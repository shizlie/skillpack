# Self-Hosted Implementation Plan

## Goal

Make `@skillpack/core` and the API/dashboard deployable as a single Hono server on any runtime (CF Workers, Bun, Node) so that:

1. **Cloudflare-hosted** (our SaaS) — unchanged, `wrangler deploy` still works
2. **Self-hosted by vendors** — single `npx @skillpack/self-hosted` or `docker run`, SQLite + shared-key auth, no Clerk/D1 required

## Current State

| Component | CF Workers | Self-hosted |
|---|---|---|
| Core handler (`createLicenseFetchHandler`) | ✅ | ✅ (runtime-agnostic) |
| Storage (D1) | ✅ `storage-d1.js` | — |
| Storage (SQLite) | — | ✅ `storage-sqlite.js` but Bun-only (`bun:sqlite`) |
| API entry (`apps/api`) | ✅ CF Worker | ❌ |
| Dashboard entry (`apps/dashboard`) | ✅ CF Worker + Clerk | ❌ |
| Crypto (`@skillpack/crypto`) | ✅ `node:crypto` + `nodejs_compat` | ⚠️ `Buffer` + `node:crypto` — works on Node/Bun, not browser/Deno |
| `server.js` key validation | ✅ `node:crypto` | ✅ Web Crypto via `crypto-utils.js` (already shipped) |

## Blocking Issues

### 1. `storage-sqlite.js` imports `bun:sqlite` at module load time

Self-hosted on Node needs `better-sqlite3` instead. The file is 759 lines. 700+ of those are SQL DDL and query logic shared with `storage-d1.js` — only the `Database` constructor and parameter-binding differ.

### 2. No shared schema abstraction

`storage-d1.js` (813 lines) and `storage-sqlite.js` (759 lines) duplicate the same table definitions, INSERT/UPDATE/SELECT templates, and normalization logic. Every schema change requires editing both files. This is a maintenance bomb.

### 3. No self-hosted entry point

`startLicenseServer` uses `Bun.serve()` — no Node equivalent exists yet.

### 4. Dashboard requires Clerk

Self-hosted vendors don't have Clerk. Dashboard needs a standalone shared-key auth variant.

### 5. Self-hosted clock authority missing from plan

The design doc (eng-review 1C) mandates TSA integration for self-hosted servers. Without it, customer-controlled clock rewind = trivial license evasion.

---

## Deployment Topology

```
┌─────────────────────────────────────────────────────────────┐
│                    Vendor Infrastructure                     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         Self-Hosted License Server                   │   │
│  │  ┌─────────────┐    ┌─────────────────────────────┐ │   │
│  │  │  Hono app   │───▶│  createLicenseFetchHandler  │ │   │
│  │  │  (Node/Bun) │    │  (runtime-agnostic)         │ │   │
│  │  └─────────────┘    └─────────────────────────────┘ │   │
│  │         │                      │                     │   │
│  │         ▼                      ▼                     │   │
│  │  ┌─────────────┐    ┌─────────────────────────────┐ │   │
│  │  │  Dashboard  │    │  Storage Adapter            │ │   │
│  │  │  (shared-key│    │  (better-sqlite3)           │ │   │
│  │  │   auth HTML)│    │                             │ │   │
│  │  └─────────────┘    └─────────────────────────────┘ │   │
│  │                              │                       │   │
│  │                              ▼                       │   │
│  │                     ┌─────────────┐                  │   │
│  │                     │  SQLite DB  │                  │   │
│  │                     │  (on disk)  │                  │   │
│  │                     └─────────────┘                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                              │                              │
│                              ▼                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  TSA Manual Attestations                            │   │
│  │  Vendor ops team records time attestations via CLI  │   │
│  │  or API to prevent clock-rewind license evasion     │   │
│  │  Air-gapped: operator workstation with network      │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 0: Extract shared schema (PREREQUISITE — do this first)

**Goal:** Eliminate the 759-line duplication between `storage-sqlite.js` and `storage-d1.js` before adding a third adapter.

#### 0.1 Create `packages/core/src/schema.js`

Extract everything that is identical across adapters:

```js
// Table definitions (CREATE TABLE IF NOT EXISTS ...)
export const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS lease_counters (...);
  CREATE TABLE IF NOT EXISTS manual_attestations (...);
  CREATE TABLE IF NOT EXISTS policy_snapshots (...);
  CREATE TABLE IF NOT EXISTS providers (...);
  CREATE TABLE IF NOT EXISTS customers (...);
  CREATE TABLE IF NOT EXISTS workspaces (...);
  CREATE TABLE IF NOT EXISTS seat_bindings (...);
  CREATE TABLE IF NOT EXISTS leases (...);
  CREATE TABLE IF NOT EXISTS lease_audit_log (...);
  CREATE TABLE IF NOT EXISTS meter_events (...);
  CREATE TABLE IF NOT EXISTS meter_flushes (...);
  CREATE TABLE IF NOT EXISTS pricing_rules (...);
  CREATE TABLE IF NOT EXISTS invoices (...);
  CREATE TABLE IF NOT EXISTS invoice_line_items (...);
  CREATE TABLE IF NOT EXISTS payment_transactions (...);
