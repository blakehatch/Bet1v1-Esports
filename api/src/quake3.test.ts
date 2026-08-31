import assert from "node:assert/strict";
import test from "node:test";
import { killPayout, parseStatusResponse, quake3EventId, quake3EventSchema } from "./quake3.js";

test("parses signed scores and opaque player names from getstatus", () => {
  const response = `${String.fromCharCode(255, 255, 255, 255)}statusResponse\n\\fraglimit\\10\n9 42 "b1v1_maker"\n-1 55 "b1v1_opponent"\n`;
  assert.deepEqual(parseStatusResponse(response), [
    { score: 9, ping: 42, name: "b1v1_maker" },
    { score: -1, ping: 55, name: "b1v1_opponent" }
  ]);
});

test("validates and deterministically identifies Q3JS kill callbacks", () => {
  const event = quake3EventSchema.parse({
    event: "kill",
    killer: { clientNum: 0, name: "b1v1_maker" },
    victim: { clientNum: 1, name: "b1v1_opponent" },
    meansOfDeath: 6,
    gameTime: 100,
    serverTime: 200,
    map: "q3dm17"
  });
  assert.equal(quake3EventId(event), quake3EventId(event));
  assert.throws(() => quake3EventSchema.parse({ ...event, killer: { clientNum: -1, name: "bad" } }));
});

test("caps the final kill tranche at the victim's remaining bankroll", () => {
  assert.equal(killPayout(5n, 100n), 5n);
  assert.equal(killPayout(5n, 2n), 2n);
});
