#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST="${HOST:-127.0.0.1}"
API_PORT="${API_PORT:-18787}"
DASHBOARD_PORT="${DASHBOARD_PORT:-18788}"
API_INSPECTOR_PORT="${API_INSPECTOR_PORT:-9329}"
DASHBOARD_INSPECTOR_PORT="${DASHBOARD_INSPECTOR_PORT:-9330}"
API_URL="${API_URL:-http://$HOST:$API_PORT}"
DASHBOARD_URL="${DASHBOARD_URL:-http://$HOST:$DASHBOARD_PORT}"
API_KEY="${API_KEY:-dev-management-key}"
API_LOG_FILE="${API_LOG_FILE:-$ROOT_DIR/.context/cloudflare-api-local.log}"
DASHBOARD_LOG_FILE="${DASHBOARD_LOG_FILE:-$ROOT_DIR/.context/cloudflare-dashboard-local.log}"
API_DIR="$ROOT_DIR/apps/api"
DASHBOARD_DIR="$ROOT_DIR/apps/dashboard"
PRIVATE_KEY_PATH="${PRIVATE_KEY_PATH:-$ROOT_DIR/verticals/laws-consultant/distribution/keys/dev-private.pem}"
PUBLIC_KEY_PATH="${PUBLIC_KEY_PATH:-$ROOT_DIR/verticals/laws-consultant/distribution/keys/dev-public.pem}"

if [ ! -f "$PRIVATE_KEY_PATH" ] || [ ! -f "$PUBLIC_KEY_PATH" ]; then
  echo "signing keys missing; generating dev Ed25519 keypair..."
  mkdir -p "$(dirname "$PRIVATE_KEY_PATH")"
  openssl genpkey -algorithm Ed25519 -out "$PRIVATE_KEY_PATH" >/dev/null 2>&1
  openssl pkey -in "$PRIVATE_KEY_PATH" -pubout -out "$PUBLIC_KEY_PATH" >/dev/null 2>&1
fi

PRIVATE_KEY_B64="$(base64 < "$PRIVATE_KEY_PATH" | tr -d '\n')"
PUBLIC_KEY_B64="$(base64 < "$PUBLIC_KEY_PATH" | tr -d '\n')"

cat > "$API_DIR/.dev.vars" <<EOF
SKILLPACK_MANAGEMENT_API_KEY=$API_KEY
SKILLPACK_SIGNING_PRIVATE_KEY_PEM_BASE64=$PRIVATE_KEY_B64
SKILLPACK_SIGNING_PUBLIC_KEY_PEM_BASE64=$PUBLIC_KEY_B64
SKILLPACK_DASHBOARD_ORIGIN=$DASHBOARD_URL
EOF

cat > "$DASHBOARD_DIR/.dev.vars" <<EOF
SKILLPACK_API_BASE_URL=$API_URL
SKILLPACK_DASHBOARD_ORIGIN=$DASHBOARD_URL
SKILLPACK_API_MANAGEMENT_KEY=$API_KEY
CLERK_PUBLISHABLE_KEY=pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk
CLERK_SECRET_KEY=sk_test_local_placeholder
EOF

echo "[1/6] apply D1 local migrations"
bun run --cwd "$API_DIR" d1:migrate:local >/dev/null

mkdir -p "$(dirname "$API_LOG_FILE")"
echo "[2/6] start local API worker on $API_URL"
(
  cd "$API_DIR"
  bunx wrangler dev --local --port "$API_PORT" --inspector-port "$API_INSPECTOR_PORT"
) >"$API_LOG_FILE" 2>&1 &
API_PID=$!

echo "[3/6] start local dashboard worker on $DASHBOARD_URL"
(
  cd "$DASHBOARD_DIR"
  bunx wrangler dev --local --port "$DASHBOARD_PORT" --inspector-port "$DASHBOARD_INSPECTOR_PORT"
) >"$DASHBOARD_LOG_FILE" 2>&1 &
DASHBOARD_PID=$!

cleanup() {
  for pid in "$API_PID" "$DASHBOARD_PID"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

echo "[4/6] wait for worker pair readiness"
READY=0
for _ in $(seq 1 60); do
  if bun scripts/deploy/smoke-hosted-control-plane.mjs \
    --api-base-url="$API_URL" \
    --dashboard-base-url="$DASHBOARD_URL" \
    --management-api-key="$API_KEY" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "worker pair did not become ready; see $API_LOG_FILE and $DASHBOARD_LOG_FILE"
  tail -n 50 "$API_LOG_FILE" || true
  tail -n 50 "$DASHBOARD_LOG_FILE" || true
  exit 1
fi

echo "[5/6] run end-to-end smoke against local worker pair"
API_BASE_URL="$API_URL" \
  DASHBOARD_BASE_URL="$DASHBOARD_URL" \
  API_KEY="$API_KEY" \
  ./scripts/demo-cloudflare-e2e.sh

echo "[6/6] done"
echo "PASS: local Cloudflare+D1 flow is working (logs: $API_LOG_FILE, $DASHBOARD_LOG_FILE)"
