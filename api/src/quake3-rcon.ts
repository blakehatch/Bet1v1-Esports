import { createSocket } from "node:dgram";
import { config } from "./config.js";

export type WagerAsset = "SOL" | "USDC";

const decimals: Record<WagerAsset, number> = { SOL: 9, USDC: 6 };

export const formatWagerMoney = (amount: bigint, asset: WagerAsset) => {
  if (amount < 0n) throw new Error("Wager money cannot be negative");
  const scale = 10n ** BigInt(decimals[asset]);
  const whole = amount / scale;
  const fraction = (amount % scale)
    .toString()
    .padStart(decimals[asset], "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} ${asset}`;
};

export const formatUsdEstimate = (amount: bigint, solUsdPrice?: number) => {
  if (!solUsdPrice || !Number.isFinite(solUsdPrice) || solUsdPrice <= 0) return "";
  return ` (~$${(Number(amount) / 1_000_000_000 * solUsdPrice).toFixed(2)})`;
};

const safeMessage = (message: string) =>
  message
    .replace(/[\u0000-\u001f"\\;]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);

export const sayCommand = (message: string) => `say "${safeMessage(message)}"`;

export const centerPrintCommand = (message: string) => `cp "${safeMessage(message)}"`;

export const tellCommand = (clientNum: number, message: string) => {
  if (!Number.isInteger(clientNum) || clientNum < 0) {
    throw new Error("Quake 3 client number must be a non-negative integer");
  }
  return `tell ${clientNum} "${safeMessage(message)}"`;
};

export const remainingBalancesAfterIncrement = (
  makerRemaining: bigint,
  opponentRemaining: bigint,
  beneficiaryIsMaker: boolean,
  amount: bigint,
  finalIncrement: boolean
) => {
  if (finalIncrement) return { makerRemaining: 0n, opponentRemaining: 0n };
  const nextMaker = makerRemaining - (beneficiaryIsMaker ? 0n : amount);
  const nextOpponent = opponentRemaining - (beneficiaryIsMaker ? amount : 0n);
  if (nextMaker < 0n || nextOpponent < 0n) {
    throw new Error("Incremental payout exceeds the remaining wager balance");
  }
  return { makerRemaining: nextMaker, opponentRemaining: nextOpponent };
};

type IncrementalNotification = {
  winnerName: string;
  makerName: string;
  opponentName: string;
  won: bigint;
  asset: WagerAsset;
  solUsdPrice?: number;
  makerClientNum: number | null;
  opponentClientNum: number | null;
  makerBalance: bigint;
  opponentBalance: bigint;
};

export type Quake3NotificationPlan = {
  immediate: string[];
  repeats: { delayMs: number; commands: string[] }[];
};

const privateSummaryCommands = (notification: IncrementalNotification, summary: string) => {
  const commands: string[] = [];
  if (notification.makerClientNum !== null) {
    commands.push(tellCommand(notification.makerClientNum, summary));
  }
  if (notification.opponentClientNum !== null) {
    commands.push(tellCommand(notification.opponentClientNum, summary));
  }
  return commands;
};

export const incrementalNotificationPlan = (notification: IncrementalNotification): Quake3NotificationPlan => {
  const estimate = notification.asset === "SOL"
    ? formatUsdEstimate(notification.won, notification.solUsdPrice)
    : "";
  const payoutMessage = `Bet1v1: ${safeMessage(notification.winnerName)} +${formatWagerMoney(notification.won, notification.asset)}${estimate} | ${safeMessage(notification.makerName)} ${formatWagerMoney(notification.makerBalance, notification.asset)} vs ${safeMessage(notification.opponentName)} ${formatWagerMoney(notification.opponentBalance, notification.asset)}`;
  const privateSummaries = privateSummaryCommands(notification, payoutMessage);
  return {
    immediate: [sayCommand(payoutMessage), centerPrintCommand(payoutMessage), ...privateSummaries],
    repeats: [
      { delayMs: 2_500, commands: [centerPrintCommand(payoutMessage), ...privateSummaries] },
      { delayMs: 5_000, commands: [centerPrintCommand(payoutMessage)] }
    ]
  };
};

export const winnerTakeAllNotificationPlan = (
  winnerName: string,
  total: bigint,
  asset: WagerAsset,
  solUsdPrice?: number
): Quake3NotificationPlan => {
  const estimate = asset === "SOL" ? formatUsdEstimate(total, solUsdPrice) : "";
  const winnerMessage = `Bet1v1: ${safeMessage(winnerName)} won ${formatWagerMoney(total, asset)}${estimate} total.`;
  return {
    immediate: [sayCommand(winnerMessage), centerPrintCommand(winnerMessage)],
    repeats: [2_500, 5_000, 7_500, 10_000].map((delayMs) => ({
      delayMs,
      commands: [centerPrintCommand(winnerMessage)]
    }))
  };
};

type CashOutNotification = {
  makerName: string;
  opponentName: string;
  makerBalance: bigint;
  opponentBalance: bigint;
  asset: WagerAsset;
  solUsdPrice?: number;
  makerClientNum: number | null;
  opponentClientNum: number | null;
};

export const cashOutNotificationPlan = (notification: CashOutNotification): Quake3NotificationPlan => {
  const makerEstimate = notification.asset === "SOL"
    ? formatUsdEstimate(notification.makerBalance, notification.solUsdPrice)
    : "";
  const opponentEstimate = notification.asset === "SOL"
    ? formatUsdEstimate(notification.opponentBalance, notification.solUsdPrice)
    : "";
  const message = `Bet1v1: Match cashed out | ${safeMessage(notification.makerName)} ${formatWagerMoney(notification.makerBalance, notification.asset)}${makerEstimate} vs ${safeMessage(notification.opponentName)} ${formatWagerMoney(notification.opponentBalance, notification.asset)}${opponentEstimate}`;
  const privateSummaries = privateSummaryCommands(
    {
      ...notification,
      winnerName: notification.makerName,
      won: 0n
    },
    message
  );
  return {
    immediate: [sayCommand(message), centerPrintCommand(message), ...privateSummaries],
    repeats: [
      { delayMs: 2_500, commands: [centerPrintCommand(message), ...privateSummaries] },
      { delayMs: 5_000, commands: [centerPrintCommand(message)] }
    ]
  };
};

export const rconPacket = (password: string, command: string) => {
  if (!password || /\s|\0/.test(password)) {
    throw new Error("Quake 3 RCON password must be non-empty and contain no whitespace");
  }
  if (!command || /[\0\r\n]/.test(command)) {
    throw new Error("Invalid Quake 3 RCON command");
  }
  return Buffer.concat([
    Buffer.from([255, 255, 255, 255]),
    Buffer.from(`rcon ${password} ${command}\n`)
  ]);
};

export const sendQuake3Rcon = (command: string) => {
  const packet = rconPacket(config.quake3RconPassword, command);
  return new Promise<void>((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (error) => {
      socket.close();
      reject(error);
    });
    socket.send(
      packet,
      config.quake3StatusPort,
      config.quake3StatusHost,
      (error) => {
        socket.close();
        if (error) reject(error);
        else resolve();
      }
    );
  });
};

export const sendQuake3Notifications = async (commands: string[]) => {
  if (!config.quake3RconPassword) return false;
  for (const command of commands) await sendQuake3Rcon(command);
  return true;
};

type NotificationSender = (commands: string[]) => Promise<boolean>;

export class Quake3NotificationScheduler {
  private readonly generations = new Map<string, number>();
  private readonly timers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

  constructor(
    private readonly send: NotificationSender = sendQuake3Notifications,
    private readonly onError: (error: unknown) => void = console.error
  ) {}

  private supersede(key: string) {
    for (const timer of this.timers.get(key) ?? []) clearTimeout(timer);
    this.timers.delete(key);
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    return generation;
  }

  async notify(key: string, plan: Quake3NotificationPlan) {
    const generation = this.supersede(key);
    const enabled = await this.send(plan.immediate);
    if (!enabled || this.generations.get(key) !== generation) return enabled;

    const timers = new Set<ReturnType<typeof setTimeout>>();
    this.timers.set(key, timers);
    for (const repeat of plan.repeats) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (this.generations.get(key) !== generation) return;
        void this.send(repeat.commands).catch(this.onError);
        if (timers.size === 0) this.timers.delete(key);
      }, repeat.delayMs);
      timers.add(timer);
    }
    return enabled;
  }

  cancel(key: string) {
    this.supersede(key);
  }

  close() {
    for (const key of this.timers.keys()) this.supersede(key);
  }
}
