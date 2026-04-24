# Cloudflare Hosted Control Plane Deploy

This runbook deploys the hosted skillpack control plane:

- `apps/api`: Cloudflare Worker REST API
- `apps/dashboard`: Cloudflare Worker dashboard/BFF
- `skillpack-db`: Cloudflare D1 database bound to the API Worker as `DB`

It also verifies the live direct-meter path, where a `.mcpb` runtime call uploads usage to the hosted API without a manual `meter upload`.

## What PR #8 Changed

PR #8, `feat: harden hosted deploy and direct meter flow`, shipped:

- manifest-driven deploy wiring in `deploy/hosted-control-plane.manifest.json`
- deploy wrapper: `scripts/deploy/deploy-hosted-control-plane.mjs`
- hosted smoke runner: `scripts/deploy/smoke-hosted-control-plane.mjs`
- local and remote end-to-end smoke scripts
- direct meter uploads authenticated by `x-skillpack-lease-token`

The PR did not create the real Cloudflare database, secrets, or production deployment. Those are the operator steps below.

## Prerequisites

Install dependencies and authenticate Wrangler:

```bash
bun install
bunx wrangler login
```

You need:

- Cloudflare account access
- a Cloudflare Workers subdomain
- production Ed25519 signing key pair, generated below if you do not already have one
- Clerk application keys for dashboard auth
- one hosted API key value, generated below

Do not commit private keys, `.dev.vars`, or generated Wrangler auth files.

## Worker Names And URLs

The current Worker names are defined in:

- `apps/api/wrangler.jsonc`: `skillpack-api`
- `apps/dashboard/wrangler.jsonc`: `skillpack-dashboard`

Default workers.dev URLs usually look like:

```txt
https://skillpack-api.opensocialforall.workers.dev
https://skillpack-dashboard.opensocialforall.workers.dev
```

Use those exact live URLs in the commands below.

## Required Binding

Only the API Worker has a Cloudflare resource binding:

| Worker          | Binding | Type        | Name                |
| --------------- | ------- | ----------- | ------------------- |
| `skillpack-api` | `DB`    | D1 database | `skillpack-db` |

The dashboard Worker has no D1 binding. It talks to the API Worker through `SKILLPACK_API_BASE_URL`.

Important: the database name in `apps/api/wrangler.jsonc` must match the database name used by `apps/api/package.json` migration scripts. The repo default is `skillpack-db`.

If you already created a D1 database with another name, either create a new `skillpack-db` database or update both migration scripts in `apps/api/package.json` to use your chosen name. Do not leave Wrangler config and package scripts pointing at different D1 names.

## Create The D1 Database

From repo root:

```bash
cd apps/api
bunx wrangler d1 create skillpack-db
```

Wrangler prints a `database_id`. Copy that value into `apps/api/wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "skillpack-db",
    "database_id": "<paste-database-id-here>",
    "migrations_dir": "migrations"
  }
]
```

The binding name must stay `DB`. `apps/api/src/index.js` expects `env.DB`.

## Generate The API Key, Private Key, And Public Key

There is no hosted service that gives you these values. You create them.

From repo root:

```bash
mkdir -p .secrets/hosted
chmod 700 .secrets/hosted

openssl rand -base64 48 > .secrets/hosted/api-key.txt

openssl genpkey \
  -algorithm Ed25519 \
  -out .secrets/hosted/signing-private.pem

openssl pkey \
  -in .secrets/hosted/signing-private.pem \
  -pubout \
  -out .secrets/hosted/signing-public.pem

chmod 600 .secrets/hosted/api-key.txt
chmod 600 .secrets/hosted/signing-private.pem
chmod 644 .secrets/hosted/signing-public.pem
```

This creates:

| Generated file | What it is | To use as Cloudflare secret |
| --- | --- | --- |
| `.secrets/hosted/api-key.txt` | hosted API key | `SKILLPACK_API_KEY` for both Workers |
| `.secrets/hosted/signing-private.pem` | Ed25519 private key | `SKILLPACK_SIGNING_PRIVATE_KEY_PEM` |
| `.secrets/hosted/signing-public.pem` | Ed25519 public key | `SKILLPACK_SIGNING_PUBLIC_KEY_PEM` |

The hosted API key is a random bearer secret. Whoever has it can call protected hosted API endpoints.

The API Worker uses the key to decide whether a request is allowed to call protected hosted API endpoints. The dashboard Worker uses the key only when it needs to proxy an authenticated dashboard request to the API Worker.

