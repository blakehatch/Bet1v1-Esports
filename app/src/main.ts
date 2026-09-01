import "./style.css";
import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import { AddressType, BrowserSDK, waitForPhantomExtension } from "@phantom/browser-sdk";
import { Buffer } from "buffer";

type InjectedPhantomProvider = {
  isPhantom?: boolean;
  isConnected?: boolean;
  publicKey?: PublicKey | null;
  request?: (request: {
    method: "connect";
    params?: { onlyIfTrusted?: boolean };
  }) => Promise<{ publicKey?: PublicKey }>;
  signMessage?: (
    message: Uint8Array,
    display?: "utf8" | "hex"
  ) => Promise<{ signature: Uint8Array }>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  signAndSendTransaction?: (transaction: Transaction) => Promise<{ signature: string }>;
};

declare global {
  interface Window {
    solana?: InjectedPhantomProvider;
  }
}

type Quake3Identity = {
  playerName: string;
  playUrl: string;
  connected: boolean;
  clientNum: number | null;
};

type AppConfig = {
  programId: string;
  tokenMint: string;
  usdcMint: string;
  mockChain: boolean;
  stakingEnabled: boolean;
  serverAddress: string;
  quake3ServerAddress: string;
};

type Game = "CS2" | "QUAKE3";
type WagerAsset = "SOL" | "USDC";

type Access = {
  amount: string;
  requiredStake: string;
  banned: boolean;
  active: boolean;
};

type Account = {
  wallet: string;
  username: string | null;
};

type Wager = {
  wagerId: string;
  maker: string;
  challenger: string | null;
  opponent: string | null;
  amount: string;
  asset: WagerAsset;
  game: Game;
  status: string;
  serverAddress: string | null;
  winner: string | null;
  chainSignature?: string | null;
  createSignature?: string | null;
  joinSignature?: string | null;
  settlementSignature?: string | null;
  payoutMode: "WINNER_TAKE_ALL" | "INCREMENTAL";
  fragLimit: number;
  incrementValue: string;
  makerRemaining: string;
  opponentRemaining: string;
  makerScore: number;
  opponentScore: number;
  cashoutRequestedBy?: string | null;
  cashoutRequestedAt?: string | null;
  makerFinalBalance?: string | null;
  opponentFinalBalance?: string | null;
  createdAt: string;
  quake3Identity?: Quake3Identity;
};

