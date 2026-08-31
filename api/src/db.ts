import pg from "pg";
import { config } from "./config.js";

export const db = new pg.Pool({ connectionString: config.databaseUrl });

const migrationSql = `
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

    CREATE TABLE IF NOT EXISTS wallet_challenges (
      wallet TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_sessions (
      token_hash TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS api_sessions_wallet_idx ON api_sessions (wallet);

    CREATE TABLE IF NOT EXISTS wagers (
      wager_id BIGSERIAL PRIMARY KEY,
      maker TEXT NOT NULL,
      challenger TEXT,
      opponent TEXT,
      amount NUMERIC(20, 0) NOT NULL,
      game TEXT NOT NULL DEFAULT 'CS2' CHECK (game IN ('CS2', 'QUAKE3')),
      status TEXT NOT NULL DEFAULT 'OPEN',
      server_address TEXT,
      winner TEXT,
      chain_signature TEXT,
      payout_mode TEXT NOT NULL DEFAULT 'WINNER_TAKE_ALL',
      frag_limit INTEGER NOT NULL DEFAULT 10,
      kill_value NUMERIC(20, 0) NOT NULL DEFAULT 0,
      maker_remaining NUMERIC(20, 0) NOT NULL DEFAULT 0,
      opponent_remaining NUMERIC(20, 0) NOT NULL DEFAULT 0,
      maker_score INTEGER NOT NULL DEFAULT 0,
      opponent_score INTEGER NOT NULL DEFAULT 0,
      quake_maker_handle TEXT,
      quake_opponent_handle TEXT,
      maker_client_num INTEGER,
      opponent_client_num INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE wagers
      ADD COLUMN IF NOT EXISTS game TEXT NOT NULL DEFAULT 'CS2'
      CHECK (game IN ('CS2', 'QUAKE3'));

    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS payout_mode TEXT NOT NULL DEFAULT 'WINNER_TAKE_ALL';
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS frag_limit INTEGER NOT NULL DEFAULT 10;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS kill_value NUMERIC(20, 0) NOT NULL DEFAULT 0;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS maker_remaining NUMERIC(20, 0) NOT NULL DEFAULT 0;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS opponent_remaining NUMERIC(20, 0) NOT NULL DEFAULT 0;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS maker_score INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS opponent_score INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS quake_maker_handle TEXT;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS quake_opponent_handle TEXT;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS maker_client_num INTEGER;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS opponent_client_num INTEGER;

    CREATE UNIQUE INDEX IF NOT EXISTS wagers_quake_maker_handle_idx
      ON wagers (quake_maker_handle) WHERE quake_maker_handle IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS wagers_quake_opponent_handle_idx
      ON wagers (quake_opponent_handle) WHERE quake_opponent_handle IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS wagers_one_active_quake_idx
      ON wagers (game) WHERE game = 'QUAKE3' AND status IN ('MATCHED', 'SETTLING');

    CREATE TABLE IF NOT EXISTS quake_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      wager_id BIGINT REFERENCES wagers(wager_id),
      outcome TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS kill_payouts (
      event_id TEXT PRIMARY KEY REFERENCES quake_events(event_id),
      wager_id BIGINT NOT NULL REFERENCES wagers(wager_id),
      killer TEXT NOT NULL,
      victim TEXT NOT NULL,
      amount NUMERIC(20, 0) NOT NULL,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      chain_signature TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (wager_id, sequence)
    );
  `;

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export const migrate = async () => {
  const attempts = 15;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await db.query(migrationSql);
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }

      const delay = Math.min(250 * 2 ** (attempt - 1), 2_000);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Database unavailable during startup (${message}); retrying in ${delay}ms ` +
          `(${attempt}/${attempts})`
      );
      await wait(delay);
    }
  }
};

export const serializeWager = (row: Record<string, unknown>) => ({
  wagerId: String(row.wager_id),
  maker: row.maker,
  challenger: row.challenger,
  opponent: row.opponent,
  amount: String(row.amount),
  game: row.game,
  status: row.status,
  serverAddress: row.server_address,
  winner: row.winner,
  chainSignature: row.chain_signature,
  payoutMode: row.payout_mode,
  fragLimit: Number(row.frag_limit),
  killValue: String(row.kill_value),
  makerRemaining: String(row.maker_remaining),
  opponentRemaining: String(row.opponent_remaining),
  makerScore: Number(row.maker_score),
  opponentScore: Number(row.opponent_score),
  createdAt: row.created_at
});
