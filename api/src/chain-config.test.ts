import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { decodeConfigAccount, decodeWagerAccount } from "./chain.js";

test("decodes the complete Anchor config layout at the correct offsets", () => {
  const authority = Keypair.generate().publicKey;
  const chainAuthority = Keypair.generate().publicKey;
  const tokenMint = Keypair.generate().publicKey;
  const usdcMint = Keypair.generate().publicKey;
  const data = Buffer.alloc(178);
  authority.toBuffer().copy(data, 8);
  chainAuthority.toBuffer().copy(data, 40);
  tokenMint.toBuffer().copy(data, 72);
  usdcMint.toBuffer().copy(data, 104);
  data.writeBigUInt64LE(987_654_321n, 136);
  data[144] = 1;
  data[145] = 254;

  const decoded = decodeConfigAccount(data);
  assert.equal(decoded.tokenMint.toBase58(), tokenMint.toBase58());
  assert.equal(decoded.usdcMint.toBase58(), usdcMint.toBase58());
  assert.equal(decoded.requiredStake, 987_654_321n);
  assert.equal(decoded.stakingEnabled, true);
});

test("rejects truncated config accounts", () => {
  assert.throws(
    () => decodeConfigAccount(Buffer.alloc(145)),
    /Program config is not initialized/
  );
});

test("decodes on-chain wager balances used for cash-out", () => {
  const maker = Keypair.generate().publicKey;
  const challenger = Keypair.generate().publicKey;
  const opponent = Keypair.generate().publicKey;
  const tokenMint = Keypair.generate().publicKey;
  const data = Buffer.alloc(219);
  maker.toBuffer().copy(data, 16);
  challenger.toBuffer().copy(data, 48);
  opponent.toBuffer().copy(data, 80);
  data.writeBigUInt64LE(100_000_000n, 112);
  tokenMint.toBuffer().copy(data, 120);
  data[184] = 1;
  data[185] = 1;
  data.writeBigUInt64LE(100_000_000n, 194);
  data.writeBigUInt64LE(75_000_000n, 202);

  const decoded = decodeWagerAccount(data);
  assert.equal(decoded.maker.toBase58(), maker.toBase58());
  assert.equal(decoded.challenger.toBase58(), challenger.toBase58());
  assert.equal(decoded.opponent.toBase58(), opponent.toBase58());
  assert.equal(decoded.amount, 100_000_000n);
  assert.equal(decoded.tokenMint.toBase58(), tokenMint.toBase58());
  assert.equal(decoded.status, 1);
  assert.equal(decoded.payoutMode, 1);
  assert.equal(decoded.makerRemaining, 100_000_000n);
  assert.equal(decoded.opponentRemaining, 75_000_000n);
});

test("rejects truncated wager accounts before cash-out", () => {
  assert.throws(
    () => decodeWagerAccount(Buffer.alloc(209)),
    /Program wager account is truncated/
  );
});