const apiUrl = import.meta.env.VITE_API_URL ?? "/api";
const stakeDecimals = Number(import.meta.env.VITE_TOKEN_DECIMALS ?? 9);
const assetDecimals = (asset: WagerAsset) => asset === "SOL" ? 9 : 6;
const connection = new Connection(import.meta.env.VITE_SOLANA_RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
const phantom = new BrowserSDK({
  providers: ["injected"],
  addressTypes: [AddressType.solana]
});
const tokenProgramId = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const associatedTokenProgramId = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
let walletAddress = "";
let appConfig: AppConfig;
let selectedGame: Game | null = null;
let accessActive = false;
let authToken = "";
let injectedPhantom: InjectedPhantomProvider | null = null;
let solUsdPrice: number | null = null;
let accountUsername = "";
let usernameSetupPending = false;
const quake3Identities = new Map<string, Quake3Identity>();

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
      <div class="wallet-summary">
        <span class="wallet" id="wallet">WALLET DISCONNECTED</span>
        <span class="wallet-balance" id="wallet-balances">SOL -- · USDC --</span>
      </div>
      <button class="secondary compact account-button hidden" id="account-settings" type="button">ACCOUNT <span id="account-name"></span></button>
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
        <p id="hero-tagline">Choose your arena. Challenge a rival.</p>
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

    <section class="access-panel card hidden" id="access-panel">
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
      <article class="card stack wager-form">
        <div class="card-heading"><span class="card-icon">◇</span><div><small>ON-CHAIN ESCROW</small><h3>New wager</h3></div></div>
        <div class="form-block">
          <div class="field-heading"><span>WAGER ASSET</span><small>ESCROW CURRENCY</small></div>
          <div class="choice-grid asset-choices" role="radiogroup" aria-label="Wager asset">
            <label class="choice-card">
              <input type="radio" name="wager-asset" value="SOL" checked />
              <span class="choice-symbol sol-symbol">◎</span>
              <span><strong>SOL</strong><small>Native Solana</small></span>
            </label>
            <label class="choice-card">
              <input type="radio" name="wager-asset" value="USDC" />
              <span class="choice-symbol usdc-symbol">$</span>
              <span><strong>USDC</strong><small>Stable test token</small></span>
            </label>
          </div>
        </div>
        <div class="form-block">
          <div class="field-heading"><label for="wager-amount">WAGER PER PLAYER</label><small id="wager-unit">SOL</small></div>
          <input id="wager-amount" type="number" min="0" step="0.000000001" value="0.1" aria-label="Wager amount" />
          <p class="field-hint" id="wager-usd-estimate">Loading SOL price…</p>
        </div>
        <div class="form-block">
          <div class="field-heading"><span>PAYOUT STRUCTURE</span><small>HOW THE POT MOVES</small></div>
          <div class="choice-grid payout-choices" role="radiogroup" aria-label="Payout mode">
            <label class="choice-card payout-card">
              <input type="radio" name="payout-mode" value="WINNER_TAKE_ALL" checked />
              <span><strong>Winner takes all</strong><small>Entire match pot settles once</small></span>
              <b>FULL POT</b>
            </label>
            <label class="choice-card payout-card" id="incremental-choice">
              <input id="incremental-mode" type="radio" name="payout-mode" value="INCREMENTAL" />
              <span><strong>Per scoring event</strong><small>Balance moves live as points land</small></span>
              <b>Q3 LIVE</b>
            </label>
          </div>
          <p class="mode-help" id="payout-help">Choose Quake III to unlock live per-score payouts in SOL or USDC.</p>
        </div>
        <div class="conditional-fields" id="frag-limit-fields">
          <div class="field-heading"><label for="frag-limit">MATCH FRAG LIMIT</label><small>Q3 SERVER: 10</small></div>
          <input id="frag-limit" type="number" min="1" max="100" step="1" value="10" aria-label="Quake frag limit" />
        </div>
        <div class="conditional-fields hidden" id="increment-fields">
          <div class="field-heading"><label for="increment-value">PAYOUT PER SCORING EVENT</label><small id="increment-unit">USDC</small></div>
          <input id="increment-value" type="number" min="0" step="0.000001" value="0.005" aria-label="Incremental payout amount" disabled />
          <p class="field-hint">Each verified score transfers this amount from the opponent's remaining escrow.</p>
        </div>
        <div class="form-block">
          <div class="field-heading"><label for="challenger">OPPONENT</label><small>OPTIONAL</small></div>
          <input id="challenger" placeholder="Friend wallet or blank for an open challenge" aria-label="Challenger wallet" />
        </div>
        <button id="create-wager" disabled>CREATE CHALLENGE</button>
      </article>
    </section>
    <section class="grid section-space">
      <article class="card">
        <div class="row between"><div class="card-heading"><span class="live-dot"></span><div><small>LIVE BOARD</small><h3>Open challenges</h3></div></div><button class="secondary compact" id="refresh">REFRESH</button></div>
        <div id="open-wagers"><span class="empty">No open wagers.</span></div>
      </article>
      <article class="card">
        <div class="row between match-card-heading">
          <div class="card-heading"><span class="card-icon">×</span><div><small>PLAYER RECORD</small><h3>Your challenges</h3></div></div>
          <button class="secondary compact" id="toggle-history" type="button">HISTORY <span id="history-count">0</span></button>
        </div>
        <div id="my-wagers"><span class="empty">Connect a wallet.</span></div>
        <div id="challenge-history" class="history-panel hidden">
          <div class="history-heading"><strong>CHALLENGE HISTORY</strong><span>Older challenges</span></div>
          <div id="history-wagers"><span class="empty">No challenge history.</span></div>
        </div>
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
  <div id="username-modal" class="account-modal hidden" role="dialog" aria-modal="true" aria-labelledby="username-title">
    <form id="username-form" class="account-dialog">
      <div class="section-kicker" id="username-kicker">PLAYER IDENTITY</div>
      <h2 id="username-title">Choose your game name</h2>
      <p>This name is tied to your wallet and used inside Quake and payout messages. You can change it later; active matches keep their current identity.</p>
      <label for="username-input">USERNAME</label>
      <input id="username-input" minlength="3" maxlength="16" autocomplete="nickname" placeholder="RocketQueen" required />
      <small>3–16 characters · letters, numbers, underscores, or hyphens</small>
      <p class="username-error hidden" id="username-error"></p>
      <div class="row username-actions">
        <button id="save-username" type="submit">SAVE USERNAME</button>
        <button class="secondary" id="cancel-username" type="button">CANCEL</button>
      </div>
    </form>
  </div>
`;

const element = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
let noticeTimer = 0;
const notice = (message: string, signature?: string, duration = 5_000) => {
  const item = element<HTMLDivElement>("notice");
  window.clearTimeout(noticeTimer);
  const copy = document.createElement("span");
  copy.textContent = message;
  item.replaceChildren(copy);
  if (signature) {
    const link = document.createElement("a");
    link.href = `https://solscan.io/tx/${signature}?cluster=devnet`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "VIEW ON SOLSCAN ↗";
    item.append(link);
  }
  item.classList.remove("hidden");
  noticeTimer = window.setTimeout(() => item.classList.add("hidden"), duration);
};

const showUsernameSettings = (required: boolean) => {
  usernameSetupPending = required;
  element("username-kicker").textContent = required ? "ONE-TIME PLAYER SETUP" : "ACCOUNT SETTINGS";
  element("username-title").textContent = required ? "Choose your game name" : "Change your game name";
  element<HTMLInputElement>("username-input").value = accountUsername;
  element("username-error").classList.add("hidden");
  element<HTMLButtonElement>("cancel-username").classList.toggle("hidden", required);
  element("username-modal").classList.remove("hidden");
  window.setTimeout(() => element<HTMLInputElement>("username-input").focus(), 0);
};

const hideUsernameSettings = () => {
  if (usernameSetupPending) return;
  element("username-modal").classList.add("hidden");
};

const api = async <T>(path: string, init?: RequestInit) => {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...init?.headers
    }
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? "Request failed");
  }
  return body;
};

const rawAmount = (value: string, decimals: number) => {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0").slice(0, decimals) || "0");
};

const checkedValue = <T extends string>(name: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)!.value as T;

const displayAmount = (value: string, decimals: number) => {
  const unit = 10 ** decimals;
  return (Number(value) / unit).toLocaleString(undefined, { maximumFractionDigits: decimals });
};

const solUsdEstimate = (lamports: bigint) => solUsdPrice
  ? ` (~$${(Number(lamports) / 1_000_000_000 * solUsdPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`
  : "";