`;

// Shared query builders — parameterized SQL strings
export function buildInsertQuery(table, columns) { ... }
export function buildUpdateQuery(table, columns, where) { ... }
export function buildSelectQuery(table, columns, where, orderBy, limit) { ... }

// Shared normalization logic
export function normalizeSeatId(seatId) { return seatId ?? "default"; }
export function normalizeTimestamp(ts) { ... }
```

#### 0.2 Refactor `storage-sqlite.js` and `storage-d1.js`

Both files shrink to ~100 lines each:

```js
// storage-sqlite.js
import { SCHEMA_DDL, buildInsertQuery, buildSelectQuery, normalizeSeatId } from "./schema.js";

export async function createSqliteLeaseStore({ dbPath = ":memory:" } = {}) {
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { create: true });
  db.exec(SCHEMA_DDL);

  return {
    async createProvider({ providerId, name, updatedAtSec }) {
      const sql = buildInsertQuery("providers", ["provider_id", "name", "updated_at_sec"]);
      db.run(sql, [providerId, name, updatedAtSec]);
      return { providerId };
    },
    // ... other methods follow same pattern
  };
}
```

Same for `storage-d1.js` — imports `SCHEMA_DDL` and query builders, only D1-specific `db.prepare().bind().all()` binding remains.

**Why this matters:** Without this step, adding `storage-better-sqlite3.js` creates a three-way maintenance nightmare. Every schema change touches 3 files. With schema extraction, it's 1 file (`schema.js`) + 3 thin adapters.

#### 0.3 Add migration parity harness

```js
// tests/schema-parity.test.js
import { SCHEMA_DDL } from "../packages/core/src/schema.js";
import { readFileSync } from "node:fs";

const migrationFiles = ["apps/api/migrations/0001_init.sql", "apps/api/migrations/0002_billing.sql"];

// Parse CREATE TABLE statements from both sources
// Assert: every table in SCHEMA_DDL exists in migrations, and vice versa
// Assert: column names and types match (ignore ordering)
```

Run this in CI on every commit.

---

### Phase 1: Make `@skillpack/core` runtime-portable

**Goal:** `server.js` and storage adapters work on Node, Bun, and CF Workers without conditional imports at the call site.

#### 1.1 `crypto-utils.js` (already shipped ✅)

`packages/core/src/crypto-utils.js` already exists with:
- `sha256Hash(input)` — Web Crypto `crypto.subtle.digest("SHA-256", ...)`
- `timingSafeEqualUint8(a, b)` — XOR-accumulation constant-time compare
- `randomUUID()` — `globalThis.crypto.randomUUID()`
- `isValidManagementKey(provided, expected)` — async, uses Web Crypto

`server.js` already imports from `crypto-utils.js`. `isValidManagementKey` is already async. **No changes needed here.**

#### 1.2 Update `storage-sqlite.js` to use dynamic import

Change top-level `import { Database } from "bun:sqlite"` to dynamic import inside the factory:

```js
export async function createSqliteLeaseStore({ dbPath = ":memory:" } = {}) {
  let Database;
  try {
    ({ Database } = await import("bun:sqlite"));
  } catch (err) {
    throw new Error(
      `bun:sqlite not available (${err.message}). ` +
      `Install Bun, or use createBetterSqlite3LeaseStore() for Node.`
    );
  }
  const db = new Database(dbPath, { create: true });
  // ... rest uses SCHEMA_DDL from schema.js
}
```

This prevents Node from crashing on `bun:sqlite` import at module load time. The error message tells the user exactly what to do.

