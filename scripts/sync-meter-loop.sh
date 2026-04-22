#!/usr/bin/env bash
set -euo pipefail

SERVER_URL="${SERVER_URL:-http://localhost:3001}"
API_KEY="${API_KEY:-dev-management-key}"
WORKSPACE_ID="${WORKSPACE_ID:-demo-customer}"
METER_FILE="${METER_FILE:-$HOME/.skillpack/bundles/laws-consultant/meter.jsonl}"
PROVIDER_ID="${PROVIDER_ID:-prov-demo}"
CUSTOMER_ID="${CUSTOMER_ID:-cust-demo}"
SKILL_ID="${SKILL_ID:-laws-consultant}"
BUNDLE_ID="${BUNDLE_ID:-laws-consultant}"
LEASE_JTI="${LEASE_JTI:-}"
INTERVAL_SEC="${INTERVAL_SEC:-5}"

if [ ! -f "$METER_FILE" ]; then
  echo "meter file not found: $METER_FILE"
  echo "start the runtime once first so meter.jsonl is created"
  exit 1
fi

while true; do
  cmd=(
    bun packages/cli/src/cli.js meter upload
    --server-url "$SERVER_URL"
    --api-key "$API_KEY"
    --workspace-id "$WORKSPACE_ID"
    --provider-id "$PROVIDER_ID"
    --customer-id "$CUSTOMER_ID"
    --skill-id "$SKILL_ID"
    --bundle-id "$BUNDLE_ID"
    --file "$METER_FILE"
  )

  if [ -n "$LEASE_JTI" ]; then
    cmd+=(--lease-jti "$LEASE_JTI")
  fi

  "${cmd[@]}" >/dev/null || true
  sleep "$INTERVAL_SEC"
done
