import "dotenv/config";

const required = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
};

export const config = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: required("DATABASE_URL", "postgres://bet1v1:bet1v1@localhost:5432/bet1v1"),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  rpcUrl: required("SOLANA_RPC_URL", "http://127.0.0.1:8899"),
  programId: required("PROGRAM_ID", "6L4UuN5zYFaZsLffmUuNKk9d5BtzusyK1xE5Z8Wr2CUY"),
  tokenMint: required("TOKEN_MINT", "So11111111111111111111111111111111111111112"),
  chainAuthoritySecret: process.env.CHAIN_AUTHORITY_SECRET ?? "",
  mockChain: process.env.MOCK_CHAIN !== "false",
  mockRequiredStake: BigInt(process.env.MOCK_REQUIRED_STAKE ?? "1000000000"),
  adminKey: required("ADMIN_KEY", "local-admin"),
  winnerChannel: "cs2:winners",
  quake3EventChannel: "quake3:events",
  queueName: "chain-actions",
  gameQueueName: "game-events",
  serverAddress: process.env.CS2_SERVER_ADDRESS ?? "127.0.0.1:27015",
  quake3ServerAddress: process.env.QUAKE3_SERVER_ADDRESS ?? "127.0.0.1:27961",
  quake3StatusHost: process.env.QUAKE3_STATUS_HOST ?? "127.0.0.1",
  quake3StatusPort: Number(process.env.QUAKE3_STATUS_PORT ?? 27960),
  quake3FragLimit: Number(process.env.QUAKE3_FRAG_LIMIT ?? 10),
  quake3EventSecret: required(
    "Q3JS_EVENT_CLIENT_SECRET",
    "bet1v1-q3-local-event-secret-change-me"
  ),
  quake3ClientUrl: process.env.Q3JS_CLIENT_URL ?? "https://q3js.com/play",
  quake3Secure: process.env.Q3JS_SECURE === "true"
};
