#!/usr/bin/env bash
# Registers (or updates) the date-math service on Pocket Network as the service OWNER.
# Costs: add_service_fee (MainNet 1,000 POKT, one-time) + a little gas. Updates later cost gas only.
#
# Usage (inside WSL, from the repo root):
#   bash scripts/register.sh beta     # free dry run with faucet POKT
#   bash scripts/register.sh main     # real: spends 1,000 POKT
# Env overrides: KEY=owner  KEYRING_BACKEND=file  CU=100000  SERVICE_ID=date-math  SERVICE_NAME="Date Math"
set -euo pipefail

NETWORK="${1:-}"
case "$NETWORK" in
  main) REST="https://sauron-api.infra.pocket.network" ;;
  beta) REST="https://sauron-api.beta.infra.pocket.network" ;;
  *) echo "usage: $0 <beta|main>"; exit 1 ;;
esac

KEY="${KEY:-owner}"
KEYRING_BACKEND="${KEYRING_BACKEND:-file}"
SERVICE_ID="${SERVICE_ID:-date-math}"
SERVICE_NAME="${SERVICE_NAME:-Date Math}"
CU="${CU:-100000}"
CARD="$(dirname "$0")/../pocket/card.json"
KR=(--keyring-backend "$KEYRING_BACKEND")

command -v pocketd >/dev/null || { echo "pocketd not found: run scripts/install-pocketd.sh"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required (sudo apt install -y python3)"; exit 1; }
[ -f "$CARD" ] || { echo "card not found: $CARD"; exit 1; }
if grep -q "REPLACE_" "$CARD"; then echo "Card still has REPLACE_ placeholders. Put your Worker host into pocket/card.json first."; exit 1; fi

py() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
fmt() { python3 -c "print(f'{int($1)/1e6:,.6f} POKT')"; }
balance() { curl -fsS "$REST/cosmos/bank/v1beta1/balances/$1/by_denom?denom=upokt" | py "d['balance']['amount']"; }

ADDR="$(pocketd keys show "$KEY" -a "${KR[@]}")"
FEE="$(curl -fsS "$REST/pokt-network/poktroll/service/params" | py "d['params']['add_service_fee']['amount']")"
BAL="$(balance "$ADDR")"
OWNER_ONCHAIN="$(curl -sS "$REST/pokt-network/poktroll/service/service/$SERVICE_ID" | py "d.get('service',{}).get('owner_address','')" 2>/dev/null || true)"

GAS_BUFFER=2000000  # 2 POKT headroom for gas
if [ -n "$OWNER_ONCHAIN" ]; then
  [ "$OWNER_ONCHAIN" = "$ADDR" ] || { echo "Service id '$SERVICE_ID' is owned by $OWNER_ONCHAIN, not you ($ADDR). Pick another id."; exit 1; }
  MODE="UPDATE (gas only, no fee)"; NEED=$GAS_BUFFER; FEE_TXT="none (update)"
else
  MODE="CREATE (one-time fee)"; NEED=$((FEE + GAS_BUFFER)); FEE_TXT="$(fmt "$FEE")"
fi

# Minify the card: smaller tx, less gas, safely under the 4 KiB audit limit. Written next to the source card.
MIN="$(dirname "$CARD")/card.min.json"
python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1])), separators=(',',':')), end='')" "$CARD" > "$MIN"
SIZE="$(wc -c < "$MIN")"
[ "$SIZE" -lt 4096 ] || { echo "Minified card is $SIZE bytes (audit limit 4096)."; exit 1; }

echo "== Pocket service registration ($NETWORK)"
echo "  mode:        $MODE"
echo "  service:     $SERVICE_ID  \"$SERVICE_NAME\""
echo "  price:       $CU CU/relay (~\$$(python3 -c "print(f'{$CU/1e9:.6f}')") per relay on-chain)"
echo "  owner:       $ADDR"
echo "  balance:     $(fmt "$BAL")"
echo "  fee:         $FEE_TXT"
echo "  card:        $SIZE bytes (minified, $MIN)"
[ "$BAL" -ge "$NEED" ] || { echo "Insufficient balance: need at least $(fmt "$NEED") incl. gas headroom."; exit 1; }

echo; echo "Validating card (no gas)..."
pocketd tx service validate-card "$MIN"

echo
echo "The service id is PERMANENT once created."
read -r -p "Type the service id ($SERVICE_ID) to confirm and send the transaction: " CONFIRM
[ "$CONFIRM" = "$SERVICE_ID" ] || { echo "Aborted."; exit 1; }

pocketd tx service add-service "$SERVICE_ID" "$SERVICE_NAME" "$CU" \
  --card-file "$MIN" --from "$KEY" "${KR[@]}" \
  --network="$NETWORK" --gas auto --gas-prices 1upokt --gas-adjustment 1.5 --yes

echo; echo "Waiting for inclusion in a block..."
for _ in $(seq 1 24); do
  sleep 10
  if pocketd query service show-service "$SERVICE_ID" --network="$NETWORK" >/dev/null 2>&1; then break; fi
done
pocketd query service show-service "$SERVICE_ID" --network="$NETWORK"
echo; echo "New balance: $(fmt "$(balance "$ADDR")")"
echo "Next: node tools/preaudit.mjs --network $NETWORK"
