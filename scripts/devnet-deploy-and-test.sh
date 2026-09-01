#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM_DIR="$REPO_DIR/bet1v1-solana-program"
RPC_URL="${DEVNET_RPC_URL:-https://api.devnet.solana.com}"
DEFAULT_KEYPAIR="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
CHAIN_KEYPAIR="$PROGRAM_DIR/chain-automation-keypair.json"
ACCESS_MINT_KEYPAIR="$PROGRAM_DIR/devnet-access-mint-keypair.json"
USDC_MINT_KEYPAIR="$PROGRAM_DIR/devnet-usdc-mint-keypair.json"
PROGRAM_KEYPAIR="$PROGRAM_DIR/target/deploy/bet1v1_solana_program-keypair.json"
COMPOSE_PROJECT="bet1v1-devnet-e2e"
APP_PORT="${DEVNET_APP_PORT:-3003}"

for command_name in anchor solana solana-keygen spl-token docker curl yarn; do
  command -v "$command_name" >/dev/null || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done
test -f "$DEFAULT_KEYPAIR" || { echo "Default Solana keypair not found: $DEFAULT_KEYPAIR" >&2; exit 1; }
test -f "$CHAIN_KEYPAIR" || { echo "Chain automation keypair not found: $CHAIN_KEYPAIR" >&2; exit 1; }
test -f "$PROGRAM_KEYPAIR" || { echo "Program keypair not found: $PROGRAM_KEYPAIR" >&2; exit 1; }
docker info >/dev/null

ADMIN_ADDRESS="$(solana-keygen pubkey "$DEFAULT_KEYPAIR")"
CHAIN_ADDRESS="$(solana-keygen pubkey "$CHAIN_KEYPAIR")"
PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
if [[ "$ADMIN_ADDRESS" == "$CHAIN_ADDRESS" ]]; then
  echo "Admin and chain automation authorities must be different" >&2
  exit 1
fi

ADMIN_BALANCE_LAMPORTS="$(solana balance "$ADMIN_ADDRESS" --url "$RPC_URL" --lamports)"
ADMIN_BALANCE_LAMPORTS="${ADMIN_BALANCE_LAMPORTS%% *}"
if (( ADMIN_BALANCE_LAMPORTS < 5000000000 )); then
  echo "The admin wallet needs at least 5 SOL before deploying to devnet" >&2
  exit 1
fi

for mint_keypair in "$ACCESS_MINT_KEYPAIR" "$USDC_MINT_KEYPAIR"; do
  if [[ ! -f "$mint_keypair" ]]; then
    solana-keygen new --no-bip39-passphrase --silent --force -o "$mint_keypair"
  fi
done
ACCESS_MINT="$(solana-keygen pubkey "$ACCESS_MINT_KEYPAIR")"
USDC_MINT="$(solana-keygen pubkey "$USDC_MINT_KEYPAIR")"

cd "$PROGRAM_DIR"
anchor build
anchor deploy --provider.cluster "$RPC_URL" --provider.wallet "$DEFAULT_KEYPAIR"

if ! solana account "$ACCESS_MINT" --url "$RPC_URL" >/dev/null 2>&1; then
  spl-token create-token --url "$RPC_URL" --fee-payer "$DEFAULT_KEYPAIR" \
    --mint-authority "$DEFAULT_KEYPAIR" --decimals 9 "$ACCESS_MINT_KEYPAIR"
fi
if ! solana account "$USDC_MINT" --url "$RPC_URL" >/dev/null 2>&1; then
  spl-token create-token --url "$RPC_URL" --fee-payer "$DEFAULT_KEYPAIR" \
    --mint-authority "$DEFAULT_KEYPAIR" --decimals 6 "$USDC_MINT_KEYPAIR"
fi

