import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";

export type WinnerEvent = {
  wagerId: string;
  winner: string;
};

export const redisConnection = () =>
  new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export const chainQueue = new Queue<WinnerEvent>(config.queueName, {
  connection: redisConnection(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 100
  }
});

export const subscribeToWinners = async () => {
  const subscriber = redisConnection();
  await subscriber.subscribe(config.winnerChannel);
  subscriber.on("message", (_: string, message: string) => {
    void enqueueWinner(message).catch(console.error);
  });
  return subscriber;
};

const enqueueWinner = async (message: string) => {
  const event = JSON.parse(message) as Partial<WinnerEvent>;
  if (typeof event.wagerId !== "string" || typeof event.winner !== "string") {
    throw new Error("Invalid winner event");
  }
  await chainQueue.add("settle-wager", event as WinnerEvent, {
    jobId: `settle-${event.wagerId}`
  });
};
