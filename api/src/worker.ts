import { Job, QueueEvents, Worker } from "bullmq";
import { cashOutWager, settleIncrement, settleWager } from "./chain.js";
import { config } from "./config.js";
import { db, migrate } from "./db.js";
import {
  chainQueue,
  CashOutEvent,
  ChainAction,
  gameQueue,
  IncrementPayoutEvent,
  redisConnection,
  WinnerEvent
} from "./queue.js";
import {
  getQuake3Scores,
  killPayout,
  Quake3QueuedEvent,
  Quake3ScoringEvent,
  scoringWallets
} from "./quake3.js";
import { getSolUsdPrice } from "./prices.js";
import {
  cashOutNotificationPlan,
  incrementalNotificationPlan,
  Quake3NotificationPlan,
  Quake3NotificationScheduler,
  remainingBalancesAfterIncrement,
  WagerAsset,
  winnerTakeAllNotificationPlan
} from "./quake3-rcon.js";
import { assertWinnerIsParticipant, winnerAtFragLimit } from "./wagers.js";

await migrate();
const chainQueueEvents = new QueueEvents(config.queueName, { connection: redisConnection() });
await chainQueueEvents.waitUntilReady();

const processIdentityEvent = async (event: Quake3QueuedEvent) => {
  if (event.event === "kill" || event.event === "death") return;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO quake_events (event_id, event_type, payload)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_id`,
      [event.eventId, event.event, JSON.stringify(event)]
    );
    if (!inserted.rows[0]) {
      await client.query("ROLLBACK");
      return;
    }
    const makerValue = event.event === "join" ? event.player.clientNum : null;
    const opponentValue = event.event === "join" ? event.player.clientNum : null;
    const result = await client.query(
      `UPDATE wagers
       SET maker_client_num = CASE WHEN quake_maker_handle = $1 THEN $2 ELSE maker_client_num END,
           opponent_client_num = CASE WHEN quake_opponent_handle = $1 THEN $3 ELSE opponent_client_num END
       WHERE game = 'QUAKE3' AND status IN ('OPEN', 'MATCHED')
         AND $1 IN (quake_maker_handle, quake_opponent_handle)
       RETURNING wager_id`,
      [event.player.name, makerValue, opponentValue]
    );
    await client.query(
      `UPDATE quake_events SET wager_id = $2, outcome = $3, processed_at = NOW() WHERE event_id = $1`,
      [event.eventId, result.rows[0]?.wager_id ?? null, result.rows[0] ? event.event.toUpperCase() : "UNKNOWN_PLAYER"]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

type MatchedQuakeWager = {
  wager_id: string;
  maker: string;
  opponent: string;
  payout_mode: "WINNER_TAKE_ALL" | "INCREMENTAL";
  frag_limit: number;
  increment_value: string;
  maker_remaining: string;
  opponent_remaining: string;
  quake_maker_handle: string;
  quake_opponent_handle: string;
  maker_client_num: number;
  opponent_client_num: number;
};

const findScoringWager = async (event: Quake3ScoringEvent) => {
  const result = await db.query(
    `SELECT * FROM wagers
     WHERE game = 'QUAKE3' AND status = 'MATCHED'
       AND ((quake_maker_handle = $1 AND maker_client_num = $2)
         OR (quake_opponent_handle = $1 AND opponent_client_num = $2))
     LIMIT 1`,
    [event.victim.name, event.victim.clientNum]
  );
  return result.rows[0] as MatchedQuakeWager | undefined;
};

const recordUnmatchedScore = async (event: Quake3ScoringEvent) => {
  await db.query(
    `INSERT INTO quake_events (event_id, event_type, payload, outcome, processed_at)
     VALUES ($1, $2, $3, 'UNMATCHED_PLAYERS', NOW()) ON CONFLICT DO NOTHING`,
    [event.eventId, event.event, JSON.stringify(event)]
  );
};

const processScoringEvent = async (event: Quake3ScoringEvent) => {
  const wager = await findScoringWager(event);
  const wallets = wager ? scoringWallets(event, wager) : null;
  if (!wager || !wallets) {
    await recordUnmatchedScore(event);
    return;
  }
  const killer = wallets.beneficiary;
  const victim = wallets.victim;

  if (wager.payout_mode === "WINNER_TAKE_ALL") {
    const scores = await getQuake3Scores();
    const makerScore = scores.find((score) => score.name === wager.quake_maker_handle)?.score;
    const opponentScore = scores.find((score) => score.name === wager.quake_opponent_handle)?.score;
    if (makerScore === undefined || opponentScore === undefined) {
      throw new Error("Both wager players were not present in the Quake 3 status response");
    }
    const inserted = await db.query(
      `INSERT INTO quake_events (event_id, event_type, payload, wager_id, outcome, processed_at)
       VALUES ($1, $2, $3, $4, 'SCORE_UPDATED', NOW()) ON CONFLICT DO NOTHING RETURNING event_id`,
      [event.eventId, event.event, JSON.stringify(event), wager.wager_id]
    );
    if (!inserted.rows[0]) return;
    await db.query(
      "UPDATE wagers SET maker_score = $2, opponent_score = $3 WHERE wager_id = $1",
      [wager.wager_id, makerScore, opponentScore]
    );
    const winner = winnerAtFragLimit(
      makerScore,
      opponentScore,
      wager.frag_limit,
      wager.maker,
      wager.opponent
    );
    if (winner) {
      await chainQueue.add("settle-wager", { wagerId: String(wager.wager_id), winner }, {
        jobId: `settle-${wager.wager_id}`
      });
    }
    return;
  }

  const victimRemaining = BigInt(victim === wager.maker ? wager.maker_remaining : wager.opponent_remaining);
  const amount = killPayout(BigInt(wager.increment_value), victimRemaining);
  if (amount <= 0n) return;
  const client = await db.connect();
  let sequence = 0;
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO quake_events (event_id, event_type, payload, wager_id, outcome)
       VALUES ($1, $2, $3, $4, 'PAYOUT_PENDING') ON CONFLICT DO NOTHING`,
      [event.eventId, event.event, JSON.stringify(event), wager.wager_id]
    );
    const existing = await client.query("SELECT sequence FROM kill_payouts WHERE event_id = $1", [event.eventId]);
    if (existing.rows[0]) {
      sequence = Number(existing.rows[0].sequence);
    } else {
      const count = await client.query(
        "SELECT COUNT(*)::int AS count FROM kill_payouts WHERE wager_id = $1",
        [wager.wager_id]
      );
      sequence = Number(count.rows[0].count) + 1;
      await client.query(
      `INSERT INTO kill_payouts (event_id, wager_id, killer, victim, amount, sequence)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [event.eventId, wager.wager_id, killer, victim, amount.toString(), sequence]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const payoutJob = await chainQueue.add("settle-increment", {
    eventId: event.eventId,
    wagerId: String(wager.wager_id),
    beneficiary: killer,
    debitedPlayer: victim,
    sequence
  }, { jobId: `settle-increment-${event.eventId}` });
  await payoutJob.waitUntilFinished(chainQueueEvents, 30_000);
};

const gameWorker = new Worker<Quake3QueuedEvent>(
  config.gameQueueName,
  async (job) => job.data.event === "kill" || job.data.event === "death"
    ? processScoringEvent(job.data)
    : processIdentityEvent(job.data),
  { connection: redisConnection(), concurrency: 1 }
);

const quake3Notifications = new Quake3NotificationScheduler(
  undefined,
  (error) => console.error("Unable to send a repeated Quake 3 notification", error)
);

const notifyQuake3 = async (
  wagerId: string,
  label: string,
  plan: () => Quake3NotificationPlan
) => {
  try {
    await quake3Notifications.notify(wagerId, plan());
  } catch (error) {
    console.error(`Unable to send Quake 3 ${label} notification`, error);
  }
};

const solPriceFor = async (asset: WagerAsset) => {
  if (asset !== "SOL") return undefined;
  try {
    return (await getSolUsdPrice()).usd;
  } catch (error) {
    console.error("Unable to add a SOL/USD estimate to the Quake notification", error);
    return undefined;
  }
};

type WinnerTakeAllWager = {
  maker: string;
  opponent: string;
  game: "CS2" | "QUAKE3";
  asset: WagerAsset;
  amount: string;
  quake_maker_handle: string | null;
  quake_opponent_handle: string | null;
};

const processWinner = async (event: WinnerEvent) => {
  const result = await db.query(
    `UPDATE wagers SET status = 'SETTLING'
     WHERE wager_id = $1 AND status IN ('MATCHED', 'SETTLING') AND winner IS NULL
     AND payout_mode = 'WINNER_TAKE_ALL'
     RETURNING maker, opponent, game, asset, amount,
       quake_maker_handle, quake_opponent_handle`,
    [event.wagerId]
  );
  const wager = result.rows[0] as WinnerTakeAllWager | undefined;
  if (!wager) return;
  assertWinnerIsParticipant(event.winner, wager.maker, wager.opponent);
  try {
    const signature = await settleWager(event.wagerId, event.winner);
    await db.query(
      `UPDATE wagers SET status = 'SETTLED', winner = $2, chain_signature = $3,
         settlement_signature = $3,
         maker_remaining = 0, opponent_remaining = 0 WHERE wager_id = $1`,
      [event.wagerId, event.winner, signature]
    );
    if (wager.game === "QUAKE3") {
      const winnerName = event.winner === wager.maker
        ? wager.quake_maker_handle
        : wager.quake_opponent_handle;
      if (winnerName) {
        const solUsdPrice = await solPriceFor(wager.asset);
        await notifyQuake3(
          event.wagerId,
          "winner-take-all",
          () => winnerTakeAllNotificationPlan(
            winnerName,
            BigInt(wager.amount) * 2n,
            wager.asset,
            solUsdPrice
          )
        );
      }
    }
    return signature;
  } catch (error) {
    await db.query("UPDATE wagers SET status = 'MATCHED' WHERE wager_id = $1 AND winner IS NULL", [event.wagerId]);
    throw error;
  }
};

type IncrementPayoutRow = {
  payout_amount: string;
  payout_status: string;
  status: string;
  payout_mode: string;
  maker: string;
  opponent: string;
  game: "CS2" | "QUAKE3";
  asset: WagerAsset;
  amount: string;
  maker_remaining: string;
  opponent_remaining: string;
  maker_client_num: number | null;
  opponent_client_num: number | null;
  quake_maker_handle: string | null;
  quake_opponent_handle: string | null;
};

const processIncrementPayout = async (event: IncrementPayoutEvent) => {
  const result = await db.query(
    `SELECT k.amount AS payout_amount, k.status AS payout_status, w.*
     FROM kill_payouts k JOIN wagers w USING (wager_id)
     WHERE k.event_id = $1`,
    [event.eventId]
  );
  const row = result.rows[0] as IncrementPayoutRow | undefined;
  if (!row || row.payout_status === "PAID") return;
  if (row.status !== "MATCHED" || row.payout_mode !== "INCREMENTAL") {
    throw new Error("Incremental wager is not payable");
  }
  const signature = await settleIncrement(event.wagerId, event.beneficiary, event.sequence);
  const amount = BigInt(String(row.payout_amount));
  const beneficiaryIsMaker = event.beneficiary === row.maker;
  const debitedRemaining = BigInt(String(beneficiaryIsMaker ? row.opponent_remaining : row.maker_remaining));
  const finalIncrement = amount >= debitedRemaining;
  const { makerRemaining, opponentRemaining } = remainingBalancesAfterIncrement(
    BigInt(row.maker_remaining),
    BigInt(row.opponent_remaining),
    beneficiaryIsMaker,
    amount,
    finalIncrement
  );
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE kill_payouts SET status = 'PAID', chain_signature = $2 WHERE event_id = $1`,
      [event.eventId, signature]
    );
    await client.query(
      `UPDATE quake_events SET outcome = 'PAYOUT_PAID', processed_at = NOW() WHERE event_id = $1`,
      [event.eventId]
    );
    if (beneficiaryIsMaker) {
      await client.query(
        `UPDATE wagers SET maker_score = maker_score + 1,
           opponent_remaining = CASE WHEN $2 THEN 0 ELSE opponent_remaining - $3 END,
           maker_remaining = CASE WHEN $2 THEN 0 ELSE maker_remaining END,
           status = CASE WHEN $2 THEN 'SETTLED' ELSE status END,
           winner = CASE WHEN $2 THEN maker ELSE winner END,
           chain_signature = $4, settlement_signature = $4
         WHERE wager_id = $1`,
        [event.wagerId, finalIncrement, amount.toString(), signature]
      );
    } else {
      await client.query(
        `UPDATE wagers SET opponent_score = opponent_score + 1,
           maker_remaining = CASE WHEN $2 THEN 0 ELSE maker_remaining - $3 END,
           opponent_remaining = CASE WHEN $2 THEN 0 ELSE opponent_remaining END,
           status = CASE WHEN $2 THEN 'SETTLED' ELSE status END,
           winner = CASE WHEN $2 THEN opponent ELSE winner END,
           chain_signature = $4, settlement_signature = $4
         WHERE wager_id = $1`,
        [event.wagerId, finalIncrement, amount.toString(), signature]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (row.game === "QUAKE3") {
    const winnerName = beneficiaryIsMaker
      ? row.quake_maker_handle
      : row.quake_opponent_handle;
    if (winnerName) {
      const bankroll = BigInt(row.amount);
      const makerBalance = finalIncrement && beneficiaryIsMaker
        ? bankroll * 2n
        : finalIncrement
          ? 0n
          : makerRemaining + (bankroll - opponentRemaining);
      const opponentBalance = finalIncrement && !beneficiaryIsMaker
        ? bankroll * 2n
        : finalIncrement
          ? 0n
          : opponentRemaining + (bankroll - makerRemaining);
      const solUsdPrice = await solPriceFor(row.asset);
      await notifyQuake3(
        event.wagerId,
        "incremental payout",
        () => incrementalNotificationPlan({
          winnerName,
          makerName: row.quake_maker_handle ?? "Maker",
          opponentName: row.quake_opponent_handle ?? "Opponent",
          won: amount,
          asset: row.asset,
          solUsdPrice,
          makerClientNum: row.maker_client_num,
          opponentClientNum: row.opponent_client_num,
          makerBalance,
          opponentBalance
        })
      );
    }
  }
  return signature;
};

type CashOutRow = {
  status: string;
  payout_mode: string;
  game: "CS2" | "QUAKE3";
  asset: WagerAsset;
  amount: string;
  maker_remaining: string;
  opponent_remaining: string;
  maker_client_num: number | null;
  opponent_client_num: number | null;
  quake_maker_handle: string | null;
  quake_opponent_handle: string | null;
};

const processCashOut = async (event: CashOutEvent) => {
  const result = await db.query("SELECT * FROM wagers WHERE wager_id = $1", [event.wagerId]);
  const row = result.rows[0] as CashOutRow | undefined;
  if (!row || row.status === "CASHED_OUT") return;
  if (row.status !== "CASHING_OUT" || row.payout_mode !== "INCREMENTAL") {
    throw new Error("Incremental wager is not ready to cash out");
  }
  const cashOut = await cashOutWager(event.wagerId);
  const makerBalance = cashOut.makerRemaining + (cashOut.amount - cashOut.opponentRemaining);
  const opponentBalance = cashOut.opponentRemaining + (cashOut.amount - cashOut.makerRemaining);
  await db.query(
    `UPDATE wagers SET status = 'CASHED_OUT', maker_remaining = 0, opponent_remaining = 0,
       maker_final_balance = $3, opponent_final_balance = $4,
       chain_signature = $2, settlement_signature = $2
     WHERE wager_id = $1 AND status = 'CASHING_OUT'`,
    [event.wagerId, cashOut.signature, makerBalance.toString(), opponentBalance.toString()]
  );
  if (row.game === "QUAKE3" && row.quake_maker_handle && row.quake_opponent_handle) {
    const solUsdPrice = await solPriceFor(row.asset);
    await notifyQuake3(
      event.wagerId,
      "cash-out",
      () => cashOutNotificationPlan({
        makerName: row.quake_maker_handle!,
        opponentName: row.quake_opponent_handle!,
        makerBalance,
        opponentBalance,
        asset: row.asset,
        solUsdPrice,
        makerClientNum: row.maker_client_num,
        opponentClientNum: row.opponent_client_num
      })
    );
  }
  return cashOut.signature;
};

const chainWorker = new Worker<ChainAction>(
  config.queueName,
  async (job: Job<ChainAction>) => job.name === "settle-increment"
    ? processIncrementPayout(job.data as IncrementPayoutEvent)
    : job.name === "cash-out"
      ? processCashOut(job.data as CashOutEvent)
      : processWinner(job.data as WinnerEvent),
  { connection: redisConnection(), concurrency: 1 }
);

const close = async () => {
  quake3Notifications.close();
  await Promise.all([
    gameWorker.close(),
    chainWorker.close(),
    chainQueueEvents.close(),
    gameQueue.close(),
    chainQueue.close()
  ]);
  await db.end();
  process.exit(0);
};

process.on("SIGINT", close);
process.on("SIGTERM", close);