The signing private key signs lease tokens. The signing public key verifies those tokens. The live API Worker and any bundle you use for the live direct-meter smoke must use the same key pair, or direct upload verification will fail.

For the live `.mcpb` smoke, copy this same key pair into the ignored local demo-key path before building the bundle:

```bash
mkdir -p verticals/laws-consultant/distribution/keys
cp .secrets/hosted/signing-private.pem verticals/laws-consultant/distribution/keys/dev-private.pem
cp .secrets/hosted/signing-public.pem verticals/laws-consultant/distribution/keys/dev-public.pem
```

Those `verticals/.../keys/*.pem` files are gitignored. They are local inputs for bundle building.

## Set Production Secrets

Set the same hosted API key value on both Workers:

```txt
API Worker secret:
  SKILLPACK_API_KEY=<contents of .secrets/hosted/api-key.txt>

dashboard Worker secret:
  SKILLPACK_API_KEY=<same contents of .secrets/hosted/api-key.txt>
```

### API Worker Secrets

```bash
cd apps/api

bunx wrangler secret put SKILLPACK_API_KEY < ../../.secrets/hosted/api-key.txt
bunx wrangler secret put SKILLPACK_SIGNING_PRIVATE_KEY_PEM < ../../.secrets/hosted/signing-private.pem
bunx wrangler secret put SKILLPACK_SIGNING_PUBLIC_KEY_PEM < ../../.secrets/hosted/signing-public.pem
```

What each secret does:

| Secret | Used by | Purpose |
| --- | --- | --- |
| `SKILLPACK_API_KEY` | API Worker | stores the hosted API key for protected API endpoints |
| `SKILLPACK_SIGNING_PRIVATE_KEY_PEM` | API Worker | signs issued lease tokens |
| `SKILLPACK_SIGNING_PUBLIC_KEY_PEM` | API Worker | verifies signed lease and bundle flows |

### Dashboard Worker Secrets

```bash
cd ../dashboard

bunx wrangler secret put SKILLPACK_API_KEY < ../../.secrets/hosted/api-key.txt
bunx wrangler secret put CLERK_SECRET_KEY
bunx wrangler secret put CLERK_PUBLISHABLE_KEY
```

What each secret does:

| Secret | Used by | Purpose |
| --- | --- | --- |
| `SKILLPACK_API_KEY` | Dashboard Worker | stores the same hosted API key for dashboard-to-API proxy calls |
| `CLERK_SECRET_KEY` | Dashboard Worker | verifies dashboard sessions server-side |
| `CLERK_PUBLISHABLE_KEY` | Dashboard Worker | configures Clerk in the browser |

The dashboard API key is required for dashboard operations that proxy to the hosted API, and for the live smoke tests in this runbook. It is not required for detached dashboard flows that only inspect local files, exported state, prepared artifacts, cached data, or operator-provided inputs in the browser.

Optional dashboard auth URLs can be added later as Worker vars if needed:

```txt
SKILLPACK_CLERK_SIGN_IN_URL
SKILLPACK_CLERK_SIGN_UP_URL
```

They are not required for the current smoke tests.

## Deploy From Your Machine

From repo root:

```bash
export API_BASE_URL="https://skillpack-api.opensocialforall.workers.dev"
export DASHBOARD_ORIGIN="https://skillpack-dashboard.opensocialforall.workers.dev"

bun scripts/deploy/deploy-hosted-control-plane.mjs \
  '{"apiPublicBaseUrl":"'"$API_BASE_URL"'","dashboardPublicOrigin":"'"$DASHBOARD_ORIGIN"'"}'
```

The deploy wrapper:

1. reads `deploy/hosted-control-plane.manifest.json`
2. generates Wrangler config files with the correct public vars
3. runs remote D1 migrations for `apps/api`
4. deploys `skillpack-api`
5. deploys `skillpack-dashboard`

Generated config files are written under each app's `.wrangler/` directory.

## Deploy From GitHub Actions

The workflow is:

```txt
.github/workflows/deploy-hosted-control-plane.yml
```

Set these repository variables:

```txt
SKILLPACK_API_BASE_URL=https://skillpack-api.opensocialforall.workers.dev
SKILLPACK_DASHBOARD_ORIGIN=https://skillpack-dashboard.opensocialforall.workers.dev
```

Set these repository secrets:

```txt
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
SKILLPACK_API_KEY
```

Important: the workflow deploys Workers, but Worker runtime secrets must already exist in Cloudflare. Set the Worker secrets with `wrangler secret put` before relying on CI deploys.

