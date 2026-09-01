import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertValidWagerTerms,
  assertWagerAccess,
  assertWagerCanBeAccepted,
  assertWinnerIsParticipant,
  MAX_TOKEN_AMOUNT,
  optionalWagerAmount,
  wagerAmount,
  WagerRuleError,
  winnerAtFragLimit
} from "./wagers.js";

const maker = "maker-wallet";
const opponent = "opponent-wallet";
const stranger = "stranger-wallet";

const winnerTakeAll = {
  maker,
  challenger: null,
  amount: "100",
  asset: "USDC" as const,
  game: "QUAKE3" as const,
  payoutMode: "WINNER_TAKE_ALL" as const,
  fragLimit: 10,
  incrementValue: "0"
};

const incremental = {
  ...winnerTakeAll,
  payoutMode: "INCREMENTAL" as const,
  incrementValue: "10"
};

const expectRuleError = (action: () => void, message: string, statusCode = 400) => {
  assert.throws(action, (error) => {
    assert.ok(error instanceof WagerRuleError);
    assert.equal(error.message, message);
    assert.equal(error.statusCode, statusCode);
    return true;
  });
};

describe("wager token amounts", () => {
  test("accepts the smallest positive wager", () => {
    assert.equal(wagerAmount.safeParse("1").success, true);
  });

  test("accepts leading zeroes without changing the integer value", () => {
    assert.equal(wagerAmount.safeParse("0001").success, true);
  });

  test("accepts the largest u64 wager", () => {
    assert.equal(wagerAmount.safeParse(MAX_TOKEN_AMOUNT.toString()).success, true);
  });

  test("rejects zero for the wager bankroll", () => {
    assert.equal(wagerAmount.safeParse("0").success, false);
  });

  test("allows zero for an unused increment value", () => {
    assert.equal(optionalWagerAmount.safeParse("0").success, true);
  });

  test("rejects an amount larger than u64", () => {
    assert.equal(wagerAmount.safeParse((MAX_TOKEN_AMOUNT + 1n).toString()).success, false);
  });

  test("rejects signs, decimals, exponents, whitespace, and empty values", () => {
    for (const value of ["-1", "+1", "1.5", "1e9", " 1", "1 ", ""]) {
      assert.equal(wagerAmount.safeParse(value).success, false, `${JSON.stringify(value)} should be invalid`);
    }
  });

  test("rejects non-string amounts", () => {
    for (const value of [1, 1n, null, undefined, {}, []]) {
      assert.equal(wagerAmount.safeParse(value).success, false);
    }
  });

  test("returns a clear validation issue for malformed amounts", () => {
    const result = wagerAmount.safeParse("1.5");
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.issues[0]?.message, "Invalid token amount");
  });
});

describe("wager creation rules", () => {
  test("accepts a standard winner-take-all Quake wager", () => {
    assert.doesNotThrow(() => assertValidWagerTerms(winnerTakeAll, 10));
  });

  test("accepts an increment value equal to the full bankroll", () => {
    assert.doesNotThrow(() => assertValidWagerTerms({ ...incremental, incrementValue: "100" }, 10));
  });

  test("rejects a zero increment value", () => {
    expectRuleError(
      () => assertValidWagerTerms({ ...incremental, incrementValue: "0" }, 10),
      "Increment value must be positive and cannot exceed either player's bankroll"
    );
  });

  test("rejects an increment value larger than the bankroll", () => {
    expectRuleError(
      () => assertValidWagerTerms({ ...incremental, incrementValue: "101" }, 10),
      "Increment value must be positive and cannot exceed either player's bankroll"
    );
  });

  test("rejects incremental payouts for unsupported games", () => {
    expectRuleError(
      () => assertValidWagerTerms({ ...incremental, game: "CS2" }, 10),
      "Incremental payouts are currently supported only for Quake 3"
    );
  });

  test("accepts incremental payouts in native SOL", () => {
    assert.doesNotThrow(() => assertValidWagerTerms({ ...incremental, asset: "SOL" }, 10));
  });

  test("rejects an increment value on winner-take-all wagers", () => {
    expectRuleError(
      () => assertValidWagerTerms({ ...winnerTakeAll, incrementValue: "1" }, 10),
      "Winner-take-all wagers cannot set an increment value"
    );
  });

  test("treats a zero-padded increment value as zero for winner-take-all", () => {
    assert.doesNotThrow(() => assertValidWagerTerms({ ...winnerTakeAll, incrementValue: "00" }, 10));
  });

  test("requires winner-take-all Quake wagers to match the server fraglimit", () => {
    expectRuleError(
      () => assertValidWagerTerms({ ...winnerTakeAll, fragLimit: 9 }, 10),
      "This Quake 3 server uses fraglimit 10"
    );
  });

  test("does not apply the shared Quake fraglimit to CS2", () => {
    assert.doesNotThrow(() => assertValidWagerTerms({ ...winnerTakeAll, game: "CS2", fragLimit: 3 }, 10));
  });

  test("does not apply the match fraglimit rule to incremental wagers", () => {
    assert.doesNotThrow(() => assertValidWagerTerms({ ...incremental, fragLimit: 99 }, 10));
  });

  test("rejects challenging the maker's own wallet", () => {
    expectRuleError(
      () => assertValidWagerTerms({ ...winnerTakeAll, challenger: maker }, 10),
      "A maker cannot challenge itself"
    );
  });
});

