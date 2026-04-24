# Hosted Deploy + Local Meter Client (Direct Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a manifest-driven hosted control-plane deploy path and a bundle-local direct-mode meter client so we can verify end-to-end hosted usage sync without relying on the operator CLI for meter upload.

**Architecture:** Use a single deploy manifest to define the API/dashboard env contract and resolve all worker wiring from a small set of environment-specific inputs, minimizing secret and var drift. In parallel, bind direct meter upload to signed lease commercial context so the server derives accepted usage identity from the lease, then move the bundle-local meter flow into dedicated `.mjs` helper modules that use only Node built-ins and can be copied into release artifacts unchanged.

**Tech Stack:** Bun/JavaScript monorepo, Cloudflare Workers + D1 + Wrangler, GitHub Actions, existing `@skillpack/core` and `@skillpack/protocol` packages, Node bundle server.

---

## Scope Check

This plan intentionally covers two tightly-coupled deliverables:

1. hosted `skillpack control plane` deployability
2. bundle-local `local meter client` direct mode

These belong in one plan because:

- the direct-mode client needs a real hosted target
- the hosted deploy lane needs a smoke path that proves usage arrives without the operator manually calling `skillpack meter upload`

Out of scope for this plan:

- `Skillpack Edge Gateway`
- `Vendor Self-Host Control Plane`
- billing and invoice generation
- premium dashboard surfaces

Those should become follow-on plan docs after this hosted baseline verifies successfully.

## File Structure

- Create: `deploy/hosted-control-plane.manifest.json`
- Create: `scripts/deploy/resolve-hosted-manifest.mjs`
- Create: `scripts/deploy/resolve-hosted-manifest.test.js`
- Create: `scripts/deploy/deploy-hosted-control-plane.mjs`
- Create: `scripts/deploy/smoke-hosted-control-plane.mjs`
- Create: `scripts/deploy/smoke-hosted-control-plane.test.js`
- Create: `.github/workflows/deploy-hosted-control-plane.yml`
- Modify: `apps/api/wrangler.jsonc`
- Modify: `apps/dashboard/wrangler.jsonc`
- Modify: `scripts/demo-cloudflare-local-e2e.sh`
- Modify: `scripts/demo-cloudflare-e2e.sh`
- Modify: `packages/protocol/src/index.js`
- Modify: `packages/protocol/src/commercial.js`
- Modify: `packages/protocol/test/commercial.test.js`
- Modify: `packages/core/src/server.js`
- Modify: `packages/core/test/commercial-management.test.js`
- Modify: `apps/api/test/worker.test.js`
- Create: `packages/runtime/src/runtime-meter.mjs`
- Create: `packages/runtime/src/local-meter-client.mjs`
- Create: `packages/runtime/src/meter-store.mjs`
- Create: `packages/runtime/src/direct-upload-transport.mjs`
- Create: `packages/runtime/test/local-meter-client.test.mjs`
- Modify: `packages/runtime/src/index.js`
- Modify: `packages/runtime/src/server.mjs`
- Modify: `scripts/bundle-laws-consultant.mjs`
- Modify: `docs/runbooks/cloudflare-d1-deploy.md`
- Modify: `README.md`

### Responsibility Map

- `deploy/hosted-control-plane.manifest.json`: source of truth for deployables, required inputs, public var bindings, and secret names.
- `scripts/deploy/resolve-hosted-manifest.mjs`: validate manifest + environment inputs and emit resolved deploy config for local scripts and CI.
- `scripts/deploy/deploy-hosted-control-plane.mjs`: consume resolved manifest output, materialize temporary Wrangler config with manifest-owned public vars, verify required secrets are present, run remote D1 migrations, and deploy both workers from the same contract.
- `scripts/deploy/smoke-hosted-control-plane.mjs`: smoke the real API/dashboard pair and verify the hosted contract is wired correctly.
- `packages/protocol/src/commercial.js`: define direct-mode upload contract and lease-bound accepted-usage rules.
- `packages/core/src/server.js`: issue leases with signed commercial context and accept direct-mode meter uploads only when the lease-bound identity matches.
- `packages/runtime/src/*.mjs`: bundle-local helper modules copied into the release artifact and imported by `server.mjs` without requiring workspace package resolution or `fetch`, while preserving the current persisted meter chain and retry spool semantics across restarts.

---

### Task 1: Add A Manifest-Driven Hosted Deploy Contract

**Files:**
- Create: `deploy/hosted-control-plane.manifest.json`
- Create: `scripts/deploy/resolve-hosted-manifest.mjs`
- Create: `scripts/deploy/resolve-hosted-manifest.test.js`
- Create: `scripts/deploy/deploy-hosted-control-plane.mjs`
- Modify: `apps/api/wrangler.jsonc`
- Modify: `apps/dashboard/wrangler.jsonc`

- [ ] **Step 1: Write the failing manifest resolver test**