const liveWagerBalances = (wager: Wager) => {
  const bankroll = BigInt(wager.amount);
  if (wager.status === "CASHED_OUT" && wager.makerFinalBalance != null && wager.opponentFinalBalance != null) {
    return {
      maker: BigInt(wager.makerFinalBalance),
      opponent: BigInt(wager.opponentFinalBalance)
    };
  }
  if (wager.status === "SETTLED" && wager.winner) {
    return wager.winner === wager.maker
      ? { maker: bankroll * 2n, opponent: 0n }
      : { maker: 0n, opponent: bankroll * 2n };
  }
  if (!["MATCHED", "SETTLING"].includes(wager.status)) return null;
  const makerRemaining = BigInt(wager.makerRemaining);
  const opponentRemaining = BigInt(wager.opponentRemaining);
  return {
    maker: makerRemaining + (bankroll - opponentRemaining),
    opponent: opponentRemaining + (bankroll - makerRemaining)
  };
};

const gameName = (game: Game) => game === "CS2" ? "Counter-Strike 2" : "Quake III Arena";
const rememberIdentity = (wager: Wager) => {
  if (wager.quake3Identity) quake3Identities.set(wager.wagerId, wager.quake3Identity);
};
const loadQuake3Identity = async (wagerId: string) => {
  const identity = await api<Quake3Identity & { wagerId: string }>(
    `/wagers/${wagerId}/quake3-identity?wallet=${encodeURIComponent(walletAddress)}`
  );
  quake3Identities.set(wagerId, identity);
  return identity;
};
const playUrl = (wagerId: string) => quake3Identities.get(wagerId)?.playUrl;

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

const walletError = (error: unknown, fallback: string) => {
  if (typeof error === "object" && error !== null) {
    const issue = error as { code?: number; message?: string };
    if (issue.code === 4001) return "The request was cancelled in Phantom.";
    if (issue.message) return issue.message;
  }
  return fallback;
};

const connectPhantom = async () => {
  await waitForPhantomExtension(3_000);
  const injected = (window.phantom?.solana as InjectedPhantomProvider | undefined) ?? window.solana;
  let injectedFailure = "";
  if (injected?.isPhantom) {
    if (injected.publicKey) {
      injectedPhantom = injected;
      return injected.publicKey;
    }
    if (injected.request) {
      try {
        const result = await injected.request({ method: "connect" });
        const publicKey = result.publicKey ?? injected.publicKey;
        if (!publicKey) throw new Error("Phantom returned no Solana account");
        injectedPhantom = injected;
        return publicKey;
      } catch (requestError) {
        injectedFailure = walletError(requestError, "unknown injected-provider error");
        // Arc occasionally fails the injected JSON-RPC bridge. The Browser SDK
        // uses Wallet Standard discovery and remains a useful second path.
        console.warn("Phantom JSON-RPC connection failed; trying Wallet Standard", requestError);
      }
    }
  }
  try {
    await phantom.discoverWallets();
    const result = await phantom.connect({ provider: "injected" });
    const address = result.addresses.find((candidate) => {
      try {
        new PublicKey(candidate.address);
        return true;
      } catch {
        return false;
      }
    })?.address ?? phantom.solana.publicKey;
    if (!address) {
      throw new Error("Phantom connected without an active Solana account");
    }
    return new PublicKey(address);
  } catch (error) {
    const sdkFailure = walletError(error, "unknown Wallet Standard error");
    const detail = injectedFailure
      ? `Injected provider: ${injectedFailure}; Wallet Standard: ${sdkFailure}`
      : sdkFailure;
    throw new Error(
      `Phantom could not authorize this site: ${detail}. ` +
      "Open Phantom, unlock it, select a Solana account, and try again."
    );
  }
};

const authenticate = async () => {
  const challenge = await api<{ nonce: string; message: string }>(`/auth/challenge/${walletAddress}`);
  const encoded = new TextEncoder().encode(challenge.message);
  const signed = injectedPhantom?.signMessage
    ? await injectedPhantom.signMessage(encoded, "utf8")
    : await phantom.solana.signMessage(encoded);
  const session = await api<{ token: string }>("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ wallet: walletAddress, nonce: challenge.nonce, signature: Array.from(signed.signature) })
  });
  authToken = session.token;
};

const send = async (instruction: TransactionInstruction) => {
  const publicKey = await connectPhantom();
  const transaction = new Transaction().add(instruction);
  transaction.feePayer = publicKey;
  const latest = await connection.getLatestBlockhash();
  transaction.recentBlockhash = latest.blockhash;
  // Phantom's active network can differ from the app's network. Ask the wallet
  // only to sign, then submit through this app's explicitly configured RPC.
  const signed = injectedPhantom?.signTransaction
    ? await injectedPhantom.signTransaction(transaction)
    : await phantom.solana.signTransaction(transaction) as Transaction;
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed"
  });
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  return signature;
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
  const reservedFor = wager.opponent ?? wager.challenger;
  const challenger = reservedFor ? new PublicKey(reservedFor) : PublicKey.default;
  const programId = new PublicKey(appConfig.programId);
  const mint = new PublicKey(appConfig.usdcMint);
  const id = u64(BigInt(wager.wagerId));
  if (wager.asset === "SOL") {
    return send(new TransactionInstruction({
      programId,
      data: await instructionData("create_sol_wager", [
        id,
        challenger.toBytes(),
        u64(BigInt(wager.amount)),
        Uint8Array.of(wager.payoutMode === "INCREMENTAL" ? 1 : 0),
        u64(BigInt(wager.incrementValue))
      ]),
      keys: [
        { pubkey: pda([new TextEncoder().encode("config")], programId), isSigner: false, isWritable: false },
        { pubkey: pda([new TextEncoder().encode("stake"), maker.toBytes()], programId), isSigner: false, isWritable: true },
        { pubkey: pda([new TextEncoder().encode("wager"), id], programId), isSigner: false, isWritable: true },
        { pubkey: maker, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ]
    }));
  }
  return send(new TransactionInstruction({
    programId,
    data: await instructionData("create_wager", [
      id,
      challenger.toBytes(),
      u64(BigInt(wager.amount)),
      Uint8Array.of(wager.payoutMode === "INCREMENTAL" ? 1 : 0),
      u64(BigInt(wager.incrementValue))
    ]),
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
  const mint = new PublicKey(appConfig.usdcMint);
  const id = u64(BigInt(wager.wagerId));
  if (wager.asset === "SOL") {
    return send(new TransactionInstruction({
      programId,
      data: await instructionData("join_sol_wager"),
      keys: [
        { pubkey: pda([new TextEncoder().encode("config")], programId), isSigner: false, isWritable: false },
        { pubkey: pda([new TextEncoder().encode("stake"), opponent.toBytes()], programId), isSigner: false, isWritable: true },
        { pubkey: pda([new TextEncoder().encode("wager"), id], programId), isSigner: false, isWritable: true },
        { pubkey: opponent, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ]
    }));
  }
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
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ]
  }));
};

