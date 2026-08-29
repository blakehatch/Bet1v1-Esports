import pg from "pg";
import { config } from "./config.js";

export const db = new pg.Pool({ connectionString: config.databaseUrl });

export const migrate = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      wallet TEXT PRIMARY KEY,
      steam_id TEXT,
      stake_amount NUMERIC(20, 0) NOT NULL DEFAULT 0,
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS friendships (
      wallet_a TEXT NOT NULL,
      wallet_b TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (wallet_a, wallet_b),
      CHECK (wallet_a <> wallet_b)
    );

    CREATE TABLE IF NOT EXISTS wagers (
      wager_id BIGSERIAL PRIMARY KEY,
      maker TEXT NOT NULL,
      challenger TEXT,
      opponent TEXT,
      amount NUMERIC(20, 0) NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      server_address TEXT,
      winner TEXT,
      chain_signature TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

export const serializeWager = (row: Record<string, unknown>) => ({
  wagerId: String(row.wager_id),
  maker: row.maker,
  challenger: row.challenger,
  opponent: row.opponent,
  amount: String(row.amount),
  status: row.status,
  serverAddress: row.server_address,
  winner: row.winner,
  chainSignature: row.chain_signature,
  createdAt: row.created_at
});
