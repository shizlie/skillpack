#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"
SERVER_URL="${SERVER_URL:-http://$HOST:$PORT}"
API_KEY="${API_KEY:-dev-management-key}"
LOG_FILE="${LOG_FILE:-$ROOT_DIR/.context/cloudflare-local-dev.log}"
WORKER_DIR="$ROOT_DIR/packages/license-server-worker"
PRIVATE_KEY_PATH="${PRIVATE_KEY_PATH:-$ROOT_DIR/verticals/laws-consultant/distribution/keys/dev-private.pem}"
PUBLIC_KEY_PATH="${PUBLIC_KEY_PATH:-$ROOT_DIR/verticals/laws-consultant/distribution/keys/dev-public.pem}"

if [ ! -f "$PRIVATE_KEY_PATH" ] || [ ! -f "$PUBLIC_KEY_PATH" ]; then
  echo "signing keys missing; generating via bundle build..."
  bun run bundle:laws-consultant >/dev/null
fi

PRIVATE_KEY_B64="$(base64 < "$PRIVATE_KEY_PATH" | tr -d '\n')"
PUBLIC_KEY_B64="$(base64 < "$PUBLIC_KEY_PATH" | tr -d '\n')"

cat > "$WORKER_DIR/.dev.vars" <<EOF
SKILLPACK_MANAGEMENT_API_KEY=$API_KEY
SKILLPACK_SIGNING_PRIVATE_KEY_PEM_BASE64=$PRIVATE_KEY_B64
SKILLPACK_SIGNING_PUBLIC_KEY_PEM_BASE64=$PUBLIC_KEY_B64
EOF

echo "[1/5] apply D1 local migrations"
bun run --cwd "$WORKER_DIR" d1:migrate:local >/dev/null

mkdir -p "$(dirname "$LOG_FILE")"
echo "[2/5] start local Cloudflare worker on $SERVER_URL"
(
  cd "$WORKER_DIR"
  bunx wrangler dev --local --port "$PORT"
) >"$LOG_FILE" 2>&1 &
WORKER_PID=$!

cleanup() {
  if kill -0 "$WORKER_PID" >/dev/null 2>&1; then
    kill "$WORKER_PID" >/dev/null 2>&1 || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "[3/5] wait for worker readiness"
READY=0
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "$SERVER_URL/v1/usage/summary"; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "worker did not become ready; see $LOG_FILE"
  tail -n 50 "$LOG_FILE" || true
  exit 1
fi

echo "[4/5] run end-to-end smoke against local worker"
SERVER_URL="$SERVER_URL" API_KEY="$API_KEY" ./scripts/demo-cloudflare-e2e.sh

echo "[5/5] done"
echo "PASS: local Cloudflare+D1 flow is working (log: $LOG_FILE)"