const cancelWagerOnChain = async (wager: Wager) => {
  const maker = new PublicKey(walletAddress);
  const programId = new PublicKey(appConfig.programId);
  const mint = new PublicKey(appConfig.usdcMint);
  const id = u64(BigInt(wager.wagerId));
  if (wager.asset === "SOL") {
    return send(new TransactionInstruction({
      programId,
      data: await instructionData("cancel_sol_wager"),
      keys: [
        { pubkey: pda([new TextEncoder().encode("config")], programId), isSigner: false, isWritable: false },
        { pubkey: pda([new TextEncoder().encode("stake"), maker.toBytes()], programId), isSigner: false, isWritable: true },
        { pubkey: pda([new TextEncoder().encode("wager"), id], programId), isSigner: false, isWritable: true },
        { pubkey: maker, isSigner: true, isWritable: true }
      ]
    }));
  }
  return send(new TransactionInstruction({
    programId,
    data: await instructionData("cancel_wager"),
    keys: [
      { pubkey: pda([new TextEncoder().encode("config")], programId), isSigner: false, isWritable: false },
      { pubkey: pda([new TextEncoder().encode("stake"), maker.toBytes()], programId), isSigner: false, isWritable: true },
      { pubkey: pda([new TextEncoder().encode("wager"), id], programId), isSigner: false, isWritable: true },
      { pubkey: pda([new TextEncoder().encode("wager_vault"), id], programId), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: associatedTokenAddress(mint, maker), isSigner: false, isWritable: true },
      { pubkey: maker, isSigner: true, isWritable: true },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false }
    ]
  }));
};

const shortWallet = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
const transactionLink = (signature: string | null | undefined, label: string) => signature
  ? `<a class="tx-link" href="https://solscan.io/tx/${signature}?cluster=devnet" target="_blank" rel="noopener noreferrer">${label} ↗</a>`
  : "";
const wagerActions = (wager: Wager) => {
  if (wager.status === "OPEN" && wager.maker !== walletAddress
      && (!wager.challenger || wager.challenger === walletAddress)) {
    const acceptAction = wager.createSignature ? "data-join" : "data-accept-intent";
    return `<div class="wager-actions"><button ${acceptAction}="${wager.wagerId}">ACCEPT</button>${wager.challenger === walletAddress && !wager.createSignature ? `<button class="secondary decline" data-decline="${wager.wagerId}">DECLINE</button>` : ""}</div>`;
  }
  if (wager.status === "OPEN" && wager.maker === walletAddress && wager.createSignature) {
    return `<button class="secondary decline" data-cancel="${wager.wagerId}">CANCEL & REFUND</button>`;
  }
  if (wager.status === "ACCEPTED" && wager.maker === walletAddress) {
    return `<button data-fund-maker="${wager.wagerId}">FUND ESCROW</button>`;
  }
  if (wager.status === "ACCEPTED" && wager.opponent === walletAddress) {
    return `<span class="action-state">ACCEPTED · WAITING FOR MAKER TO FUND</span>`;
  }
  if (wager.status === "MAKER_FUNDED" && wager.opponent === walletAddress) {
    return `<button data-join="${wager.wagerId}">FUND & START MATCH</button>`;
  }
  if (wager.status === "MAKER_FUNDED" && wager.maker === walletAddress) {
    return `<div class="stack"><span class="action-state">ESCROW FUNDED · WAITING FOR OPPONENT</span><button class="secondary decline" data-cancel="${wager.wagerId}">CANCEL & REFUND</button></div>`;
  }
  if (wager.status === "MATCHED" && wager.serverAddress) {
    const play = wager.game === "QUAKE3"
      ? `<button data-q3-wager="${wager.wagerId}" ${playUrl(wager.wagerId) ? "" : "disabled"}>PLAY QUAKE III</button>`
      : `<button data-connect="${wager.serverAddress}" data-connect-game="${wager.game}">CONNECT TO CS2</button>`;
    if (wager.payoutMode !== "INCREMENTAL") return play;
    const cashOut = !wager.cashoutRequestedBy
      ? `<button class="secondary cashout" data-cashout="${wager.wagerId}">REQUEST CASH OUT</button>`
      : wager.cashoutRequestedBy === walletAddress
        ? `<button class="secondary cashout" data-cancel-cashout="${wager.wagerId}">CANCEL CASH OUT REQUEST</button>`
        : `<button class="cashout" data-cashout="${wager.wagerId}">ACCEPT CASH OUT</button>`;
    const requestState = wager.cashoutRequestedBy
      ? `<span class="action-state">${wager.cashoutRequestedBy === walletAddress ? "WAITING FOR OPPONENT APPROVAL" : "OPPONENT REQUESTED A CASH OUT"}</span>`
      : "";
    return `<div class="stack">${play}${requestState}${cashOut}</div>`;
  }
  if (wager.status === "CASHING_OUT") {
    return `<span class="action-state">CASH OUT APPROVED · RETURNING BOTH BALANCES</span>`;
  }
  return "";
};

