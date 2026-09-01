import Fastify from "fastify";
import cors from "@fastify/cors";
import { Redis } from "ioredis";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { chainAddresses, getAccess, getWagerAccount } from "./chain.js";
import { createChallenge, requireWalletSession, verifyChallenge } from "./auth.js";
import { config } from "./config.js";
import { db, migrate, serializeWager } from "./db.js";
import { chainQueue, subscribeToEvents } from "./queue.js";
import { getSolUsdPrice } from "./prices.js";
import {
  quake3EventId,
  quake3EventSchema,
  quake3IdentityForWallet,
  quake3PlayUrl,
  validEventSecret
} from "./quake3.js";
import {
  assertValidWagerTerms,
  assertWagerAccess,
  assertWagerCanBeAccepted,
  optionalWagerAmount,
  wagerAmount,
  WagerRuleError
} from "./wagers.js";
import { username } from "./usernames.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await migrate();
const eventSubscriber = await subscribeToEvents();
const publisher = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const wallet = z.string().refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid wallet");

type ChainBackedWager = {
  wager_id: string;
  maker: string;
  opponent: string | null;
  amount: string;
  asset: "SOL" | "USDC";
  payout_mode: "WINNER_TAKE_ALL" | "INCREMENTAL";
};

const assertOnChainWager = async (
  wager: ChainBackedWager,
  expectedStatus: 0 | 1,
  expectedOpponent?: string
) => {
  if (config.mockChain) return;
  const onChain = await getWagerAccount(String(wager.wager_id));
  const expectedMint = wager.asset === "USDC" ? chainAddresses.usdcMint : PublicKey.default.toBase58();
  const payoutMode = wager.payout_mode === "INCREMENTAL" ? 1 : 0;
  const participantsMatch = onChain?.maker.equals(new PublicKey(wager.maker))
    && (expectedStatus === 0 || Boolean(expectedOpponent && onChain.opponent.equals(new PublicKey(expectedOpponent))));
  if (
    !onChain
    || !participantsMatch
    || onChain.amount !== BigInt(wager.amount)
    || onChain.tokenMint.toBase58() !== expectedMint
    || onChain.status !== expectedStatus
    || onChain.payoutMode !== payoutMode
    || onChain.makerRemaining !== BigInt(wager.amount)
    || onChain.opponentRemaining !== (expectedStatus === 1 ? BigInt(wager.amount) : 0n)
  ) {
    throw new WagerRuleError("The on-chain escrow does not match this challenge", 409);
  }
};

const otherQuakeReservationExists = async (wagerId: string) => {
  const active = await db.query(
    `SELECT wager_id FROM wagers
     WHERE game = 'QUAKE3'
       AND status IN ('ACCEPTED', 'MAKER_FUNDED', 'MATCHED', 'SETTLING', 'CASHING_OUT')
       AND wager_id <> $1
     LIMIT 1`,
    [wagerId]
  );
  return Boolean(active.rows[0]);
};

const privateWager = (row: Record<string, unknown>, role: "maker" | "opponent") => {
  const handle = String(row[role === "maker" ? "quake_maker_handle" : "quake_opponent_handle"] ?? "");
  const rawClientNum = row[role === "maker" ? "maker_client_num" : "opponent_client_num"];
  const clientNum = Number.isInteger(rawClientNum) ? Number(rawClientNum) : null;
  return {
    ...serializeWager(row),
    ...(handle ? {
      quake3Identity: {
        playerName: handle,
        playUrl: quake3PlayUrl(handle),
        connected: clientNum !== null,
        clientNum
      }
    } : {})
  };
};

const requireAdmin = (key: unknown) => {
  if (key !== config.adminKey) {
    const error = new Error("Unauthorized") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }
};

app.get("/health", async () => ({ ok: true }));

app.get("/prices/sol", async (_request, reply) => {
  try {
    const price = await getSolUsdPrice();
    return { usd: price.usd, approximate: true, ...(price.stale ? { stale: true } : {}) };
  } catch (error) {
    return reply.status(503).send({ error: error instanceof Error ? error.message : "SOL price is unavailable" });
  }
});

