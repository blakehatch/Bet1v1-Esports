![Bet1v1](./B1v1_Banner.jpg)

Bet1v1 is a P2P wagering prototype with a Solana escrow program, a TypeScript API, BullMQ settlement workers, a browser dapp, Postgres, Redis, and Quake III/CS2 dedicated-server integrations.

## Local prototype

Copy `.env.example` to `.env`, then run:

```sh
docker compose up --build
```

Open `http://localhost:3000`. The default `MOCK_CHAIN=true` mode lets the dapp simulate token stakes and lets the admin panel publish winner events without a Solana validator or the 60GB CS2 install. Each wallet signs a transaction-free login challenge before it can mutate wallet-owned API state. The admin key defaults to `local-admin`.

Set `APP_PORT` if port 3000 is already in use. `VITE_SOLANA_RPC_URL` is compiled into the browser bundle and must be reachable from players' browsers when `MOCK_CHAIN=false`; `SOLANA_RPC_URL` is the separate endpoint used by the API container.

Choose Counter-Strike 2 or Quake III Arena from the arena menu before entering the wager dashboard. Challenges are kept separate by game, and matched wagers receive the corresponding configured server address.

The normal stack contains:

- `app` on port 3000
- `api` behind the app at `http://localhost:3000/api`
- `worker` consuming BullMQ settlement jobs
- `postgres` on the private Compose network
- `redis` on the private Compose network

## Solana program

The Anchor program supports:

- program configuration with a general authority, rotatable chain authority, BET1V1 mint, and required stake
- staking and unstaking for access, with unstaking locked while a wager is active
- public or friend-reserved two-player wagers
- escrow funding by both players
- settlement signed only by the chain authority
- cancellation before an opponent joins
- authority or chain-authority invalidation and refunds after matching
- winner-take-all settlement and victim-funded, configurable per-kill tranches
- authority-only bans that slash the full access stake into a treasury token account

Build it with:

```sh
cd bet1v1-solana-program
anchor build
```

Initialize the config after deployment and set the program upgrade authority to the intended multisig. The configured authority exists inside program state; Solana's separate program upgrade authority controls binary upgrades.

To use the real chain path, set `MOCK_CHAIN=false`, set `TOKEN_MINT`, provide a funded chain authority secret as a JSON byte array or base58 string, and point `SOLANA_RPC_URL` to the deployed cluster. Rebuild the app so its Vite variables match the RPC and token decimals.

## Match settlement flow

The normal result contract is a Redis publication on `cs2:winners`:

```json
{"wagerId":"1","winner":"SolanaWalletAddress"}
```

The API's admin simulator validates that the winner belongs to a matched wager and publishes this event. The API subscriber creates a deduplicated BullMQ job. The worker validates the match again, signs the Anchor `settle_wager` transaction with `CHAIN_AUTHORITY_SECRET`, and records the resulting signature in Postgres.

For a real server integration, a CounterStrikeSharp match plugin should publish the same payload only after the final authoritative result. The prototype keeps this boundary mocked because the server image is large and game updates can temporarily break Metamod signatures.

## Q3JS server and automatic settlement

The pinned Q3JS image contains the ioquake3 dedicated server and WebSocket gateway, but it does not redistribute Quake III game data. Place legally obtained `pak0.pk3` through `pak8.pk3` directly in `bet1v1-quake-3-js-server/baseq3`, then run the full stack:

```sh
docker compose --profile bet1v1-quake-3-js-server up -d --build --wait
```

The server runs tournament mode with two slots, frag-only endings, and no time limit. It exposes native Quake traffic on UDP 27960 and its WebSocket gateway and health endpoint on TCP 27961. The dapp generates an opaque, private player name for each wallet/wager and opens the external Q3JS browser client with that identity.

Q3JS already posts authenticated `join`, `leave`, and `kill` callbacks; no Q3JS source modification is required. The API validates the shared secret and publishes callbacks on `quake3:events`. Its subscriber deduplicates them into the serial `game-events` BullMQ queue. Join events bind the opaque name to a Q3 client number, and kill jobs require both values to match before money can move.

Quake wagers support two payout modes:

- `WINNER_TAKE_ALL` is the default. A kill callback triggers an ioquake3 UDP `getstatus` query, and the worker settles the full pot only when the authoritative score reaches `QUAKE3_FRAG_LIMIT`.
- `PER_KILL` escrows a bankroll from each player and pays `min(killValue, victimRemaining)` from the victim's reserve on every valid player kill. For example, a 100-token bankroll with a 5-token kill value can absorb 20 deaths. When one reserve reaches zero, the survivor's unused reserve is refunded and the wager closes.

The Compose deployment intentionally permits only one active Quake wager because it runs one shared two-slot server. Horizontal match-server orchestration is required before concurrent Quake wagers are enabled. The chain authority pays one Solana fee per kill in per-kill mode.

Local Q3JS mode uses a loopback master URL, so heartbeat failures are harmless. Its local event secret has a development fallback; always replace it on a public host. Set `Q3JS_PUBLISH_HOST` to the browser-reachable host and set `Q3JS_SECURE=true` only when a valid TLS proxy serves the gateway as WSS.

## Hetzner deployment

The production overlay adds Caddy for automatic HTTPS on the dapp hostname and WSS on a separate Q3 gateway hostname. Create DNS A/AAAA records for both names, copy `.env.hetzner.example` to `.env`, replace every placeholder/secret, then run:

```sh
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.hetzner.yml \
  --profile bet1v1-quake-3-js-server up -d --build --wait
```

Allow inbound TCP 22, 80, and 443 plus UDP 443 and 27960 in the Hetzner firewall. The production example binds the raw app and Q3 gateway ports to loopback; public browser traffic goes through Caddy. Keep `.env` root-readable, never commit `CHAIN_AUTHORITY_SECRET`, and back up the Postgres, Caddy, and Q3 state volumes.

Start with `MOCK_CHAIN=true` for the host/network smoke test. Before using real funds, deploy the compiled Anchor program, initialize its config/mint/authorities, fund the chain-authority fee payer, set `MOCK_CHAIN=false`, and replace all Solana/token settings. The ignored deployment key at `bet1v1-solana-program/target/deploy/bet1v1_solana_program-keypair.json` controls the current program ID and must be backed up securely; it is not copied to Hetzner.

## Optional CS2 server

The optional server uses [kus/cs2-modded-server](https://github.com/kus/cs2-modded-server), which already includes CounterStrikeSharp and a 1v1 arena mode. Start it only on a host with sufficient storage:

```sh
docker compose --profile cs2 up --build
```

An online server requires `STEAM_ACCOUNT` and workshop content requires `STEAM_API_KEY`. The server exposes ports 27015 and 27020 and loads the minimal configuration from `cs2/custom_files`.

The alternative [joedwards32/CS2](https://github.com/joedwards32/CS2) image is a good plain dedicated-server base, but it would require installing and maintaining CounterStrikeSharp and the 1v1 plugins separately. CounterStrikeSharp is the C# plugin layer to use when the production match-result adapter is added.
