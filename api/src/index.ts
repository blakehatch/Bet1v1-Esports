import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { Redis } from "ioredis";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { chainAddresses, getAccess } from "./chain.js";
import { createChallenge, requireWalletSession, verifyChallenge } from "./auth.js";
import { config } from "./config.js";
import { db, migrate, serializeWager } from "./db.js";
import { subscribeToEvents } from "./queue.js";
import { quake3EventId, quake3EventSchema, quake3PlayUrl, validEventSecret } from "./quake3.js";

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

const tokenAmount = z.string().regex(/^\d+$/).refine(
  (value) => BigInt(value) > 0n && BigInt(value) <= 18_446_744_073_709_551_615n,
  "Invalid token amount"
);
const optionalTokenAmount = z.string().regex(/^\d+$/).refine(
  (value) => BigInt(value) <= 18_446_744_073_709_551_615n,
  "Invalid token amount"
);
const quakeHandle = () => `b1v1_${randomBytes(12).toString("hex")}`;
const privateWager = (row: Record<string, unknown>, role: "maker" | "opponent") => {
  const handle = String(row[role === "maker" ? "quake_maker_handle" : "quake_opponent_handle"] ?? "");
  return {
    ...serializeWager(row),
    ...(handle ? { quake3Identity: { playerName: handle, playUrl: quake3PlayUrl(handle) } } : {})
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

app.post("/users/:wallet/mock-stake", async (request) => {
  if (!config.mockChain) {
    throw new Error("Mock staking is disabled");
  }
  const params = z.object({ wallet }).parse(request.params);
  await requireWalletSession(request.headers.authorization, params.wallet);
  const body = z.object({ amount: tokenAmount }).parse(request.body);
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
    `SELECT CASE WHEN wallet_a = $1 THEN wallet_b ELSE wallet_a END AS wallet
     FROM friendships
     WHERE wallet_a = $1 OR wallet_b = $1
     ORDER BY created_at DESC`,
    [params.wallet]
  );
  return result.rows;
});

app.post("/friends", async (request) => {
  const body = z.object({ owner: wallet, friend: wallet }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.owner);
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

app.post("/wagers", async (request) => {
  const body = z.object({
    maker: wallet,
    challenger: wallet.nullish(),
    amount: tokenAmount,
    game: z.enum(["CS2", "QUAKE3"]),
    payoutMode: z.enum(["WINNER_TAKE_ALL", "PER_KILL"]).default("WINNER_TAKE_ALL"),
    fragLimit: z.number().int().min(1).max(100).default(10),
    killValue: optionalTokenAmount.default("0")
  }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.maker);
  if (body.payoutMode === "PER_KILL" && (BigInt(body.killValue) === 0n || BigInt(body.killValue) > BigInt(body.amount))) {
    throw new Error("Per-kill value must be positive and cannot exceed either player's bankroll");
  }
  if (body.game !== "QUAKE3" && body.payoutMode === "PER_KILL") {
    throw new Error("Per-kill payouts are currently supported only for Quake 3");
  }
  if (body.payoutMode === "WINNER_TAKE_ALL" && body.killValue !== "0") {
    throw new Error("Winner-take-all wagers cannot set a kill value");
  }
  if (body.game === "QUAKE3" && body.payoutMode === "WINNER_TAKE_ALL" && body.fragLimit !== config.quake3FragLimit) {
    throw new Error(`This Quake 3 server uses fraglimit ${config.quake3FragLimit}`);
  }
  const access = await getAccess(body.maker);
  if (!access.active) {
    const error = new Error("Active token stake required") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
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
       maker, challenger, amount, game, payout_mode, frag_limit, kill_value,
       maker_remaining, quake_maker_handle, quake_opponent_handle
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $3, $8, $9)
     RETURNING *`,
    [
      body.maker,
      body.challenger ?? null,
      body.amount,
      body.game,
      body.payoutMode,
      body.fragLimit,
      body.payoutMode === "PER_KILL" ? body.killValue : "0",
      body.game === "QUAKE3" ? quakeHandle() : null,
      body.game === "QUAKE3" ? quakeHandle() : null
    ]
  );
  return body.game === "QUAKE3" ? privateWager(result.rows[0], "maker") : serializeWager(result.rows[0]);
});

app.post("/wagers/:wagerId/chain", async (request) => {
  const params = z.object({ wagerId: z.string().regex(/^\d+$/) }).parse(request.params);
  const body = z.object({ maker: wallet, signature: z.string().min(1) }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.maker);
  await db.query(
    `UPDATE wagers SET chain_signature = $3
     WHERE wager_id = $1 AND maker = $2 AND status = 'OPEN'`,
    [params.wagerId, body.maker, body.signature]
  );
  return { ok: true };
});

app.post("/wagers/:wagerId/accept", async (request) => {
  const params = z.object({ wagerId: z.string().regex(/^\d+$/) }).parse(request.params);
  const body = z.object({ opponent: wallet, signature: z.string().optional() }).parse(request.body);
  await requireWalletSession(request.headers.authorization, body.opponent);
  const access = await getAccess(body.opponent);
  if (!access.active) {
    const error = new Error("Active token stake required") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
  const target = await db.query("SELECT game FROM wagers WHERE wager_id = $1", [params.wagerId]);
  if (target.rows[0]?.game === "QUAKE3") {
    const activeQuake = await db.query(
      `SELECT wager_id FROM wagers
       WHERE game = 'QUAKE3' AND status IN ('MATCHED', 'SETTLING') AND wager_id <> $1
       LIMIT 1`,
      [params.wagerId]
    );
    if (activeQuake.rows[0]) {
      const error = new Error("The shared Quake 3 server already has an active wager") as Error & { statusCode: number };
      error.statusCode = 409;
      throw error;
    }
  }
  const result = await db.query(
    `UPDATE wagers
     SET opponent = $2, status = 'MATCHED',
         server_address = CASE WHEN game = 'QUAKE3' THEN $4 ELSE $3 END,
         chain_signature = COALESCE($5, chain_signature),
         opponent_remaining = amount
     WHERE wager_id = $1
       AND status = 'OPEN'
       AND maker <> $2
       AND (challenger IS NULL OR challenger = $2)
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
    const error = new Error("Wager is unavailable") as Error & { statusCode: number };
    error.statusCode = 409;
    throw error;
  }
  return result.rows[0].game === "QUAKE3"
    ? privateWager(result.rows[0], "opponent")
    : serializeWager(result.rows[0]);
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
