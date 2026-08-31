import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createSocket } from "node:dgram";
import { z } from "zod";
import { config } from "./config.js";

const player = z.object({ clientNum: z.number().int().nonnegative(), name: z.string().min(1).max(64) });

export const quake3EventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("join"), player, gameTime: z.number(), serverTime: z.number(), map: z.string() }),
  z.object({ event: z.literal("leave"), player, gameTime: z.number(), serverTime: z.number(), map: z.string() }),
  z.object({
    event: z.literal("kill"),
    killer: player,
    victim: player,
    meansOfDeath: z.number().int(),
    gameTime: z.number(),
    serverTime: z.number(),
    map: z.string()
  })
]);

export type Quake3Event = z.infer<typeof quake3EventSchema>;
export type Quake3QueuedEvent = Quake3Event & { eventId: string };

export const quake3EventId = (event: Quake3Event) =>
  createHash("sha256").update(JSON.stringify(event)).digest("hex");

export const validEventSecret = (candidate: unknown) => {
  if (typeof candidate !== "string") return false;
  const expected = Buffer.from(config.quake3EventSecret);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export type Quake3Score = { score: number; ping: number; name: string };

export const killPayout = (killValue: bigint, victimRemaining: bigint) =>
  killValue < victimRemaining ? killValue : victimRemaining;

export const parseStatusResponse = (response: string): Quake3Score[] => {
  const lines = response.replace(/^\xff\xff\xff\xffstatusResponse\n/, "").split("\n");
  return lines.slice(1).flatMap((line) => {
    const match = line.match(/^(-?\d+)\s+(-?\d+)\s+"(.*)"$/);
    return match ? [{ score: Number(match[1]), ping: Number(match[2]), name: match[3]! }] : [];
  });
};

export const getQuake3Scores = (timeoutMs = 1_000) =>
  new Promise<Quake3Score[]>((resolve, reject) => {
    const socket = createSocket("udp4");
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Quake 3 getstatus timed out"));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    });
    socket.once("message", (message) => {
      clearTimeout(timeout);
      socket.close();
      resolve(parseStatusResponse(message.toString("latin1")));
    });
    const request = Buffer.concat([Buffer.from([255, 255, 255, 255]), Buffer.from("getstatus\n")]);
    socket.send(request, config.quake3StatusPort, config.quake3StatusHost);
  });

export const quake3PlayUrl = (playerName: string) => {
  const [host, rawPort] = config.quake3ServerAddress.split(":");
  const url = new URL(config.quake3ClientUrl);
  url.searchParams.set("host", host ?? "127.0.0.1");
  url.searchParams.set("proxyPort", rawPort ?? "27961");
  url.searchParams.set("secure", config.quake3Secure ? "1" : "0");
  url.searchParams.set("baseGame", "baseq3");
  url.searchParams.set("comGameName", "Quake3Arena");
  url.searchParams.set("serverName", "Bet 1v1 Q3JS");
  url.searchParams.set("name", playerName);
  url.searchParams.set("serverMode", "Tournament");
  url.searchParams.set("serverMap", "q3dm17");
  url.searchParams.set("official", "0");
  url.searchParams.set("humanPlayers", "0");
  url.searchParams.set("entryPoint", "bet1v1_wager");
  url.searchParams.set("handoffId", randomUUID());
  url.searchParams.set("voice", "0");
  url.searchParams.set("fsGame", "q3js");
  return url.toString();
};