```js
// scripts/deploy/resolve-hosted-manifest.test.js
import { describe, expect, test } from "bun:test";
import { resolveHostedManifest } from "./resolve-hosted-manifest.mjs";

describe("resolveHostedManifest", () => {
  test("binds worker vars from explicit manifest inputs", () => {
    const manifest = {
      schemaVersion: 1,
      inputs: {
        apiPublicBaseUrl: { required: true },
        dashboardPublicOrigin: { required: true },
      },
      deployables: {
        api: {
          workdir: "apps/api",
          wranglerConfig: "apps/api/wrangler.jsonc",
          publicVars: {
            SKILLPACK_DASHBOARD_ORIGIN: { fromInput: "dashboardPublicOrigin" },
          },
          secrets: [
            "SKILLPACK_MANAGEMENT_API_KEY",
            "SKILLPACK_SIGNING_PRIVATE_KEY_PEM",
            "SKILLPACK_SIGNING_PUBLIC_KEY_PEM",
          ],
        },
        dashboard: {
          workdir: "apps/dashboard",
          wranglerConfig: "apps/dashboard/wrangler.jsonc",
          publicVars: {
            SKILLPACK_API_BASE_URL: { fromInput: "apiPublicBaseUrl" },
            SKILLPACK_DASHBOARD_ORIGIN: { fromInput: "dashboardPublicOrigin" },
          },
          secrets: [
            "SKILLPACK_API_MANAGEMENT_KEY",
            "CLERK_SECRET_KEY",
            "CLERK_PUBLISHABLE_KEY",
          ],
        },
      },
    };

    const resolved = resolveHostedManifest(manifest, {
      apiPublicBaseUrl: "https://skillpack-api.example.workers.dev",
      dashboardPublicOrigin: "https://skillpack-dashboard.example.workers.dev",
    });

    expect(resolved.deployables.api.publicVars.SKILLPACK_DASHBOARD_ORIGIN).toBe(
      "https://skillpack-dashboard.example.workers.dev"
    );
    expect(resolved.deployables.dashboard.publicVars.SKILLPACK_API_BASE_URL).toBe(
      "https://skillpack-api.example.workers.dev"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/deploy/resolve-hosted-manifest.test.js`
Expected: FAIL with module/function not found for `resolveHostedManifest`.

- [ ] **Step 3: Write the manifest + resolver**

```json
// deploy/hosted-control-plane.manifest.json
{
  "schemaVersion": 1,
  "inputs": {
    "apiPublicBaseUrl": { "required": true },
    "dashboardPublicOrigin": { "required": true }
  },
  "deployables": {
    "api": {
      "workdir": "apps/api",
      "wranglerConfig": "apps/api/wrangler.jsonc",
      "publicVars": {
        "SKILLPACK_DASHBOARD_ORIGIN": { "fromInput": "dashboardPublicOrigin" }
      },
      "secrets": [
        "SKILLPACK_MANAGEMENT_API_KEY",
        "SKILLPACK_SIGNING_PRIVATE_KEY_PEM",
        "SKILLPACK_SIGNING_PUBLIC_KEY_PEM"
      ]
    },
    "dashboard": {
      "workdir": "apps/dashboard",
      "wranglerConfig": "apps/dashboard/wrangler.jsonc",
      "publicVars": {
        "SKILLPACK_API_BASE_URL": { "fromInput": "apiPublicBaseUrl" },
        "SKILLPACK_DASHBOARD_ORIGIN": { "fromInput": "dashboardPublicOrigin" }
      },
      "secrets": [
        "SKILLPACK_API_MANAGEMENT_KEY",
        "CLERK_SECRET_KEY",
        "CLERK_PUBLISHABLE_KEY"
      ]
    }
  }
}
```

```js
// scripts/deploy/resolve-hosted-manifest.mjs
import fs from "node:fs";

export function resolveHostedManifest(manifest, inputs) {
  const resolved = {};
  for (const [name, deployable] of Object.entries(manifest.deployables ?? {})) {
    const publicVars = {};
    for (const [key, binding] of Object.entries(deployable.publicVars ?? {})) {
      const value = inputs?.[binding.fromInput];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`deploy_manifest_missing_input:${binding.fromInput}`);
      }
      publicVars[key] = value;
    }
    resolved[name] = {
      ...deployable,
      publicVars,
      secrets: [...(deployable.secrets ?? [])],
    };
  }
  return { deployables: resolved };
}

if (import.meta.main) {
  const manifestPath = process.argv[2];
  const inputsJson = process.argv[3];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const inputs = JSON.parse(inputsJson);
  process.stdout.write(JSON.stringify(resolveHostedManifest(manifest, inputs), null, 2) + "\n");
}
```

- [ ] **Step 4: Add a deploy wrapper that enforces the manifest contract**