#### 1.3 Create `packages/core/src/storage-better-sqlite3.js`

Thin adapter (~100 lines after Phase 0 schema extraction):

```js
import Database from "better-sqlite3";
import { SCHEMA_DDL, buildInsertQuery, buildSelectQuery, normalizeSeatId } from "./schema.js";

export function createBetterSqlite3LeaseStore({ dbPath = "./skillpack.db" } = {}) {
  const db = new Database(dbPath);
  db.exec(SCHEMA_DDL);

  return {
    createProvider({ providerId, name, updatedAtSec }) {
      const sql = buildInsertQuery("providers", ["provider_id", "name", "updated_at_sec"]);
      db.prepare(sql).run(providerId, name, updatedAtSec);
      return { providerId };
    },
    // ... other methods
  };
}
```

**Note:** `better-sqlite3` is synchronous. Every DB call blocks the Node event loop. For high-throughput self-hosted deployments, run behind Node `cluster` or `pm2` with `instances: 'max'`. This is acceptable for v1 — the design doc targets ~100 customers × 100 events/min, well within single-process SQLite limits. Document this limitation.

#### 1.4 Update `packages/core/src/index.js` exports

```js
export { createInMemoryLeaseStore } from "./storage.js";
export { createD1LeaseStore, ensureD1Schema } from "./storage-d1.js";
export { createSqliteLeaseStore } from "./storage-sqlite.js";
export { createBetterSqlite3LeaseStore } from "./storage-better-sqlite3.js";
export { createLicenseFetchHandler, startLicenseServer } from "./server.js";
export { draftInvoiceFromUsage, findPricingRuleForUsage } from "./billing.js";
export {
  createDodoPaymentProvider,
  createManualPaymentProvider,
  createPaymentProviderRegistry,
  createStripePaymentProvider,
} from "./payment-providers.js";
```

---

### Phase 2: Self-hosted API + Dashboard app

**Goal:** New `apps/self-hosted/` that runs the same core logic with SQLite + shared-key auth + TSA clock authority.

#### 2.1 Create `apps/self-hosted/package.json`

```json
{
  "name": "@skillpack/self-hosted",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "skillpack-server": "src/cli.js"
  },
  "scripts": {
    "dev": "node --watch src/cli.js",
    "start": "node src/cli.js",
    "test": "node --test tests/**/*.test.js"
  },
  "dependencies": {
    "@skillpack/core": "workspace:*",
    "@skillpack/crypto": "workspace:*",
    "@hono/node-server": "^1.13.8",
    "better-sqlite3": "^11.8.2",
    "hono": "^4.8.2"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

#### 2.2 Create `apps/self-hosted/src/cli.js`

Thin entry point (~80 lines):

```js
import { parseArgs } from "node:util";
import { createLicenseFetchHandler } from "@skillpack/core";
import { createBetterSqlite3LeaseStore } from "@skillpack/core/storage-better-sqlite3";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readKeyFromEnvOrFile } from "./key-utils.js";
import { serveSelfHostedDashboard } from "./dashboard.js";
import { runMigrations } from "./db-migrate.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3001" },
    db: { type: "string", default: "./skillpack.db" },
    "api-key": { type: "string" },
    "signing-private-key": { type: "string" },
    "signing-public-key": { type: "string" },
    dashboard: { type: "boolean", default: true },
    migrate: { type: "boolean", default: true },
  },
});

// Read PEM keys from env or files
const signingPrivateKeyPem = readKeyFromEnvOrFile(
  "SKILLPACK_SIGNING_PRIVATE_KEY_PEM",
  values["signing-private-key"]
);
const signingPublicKeyPem = readKeyFromEnvOrFile(
  "SKILLPACK_SIGNING_PUBLIC_KEY_PEM",
  values["signing-public-key"]
);
const managementApiKey = values["api-key"] ?? process.env.SKILLPACK_API_KEY;

if (!managementApiKey) {
  console.error("FATAL: --api-key or SKILLPACK_API_KEY required");
  process.exit(1);
}

const leaseStore = createBetterSqlite3LeaseStore({ dbPath: values.db });

if (values.migrate) {
  runMigrations(leaseStore.db, { migrationsDir: "../../api/migrations" });
}

const handler = createLicenseFetchHandler({
  signingPrivateKeyPem,
  signingPublicKeyPem,
  managementApiKey,
  leaseStore,
});

