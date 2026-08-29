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
  programId: required("PROGRAM_ID", "8rqv4B1Sw4xweu4kWEHGnqoTQbQvRKuxSturDsz32i4v"),
  tokenMint: required("TOKEN_MINT", "So11111111111111111111111111111111111111112"),
  chainAuthoritySecret: process.env.CHAIN_AUTHORITY_SECRET ?? "",
  mockChain: process.env.MOCK_CHAIN !== "false",
  mockRequiredStake: BigInt(process.env.MOCK_REQUIRED_STAKE ?? "1000000000"),
  adminKey: required("ADMIN_KEY", "local-admin"),
  winnerChannel: "cs2:winners",
  queueName: "chain-actions",
  serverAddress: process.env.CS2_SERVER_ADDRESS ?? "127.0.0.1:27015"
};