```js
// scripts/deploy/deploy-hosted-control-plane.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveHostedManifest } from "./resolve-hosted-manifest.mjs";

function requireSecretEnv(secretName) {
  const value = process.env[secretName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`deploy_manifest_missing_secret_env:${secretName}`);
  }
  return value;
}

function deployWithResolvedVars({ rootDir, deployableName, deployable }) {
  for (const secretName of deployable.secrets ?? []) {
    requireSecretEnv(secretName);
  }

  const sourceConfigPath = path.join(rootDir, deployable.wranglerConfig);
  const sourceConfig = JSON.parse(fs.readFileSync(sourceConfigPath, "utf8"));
  const mergedConfig = {
    ...sourceConfig,
    vars: {
      ...(sourceConfig.vars ?? {}),
      ...(deployable.publicVars ?? {}),
    },
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `skillpack-${deployableName}-`));
  const tempConfigPath = path.join(tempDir, "wrangler.generated.json");
  fs.writeFileSync(tempConfigPath, JSON.stringify(mergedConfig, null, 2));

  if (deployableName === "api") {
    const migrate = spawnSync("bun", ["run", "--cwd", deployable.workdir, "d1:migrate:remote"], {
      cwd: rootDir,
      stdio: "inherit",
      env: process.env,
    });
    if (migrate.status !== 0) {
      throw new Error("deploy_api_remote_migration_failed");
    }
  }

  const deploy = spawnSync(
    "bunx",
    ["wrangler", "deploy", "--cwd", deployable.workdir, "--config", tempConfigPath],
    {
      cwd: rootDir,
      stdio: "inherit",
      env: process.env,
    }
  );
  if (deploy.status !== 0) {
    throw new Error(`deploy_failed:${deployableName}`);
  }
}

if (import.meta.main) {
  const rootDir = process.cwd();
  const manifest = JSON.parse(fs.readFileSync("deploy/hosted-control-plane.manifest.json", "utf8"));
  const inputs = JSON.parse(process.argv[2]);
  const resolved = resolveHostedManifest(manifest, inputs);
  for (const [name, deployable] of Object.entries(resolved.deployables)) {
    deployWithResolvedVars({ rootDir, deployableName: name, deployable });
  }
}
```

- [ ] **Step 5: Align Wrangler config comments with the manifest contract**

```jsonc
// apps/api/wrangler.jsonc
{
  "name": "skillpack-api",
  "main": "src/index.js",
  "compatibility_date": "2026-04-22",
  "compatibility_flags": ["nodejs_compat"],

  // Public vars and secrets are resolved from deploy/hosted-control-plane.manifest.json
  // so the API/dashboard contract lives in one place.
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "skillpack-license",
      "database_id": "REPLACE_WITH_D1_DATABASE_ID",
      "migrations_dir": "migrations"
    }
  ]
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test scripts/deploy/resolve-hosted-manifest.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add deploy/hosted-control-plane.manifest.json \
  scripts/deploy/resolve-hosted-manifest.mjs \
  scripts/deploy/resolve-hosted-manifest.test.js \
  scripts/deploy/deploy-hosted-control-plane.mjs \
  apps/api/wrangler.jsonc \
  apps/dashboard/wrangler.jsonc
git commit -m "build: add manifest-driven hosted deploy contract"
```

---

### Task 2: Add A Real Hosted Deploy Workflow + Local Two-Worker Smoke

**Files:**
- Create: `scripts/deploy/deploy-hosted-control-plane.mjs`
- Create: `scripts/deploy/smoke-hosted-control-plane.mjs`
- Create: `scripts/deploy/smoke-hosted-control-plane.test.js`
- Create: `.github/workflows/deploy-hosted-control-plane.yml`
- Modify: `scripts/demo-cloudflare-local-e2e.sh`
- Modify: `scripts/demo-cloudflare-e2e.sh`

- [ ] **Step 1: Write the failing smoke test**

```js
// scripts/deploy/smoke-hosted-control-plane.test.js
import { describe, expect, test } from "bun:test";
import { smokeHostedControlPlane } from "./smoke-hosted-control-plane.mjs";

describe("smokeHostedControlPlane", () => {
  test("surfaces api health failure", async () => {
    await expect(
      smokeHostedControlPlane({
        apiBaseUrl: "http://127.0.0.1:9",
        dashboardBaseUrl: "http://127.0.0.1:9",
        managementApiKey: "dev-key",
      })
    ).rejects.toThrow(/ECONNREFUSED|fetch failed|connect/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/deploy/smoke-hosted-control-plane.test.js`
Expected: FAIL because `smokeHostedControlPlane` is missing.

- [ ] **Step 3: Write the smoke runner**

```js
// scripts/deploy/smoke-hosted-control-plane.mjs
export async function smokeHostedControlPlane({
  apiBaseUrl,
  dashboardBaseUrl,
  managementApiKey,
  fetchImpl = fetch,
}) {
  const apiHealth = await fetchImpl(`${apiBaseUrl}/healthz`);
  if (!apiHealth.ok) throw new Error(`api_health_failed:${apiHealth.status}`);

  const dashboardHealth = await fetchImpl(`${dashboardBaseUrl}/healthz`);
  if (!dashboardHealth.ok) throw new Error(`dashboard_health_failed:${dashboardHealth.status}`);

  const configRes = await fetchImpl(`${dashboardBaseUrl}/app-config`);
  const config = await configRes.json();
  if (config.apiProxyBase !== "/api") throw new Error("dashboard_config_invalid_proxy_base");

  const providersRes = await fetchImpl(`${apiBaseUrl}/v1/providers`, {
    headers: { "x-api-key": managementApiKey },
  });
  if (!providersRes.ok) throw new Error(`api_management_failed:${providersRes.status}`);

  return { ok: true };
}

if (import.meta.main) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [k, v] = arg.replace(/^--/, "").split("=");
      return [k, v];
    })
  );
  await smokeHostedControlPlane({
    apiBaseUrl: args["api-base-url"],
    dashboardBaseUrl: args["dashboard-base-url"],
    managementApiKey: args["management-api-key"],
  });
  console.log(JSON.stringify({ ok: true }));
}
```

- [ ] **Step 4: Update the local smoke script to launch both workers**

