import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { Bet1v1SolanaProgram } from "../target/types/bet1v1_solana_program";

describe("bet1v1-solana-program wagers", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .bet1v1SolanaProgram as Program<Bet1v1SolanaProgram>;
  const payer = (
    provider.wallet as anchor.Wallet & { payer: anchor.web3.Keypair }
  ).payer;
  const maker = provider.wallet.publicKey;
  const opponent = anchor.web3.Keypair.generate();
  const stranger = anchor.web3.Keypair.generate();
  const chainAuthority = anchor.web3.Keypair.generate();
  const amount = new anchor.BN(100_000);
  const requiredStake = new anchor.BN(50_000);

  let usdcMint: anchor.web3.PublicKey;
  let accessMint: anchor.web3.PublicKey;
  let makerUsdc: anchor.web3.PublicKey;
  let opponentUsdc: anchor.web3.PublicKey;
  let strangerUsdc: anchor.web3.PublicKey;
  let opponentAccess: anchor.web3.PublicKey;

  const [config] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const idSeed = (id: anchor.BN) => id.toArrayLike(Buffer, "le", 8);
  const stake = (owner: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("stake"), owner.toBuffer()],
      program.programId
    )[0];
  const stakeVault = (owner: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("stake_vault"), owner.toBuffer()],
      program.programId
    )[0];
  const wager = (id: anchor.BN) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager"), idSeed(id)],
      program.programId
    )[0];
  const wagerVault = (id: anchor.BN) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager_vault"), idSeed(id)],
      program.programId
    )[0];

  const expectError = async (promise: Promise<unknown>, code: string) => {
    try {
      await promise;
      expect.fail(`Expected ${code}`);
    } catch (error) {
      const parsed = error as {
        error?: { errorCode?: { code?: string } };
        message?: string;
      };
      expect(parsed.error?.errorCode?.code, parsed.message).to.equal(code);
    }
  };

  const solEscrow = async (id: anchor.BN) => {
    const info = await provider.connection.getAccountInfo(wager(id));
    if (!info) throw new Error("Wager account not found");
    const rent = await provider.connection.getMinimumBalanceForRentExemption(
      info.data.length
    );
    return BigInt(info.lamports - rent);
  };

  const createSolWager = (
    id: anchor.BN,
    challenger = anchor.web3.PublicKey.default,
    wagerAmount = amount,
    payoutMode = 0,
    incrementValue = new anchor.BN(0)
  ) =>
    program.methods
      .createSolWager(id, challenger, wagerAmount, payoutMode, incrementValue)
      .accountsPartial({
        config,
        makerStake: stake(maker),
        wager: wager(id),
        maker,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

  const joinSolWager = (id: anchor.BN, player = opponent) =>
    program.methods
      .joinSolWager()
      .accountsPartial({
        config,
        opponentStake: stake(player.publicKey),
        wager: wager(id),
        opponent: player.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([player])
      .rpc();

  const createUsdcWager = (
    id: anchor.BN,
    challenger = anchor.web3.PublicKey.default,
    payoutMode = 0,
    incrementValue = new anchor.BN(0)
  ) =>
    program.methods
      .createWager(id, challenger, amount, payoutMode, incrementValue)
      .accountsPartial({
        config,
        makerStake: stake(maker),
        wager: wager(id),
        wagerVault: wagerVault(id),
        tokenMint: usdcMint,
        makerToken: makerUsdc,
        maker,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

  const joinUsdcWager = (
    id: anchor.BN,
    player: anchor.web3.Keypair,
    playerUsdc: anchor.web3.PublicKey
  ) =>
    program.methods
      .joinWager()
      .accountsPartial({
        config,
        opponentStake: stake(player.publicKey),
        wager: wager(id),
        wagerVault: wagerVault(id),
        tokenMint: usdcMint,
        opponentToken: playerUsdc,
        opponent: player.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([player])
      .rpc();

  const settleSolWager = (
    id: anchor.BN,
    winner: anchor.web3.PublicKey,
    signer = chainAuthority
  ) =>
    program.methods
      .settleSolWager()
      .accountsPartial({
        config,
        wager: wager(id),
        makerStake: stake(maker),
        opponentStake: stake(opponent.publicKey),
        winner,
        chainAuthority: signer.publicKey,
      })
      .signers([signer])
      .rpc();

  const settleSolIncrement = (
    id: anchor.BN,
    beneficiary: anchor.web3.PublicKey,
    sequence: number,
    signer = chainAuthority
  ) =>
    program.methods
      .settleSolIncrement(beneficiary, sequence)
      .accountsPartial({
        config,
        wager: wager(id),
        makerStake: stake(maker),
        opponentStake: stake(opponent.publicKey),
        maker,
        opponent: opponent.publicKey,
        chainAuthority: signer.publicKey,
      })
      .signers([signer])
      .rpc();

  const stakeAccessTokens = (
    user: anchor.web3.Keypair,
    userAccessToken: anchor.web3.PublicKey,
    stakeAmount: anchor.BN
  ) =>
    program.methods
      .stakeTokens(stakeAmount)
      .accountsPartial({
        config,
        stake: stake(user.publicKey),
        stakeVault: stakeVault(user.publicKey),
        tokenMint: accessMint,
        userToken: userAccessToken,
        user: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc();

  before(async () => {
    for (const player of [opponent, stranger]) {
      const signature = await provider.connection.requestAirdrop(
        player.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      const latest = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction(
        { signature, ...latest },
        "confirmed"
      );
    }
    usdcMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );
    accessMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );
    makerUsdc = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        usdcMint,
        maker
      )
    ).address;
    opponentUsdc = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        usdcMint,
        opponent.publicKey
      )
    ).address;
    strangerUsdc = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        usdcMint,
        stranger.publicKey
      )
    ).address;
    opponentAccess = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        accessMint,
        opponent.publicKey
      )
    ).address;
    for (const account of [makerUsdc, opponentUsdc, strangerUsdc]) {
      await mintTo(
        provider.connection,
        payer,
        usdcMint,
        account,
        payer,
        BigInt(10_000_000)
      );
    }
    await mintTo(
      provider.connection,
      payer,
      accessMint,
      opponentAccess,
      payer,
      BigInt(1_000_000)
    );
  });

  it("initializes with staking disabled and the configured USDC mint", async () => {
    await program.methods
      .initializeConfig(requiredStake, false)
      .accountsPartial({
        config,
        authority: maker,
        chainAuthority: chainAuthority.publicKey,
        tokenMint: accessMint,
        usdcMint,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([chainAuthority])
      .rpc();

    const state = await program.account.config.fetch(config);
    expect(state.tokenMint.equals(accessMint)).to.equal(true);
    expect(state.usdcMint.equals(usdcMint)).to.equal(true);
    expect(state.requiredStake.eq(requiredStake)).to.equal(true);
    expect(state.stakingEnabled).to.equal(false);
  });

  it("rejects staking while the platform is ungated", async () => {
    await expectError(
      program.methods
        .stakeTokens(new anchor.BN(1))
        .accountsPartial({
          config,
          stake: stake(opponent.publicKey),
          stakeVault: stakeVault(opponent.publicKey),
          tokenMint: accessMint,
          userToken: opponentAccess,
          user: opponent.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([opponent])
        .rpc(),
      "StakingDisabled"
    );
  });

  it("does not let the chain automation authority change config", async () => {
    await expectError(
      program.methods
        .updateConfig(maker, chainAuthority.publicKey, requiredStake, true)
        .accountsPartial({ config, authority: chainAuthority.publicKey })
        .signers([chainAuthority])
        .rpc(),
      "ConstraintHasOne"
    );
    expect(
      (await program.account.config.fetch(config)).stakingEnabled
    ).to.equal(false);
  });

  it("rejects zero SOL wagers", async () => {
    await expectError(
      createSolWager(new anchor.BN(90), undefined, new anchor.BN(0)),
      "InvalidWagerAmount"
    );
  });

  it("creates a native SOL wager and escrows one bankroll", async () => {
    const id = new anchor.BN(1);
    await createSolWager(id);
    const state = await program.account.wager.fetch(wager(id));
    expect(state.tokenMint.equals(anchor.web3.PublicKey.default)).to.equal(
      true
    );
    expect(state.status).to.equal(0);
    expect(state.amount.eq(amount)).to.equal(true);
    expect(await solEscrow(id)).to.equal(BigInt(amount.toString()));
  });

  it("joins a SOL wager and escrows both bankrolls", async () => {
    const id = new anchor.BN(1);
    await joinSolWager(id);
    const state = await program.account.wager.fetch(wager(id));
    expect(state.opponent.equals(opponent.publicKey)).to.equal(true);
    expect(state.status).to.equal(1);
    expect(await solEscrow(id)).to.equal(BigInt(amount.muln(2).toString()));
  });

  it("rejects SOL settlement from the wrong chain authority", async () => {
    await expectError(
      settleSolWager(new anchor.BN(1), maker, stranger),
      "ConstraintHasOne"
    );
  });

  it("settles SOL to the winner and leaves only account rent", async () => {
    const id = new anchor.BN(1);
    await settleSolWager(id, maker);
    const state = await program.account.wager.fetch(wager(id));
    expect(state.status).to.equal(2);
    expect(state.winner.equals(maker)).to.equal(true);
    expect(await solEscrow(id)).to.equal(BigInt(0));
    expect(
      (await program.account.userStake.fetch(stake(maker))).activeWagers
    ).to.equal(0);
    expect(
      (await program.account.userStake.fetch(stake(opponent.publicKey)))
        .activeWagers
    ).to.equal(0);
  });

  it("prevents replaying SOL settlement", async () => {
    await expectError(
      settleSolWager(new anchor.BN(1), maker),
      "WagerNotMatched"
    );
  });

  it("pays native SOL increments in sequence and empties escrow on the final score", async () => {
    const id = new anchor.BN(8);
    const incrementValue = new anchor.BN(40_000);
    await createSolWager(
      id,
      anchor.web3.PublicKey.default,
      amount,
      1,
      incrementValue
    );
    await joinSolWager(id);
    const makerBefore = await provider.connection.getBalance(maker);

    await expectError(
      settleSolIncrement(id, maker, 1, stranger),
      "ConstraintHasOne"
    );
    await settleSolIncrement(id, maker, 1);
    let state = await program.account.wager.fetch(wager(id));
    expect(state.makerScore).to.equal(1);
    expect(state.opponentRemaining.eq(new anchor.BN(60_000))).to.equal(true);
    expect(await solEscrow(id)).to.equal(BigInt(160_000));

    await expectError(
      settleSolIncrement(id, maker, 1),
      "InvalidScoreSequence"
    );
    await settleSolIncrement(id, opponent.publicKey, 2);
    await settleSolIncrement(id, maker, 3);
    await settleSolIncrement(id, maker, 4);

    state = await program.account.wager.fetch(wager(id));
    expect(state.status).to.equal(2);
    expect(state.winner.equals(maker)).to.equal(true);
    expect(state.makerScore).to.equal(3);
    expect(state.opponentScore).to.equal(1);
    expect(state.makerRemaining.eq(new anchor.BN(0))).to.equal(true);
    expect(state.opponentRemaining.eq(new anchor.BN(0))).to.equal(true);
    expect(await solEscrow(id)).to.equal(BigInt(0));
    // The provider wallet is also this test's transaction fee payer, so its
    // observed delta is the 160,000-lamport payout minus settlement tx fees.
    const makerAfter = await provider.connection.getBalance(maker);
    expect(makerAfter).to.be.greaterThan(makerBefore + 100_000);
    expect(makerAfter).to.be.at.most(makerBefore + 160_000);
  });

  it("cancels an open SOL wager and refunds its escrow", async () => {
    const id = new anchor.BN(2);
    await createSolWager(id);
    await program.methods
      .cancelSolWager()
      .accountsPartial({
        config,
        makerStake: stake(maker),
        wager: wager(id),
        maker,
      })
      .rpc();
    expect((await program.account.wager.fetch(wager(id))).status).to.equal(3);
    expect(await solEscrow(id)).to.equal(BigInt(0));
  });

  it("lets only chain automation refund a reserved SOL challenge", async () => {
    const id = new anchor.BN(91);
    await createSolWager(id, opponent.publicKey);

    await expectError(
      program.methods
        .declineSolWager()
        .accountsPartial({
          config,
          makerStake: stake(maker),
          wager: wager(id),
          maker,
          chainAuthority: stranger.publicKey,
        })
        .signers([stranger])
        .rpc(),
      "ConstraintHasOne"
    );

    await program.methods
      .declineSolWager()
      .accountsPartial({
        config,
        makerStake: stake(maker),
        wager: wager(id),
        maker,
        chainAuthority: chainAuthority.publicKey,
      })
      .signers([chainAuthority])
      .rpc();
    const state = await program.account.wager.fetch(wager(id));
    expect(state.status).to.equal(3);
    expect(state.makerRemaining.eq(new anchor.BN(0))).to.equal(true);
    expect(await solEscrow(id)).to.equal(BigInt(0));
  });

  it("does not let chain automation decline a public SOL wager", async () => {
    const id = new anchor.BN(92);
    await createSolWager(id);
    await expectError(
      program.methods
        .declineSolWager()
        .accountsPartial({
          config,
          makerStake: stake(maker),
          wager: wager(id),
          maker,
          chainAuthority: chainAuthority.publicKey,
        })
        .signers([chainAuthority])
        .rpc(),
      "WagerNotReserved"
    );
    await program.methods
      .cancelSolWager()
      .accountsPartial({ config, makerStake: stake(maker), wager: wager(id), maker })
      .rpc();
  });

  it("creates a reserved USDC wager and rejects the wrong opponent", async () => {
    const id = new anchor.BN(3);
    const makerBefore = (await getAccount(provider.connection, makerUsdc))
      .amount;
    await createUsdcWager(id, opponent.publicKey);
    expect(
      (await getAccount(provider.connection, wagerVault(id))).amount
    ).to.equal(BigInt(amount.toString()));
    expect((await getAccount(provider.connection, makerUsdc)).amount).to.equal(
      makerBefore - BigInt(amount.toString())
    );
    await expectError(
      joinUsdcWager(id, stranger, strangerUsdc),
      "WagerReserved"
    );
  });

  it("refunds the exact USDC escrow when a reserved challenge is declined", async () => {
    const id = new anchor.BN(93);
    const makerBefore = (await getAccount(provider.connection, makerUsdc)).amount;
    await createUsdcWager(id, opponent.publicKey);
    await program.methods
      .declineWager()
      .accountsPartial({
        config,
        makerStake: stake(maker),
        wager: wager(id),
        wagerVault: wagerVault(id),
        tokenMint: usdcMint,
        makerToken: makerUsdc,
        chainAuthority: chainAuthority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([chainAuthority])
      .rpc();
    const state = await program.account.wager.fetch(wager(id));
    expect(state.status).to.equal(3);
    expect(state.makerRemaining.eq(new anchor.BN(0))).to.equal(true);
    expect((await getAccount(provider.connection, wagerVault(id))).amount).to.equal(0n);
    expect((await getAccount(provider.connection, makerUsdc)).amount).to.equal(makerBefore);
  });

  it("joins and settles the reserved USDC wager", async () => {
    const id = new anchor.BN(3);
    const opponentBefore = (await getAccount(provider.connection, opponentUsdc))
      .amount;
    await joinUsdcWager(id, opponent, opponentUsdc);
    expect(
      (await getAccount(provider.connection, wagerVault(id))).amount
    ).to.equal(BigInt(amount.muln(2).toString()));

    await program.methods
      .settleWager()
      .accountsPartial({
        config,
        wager: wager(id),
        makerStake: stake(maker),
        opponentStake: stake(opponent.publicKey),
        wagerVault: wagerVault(id),
        tokenMint: usdcMint,
        winnerToken: opponentUsdc,
        winner: opponent.publicKey,
        chainAuthority: chainAuthority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([chainAuthority])
      .rpc();

    const state = await program.account.wager.fetch(wager(id));
    expect(state.status).to.equal(2);
    expect(state.winner.equals(opponent.publicKey)).to.equal(true);
    expect(
      (await getAccount(provider.connection, wagerVault(id))).amount
    ).to.equal(BigInt(0));
    expect(
      (await getAccount(provider.connection, opponentUsdc)).amount
    ).to.equal(opponentBefore + BigInt(amount.toString()));
  });

  it("pays USDC increments in sequence and closes on a partial final increment", async () => {
    const id = new anchor.BN(7);
    const incrementValue = new anchor.BN(40_000);
    await createUsdcWager(id, anchor.web3.PublicKey.default, 1, incrementValue);
    await joinUsdcWager(id, opponent, opponentUsdc);
    const makerBefore = (await getAccount(provider.connection, makerUsdc))
      .amount;

    const settleIncrement = (
      beneficiary: anchor.web3.PublicKey,
      sequence: number
    ) =>
      program.methods
        .settleIncrement(beneficiary, sequence)
        .accountsPartial({
          config,
          wager: wager(id),
          makerStake: stake(maker),
          opponentStake: stake(opponent.publicKey),
          wagerVault: wagerVault(id),
          tokenMint: usdcMint,
          makerToken: makerUsdc,
          opponentToken: opponentUsdc,
          chainAuthority: chainAuthority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([chainAuthority])
        .rpc();

    await settleIncrement(maker, 1);
    let state = await program.account.wager.fetch(wager(id));
    expect(state.makerScore).to.equal(1);
    expect(state.opponentRemaining.eq(new anchor.BN(60_000))).to.equal(true);
    expect((await getAccount(provider.connection, makerUsdc)).amount).to.equal(
      makerBefore + BigInt(40_000)
    );

    await expectError(settleIncrement(maker, 1), "InvalidScoreSequence");
    await settleIncrement(opponent.publicKey, 2);
    await settleIncrement(maker, 3);
    await settleIncrement(maker, 4);

    state = await program.account.wager.fetch(wager(id));
    expect(state.status).to.equal(2);
    expect(state.winner.equals(maker)).to.equal(true);
    expect(state.makerScore).to.equal(3);
    expect(state.opponentScore).to.equal(1);
    expect(state.makerRemaining.eq(new anchor.BN(0))).to.equal(true);
    expect(state.opponentRemaining.eq(new anchor.BN(0))).to.equal(true);
    expect(
      (await getAccount(provider.connection, wagerVault(id))).amount
    ).to.equal(BigInt(0));
  });

  it("authoritatively invalidates a matched SOL wager and refunds escrow", async () => {
    const id = new anchor.BN(6);
    await createSolWager(id);
    await joinSolWager(id);
    const accounts = {
      config,
      wager: wager(id),
      makerStake: stake(maker),
      opponentStake: stake(opponent.publicKey),
      maker,
      opponent: opponent.publicKey,
      signer: chainAuthority.publicKey,
    };
    await expectError(
      program.methods
        .invalidateSolWager()
        .accountsPartial({ ...accounts, signer: stranger.publicKey })
        .signers([stranger])
        .rpc(),
      "Unauthorized"
    );
    await program.methods
      .invalidateSolWager()
      .accountsPartial(accounts)
      .signers([chainAuthority])
      .rpc();

    const state = await program.account.wager.fetch(wager(id));
    expect(state.status).to.equal(3);
    expect(state.makerRemaining.eq(new anchor.BN(0))).to.equal(true);
    expect(state.opponentRemaining.eq(new anchor.BN(0))).to.equal(true);
    expect(await solEscrow(id)).to.equal(BigInt(0));
  });

  it("cashes out a USDC incremental wager at its live balances", async () => {
    const id = new anchor.BN(94);
    const incrementValue = new anchor.BN(40_000);
    const makerBefore = (await getAccount(provider.connection, makerUsdc)).amount;
    const opponentBefore = (await getAccount(provider.connection, opponentUsdc)).amount;
    await createUsdcWager(id, opponent.publicKey, 1, incrementValue);
    await joinUsdcWager(id, opponent, opponentUsdc);
    await program.methods
      .settleIncrement(maker, 1)
      .accountsPartial({
        config,
        wager: wager(id),
        makerStake: stake(maker),
        opponentStake: stake(opponent.publicKey),
        wagerVault: wagerVault(id),
        tokenMint: usdcMint,
        makerToken: makerUsdc,
        opponentToken: opponentUsdc,
        chainAuthority: chainAuthority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([chainAuthority])
      .rpc();
    await program.methods
      .invalidateWager()
      .accountsPartial({
        config,
        wager: wager(id),
        makerStake: stake(maker),
        opponentStake: stake(opponent.publicKey),
        wagerVault: wagerVault(id),
        tokenMint: usdcMint,
        makerToken: makerUsdc,
        opponentToken: opponentUsdc,
        signer: chainAuthority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([chainAuthority])
      .rpc();

    const state = await program.account.wager.fetch(wager(id));
    expect(state.status).to.equal(3);
    expect((await getAccount(provider.connection, wagerVault(id))).amount).to.equal(0n);
    expect((await getAccount(provider.connection, makerUsdc)).amount).to.equal(
      makerBefore + 40_000n
    );
    expect((await getAccount(provider.connection, opponentUsdc)).amount).to.equal(
      opponentBefore - 40_000n
    );
  });

  it("enforces the stake gate across both wager assets", async () => {
    await program.methods
      .updateConfig(maker, chainAuthority.publicKey, requiredStake, true)
      .accountsPartial({ config, authority: maker })
      .rpc();

    await expectError(createSolWager(new anchor.BN(4)), "StakeRequired");

    await stakeAccessTokens(opponent, opponentAccess, requiredStake.subn(1));
    await expectError(
      program.methods
        .createSolWager(
          new anchor.BN(5),
          anchor.web3.PublicKey.default,
          amount,
          0,
          new anchor.BN(0)
        )
        .accountsPartial({
          config,
          makerStake: stake(opponent.publicKey),
          wager: wager(new anchor.BN(5)),
          maker: opponent.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([opponent])
        .rpc(),
      "StakeRequired"
    );
    await stakeAccessTokens(opponent, opponentAccess, new anchor.BN(1));
  });

  it("allows exact-threshold access and unstaking after the gate is disabled", async () => {
    const id = new anchor.BN(5);
    await program.methods
      .createSolWager(
        id,
        anchor.web3.PublicKey.default,
        amount,
        0,
        new anchor.BN(0)
      )
      .accountsPartial({
        config,
        makerStake: stake(opponent.publicKey),
        wager: wager(id),
        maker: opponent.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([opponent])
      .rpc();
    await program.methods
      .cancelSolWager()
      .accountsPartial({
        config,
        makerStake: stake(opponent.publicKey),
        wager: wager(id),
        maker: opponent.publicKey,
      })
      .signers([opponent])
      .rpc();

    await program.methods
      .updateConfig(maker, chainAuthority.publicKey, requiredStake, false)
      .accountsPartial({ config, authority: maker })
      .rpc();
    await program.methods
      .unstakeTokens(requiredStake)
      .accountsPartial({
        config,
        stake: stake(opponent.publicKey),
        stakeVault: stakeVault(opponent.publicKey),
        tokenMint: accessMint,
        userToken: opponentAccess,
        user: opponent.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([opponent])
      .rpc();
    expect(
      (
        await program.account.userStake.fetch(stake(opponent.publicKey))
      ).amount.eq(new anchor.BN(0))
    ).to.equal(true);
  });
});
