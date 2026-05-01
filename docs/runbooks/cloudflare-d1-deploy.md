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
- optional Skillpack shared API key value for shared-key or hybrid automation, generated below

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

## Management Auth Modes

Protected Skillpack management routes can authenticate in three modes:

| Mode | `SKILLPACK_MANAGEMENT_AUTH_MODE` | Best for | Required auth material |
| --- | --- | --- | --- |
| Shared key | `shared-key` | self-hosted and simple automation | `SKILLPACK_API_KEY` |
| Clerk | `clerk` | hosted dashboard-only operation | `CLERK_SECRET_KEY` on API and dashboard Clerk keys |
| Hybrid | `hybrid` | hosted default | `CLERK_SECRET_KEY`; optional `SKILLPACK_API_KEY` for automation |

The deploy manifest defaults hosted deploys to `hybrid`. That means dashboard calls can use Clerk bearer tokens, while scripts can still use `SKILLPACK_API_KEY` if you choose to set one.

`SKILLPACK_API_KEY` is a Skillpack management bearer secret, not a Cloudflare credential. It protects Skillpack provider, customer, workspace, policy, usage, TSA, and billing management endpoints. It is unrelated to `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID`, which are not used by this terminal-first deploy flow.

## Generate The Optional API Key, Private Key, And Public Key

There is no hosted service that gives you these values. You create them.
Use production key filenames for hosted deploys. The `dev-private.pem` and
`dev-public.pem` paths are only for local demo/dev runs and `.dev.vars`.

From repo root:

```bash
mkdir -p .secrets/hosted
chmod 700 .secrets/hosted

openssl rand -base64 48 > .secrets/hosted/api-key.txt

openssl genpkey \
  -algorithm Ed25519 \
  -out .secrets/hosted/prod-private.pem

openssl pkey \
  -in .secrets/hosted/prod-private.pem \
  -pubout \
  -out .secrets/hosted/prod-public.pem

chmod 600 .secrets/hosted/api-key.txt
chmod 600 .secrets/hosted/prod-private.pem
chmod 644 .secrets/hosted/prod-public.pem
```

This creates:

| Generated file | What it is | To use as Cloudflare secret |
| --- | --- | --- |
| `.secrets/hosted/api-key.txt` | hosted API key | `SKILLPACK_API_KEY` for both Workers |
| `.secrets/hosted/prod-private.pem` | production Ed25519 private key | `SKILLPACK_SIGNING_PRIVATE_KEY_PEM` |
| `.secrets/hosted/prod-public.pem` | production Ed25519 public key | `SKILLPACK_SIGNING_PUBLIC_KEY_PEM` |

In `clerk` mode, you may skip `.secrets/hosted/api-key.txt`. In `hybrid` mode, keep it if you want CLI/CI smoke checks or other automation to call management endpoints without minting a Clerk session token.

The API Worker uses the key only in `shared-key` or `hybrid` mode. The dashboard Worker uses the key only in `shared-key` mode, or as a fallback in `hybrid` mode when a Clerk bearer token is not present.

The signing private key signs lease tokens. The signing public key verifies those tokens. The live API Worker and any bundle you use for the live direct-meter smoke must use the same key pair, or direct upload verification will fail.

Local dev smoke uses the ignored dev-key path and writes those dev keys into `.dev.vars`:

```bash
verticals/laws-consultant/distribution/keys/dev-private.pem
verticals/laws-consultant/distribution/keys/dev-public.pem
```

Production bundle builds must use the production key pair explicitly:

```bash
SKILLPACK_BUNDLE_PRIVATE_KEY_PATH=.secrets/hosted/prod-private.pem \
SKILLPACK_BUNDLE_PUBLIC_KEY_PATH=.secrets/hosted/prod-public.pem \
bun run bundle:laws-consultant
```

The live `.mcpb` smoke needs a bundle signed with the same production private key that the hosted API uses to issue and verify leases.

## Set Production Secrets