```bash
# scripts/demo-cloudflare-local-e2e.sh
API_DIR="$ROOT_DIR/apps/api"
DASHBOARD_DIR="$ROOT_DIR/apps/dashboard"
API_PORT="${API_PORT:-8787}"
DASHBOARD_PORT="${DASHBOARD_PORT:-8788}"
API_URL="http://$HOST:$API_PORT"
DASHBOARD_URL="http://$HOST:$DASHBOARD_PORT"

cat > "$API_DIR/.dev.vars" <<EOF
SKILLPACK_MANAGEMENT_API_KEY=$API_KEY
SKILLPACK_SIGNING_PRIVATE_KEY_PEM_BASE64=$PRIVATE_KEY_B64
SKILLPACK_SIGNING_PUBLIC_KEY_PEM_BASE64=$PUBLIC_KEY_B64
SKILLPACK_DASHBOARD_ORIGIN=$DASHBOARD_URL
EOF

(
  cd "$API_DIR"
  bun run d1:migrate:local
) >/dev/null

(
  cd "$API_DIR"
  bunx wrangler dev --local --port "$API_PORT"
) >"$ROOT_DIR/.context/cloudflare-api-local.log" 2>&1 &
API_PID=$!

cat > "$DASHBOARD_DIR/.dev.vars" <<EOF
SKILLPACK_API_BASE_URL=$API_URL
SKILLPACK_DASHBOARD_ORIGIN=$DASHBOARD_URL
SKILLPACK_API_MANAGEMENT_KEY=$API_KEY
CLERK_PUBLISHABLE_KEY=pk_test_local_placeholder
CLERK_SECRET_KEY=sk_test_local_placeholder
EOF

(
  cd "$DASHBOARD_DIR"
  bunx wrangler dev --local --port "$DASHBOARD_PORT"
) >"$ROOT_DIR/.context/cloudflare-dashboard-local.log" 2>&1 &
DASHBOARD_PID=$!
```

- [ ] **Step 5: Add the deploy workflow using manifest inputs**

```yaml
# .github/workflows/deploy-hosted-control-plane.yml
name: Deploy Hosted Control Plane

on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      API_BASE_URL: ${{ vars.SKILLPACK_API_BASE_URL }}
      DASHBOARD_ORIGIN: ${{ vars.SKILLPACK_DASHBOARD_ORIGIN }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
      - run: bun test apps/api/test/worker.test.js apps/dashboard/test/worker.test.js
      - run: >
          bun scripts/deploy/deploy-hosted-control-plane.mjs
          "{\"apiPublicBaseUrl\":\"${API_BASE_URL}\",\"dashboardPublicOrigin\":\"${DASHBOARD_ORIGIN}\"}"
      - run: >
          bun scripts/deploy/smoke-hosted-control-plane.mjs
          --api-base-url=${API_BASE_URL}
          --dashboard-base-url=${DASHBOARD_ORIGIN}
          --management-api-key=${{ secrets.SKILLPACK_MANAGEMENT_API_KEY }}
```

- [ ] **Step 6: Run verification**

Run: `API_KEY=dev-management-key ./scripts/demo-cloudflare-local-e2e.sh`
Expected: PASS with both workers healthy and smoke runner succeeding.

- [ ] **Step 7: Commit**

```bash
git add scripts/deploy/smoke-hosted-control-plane.mjs \
  scripts/deploy/smoke-hosted-control-plane.test.js \
  scripts/deploy/deploy-hosted-control-plane.mjs \
  .github/workflows/deploy-hosted-control-plane.yml \
  scripts/demo-cloudflare-local-e2e.sh \
  scripts/demo-cloudflare-e2e.sh
git commit -m "ci: deploy hosted control plane and verify worker pair"
```

---

### Task 3: Bind Direct Upload To Signed Lease Commercial Context

**Files:**
- Modify: `packages/protocol/src/commercial.js`
- Modify: `packages/protocol/src/index.js`
- Modify: `packages/protocol/test/commercial.test.js`
- Modify: `packages/core/src/server.js`
- Modify: `packages/core/test/commercial-management.test.js`
- Modify: `apps/api/test/worker.test.js`

- [ ] **Step 1: Write the failing lease-context test**

```js
// packages/core/test/commercial-management.test.js
test("direct meter upload derives accepted usage context from the lease", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: "mgmt-key",
  });

  await fetch(new Request("http://local/v1/providers", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "mgmt-key" },
    body: JSON.stringify({ providerId: "prov-1", name: "Provider One" }),
  }));
  await fetch(new Request("http://local/v1/providers/prov-1/customers", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "mgmt-key" },
    body: JSON.stringify({ customerId: "cust-1", name: "Customer One" }),
  }));
  await fetch(new Request("http://local/v1/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "mgmt-key" },
    body: JSON.stringify({
      workspaceId: "ws-1",
      providerId: "prov-1",
      customerId: "cust-1",
      name: "Workspace One",
    }),
  }));

  const leaseIssue = await fetch(new Request("http://local/v1/leases/issue", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "mgmt-key" },
    body: JSON.stringify({
      customerId: "cust-1",
      seatId: "seat-1",
      providerId: "prov-1",
      workspaceId: "ws-1",
      skillId: "laws-consultant",
      bundleId: "laws-consultant-1.0.0",
    }),
  }));
  const { leaseToken } = await leaseIssue.json();

  const upload = await fetch(new Request("http://local/v1/meter/upload", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-skillpack-lease-token": leaseToken,
    },
    body: JSON.stringify({
      events: [
        {
          prevHash: "GENESIS",
          seq: 0,
          at: 1800000100,
          kind: "tool_call",
          seatId: "seat-1",
          tool: "wiki_search",
          usage: { unit: "tool_call", delta: 1 },
        },
      ],
    }),
  }));

  expect(upload.status).toBe(200);

  const summary = await fetch(new Request("http://local/v1/usage/summary?workspaceId=ws-1", {
    headers: { "x-api-key": "mgmt-key" },
  }));
  const body = await summary.json();
  expect(body.summary[0]).toMatchObject({
    providerId: "prov-1",
    customerId: "cust-1",
    workspaceId: "ws-1",
    bundleId: "laws-consultant-1.0.0",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/commercial-management.test.js -t "direct meter upload derives accepted usage context from the lease"`
