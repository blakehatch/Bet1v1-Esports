import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import test from "node:test";
import { config } from "./config.js";
import {
  cashOutNotificationPlan,
  centerPrintCommand,
  formatWagerMoney,
  formatUsdEstimate,
  incrementalNotificationPlan,
  Quake3NotificationScheduler,
  remainingBalancesAfterIncrement,
  rconPacket,
  sayCommand,
  sendQuake3Rcon,
  tellCommand,
  winnerTakeAllNotificationPlan
} from "./quake3-rcon.js";

test("formats SOL and USDC base units without floating-point rounding", () => {
  assert.equal(formatWagerMoney(400_000_000n, "SOL"), "0.4 SOL");
  assert.equal(formatWagerMoney(1_000_000n, "USDC"), "1 USDC");
  assert.equal(formatWagerMoney(250_000n, "USDC"), "0.25 USDC");
  assert.equal(formatWagerMoney(1n, "USDC"), "0.000001 USDC");
  assert.throws(() => formatWagerMoney(-1n, "SOL"), /cannot be negative/);
});

test("builds private remaining-balance and public incremental-win messages", () => {
  assert.deepEqual(
    incrementalNotificationPlan({
      winnerName: "b1v1_maker",
      makerName: "b1v1_maker",
      opponentName: "b1v1_opponent",
      won: 250_000n,
      asset: "USDC",
      makerClientNum: 1,
      opponentClientNum: 2,
      makerBalance: 1_250_000n,
      opponentBalance: 750_000n
    }),
    {
      immediate: [
        'say "Bet1v1: b1v1_maker won 0.25 USDC | 1.25 vs 0.75 USDC"',
        'cp "Bet1v1: b1v1_maker won 0.25 USDC | 1.25 vs 0.75 USDC"',
        'tell 1 "Bet1v1: b1v1_maker won 0.25 USDC | 1.25 vs 0.75 USDC"',
        'tell 2 "Bet1v1: b1v1_maker won 0.25 USDC | 1.25 vs 0.75 USDC"'
      ],
      repeats: [
        {
          delayMs: 2_500,
          commands: [
            'cp "Bet1v1: b1v1_maker won 0.25 USDC | 1.25 vs 0.75 USDC"',
            'tell 1 "Bet1v1: b1v1_maker won 0.25 USDC | 1.25 vs 0.75 USDC"',
            'tell 2 "Bet1v1: b1v1_maker won 0.25 USDC | 1.25 vs 0.75 USDC"'
          ]
        },
        {
          delayMs: 5_000,
          commands: ['cp "Bet1v1: b1v1_maker won 0.25 USDC | 1.25 vs 0.75 USDC"']
        }
      ]
    }
  );
});

test("calculates both players' remaining balances after an increment", () => {
  assert.deepEqual(
    remainingBalancesAfterIncrement(1_000_000n, 1_000_000n, true, 250_000n, false),
    { makerRemaining: 1_000_000n, opponentRemaining: 750_000n }
  );
  assert.deepEqual(
    remainingBalancesAfterIncrement(1_000_000n, 750_000n, false, 250_000n, false),
    { makerRemaining: 750_000n, opponentRemaining: 750_000n }
  );
  assert.deepEqual(
    remainingBalancesAfterIncrement(1_000_000n, 250_000n, true, 250_000n, true),
    { makerRemaining: 0n, opponentRemaining: 0n }
  );
  assert.throws(
    () => remainingBalancesAfterIncrement(1n, 1n, true, 2n, false),
    /exceeds the remaining wager balance/
  );
});

test("omits a private message when the player is no longer connected", () => {
  assert.deepEqual(
    incrementalNotificationPlan({
      winnerName: "b1v1_maker",
      makerName: "b1v1_maker",
      opponentName: "b1v1_opponent",
      won: 1n,
      asset: "USDC",
      makerClientNum: null,
      opponentClientNum: 4,
      makerBalance: 2_000_000n,
      opponentBalance: 0n
    }),
    {
      immediate: [
        'say "Bet1v1: b1v1_maker won 0.000001 USDC | 2 vs 0 USDC"',
        'cp "Bet1v1: b1v1_maker won 0.000001 USDC | 2 vs 0 USDC"',
        'tell 4 "Bet1v1: b1v1_maker won 0.000001 USDC | 2 vs 0 USDC"'
      ],
      repeats: [
        {
          delayMs: 2_500,
          commands: [
            'cp "Bet1v1: b1v1_maker won 0.000001 USDC | 2 vs 0 USDC"',
            'tell 4 "Bet1v1: b1v1_maker won 0.000001 USDC | 2 vs 0 USDC"'
          ]
        },
        {
          delayMs: 5_000,
          commands: ['cp "Bet1v1: b1v1_maker won 0.000001 USDC | 2 vs 0 USDC"']
        }
      ]
    }
  );
});

test("announces a winner-take-all winner and the total pot", () => {
  const message = "Bet1v1: b1v1_winner won 0.4 SOL total.";
  assert.deepEqual(winnerTakeAllNotificationPlan("b1v1_winner", 400_000_000n, "SOL"), {
    immediate: [sayCommand(message), centerPrintCommand(message)],
    repeats: [2_500, 5_000, 7_500, 10_000].map((delayMs) => ({
      delayMs,
      commands: [centerPrintCommand(message)]
    }))
  });
});

