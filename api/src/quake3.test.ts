import assert from "node:assert/strict";
import test from "node:test";
import {
  killPayout,
  parseStatusResponse,
  quake3EventId,
  quake3EventSchema,
  quake3IdentityForWallet,
  quake3PlayUrl
} from "./quake3.js";

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

test("builds a Q3JS wager handoff with the dedicated server metadata", () => {
  const url = new URL(quake3PlayUrl("b1v1_test_player"));
  assert.equal(url.searchParams.get("name"), "b1v1_test_player");
  assert.equal(url.searchParams.get("baseGame"), "baseq3");
  assert.equal(url.searchParams.get("fsGame"), "q3js");
  assert.equal(url.searchParams.get("serverMode"), "Tournament");
  assert.equal(url.searchParams.get("serverMap"), "q3dm17");
  assert.equal(url.searchParams.get("official"), "0");
  assert.equal(url.searchParams.get("entryPoint"), "bet1v1_wager");
  assert.match(url.searchParams.get("handoffId") ?? "", /^[0-9a-f-]{36}$/);
});

test("returns only the authenticated wallet's private Quake identity", () => {
  const wager = {
    game: "QUAKE3",
    maker: "maker-wallet",
    opponent: "opponent-wallet",
    quake_maker_handle: "b1v1_private_maker",
    quake_opponent_handle: "b1v1_private_opponent",
    maker_client_num: 3,
    opponent_client_num: null
  };
  const maker = quake3IdentityForWallet(wager, "maker-wallet");
  const opponent = quake3IdentityForWallet(wager, "opponent-wallet");
  assert.equal(maker?.playerName, "b1v1_private_maker");
  assert.equal(maker?.connected, true);
  assert.equal(maker?.clientNum, 3);
  assert.equal(opponent?.playerName, "b1v1_private_opponent");
  assert.equal(opponent?.connected, false);
  assert.equal(opponent?.clientNum, null);
  assert.equal(quake3IdentityForWallet(wager, "somebody-else"), null);
  assert.equal(quake3IdentityForWallet({ ...wager, game: "CS2" }, "maker-wallet"), null);
});