Expected: FAIL because the lease does not currently carry signed commercial context and the upload route requires management auth.

- [ ] **Step 3: Extend the lease payload contract**

```js
// packages/protocol/src/commercial.js
export function validateDirectLeaseCommercialContext(payload) {
  for (const key of ["providerId", "workspaceId", "skillId", "bundleId"]) {
    if (typeof payload[key] !== "string" || payload[key].length === 0) {
      throw new Error(`lease_payload_missing_${key}`);
    }
  }
  return payload;
}
```

```js
// packages/protocol/src/index.js
export {
  validateDirectLeaseCommercialContext,
  validateDirectMeterUploadContract,
  validateMeterUploadContract,
} from "./commercial.js";
```

- [ ] **Step 4: Extend the direct upload contract so lease-authenticated uploads do not require client-supplied workspace context**

```js
// packages/protocol/src/commercial.js
export function validateDirectMeterUploadContract(payload, acceptedContext) {
  if (!isPlainObject(payload)) {
    throw new Error("meter_upload_invalid_body");
  }
  if (!Array.isArray(payload.events)) {
    throw new Error("meter_upload_missing_events");
  }
  const parsed = z
    .object({
      events: z.array(meterUploadEventSchema),
    })
    .strict()
    .safeParse(payload);
  if (!parsed.success) throw new Error("meter_upload_invalid_contract");
  const events = parsed.data.events
    .filter(isUsageEventCandidate)
    .map((event) => normalizeEvent(acceptedContext, event));
  return { workspaceId: acceptedContext.workspaceId, context: acceptedContext, events };
}
```

- [ ] **Step 5: Split operator upload auth from lease-bound direct upload auth**

```js
// packages/core/src/server.js
function authenticateDirectMeterUpload(request, signingPublicKeyPem, nowSec) {
  const leaseToken = request.headers.get("x-skillpack-lease-token");
  if (typeof leaseToken !== "string" || leaseToken.length === 0) {
    return null;
  }
  return verifyLeaseToken(leaseToken, signingPublicKeyPem, { nowSec });
}

function isManagementRoute(request, pathname) {
  // keep all existing management routes here EXCEPT /v1/meter/upload
}

if (request.method === "POST" && url.pathname === "/v1/leases/issue") {
  const body = await readBody(request);
  const payload = {
    iss: vendorId,
    sub: customerId,
    seatId,
    iat,
    exp: iat + ttlSec,
    jti: crypto.randomUUID(),
    leaseCounter: nextCounter,
    providerId: body.providerId,
    workspaceId: body.workspaceId,
    skillId: body.skillId,
    bundleId: body.bundleId,
  };
  validateDirectLeaseCommercialContext(payload);
}

if (request.method === "POST" && url.pathname === "/v1/meter/upload") {
  const directLease = authenticateDirectMeterUpload(request, signingPublicKeyPem, nowSec);
  if (directLease) {
    validated = validateDirectMeterUploadContract(await readBody(request), {
      providerId: directLease.providerId,
      customerId: directLease.sub,
      workspaceId: directLease.workspaceId,
      skillId: directLease.skillId,
      bundleId: directLease.bundleId,
      leaseJti: directLease.jti,
      seatId: directLease.seatId ?? "default",
    });
    await appendMeterEvents(validated.events);
    return json({ accepted: true, mode: "direct", ack: { count: validated.events.length } });
  }

  if (!managementApiKey) {
    return json({ error: "management_api_key_not_configured" }, 503);
  }
  if (!isValidManagementKey(request, managementApiKey)) {
    return json({ error: "unauthorized" }, 401);
  }
  validated = validateMeterUploadContract(await readBody(request));
  await appendMeterEvents(validated.events);
  return json({ accepted: true, mode: "management", ack: { count: validated.events.length } });
}
```

- [ ] **Step 6: Add protocol coverage for lease-bound normalization and tamper rejection**

```js
// packages/protocol/test/commercial.test.js
test("direct meter upload uses accepted lease context instead of client-supplied commercial ids", () => {
  const accepted = validateDirectMeterUploadContract(
    {
      events: [
        {
          prevHash: "GENESIS",
          seq: 0,
          at: 1800000100,
          kind: "tool_call",
          seatId: "seat-1",
          tool: "wiki_search",
          usage: { unit: "tool_call", delta: 1 },
          workspaceId: "client-forged-ws",
        },
      ],
    },
    {
      providerId: "prov-1",
      customerId: "cust-1",
      workspaceId: "ws-1",
      skillId: "laws-consultant",
      bundleId: "laws-consultant-1.0.0",
      leaseJti: "lease-jti-1",
      seatId: "seat-1",
    }
  );

  expect(accepted.events[0]).toMatchObject({
    providerId: "prov-1",
    customerId: "cust-1",
    workspaceId: "ws-1",
    bundleId: "laws-consultant-1.0.0",
  });
});
```

