#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_BASE_URL="${API_BASE_URL:-${SERVER_URL:-}}"
DASHBOARD_BASE_URL="${DASHBOARD_BASE_URL:-}"
API_KEY="${API_KEY:-}"
WORKSPACE_ID="${WORKSPACE_ID:-demo-customer}"
PROVIDER_ID="${PROVIDER_ID:-prov-demo}"
CUSTOMER_ID="${CUSTOMER_ID:-demo-customer}"
SKILL_ID="${SKILL_ID:-laws-consultant}"

if [ -z "$API_BASE_URL" ] || [ -z "$API_KEY" ]; then
  echo "usage: API_BASE_URL=https://<api-worker-url> API_KEY=<hosted-api-key> [DASHBOARD_BASE_URL=https://<dashboard-worker-url>] ./scripts/demo-cloudflare-e2e.sh"
  exit 1
fi

VERSION="$(cat VERSION)"
BUNDLE_DIR="dist/skills/laws-consultant-$VERSION"
BUNDLE_PATH="$BUNDLE_DIR/laws-consultant-$VERSION.mcpb"
PUBLIC_KEY_PATH="$BUNDLE_DIR/laws-consultant-$VERSION.public.pem"
RUNTIME_PATH="$BUNDLE_DIR/runtime/server.mjs"
METER_FILE="$BUNDLE_DIR/meter.jsonl"
BUNDLE_ID="laws-consultant-$VERSION"

if [ ! -f "$BUNDLE_PATH" ] || [ ! -f "$PUBLIC_KEY_PATH" ] || [ ! -f "$RUNTIME_PATH" ]; then
  echo "bundle artifacts missing; building now..."
  bun run bundle:laws-consultant
fi

STEP=1
TOTAL_STEPS=6
if [ -n "$DASHBOARD_BASE_URL" ]; then
  TOTAL_STEPS=7
  echo "[$STEP/$TOTAL_STEPS] smoke hosted control plane"
  bun scripts/deploy/smoke-hosted-control-plane.mjs \
    --api-base-url="$API_BASE_URL" \
    --dashboard-base-url="$DASHBOARD_BASE_URL" \
    --api-key="$API_KEY" >/dev/null
  STEP=$((STEP + 1))
fi

echo "[$STEP/$TOTAL_STEPS] provider/customer/workspace setup"
bun apps/cli/src/cli.js provider create \
  --server-url "$API_BASE_URL" --api-key "$API_KEY" \
  --provider-id "$PROVIDER_ID" --name "Provider Demo" >/dev/null

bun apps/cli/src/cli.js customer create \
  --server-url "$API_BASE_URL" --api-key "$API_KEY" \
  --provider-id "$PROVIDER_ID" --customer-id "$CUSTOMER_ID" --name "Customer Demo" >/dev/null

bun apps/cli/src/cli.js workspace create \
  --server-url "$API_BASE_URL" --api-key "$API_KEY" \
  --workspace-id "$WORKSPACE_ID" --provider-id "$PROVIDER_ID" --customer-id "$CUSTOMER_ID" --name "Workspace Demo" >/dev/null
STEP=$((STEP + 1))

echo "[$STEP/$TOTAL_STEPS] issue policy"
bun apps/cli/src/cli.js policy issue \
  --server-url "$API_BASE_URL" --api-key "$API_KEY" \
  --policy-file verticals/laws-consultant/distribution/policy.dev.json >/dev/null
STEP=$((STEP + 1))

echo "[$STEP/$TOTAL_STEPS] invoke runtime tool call from .mcpb"
printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wiki_search","arguments":{"query":"copyright","limit":1}}}\n' \
  | SKILLPACK_SYNC_MODE=direct \
    SKILLPACK_CONTROL_PLANE_URL="$API_BASE_URL" \
    node "$RUNTIME_PATH" "$BUNDLE_PATH" "$PUBLIC_KEY_PATH" >/dev/null

if [ ! -f "$METER_FILE" ]; then
  echo "meter file not generated: $METER_FILE"
  exit 1
fi
STEP=$((STEP + 1))

echo "[$STEP/$TOTAL_STEPS] fetch usage summary"
SUMMARY_JSON="$(bun apps/cli/src/cli.js usage summary \
  --server-url "$API_BASE_URL" --api-key "$API_KEY" \
  --workspace-id "$WORKSPACE_ID" --provider-id "$PROVIDER_ID")"

echo "$SUMMARY_JSON"
STEP=$((STEP + 1))

echo "[$STEP/$TOTAL_STEPS] assert usage > 0"
echo "$SUMMARY_JSON" | bun -e '
const input = await new Response(Bun.stdin.stream()).text();
const parsed = JSON.parse(input);
const total = (parsed.summary ?? []).reduce((acc, row) => acc + Number(row.totalCalls ?? 0), 0);
if (!(total > 0)) {
  console.error("FAIL: no usage observed in summary");
  process.exit(1);
}
console.log(`PASS: usage observed (totalCalls=${total})`);
'
