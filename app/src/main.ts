import "./style.css";
import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import { Buffer } from "buffer";

type Phantom = {
  publicKey?: PublicKey;
  connect: () => Promise<{ publicKey: PublicKey }>;
  signAndSendTransaction: (transaction: Transaction) => Promise<{ signature: string }>;
};

declare global {
  interface Window {
    solana?: Phantom;
  }
}

type AppConfig = {
  programId: string;
  tokenMint: string;
  mockChain: boolean;
  serverAddress: string;
};

type Access = {
  amount: string;
  requiredStake: string;
  banned: boolean;
  active: boolean;
};

type Wager = {
  wagerId: string;
  maker: string;
  challenger: string | null;
  opponent: string | null;
  amount: string;
  status: string;
  serverAddress: string | null;
  winner: string | null;
};

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const decimals = Number(import.meta.env.VITE_TOKEN_DECIMALS ?? 9);
const connection = new Connection(import.meta.env.VITE_SOLANA_RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const tokenProgramId = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const associatedTokenProgramId = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
let walletAddress = "";
let appConfig: AppConfig;

const root = document.querySelector<HTMLDivElement>("#app")!;

root.innerHTML = `
  <header>
    <div class="brand">BET<span>1V1</span></div>
    <div class="row">
      <span class="wallet" id="wallet">Wallet disconnected</span>
      <button id="connect">Connect wallet</button>
    </div>
  </header>
  <main>
    <section class="hero">
      <span class="pill">P2P ARENA WAGERING</span>
      <h1>Stake. Challenge. <span class="accent">Duke it out.</span></h1>
      <p class="muted">Stake BET1V1 for access, escrow a wager, then settle from the verified server result.</p>
    </section>
    <section class="grid">
      <article class="card stack">
        <div class="row between"><h2>Access stake</h2><span class="pill" id="access-status">LOCKED</span></div>
        <p class="muted" id="stake-copy">Connect a wallet to check access.</p>
        <div class="row">
          <input id="stake-amount" type="number" min="0" step="0.000000001" value="1" aria-label="Stake amount" />
          <button id="stake" disabled>Stake</button>
        </div>
      </article>
    </section>
    <div id="gated" class="hidden">
    <section class="grid" style="margin-top: 1rem">
      <article class="card stack">
        <h2>Friend list</h2>
        <div class="row">
          <input id="friend-wallet" placeholder="Friend wallet" aria-label="Friend wallet" />
          <button id="add-friend" disabled>Add</button>
        </div>
        <div id="friends" class="stack"><span class="empty">No friends yet.</span></div>
      </article>
      <article class="card stack">
        <h2>New wager</h2>
        <input id="wager-amount" type="number" min="0" step="0.000000001" value="0.1" aria-label="Wager amount" />
        <input id="challenger" placeholder="Friend wallet or blank for random" aria-label="Challenger wallet" />
        <button id="create-wager" disabled>Create wager</button>
      </article>
    </section>
    <section class="grid" style="margin-top: 1rem">
      <article class="card">
        <div class="row between"><h2>Open challenges</h2><button class="secondary" id="refresh">Refresh</button></div>
        <div id="open-wagers"><span class="empty">No open wagers.</span></div>
      </article>
      <article class="card">
        <h2>Your matches</h2>
        <div id="my-wagers"><span class="empty">Connect a wallet.</span></div>
      </article>
    </section>
    <section class="card" style="margin-top: 1rem">
      <div class="row between"><div><h2>Admin match simulator</h2><p class="muted">Publish a signed-off winner event without installing a game server.</p></div><input id="admin-key" value="local-admin" aria-label="Admin key" style="max-width: 14rem" /></div>
      <div id="admin-wagers"><span class="empty">No matched wagers.</span></div>
    </section>
    </div>
  </main>
  <div id="notice" class="hidden"></div>
`;

const element = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const notice = (message: string) => {
  const item = element<HTMLDivElement>("notice");
  item.textContent = message;
  item.classList.remove("hidden");
  window.setTimeout(() => item.classList.add("hidden"), 3500);
};

const api = async <T>(path: string, init?: RequestInit) => {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers }
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? "Request failed");
  }
  return body;
};

const rawAmount = (value: string) => {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0").slice(0, decimals) || "0");
};

const displayAmount = (value: string) => {
  const unit = 10 ** decimals;
  return (Number(value) / unit).toLocaleString(undefined, { maximumFractionDigits: decimals });
};

const u64 = (value: bigint) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
};

const instructionData = async (name: string, parts: Uint8Array[] = []) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  const discriminator = new Uint8Array(digest).slice(0, 8);
  const length = parts.reduce((total, part) => total + part.length, discriminator.length);
  const data = new Uint8Array(length);
  data.set(discriminator);
  let offset = discriminator.length;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return Buffer.from(data);
};

