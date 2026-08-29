![Bet1v1](./B1v1_Banner.jpg)

Bet1v1 is a minimal CS2 P2P wagering prototype with a Solana escrow program, a TypeScript API, a BullMQ settlement worker, a browser dapp, Postgres, Redis, and an optional modded CS2 server.

## Local prototype

Copy `.env.example` to `.env`, then run:

```sh
docker compose up --build
```

Open `http://localhost:3000`. The default `MOCK_CHAIN=true` mode lets the dapp simulate token stakes and lets the admin panel publish winner events without a Solana validator or the 60GB CS2 install. Use two Solana wallet addresses to create and accept a wager. The admin key defaults to `local-admin`.

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
- authority-only bans that slash the full access stake into a treasury token account

Build it with:

```sh
cd bet1v1-solana-program
anchor build
```

Initialize the config after deployment and set the program upgrade authority to the intended multisig. The configured authority exists inside program state; Solana's separate program upgrade authority controls binary upgrades.

To use the real chain path, set `MOCK_CHAIN=false`, set `TOKEN_MINT`, provide a funded chain authority secret as a JSON byte array or base58 string, and point `SOLANA_RPC_URL` to the deployed cluster. Rebuild the app so its Vite variables match the RPC and token decimals.

## Match settlement flow

The CS2 result contract is a Redis publication on `cs2:winners`:

```json
{"wagerId":"1","winner":"SolanaWalletAddress"}
```

The API's admin simulator validates that the winner belongs to a matched wager and publishes this event. The API subscriber creates a deduplicated BullMQ job. The worker validates the match again, signs the Anchor `settle_wager` transaction with `CHAIN_AUTHORITY_SECRET`, and records the resulting signature in Postgres.

For a real server integration, a CounterStrikeSharp match plugin should publish the same payload only after the final authoritative result. The prototype keeps this boundary mocked because the server image is large and game updates can temporarily break Metamod signatures.

## Optional Q3JS server

Q3JS is the lightweight server option for normal match testing. Its pinned image contains the ioquake3 dedicated server and the WebSocket gateway, but it does not redistribute Quake III game data. Place legally obtained `pak0.pk3` through `pak8.pk3` in `bet1v1-quake-3-js-server/baseq3`, then run:

```sh
docker compose --profile bet1v1-quake-3-js-server up bet1v1-quake-3-js-server
```

The server runs tournament mode with two slots. It exposes native Quake traffic on UDP 27960 and its WebSocket gateway and health endpoint on TCP 27961. The browser client remains separate from this repository.

## Optional CS2 server

The optional server uses [kus/cs2-modded-server](https://github.com/kus/cs2-modded-server), which already includes CounterStrikeSharp and a 1v1 arena mode. Start it only on a host with sufficient storage:

```sh
docker compose --profile cs2 up --build
```

An online server requires `STEAM_ACCOUNT` and workshop content requires `STEAM_API_KEY`. The server exposes ports 27015 and 27020 and loads the minimal configuration from `cs2/custom_files`.

The alternative [joedwards32/CS2](https://github.com/joedwards32/CS2) image is a good plain dedicated-server base, but it would require installing and maintaining CounterStrikeSharp and the 1v1 plugins separately. CounterStrikeSharp is the C# plugin layer to use when the production match-result adapter is added.
