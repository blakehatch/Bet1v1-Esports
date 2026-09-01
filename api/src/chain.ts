import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { hasPlatformAccess } from "./access.js";
import { config } from "./config.js";
import { db } from "./db.js";

const connection = new Connection(config.rpcUrl, "confirmed");
const programId = new PublicKey(config.programId);
const tokenMint = new PublicKey(config.tokenMint);
const usdcMint = new PublicKey(config.usdcMint);
const tokenProgramId = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const associatedTokenProgramId = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const associatedTokenAddress = (owner: PublicKey, mint = usdcMint) =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    associatedTokenProgramId
  )[0];

const discriminator = (name: string) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const u64 = (value: bigint) => {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(value);
  return data;
};

const u32 = (value: number) => {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value);
  return data;
};

const walletKeypair = () => {
  const encoded = config.chainAuthorityKeypair
    ? readFileSync(config.chainAuthorityKeypair, "utf8")
    : config.chainAuthoritySecret;
  if (!encoded) {
    throw new Error(
      "CHAIN_AUTHORITY_KEYPAIR or CHAIN_AUTHORITY_SECRET is required when MOCK_CHAIN=false"
    );
  }
  const bytes = encoded.trim().startsWith("[")
    ? Uint8Array.from(JSON.parse(encoded) as number[])
    : bs58.decode(encoded);
  return Keypair.fromSecretKey(bytes);
};

export const decodeConfigAccount = (accountData: Uint8Array) => {
  const data = Buffer.from(accountData);
  // Anchor discriminator(8), authority(32), chain authority(32), token mint(32),
  // USDC mint(32), required stake(8), staking enabled(1), bump(1).
  if (data.length < 146) throw new Error("Program config is not initialized");
  return {
    tokenMint: new PublicKey(data.subarray(72, 104)),
    usdcMint: new PublicKey(data.subarray(104, 136)),
    requiredStake: data.readBigUInt64LE(136),
    stakingEnabled: data[144] === 1
  };
};

export const decodeWagerAccount = (accountData: Uint8Array) => {
  const data = Buffer.from(accountData);
  // Anchor discriminator(8), wager id(8), maker/challenger/opponent(32 each),
  // amount(8), token mint/winner(32 each), status(1), payout mode(1),
  // increment value(8), then both remaining escrow balances(8 each).
  if (data.length < 210) throw new Error("Program wager account is truncated");
  return {
    maker: new PublicKey(data.subarray(16, 48)),
    challenger: new PublicKey(data.subarray(48, 80)),
    opponent: new PublicKey(data.subarray(80, 112)),
    amount: data.readBigUInt64LE(112),
    tokenMint: new PublicKey(data.subarray(120, 152)),
    status: data[184],
    payoutMode: data[185],
    makerRemaining: data.readBigUInt64LE(194),
    opponentRemaining: data.readBigUInt64LE(202)
  };
};

