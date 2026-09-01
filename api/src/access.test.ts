import assert from "node:assert/strict";
import test from "node:test";
import { hasPlatformAccess } from "./access.js";

test("staking disabled leaves the platform ungated", () => {
  assert.equal(hasPlatformAccess(0n, 1_000_000_000n, false, false), true);
});

test("staking enabled requires the configured amount", () => {
  assert.equal(hasPlatformAccess(999_999_999n, 1_000_000_000n, false, true), false);
  assert.equal(hasPlatformAccess(1_000_000_000n, 1_000_000_000n, false, true), true);
});

test("bans still deny access when staking is disabled", () => {
  assert.equal(hasPlatformAccess(0n, 1_000_000_000n, true, false), false);
});
