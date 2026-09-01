import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { expect } from "chai";
import { Bet1v1SolanaProgram } from "../target/types/bet1v1_solana_program";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const keypair = (path: string) =>
  anchor.web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[])
  );

describe("initialize cluster config", () => {
  it("sets the default wallet as admin and the dedicated automation signer", async () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace
      .bet1v1SolanaProgram as Program<Bet1v1SolanaProgram>;
    const chainAuthority = keypair(required("CHAIN_AUTHORITY_KEYPAIR"));
    const tokenMint = new anchor.web3.PublicKey(required("TOKEN_MINT"));
    const usdcMint = new anchor.web3.PublicKey(required("USDC_MINT"));
    const [config] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    if (!(await provider.connection.getAccountInfo(config))) {
      await program.methods
        .initializeConfig(new anchor.BN(0), false)
        .accountsPartial({
          config,
          authority: provider.wallet.publicKey,
          chainAuthority: chainAuthority.publicKey,
          tokenMint,
          usdcMint,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([chainAuthority])
        .rpc();
    }

    const state = await program.account.config.fetch(config);
    expect(state.authority.equals(provider.wallet.publicKey)).to.equal(true);
    expect(state.chainAuthority.equals(chainAuthority.publicKey)).to.equal(
      true
    );
    expect(state.tokenMint.equals(tokenMint)).to.equal(true);
    expect(state.usdcMint.equals(usdcMint)).to.equal(true);
    expect(state.stakingEnabled).to.equal(false);
    console.log(`admin=${state.authority.toBase58()}`);
    console.log(`chainAutomation=${state.chainAuthority.toBase58()}`);
    console.log(`accessMint=${state.tokenMint.toBase58()}`);
    console.log(`usdcMint=${state.usdcMint.toBase58()}`);
  });
});
