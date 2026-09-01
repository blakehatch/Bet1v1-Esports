import pg from "pg";
import { config } from "./config.js";

export const db = new pg.Pool({ connectionString: config.databaseUrl });

const migrationSql = `
    CREATE TABLE IF NOT EXISTS users (
      wallet TEXT PRIMARY KEY,
      steam_id TEXT,
      username TEXT,
      stake_amount NUMERIC(20, 0) NOT NULL DEFAULT 0,
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx
      ON users (LOWER(username)) WHERE username IS NOT NULL;

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
      asset TEXT NOT NULL DEFAULT 'SOL' CHECK (asset IN ('SOL', 'USDC')),
      game TEXT NOT NULL DEFAULT 'CS2' CHECK (game IN ('CS2', 'QUAKE3')),
      status TEXT NOT NULL DEFAULT 'OPEN',
      server_address TEXT,
      winner TEXT,
      chain_signature TEXT,
      create_signature TEXT,
      join_signature TEXT,
      settlement_signature TEXT,
      payout_mode TEXT NOT NULL DEFAULT 'WINNER_TAKE_ALL',
      frag_limit INTEGER NOT NULL DEFAULT 10,
      increment_value NUMERIC(20, 0) NOT NULL DEFAULT 0,
      maker_remaining NUMERIC(20, 0) NOT NULL DEFAULT 0,
      opponent_remaining NUMERIC(20, 0) NOT NULL DEFAULT 0,
      maker_score INTEGER NOT NULL DEFAULT 0,
      opponent_score INTEGER NOT NULL DEFAULT 0,
      quake_maker_handle TEXT,
      quake_opponent_handle TEXT,
      maker_client_num INTEGER,
      opponent_client_num INTEGER,
      cashout_requested_by TEXT,
      cashout_requested_at TIMESTAMPTZ,
      maker_final_balance NUMERIC(20, 0),
      opponent_final_balance NUMERIC(20, 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE wagers
      ADD COLUMN IF NOT EXISTS game TEXT NOT NULL DEFAULT 'CS2'
      CHECK (game IN ('CS2', 'QUAKE3'));

    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS asset TEXT NOT NULL DEFAULT 'SOL'
      CHECK (asset IN ('SOL', 'USDC'));

    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS payout_mode TEXT NOT NULL DEFAULT 'WINNER_TAKE_ALL';
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS frag_limit INTEGER NOT NULL DEFAULT 10;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS kill_value NUMERIC(20, 0) NOT NULL DEFAULT 0;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS increment_value NUMERIC(20, 0) NOT NULL DEFAULT 0;
    UPDATE wagers SET increment_value = kill_value
      WHERE increment_value = 0 AND kill_value <> 0;
    UPDATE wagers SET payout_mode = 'INCREMENTAL' WHERE payout_mode = 'PER_KILL';
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS maker_remaining NUMERIC(20, 0) NOT NULL DEFAULT 0;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS opponent_remaining NUMERIC(20, 0) NOT NULL DEFAULT 0;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS maker_score INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS opponent_score INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS quake_maker_handle TEXT;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS quake_opponent_handle TEXT;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS maker_client_num INTEGER;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS opponent_client_num INTEGER;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS create_signature TEXT;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS join_signature TEXT;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS settlement_signature TEXT;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS cashout_requested_by TEXT;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS cashout_requested_at TIMESTAMPTZ;
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS maker_final_balance NUMERIC(20, 0);
    ALTER TABLE wagers ADD COLUMN IF NOT EXISTS opponent_final_balance NUMERIC(20, 0);
    UPDATE wagers SET create_signature = chain_signature
      WHERE status = 'OPEN' AND create_signature IS NULL AND chain_signature IS NOT NULL;

    DROP INDEX IF EXISTS wagers_quake_maker_handle_idx;
    DROP INDEX IF EXISTS wagers_quake_opponent_handle_idx;
    DROP INDEX IF EXISTS wagers_one_active_quake_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS wagers_one_active_quake_idx
      ON wagers (game) WHERE game = 'QUAKE3'
        AND status IN ('ACCEPTED', 'MAKER_FUNDED', 'MATCHED', 'SETTLING', 'CASHING_OUT');

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
      await db.query(
        `SELECT setval(
           pg_get_serial_sequence('wagers', 'wager_id'),
           GREATEST(
             (SELECT last_value FROM wagers_wager_id_seq),
             (SELECT COALESCE(MAX(wager_id), 1) FROM wagers),
             $1::bigint
           ),
           true
         )`,
        [config.wagerIdFloor.toString()]
      );
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
  asset: row.asset,
  game: row.game,
  status: row.status,
  serverAddress: row.server_address,
  winner: row.winner,
  chainSignature: row.chain_signature,
  createSignature: row.create_signature,
  joinSignature: row.join_signature,
  settlementSignature: row.settlement_signature,
  payoutMode: row.payout_mode,
  fragLimit: Number(row.frag_limit),
  incrementValue: String(row.increment_value),
  makerRemaining: String(row.maker_remaining),
  opponentRemaining: String(row.opponent_remaining),
  makerScore: Number(row.maker_score),
  opponentScore: Number(row.opponent_score),
  cashoutRequestedBy: row.cashout_requested_by,
  cashoutRequestedAt: row.cashout_requested_at,
  makerFinalBalance: row.maker_final_balance == null ? null : String(row.maker_final_balance),
  opponentFinalBalance: row.opponent_final_balance == null ? null : String(row.opponent_final_balance),
  createdAt: row.created_at
});
