#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM_DIR="$REPO_DIR/bet1v1-solana-program"
RPC_URL="http://127.0.0.1:8899"
PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_DIR/target/deploy/bet1v1_solana_program-keypair.json")"
DEFAULT_KEYPAIR="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
CHAIN_KEYPAIR="$PROGRAM_DIR/chain-automation-keypair.json"
ACCESS_MINT_KEYPAIR="$PROGRAM_DIR/localnet-access-mint-keypair.json"
USDC_MINT_KEYPAIR="$PROGRAM_DIR/localnet-usdc-mint-keypair.json"
COMPOSE_PROJECT="bet1v1-localnet-e2e"

for command_name in anchor solana solana-keygen solana-test-validator spl-token docker curl yarn; do
  command -v "$command_name" >/dev/null || { echo "Missing required command: $command_name" >&2; exit 1; }
done
test -f "$DEFAULT_KEYPAIR" || { echo "Default Solana keypair not found: $DEFAULT_KEYPAIR" >&2; exit 1; }
test -f "$CHAIN_KEYPAIR" || { echo "Chain automation keypair not found: $CHAIN_KEYPAIR" >&2; exit 1; }
docker info >/dev/null

if ! curl -fsS --max-time 2 -X POST "$RPC_URL" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null; then
  solana-test-validator \
    --reset \
    --ledger "$PROGRAM_DIR/test-ledger" \
    --rpc-port 8899 \
    >"$PROGRAM_DIR/.anchor/localnet-validator.log" 2>&1 &
  echo "$!" >"$PROGRAM_DIR/.anchor/localnet-validator.pid"
fi

for attempt in $(seq 1 60); do
  if curl -fsS --max-time 2 -X POST "$RPC_URL" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"'; then
    break
  fi
  if [[ "$attempt" == "60" ]]; then
    echo "Local validator did not become healthy" >&2
    exit 1
  fi
  sleep 0.5
done

ADMIN_ADDRESS="$(solana-keygen pubkey "$DEFAULT_KEYPAIR")"
CHAIN_ADDRESS="$(solana-keygen pubkey "$CHAIN_KEYPAIR")"
solana airdrop 100 "$ADMIN_ADDRESS" --url "$RPC_URL" >/dev/null
solana airdrop 10 "$CHAIN_ADDRESS" --url "$RPC_URL" >/dev/null

for mint_keypair in "$ACCESS_MINT_KEYPAIR" "$USDC_MINT_KEYPAIR"; do
  if [[ ! -f "$mint_keypair" ]]; then
    solana-keygen new --no-bip39-passphrase --silent --force -o "$mint_keypair"
  fi
done
ACCESS_MINT="$(solana-keygen pubkey "$ACCESS_MINT_KEYPAIR")"
USDC_MINT="$(solana-keygen pubkey "$USDC_MINT_KEYPAIR")"

cd "$PROGRAM_DIR"
anchor build
anchor deploy --provider.cluster localnet --provider.wallet "$DEFAULT_KEYPAIR"

if ! solana account "$ACCESS_MINT" --url "$RPC_URL" >/dev/null 2>&1; then
  spl-token create-token --url "$RPC_URL" --decimals 9 "$ACCESS_MINT_KEYPAIR" >/dev/null
fi
if ! solana account "$USDC_MINT" --url "$RPC_URL" >/dev/null 2>&1; then
  spl-token create-token --url "$RPC_URL" --decimals 6 "$USDC_MINT_KEYPAIR" >/dev/null
fi

ANCHOR_PROVIDER_URL="$RPC_URL" \
ANCHOR_WALLET="$DEFAULT_KEYPAIR" \
CHAIN_AUTHORITY_KEYPAIR="$CHAIN_KEYPAIR" \
TOKEN_MINT="$ACCESS_MINT" \
USDC_MINT="$USDC_MINT" \
yarn ts-mocha -p ./tsconfig.json -t 120000 integration/initialize-localnet.ts

cd "$REPO_DIR"
PROGRAM_ID="$PROGRAM_ID" \
TOKEN_MINT="$ACCESS_MINT" \
USDC_MINT="$USDC_MINT" \
MOCK_CHAIN=false \
STAKING_ENABLED=false \
SOLANA_RPC_URL=http://host.docker.internal:8899 \
VITE_SOLANA_RPC_URL="$RPC_URL" \
docker compose -p "$COMPOSE_PROJECT" up -d --build postgres redis api worker app

for attempt in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null; then
    break
  fi
  if [[ "$attempt" == "60" ]]; then
    docker compose -p "$COMPOSE_PROJECT" logs --tail 200 api worker
    echo "Local API did not become healthy" >&2
    exit 1
  fi
  sleep 1
done

TEST_KEYPAIR_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_KEYPAIR_DIR"' EXIT
MAKER_KEYPAIR="$TEST_KEYPAIR_DIR/maker.json"
OPPONENT_KEYPAIR="$TEST_KEYPAIR_DIR/opponent.json"
solana-keygen new --no-bip39-passphrase --silent --force -o "$MAKER_KEYPAIR"
solana-keygen new --no-bip39-passphrase --silent --force -o "$OPPONENT_KEYPAIR"
solana airdrop 10 "$(solana-keygen pubkey "$MAKER_KEYPAIR")" --url "$RPC_URL" >/dev/null
solana airdrop 10 "$(solana-keygen pubkey "$OPPONENT_KEYPAIR")" --url "$RPC_URL" >/dev/null

cd "$PROGRAM_DIR"
ANCHOR_PROVIDER_URL="$RPC_URL" \
ANCHOR_WALLET="$DEFAULT_KEYPAIR" \
MAKER_KEYPAIR="$MAKER_KEYPAIR" \
OPPONENT_KEYPAIR="$OPPONENT_KEYPAIR" \
USDC_MINT="$USDC_MINT" \
API_URL=http://127.0.0.1:3000/api \
yarn ts-mocha -p ./tsconfig.json -t 120000 integration/localnet-api.ts

cd "$REPO_DIR"
solana program show "$PROGRAM_ID" --url "$RPC_URL"
docker compose -p "$COMPOSE_PROJECT" ps
docker compose -p "$COMPOSE_PROJECT" logs --tail 50 worker
