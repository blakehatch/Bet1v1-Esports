import { createHash, randomUUID } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";
import { db } from "./db.js";

const connection = new Connection(config.rpcUrl, "confirmed");
const programId = new PublicKey(config.programId);
const tokenMint = new PublicKey(config.tokenMint);
const tokenProgramId = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const associatedTokenProgramId = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const associatedTokenAddress = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), tokenMint.toBuffer()],
    associatedTokenProgramId
  )[0];

const discriminator = (name: string) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const u64 = (value: bigint) => {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(value);
  return data;
};

const walletKeypair = () => {
  if (!config.chainAuthoritySecret) {
    throw new Error("CHAIN_AUTHORITY_SECRET is required when MOCK_CHAIN=false");
  }
  const bytes = config.chainAuthoritySecret.trim().startsWith("[")
    ? Uint8Array.from(JSON.parse(config.chainAuthoritySecret) as number[])
    : bs58.decode(config.chainAuthoritySecret);
  return Keypair.fromSecretKey(bytes);
};

export const getAccess = async (wallet: string) => {
  const owner = new PublicKey(wallet);
  if (config.mockChain) {
    const result = await db.query(
      "SELECT stake_amount, banned FROM users WHERE wallet = $1",
      [wallet]
    );
    const row = result.rows[0] as { stake_amount: string; banned: boolean } | undefined;
    const amount = BigInt(row?.stake_amount ?? "0");
    const requiredStake = config.mockRequiredStake;
    const banned = row?.banned ?? false;
    return { amount: amount.toString(), requiredStake: requiredStake.toString(), banned, active: !banned && amount >= requiredStake };
  }
  const [stakeAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), owner.toBuffer()],
    programId
  );
  const [configAddress] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [stakeAccount, configAccount] = await connection.getMultipleAccountsInfo([
    stakeAddress,
    configAddress
  ]);
  if (!configAccount || configAccount.data.length < 113) {
    throw new Error("Program config is not initialized");
  }
  const requiredStake = configAccount.data.readBigUInt64LE(104);
  if (!stakeAccount || stakeAccount.data.length < 54) {
    return { amount: "0", requiredStake: requiredStake.toString(), banned: false, active: false };
  }
  const amount = stakeAccount.data.readBigUInt64LE(40);
  const banned = stakeAccount.data[52] === 1;
  return { amount: amount.toString(), requiredStake: requiredStake.toString(), banned, active: !banned && amount >= requiredStake };
};

export const settleWager = async (wagerId: string, winnerAddress: string) => {
  if (config.mockChain) {
    return `mock-${randomUUID()}`;
  }
  const chainAuthority = walletKeypair();
  const winner = new PublicKey(winnerAddress);
  const wagerIdBytes = u64(BigInt(wagerId));
  const [configAddress] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [wagerAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("wager"), wagerIdBytes],
    programId
  );
  const [wagerVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("wager_vault"), wagerIdBytes],
    programId
  );
  const wagerResult = await db.query(
    "SELECT maker, opponent FROM wagers WHERE wager_id = $1",
    [wagerId]
  );
  const wager = wagerResult.rows[0] as { maker: string; opponent: string } | undefined;
  if (!wager?.opponent) {
    throw new Error("Matched wager not found");
  }
  const [makerStake] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), new PublicKey(wager.maker).toBuffer()],
    programId
  );
  const [opponentStake] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), new PublicKey(wager.opponent).toBuffer()],
    programId
  );
  const winnerToken = associatedTokenAddress(winner);
  const transaction = new Transaction();
  if (!(await connection.getAccountInfo(winnerToken))) {
    transaction.add(
      new TransactionInstruction({
        programId: associatedTokenProgramId,
        data: Buffer.alloc(0),
        keys: [
          { pubkey: chainAuthority.publicKey, isSigner: true, isWritable: true },
          { pubkey: winnerToken, isSigner: false, isWritable: true },
          { pubkey: winner, isSigner: false, isWritable: false },
          { pubkey: tokenMint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: tokenProgramId, isSigner: false, isWritable: false }
        ]
      })
    );
  }
  transaction.add(
    new TransactionInstruction({
      programId,
      data: discriminator("settle_wager"),
      keys: [
        { pubkey: configAddress, isSigner: false, isWritable: false },
        { pubkey: wagerAddress, isSigner: false, isWritable: true },
        { pubkey: makerStake, isSigner: false, isWritable: true },
        { pubkey: opponentStake, isSigner: false, isWritable: true },
        { pubkey: wagerVault, isSigner: false, isWritable: true },
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: winnerToken, isSigner: false, isWritable: true },
        { pubkey: winner, isSigner: false, isWritable: false },
        { pubkey: chainAuthority.publicKey, isSigner: true, isWritable: false },
        { pubkey: tokenProgramId, isSigner: false, isWritable: false }
      ]
    })
  );
  return sendAndConfirmTransaction(connection, transaction, [chainAuthority], {
    commitment: "confirmed"
  });
};

export const chainAddresses = {
  programId: programId.toBase58(),
  tokenMint: tokenMint.toBase58(),
  tokenProgram: tokenProgramId.toBase58(),
  systemProgram: SystemProgram.programId.toBase58(),
  rent: SYSVAR_RENT_PUBKEY.toBase58()
};
