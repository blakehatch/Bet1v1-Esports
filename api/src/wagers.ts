import { z } from "zod";

export const MAX_TOKEN_AMOUNT = 18_446_744_073_709_551_615n;

const tokenAmountSchema = (allowZero: boolean) => z.string().refine(
  (value) => {
    if (!/^\d+$/.test(value)) return false;
    const amount = BigInt(value);
    return (allowZero || amount > 0n) && amount <= MAX_TOKEN_AMOUNT;
  },
  "Invalid token amount"
);

export const wagerAmount = tokenAmountSchema(false);
export const optionalWagerAmount = tokenAmountSchema(true);

export type WagerTerms = {
  maker: string;
  challenger?: string | null;
  amount: string;
  asset: "SOL" | "USDC";
  game: "CS2" | "QUAKE3";
  payoutMode: "WINNER_TAKE_ALL" | "INCREMENTAL";
  fragLimit: number;
  incrementValue: string;
};

export type AcceptableWager = {
  maker: string;
  challenger?: string | null;
  game: "CS2" | "QUAKE3";
  status: string;
};

export class WagerRuleError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

export const assertValidWagerTerms = (terms: WagerTerms, quake3FragLimit: number) => {
  if (terms.challenger === terms.maker) {
    throw new WagerRuleError("A maker cannot challenge itself");
  }
  if (
    terms.payoutMode === "INCREMENTAL"
    && (BigInt(terms.incrementValue) === 0n || BigInt(terms.incrementValue) > BigInt(terms.amount))
  ) {
    throw new WagerRuleError("Increment value must be positive and cannot exceed either player's bankroll");
  }
  if (terms.game !== "QUAKE3" && terms.payoutMode === "INCREMENTAL") {
    throw new WagerRuleError("Incremental payouts are currently supported only for Quake 3");
  }
  if (terms.payoutMode === "WINNER_TAKE_ALL" && BigInt(terms.incrementValue) !== 0n) {
    throw new WagerRuleError("Winner-take-all wagers cannot set an increment value");
  }
  if (
    terms.game === "QUAKE3"
    && terms.payoutMode === "WINNER_TAKE_ALL"
    && terms.fragLimit !== quake3FragLimit
  ) {
    throw new WagerRuleError(`This Quake 3 server uses fraglimit ${quake3FragLimit}`);
  }
};

export const assertWagerAccess = (active: boolean) => {
  if (!active) {
    throw new WagerRuleError("Active token stake required", 403);
  }
};

export const assertWagerCanBeAccepted = (
  wager: AcceptableWager | undefined,
  opponent: string,
  sharedQuakeServerOccupied: boolean
) => {
  if (
    !wager
    || wager.status !== "OPEN"
    || wager.maker === opponent
    || (wager.challenger != null && wager.challenger !== opponent)
  ) {
    throw new WagerRuleError("Wager is unavailable", 409);
  }
  if (wager.game === "QUAKE3" && sharedQuakeServerOccupied) {
    throw new WagerRuleError("The shared Quake 3 server already has an active wager", 409);
  }
};

export const winnerAtFragLimit = (
  makerScore: number,
  opponentScore: number,
  fragLimit: number,
  maker: string,
  opponent: string
) => makerScore >= fragLimit ? maker : opponentScore >= fragLimit ? opponent : undefined;

export const assertWinnerIsParticipant = (winner: string, maker: string, opponent: string) => {
  if (winner !== maker && winner !== opponent) {
    throw new WagerRuleError("Winner is not a wager participant");
  }
};
