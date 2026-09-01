import assert from "node:assert/strict";
import test from "node:test";
import { username } from "./usernames.js";

test("accepts short readable Quake usernames", () => {
  assert.equal(username.parse("  RocketQueen  "), "RocketQueen");
  assert.equal(username.parse("player-one"), "player-one");
  assert.equal(username.parse("player_two"), "player_two");
});

test("rejects unreadable, injectable, and reserved usernames", () => {
  for (const value of ["ab", "a".repeat(17), "space marine", "^1red", "semi;quit", "admin", "BET1V1"]) {
    assert.equal(username.safeParse(value).success, false, value);
  }
});