const app = new Hono();
app.all("/v1/*", (c) => handler(c.req.raw));
app.get("/healthz", (c) => c.json({ status: "ok", mode: "self-hosted" }));

// Mount dashboard on / if enabled
if (values.dashboard) {
  app.get("/*", serveSelfHostedDashboard({ apiKey: managementApiKey }));
}

serve({ fetch: app.fetch, port: Number(values.port) });
console.log(`skillpack self-hosted listening on :${values.port}`);
console.log(`  database: ${values.db}`);
console.log(`  dashboard: ${values.dashboard ? "enabled" : "disabled"}`);
console.log(`  tsa: manual-attestation mode (record via POST /v1/tsa/manual-attest or skillpack CLI)`);
```

**Key additions vs. original plan:**
- `--migrate` flag to run DB migrations on startup
- Fatal exit if `managementApiKey` missing (fail fast, don't boot an open server)
- TSA works via manual attestations (already built into `createLicenseFetchHandler`)

#### 2.3 Create `apps/self-hosted/src/dashboard.js`

Standalone HTML dashboard — no Clerk, no shared bundle:

```js
import { html } from "hono/html";

export function serveSelfHostedDashboard({ apiKey }) {
  return (c) => {
    const providedKey = c.req.header("x-api-key");
    // Dashboard GET requests don't have headers — serve the login page
    // API calls (fetch from dashboard JS) include x-api-key
    if (providedKey) {
      return c.json({ error: "Use /v1/* for API calls" }, 404);
    }
    return c.html(renderDashboardHtml({ apiKeyPrefix: apiKey.slice(0, 8) }));
  };
}

function renderDashboardHtml({ apiKeyPrefix }) {
  return html`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Skillpack — Self-Hosted Dashboard</title>
        <style>${renderDashboardStyles()}</style>
      </head>
      <body>
        <div id="auth-screen">
          <h1>Skillpack Dashboard</h1>
          <p>Self-hosted mode — enter your API key to continue</p>
          <input type="password" id="api-key-input" placeholder="sk-..." />
          <button onclick="login()">Sign In</button>
          <p class="hint">API key starts with: ${apiKeyPrefix}...</p>
        </div>
        <div id="dashboard" style="display:none">
          <nav>...</nav>
          <main id="content">Loading...</main>
        </div>
        <script>
          // Store API key in localStorage, inject into all /v1/* fetch calls
          // Load providers, customers, workspaces, leases, usage via /v1/* endpoints
          // Same UI components as hosted dashboard, but data from self-hosted API
        </script>
      </body>
    </html>
  `;
}