const renderWager = (wager: Wager, action = "", history = false) => {
  const identity = quake3Identities.get(wager.wagerId);
  const amount = displayAmount(wager.amount, assetDecimals(wager.asset));
  const decimals = assetDecimals(wager.asset);
  const payoutRaw = wager.payoutMode === "INCREMENTAL"
    ? BigInt(wager.incrementValue)
    : BigInt(wager.amount) * 2n;
  const payoutEstimate = wager.asset === "SOL" ? solUsdEstimate(payoutRaw) : "";
  const payout = wager.payoutMode === "INCREMENTAL"
    ? `${displayAmount(wager.incrementValue, decimals)} ${wager.asset}${payoutEstimate} / SCORE`
    : `${displayAmount(payoutRaw.toString(), decimals)} ${wager.asset}${payoutEstimate} POT`;
  const liveBalances = liveWagerBalances(wager);
  const balanceText = liveBalances
    ? `${displayAmount(liveBalances.maker.toString(), decimals)} ${wager.asset} VS ${displayAmount(liveBalances.opponent.toString(), decimals)} ${wager.asset}`
    : `${displayAmount(wager.makerRemaining, decimals)} ${wager.asset} — ${displayAmount(wager.opponentRemaining, decimals)} ${wager.asset}`;
  const opponent = wager.opponent ?? wager.challenger;
  const txLinks = [
    transactionLink(wager.createSignature, "CHALLENGE TX"),
    transactionLink(wager.joinSignature, "JOIN TX"),
    transactionLink(
      wager.settlementSignature,
      wager.status === "DECLINED" ? "REFUND TX" : wager.status === "CASHED_OUT" ? "CASH OUT TX" : "SETTLEMENT TX"
    ),
    !wager.createSignature && !wager.joinSignature && !wager.settlementSignature
      ? transactionLink(wager.chainSignature, "LATEST TX") : ""
  ].filter(Boolean).join("");
  return `
    <article class="wager ${history ? "wager-history" : ""}" data-status="${wager.status}">
      <header class="wager-header">
        <div><small>CHALLENGE #${wager.wagerId}</small><strong>${amount} ${wager.asset} <em>PER PLAYER</em></strong></div>
        <span class="pill status-pill">${wager.status}</span>
      </header>
      <div class="wager-tags"><span>${wager.game === "CS2" ? "CS2" : "QUAKE III"}</span><span>${wager.payoutMode === "INCREMENTAL" ? "PER SCORE" : "WINNER TAKES ALL"}</span></div>
      <div class="wager-detail-grid">
        <div><small>PAYOUT</small><strong>${payout}</strong></div>
        <div><small>${wager.payoutMode === "INCREMENTAL" ? (liveBalances ? "LIVE BALANCE" : "ESCROW") : "MATCH RULE"}</small><strong>${wager.payoutMode === "INCREMENTAL" ? balanceText : `FRAGLIMIT ${wager.fragLimit}`}</strong></div>
        ${wager.game === "QUAKE3" && wager.status !== "OPEN" ? `<div><small>SCORE</small><strong>${wager.makerScore} — ${wager.opponentScore}</strong></div>` : ""}
      </div>
      <div class="participants"><span>${wager.maker === walletAddress ? "YOU" : shortWallet(wager.maker)}</span><b>VS</b><span>${opponent ? (opponent === walletAddress ? "YOU" : shortWallet(opponent)) : "OPEN"}</span></div>
      ${identity ? `<div class="identity-state"><i class="${identity.connected ? "connected" : ""}"></i><span>${identity.playerName}</span><b>${identity.connected ? "SERVER LINKED" : "WAITING FOR GAME"}</b></div>` : ""}
      ${wager.winner ? `<div class="winner-line">WINNER <strong>${wager.winner === walletAddress ? "YOU" : shortWallet(wager.winner)}</strong></div>` : ""}
      ${txLinks ? `<nav class="transaction-links" aria-label="Challenge transactions">${txLinks}</nav>` : ""}
      ${action}
    </article>
  `;
};

const refreshAccess = async () => {
  if (!walletAddress) return;
  const access = await api<Access>(`/access/${walletAddress}`);
  accessActive = access.active && !access.banned;
  element("access-status").textContent = access.banned
    ? "BANNED"
    : appConfig.stakingEnabled
      ? access.active ? "ACTIVE" : "LOCKED"
      : "OPEN";
  element("stake-copy").textContent = appConfig.stakingEnabled
    ? `${displayAmount(access.amount, stakeDecimals)} staked · ${displayAmount(access.requiredStake, stakeDecimals)} required`
    : "Token staking is disabled. Wallet access is open.";
  element<HTMLButtonElement>("stake").disabled = access.banned || !appConfig.stakingEnabled;
  element<HTMLButtonElement>("create-wager").disabled = !accessActive || !selectedGame;
  element<HTMLButtonElement>("add-friend").disabled = !accessActive;
  element("workspace").classList.toggle("access-locked", !accessActive);
};

