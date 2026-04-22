#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SERVER_URL="${SERVER_URL:-}"
API_KEY="${API_KEY:-}"
WORKSPACE_ID="${WORKSPACE_ID:-demo-customer}"
PROVIDER_ID="${PROVIDER_ID:-prov-demo}"
CUSTOMER_ID="${CUSTOMER_ID:-cust-demo}"
SKILL_ID="${SKILL_ID:-laws-consultant}"

if [ -z "$SERVER_URL" ] || [ -z "$API_KEY" ]; then
  echo "usage: SERVER_URL=https://<worker-url> API_KEY=<management-key> ./scripts/demo-cloudflare-e2e.sh"
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

echo "[1/6] provider/customer/workspace setup"
bun packages/cli/src/cli.js provider create \
  --server-url "$SERVER_URL" --api-key "$API_KEY" \
  --provider-id "$PROVIDER_ID" --name "Provider Demo" >/dev/null

bun packages/cli/src/cli.js customer create \
  --server-url "$SERVER_URL" --api-key "$API_KEY" \
  --provider-id "$PROVIDER_ID" --customer-id "$CUSTOMER_ID" --name "Customer Demo" >/dev/null

bun packages/cli/src/cli.js workspace create \
  --server-url "$SERVER_URL" --api-key "$API_KEY" \
  --workspace-id "$WORKSPACE_ID" --provider-id "$PROVIDER_ID" --customer-id "$CUSTOMER_ID" --name "Workspace Demo" >/dev/null

echo "[2/6] issue policy"
bun packages/cli/src/cli.js policy issue \
  --server-url "$SERVER_URL" --api-key "$API_KEY" \
  --policy-file verticals/laws-consultant/distribution/policy.dev.json >/dev/null

echo "[3/6] invoke runtime tool call from .mcpb"
printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wiki_search","arguments":{"query":"copyright","limit":1}}}\n' \
  | node "$RUNTIME_PATH" "$BUNDLE_PATH" "$PUBLIC_KEY_PATH" >/dev/null

if [ ! -f "$METER_FILE" ]; then
  echo "meter file not generated: $METER_FILE"
  exit 1
fi

echo "[4/6] upload meter to Cloudflare worker"
bun packages/cli/src/cli.js meter upload \
  --server-url "$SERVER_URL" --api-key "$API_KEY" \
  --workspace-id "$WORKSPACE_ID" \
  --provider-id "$PROVIDER_ID" \
  --customer-id "$CUSTOMER_ID" \
  --skill-id "$SKILL_ID" \
  --bundle-id "$BUNDLE_ID" \
  --file "$METER_FILE" >/dev/null

echo "[5/6] fetch usage summary"
SUMMARY_JSON="$(bun packages/cli/src/cli.js usage summary \
  --server-url "$SERVER_URL" --api-key "$API_KEY" \
  --workspace-id "$WORKSPACE_ID" --provider-id "$PROVIDER_ID")"

echo "$SUMMARY_JSON"

echo "[6/6] assert usage > 0"
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
