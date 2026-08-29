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
  quake3ServerAddress: string;
};

type Game = "CS2" | "QUAKE3";

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
  game: Game;
  status: string;
  serverAddress: string | null;
  winner: string | null;
};

const apiUrl = import.meta.env.VITE_API_URL ?? "/api";
const decimals = Number(import.meta.env.VITE_TOKEN_DECIMALS ?? 9);
const connection = new Connection(import.meta.env.VITE_SOLANA_RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const tokenProgramId = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const associatedTokenProgramId = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
let walletAddress = "";
let appConfig: AppConfig;
let selectedGame: Game | null = null;
let accessActive = false;

const root = document.querySelector<HTMLDivElement>("#app")!;

root.innerHTML = `
  <div class="page-frame" aria-hidden="true"></div>
  <header class="topbar">
    <a class="brand-lockup" href="#" aria-label="Bet1v1 home">
      <span class="brand-mark">1V1</span>
      <span><strong>BET1V1</strong><small>ESPORTS PROTOCOL</small></span>
    </a>
    <div class="network-status"><i></i> SOLANA DEVNET</div>
    <div class="wallet-actions">
      <span class="wallet" id="wallet">WALLET DISCONNECTED</span>
      <button class="connect-button" id="connect">CONNECT WALLET</button>
    </div>
  </header>
  <main>
    <section class="hero">
      <div class="signal-label"><span></span>BET1V1 ESPORTS <b>PUBLIC</b><span></span></div>
      <div class="hero-crystal" aria-hidden="true"><i></i></div>
      <div class="hero-copy">
        <h1><span>Bet</span><em>1v1</em></h1>
        <div class="protocol-label"><b>P2P 1V1</b> ESPORTS WAGERING PROTOCOL</div>
        <p>Stake $B1V1. Choose your arena. Challenge a rival.</p>
        <div class="solana-lockup"><i><span></span><span></span><span></span></i> ON <b>SOLANA</b></div>
      </div>
      <div class="hero-footer"><span>WAGER P2P</span><i></i><span>1V1 DUELS</span><i></i><span>ON-CHAIN ESCROW</span><i></i><span>FAST FINALITY</span></div>
    </section>

    <section class="game-menu" id="game-menu">
      <div class="section-kicker">01 // SELECT YOUR ARENA</div>
      <div class="section-title-row">
        <div><h2>Choose your game</h2><p>Your arena determines which challenges and servers you enter.</p></div>
        <span class="menu-state" id="game-selection-state">AWAITING SELECTION</span>
      </div>
      <div class="game-grid">
        <button class="game-tile cs2-tile" data-game="CS2" type="button" aria-pressed="false">
          <span class="game-number">01</span>
          <span class="game-art cs2-art" aria-hidden="true"><i></i></span>
          <span class="game-info"><small>TACTICAL // BEST OF ONE</small><strong>COUNTER-STRIKE 2</strong><span>Precision aim. Zero excuses.</span></span>
          <span class="select-arrow">ENTER ARENA <b>→</b></span>
        </button>
        <button class="game-tile quake-tile" data-game="QUAKE3" type="button" aria-pressed="false">
          <span class="game-number">02</span>
          <span class="game-art quake-art" aria-hidden="true"><i>Q</i></span>
          <span class="game-info"><small>ARENA // FRAGLIMIT 10</small><strong>QUAKE III ARENA</strong><span>Pure movement. Pure duel.</span></span>
          <span class="select-arrow">ENTER ARENA <b>→</b></span>
        </button>
      </div>
    </section>

    <section class="access-panel card">
      <div class="access-copy">
        <div class="section-kicker">02 // ACCESS PROTOCOL</div>
        <div class="row between"><h2>Stake to compete</h2><span class="pill" id="access-status">LOCKED</span></div>
        <p class="muted" id="stake-copy">Connect a wallet to check access.</p>
      </div>
      <div class="stake-controls">
        <label for="stake-amount">$B1V1 AMOUNT</label>
        <div class="row">
          <input id="stake-amount" type="number" min="0" step="0.000000001" value="1" aria-label="Stake amount" />
          <button id="stake" disabled>STAKE TOKENS</button>
        </div>
      </div>
    </section>

    <div id="workspace" class="hidden arena-workspace">
      <div class="arena-heading">
        <div><div class="section-kicker">03 // MATCH CONTROL</div><h2 id="selected-game-title">Arena dashboard</h2></div>
        <span class="selected-game-chip" id="selected-game-chip">NO GAME</span>
      </div>
    <section class="grid">
      <article class="card stack">
        <div class="card-heading"><span class="card-icon">+</span><div><small>SQUAD NETWORK</small><h3>Friend list</h3></div></div>
        <div class="row">
          <input id="friend-wallet" placeholder="Friend wallet" aria-label="Friend wallet" />
          <button id="add-friend" disabled>ADD</button>
        </div>
        <div id="friends" class="stack"><span class="empty">No friends yet.</span></div>
      </article>
      <article class="card stack">
        <div class="card-heading"><span class="card-icon">◇</span><div><small>ON-CHAIN ESCROW</small><h3>New wager</h3></div></div>
        <label for="wager-amount">WAGER PER PLAYER</label>
        <input id="wager-amount" type="number" min="0" step="0.000000001" value="0.1" aria-label="Wager amount" />
        <input id="challenger" placeholder="Friend wallet or blank for random" aria-label="Challenger wallet" />
        <button id="create-wager" disabled>CREATE CHALLENGE</button>
      </article>
    </section>
    <section class="grid section-space">
      <article class="card">
        <div class="row between"><div class="card-heading"><span class="live-dot"></span><div><small>LIVE BOARD</small><h3>Open challenges</h3></div></div><button class="secondary compact" id="refresh">REFRESH</button></div>
        <div id="open-wagers"><span class="empty">No open wagers.</span></div>
      </article>
      <article class="card">
        <div class="card-heading"><span class="card-icon">×</span><div><small>PLAYER RECORD</small><h3>Your matches</h3></div></div>
        <div id="my-wagers"><span class="empty">Connect a wallet.</span></div>
      </article>
    </section>
    <section class="card admin-card section-space">
      <div class="row between"><div><div class="section-kicker">DEV CONTROL</div><h3>Admin match simulator</h3><p class="muted">Publish a verified winner event without installing a game server.</p></div><input id="admin-key" value="local-admin" aria-label="Admin key" /></div>
      <div id="admin-wagers"><span class="empty">No matched wagers.</span></div>
    </section>
    </div>
  </main>
  <footer><span>BET1V1 // PUBLIC BUILD</span><span>POWERED BY SOLANA</span></footer>
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

const gameName = (game: Game) => game === "CS2" ? "Counter-Strike 2" : "Quake III Arena";

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
    <div class="row between"><strong>#${wager.wagerId} · ${displayAmount(wager.amount)} $B1V1 EACH</strong><span class="pill">${wager.status}</span></div>
    <span class="game-tag">${wager.game === "CS2" ? "CS2" : "QUAKE III"}</span>
    <span class="muted">${wager.maker.slice(0, 8)}… vs ${wager.opponent ? `${wager.opponent.slice(0, 8)}…` : "waiting"}</span>
    ${wager.winner ? `<span class="accent">Winner ${wager.winner.slice(0, 12)}…</span>` : ""}
    ${action}
  </div>
`;

const refreshAccess = async () => {
  if (!walletAddress) return;
  const access = await api<Access>(`/access/${walletAddress}`);
  accessActive = access.active && !access.banned;
  element("access-status").textContent = access.banned ? "BANNED" : access.active ? "ACTIVE" : "LOCKED";
  element("stake-copy").textContent = `${displayAmount(access.amount)} staked · ${displayAmount(access.requiredStake)} required`;
  element<HTMLButtonElement>("stake").disabled = access.banned;
  element<HTMLButtonElement>("create-wager").disabled = !accessActive || !selectedGame;
  element<HTMLButtonElement>("add-friend").disabled = !accessActive || !selectedGame;
  element("workspace").classList.toggle("access-locked", !accessActive);
};

const refreshFriends = async () => {
  if (!walletAddress) return;
  const friends = await api<{ wallet: string }[]>(`/friends/${walletAddress}`);
  element("friends").innerHTML = friends.length
    ? friends.map((friend) => `<span class="wallet">${friend.wallet}</span>`).join("")
    : `<span class="empty">No friends yet.</span>`;
};

const refreshWagers = async () => {
  if (!selectedGame) return;
  const gameQuery = `game=${selectedGame}`;
  const open = await api<Wager[]>(`/wagers?status=OPEN&${gameQuery}`);
  element("open-wagers").innerHTML = open.length
    ? open.map((wager) => {
        const available = walletAddress && wager.maker !== walletAddress && (!wager.challenger || wager.challenger === walletAddress);
        return renderWager(wager, available ? `<button data-join="${wager.wagerId}">Accept</button>` : "");
      }).join("")
    : `<span class="empty">No open wagers.</span>`;
  const mine = walletAddress ? await api<Wager[]>(`/wagers?wallet=${walletAddress}&${gameQuery}`) : [];
  element("my-wagers").innerHTML = mine.length
    ? mine.map((wager) => renderWager(
        wager,
        wager.status === "MATCHED" && wager.serverAddress
          ? `<button data-connect="${wager.serverAddress}" data-connect-game="${wager.game}">${wager.game === "CS2" ? "CONNECT TO CS2" : "OPEN QUAKE SERVER"}</button>`
          : ""
      )).join("")
    : `<span class="empty">No matches yet.</span>`;
  const matched = await api<Wager[]>(`/wagers?status=MATCHED&${gameQuery}`);
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
    if (!selectedGame) throw new Error("Select a game first");
    const challenger = element<HTMLInputElement>("challenger").value.trim() || null;
    const amount = rawAmount(element<HTMLInputElement>("wager-amount").value).toString();
    const wager = await api<Wager>("/wagers", {
      method: "POST",
      body: JSON.stringify({ maker: walletAddress, challenger, amount, game: selectedGame })
    });
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
  const connectGame = target.dataset.connectGame as Game | undefined;
  const winnerId = target.dataset.winnerId;
  try {
    if (joinId) {
      const wagers = await api<Wager[]>(`/wagers?status=OPEN&game=${selectedGame}`);
      const wager = wagers.find((item) => item.wagerId === joinId);
      if (!wager) throw new Error("Wager is unavailable");
      const signature = appConfig.mockChain ? undefined : await joinWagerOnChain(wager);
      await api(`/wagers/${joinId}/accept`, { method: "POST", body: JSON.stringify({ opponent: walletAddress, signature }) });
      await refreshWagers();
      notice("Wager accepted");
    }
    if (server) {
      if (connectGame === "QUAKE3") {
        window.open(`http://${server}`, "_blank", "noopener,noreferrer");
      } else {
        window.location.href = `steam://connect/${server}`;
      }
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

document.querySelectorAll<HTMLButtonElement>("[data-game]").forEach((button) => {
  button.addEventListener("click", async () => {
    selectedGame = button.dataset.game as Game;
    document.querySelectorAll<HTMLButtonElement>("[data-game]").forEach((tile) => {
      const active = tile === button;
      tile.classList.toggle("selected", active);
      tile.setAttribute("aria-pressed", String(active));
    });
    element("game-selection-state").textContent = `${gameName(selectedGame)} selected`;
    element("selected-game-title").textContent = `${gameName(selectedGame)} dashboard`;
    element("selected-game-chip").textContent = selectedGame === "CS2" ? "CS2 // ACTIVE" : "Q3 // ACTIVE";
    element("workspace").classList.remove("hidden");
    element("workspace").classList.toggle("access-locked", !accessActive);
    element<HTMLButtonElement>("create-wager").disabled = !accessActive;
    element<HTMLButtonElement>("add-friend").disabled = !accessActive;
    try {
      await refreshWagers();
      element("workspace").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      notice(error instanceof Error ? error.message : "Unable to load arena");
    }
  });
});

const start = async () => {
  try {
    appConfig = await api<AppConfig>("/config");
  } catch (error) {
    notice(error instanceof Error ? error.message : "API unavailable");
  }
};

void start();
