# Cloudflare Deploy + D1 End-to-End Flow

Goal: deploy the hosted control plane on Cloudflare Workers + D1, then verify `.mcpb` runtime usage reaches the backend ledger through the direct meter client path.

## 1) Local smoke first (recommended)

From repo root:

```bash
./scripts/demo-cloudflare-local-e2e.sh
```

This script:

1. applies local D1 migrations
2. starts `apps/api` and `apps/dashboard` with `wrangler dev --local`
3. runs shared hosted-control-plane smoke
4. runs full `.mcpb` direct-meter smoke
4. asserts usage summary reflects the runtime call

It writes worker logs to:

- `.context/cloudflare-api-local.log`
- `.context/cloudflare-dashboard-local.log`

## 2) Configure the manifest inputs

The hosted API/dashboard contract is owned by:

- `deploy/hosted-control-plane.manifest.json`

The deploy wrapper resolves this manifest from two environment-specific inputs:

- `apiPublicBaseUrl`
- `dashboardPublicOrigin`

## 3) Create D1 database

From `apps/api/`:

```bash
cd apps/api
npx wrangler d1 create skillpack-license
```

Copy the returned `database_id` into `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "skillpack-license",
    "database_id": "<paste-id>",
    "migrations_dir": "migrations"
  }
]
```

## 4) Apply migrations

```bash
cd apps/api
npx wrangler d1 migrations apply skillpack-license
```

## 5) Set secrets

Use the same key pair used to sign/verify runtime bundles.

```bash
cd apps/api
npx wrangler secret put SKILLPACK_SIGNING_PRIVATE_KEY_PEM
npx wrangler secret put SKILLPACK_SIGNING_PUBLIC_KEY_PEM
npx wrangler secret put SKILLPACK_MANAGEMENT_API_KEY

cd ../dashboard
npx wrangler secret put SKILLPACK_API_MANAGEMENT_KEY
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put CLERK_PUBLISHABLE_KEY
```

## 6) Deploy the hosted pair

Preferred path from repo root:

```bash
export SKILLPACK_API_BASE_URL="https://<api-worker>.workers.dev"
export SKILLPACK_DASHBOARD_ORIGIN="https://<dashboard-worker>.workers.dev"
export SKILLPACK_MANAGEMENT_API_KEY="<management-api-key>"
export SKILLPACK_SIGNING_PRIVATE_KEY_PEM="$(cat path/to/private.pem)"
export SKILLPACK_SIGNING_PUBLIC_KEY_PEM="$(cat path/to/public.pem)"
export SKILLPACK_API_MANAGEMENT_KEY="<api-management-key>"
export CLERK_SECRET_KEY="<clerk-secret>"
export CLERK_PUBLISHABLE_KEY="<clerk-publishable>"

bun scripts/deploy/deploy-hosted-control-plane.mjs \
  '{"apiPublicBaseUrl":"'"$SKILLPACK_API_BASE_URL"'","dashboardPublicOrigin":"'"$SKILLPACK_DASHBOARD_ORIGIN"'"}'
```

That wrapper:

- resolves `deploy/hosted-control-plane.manifest.json`
- injects manifest-owned public vars into both workers
- runs remote D1 migration before deploying the API worker

## 7) Run hosted smoke

```bash
bun scripts/deploy/smoke-hosted-control-plane.mjs \
  --api-base-url="https://<api-worker>.workers.dev" \
  --dashboard-base-url="https://<dashboard-worker>.workers.dev" \
  --management-api-key="<management-api-key>"
```

## 8) Run end-to-end smoke

From repo root:

```bash
API_BASE_URL="https://<api-worker>.workers.dev" \
DASHBOARD_BASE_URL="https://<dashboard-worker>.workers.dev" \
API_KEY="<management-api-key>" \
./scripts/demo-cloudflare-e2e.sh
```

This does:

1. create provider/customer/workspace
2. issue policy
3. run one runtime tool call from `.mcpb` with `SKILLPACK_SYNC_MODE=direct`
4. let the bundle-local meter client upload usage directly to `/v1/meter/upload`
5. query usage summary
6. assert total usage > 0

## 9) Notes

- Runtime remains offline-first. It still writes local `meter.jsonl`.
- Direct mode is enabled only when the bundle runtime has `SKILLPACK_SYNC_MODE=direct` and `SKILLPACK_CONTROL_PLANE_URL` set.
- Direct uploads authenticate with `x-skillpack-lease-token`.
- Accepted usage identity comes from the signed lease context (`providerId`, `customerId`, `workspaceId`, `skillId`, `bundleId`, `leaseJti`), not from client-supplied upload metadata.
- The legacy management-key upload path still exists for manual/CLI fallback flows.
