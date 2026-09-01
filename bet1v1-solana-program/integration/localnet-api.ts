import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect } from "chai";
import { Bet1v1SolanaProgram } from "../target/types/bet1v1_solana_program";

type ApiWager = {
  wagerId: string;
  maker: string;
  challenger: string | null;
  opponent: string | null;
  amount: string;
  asset: "SOL" | "USDC";
  game: "CS2" | "QUAKE3";
  status: string;
  winner: string | null;
  payoutMode: "WINNER_TAKE_ALL" | "INCREMENTAL";
  incrementValue: string;
  makerRemaining: string;
  opponentRemaining: string;
  makerScore: number;
  opponentScore: number;
  cashoutRequestedBy?: string | null;
  makerFinalBalance?: string | null;
  opponentFinalBalance?: string | null;
  quake3Identity?: Quake3Identity;
};

type Quake3Identity = {
  wagerId?: string;
  playerName: string;
  playUrl: string;
  connected: boolean;
  clientNum: number | null;
};

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const keypair = (path: string) =>
  anchor.web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[])
  );

const privateKey = (wallet: anchor.web3.Keypair) =>
  createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(wallet.secretKey.subarray(0, 32)),
    ]),
    format: "der",
    type: "pkcs8",
  });

const apiBase = process.env.API_URL ?? "http://127.0.0.1:3000/api";
const eventSecret =
  process.env.Q3JS_EVENT_CLIENT_SECRET ??
  "bet1v1-q3-local-event-secret-change-me";