app.get("/auth/challenge/:wallet", async (request) => {
  const params = z.object({ wallet }).parse(request.params);
  return createChallenge(params.wallet);
});

app.post("/auth/verify", async (request) => {
  const body = z.object({
    wallet,
    nonce: z.string().min(1),
    signature: z.array(z.number().int().min(0).max(255)).length(64)
  }).parse(request.body);
  return verifyChallenge(body.wallet, body.nonce, body.signature);
});

app.get("/config", async () => ({
  ...chainAddresses,
  mockChain: config.mockChain,
  stakingEnabled: config.stakingEnabled,
  serverAddress: config.serverAddress,
  quake3ServerAddress: config.quake3ServerAddress,
  quake3FragLimit: config.quake3FragLimit
}));

app.post("/q3/events", async (request, reply) => {
  if (!validEventSecret(request.headers["x-q3js-client-secret"])) {
    return reply.status(401).send({ error: "Unauthorized Q3JS event source" });
  }
  const payload = quake3EventSchema.parse(request.body);
  const eventId = quake3EventId(payload);
  await publisher.publish(config.quake3EventChannel, JSON.stringify({ eventId, payload }));
  return { accepted: true, eventId };
});

app.get("/access/:wallet", async (request) => {
  const params = z.object({ wallet }).parse(request.params);
  return getAccess(params.wallet);
});

app.get("/account/:wallet", async (request) => {
  const params = z.object({ wallet }).parse(request.params);
  await requireWalletSession(request.headers.authorization, params.wallet);
  await db.query("INSERT INTO users (wallet) VALUES ($1) ON CONFLICT DO NOTHING", [params.wallet]);
  const result = await db.query("SELECT wallet, username FROM users WHERE wallet = $1", [params.wallet]);
  return { wallet: params.wallet, username: result.rows[0]?.username ?? null };
});

app.put("/account/:wallet/username", async (request) => {
  const params = z.object({ wallet }).parse(request.params);
  const body = z.object({ username }).parse(request.body);
  await requireWalletSession(request.headers.authorization, params.wallet);
  try {
    const result = await db.query(
      `INSERT INTO users (wallet, username) VALUES ($1, $2)
       ON CONFLICT (wallet) DO UPDATE SET username = EXCLUDED.username
       RETURNING wallet, username`,
      [params.wallet, body.username]
    );
    await db.query(
      `UPDATE wagers SET quake_maker_handle = $2
       WHERE maker = $1 AND game = 'QUAKE3' AND status IN ('OPEN', 'ACCEPTED', 'MAKER_FUNDED')`,
      [params.wallet, body.username]
    );
    await db.query(
      `UPDATE wagers SET quake_opponent_handle = $2
       WHERE opponent = $1 AND game = 'QUAKE3' AND status IN ('ACCEPTED', 'MAKER_FUNDED')`,
      [params.wallet, body.username]
    );
    return result.rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new WagerRuleError("That username is already taken", 409);
    }
    throw error;
  }
});

app.post("/users/:wallet/mock-stake", async (request) => {
  if (!config.mockChain) {
    throw new Error("Mock staking is disabled");
  }
  if (!config.stakingEnabled) {
    throw new Error("Staking is disabled");
  }
  const params = z.object({ wallet }).parse(request.params);
  await requireWalletSession(request.headers.authorization, params.wallet);
  const body = z.object({ amount: wagerAmount }).parse(request.body);
  await db.query(
    `INSERT INTO users (wallet, stake_amount)
     VALUES ($1, $2)
     ON CONFLICT (wallet)
     DO UPDATE SET stake_amount = users.stake_amount + EXCLUDED.stake_amount`,
    [params.wallet, body.amount]
  );
  return getAccess(params.wallet);
});

app.get("/friends/:wallet", async (request) => {
  const params = z.object({ wallet }).parse(request.params);
  const result = await db.query(
    `SELECT friend.wallet, users.username
     FROM friendships
     CROSS JOIN LATERAL (
       SELECT CASE WHEN wallet_a = $1 THEN wallet_b ELSE wallet_a END AS wallet
     ) friend
     LEFT JOIN users ON users.wallet = friend.wallet
     WHERE wallet_a = $1 OR wallet_b = $1
     ORDER BY friendships.created_at DESC`,
    [params.wallet]
  );
  return result.rows;
});