describe("wager access", () => {
  test("allows a wallet with platform access", () => {
    assert.doesNotThrow(() => assertWagerAccess(true));
  });

  test("returns a clear forbidden error without platform access", () => {
    expectRuleError(() => assertWagerAccess(false), "Active token stake required", 403);
  });
});

describe("wager acceptance rules", () => {
  const openWager = { maker, challenger: null, game: "CS2" as const, status: "OPEN" };

  test("accepts an open public wager", () => {
    assert.doesNotThrow(() => assertWagerCanBeAccepted(openWager, opponent, false));
  });

  test("accepts a reserved wager for its intended challenger", () => {
    assert.doesNotThrow(() => assertWagerCanBeAccepted({ ...openWager, challenger: opponent }, opponent, false));
  });

  test("rejects a missing wager", () => {
    expectRuleError(() => assertWagerCanBeAccepted(undefined, opponent, false), "Wager is unavailable", 409);
  });

  test("rejects an already matched wager", () => {
    expectRuleError(
      () => assertWagerCanBeAccepted({ ...openWager, status: "MATCHED" }, opponent, false),
      "Wager is unavailable",
      409
    );
  });

  test("rejects the maker accepting their own wager", () => {
    expectRuleError(() => assertWagerCanBeAccepted(openWager, maker, false), "Wager is unavailable", 409);
  });

  test("rejects a stranger from a reserved wager", () => {
    expectRuleError(
      () => assertWagerCanBeAccepted({ ...openWager, challenger: opponent }, stranger, false),
      "Wager is unavailable",
      409
    );
  });

  test("rejects Quake acceptance while the shared server is occupied", () => {
    expectRuleError(
      () => assertWagerCanBeAccepted({ ...openWager, game: "QUAKE3" }, opponent, true),
      "The shared Quake 3 server already has an active wager",
      409
    );
  });

  test("does not apply Quake server occupancy to CS2", () => {
    assert.doesNotThrow(() => assertWagerCanBeAccepted(openWager, opponent, true));
  });
});

describe("wager winners", () => {
  test("has no winner below the fraglimit", () => {
    assert.equal(winnerAtFragLimit(9, 9, 10, maker, opponent), undefined);
  });

  test("negative Quake scores do not produce a winner", () => {
    assert.equal(winnerAtFragLimit(-1, -5, 10, maker, opponent), undefined);
  });

  test("selects the maker exactly at the fraglimit", () => {
    assert.equal(winnerAtFragLimit(10, 9, 10, maker, opponent), maker);
  });

  test("selects the opponent above the fraglimit", () => {
    assert.equal(winnerAtFragLimit(2, 11, 10, maker, opponent), opponent);
  });

  test("deterministically selects the maker if both reported scores reach the limit", () => {
    assert.equal(winnerAtFragLimit(10, 10, 10, maker, opponent), maker);
  });

  test("allows either participant as a reported winner", () => {
    assert.doesNotThrow(() => assertWinnerIsParticipant(maker, maker, opponent));
    assert.doesNotThrow(() => assertWinnerIsParticipant(opponent, maker, opponent));
  });

  test("rejects a reported winner outside the wager", () => {
    expectRuleError(
      () => assertWinnerIsParticipant(stranger, maker, opponent),
      "Winner is not a wager participant"
    );
  });
});