const api = async <T>(path: string, init: RequestInit = {}) => {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${body.error ?? response.statusText}`
    );
  }
  return body;
};

const authenticate = async (wallet: anchor.web3.Keypair) => {
  const address = wallet.publicKey.toBase58();
  const challenge = await api<{ nonce: string; message: string }>(
    `/auth/challenge/${address}`
  );
  const signature = sign(
    null,
    Buffer.from(challenge.message),
    privateKey(wallet)
  );
  const session = await api<{ token: string }>("/auth/verify", {
    method: "POST",
    body: JSON.stringify({
      wallet: address,
      nonce: challenge.nonce,
      signature: Array.from(signature),
    }),
  });
  return session.token;
};

const authorized = (token: string, body: unknown): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

const waitFor = async <T>(
  label: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = Number(process.env.CHAIN_WAIT_TIMEOUT_MS ?? "30000")
) => {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  if (!ready(value)) throw new Error(`Timed out waiting for ${label}`);
  return value;
};

describe("API and chain worker integration", function () {
  this.timeout(Number(process.env.INTEGRATION_TIMEOUT_MS ?? "120000"));

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .bet1v1SolanaProgram as Program<Bet1v1SolanaProgram>;
  const payer = (
    provider.wallet as anchor.Wallet & { payer: anchor.web3.Keypair }
  ).payer;
  const maker = keypair(required("MAKER_KEYPAIR"));
  const opponent = keypair(required("OPPONENT_KEYPAIR"));
  const usdcMint = new anchor.web3.PublicKey(required("USDC_MINT"));
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
  const wagerAddress = (id: anchor.BN) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager"), idSeed(id)],
      program.programId
    )[0];
  const wagerVault = (id: anchor.BN) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager_vault"), idSeed(id)],
      program.programId
    )[0];

  let makerToken: anchor.web3.PublicKey;
  let opponentToken: anchor.web3.PublicKey;
  let makerSession = "";
  let opponentSession = "";

  before(async () => {
    makerToken = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        usdcMint,
        maker.publicKey
      )
    ).address;
    opponentToken = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        usdcMint,
        opponent.publicKey
      )
    ).address;
    for (const token of [makerToken, opponentToken]) {
      const current = (await getAccount(provider.connection, token)).amount;
      const target = BigInt(5_000_000);
      if (current >= target) continue;
      await mintTo(
        provider.connection,
        payer,
        usdcMint,
        token,
        payer,
        target - current
      );
    }
    [makerSession, opponentSession] = await Promise.all([
      authenticate(maker),
      authenticate(opponent),
    ]);
    const makerUsername = `m_${maker.publicKey.toBase58().slice(0, 12)}`;
    const opponentUsername = `o_${opponent.publicKey.toBase58().slice(0, 12)}`;
    await Promise.all([
      api(
        `/account/${maker.publicKey.toBase58()}/username`,
        { ...authorized(makerSession, { username: makerUsername }), method: "PUT" }
      ),
      api(
        `/account/${opponent.publicKey.toBase58()}/username`,
        { ...authorized(opponentSession, { username: opponentUsername }), method: "PUT" }
      )
    ]);
    await api(
      "/friends",
      authorized(makerSession, {
        owner: maker.publicKey.toBase58(),
        friend: opponent.publicKey.toBase58(),
      })
    );
  });

  it("exposes the deployed cluster configuration through the API", async () => {
    const configResponse = await api<{
      programId: string;
      usdcMint: string;
      mockChain: boolean;
      stakingEnabled: boolean;
    }>("/config");
    expect(configResponse.programId).to.equal(program.programId.toBase58());
    expect(configResponse.usdcMint).to.equal(usdcMint.toBase58());
    expect(configResponse.mockChain).to.equal(false);
    expect(configResponse.stakingEnabled).to.equal(false);
  });

  it("keeps a reserved challenge entirely off-chain when it is declined", async () => {
    const makerBefore = await provider.connection.getBalance(maker.publicKey);
    const opponentBefore = await provider.connection.getBalance(opponent.publicKey);
    const created = await api<ApiWager>(
      "/wagers",
      authorized(makerSession, {
        maker: maker.publicKey.toBase58(),
        challenger: opponent.publicKey.toBase58(),
        amount: "1000000",
        asset: "SOL",
        game: "CS2",
        payoutMode: "WINNER_TAKE_ALL",
        incrementValue: "0",
        fragLimit: 10,
      })
    );
    const id = new anchor.BN(created.wagerId);
    expect(await provider.connection.getAccountInfo(wagerAddress(id))).to.equal(null);

    await api(
      `/wagers/${created.wagerId}/decline`,
      authorized(opponentSession, { challenger: opponent.publicKey.toBase58() })
    );
    const declined = (await api<ApiWager[]>(
      `/wagers?wallet=${opponent.publicKey.toBase58()}&game=CS2`
    )).find((wager) => wager.wagerId === created.wagerId);
    expect(declined?.status).to.equal("DECLINED");
    expect(await provider.connection.getAccountInfo(wagerAddress(id))).to.equal(null);
    expect(await provider.connection.getBalance(maker.publicKey)).to.equal(makerBefore);
    expect(await provider.connection.getBalance(opponent.publicKey)).to.equal(opponentBefore);
  });

  it("moves USDC after mocked Quake scoring events through the API and worker", async () => {
    const makerBeforeAcceptance = (await getAccount(provider.connection, makerToken)).amount;
    const opponentBeforeAcceptance = (await getAccount(provider.connection, opponentToken)).amount;
    const created = await api<ApiWager>(
      "/wagers",
      authorized(makerSession, {
        maker: maker.publicKey.toBase58(),
        challenger: null,
        amount: "1000000",
        asset: "USDC",
        game: "QUAKE3",
        payoutMode: "INCREMENTAL",
        incrementValue: "250000",
        fragLimit: 10,
      })
    );
    const acceptedOffChain = await api<ApiWager>(
      `/wagers/${created.wagerId}/accept-intent`,
      authorized(opponentSession, { opponent: opponent.publicKey.toBase58() })
    );
    const id = new anchor.BN(created.wagerId);
    expect(acceptedOffChain.status).to.equal("ACCEPTED");
    expect(await provider.connection.getAccountInfo(wagerAddress(id))).to.equal(null);
    expect((await getAccount(provider.connection, makerToken)).amount).to.equal(makerBeforeAcceptance);
    expect((await getAccount(provider.connection, opponentToken)).amount).to.equal(opponentBeforeAcceptance);
    const createSignature = await program.methods
      .createWager(
        id,
        anchor.web3.PublicKey.default,
        new anchor.BN(1_000_000),
        1,
        new anchor.BN(250_000)
      )
      .accountsPartial({
        config,
        makerStake: stake(maker.publicKey),
        wager: wagerAddress(id),
        wagerVault: wagerVault(id),
        tokenMint: usdcMint,
        makerToken,
        maker: maker.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([maker])
      .rpc();
    await api(
      `/wagers/${created.wagerId}/chain`,
      authorized(makerSession, {
        maker: maker.publicKey.toBase58(),
        signature: createSignature,
      })
    );

    const joinSignature = await program.methods
      .joinWager()
      .accountsPartial({
        config,
        opponentStake: stake(opponent.publicKey),
        wager: wagerAddress(id),
        wagerVault: wagerVault(id),
        tokenMint: usdcMint,
        opponentToken,
        opponent: opponent.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([opponent])
      .rpc();
    const accepted = await api<ApiWager>(
      `/wagers/${created.wagerId}/accept`,
      authorized(opponentSession, {
        opponent: opponent.publicKey.toBase58(),
        signature: joinSignature,
      })
    );
    const makerName = created.quake3Identity?.playerName;
    const opponentName = accepted.quake3Identity?.playerName;
    if (!makerName || !opponentName)
      throw new Error("Missing private Quake identities");
    expect(makerName).to.match(/^m_/);
    expect(opponentName).to.match(/^o_/);
    const [recoveredMaker, recoveredOpponent] = await Promise.all([
      api<Quake3Identity>(
        `/wagers/${created.wagerId}/quake3-identity?wallet=${maker.publicKey.toBase58()}`,
        { headers: { authorization: `Bearer ${makerSession}` } }
      ),
      api<Quake3Identity>(
        `/wagers/${created.wagerId}/quake3-identity?wallet=${opponent.publicKey.toBase58()}`,
        { headers: { authorization: `Bearer ${opponentSession}` } }
      )
    ]);
    expect(recoveredMaker.playerName).to.equal(makerName);
    expect(recoveredOpponent.playerName).to.equal(opponentName);
    expect(recoveredMaker.playerName).not.to.equal(recoveredOpponent.playerName);
    const playUrl = new URL(recoveredMaker.playUrl);
    expect(playUrl.searchParams.get("name")).to.equal(makerName);
    expect(playUrl.searchParams.get("fsGame")).to.equal("q3js");

    for (const [playerName, clientNum] of [
      [makerName, 1],
      [opponentName, 2],
    ] as const) {
      await api("/q3/events", {
        method: "POST",
        headers: { "x-q3js-client-secret": eventSecret },
        body: JSON.stringify({
          event: "join",
          player: { clientNum, name: playerName },
          gameTime: clientNum,
          serverTime: clientNum,
          map: "q3dm17",
        }),
      });
    }
    const linkedMaker = await waitFor(
      "the Quake server to link the game identity to the maker wallet",
      () => api<Quake3Identity>(
        `/wagers/${created.wagerId}/quake3-identity?wallet=${maker.publicKey.toBase58()}`,
        { headers: { authorization: `Bearer ${makerSession}` } }
      ),
      (identity) => identity.connected
    );
    expect(linkedMaker.clientNum).to.equal(1);

    const sendKill = (sequence: number) =>
      api("/q3/events", {
        method: "POST",
        headers: { "x-q3js-client-secret": eventSecret },
        body: JSON.stringify({
          event: "kill",
          killer: { clientNum: 1, name: makerName },
          victim: { clientNum: 2, name: opponentName },
          meansOfDeath: 7,
          gameTime: 100 + sequence,
          serverTime: 1_000 + sequence,
          map: "q3dm17",
        }),
      });

    await sendKill(1);
    await sendKill(1);
    const afterFirst = await waitFor(
      "the first automated USDC increment",
      async () => {
        const wagers = await api<ApiWager[]>(
          `/wagers?wallet=${maker.publicKey.toBase58()}&game=QUAKE3`
        );
        return wagers.find((wager) => wager.wagerId === created.wagerId);
      },
      (wager) => wager?.makerScore === 1
    );
    expect(afterFirst?.opponentRemaining).to.equal("750000");
    expect((await getAccount(provider.connection, makerToken)).amount).to.equal(
      BigInt(4_250_000)
    );

    await sendKill(2);
    await sendKill(3);
    await sendKill(4);
    const settled = await waitFor(
      "the automation worker to close the incremental wager",
      async () => {
        const wagers = await api<ApiWager[]>(
          `/wagers?wallet=${maker.publicKey.toBase58()}&game=QUAKE3`
        );
        return wagers.find((wager) => wager.wagerId === created.wagerId);
      },
      (wager) => wager?.status === "SETTLED"
    );
    expect(settled?.winner).to.equal(maker.publicKey.toBase58());
    expect(settled?.makerScore).to.equal(4);
    expect((await getAccount(provider.connection, makerToken)).amount).to.equal(
      BigInt(6_000_000)
    );
    expect(
      (await getAccount(provider.connection, wagerVault(id))).amount
    ).to.equal(BigInt(0));
    console.log(
      `incrementalWager=${created.wagerId} winner=${settled?.winner}`
    );
  });

  it("moves native SOL after an API winner event signed by the worker", async () => {
    const amount = new anchor.BN(200_000_000);
    const created = await api<ApiWager>(
      "/wagers",
      authorized(makerSession, {
        maker: maker.publicKey.toBase58(),
        challenger: null,
        amount: amount.toString(),
        asset: "SOL",
        game: "CS2",
        payoutMode: "WINNER_TAKE_ALL",
        incrementValue: "0",
        fragLimit: 10,
      })
    );
    await api<ApiWager>(
      `/wagers/${created.wagerId}/accept-intent`,
      authorized(opponentSession, { opponent: opponent.publicKey.toBase58() })
    );
    const id = new anchor.BN(created.wagerId);
    const createSignature = await program.methods
      .createSolWager(
        id,
        anchor.web3.PublicKey.default,
        amount,
        0,
        new anchor.BN(0)
      )
      .accountsPartial({
        config,
        makerStake: stake(maker.publicKey),
        wager: wagerAddress(id),
        maker: maker.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc();
    await api(
      `/wagers/${created.wagerId}/chain`,
      authorized(makerSession, {
        maker: maker.publicKey.toBase58(),
        signature: createSignature,
      })
    );
    const joinSignature = await program.methods
      .joinSolWager()
      .accountsPartial({
        config,
        opponentStake: stake(opponent.publicKey),
        wager: wagerAddress(id),
        opponent: opponent.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([opponent])
      .rpc();
    await api(
      `/wagers/${created.wagerId}/accept`,
      authorized(opponentSession, {
        opponent: opponent.publicKey.toBase58(),
        signature: joinSignature,
      })
    );
    const makerBeforeSettlement = await provider.connection.getBalance(
      maker.publicKey
    );

    await api("/admin/winners", {
      method: "POST",
      headers: { "x-admin-key": process.env.ADMIN_KEY ?? "local-admin" },
      body: JSON.stringify({
        wagerId: created.wagerId,
        winner: maker.publicKey.toBase58(),
      }),
    });
    const settled = await waitFor(
      "the automation worker to settle native SOL",
      async () => {
        const wagers = await api<ApiWager[]>(
          `/wagers?wallet=${maker.publicKey.toBase58()}&game=CS2`
        );
        return wagers.find((wager) => wager.wagerId === created.wagerId);
      },
      (wager) => wager?.status === "SETTLED"
    );
    const makerAfterSettlement = await provider.connection.getBalance(
      maker.publicKey
    );
    expect(settled?.winner).to.equal(maker.publicKey.toBase58());
    expect(makerAfterSettlement - makerBeforeSettlement).to.equal(
      amount.muln(2).toNumber()
    );
    const info = await provider.connection.getAccountInfo(wagerAddress(id));
    if (!info) throw new Error("SOL wager account missing");
    const rent = await provider.connection.getMinimumBalanceForRentExemption(
      info.data.length
    );
    expect(info.lamports).to.equal(rent);
    console.log(
      `solWager=${created.wagerId} payoutLamports=${amount.muln(2).toString()}`
    );
  });

  it("moves native SOL per score and mutually cashes out the live balances", async () => {
    const amount = new anchor.BN(100_000_000);
    const incrementValue = new anchor.BN(25_000_000);
    const cashoutGame = process.env.CASHOUT_TEST_GAME === "CS2" ? "CS2" : "QUAKE3";
    await api(
      "/friends",
      authorized(makerSession, {
        owner: maker.publicKey.toBase58(),
        friend: opponent.publicKey.toBase58(),
      })
    );
    const friends = await api<{ wallet: string }[]>(
      `/friends/${maker.publicKey.toBase58()}`
    );
    expect(friends.some(({ wallet }) => wallet === opponent.publicKey.toBase58())).to.equal(true);
    const existingWagerId = process.env.CASHOUT_EXISTING_WAGER_ID;
    let created: ApiWager;
    let accepted: ApiWager;
    if (existingWagerId) {
      const wagers = await api<ApiWager[]>(
        `/wagers?wallet=${maker.publicKey.toBase58()}&game=${cashoutGame}`
      );
      const existing = wagers.find((wager) => wager.wagerId === existingWagerId);
      if (!existing || existing.status !== "MATCHED") {
        throw new Error(`Existing cash-out wager ${existingWagerId} is not matched`);
      }
      created = existing;
      accepted = existing;
    } else {
      created = await api<ApiWager>(
        "/wagers",
        authorized(makerSession, {
          maker: maker.publicKey.toBase58(),
          challenger: opponent.publicKey.toBase58(),
          amount: amount.toString(),
          asset: "SOL",
          game: cashoutGame,
          payoutMode: "INCREMENTAL",
          incrementValue: incrementValue.toString(),
          fragLimit: 10,
        })
      );
      await api<ApiWager>(
        `/wagers/${created.wagerId}/accept-intent`,
        authorized(opponentSession, { opponent: opponent.publicKey.toBase58() })
      );
      const pendingId = new anchor.BN(created.wagerId);
      const createSignature = await program.methods
        .createSolWager(
          pendingId,
          opponent.publicKey,
          amount,
          1,
          incrementValue
        )
        .accountsPartial({
          config,
          makerStake: stake(maker.publicKey),
          wager: wagerAddress(pendingId),
          maker: maker.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      await api(
        `/wagers/${created.wagerId}/chain`,
        authorized(makerSession, {
          maker: maker.publicKey.toBase58(),
          signature: createSignature,
        })
      );
      const joinSignature = await program.methods
        .joinSolWager()
        .accountsPartial({
          config,
          opponentStake: stake(opponent.publicKey),
          wager: wagerAddress(pendingId),
          opponent: opponent.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([opponent])
        .rpc();
      accepted = await api<ApiWager>(
        `/wagers/${created.wagerId}/accept`,
        authorized(opponentSession, {
          opponent: opponent.publicKey.toBase58(),
          signature: joinSignature,
        })
      );
    }
    const id = new anchor.BN(created.wagerId);
    const makerBeforeScores = await provider.connection.getBalance(maker.publicKey);
    const opponentBeforeScores = await provider.connection.getBalance(opponent.publicKey);
    if (cashoutGame === "QUAKE3") {
      const makerName = created.quake3Identity?.playerName;
      const opponentName = accepted.quake3Identity?.playerName;
      if (!makerName || !opponentName) throw new Error("Missing private Quake identities");
      for (const [playerName, clientNum] of [[makerName, 3], [opponentName, 4]] as const) {
        await api("/q3/events", {
          method: "POST",
          headers: { "x-q3js-client-secret": eventSecret },
          body: JSON.stringify({
            event: "join",
            player: { clientNum, name: playerName },
            gameTime: 200 + clientNum,
            serverTime: 2_000 + clientNum,
            map: "q3dm17",
          }),
        });
      }
      await api("/q3/events", {
        method: "POST",
        headers: { "x-q3js-client-secret": eventSecret },
        body: JSON.stringify({
          event: "kill",
          killer: { clientNum: 3, name: makerName },
          victim: { clientNum: 4, name: opponentName },
          meansOfDeath: 7,
          gameTime: 301,
          serverTime: 3_001,
          map: "q3dm17",
        }),
      });
      await waitFor(
        "the native SOL increment before cash out",
        async () => {
          const wagers = await api<ApiWager[]>(
            `/wagers?wallet=${maker.publicKey.toBase58()}&game=${cashoutGame}`
          );
          return wagers.find((wager) => wager.wagerId === created.wagerId);
        },
        (wager) => wager?.makerScore === 1
      );
    }
    const requested = await api<{ state: string }>(
      `/wagers/${created.wagerId}/cashout`,
      authorized(makerSession, { wallet: maker.publicKey.toBase58() })
    );
    expect(requested.state).to.equal("REQUESTED");
    const approved = await api<{ state: string }>(
      `/wagers/${created.wagerId}/cashout`,
      authorized(opponentSession, { wallet: opponent.publicKey.toBase58() })
    );
    expect(approved.state).to.equal("CASHING_OUT");
    const cashedOut = await waitFor(
      "the automation worker to return both live SOL balances",
      async () => {
        const wagers = await api<ApiWager[]>(
          `/wagers?wallet=${maker.publicKey.toBase58()}&game=${cashoutGame}`
        );
        return wagers.find((wager) => wager.wagerId === created.wagerId);
      },
      (wager) => wager?.status === "CASHED_OUT"
    );
    expect(cashedOut?.winner).to.equal(null);
    const makerFinalBalance = cashoutGame === "QUAKE3" ? 125_000_000 : 100_000_000;
    const opponentFinalBalance = cashoutGame === "QUAKE3" ? 75_000_000 : 100_000_000;
    expect(cashedOut?.makerFinalBalance).to.equal(makerFinalBalance.toString());
    expect(cashedOut?.opponentFinalBalance).to.equal(opponentFinalBalance.toString());
    expect(await provider.connection.getBalance(maker.publicKey)).to.equal(
      makerBeforeScores + makerFinalBalance
    );
    expect(await provider.connection.getBalance(opponent.publicKey)).to.equal(
      opponentBeforeScores + opponentFinalBalance
    );
    const info = await provider.connection.getAccountInfo(wagerAddress(id));
    if (!info) throw new Error("SOL wager account missing");
    const rent = await provider.connection.getMinimumBalanceForRentExemption(info.data.length);
    expect(info.lamports).to.equal(rent);
    console.log(
      `solIncrementalCashout=${created.wagerId} maker=${makerFinalBalance / anchor.web3.LAMPORTS_PER_SOL}SOL opponent=${opponentFinalBalance / anchor.web3.LAMPORTS_PER_SOL}SOL`
    );
  });
});