CHAIN_BALANCE_LAMPORTS="$(solana balance "$CHAIN_ADDRESS" --url "$RPC_URL" --lamports)"
CHAIN_BALANCE_LAMPORTS="${CHAIN_BALANCE_LAMPORTS%% *}"
if (( CHAIN_BALANCE_LAMPORTS < 20000000 )); then
  solana transfer "$CHAIN_ADDRESS" 0.1 --allow-unfunded-recipient \
    --url "$RPC_URL" --keypair "$DEFAULT_KEYPAIR"
fi

ANCHOR_PROVIDER_URL="$RPC_URL" \
ANCHOR_WALLET="$DEFAULT_KEYPAIR" \
CHAIN_AUTHORITY_KEYPAIR="$CHAIN_KEYPAIR" \
TOKEN_MINT="$ACCESS_MINT" \
USDC_MINT="$USDC_MINT" \
yarn ts-mocha -p ./tsconfig.json -t 120000 integration/initialize-localnet.ts

cd "$REPO_DIR"
export PROGRAM_ID TOKEN_MINT="$ACCESS_MINT" USDC_MINT
export MOCK_CHAIN=false STAKING_ENABLED=false SOLANA_RPC_URL="$RPC_URL"
export VITE_SOLANA_RPC_URL="$RPC_URL" APP_PORT
docker compose -p "$COMPOSE_PROJECT" up -d --build postgres redis api worker app

API_URL="http://127.0.0.1:$APP_PORT/api"
for attempt in $(seq 1 120); do
  if curl -fsS --max-time 2 "$API_URL/health" >/dev/null; then
    break
  fi
  if [[ "$attempt" == 120 ]]; then
    docker compose -p "$COMPOSE_PROJECT" logs --tail 200 api worker app
    echo "Devnet API did not become healthy" >&2
    exit 1
  fi
  sleep 1
done

TEST_KEYPAIR_DIR="$(mktemp -d /tmp/bet1v1-devnet-e2e.XXXXXX)"
MAKER_KEYPAIR="$TEST_KEYPAIR_DIR/maker.json"
OPPONENT_KEYPAIR="$TEST_KEYPAIR_DIR/opponent.json"
cleanup_test_keys() {
  rm -f "$MAKER_KEYPAIR" "$OPPONENT_KEYPAIR"
  rmdir "$TEST_KEYPAIR_DIR" 2>/dev/null || true
}
trap cleanup_test_keys EXIT
solana-keygen new --no-bip39-passphrase --silent --force -o "$MAKER_KEYPAIR"
solana-keygen new --no-bip39-passphrase --silent --force -o "$OPPONENT_KEYPAIR"

fund_test_wallet() {
  local wallet_address="$1"
  if ! solana airdrop 1 "$wallet_address" --url "$RPC_URL"; then
    echo "Devnet faucet unavailable; funding $wallet_address from the admin wallet" >&2
    solana transfer "$wallet_address" 1 --allow-unfunded-recipient \
      --url "$RPC_URL" --keypair "$DEFAULT_KEYPAIR"
  fi
}
fund_test_wallet "$(solana-keygen pubkey "$MAKER_KEYPAIR")"
fund_test_wallet "$(solana-keygen pubkey "$OPPONENT_KEYPAIR")"

cd "$PROGRAM_DIR"
ANCHOR_PROVIDER_URL="$RPC_URL" \
ANCHOR_WALLET="$DEFAULT_KEYPAIR" \
MAKER_KEYPAIR="$MAKER_KEYPAIR" \
OPPONENT_KEYPAIR="$OPPONENT_KEYPAIR" \
USDC_MINT="$USDC_MINT" \
API_URL="$API_URL" \
CHAIN_WAIT_TIMEOUT_MS=90000 \
INTEGRATION_TIMEOUT_MS=300000 \
yarn ts-mocha -p ./tsconfig.json -t 300000 integration/localnet-api.ts

solana program show "$PROGRAM_ID" --url "$RPC_URL"
docker compose -p "$COMPOSE_PROJECT" ps
docker compose -p "$COMPOSE_PROJECT" logs --tail 50 worker