function renderDashboardStyles() {
  return /* css */ `
    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 2rem; }
    #auth-screen { text-align: center; margin-top: 20vh; }
    input { padding: 0.5rem; font-size: 1rem; width: 300px; }
    button { padding: 0.5rem 1rem; font-size: 1rem; margin-left: 0.5rem; }
    .hint { color: #666; font-size: 0.85rem; }
  `;
}
```

**Why standalone HTML instead of reusing `@skillpack/dashboard`:**
- Clerk's `<SignIn />` component is a fundamentally different auth model (OAuth redirect vs. password input)
- Bundling Clerk JS for a self-hosted build pulls in ~200KB of unused code
- The self-hosted dashboard is simpler — no multi-tenant workspace switcher, no Clerk organization logic
- Keeping them separate means changes to the Clerk dashboard don't risk breaking self-hosted

#### 2.4 Create `apps/self-hosted/src/db-migrate.js`

```js
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function runMigrations(db, { migrationsDir }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare("SELECT filename FROM _migrations").pluck().all()
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (filename) VALUES (?)").run(file);
    console.log(`  migration applied: ${file}`);
  }
}
```

Reads `apps/api/migrations/*.sql`, applies in order, skips already-applied. Keeps schema in sync with D1.

#### 2.5 Create `apps/self-hosted/src/key-utils.js`

```js
import { readFileSync } from "node:fs";

export function readKeyFromEnvOrFile(envVar, filePath) {
  if (process.env[envVar]) {
    return process.env[envVar];
  }
  if (filePath) {
    return readFileSync(filePath, "utf-8");
  }
  return undefined;
}
```

---

### Phase 3: Make `@skillpack/crypto` portable (deferred)

`@skillpack/crypto` uses `node:crypto` for `sign`, `verify`, `generateKeyPairSync`, `createHmac`. Works on:

- ✅ Node (native)
- ✅ Bun (native)
- ✅ CF Workers (via `nodejs_compat`)

Does **not** work in browsers or Deno. For v1 self-hosted (Node + Bun), this is fine. Web Crypto migration is v2.

**Decision:** No changes to `@skillpack/crypto` in v1. Document requirement: Node ≥ 20 or Bun ≥ 1.0.

---

### Phase 4: Docker packaging

#### 4.1 Create `apps/self-hosted/Dockerfile`

```dockerfile
# Build stage — compile to single binary with Bun
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/ packages/
COPY apps/self-hosted/ apps/self-hosted/
RUN bun install --frozen-lockfile
RUN bun build apps/self-hosted/src/cli.js --compile --outfile skillpack-server

# Runtime stage — distroless Node for minimal attack surface
FROM gcr.io/distroless/nodejs22-debian12
COPY --from=build /app/skillpack-server /skillpack-server
COPY --from=build /app/apps/api/migrations/ /migrations/
EXPOSE 3001
ENTRYPOINT ["/skillpack-server"]
```

- Bun's `--compile` produces a single static binary with Node runtime embedded
- Vendors run: `docker run -v skillpack-data:/data -p 3001:3001 skillpack/self-hosted`
- Alternative for Node-only shops: `FROM node:22-slim` + `node src/cli.js` (slower startup, larger image)

**Performance note:** `better-sqlite3` inside Docker on `gcr.io/distroless/nodejs22` requires `libc` compat. The distroless image is Debian-based, so native modules load correctly. Alpine-based images (`node:alpine`) would need `better-sqlite3` rebuilt — avoid Alpine.

#### 4.2 Create `apps/self-hosted/docker-compose.yml`

```yaml
version: "3.8"
services:
  skillpack:
    build: .
    ports:
      - "3001:3001"
    environment:
      SKILLPACK_API_KEY: ${SKILLPACK_API_KEY}
      SKILLPACK_SIGNING_PRIVATE_KEY_PEM: ${SKILLPACK_SIGNING_PRIVATE_KEY_PEM}
      SKILLPACK_SIGNING_PUBLIC_KEY_PEM: ${SKILLPACK_SIGNING_PUBLIC_KEY_PEM}
    volumes:
      - skillpack-data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/healthz"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  skillpack-data:
```

---

### Phase 5: Tests

#### 5.1 Runtime-portable tests for `crypto-utils.js`

```js
// packages/core/tests/crypto-utils.test.js
import { test } from "node:test";
import assert from "node:assert";
import { sha256Hash, timingSafeEqualUint8, isValidManagementKey } from "../src/crypto-utils.js";
import crypto from "node:crypto";

test("sha256Hash matches node:crypto", async () => {
  const input = "test-key-123";
  const webHash = await sha256Hash(input);
  const nodeHash = crypto.createHash("sha256").update(input).digest();
  assert.deepStrictEqual(webHash, new Uint8Array(nodeHash));
});

test("timingSafeEqualUint8 rejects mismatched lengths", () => {
  assert.throws(() => timingSafeEqualUint8(new Uint8Array(4), new Uint8Array(5)));
});

test("isValidManagementKey constant-time rejects wrong key", async () => {
  const valid = await isValidManagementKey("wrong-key", "correct-key-12345");
  assert.strictEqual(valid, false);
});
```

Run on both Node and Bun in CI:
```bash
node --test packages/core/tests/crypto-utils.test.js
bun test packages/core/tests/crypto-utils.test.js
```

#### 5.2 Integration test for self-hosted server

```js
// apps/self-hosted/tests/integration.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";

describe("self-hosted server", () => {
  let server;
  let baseUrl;

  before(async () => {
    server = spawn("node", ["src/cli.js", "--db", ":memory:", "--api-key", "test-key"], {
      cwd: process.cwd(),
      env: { ...process.env, SKILLPACK_SIGNING_PRIVATE_KEY_PEM: testKeyPem, SKILLPACK_SIGNING_PUBLIC_KEY_PEM: testPubPem },
    });
    await waitForPort(3001);
    baseUrl = "http://localhost:3001";
  });

  after(() => server.kill());

  test("healthz returns ok", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.mode, "self-hosted");
  });

  test("provider CRUD with shared-key auth", async () => {
    // POST /v1/providers, GET /v1/providers/:id, etc.
    // Same test cases as D1 adapter tests
  });

  test("lease issue and verify", async () => {
    // Full lease lifecycle
  });

  test("meter upload and usage summary", async () => {
    // Upload meter events, verify usage aggregation
  });
});
```

**Key assertion:** The same test suite runs against both D1 (via Miniflare in CI) and self-hosted (via `better-sqlite3`). This proves behavioral parity.

#### 5.3 Migration parity test (already covered in Phase 0.3)

Run in CI:
```bash
node tests/schema-parity.test.js
```

---

### Phase 6: Documentation

#### 6.1 Update `README.md`

Add "Self-Hosted" section:

```markdown
## Self-Hosted

Run the license server on your own infrastructure (Node or Docker) with SQLite.

### Quick start

```bash
npx @skillpack/self-hosted \
  --db ./skillpack.db \
  --api-key $SKILLPACK_API_KEY \
  --signing-private-key ./signing-private.pem \
  --signing-public-key ./signing-public.pem
```

### Docker

```bash
docker run -d \
  -v skillpack-data:/data \
  -p 3001:3001 \
  -e SKILLPACK_API_KEY \
  -e SKILLPACK_SIGNING_PRIVATE_KEY_PEM \
  -e SKILLPACK_SIGNING_PUBLIC_KEY_PEM \
  skillpack/self-hosted
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `SKILLPACK_API_KEY` | ✅ | Shared secret for management API access |
| `SKILLPACK_SIGNING_PRIVATE_KEY_PEM` | ✅ | Ed25519 private key for signing leases |
| `SKILLPACK_SIGNING_PUBLIC_KEY_PEM` | ✅ | Ed25519 public key for verifying leases |

### Auth model

Self-hosted uses shared-key auth only (no Clerk). Pass `x-api-key` header on all management API calls. The dashboard prompts for the API key on first load and stores it in `localStorage`.

### Clock tamper protection (manual attestation)

Self-hosted servers use manual TSA (Timestamp Authority) attestations to prevent customers from rewinding system clocks to extend expired leases. Without regular attestations, the server trusts the host OS clock.

To record a manual attestation:
```bash
skillpack tsa manual-attest \
  --server-url http://localhost:3001 \
  --customer-id <customerId> \
  --seat-id <seatId> \
  --operator-id <operatorId> \
  --ticket-id <ticketId> \
  --reason "Weekly time attestation" \
  --attested-at-sec $(date +%s)
```

Air-gapped deployments: run the CLI from an operator workstation with network access, or call `POST /v1/tsa/manual-attest` directly with the attestation payload. The server refuses to issue new leases if the latest attestation is older than the grace period (7 days default). Already-issued leases continue until their TTL — no in-field skill outage.
```

#### 6.2 Update `CLAUDE.md`

- Add `apps/self-hosted` to package layout
- Update "Self-hosted" architecture note with TSA requirement
- Add `better-sqlite3` sync-event-loop warning to performance notes

#### 6.3 Mark TODO #13 as complete

---

## Data Flow Diagram

```
┌──────────────┐     x-api-key      ┌──────────────────────────┐
│   Dashboard  │ ─────────────────▶ │  Self-Hosted Hono Server │
│   (browser)  │                    │  (Node/Bun)              │
└──────────────┘                    └──────────────────────────┘
                                             │
                        ┌────────────────────┼────────────────────┐
                        ▼                    ▼                    ▼
               ┌─────────────┐     ┌─────────────────┐   ┌─────────────┐
               │  /v1/* API  │     │  /healthz       │   │  Dashboard  │
               │  (leases,   │     │  (liveness)     │   │  (login     │
               │  metering)  │     │                 │   │  + SPA)     │
               └──────┬──────┘     └─────────────────┘   └─────────────┘
                      │
                      ▼
         ┌────────────────────────┐
         │ createLicenseFetchHandler
         │  (runtime-agnostic)    │
         └───────────┬────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌─────────┐ ┌──────────┐ ┌──────────┐
   │ Lease   │ │ Meter    │ │ Billing  │
   │ Store   │ │ Upload   │ │ Engine   │
   │ (SQLite)│ │ Handler  │ │          │
   └────┬────┘ └──────────┘ └──────────┘
        │
        ▼
   ┌─────────────┐
   │ better-sqlite3
   │ (sync, on-disk)
   └─────────────┘
```

---

## File Change Summary

| File | Action | Description |
|---|---|---|
| `packages/core/src/schema.js` | **NEW** | Shared DDL + query builders extracted from storage adapters |
| `packages/core/src/storage-sqlite.js` | **EDIT** | Refactor to use `schema.js` + dynamic `import("bun:sqlite")` |
| `packages/core/src/storage-d1.js` | **EDIT** | Refactor to use `schema.js` (reduce from 813 to ~100 lines) |
| `packages/core/src/storage-better-sqlite3.js` | **NEW** | `better-sqlite3` adapter, ~100 lines, uses `schema.js` |
| `packages/core/src/crypto-utils.js` | **EXISTING ✅** | Already shipped — no changes needed |
| `packages/core/src/server.js` | **EXISTING ✅** | Already imports from `crypto-utils.js` — no changes needed |
| `packages/core/src/index.js` | **EDIT** | Export `createBetterSqlite3LeaseStore` |
| `apps/self-hosted/package.json` | **NEW** | Package manifest with `better-sqlite3` dep |
| `apps/self-hosted/src/cli.js` | **NEW** | Entry point with args parsing, TSA wiring, key loading |
| `apps/self-hosted/src/dashboard.js` | **NEW** | Standalone HTML dashboard with shared-key auth |
| `apps/self-hosted/src/db-migrate.js` | **NEW** | Migration runner for `apps/api/migrations/*.sql` |
| `apps/self-hosted/src/key-utils.js` | **NEW** | `readKeyFromEnvOrFile()` helper |
| `apps/self-hosted/Dockerfile` | **NEW** | Bun compile → distroless Node runtime |
| `apps/self-hosted/docker-compose.yml` | **NEW** | Docker Compose with healthcheck |
| `packages/core/tests/crypto-utils.test.js` | **NEW** | Parity tests for Web Crypto vs. node:crypto |
| `apps/self-hosted/tests/integration.test.js` | **NEW** | Full server lifecycle test |
| `tests/schema-parity.test.js` | **NEW** | Asserts migration SQL matches `schema.js` DDL |

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Async auth changes** | Low | `isValidManagementKey` is already async in shipped `crypto-utils.js`. `authenticateManagementRequest` already handles async. No code changes needed. |
| **Triple SQLite adapter maintenance** | **Eliminated** | Phase 0 extracts shared schema into `schema.js`. Adapters are now ~100 lines each. Schema changes touch 1 file. |
| **`better-sqlite3` blocks event loop** | Medium | Documented limitation. Single-process throughput is fine for v1 targets (~167 writes/sec). Future: evaluate `libsql` (async SQLite) for v2. |
| **`@skillpack/crypto` stays node:crypto** | Low | Documented. Node ≥ 20 or Bun ≥ 1.0 required. Browser/Deno is v2. |
| **Dashboard shared-key UX** | Low | Standalone HTML — simpler than Clerk version by design. No runtime patching of existing dashboard. |
| **TSA stale = no new leases** | **By design** | If latest manual attestation is older than grace period (7d), server stops issuing new leases. Already-issued leases continue until TTL — no in-field skill outage. Vendor ops team records attestations via CLI or API. |
| **Docker image size** | Low | Bun `--compile` produces ~50MB binary. Distroless base adds ~40MB. Total ~90MB. Acceptable for v1. |
| **Migration drift** | Low | `schema-parity.test.js` runs in CI on every commit. Fails if `apps/api/migrations/` diverges from `schema.js`. |

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-05 | Extract `schema.js` before adding third adapter | Prevents 759-line duplication. Every schema change would touch 3 files without this. |
| 2026-05-05 | Self-hosted dashboard = standalone HTML, not shared Clerk bundle | Different auth model (password vs. OAuth). Separate file avoids runtime patching and unused Clerk JS bloat. |
| 2026-05-05 | TSA uses manual attestations in self-hosted (no auto-fetch URL) | Current codebase has manual attestation API only. Auto-fetch from TSA URL is a future enhancement (v1.x). For now, vendor ops team records attestations via CLI (`skillpack tsa manual-attest`) or direct API call. |
| 2026-05-05 | `better-sqlite3` sync API accepted for v1 | Event loop blocking is acceptable at v1 scale. Async SQLite (`libsql`) is v2 exploration. |
| 2026-05-05 | `@skillpack/crypto` stays `node:crypto` for v1 | Works on Node/Bun/Workers. Web Crypto migration is v2. Not blocking self-hosted. |
