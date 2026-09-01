import assert from "node:assert/strict";
import test from "node:test";
import { parseUncreditedDeath } from "./bet1v1-wrapper.mjs";

test("captures a world/environmental death", () => {
  assert.deepEqual(
    parseUncreditedDeath("Kill: 1022 1 22: <world> killed HuntrX by MOD_TRIGGER_HURT", 123),
    {
      event: "death",
      victim: { clientNum: 1, name: "HuntrX" },
      meansOfDeath: 22,
      observedAt: 123
    }
  );
});

test("captures a suicide", () => {
  assert.deepEqual(
    parseUncreditedDeath("Kill: 0 0 20: Blakewh killed Blakewh by MOD_SUICIDE", 456),
    {
      event: "death",
      victim: { clientNum: 0, name: "Blakewh" },
      meansOfDeath: 20,
      observedAt: 456
    }
  );
});

test("leaves direct player kills to the native Q3JS callback", () => {
  assert.equal(
    parseUncreditedDeath("Kill: 1 0 6: HuntrX killed Blakewh by MOD_ROCKET", 789),
    null
  );
});