For `hybrid` or `shared-key`, set the same hosted API key value on both Workers:

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
bunx wrangler secret put CLERK_SECRET_KEY
bunx wrangler secret put SKILLPACK_SIGNING_PRIVATE_KEY_PEM < ../../.secrets/hosted/prod-private.pem
bunx wrangler secret put SKILLPACK_SIGNING_PUBLIC_KEY_PEM < ../../.secrets/hosted/prod-public.pem
```

What each secret does:

| Secret | Used by | Purpose |
| --- | --- | --- |
| `SKILLPACK_API_KEY` | API Worker | stores the hosted API key for protected API endpoints |
| `CLERK_SECRET_KEY` | API Worker | verifies Clerk bearer tokens for protected API endpoints in `clerk` or `hybrid` mode |
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
| `SKILLPACK_API_KEY` | Dashboard Worker | stores the same hosted API key for shared-key proxy calls and hybrid fallback |
| `CLERK_SECRET_KEY` | Dashboard Worker | verifies dashboard sessions server-side |
| `CLERK_PUBLISHABLE_KEY` | Dashboard Worker | configures Clerk in the browser |

The dashboard API key is not required in `clerk` mode. The browser sends a Clerk session token to the dashboard proxy, and the dashboard forwards that bearer token to the API Worker. Detached dashboard flows that only inspect local files, exported state, prepared artifacts, cached data, or operator-provided inputs do not require the backend at all.

Optional dashboard auth URLs can be added later as Worker vars if needed:

```txt
SKILLPACK_CLERK_SIGN_IN_URL
SKILLPACK_CLERK_SIGN_UP_URL
```

They are not required for the current smoke tests.

## Production Deploy From Your Machine

This path deploys to Cloudflare remote Workers and remote D1. It is separate from
local dev smoke, which uses `wrangler dev --local` and local D1 state only.
Deployment is terminal-first: authenticate Wrangler locally with `bunx wrangler login`.
Do not create or pass `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` for this flow.

## After Merge Deployment Checklist

After this PR is merged to `main`, deploy from a local terminal:

```bash
git checkout main
git pull --ff-only origin main
bun install
bunx wrangler login

export API_BASE_URL="https://skillpack-api.opensocialforall.workers.dev"
export DASHBOARD_ORIGIN="https://skillpack-dashboard.opensocialforall.workers.dev"
```

Then follow the one-time secret setup below if any values are new or rotated, run
the deploy wrapper, and run the live smoke command. For hosted deployments, keep
`managementAuthMode` as `hybrid` unless you intentionally want `clerk` only or
`shared-key` only.

From repo root:

```bash
bun install
bunx wrangler login

export API_BASE_URL="https://skillpack-api.opensocialforall.workers.dev"
export DASHBOARD_ORIGIN="https://skillpack-dashboard.opensocialforall.workers.dev"

# One-time, or whenever secrets rotate:
(cd apps/api && bunx wrangler secret put SKILLPACK_API_KEY < ../../.secrets/hosted/api-key.txt)
(cd apps/api && bunx wrangler secret put CLERK_SECRET_KEY)
(cd apps/api && bunx wrangler secret put SKILLPACK_SIGNING_PRIVATE_KEY_PEM < ../../.secrets/hosted/prod-private.pem)
(cd apps/api && bunx wrangler secret put SKILLPACK_SIGNING_PUBLIC_KEY_PEM < ../../.secrets/hosted/prod-public.pem)
(cd apps/dashboard && bunx wrangler secret put SKILLPACK_API_KEY < ../../.secrets/hosted/api-key.txt)
(cd apps/dashboard && bunx wrangler secret put CLERK_SECRET_KEY)
(cd apps/dashboard && bunx wrangler secret put CLERK_PUBLISHABLE_KEY)

# Deploy API + dashboard together with matching public bindings:
bun scripts/deploy/deploy-hosted-control-plane.mjs \
  '{"apiPublicBaseUrl":"'"$API_BASE_URL"'","dashboardPublicOrigin":"'"$DASHBOARD_ORIGIN"'","managementAuthMode":"hybrid"}'

# Verify the live hosted pair:
bun scripts/deploy/smoke-hosted-control-plane.mjs \
  --api-base-url="$API_BASE_URL" \
  --dashboard-base-url="$DASHBOARD_ORIGIN" \
  --api-key="$(cat .secrets/hosted/api-key.txt)"
```

To verify a Clerk-only API deployment instead, pass a short-lived Clerk bearer token:

```bash
bun scripts/deploy/smoke-hosted-control-plane.mjs \
  --api-base-url="$API_BASE_URL" \
  --dashboard-base-url="$DASHBOARD_ORIGIN" \
  --api-auth-header="Bearer <short-lived Clerk session token>"