- [ ] **Step 7: Add worker coverage for the lease-bound path**

```js
// apps/api/test/worker.test.js
test("worker: meter upload with x-skillpack-lease-token ignores client context and uses lease context", async () => {
  // issue lease through worker with providerId/workspaceId/skillId/bundleId
  // upload events with forged provider/workspace ids in the body
  // assert summary row uses only the signed lease values
});
```

- [ ] **Step 8: Add server coverage for legacy management upload auth**

```js
// packages/core/test/commercial-management.test.js
test("management meter upload still requires x-api-key when no lease token is present", async () => {
  // existing operator-upload path remains available for CLI/manual fallback
});
```

- [ ] **Step 9: Run targeted tests**

Run: `bun test packages/protocol/test/commercial.test.js packages/core/test/commercial-management.test.js apps/api/test/worker.test.js`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/protocol/src/commercial.js \
  packages/protocol/src/index.js \
  packages/protocol/test/commercial.test.js \
  packages/core/src/server.js \
  packages/core/test/commercial-management.test.js \
  apps/api/test/worker.test.js
git commit -m "feat: bind direct meter upload to signed lease context"
```

---

### Task 4: Extract The Bundle-Local Meter Client Into Copyable `.mjs` Units

**Files:**
- Create: `packages/runtime/src/runtime-meter.mjs`
- Create: `packages/runtime/src/local-meter-client.mjs`
- Create: `packages/runtime/src/meter-store.mjs`
- Create: `packages/runtime/src/direct-upload-transport.mjs`
- Create: `packages/runtime/test/local-meter-client.test.mjs`
- Modify: `packages/runtime/src/index.js`

- [ ] **Step 1: Write the failing local meter client test**

```js
// packages/runtime/test/local-meter-client.test.mjs
import { describe, expect, test } from "bun:test";
const { createLocalMeterClient } = await import("../src/local-meter-client.mjs");