Trigger manually:

```bash
gh workflow run deploy-hosted-control-plane.yml
```

Or push to `main`; the workflow also runs on `main` pushes.

## Live Smoke Test

After deploy, verify both Workers are reachable and wired:

```bash
bun scripts/deploy/smoke-hosted-control-plane.mjs \
  --api-base-url="$API_BASE_URL" \
  --dashboard-base-url="$DASHBOARD_ORIGIN" \
  --api-key="<SKILLPACK_API_KEY>"
```

This checks:

- API `/healthz`
- dashboard `/healthz`
- dashboard `/app-config`
- dashboard API wiring
- Clerk backend secret presence
- hosted API key access

Expected output:

```json
{ "ok": true }
```

## Live End-To-End Meter Test

Run the full hosted direct-meter test:

```bash
API_BASE_URL="$API_BASE_URL" \
DASHBOARD_BASE_URL="$DASHBOARD_ORIGIN" \
API_KEY="<SKILLPACK_API_KEY>" \
./scripts/demo-cloudflare-e2e.sh
```

This script:

1. creates a provider, customer, and workspace
2. issues a policy
3. builds the `laws-consultant` bundle if missing
4. invokes one runtime tool call from the `.mcpb`
5. sets `SKILLPACK_SYNC_MODE=direct`
6. sets `SKILLPACK_CONTROL_PLANE_URL` to the live API Worker
7. uploads usage to `/v1/meter/upload`
8. queries usage summary
9. asserts total usage is greater than zero

Expected final output:

```txt
PASS: usage observed (totalCalls=...)
```

## Local Smoke Test

Before changing production config, test the same lane locally:

```bash
./scripts/demo-cloudflare-local-e2e.sh
```

This script:

1. applies local D1 migrations
2. starts `apps/api` with `wrangler dev --local`
3. starts `apps/dashboard` with `wrangler dev --local`
4. runs hosted-control-plane smoke
5. runs full `.mcpb` direct-meter smoke
6. asserts usage summary reflects the runtime call

Logs:

```txt
.context/cloudflare-api-local.log
.context/cloudflare-dashboard-local.log
```

## Troubleshooting

### `worker_missing_d1_binding_DB`

The API Worker cannot see the D1 binding.

Check `apps/api/wrangler.jsonc`:

```jsonc
"binding": "DB"
```

Then redeploy.

### `worker_missing_env_SKILLPACK_SIGNING_PRIVATE_KEY_PEM`

The API Worker secret is missing.

Run:

```bash
cd apps/api
bunx wrangler secret put SKILLPACK_SIGNING_PRIVATE_KEY_PEM
```

Then redeploy.

### `api_key_failed:401`

The hosted API key passed to the smoke script does not match the API Worker secret.

Use the exact value stored as:

```txt
SKILLPACK_API_KEY
```

For the dashboard Worker, `SKILLPACK_API_KEY` should usually be the same hosted API key value.

### `dashboard_config_missing_api_base_url`

The dashboard deploy did not receive `SKILLPACK_API_BASE_URL`.

Deploy through:

```bash
bun scripts/deploy/deploy-hosted-control-plane.mjs \
  '{"apiPublicBaseUrl":"'"$API_BASE_URL"'","dashboardPublicOrigin":"'"$DASHBOARD_ORIGIN"'"}'
```

Do not deploy `apps/dashboard` directly unless you manually provide the same vars.

### No Usage In Summary

Run the full remote script, not only the hosted smoke:

```bash
API_BASE_URL="$API_BASE_URL" \
DASHBOARD_BASE_URL="$DASHBOARD_ORIGIN" \
API_KEY="<SKILLPACK_API_KEY>" \
./scripts/demo-cloudflare-e2e.sh
```

The direct meter path only runs when the runtime has:

```txt
SKILLPACK_SYNC_MODE=direct
SKILLPACK_CONTROL_PLANE_URL=<live-api-url>
```

## Contract Notes

- Runtime remains offline-first. It still writes local `meter.jsonl`.
- Direct mode uploads in the background after local spool write.
- Direct uploads authenticate with `x-skillpack-lease-token`.
- Accepted usage identity comes from the signed lease context: `providerId`, `customerId`, `workspaceId`, `skillId`, `bundleId`, and `leaseJti`.
- The server does not trust client-supplied commercial IDs for accepted direct usage.
- The legacy API-key upload path remains available for CLI/manual fallback flows.