const pda = (seeds: Uint8Array[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds.map((seed) => Buffer.from(seed)), programId)[0];

const associatedTokenAddress = (mint: PublicKey, owner: PublicKey) =>
  pda([owner.toBytes(), tokenProgramId.toBytes(), mint.toBytes()], associatedTokenProgramId);

const provider = () => {
  if (!window.solana) {
    throw new Error("Install a Solana wallet extension");
  }
  return window.solana;
};

const send = async (instruction: TransactionInstruction) => {
  const wallet = provider();
  if (!wallet.publicKey) {
    await wallet.connect();
  }
  const transaction = new Transaction().add(instruction);
  transaction.feePayer = wallet.publicKey;
  const latest = await connection.getLatestBlockhash();
  transaction.recentBlockhash = latest.blockhash;
  const result = await wallet.signAndSendTransaction(transaction);
  await connection.confirmTransaction({ signature: result.signature, ...latest }, "confirmed");
  return result.signature;
};

const stakeOnChain = async (amount: bigint) => {
  const user = new PublicKey(walletAddress);
  const programId = new PublicKey(appConfig.programId);
  const mint = new PublicKey(appConfig.tokenMint);
  const configAddress = pda([new TextEncoder().encode("config")], programId);
  const stake = pda([new TextEncoder().encode("stake"), user.toBytes()], programId);
  const stakeVault = pda([new TextEncoder().encode("stake_vault"), user.toBytes()], programId);
  const userToken = associatedTokenAddress(mint, user);
  return send(new TransactionInstruction({
    programId,
    data: await instructionData("stake_tokens", [u64(amount)]),
    keys: [
      { pubkey: configAddress, isSigner: false, isWritable: false },
      { pubkey: stake, isSigner: false, isWritable: true },
      { pubkey: stakeVault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: userToken, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ]
  }));
};

const createWagerOnChain = async (wager: Wager) => {
  const maker = new PublicKey(walletAddress);
  const challenger = wager.challenger ? new PublicKey(wager.challenger) : PublicKey.default;
  const programId = new PublicKey(appConfig.programId);
  const mint = new PublicKey(appConfig.tokenMint);
  const id = u64(BigInt(wager.wagerId));
  return send(new TransactionInstruction({
    programId,
    data: await instructionData("create_wager", [id, challenger.toBytes(), u64(BigInt(wager.amount))]),
    keys: [
      { pubkey: pda([new TextEncoder().encode("config")], programId), isSigner: false, isWritable: false },
      { pubkey: pda([new TextEncoder().encode("stake"), maker.toBytes()], programId), isSigner: false, isWritable: true },
      { pubkey: pda([new TextEncoder().encode("wager"), id], programId), isSigner: false, isWritable: true },
      { pubkey: pda([new TextEncoder().encode("wager_vault"), id], programId), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: associatedTokenAddress(mint, maker), isSigner: false, isWritable: true },
      { pubkey: maker, isSigner: true, isWritable: true },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ]
  }));
};

const joinWagerOnChain = async (wager: Wager) => {
  const opponent = new PublicKey(walletAddress);
  const programId = new PublicKey(appConfig.programId);
  const mint = new PublicKey(appConfig.tokenMint);
  const id = u64(BigInt(wager.wagerId));
  return send(new TransactionInstruction({
    programId,
    data: await instructionData("join_wager"),
    keys: [
      { pubkey: pda([new TextEncoder().encode("config")], programId), isSigner: false, isWritable: false },
      { pubkey: pda([new TextEncoder().encode("stake"), opponent.toBytes()], programId), isSigner: false, isWritable: true },
      { pubkey: pda([new TextEncoder().encode("wager"), id], programId), isSigner: false, isWritable: true },
      { pubkey: pda([new TextEncoder().encode("wager_vault"), id], programId), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: associatedTokenAddress(mint, opponent), isSigner: false, isWritable: true },
      { pubkey: opponent, isSigner: true, isWritable: true },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false }
    ]
  }));
};

const renderWager = (wager: Wager, action = "") => `
  <div class="wager">
    <div class="row between"><strong>#${wager.wagerId} · ${displayAmount(wager.amount)} BET1V1 each</strong><span class="pill">${wager.status}</span></div>
    <span class="muted">${wager.maker.slice(0, 8)}… vs ${wager.opponent ? `${wager.opponent.slice(0, 8)}…` : "waiting"}</span>
    ${wager.winner ? `<span class="accent">Winner ${wager.winner.slice(0, 12)}…</span>` : ""}
    ${action}
  </div>
`;

const refreshAccess = async () => {
  if (!walletAddress) return;
  const access = await api<Access>(`/access/${walletAddress}`);
  element("access-status").textContent = access.banned ? "BANNED" : access.active ? "ACTIVE" : "LOCKED";
  element("stake-copy").textContent = `${displayAmount(access.amount)} staked · ${displayAmount(access.requiredStake)} required`;
  element("gated").classList.toggle("hidden", !access.active);
  element<HTMLButtonElement>("stake").disabled = access.banned;
  element<HTMLButtonElement>("create-wager").disabled = !access.active;
  element<HTMLButtonElement>("add-friend").disabled = !access.active;
};

const refreshFriends = async () => {
  if (!walletAddress) return;
  const friends = await api<{ wallet: string }[]>(`/friends/${walletAddress}`);
  element("friends").innerHTML = friends.length
    ? friends.map((friend) => `<span class="wallet">${friend.wallet}</span>`).join("")
    : `<span class="empty">No friends yet.</span>`;
};

const refreshWagers = async () => {
  const open = await api<Wager[]>("/wagers?status=OPEN");
  element("open-wagers").innerHTML = open.length
    ? open.map((wager) => {
        const available = walletAddress && wager.maker !== walletAddress && (!wager.challenger || wager.challenger === walletAddress);
        return renderWager(wager, available ? `<button data-join="${wager.wagerId}">Accept</button>` : "");
      }).join("")
    : `<span class="empty">No open wagers.</span>`;
  const mine = walletAddress ? await api<Wager[]>(`/wagers?wallet=${walletAddress}`) : [];
  element("my-wagers").innerHTML = mine.length
    ? mine.map((wager) => renderWager(wager, wager.status === "MATCHED" && wager.serverAddress ? `<button data-connect="${wager.serverAddress}">Connect to CS2</button>` : "")).join("")
    : `<span class="empty">No matches yet.</span>`;
  const matched = await api<Wager[]>("/wagers?status=MATCHED");
  element("admin-wagers").innerHTML = matched.length
    ? matched.map((wager) => renderWager(wager, `<div class="row"><button data-winner-id="${wager.wagerId}" data-winner="${wager.maker}">Maker won</button><button class="secondary" data-winner-id="${wager.wagerId}" data-winner="${wager.opponent}">Opponent won</button></div>`)).join("")
    : `<span class="empty">No matched wagers.</span>`;
};

element("connect").addEventListener("click", async () => {
  try {
    const result = await provider().connect();
    walletAddress = result.publicKey.toBase58();
    element("wallet").textContent = walletAddress;
    await Promise.all([refreshAccess(), refreshFriends(), refreshWagers()]);
  } catch (error) {
    notice(error instanceof Error ? error.message : "Wallet connection failed");
  }
});

element("stake").addEventListener("click", async () => {
  try {
    const amount = rawAmount(element<HTMLInputElement>("stake-amount").value);
    if (appConfig.mockChain) {
      await api(`/users/${walletAddress}/mock-stake`, { method: "POST", body: JSON.stringify({ amount: amount.toString() }) });
    } else {
      await stakeOnChain(amount);
    }
    await refreshAccess();
    notice("Stake updated");
  } catch (error) {
    notice(error instanceof Error ? error.message : "Stake failed");
  }
});

element("add-friend").addEventListener("click", async () => {
  try {
    const friend = element<HTMLInputElement>("friend-wallet").value.trim();
    await api("/friends", { method: "POST", body: JSON.stringify({ owner: walletAddress, friend }) });
    element<HTMLInputElement>("friend-wallet").value = "";
    await refreshFriends();
    notice("Friend added");
  } catch (error) {
    notice(error instanceof Error ? error.message : "Friend request failed");
  }
});

element("create-wager").addEventListener("click", async () => {
  try {
    const challenger = element<HTMLInputElement>("challenger").value.trim() || null;
    const amount = rawAmount(element<HTMLInputElement>("wager-amount").value).toString();
    const wager = await api<Wager>("/wagers", { method: "POST", body: JSON.stringify({ maker: walletAddress, challenger, amount }) });
    if (!appConfig.mockChain) {
      const signature = await createWagerOnChain(wager);
      await api(`/wagers/${wager.wagerId}/chain`, { method: "POST", body: JSON.stringify({ maker: walletAddress, signature }) });
    }
    await refreshWagers();
    notice(`Wager #${wager.wagerId} opened`);
  } catch (error) {
    notice(error instanceof Error ? error.message : "Wager creation failed");
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const joinId = target.dataset.join;
  const server = target.dataset.connect;
  const winnerId = target.dataset.winnerId;
  try {
    if (joinId) {
      const wagers = await api<Wager[]>(`/wagers?status=OPEN`);
      const wager = wagers.find((item) => item.wagerId === joinId);
      if (!wager) throw new Error("Wager is unavailable");
      const signature = appConfig.mockChain ? undefined : await joinWagerOnChain(wager);
      await api(`/wagers/${joinId}/accept`, { method: "POST", body: JSON.stringify({ opponent: walletAddress, signature }) });
      await refreshWagers();
      notice("Wager accepted");
    }
    if (server) {
      window.location.href = `steam://connect/${server}`;
    }
    if (winnerId) {
      await api("/admin/winners", {
        method: "POST",
        headers: { "x-admin-key": element<HTMLInputElement>("admin-key").value },
        body: JSON.stringify({ wagerId: winnerId, winner: target.dataset.winner })
      });
      notice("Winner event queued");
      window.setTimeout(refreshWagers, 800);
    }
  } catch (error) {
    notice(error instanceof Error ? error.message : "Action failed");
  }
});

element("refresh").addEventListener("click", refreshWagers);

const start = async () => {
  try {
    appConfig = await api<AppConfig>("/config");
    await refreshWagers();
  } catch (error) {
    notice(error instanceof Error ? error.message : "API unavailable");
  }
};

void start();