describe("createLocalMeterClient", () => {
  test("keeps pending events when upload fails and clears them after retry", async () => {
    const uploads = [];
    const store = await import("../src/meter-store.mjs").then((m) => m.createMemoryMeterStore());
    let fail = true;
    const transport = {
      async upload(batch) {
        if (fail) throw new Error("offline");
        uploads.push(batch);
      },
    };

    const client = createLocalMeterClient({
      chainKey: "ZmFrZS1jaGFpbi1rZXk",
      leaseToken: "lease-token",
      context: { workspaceId: "ws-1" },
      meterStore: store,
      transport,
      now: () => 1800000100,
    });

    await client.appendAndFlush("tool_call", {
      seatId: "seat-1",
      tool: "wiki_search",
      usage: { unit: "tool_call", delta: 1 },
    });
    expect(client.getPendingEvents()).toHaveLength(1);

    const restarted = createLocalMeterClient({
      chainKey: "ZmFrZS1jaGFpbi1rZXk",
      leaseToken: "lease-token",
      context: { workspaceId: "ws-1" },
      meterStore: store,
      transport,
      now: () => 1800000101,
    });
    expect(restarted.getPendingEvents()).toHaveLength(1);

    fail = false;
    await restarted.flushPending();
    expect(restarted.getPendingEvents()).toHaveLength(0);
    expect(uploads).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runtime/test/local-meter-client.test.mjs`
Expected: FAIL because the `.mjs` helpers do not exist yet.

- [ ] **Step 3: Write the built-in-safe helper modules**

```js
// packages/runtime/src/runtime-meter.mjs
import crypto from "node:crypto";

export const GENESIS_HASH = "GENESIS";

export function chainMeterEvent({ prevHash, seq, at, kind, data }, chainKeyB64) {
  const payload = { prevHash, seq, at, kind, data };
  const hmac = crypto.createHmac("sha256", Buffer.from(chainKeyB64, "base64"))
    .update(JSON.stringify(payload))
    .digest("base64");
  return { ...payload, hash: hmac };
}

export function createRuntimeMeter({ chainKey, startSeq = 0, startPrevHash = GENESIS_HASH }) {
  let seq = startSeq;
  let prevHash = startPrevHash;
  return {
    append(kind, data, at) {
      const event = chainMeterEvent({ prevHash, seq, at, kind, data }, chainKey);
      prevHash = event.hash;
      seq += 1;
      return event;
    },
    state() {
      return { seq, prevHash };
    },
  };
}
```

```js
// packages/runtime/src/local-meter-client.mjs
import { createRuntimeMeter } from "./runtime-meter.mjs";

export function createLocalMeterClient({ chainKey, leaseToken, context, meterStore, transport, now }) {
  const restored = meterStore.readState();
  const meter = createRuntimeMeter({
    chainKey: restored?.chainKey ?? chainKey,
    startSeq: restored?.seq ?? 0,
    startPrevHash: restored?.prevHash ?? "GENESIS",
  });
  const pending = [...(meterStore.listPendingEvents() ?? [])];

  function persistState() {
    const state = meter.state();
    meterStore.writeState({
      chainKey: restored?.chainKey ?? chainKey,
      seq: state.seq,
      prevHash: state.prevHash,
    });
  }

  async function appendAndFlush(kind, data) {
    const event = meter.append(kind, data, now());
    pending.push(event);
    await meterStore.append(event);
    persistState();
    await flushPending();
    return event;
  }

  async function flushPending() {
    if (pending.length === 0) return;
    try {
      await transport.upload({ leaseToken, context, events: [...pending] });
      pending.length = 0;
      await meterStore.clearPending();
      persistState();
    } catch {
      // keep local spool
    }
  }

  return {
    appendAndFlush,
    flushPending,
    getPendingEvents: () => [...pending],
  };
}
```

- [ ] **Step 4: Define the meter store contract around restart-safe spool semantics**

```js
// packages/runtime/src/meter-store.mjs
export function createFileMeterStore({ meterLogPath, meterStatePath, currentLeaseJti }) {
  // append events to meterLogPath
  // persist chain state + leaseJti to meterStatePath
  // on startup, restore seq/prevHash/current pending events for the active lease
  // if leaseJti changed, rotate to a fresh chain but retain still-pending prior uploads until they are acknowledged or archived
}
```

- [ ] **Step 5: Update the package export without creating an import cycle**

```js
// packages/runtime/src/index.js
export { createRuntimeMeter } from "./runtime-meter.mjs";
```

- [ ] **Step 6: Run targeted tests**

Run: `bun test packages/runtime/test/runtime.test.js packages/runtime/test/local-meter-client.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/runtime-meter.mjs \
  packages/runtime/src/local-meter-client.mjs \
  packages/runtime/src/meter-store.mjs \
  packages/runtime/src/direct-upload-transport.mjs \
  packages/runtime/test/local-meter-client.test.mjs \
  packages/runtime/src/index.js
git commit -m "feat: extract bundle-local meter client helpers"
```

---

### Task 5: Wire Direct Mode Into The Bundle Server Without Raising The Node Requirement

**Files:**
- Modify: `packages/runtime/src/server.mjs`
- Modify: `scripts/bundle-laws-consultant.mjs`
- Modify: `scripts/demo-cloudflare-e2e.sh`
- Modify: `scripts/demo-cloudflare-local-e2e.sh`

- [ ] **Step 1: Write the failing direct-mode server test**

```js
// packages/runtime/test/runtime.test.js
test("direct upload transport uses node built-ins and leaves spool intact on failure", async () => {
  const { createDirectUploadTransport } = await import("../src/direct-upload-transport.mjs");
  const transport = createDirectUploadTransport({
    baseUrl: "http://127.0.0.1:9",
  });

  await expect(
    transport.upload({
      leaseToken: "lease-token",
      context: { workspaceId: "ws-1" },
      events: [],
    })
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runtime/test/runtime.test.js -t "direct upload transport uses node built-ins"`
Expected: FAIL until the transport exists and is wired.

- [ ] **Step 3: Import the new helper modules in the bundle server**

```js
// packages/runtime/src/server.mjs
import { createLocalMeterClient } from "./local-meter-client.mjs";
import { createFileMeterStore } from "./meter-store.mjs";
import { createDirectUploadTransport, createNoopUploadTransport } from "./direct-upload-transport.mjs";

const directMode = process.env.SKILLPACK_SYNC_MODE === "direct";
const controlPlaneBaseUrl = process.env.SKILLPACK_CONTROL_PLANE_URL ?? null;

const localMeterClient = createLocalMeterClient({
  chainKey,
  leaseToken: licenseData.leaseToken,
  context: {
    workspaceId: leaseResult.payload.workspaceId,
    providerId: leaseResult.payload.providerId,
    customerId: leaseResult.payload.sub,
    skillId: leaseResult.payload.skillId,
    bundleId: leaseResult.payload.bundleId,
  },
  meterStore: createFileMeterStore({ meterLogPath, meterStatePath, currentLeaseJti }),
  transport: directMode && controlPlaneBaseUrl
    ? createDirectUploadTransport({ baseUrl: controlPlaneBaseUrl })
    : createNoopUploadTransport(),
  now: () => Math.floor(Date.now() / 1000),
});
```

- [ ] **Step 4: Replace runtime meter call sites with the new local client**

```js
// packages/runtime/src/server.mjs
async function recordMeterEvent(kind, data = {}) {
  return localMeterClient.appendAndFlush(kind, data);
}

await recordMeterEvent("session_start", {
  bundleId,
  version: manifest.version,
  sub: leaseResult.payload.sub,
  mode: leaseResult.mode,
});

await recordMeterEvent("tool_call", {
  tool: toolName,
  seatId: runtimeSeatId,
  policyId: policySnapshot?.policyId,
  decision: policyDecision.decision,
  reasonCodes: policyDecision.reasonCodes,
  usageUnit: "tool_call",
  usageDelta: 1,
});

process.on("SIGINT", async () => {
  await recordMeterEvent("session_end", { reason: "SIGINT" });
  await localMeterClient.flushPending();
  cleanup();
  process.exit(0);
});
```

- [ ] **Step 5: Copy the new `.mjs` helpers into the release artifact**

```js
// scripts/bundle-laws-consultant.mjs
for (const file of [
  "server.mjs",
  "server-util.mjs",
  "wiki-rag-shared.mjs",
  "runtime-meter.mjs",
  "local-meter-client.mjs",
  "meter-store.mjs",
  "direct-upload-transport.mjs",
]) {
  fs.copyFileSync(
    path.join(repoRoot, "packages", "runtime", "src", file),
    path.join(releaseRuntimeDir, file)
  );
}
```

- [ ] **Step 6: Add runtime coverage that direct mode flushes through the local client path**

```js
// packages/runtime/test/runtime.test.js
test("server direct mode records tool usage via the restart-safe local meter client", async () => {
  // assert the direct transport is invoked from the same path that appends local meter events
  // and that a failed upload leaves the spool intact for retry
});
```

- [ ] **Step 7: Update the hosted demo to verify direct mode without manual meter upload**

```bash
# scripts/demo-cloudflare-e2e.sh
echo "[3/5] invoke bundle with direct mode enabled"
printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wiki_search","arguments":{"query":"copyright","limit":1}}}\n' \
  | SKILLPACK_SYNC_MODE=direct \
    SKILLPACK_CONTROL_PLANE_URL="$SERVER_URL" \
    node "$RUNTIME_PATH" "$BUNDLE_PATH" "$PUBLIC_KEY_PATH" >/dev/null

echo "[4/5] fetch usage summary (no manual meter upload)"
SUMMARY_JSON="$(bun packages/cli/src/cli.js usage summary \
  --server-url "$SERVER_URL" --api-key "$API_KEY" \
  --workspace-id "$WORKSPACE_ID" --provider-id "$PROVIDER_ID")"
```

- [ ] **Step 8: Run end-to-end verification**

Run: `API_KEY=dev-management-key ./scripts/demo-cloudflare-local-e2e.sh`
Expected: PASS with usage showing up after a direct-mode tool call and no explicit `skillpack meter upload`.

- [ ] **Step 9: Commit**

```bash
git add packages/runtime/src/server.mjs \
  scripts/bundle-laws-consultant.mjs \
  scripts/demo-cloudflare-e2e.sh \
  scripts/demo-cloudflare-local-e2e.sh
git commit -m "feat: wire hosted direct mode into bundle server"
```

---

### Task 6: Update Docs To Match The Hosted + Direct-Mode Flow

**Files:**
- Modify: `docs/runbooks/cloudflare-d1-deploy.md`
- Modify: `README.md`
- Modify: `PRODUCT.md` only if naming drift remains after implementation

- [ ] **Step 1: Write the failing doc checklist**

```md
- Deploy docs reference `apps/api` and `apps/dashboard`, not the old package path.
- Docs explain that the deploy manifest resolves worker wiring from a small set of environment-specific inputs.
- Docs explain that direct mode authenticates with the embedded lease token and derives accepted usage identity from signed lease context.
- The hosted verification path shows usage arriving without a manual `skillpack meter upload`.
```

- [ ] **Step 2: Update the deploy runbook**

```md
## Hosted deploy contract

The source of truth for hosted deploy wiring is:

`deploy/hosted-control-plane.manifest.json`

Environment-specific values such as `apiPublicBaseUrl` and `dashboardPublicOrigin` are the only primitive inputs. Worker-to-worker env binding is resolved from the manifest.
```

- [ ] **Step 3: Update README flow description**

```md
Direct mode:

- the bundle-local local meter client appends to local meter files
- if `SKILLPACK_SYNC_MODE=direct` and `SKILLPACK_CONTROL_PLANE_URL` are configured, it uploads directly to the hosted control plane
- auth for direct upload uses the embedded lease token
- accepted usage identity is derived from signed lease context, not client-supplied upload metadata
```

- [ ] **Step 4: Verify docs are aligned**

Run: `rg -n "packages/license-server-worker|manual meter upload|x-api-key for direct" README.md docs/runbooks/cloudflare-d1-deploy.md`
Expected: only intentional references remain.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/cloudflare-d1-deploy.md README.md PRODUCT.md
git commit -m "docs: align hosted deploy and direct mode contract"
```

---

## Self-Review

### Spec coverage

- Manifest-driven hosted deploy contract: covered by Tasks 1-2.
- Direct mode local meter client: covered by Tasks 3-5.
- Verifiable hosted baseline without manual CLI upload: covered by Tasks 2 and 5.
- Edge gateway and vendor self-host control plane: intentionally deferred.

### Placeholder scan

- Removed hard-coded example URLs from the deploy contract itself.
- Removed undefined helper functions from the original plan and assigned each helper to a real file.
- Removed the implicit `fetch` dependency from the bundle server path.

### Type consistency

- `providerId`, `workspaceId`, `skillId`, and `bundleId` are now part of signed lease commercial context in the plan.
- Direct upload derives accepted usage identity from the lease, not request body context.
- New bundle-local helper files are `.mjs` so they can be copied into the release artifact and imported by `server.mjs` without relying on repo `package.json`.

---

## Follow-On Plans

These are deliberately not part of the implementation tasks above, but should be the next plan docs after this work verifies successfully:

1. `Skillpack Edge Gateway`
   - one local gateway for many bundles, agents, and machines
   - local intake API, queue, retry, batching, scheduled upstream sync
   - one approved egress point for restricted enterprise networks

2. `Vendor Self-Host Control Plane`
   - vendor-operated control plane compatible with hosted lease/policy/ingest contracts
   - packaged deploy path and compatibility test matrix

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-hosted-deploy-and-local-meter-client-direct.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
