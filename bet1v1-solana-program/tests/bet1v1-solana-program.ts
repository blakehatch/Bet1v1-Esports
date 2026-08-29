import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createMint } from "@solana/spl-token";
import { expect } from "chai";
import { Bet1v1SolanaProgram } from "../target/types/bet1v1_solana_program";

describe("bet1v1-solana-program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .bet1v1SolanaProgram as Program<Bet1v1SolanaProgram>;

  it("initializes authority and staking config", async () => {
    const payer = (
      provider.wallet as anchor.Wallet & { payer: anchor.web3.Keypair }
    ).payer;
    const chainAuthority = anchor.web3.Keypair.generate();
    const tokenMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      9
    );
    const [config] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    await program.methods
      .initializeConfig(new anchor.BN(1_000_000_000))
      .accountsPartial({
        config,
        authority: provider.wallet.publicKey,
        chainAuthority: chainAuthority.publicKey,
        tokenMint,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([chainAuthority])
      .rpc();
    const state = await program.account.config.fetch(config);
    expect(state.authority.equals(provider.wallet.publicKey)).to.equal(true);
    expect(state.chainAuthority.equals(chainAuthority.publicKey)).to.equal(
      true
    );
    expect(state.tokenMint.equals(tokenMint)).to.equal(true);
    expect(state.requiredStake.eq(new anchor.BN(1_000_000_000))).to.equal(true);
  });
});