app.post("/friends", async (request) => {
  const body = z.object({ owner: wallet, friend: wallet }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.owner);
  const access = await getAccess(body.owner);
  if (!access.active) {
    const error = new Error("Active token stake required") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
  if (body.owner === body.friend) {
    throw new Error("A wallet cannot friend itself");
  }
  const [walletA, walletB] = [body.owner, body.friend].sort();
  await db.query(
    `INSERT INTO friendships (wallet_a, wallet_b)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [walletA, walletB]
  );
  return { ok: true };
});

app.get("/wagers", async (request) => {
  const query = z.object({
    wallet: wallet.optional(),
    status: z.string().optional(),
    game: z.enum(["CS2", "QUAKE3"]).optional()
  }).parse(request.query);
  const values: string[] = [];
  const clauses: string[] = [];
  if (query.wallet) {
    values.push(query.wallet);
    clauses.push(`(maker = $${values.length} OR opponent = $${values.length} OR challenger = $${values.length})`);
  }
  if (query.status) {
    values.push(query.status.toUpperCase());
    clauses.push(`status = $${values.length}`);
  }
  if (query.game) {
    values.push(query.game);
    clauses.push(`game = $${values.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await db.query(`SELECT * FROM wagers ${where} ORDER BY created_at DESC LIMIT 100`, values);
  return result.rows.map(serializeWager);
});

app.get("/wagers/:wagerId/quake3-identity", async (request) => {
  const params = z.object({ wagerId: z.string().regex(/^\d+$/) }).parse(request.params);
  const query = z.object({ wallet }).parse(request.query);
  await requireWalletSession(request.headers.authorization, query.wallet);
  const result = await db.query(
    `SELECT game, maker, opponent, quake_maker_handle, quake_opponent_handle,
       maker_client_num, opponent_client_num
     FROM wagers WHERE wager_id = $1`,
    [params.wagerId]
  );
  const identity = result.rows[0]
    ? quake3IdentityForWallet(result.rows[0], query.wallet)
    : null;
  if (!identity) {
    throw Object.assign(
      new Error("Quake identity not found for this wallet and wager"),
      { statusCode: 404 }
    );
  }
  return { wagerId: params.wagerId, ...identity };
});

app.post("/wagers", async (request) => {
  const body = z.object({
    maker: wallet,
    challenger: wallet.nullish(),
    amount: wagerAmount,
    asset: z.enum(["SOL", "USDC"]).default("SOL"),
    game: z.enum(["CS2", "QUAKE3"]),
    payoutMode: z.enum(["WINNER_TAKE_ALL", "INCREMENTAL"]).default("WINNER_TAKE_ALL"),
    fragLimit: z.number().int().min(1).max(100).default(10),
    incrementValue: optionalWagerAmount.default("0")
  }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.maker);
  assertValidWagerTerms(body, config.quake3FragLimit);
  const access = await getAccess(body.maker);
  assertWagerAccess(access.active);
  let makerUsername: string | null = null;
  if (body.game === "QUAKE3") {
    const profile = await db.query("SELECT username FROM users WHERE wallet = $1", [body.maker]);
    makerUsername = profile.rows[0]?.username ?? null;
    if (!makerUsername) throw new WagerRuleError("Choose a username before creating a Quake challenge", 409);
  }
  if (body.challenger) {
    const [walletA, walletB] = [body.maker, body.challenger].sort();
    const friendship = await db.query(
      "SELECT 1 FROM friendships WHERE wallet_a = $1 AND wallet_b = $2",
      [walletA, walletB]
    );
    if (!friendship.rows[0]) {
      const error = new Error("Challenger is not on the maker's friend list") as Error & { statusCode: number };
      error.statusCode = 403;
      throw error;
    }
  }
  const result = await db.query(
    `INSERT INTO wagers (
       maker, challenger, amount, asset, game, payout_mode, frag_limit, increment_value,
       maker_remaining, quake_maker_handle, quake_opponent_handle
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $3, $9, $10)
     RETURNING *`,
    [
      body.maker,
      body.challenger ?? null,
      body.amount,
      body.asset,
      body.game,
      body.payoutMode,
      body.fragLimit,
      body.payoutMode === "INCREMENTAL" ? body.incrementValue : "0",
      makerUsername,
      null
    ]
  );
  return body.game === "QUAKE3" ? privateWager(result.rows[0], "maker") : serializeWager(result.rows[0]);
});

app.post("/wagers/:wagerId/chain", async (request) => {
  const params = z.object({ wagerId: z.string().regex(/^\d+$/) }).parse(request.params);
  const body = z.object({ maker: wallet, signature: z.string().min(1).optional() }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.maker);
  const targetResult = await db.query(
    `SELECT wager_id, maker, opponent, amount, asset, payout_mode
     FROM wagers WHERE wager_id = $1 AND maker = $2 AND status = 'ACCEPTED' AND opponent IS NOT NULL`,
    [params.wagerId, body.maker]
  );
  const target = targetResult.rows[0] as ChainBackedWager | undefined;
  if (!target) throw new WagerRuleError("Challenge is not ready for maker funding", 409);
  await assertOnChainWager(target, 0);
  const result = await db.query(
    `UPDATE wagers SET chain_signature = COALESCE($3, chain_signature),
       create_signature = COALESCE($3, create_signature), status = 'MAKER_FUNDED'
     WHERE wager_id = $1 AND maker = $2 AND status = 'ACCEPTED' AND opponent IS NOT NULL
     RETURNING wager_id`,
    [params.wagerId, body.maker, body.signature ?? null]
  );
  if (!result.rows[0]) throw new WagerRuleError("Challenge is not ready for maker funding", 409);
  return { ok: true };
});

app.post("/wagers/:wagerId/accept-intent", async (request) => {
  const params = z.object({ wagerId: z.string().regex(/^\d+$/) }).parse(request.params);
  const body = z.object({ opponent: wallet }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.opponent);
  const access = await getAccess(body.opponent);
  assertWagerAccess(access.active);
  const profile = await db.query("SELECT username FROM users WHERE wallet = $1", [body.opponent]);
  const targetResult = await db.query(
    "SELECT maker, challenger, game, status, create_signature FROM wagers WHERE wager_id = $1",
    [params.wagerId]
  );
  const target = targetResult.rows[0] as {
    maker: string;
    challenger: string | null;
    game: "CS2" | "QUAKE3";
    status: string;
    create_signature: string | null;
  } | undefined;
  const sharedQuakeServerOccupied = target?.game === "QUAKE3"
    ? await otherQuakeReservationExists(params.wagerId)
    : false;
  assertWagerCanBeAccepted(target, body.opponent, sharedQuakeServerOccupied);
  const opponentUsername = profile.rows[0]?.username as string | null | undefined;
  if (target?.game === "QUAKE3" && !opponentUsername) {
    throw new WagerRuleError("Choose a username before accepting a Quake challenge", 409);
  }
  if (target?.create_signature) throw new WagerRuleError("Challenge is already funded", 409);
  let result;
  try {
    result = await db.query(
      `UPDATE wagers SET opponent = $2, status = 'ACCEPTED',
         quake_opponent_handle = CASE WHEN game = 'QUAKE3' THEN $3 ELSE quake_opponent_handle END
       WHERE wager_id = $1 AND status = 'OPEN' AND create_signature IS NULL
         AND maker <> $2 AND (challenger IS NULL OR challenger = $2)
       RETURNING *`,
      [params.wagerId, body.opponent, opponentUsername ?? null]
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new WagerRuleError("The shared Quake 3 server already has an active wager", 409);
    }
    throw error;
  }
  if (!result.rows[0]) throw new WagerRuleError("Wager is unavailable", 409);
  return result.rows[0].game === "QUAKE3"
    ? privateWager(result.rows[0], "opponent")
    : serializeWager(result.rows[0]);
});

app.post("/wagers/:wagerId/accept", async (request) => {
  const params = z.object({ wagerId: z.string().regex(/^\d+$/) }).parse(request.params);
  const body = z.object({ opponent: wallet, signature: z.string().min(1).optional() }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.opponent);
  const access = await getAccess(body.opponent);
  assertWagerAccess(access.active);
  const targetResult = await db.query(
    `SELECT wager_id, maker, challenger, opponent, game, status, create_signature,
       amount, asset, payout_mode FROM wagers WHERE wager_id = $1`,
    [params.wagerId]
  );
  const target = targetResult.rows[0] as {
    wager_id: string;
    maker: string;
    challenger: string | null;
    opponent: string | null;
    game: "CS2" | "QUAKE3";
    status: string;
    create_signature: string | null;
    amount: string;
    asset: "SOL" | "USDC";
    payout_mode: "WINNER_TAKE_ALL" | "INCREMENTAL";
  } | undefined;
  const sharedQuakeServerOccupied = target?.game === "QUAKE3"
    ? await otherQuakeReservationExists(params.wagerId)
    : false;
  const legacyFunded = target?.status === "OPEN" && Boolean(target.create_signature);
  if (!target || target.maker === body.opponent || sharedQuakeServerOccupied
      || (!legacyFunded && (target.status !== "MAKER_FUNDED" || target.opponent !== body.opponent))
      || (legacyFunded && target.challenger != null && target.challenger !== body.opponent)) {
    throw new WagerRuleError(
      sharedQuakeServerOccupied ? "The shared Quake 3 server already has an active wager" : "Wager is unavailable",
      409
    );
  }
  await assertOnChainWager(target as ChainBackedWager, 1, body.opponent);
  const result = await db.query(
    `UPDATE wagers
     SET opponent = $2, status = 'MATCHED',
         server_address = CASE WHEN game = 'QUAKE3' THEN $4 ELSE $3 END,
         chain_signature = COALESCE($5, chain_signature),
         join_signature = COALESCE($5, join_signature),
         opponent_remaining = amount
     WHERE wager_id = $1
       AND (status = 'MAKER_FUNDED' OR (status = 'OPEN' AND create_signature IS NOT NULL))
       AND maker <> $2
       AND (opponent = $2 OR (opponent IS NULL AND (challenger IS NULL OR challenger = $2)))
     RETURNING *`,
    [
      params.wagerId,
      body.opponent,
      config.serverAddress,
      config.quake3ServerAddress,
      body.signature ?? null
    ]
  );
  if (!result.rows[0]) {
    throw new WagerRuleError("Wager is unavailable", 409);
  }
  return result.rows[0].game === "QUAKE3"
    ? privateWager(result.rows[0], "opponent")
    : serializeWager(result.rows[0]);
});

app.post("/wagers/:wagerId/decline", async (request) => {
  const params = z.object({ wagerId: z.string().regex(/^\d+$/) }).parse(request.params);
  const body = z.object({ challenger: wallet }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.challenger);
  const reserved = await db.query(
    `UPDATE wagers SET status = 'DECLINED', maker_remaining = 0
     WHERE wager_id = $1 AND create_signature IS NULL
       AND ((status = 'OPEN' AND challenger = $2 AND opponent IS NULL)
         OR (status = 'ACCEPTED' AND opponent = $2))
     RETURNING wager_id`,
    [params.wagerId, body.challenger]
  );
  if (!reserved.rows[0]) throw new WagerRuleError("Reserved challenge is no longer open", 409);
  return { declined: true };
});

app.post("/wagers/:wagerId/cancel-intent", async (request) => {
  const params = z.object({ wagerId: z.string().regex(/^\d+$/) }).parse(request.params);
  const body = z.object({ maker: wallet }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.maker);
  const result = await db.query(
    `UPDATE wagers SET status = 'CANCELLED'
     WHERE wager_id = $1 AND maker = $2 AND status = 'ACCEPTED'
       AND create_signature IS NULL
     RETURNING wager_id`,
    [params.wagerId, body.maker]
  );
  if (!result.rows[0]) throw new WagerRuleError("Accepted challenge is no longer cancellable", 409);
  return { cancelled: true };
});

app.post("/wagers/:wagerId/cancel", async (request) => {
  const params = z.object({ wagerId: z.string().regex(/^\d+$/) }).parse(request.params);
  const body = z.object({ maker: wallet, signature: z.string().min(1) }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.maker);
  const result = await db.query(
    `UPDATE wagers SET status = 'CANCELLED', maker_remaining = 0,
       chain_signature = $3, settlement_signature = $3
     WHERE wager_id = $1 AND maker = $2 AND status IN ('OPEN', 'MAKER_FUNDED')
       AND create_signature IS NOT NULL
     RETURNING wager_id`,
    [params.wagerId, body.maker, body.signature]
  );
  if (!result.rows[0]) throw new WagerRuleError("Funded challenge is no longer cancellable", 409);
  return { cancelled: true, signature: body.signature };
});

app.post("/wagers/:wagerId/cashout", async (request) => {
  const params = z.object({ wagerId: z.string().regex(/^\d+$/) }).parse(request.params);
  const body = z.object({ wallet }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.wallet);
  const result = await db.query(
    `UPDATE wagers
     SET status = CASE
           WHEN cashout_requested_by IS NOT NULL AND cashout_requested_by <> $2
             THEN 'CASHING_OUT'
           ELSE status
         END,
         cashout_requested_by = COALESCE(cashout_requested_by, $2),
         cashout_requested_at = COALESCE(cashout_requested_at, NOW())
     WHERE wager_id = $1 AND status = 'MATCHED' AND payout_mode = 'INCREMENTAL'
       AND $2 IN (maker, opponent)
     RETURNING status, cashout_requested_by`,
    [params.wagerId, body.wallet]
  );
  const row = result.rows[0] as { status: string; cashout_requested_by: string } | undefined;
  if (!row) throw new WagerRuleError("Incremental match is not available to cash out", 409);
  if (row.status === "CASHING_OUT") {
    try {
      await chainQueue.add("cash-out", { wagerId: params.wagerId }, {
        jobId: `cashout-${params.wagerId}`
      });
    } catch (error) {
      await db.query(
        "UPDATE wagers SET status = 'MATCHED' WHERE wager_id = $1 AND status = 'CASHING_OUT'",
        [params.wagerId]
      );
      throw error;
    }
  }
  return {
    state: row.status === "CASHING_OUT" ? "CASHING_OUT" : "REQUESTED",
    requestedBy: row.cashout_requested_by
  };
});

app.post("/wagers/:wagerId/cashout/cancel", async (request) => {
  const params = z.object({ wagerId: z.string().regex(/^\d+$/) }).parse(request.params);
  const body = z.object({ wallet }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.wallet);
  const result = await db.query(
    `UPDATE wagers SET cashout_requested_by = NULL, cashout_requested_at = NULL
     WHERE wager_id = $1 AND status = 'MATCHED' AND cashout_requested_by = $2
     RETURNING wager_id`,
    [params.wagerId, body.wallet]
  );
  if (!result.rows[0]) throw new WagerRuleError("Cash-out request is no longer cancellable", 409);
  return { cancelled: true };
});

app.post("/admin/winners", async (request) => {
  requireAdmin(request.headers["x-admin-key"]);
  const body = z.object({ wagerId: z.string().regex(/^\d+$/), winner: wallet }).parse(request.body);
  const result = await db.query(
    `SELECT 1 FROM wagers
     WHERE wager_id = $1 AND status = 'MATCHED' AND payout_mode = 'WINNER_TAKE_ALL'
       AND $2 IN (maker, opponent)`,
    [body.wagerId, body.winner]
  );
  if (!result.rows[0]) {
    throw new Error("Matched wager not found");
  }
  await publisher.publish(config.winnerChannel, JSON.stringify(body));
  return { queued: true };
});

app.setErrorHandler((error, _, reply) => {
  const issue = error as Error & { statusCode?: number };
  const status = typeof issue.statusCode === "number" ? issue.statusCode : 400;
  reply.status(status).send({ error: issue.message });
});

const close = async () => {
  await app.close();
  await eventSubscriber.quit();
  await publisher.quit();
  await db.end();
};

process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ port: config.port, host: "0.0.0.0" });