test("adds a readable USD estimate and versus balances to SOL wins", () => {
  assert.equal(formatUsdEstimate(50_000_000n, 200), " (~$10.00)");
  const plan = incrementalNotificationPlan({
    winnerName: "alpha",
    makerName: "alpha",
    opponentName: "bravo",
    won: 50_000_000n,
    asset: "SOL",
    solUsdPrice: 200,
    makerClientNum: 1,
    opponentClientNum: 2,
    makerBalance: 1_050_000_000n,
    opponentBalance: 950_000_000n
  });
  assert.equal(
    plan.immediate[0],
    'say "Bet1v1: alpha won 0.05 SOL (~$10.00) | 1.05 vs 0.95 SOL"'
  );
  assert.equal(plan.immediate[1]?.replace(/^cp /, "say "), plan.immediate[0]);
  assert.equal(plan.immediate[2]?.replace(/^tell 1 /, "say "), plan.immediate[0]);
});

test("puts the winner's balance first without repeating either name", () => {
  const plan = incrementalNotificationPlan({
    winnerName: "bravo",
    makerName: "alpha",
    opponentName: "bravo",
    won: 50_000_000n,
    asset: "SOL",
    makerClientNum: 1,
    opponentClientNum: 2,
    makerBalance: 950_000_000n,
    opponentBalance: 1_050_000_000n
  });
  assert.equal(
    plan.immediate[0],
    'say "Bet1v1: bravo won 0.05 SOL | 1.05 vs 0.95 SOL"'
  );
  assert.equal(plan.immediate[0]?.match(/bravo/g)?.length, 1);
  assert.equal(plan.immediate[0]?.includes("alpha"), false);
});

test("announces both final balances when players cash out early", () => {
  const plan = cashOutNotificationPlan({
    makerName: "alpha",
    opponentName: "bravo",
    makerBalance: 1_050_000_000n,
    opponentBalance: 950_000_000n,
    asset: "SOL",
    solUsdPrice: 200,
    makerClientNum: 1,
    opponentClientNum: 2
  });
  const summary = 'Bet1v1: Match cashed out | alpha 1.05 SOL (~$210.00) vs bravo 0.95 SOL (~$190.00)';
  assert.equal(plan.immediate[0], `say "${summary}"`);
  assert.equal(plan.immediate[1], `cp "${summary}"`);
  assert.equal(plan.immediate[2], `tell 1 "${summary}"`);
  assert.equal(plan.repeats[0]?.delayMs, 2_500);
  assert.equal(plan.repeats[1]?.delayMs, 5_000);
});

test("supersedes pending repeats when a newer score notification arrives", async () => {
  const deliveries: string[] = [];
  const scheduler = new Quake3NotificationScheduler(async (commands) => {
    deliveries.push(...commands);
    return true;
  });
  await scheduler.notify("wager-1", {
    immediate: ["old-now"],
    repeats: [{ delayMs: 20, commands: ["old-repeat"] }]
  });
  await scheduler.notify("wager-1", {
    immediate: ["new-now"],
    repeats: [{ delayMs: 5, commands: ["new-repeat"] }]
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  scheduler.close();
  assert.deepEqual(deliveries, ["old-now", "new-now", "new-repeat"]);
});

test("escapes message text that could inject another RCON command", () => {
  assert.equal(sayCommand('winner"; map q3dm1\nnow'), 'say "winner map q3dm1 now"');
  assert.equal(centerPrintCommand('winner"; quit'), 'cp "winner quit"');
  assert.equal(tellCommand(3, "balance; quit"), 'tell 3 "balance quit"');
  assert.throws(() => tellCommand(-1, "bad"), /non-negative integer/);
});

test("encodes the ioquake3 connectionless RCON packet", () => {
  const packet = rconPacket("secret", 'say "hello"');
  assert.deepEqual([...packet.subarray(0, 4)], [255, 255, 255, 255]);
  assert.equal(packet.subarray(4).toString(), 'rcon secret say "hello"\n');
  assert.throws(() => rconPacket("bad secret", "status"), /no whitespace/);
  assert.throws(() => rconPacket("secret", "say ok\nquit"), /Invalid/);
});

test("sends an RCON packet to the configured Quake UDP server", async () => {
  const server = createSocket("udp4");
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string") throw new Error("Expected a UDP address");
  const original = {
    host: config.quake3StatusHost,
    port: config.quake3StatusPort,
    password: config.quake3RconPassword
  };
  config.quake3StatusHost = "127.0.0.1";
  config.quake3StatusPort = address.port;
  config.quake3RconPassword = "test-secret";
  try {
    const received = new Promise<Buffer>((resolve) => server.once("message", resolve));
    await sendQuake3Rcon('say "paid"');
    assert.equal(
      (await received).subarray(4).toString(),
      'rcon test-secret say "paid"\n'
    );
  } finally {
    config.quake3StatusHost = original.host;
    config.quake3StatusPort = original.port;
    config.quake3RconPassword = original.password;
    server.close();
  }
});