```

The deploy wrapper:

1. reads `deploy/hosted-control-plane.manifest.json`
2. generates Wrangler config files with the correct public vars
3. runs remote D1 migrations for `apps/api`
4. deploys `skillpack-api`
5. deploys `skillpack-dashboard`

Generated Wrangler config files are temporary and are written beside each app's
source `wrangler.jsonc` so relative entrypoints like `src/index.js` resolve from
the app root. They are deleted after each deploy attempt.

## Optional GitHub Smoke After Terminal Deploy

The workflow is:

```txt
.github/workflows/deploy-hosted-control-plane.yml
```

This workflow does not deploy to Cloudflare. It verifies an already-deployed hosted
pair after you deploy from a terminal with Wrangler.

Set these repository variables if you want GitHub to run the smoke check:

```txt
SKILLPACK_API_BASE_URL=https://skillpack-api.opensocialforall.workers.dev
SKILLPACK_DASHBOARD_ORIGIN=https://skillpack-dashboard.opensocialforall.workers.dev
```

Set one of these repository secrets for API smoke auth:

```txt
SKILLPACK_API_KEY=<same Skillpack management key stored in the Workers>
SMOKE_API_AUTH_HEADER=Bearer <short-lived Clerk session token>
```

Optional repository secret for a live Clerk-authenticated dashboard proxy check:

```txt
SMOKE_DASHBOARD_AUTH_HEADER=Bearer <short-lived Clerk session token>
```

If `SMOKE_DASHBOARD_AUTH_HEADER` is absent, CI still verifies dashboard health,
`/app-config`, and the full hosted API lifecycle through whichever API auth
secret you configured. If it is present, the smoke runner also calls the
dashboard proxy at `/api/v1/providers` with that auth header.

The workflow runs `scripts/deploy/check-hosted-deploy-env.mjs` before smoke verification.
If any required variable or API auth secret is missing, it fails with
`hosted_deploy_missing_configuration:<names>`.

Trigger manually:

```bash
gh workflow run deploy-hosted-control-plane.yml
```

## Live Smoke Test

After deploy, verify both Workers are reachable and wired:

```bash
bun scripts/deploy/smoke-hosted-control-plane.mjs \
  --api-base-url="$API_BASE_URL" \
  --dashboard-base-url="$DASHBOARD_ORIGIN" \
  --api-key="<SKILLPACK_API_KEY>"
```

For Clerk-only API auth:

```bash
bun scripts/deploy/smoke-hosted-control-plane.mjs \
  --api-base-url="$API_BASE_URL" \
  --dashboard-base-url="$DASHBOARD_ORIGIN" \
  --api-auth-header="Bearer <short-lived Clerk session token>"
```

This checks:

- API `/healthz`
- dashboard `/healthz`
- dashboard `/app-config`
- dashboard API wiring
- Clerk backend secret presence
- hosted API auth access by `SKILLPACK_API_KEY` or Clerk bearer token
- provider/customer/workspace creation
- policy issue
- meter upload
- usage summary
- billing pricing-rule creation
- billing invoice draft
- dashboard proxy `/api/v1/providers` when `--dashboard-auth-header` is supplied

Expected output:

```json
{ "ok": true }
```

To include the authenticated dashboard proxy check:

```bash
bun scripts/deploy/smoke-hosted-control-plane.mjs \
  --api-base-url="$API_BASE_URL" \
  --dashboard-base-url="$DASHBOARD_ORIGIN" \
  --api-auth-header="Bearer <short-lived Clerk session token>" \
  --dashboard-auth-header="Bearer <short-lived Clerk session token>"
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

## Local Dev Smoke Test

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

This does not deploy anything to Cloudflare. If Wrangler says `Resource location:
local`, you are in the local-dev path, not the production deploy path.

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

### `api_auth_header_failed:401`

The Clerk bearer token passed to the smoke script was rejected by the API Worker.

Check that:

- the API Worker has `CLERK_SECRET_KEY` set
- the deployed auth mode is `clerk` or `hybrid`
- the bearer token is current and belongs to the same Clerk app
- `SKILLPACK_DASHBOARD_ORIGIN` matches the origin authorized for the request

### `dashboard_config_missing_api_base_url`

The dashboard deploy did not receive `SKILLPACK_API_BASE_URL`.

Deploy through:

```bash
bun scripts/deploy/deploy-hosted-control-plane.mjs \
  '{"apiPublicBaseUrl":"'"$API_BASE_URL"'","dashboardPublicOrigin":"'"$DASHBOARD_ORIGIN"'","managementAuthMode":"hybrid"}'
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
