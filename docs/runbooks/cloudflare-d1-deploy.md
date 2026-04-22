# Cloudflare Deploy + D1 End-to-End Flow

Goal: deploy the license server on Cloudflare Workers with D1, then verify `.mcpb` runtime usage reaches the backend ledger.

## 1) Local smoke first (recommended)

From repo root:

```bash
./scripts/demo-cloudflare-local-e2e.sh
```

This script:

1. applies local D1 migrations
2. starts `wrangler dev --local`
3. runs full `.mcpb` meter-backhaul smoke
4. asserts usage summary reflects the runtime call

It writes worker logs to `.context/cloudflare-local-dev.log`.

## 2) Create D1 database

From `packages/license-server-worker/`:

```bash
cd packages/license-server-worker
npx wrangler d1 create skillpack-license
```

Copy the returned `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "skillpack-license"
database_id = "<paste-id>"
migrations_dir = "migrations"
```

## 3) Apply migrations

```bash
cd packages/license-server-worker
npx wrangler d1 migrations apply skillpack-license
```

## 4) Set Worker secrets

Use the same key pair used to sign/verify runtime bundles.

```bash
cd packages/license-server-worker
npx wrangler secret put SKILLPACK_SIGNING_PRIVATE_KEY_PEM
npx wrangler secret put SKILLPACK_SIGNING_PUBLIC_KEY_PEM
npx wrangler secret put SKILLPACK_MANAGEMENT_API_KEY
```

## 5) Deploy worker

```bash
cd packages/license-server-worker
npx wrangler deploy
```

Capture deployed URL: `https://<worker-subdomain>.workers.dev`

## 6) Run end-to-end smoke

From repo root:

```bash
SERVER_URL="https://<worker-subdomain>.workers.dev" \
API_KEY="<management-api-key>" \
./scripts/demo-cloudflare-e2e.sh
```

This does:

1. create provider/customer/workspace
2. issue policy
3. run one runtime tool call from `.mcpb`
4. upload `meter.jsonl` to worker
5. query usage summary
6. assert total usage > 0

## 7) Continuous sync from receiver runtime (recommended)

After receiver runtime is running and writing `meter.jsonl`:

```bash
SERVER_URL="https://<worker-subdomain>.workers.dev" \
API_KEY="<management-api-key>" \
WORKSPACE_ID="demo-customer" \
PROVIDER_ID="prov-demo" \
CUSTOMER_ID="cust-demo" \
SKILL_ID="laws-consultant" \
BUNDLE_ID="laws-consultant-$(cat VERSION)" \
METER_FILE="$HOME/.skillpack/bundles/laws-consultant/meter.jsonl" \
./scripts/sync-meter-loop.sh
```

## Notes

- Runtime remains offline-first. It does not phone home on every call.
- Usage is sent by `skillpack meter upload` (manual or sync loop).
- For remote customers, run sync loop as a service/timer in their trusted environment.
