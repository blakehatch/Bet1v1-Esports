import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { db } from "./db.js";

const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const createChallenge = async (wallet: string) => {
  const nonce = randomBytes(24).toString("hex");
  const message = `Bet1v1 wallet login\nWallet: ${wallet}\nNonce: ${nonce}\nThis does not authorize a transaction.`;
  await db.query(
    `INSERT INTO wallet_challenges (wallet, nonce, message, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')
     ON CONFLICT (wallet) DO UPDATE SET nonce = EXCLUDED.nonce, message = EXCLUDED.message, expires_at = EXCLUDED.expires_at`,
    [wallet, nonce, message]
  );
  return { nonce, message };
};

export const verifyChallenge = async (wallet: string, nonce: string, signature: number[]) => {
  const result = await db.query(
    `DELETE FROM wallet_challenges WHERE wallet = $1 AND nonce = $2 AND expires_at > NOW()
     RETURNING message`,
    [wallet, nonce]
  );
  const message = result.rows[0]?.message as string | undefined;
  if (!message) throw new Error("Wallet challenge is missing or expired");
  const rawPublicKey = new PublicKey(wallet).toBuffer();
  const publicKey = createPublicKey({
    key: Buffer.concat([ed25519SpkiPrefix, rawPublicKey]),
    format: "der",
    type: "spki"
  });
  if (!verify(null, Buffer.from(message), publicKey, Buffer.from(signature))) {
    throw new Error("Invalid wallet signature");
  }
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO api_sessions (token_hash, wallet, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
    [hashToken(token), wallet]
  );
  return { token, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
};

export const requireWalletSession = async (authorization: unknown, wallet: string) => {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw Object.assign(new Error("Wallet authentication required"), { statusCode: 401 });
  }
  const result = await db.query(
    `SELECT 1 FROM api_sessions WHERE token_hash = $1 AND wallet = $2 AND expires_at > NOW()`,
    [hashToken(authorization.slice(7)), wallet]
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error("Wallet session is invalid or expired"), { statusCode: 401 });
  }
};