const refreshFriends = async () => {
  if (!walletAddress) return;
  const friends = await api<{ wallet: string; username: string | null }[]>(`/friends/${walletAddress}`);
  element("friends").innerHTML = friends.length
    ? friends.map((friend) => `
        <button class="friend-entry" type="button" data-challenge-wallet="${friend.wallet}">
          <span class="friend-identity"><strong>${friend.username ?? shortWallet(friend.wallet)}</strong><small class="wallet">${friend.wallet}</small></span><b>CHALLENGE →</b>
        </button>
      `).join("")
    : `<span class="empty">No friends yet.</span>`;
};

const refreshBalances = async () => {
  if (!walletAddress) return;
  if (appConfig.mockChain) {
    element("wallet-balances").textContent = "MOCK CHAIN BALANCES";
    return;
  }
  try {
    const owner = new PublicKey(walletAddress);
    const usdcAccount = associatedTokenAddress(new PublicKey(appConfig.usdcMint), owner);
    const [lamports, usdc] = await Promise.all([
      connection.getBalance(owner, "confirmed"),
      connection.getTokenAccountBalance(usdcAccount, "confirmed")
        .then((balance) => balance.value.amount)
        .catch(() => "0")
    ]);
    element("wallet-balances").textContent = `${displayAmount(String(lamports), 9)} SOL · ${displayAmount(usdc, 6)} USDC`;
  } catch {
    element("wallet-balances").textContent = "BALANCE TEMPORARILY UNAVAILABLE";
  }
};

const refreshWagers = async () => {
  if (!selectedGame) return;
  const gameQuery = `game=${selectedGame}`;
  const open = await api<Wager[]>(`/wagers?status=OPEN&${gameQuery}`);
  const visibleOpen = open
    .filter((wager) => !wager.challenger || wager.challenger === walletAddress || wager.maker === walletAddress)
    .slice(0, 3);
  element("open-wagers").innerHTML = visibleOpen.length
    ? visibleOpen.map((wager) => renderWager(wager, wagerActions(wager))).join("")
    : `<span class="empty">No open wagers.</span>`;
  const mine = walletAddress ? await api<Wager[]>(`/wagers?wallet=${walletAddress}&${gameQuery}`) : [];
  if (selectedGame === "QUAKE3") {
    await Promise.all(mine
      .filter((wager) => ["ACCEPTED", "MAKER_FUNDED", "MATCHED"].includes(wager.status))
      .map((wager) => loadQuake3Identity(wager.wagerId).catch(() => undefined)));
  }
  const recent = mine.slice(0, 3);
  const history = mine.slice(3);
  element("my-wagers").innerHTML = recent.length
    ? recent.map((wager) => renderWager(wager, wagerActions(wager))).join("")
    : `<span class="empty">No recent challenges.</span>`;
  element("history-count").textContent = String(history.length);
  element("history-wagers").innerHTML = history.length
    ? history.map((wager) => renderWager(wager, "", true)).join("")
    : `<span class="empty">No challenge history.</span>`;
  const matched = await api<Wager[]>(`/wagers?status=MATCHED&${gameQuery}`);
  element("admin-wagers").innerHTML = matched.length
    ? matched.map((wager) => renderWager(wager, `<div class="row"><button data-winner-id="${wager.wagerId}" data-winner="${wager.maker}">Maker won</button><button class="secondary" data-winner-id="${wager.wagerId}" data-winner="${wager.opponent}">Opponent won</button></div>`)).join("")
    : `<span class="empty">No matched wagers.</span>`;
};

const finishWalletConnection = async () => {
  accessActive = !appConfig.stakingEnabled;
  const refreshes = await Promise.allSettled([
    refreshAccess(),
    refreshFriends(),
    refreshWagers(),
    refreshBalances()
  ]);
  const partialFailure = refreshes.some((result) => result.status === "rejected");
  notice(partialFailure ? "Wallet connected; some live data is still loading." : `Connected as ${accountUsername}.`);
};

element("connect").addEventListener("click", async () => {
  try {
    const publicKey = await connectPhantom();
    walletAddress = publicKey.toBase58();
    await authenticate();
    element("wallet").textContent = walletAddress;
    element("connect").textContent = "PHANTOM CONNECTED";
    const account = await api<Account>(`/account/${walletAddress}`);
    accountUsername = account.username ?? "";
    element("account-name").textContent = accountUsername;
    element("account-settings").classList.remove("hidden");
    if (!accountUsername) {
      showUsernameSettings(true);
      return;
    }
    await finishWalletConnection();
  } catch (error) {
    notice(walletError(error, "Phantom connection failed"));
  }
});

element("account-settings").addEventListener("click", () => showUsernameSettings(false));
element("cancel-username").addEventListener("click", hideUsernameSettings);
element<HTMLFormElement>("username-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const save = element<HTMLButtonElement>("save-username");
  const errorLine = element("username-error");
  try {
    save.disabled = true;
    save.textContent = "SAVING…";
    errorLine.classList.add("hidden");
    const account = await api<Account>(`/account/${walletAddress}/username`, {
      method: "PUT",
      body: JSON.stringify({ username: element<HTMLInputElement>("username-input").value })
    });
    accountUsername = account.username ?? "";
    element("account-name").textContent = accountUsername;
    const completeSetup = usernameSetupPending;
    usernameSetupPending = false;
    element("username-modal").classList.add("hidden");
    if (completeSetup) await finishWalletConnection();
    else {
      await refreshWagers();
      notice(`Username changed to ${accountUsername}. Pending matches were updated.`);
    }
  } catch (error) {
    errorLine.textContent = error instanceof Error ? error.message : "Unable to save username";
    errorLine.classList.remove("hidden");
  } finally {
    save.disabled = false;
    save.textContent = "SAVE USERNAME";
  }
});

