import { Worker } from "bullmq";
import { settleWager } from "./chain.js";
import { config } from "./config.js";
import { db, migrate } from "./db.js";
import { redisConnection, WinnerEvent } from "./queue.js";

await migrate();

const worker = new Worker<WinnerEvent>(
  config.queueName,
  async (job) => {
    const result = await db.query(
      `UPDATE wagers
       SET status = 'SETTLING'
       WHERE wager_id = $1
         AND status IN ('MATCHED', 'SETTLING')
         AND winner IS NULL
       RETURNING maker, opponent`,
      [job.data.wagerId]
    );
    const wager = result.rows[0] as { maker: string; opponent: string } | undefined;
    if (!wager) {
      return;
    }
    if (job.data.winner !== wager.maker && job.data.winner !== wager.opponent) {
      throw new Error("Winner is not a wager participant");
    }
    try {
      const signature = await settleWager(job.data.wagerId, job.data.winner);
      await db.query(
        `UPDATE wagers
         SET status = 'SETTLED', winner = $2, chain_signature = $3
         WHERE wager_id = $1`,
        [job.data.wagerId, job.data.winner, signature]
      );
      return signature;
    } catch (error) {
      await db.query(
        "UPDATE wagers SET status = 'MATCHED' WHERE wager_id = $1 AND winner IS NULL",
        [job.data.wagerId]
      );
      throw error;
    }
  },
  { connection: redisConnection(), concurrency: 2 }
);

const close = async () => {
  await worker.close();
  await db.end();
  process.exit(0);
};

process.on("SIGINT", close);
process.on("SIGTERM", close);