export const getWagerAccount = async (wagerId: string) => {
  const wagerIdBytes = u64(BigInt(wagerId));
  const [address] = PublicKey.findProgramAddressSync(
    [Buffer.from("wager"), wagerIdBytes],
    programId
  );
  const account = await connection.getAccountInfo(address, "confirmed");
  return account ? decodeWagerAccount(account.data) : null;
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
    return {
      amount: amount.toString(),
      requiredStake: requiredStake.toString(),
      banned,
      active: hasPlatformAccess(amount, requiredStake, banned, config.stakingEnabled)
    };
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
  if (!configAccount) {
    throw new Error("Program config is not initialized");
  }
  const onChainConfig = decodeConfigAccount(configAccount.data);
  if (!onChainConfig.tokenMint.equals(tokenMint) || !onChainConfig.usdcMint.equals(usdcMint)) {
    throw new Error("Configured token mints do not match the on-chain program config");
  }
  if (onChainConfig.stakingEnabled !== config.stakingEnabled) {
    throw new Error("STAKING_ENABLED does not match the on-chain program config");
  }
  if (!stakeAccount || stakeAccount.data.length < 54) {
    return {
      amount: "0",
      requiredStake: onChainConfig.requiredStake.toString(),
      banned: false,
      active: !config.stakingEnabled
    };
  }
  const amount = stakeAccount.data.readBigUInt64LE(40);
  const banned = stakeAccount.data[52] === 1;
  return {
    amount: amount.toString(),
    requiredStake: onChainConfig.requiredStake.toString(),
    banned,
    active: hasPlatformAccess(amount, onChainConfig.requiredStake, banned, config.stakingEnabled)
  };
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
    "SELECT maker, opponent, asset FROM wagers WHERE wager_id = $1",
    [wagerId]
  );
  const wager = wagerResult.rows[0] as {
    maker: string;
    opponent: string;
    asset: "SOL" | "USDC";
  } | undefined;
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
  const transaction = new Transaction();
  if (wager.asset === "SOL") {
    transaction.add(new TransactionInstruction({
      programId,
      data: discriminator("settle_sol_wager"),
      keys: [
        { pubkey: configAddress, isSigner: false, isWritable: false },
        { pubkey: wagerAddress, isSigner: false, isWritable: true },
        { pubkey: makerStake, isSigner: false, isWritable: true },
        { pubkey: opponentStake, isSigner: false, isWritable: true },
        { pubkey: winner, isSigner: false, isWritable: true },
        { pubkey: chainAuthority.publicKey, isSigner: true, isWritable: false }
      ]
    }));
    return sendAndConfirmTransaction(connection, transaction, [chainAuthority], {
      commitment: "confirmed"
    });
  }
  const winnerToken = associatedTokenAddress(winner);
  if (!(await connection.getAccountInfo(winnerToken))) {
    transaction.add(
      new TransactionInstruction({
        programId: associatedTokenProgramId,
        data: Buffer.alloc(0),
        keys: [
          { pubkey: chainAuthority.publicKey, isSigner: true, isWritable: true },
          { pubkey: winnerToken, isSigner: false, isWritable: true },
          { pubkey: winner, isSigner: false, isWritable: false },
          { pubkey: usdcMint, isSigner: false, isWritable: false },
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
        { pubkey: usdcMint, isSigner: false, isWritable: false },
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

export const settleIncrement = async (wagerId: string, beneficiaryAddress: string, sequence: number) => {
  if (config.mockChain) return `mock-increment-${sequence}-${randomUUID()}`;
  const chainAuthority = walletKeypair();
  const wagerIdBytes = u64(BigInt(wagerId));
  const [configAddress] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [wagerAddress] = PublicKey.findProgramAddressSync([Buffer.from("wager"), wagerIdBytes], programId);
  const [wagerVault] = PublicKey.findProgramAddressSync([Buffer.from("wager_vault"), wagerIdBytes], programId);
  const wagerResult = await db.query(
    "SELECT maker, opponent, asset FROM wagers WHERE wager_id = $1",
    [wagerId]
  );
  const wager = wagerResult.rows[0] as {
    maker: string;
    opponent: string;
    asset: "SOL" | "USDC";
  } | undefined;
  if (!wager?.opponent) throw new Error("Matched wager not found");
  if (beneficiaryAddress !== wager.maker && beneficiaryAddress !== wager.opponent) {
    throw new Error("Beneficiary is not a wager participant");
  }
  const maker = new PublicKey(wager.maker);
  const opponent = new PublicKey(wager.opponent);
  const [makerStake] = PublicKey.findProgramAddressSync([Buffer.from("stake"), maker.toBuffer()], programId);
  const [opponentStake] = PublicKey.findProgramAddressSync([Buffer.from("stake"), opponent.toBuffer()], programId);
  const transaction = new Transaction();
  if (wager.asset === "SOL") {
    transaction.add(new TransactionInstruction({
      programId,
      data: Buffer.concat([discriminator("settle_sol_increment"), new PublicKey(beneficiaryAddress).toBuffer(), u32(sequence)]),
      keys: [
        { pubkey: configAddress, isSigner: false, isWritable: false },
        { pubkey: wagerAddress, isSigner: false, isWritable: true },
        { pubkey: makerStake, isSigner: false, isWritable: true },
        { pubkey: opponentStake, isSigner: false, isWritable: true },
        { pubkey: maker, isSigner: false, isWritable: true },
        { pubkey: opponent, isSigner: false, isWritable: true },
        { pubkey: chainAuthority.publicKey, isSigner: true, isWritable: false }
      ]
    }));
    return sendAndConfirmTransaction(connection, transaction, [chainAuthority], { commitment: "confirmed" });
  }
  const makerToken = associatedTokenAddress(maker);
  const opponentToken = associatedTokenAddress(opponent);
  for (const [owner, token] of [[maker, makerToken], [opponent, opponentToken]] as const) {
    if (!(await connection.getAccountInfo(token))) {
      transaction.add(new TransactionInstruction({
        programId: associatedTokenProgramId,
        data: Buffer.alloc(0),
        keys: [
          { pubkey: chainAuthority.publicKey, isSigner: true, isWritable: true },
          { pubkey: token, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: false, isWritable: false },
          { pubkey: usdcMint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: tokenProgramId, isSigner: false, isWritable: false }
        ]
      }));
    }
  }
  transaction.add(new TransactionInstruction({
    programId,
    data: Buffer.concat([discriminator("settle_increment"), new PublicKey(beneficiaryAddress).toBuffer(), u32(sequence)]),
    keys: [
      { pubkey: configAddress, isSigner: false, isWritable: false },
      { pubkey: wagerAddress, isSigner: false, isWritable: true },
      { pubkey: makerStake, isSigner: false, isWritable: true },
      { pubkey: opponentStake, isSigner: false, isWritable: true },
      { pubkey: wagerVault, isSigner: false, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: makerToken, isSigner: false, isWritable: true },
      { pubkey: opponentToken, isSigner: false, isWritable: true },
      { pubkey: chainAuthority.publicKey, isSigner: true, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false }
    ]
  }));
  return sendAndConfirmTransaction(connection, transaction, [chainAuthority], { commitment: "confirmed" });
};

export const cashOutWager = async (wagerId: string) => {
  const wagerIdBytes = u64(BigInt(wagerId));
  const [wagerAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("wager"), wagerIdBytes],
    programId
  );
  const [wagerVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("wager_vault"), wagerIdBytes],
    programId
  );
  const result = await db.query(
    `SELECT maker, opponent, asset, amount, maker_remaining, opponent_remaining
     FROM wagers WHERE wager_id = $1`,
    [wagerId]
  );
  const wager = result.rows[0] as {
    maker: string;
    opponent: string;
    asset: "SOL" | "USDC";
    amount: string;
    maker_remaining: string;
    opponent_remaining: string;
  } | undefined;
  if (!wager?.opponent) throw new Error("Matched wager not found");

  if (config.mockChain) {
    return {
      signature: `mock-cashout-${randomUUID()}`,
      amount: BigInt(wager.amount),
      makerRemaining: BigInt(wager.maker_remaining),
      opponentRemaining: BigInt(wager.opponent_remaining)
    };
  }

  const chainAuthority = walletKeypair();
  const [configAddress] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);

  const maker = new PublicKey(wager.maker);
  const opponent = new PublicKey(wager.opponent);
  const wagerAccount = await connection.getAccountInfo(wagerAddress, "confirmed");
  if (!wagerAccount) throw new Error("On-chain wager account not found");
  const chainWager = decodeWagerAccount(wagerAccount.data);
  if (!chainWager.maker.equals(maker) || !chainWager.opponent.equals(opponent)) {
    throw new Error("On-chain wager participants do not match the API record");
  }
  if (chainWager.status !== 1 || chainWager.payoutMode !== 1) {
    throw new Error("On-chain wager is not an active incremental wager");
  }
  const [makerStake] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), maker.toBuffer()],
    programId
  );
  const [opponentStake] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), opponent.toBuffer()],
    programId
  );
  const transaction = new Transaction();
  if (wager.asset === "SOL") {
    transaction.add(new TransactionInstruction({
      programId,
      data: discriminator("invalidate_sol_wager"),
      keys: [
        { pubkey: configAddress, isSigner: false, isWritable: false },
        { pubkey: wagerAddress, isSigner: false, isWritable: true },
        { pubkey: makerStake, isSigner: false, isWritable: true },
        { pubkey: opponentStake, isSigner: false, isWritable: true },
        { pubkey: maker, isSigner: false, isWritable: true },
        { pubkey: opponent, isSigner: false, isWritable: true },
        { pubkey: chainAuthority.publicKey, isSigner: true, isWritable: false }
      ]
    }));
    const signature = await sendAndConfirmTransaction(connection, transaction, [chainAuthority], {
      commitment: "confirmed"
    });
    return { signature, ...chainWager };
  }

  const makerToken = associatedTokenAddress(maker);
  const opponentToken = associatedTokenAddress(opponent);
  for (const [owner, token] of [[maker, makerToken], [opponent, opponentToken]] as const) {
    if (!(await connection.getAccountInfo(token))) {
      transaction.add(new TransactionInstruction({
        programId: associatedTokenProgramId,
        data: Buffer.alloc(0),
        keys: [
          { pubkey: chainAuthority.publicKey, isSigner: true, isWritable: true },
          { pubkey: token, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: false, isWritable: false },
          { pubkey: usdcMint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: tokenProgramId, isSigner: false, isWritable: false }
        ]
      }));
    }
  }
  transaction.add(new TransactionInstruction({
    programId,
    data: discriminator("invalidate_wager"),
    keys: [
      { pubkey: configAddress, isSigner: false, isWritable: false },
      { pubkey: wagerAddress, isSigner: false, isWritable: true },
      { pubkey: makerStake, isSigner: false, isWritable: true },
      { pubkey: opponentStake, isSigner: false, isWritable: true },
      { pubkey: wagerVault, isSigner: false, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: makerToken, isSigner: false, isWritable: true },
      { pubkey: opponentToken, isSigner: false, isWritable: true },
      { pubkey: chainAuthority.publicKey, isSigner: true, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false }
    ]
  }));
  const signature = await sendAndConfirmTransaction(connection, transaction, [chainAuthority], {
    commitment: "confirmed"
  });
  return { signature, ...chainWager };
};

export const chainAddresses = {
  programId: programId.toBase58(),
  tokenMint: tokenMint.toBase58(),
  usdcMint: usdcMint.toBase58(),
  tokenProgram: tokenProgramId.toBase58(),
  systemProgram: SystemProgram.programId.toBase58(),
  rent: SYSVAR_RENT_PUBKEY.toBase58()
};
