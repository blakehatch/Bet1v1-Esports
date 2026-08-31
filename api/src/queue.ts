import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { Quake3QueuedEvent, quake3EventSchema } from "./quake3.js";

export type WinnerEvent = { wagerId: string; winner: string };
export type KillPayoutEvent = {
  eventId: string;
  wagerId: string;
  killer: string;
  victim: string;
  sequence: number;
};
export type ChainAction = WinnerEvent | KillPayoutEvent;

export const redisConnection = () => new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const defaults = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: 100,
  removeOnFail: 100
};

export const chainQueue = new Queue<ChainAction>(config.queueName, {
  connection: redisConnection(),
  defaultJobOptions: defaults
});

export const gameQueue = new Queue<Quake3QueuedEvent>(config.gameQueueName, {
  connection: redisConnection(),
  defaultJobOptions: defaults
});

export const subscribeToEvents = async () => {
  const subscriber = redisConnection();
  await subscriber.subscribe(config.winnerChannel, config.quake3EventChannel);
  subscriber.on("message", (channel: string, message: string) => {
    const operation = channel === config.winnerChannel
      ? enqueueWinner(message)
      : enqueueQuake3Event(message);
    void operation.catch(console.error);
  });
  return subscriber;
};

const enqueueWinner = async (message: string) => {
  const event = JSON.parse(message) as Partial<WinnerEvent>;
  if (typeof event.wagerId !== "string" || typeof event.winner !== "string") {
    throw new Error("Invalid winner event");
  }
  await chainQueue.add("settle-wager", event as WinnerEvent, { jobId: `settle-${event.wagerId}` });
};

const enqueueQuake3Event = async (message: string) => {
  const parsed = JSON.parse(message) as { eventId?: unknown; payload?: unknown };
  if (typeof parsed.eventId !== "string") throw new Error("Invalid Quake 3 event id");
  const payload = quake3EventSchema.parse(parsed.payload);
  await gameQueue.add("process-quake3-event", { ...payload, eventId: parsed.eventId }, {
    jobId: `q3-${parsed.eventId}`
  });
};