element("stake").addEventListener("click", async () => {
  try {
    if (!appConfig.stakingEnabled) throw new Error("Staking is disabled");
    const amount = rawAmount(element<HTMLInputElement>("stake-amount").value, stakeDecimals);
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
  const button = element<HTMLButtonElement>("add-friend");
  try {
    const friend = element<HTMLInputElement>("friend-wallet").value.trim();
    if (!friend) throw new Error("Enter the other player's wallet address");
    new PublicKey(friend);
    button.disabled = true;
    button.textContent = "ADDING…";
    await api("/friends", { method: "POST", body: JSON.stringify({ owner: walletAddress, friend }) });
    element<HTMLInputElement>("friend-wallet").value = "";
    await refreshFriends();
    notice("Friend added");
  } catch (error) {
    notice(error instanceof Error ? error.message : "Friend request failed");
  } finally {
    button.textContent = "ADD";
    button.disabled = !accessActive;
  }
});

element("create-wager").addEventListener("click", async () => {
  try {
    if (!selectedGame) throw new Error("Select a game first");
    const challenger = element<HTMLInputElement>("challenger").value.trim() || null;
    const asset = checkedValue<WagerAsset>("wager-asset");
    const amount = rawAmount(element<HTMLInputElement>("wager-amount").value, assetDecimals(asset)).toString();
    const payoutMode = checkedValue<Wager["payoutMode"]>("payout-mode");
    const incrementValue = payoutMode === "INCREMENTAL"
      ? rawAmount(element<HTMLInputElement>("increment-value").value, assetDecimals(asset)).toString()
      : "0";
    const fragLimit = Number(element<HTMLInputElement>("frag-limit").value);
    const wager = await api<Wager>("/wagers", {
      method: "POST",
      body: JSON.stringify({ maker: walletAddress, challenger, amount, asset, game: selectedGame, payoutMode, incrementValue, fragLimit })
    });
    rememberIdentity(wager);
    await refreshWagers();
    notice(`Challenge #${wager.wagerId} sent. No funds move on-chain until another player accepts.`);
  } catch (error) {
    notice(error instanceof Error ? error.message : "Wager creation failed");
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const joinId = target.closest<HTMLElement>("[data-join]")?.dataset.join;
  const acceptIntentId = target.closest<HTMLElement>("[data-accept-intent]")?.dataset.acceptIntent;
  const fundMakerId = target.closest<HTMLElement>("[data-fund-maker]")?.dataset.fundMaker;
  const declineId = target.closest<HTMLElement>("[data-decline]")?.dataset.decline;
  const cancelId = target.closest<HTMLElement>("[data-cancel]")?.dataset.cancel;
  const cashoutId = target.closest<HTMLElement>("[data-cashout]")?.dataset.cashout;
  const cancelCashoutId = target.closest<HTMLElement>("[data-cancel-cashout]")?.dataset.cancelCashout;
  const server = target.dataset.connect;
  const connectGame = target.dataset.connectGame as Game | undefined;
  const q3WagerId = target.dataset.q3Wager;
  const winnerId = target.dataset.winnerId;
  const challengeWallet = target.closest<HTMLElement>("[data-challenge-wallet]")?.dataset.challengeWallet;
  try {
    if (challengeWallet) {
      element<HTMLInputElement>("challenger").value = challengeWallet;
      notice("Opponent selected for the next challenge");
    }
    if (acceptIntentId) {
      const accepted = await api<Wager>(`/wagers/${acceptIntentId}/accept-intent`, {
        method: "POST",
        body: JSON.stringify({ opponent: walletAddress })
      });
      rememberIdentity(accepted);
      await refreshWagers();
      notice(`Challenge #${acceptIntentId} accepted. No money has moved yet; the maker can now fund the escrow.`);
    }
    if (fundMakerId) {
      const wagers = await api<Wager[]>(`/wagers?wallet=${walletAddress}&game=${selectedGame}`);
      const wager = wagers.find((item) => item.wagerId === fundMakerId);
      if (!wager || wager.status !== "ACCEPTED") throw new Error("Challenge is not ready for funding");
      const signature = appConfig.mockChain ? `mock-maker-fund-${fundMakerId}` : await createWagerOnChain(wager);
      await api(`/wagers/${fundMakerId}/chain`, {
        method: "POST",
        body: JSON.stringify({ maker: walletAddress, signature })
      });
      await Promise.all([refreshWagers(), refreshBalances()]);
      notice(`Challenge #${fundMakerId} maker escrow funded.`, appConfig.mockChain ? undefined : signature);
    }
    if (joinId) {
      const wagers = await api<Wager[]>(`/wagers?wallet=${walletAddress}&game=${selectedGame}`);
      const wager = wagers.find((item) => item.wagerId === joinId);
      if (!wager || (wager.status !== "MAKER_FUNDED" && !(wager.status === "OPEN" && wager.createSignature))) {
        throw new Error("Challenge is no longer ready to start");
      }
      const signature = appConfig.mockChain ? undefined : await joinWagerOnChain(wager);
      const accepted = await api<Wager>(`/wagers/${joinId}/accept`, { method: "POST", body: JSON.stringify({ opponent: walletAddress, signature }) });
      rememberIdentity(accepted);
      await Promise.all([refreshWagers(), refreshBalances()]);
      notice(`Challenge #${joinId} accepted and funded on Solana devnet.`, signature);
    }
    if (declineId) {
      await api(`/wagers/${declineId}/decline`, {
        method: "POST",
        body: JSON.stringify({ challenger: walletAddress })
      });
      await refreshWagers();
      notice(`Challenge #${declineId} declined. No funds had moved on-chain.`);
    }
    if (cancelId) {
      const wagers = await api<Wager[]>(`/wagers?wallet=${walletAddress}&game=${selectedGame}`);
      const wager = wagers.find((item) => item.wagerId === cancelId);
      if (!wager) throw new Error("Challenge is unavailable");
      const signature = appConfig.mockChain ? `mock-cancel-${cancelId}` : await cancelWagerOnChain(wager);
      await api(`/wagers/${cancelId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ maker: walletAddress, signature })
      });
      await Promise.all([refreshWagers(), refreshBalances()]);
      notice(`Challenge #${cancelId} cancelled and escrow refunded.`, appConfig.mockChain ? undefined : signature);
    }
    if (cashoutId) {
      const result = await api<{ state: "REQUESTED" | "CASHING_OUT" }>(`/wagers/${cashoutId}/cashout`, {
        method: "POST",
        body: JSON.stringify({ wallet: walletAddress })
      });
      await refreshWagers();
      notice(result.state === "CASHING_OUT"
        ? `Cash out approved for #${cashoutId}. The chain worker is returning both live balances.`
        : `Cash out requested for #${cashoutId}. The other player must approve it.`);
    }
    if (cancelCashoutId) {
      await api(`/wagers/${cancelCashoutId}/cashout/cancel`, {
        method: "POST",
        body: JSON.stringify({ wallet: walletAddress })
      });
      await refreshWagers();
      notice(`Cash-out request cancelled for #${cancelCashoutId}.`);
    }
    if (q3WagerId) {
      const url = playUrl(q3WagerId);
      if (!url) throw new Error("This browser does not hold the private Quake identity for that wager");
      window.open(url, "_blank", "noopener,noreferrer");
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
element("toggle-history").addEventListener("click", () => {
  const history = element("challenge-history");
  const open = history.classList.toggle("hidden") === false;
  element<HTMLButtonElement>("toggle-history").firstChild!.textContent = open ? "HIDE HISTORY " : "HISTORY ";
});

const updateWagerEstimate = () => {
  const asset = checkedValue<WagerAsset>("wager-asset");
  const amount = Number(element<HTMLInputElement>("wager-amount").value);
  const estimate = element("wager-usd-estimate");
  if (!Number.isFinite(amount) || amount <= 0) {
    estimate.textContent = "Enter an amount to see the per-player estimate.";
  } else if (asset === "USDC") {
    estimate.textContent = `≈ $${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD per player`;
  } else if (solUsdPrice) {
    estimate.textContent = `≈ $${(amount * solUsdPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD per player · live estimate`;
  } else {
    estimate.textContent = "SOL wager · USD estimate temporarily unavailable";
  }
};

const refreshSolPrice = async () => {
  try {
    solUsdPrice = (await api<{ usd: number }>("/prices/sol")).usd;
  } catch {
    solUsdPrice = null;
  }
  updateWagerEstimate();
};

const syncWagerControls = () => {
  const asset = checkedValue<WagerAsset>("wager-asset");
  const incrementalOption = element<HTMLInputElement>("incremental-mode");
  const winnerTakeAll = document.querySelector<HTMLInputElement>('input[name="payout-mode"][value="WINNER_TAKE_ALL"]')!;
  const incrementalSupported = selectedGame === "QUAKE3";
  incrementalOption.disabled = !incrementalSupported;
  element("incremental-choice").classList.toggle("unavailable", !incrementalSupported);
  element("incremental-choice").setAttribute("aria-disabled", String(!incrementalSupported));
  if (!incrementalSupported && incrementalOption.checked) winnerTakeAll.checked = true;
  const incremental = incrementalOption.checked;
  element<HTMLInputElement>("increment-value").disabled = !incremental;
  element("increment-fields").classList.toggle("hidden", !incremental);
  element("frag-limit-fields").classList.toggle("hidden", selectedGame !== "QUAKE3" || incremental);
  element("wager-unit").textContent = asset;
  element("increment-unit").textContent = asset;
  element("payout-help").textContent = incrementalSupported
    ? `Both payout structures are available in ${asset}. Per-score payouts update escrow and balances after every verified frag.`
    : "Per-score payouts require Quake III. This arena currently settles winner-take-all only.";
  element("payout-help").classList.toggle("available", incrementalSupported);
  const step = asset === "SOL" ? "0.000000001" : "0.000001";
  element<HTMLInputElement>("wager-amount").step = step;
  element<HTMLInputElement>("increment-value").step = step;
  updateWagerEstimate();
};

document.querySelectorAll<HTMLInputElement>('input[name="payout-mode"], input[name="wager-asset"]')
  .forEach((input) => input.addEventListener("change", syncWagerControls));
element<HTMLInputElement>("wager-amount").addEventListener("input", updateWagerEstimate);
syncWagerControls();

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
    syncWagerControls();
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
    void refreshSolPrice();
    if (appConfig.stakingEnabled) {
      element("access-panel").classList.remove("hidden");
      element("hero-tagline").textContent = "Stake $B1V1. Choose your arena. Challenge a rival.";
    }
  } catch (error) {
    notice(error instanceof Error ? error.message : "API unavailable");
  }
};

void start();

let refreshInFlight = false;
window.setInterval(() => {
  if (!walletAddress || !selectedGame || document.visibilityState !== "visible" || refreshInFlight) return;
  refreshInFlight = true;
  void Promise.all([refreshWagers(), refreshBalances()])
    .catch(() => undefined)
    .finally(() => { refreshInFlight = false; });
}, 2_500);
window.setInterval(() => void refreshSolPrice(), 5 * 60_000);
