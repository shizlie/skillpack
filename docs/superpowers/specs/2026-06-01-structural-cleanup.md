# Skillpack Structural Cleanup — Design Spec

> Source: thermo-nuclear code-quality review (2026-06-01). This spec describes the desired end state. Implementation is broken into one plan per subsystem under `docs/superpowers/plans/`.

## Goal

Eliminate the structural code-quality debt in skillpack so that:

1. The license-server handler is a declarative route table, not a 470-line `if`-chain.
2. The runtime reuses `@skillpack/protocol` and `@skillpack/crypto` — no more shadow copies.
3. The two storage backends (D1, SQLite) share a single SQL contract implementation.
4. The dashboard UI is split into focused files (HTML, CSS, JS in separate concerns, forms/handlers in a descriptor table).
5. The CLI is a descriptor table, not 12 hand-written subcommand functions plus a 16-branch dispatcher.
6. `apps/api` and `apps/dashboard` share a single `worker-auth` module.

After this work, no source file exceeds 600 lines unless it has a clear, single-responsibility justification; no business logic is duplicated across package boundaries; adding a new endpoint requires edits in at most two places (the route descriptor and any store method).

## Non-Negotiables

- **No behavior change.** Every plan must keep all existing tests green without modifying them except to update import paths.
- **No "temporary" branching.** No `// TODO: refactor later` leftovers in the final tree.
- **Canonical home for each concept.** Policy decision logic lives in `@skillpack/protocol`; crypto primitives live in `@skillpack/crypto`; row-mapping lives in the unified `storage` module; route definitions live in `core/src/routes.js`; command definitions live in `cli/src/commands.js`.
- **Tests exercise the canonical implementation.** If two implementations existed before, only one exists after, and all tests target it.
- **Bun + the existing monorepo layout** stay intact. No new tooling.

## Scope and Subsystems

The work is six independent subsystems. Each gets its own plan:

| # | Subsystem | Plan file | Priority |
|---|---|---|---|
| 1 | `core` server route table | `2026-06-01-core-server-routes.md` | P0 (blocker) |
| 2 | Runtime eliminates re-implementations | `2026-06-01-runtime-canonicalize.md` | P0 |
| 3 | Unified storage backends | `2026-06-01-storage-unification.md` | P1 |
| 4 | Dashboard UI decomposition | `2026-06-01-dashboard-decompose.md` | P1 |
| 5 | CLI command descriptor table | `2026-06-01-cli-descriptors.md` | P2 |
| 6 | Shared worker-auth module | `2026-06-01-worker-auth.md` | P2 |

Plans may be executed in any order; P0 first.

## Subsystem 1 — `core` server route table

### Current state

`packages/core/src/server.js` defines `createLicenseFetchHandler({ ... })` returning a `fetch(request)` function with a 470-line body of `if (request.method === X && url.pathname === Y)` branches. The same method+pathname conditions are repeated in `isManagementRoute` (lines 132–161) to gate management-only authorization. Adding a new endpoint requires editing two places; missing one is a security hazard.

### Target state

A single declarative route table of the form:

```js
// packages/core/src/routes.js
export const routes = [
  { method: "GET",  path: "/healthz",
    handler: () => ({ status: 200, body: { ok: true, service: "license-server" } }) },

  { method: "POST", path: "/v1/providers", management: true,
    handler: async (ctx) => {
      const provider = validateProviderCreateContract(ctx.body);
      return { status: 201, body: { provider: await ctx.store.saveProvider(provider) } };
    }},

  { method: "GET",  path: "/v1/providers", management: true,
    handler: async (ctx) => ({ status: 200, body: { providers: await ctx.store.listProviders() } }) },

  // Pattern routes with named parameters.
  { method: "GET",  path: "/v1/billing/invoices/:id/payment-handoff", management: true,
    handler: async (ctx) => { /* ... */ }},
  // ...
];
```

`createLicenseFetchHandler` becomes:

1. Authenticate management routes by walking the table (`routes.some(r => r.management && matchRoute(r, url, method))`).
2. Match the request against the table; extract path params.
3. Parse body (for non-GET), call `ctx = { store, providers, tsaMonitor, attestationContract, body, params, request }`, return `{ status, body }`.
4. Map thrown errors to JSON 4xx/5xx responses.

Path matching: a 30-line matcher handles exact match + `:param` extraction. No external routing dependency.

### Acceptance criteria

- `packages/core/src/server.js` ≤ 200 lines (currently 662).
- `isManagementRoute` is gone; `routes.some(...)` replaces it.
- All existing tests in `packages/core/test/server.test.js` and downstream worker tests pass unchanged (or with one-line import updates if the export name changes).
- Adding a new endpoint requires editing only `routes.js` and (if needed) the store.

## Subsystem 2 — Runtime eliminates re-implementations

### Current state

`packages/runtime/src/server.mjs` (1180 lines) re-implements policy validation/decision logic and crypto helpers that already exist elsewhere. `packages/runtime/src/runtime-meter.mjs` and `server-util.mjs` each re-implement `toBase64Url`, `fromBase64Url`, `sortJson`, `canonicalJson`. `packages/runtime/src/index.js:34` and `server.mjs:74` both define `verifyLeaseForRuntime`. Tests in `packages/runtime/test/policy-enforcement.test.js:4` import the wrong copy.

### Target state

- `server.mjs` imports `validatePolicySnapshot`, `evaluatePolicyToolCallDecision`, `evaluateUsageState`, `evaluateTimeState`, `evaluatePolicyDecision`, `evaluateEffectiveTimeWindow` from `@skillpack/protocol`.
- `server.mjs` imports `validateLeasePayload` from `@skillpack/protocol`.
- `runtime-meter.mjs` imports `toBase64Url`, `fromBase64Url`, `canonicalJson` from `@skillpack/crypto`.
- `server-util.mjs` keeps only `isUnsafeArchivePath`, `ensureSafePathWithin`, and `sha256Hex` (genuinely runtime-internal). The other utilities are deleted.
- `verifyLeaseForRuntime` exists in exactly one place: `packages/runtime/src/index.js`. `server.mjs` imports it.
- `packages/runtime/test/policy-enforcement.test.js:4` imports from `@skillpack/protocol` (or is deleted, since the canonical tests in `packages/protocol/test/policy.test.js` already cover the same surface).

### Acceptance criteria

- No function with a name matching `toBase64Url|fromBase64Url|sortJson|canonicalJson|validatePolicySnapshot|evaluatePolicyToolCallDecision|evaluateUsageState|evaluateTimeState|evaluatePolicyDecision|validateLeasePayload|verifyLeaseForRuntime` is defined in more than one file in `packages/`.
- The runtime's `server.mjs` shrinks by at least 200 lines.
- All existing tests pass.

## Subsystem 3 — Unified storage backends

### Current state

`packages/core/src/storage-d1.js` (814 lines) and `packages/core/src/storage-sqlite.js` (760 lines) are 90% duplicate: identical SQL schema, identical `mapPricingRule` / `mapUsageEvent` / `normalizeSeatId`, identical contract shape. The only differences are the SQL execution API (`.prepare().bind()` vs `.query().run()`) and transaction support.

### Target state

A single `packages/core/src/storage.js` exports `createLeaseStore({ exec, runInTransaction })` containing:

- The SQL schema (one copy).
- All row mappers (`mapPricingRule`, `mapUsageEvent`, `mapInvoice`, etc.).
- The full contract implementation calling `exec.first/all/run`.

Two thin adapters wrap the dialects:

```js
// storage-d1.js
export function createD1LeaseStore({ db }) {
  const exec = {
    first: async (sql, ...args) => db.prepare(sql).bind(...args).first(),
    all:   async (sql, ...args) => (await db.prepare(sql).bind(...args).all())?.results ?? [],
    run:   async (sql, ...args) => db.prepare(sql).bind(...args).run(),
  };
  return createLeaseStore({ exec });
}

// storage-sqlite.js
export function createSqliteLeaseStore({ dbPath = ":memory:" } = {}) {
  const db = new Database(dbPath, { create: true });
  const exec = {
    first: (sql, ...args) => db.query(sql).get(...args),
    all:   (sql, ...args) => db.query(sql).all(...args),
    run:   (sql, ...args) => db.query(sql).run(...args),
  };
  return createLeaseStore({ exec, runInTransaction: (fn) => db.transaction(fn)() });
}
```

### Acceptance criteria

- `packages/core/src/storage.js` exists as a single shared implementation.
- Both `storage-d1.js` and `storage-sqlite.js` are ≤ 100 lines each.
- The in-memory `storage.js` (currently a separate file) is folded in or kept as a separate export, but uses the same shared row mappers.
- All storage tests pass; `leaseStore.contract.test.js` (new) exercises both backends against the same shared test suite.

## Subsystem 4 — Dashboard UI decomposition

### Current state

`apps/dashboard/src/dashboard-ui.js` is 1350 lines containing three template-literal strings: `dashboardStyles` (CSS), `renderDashboardHtml` (HTML), `dashboardScript` (1350 lines of JS). The JS contains ten near-identical `handleXSubmit` handlers, four near-identical `refreshX` loaders, and a `bindAsyncForm` helper used inconsistently.

### Target state

```
apps/dashboard/src/
  index.js                  — Hono app, asset routing, proxy (existing)
  ui/
    index.js                — bootstrap, top-level wiring
    styles.css              — real CSS file (bundled via Wrangler text rule)
    render-html.js          — small template-tag-based HTML renderer
    api.js                  — proxyFetch, form helpers
    render/
      policy.js
      usage.js
      billing.js
      tsa.js
    formatters.js
```

Each render module exports a `mount(root, { api, formatters })` function. `bootstrap()` calls each `mount()` in order.

`bindAsyncForm` is replaced with a generic `wireForm(selector, { fields, output })` that builds a body object from a `fields` descriptor and posts it.

### Acceptance criteria

- `dashboard-ui.js` is deleted (or ≤ 50 lines, only `index.js` re-exports).
- No file under `apps/dashboard/src/` exceeds 250 lines.
- The dashboard still works as a Worker asset — Wrangler's `text` rule loads the CSS.

## Subsystem 5 — CLI command descriptor table

### Current state

`apps/cli/src/index.js` defines 12 subcommand functions with near-identical shapes, plus a 16-branch `if/else` dispatcher in `runSkillpackCli`. `apps/cli/test/cli.test.js` (849 lines) hand-writes happy-path + missing-flag tests for each.

### Target state

```js
// apps/cli/src/commands.js
export const commands = {
  license: {
    issue: {
      buildRequest: (flags) => ({ method: "POST", url: "/v1/leases/issue", body: {...} }),
      validate: (flags) => { if (!flags["customer-id"]) throw new Error("missing_customer_id"); },
    },
    verify: { /* ... */ },
  },
  tsa: { manualAttest: {...}, latestAttestation: {...} },
  provider: { create: {...} },
  customer: { create: {...} },
  workspace: { create: {...} },
  policy: { issue: {...}, sync: {...} },
  meter: { upload: {...} },
  usage: { summary: {...} },
  billing: {
    "pricing-rule": { create: {...} },
    "invoice":      { draft: {...} },
    "payment-handoff": { create: {...} },
  },
  bundle: { build: { /* local-only, no fetch */ } },
};
```

A single `runCommand(args, fetchImpl)` walks the tree, validates required flags, calls `dispatchRequest(serverUrl, descriptor)`, and emits `{ status, body, stderr }`.

### Acceptance criteria

- `apps/cli/src/index.js` shrinks to ≤ 200 lines (currently 701).
- `apps/cli/src/commands.js` is the single source of subcommand definitions.
- A loop-based test in `apps/cli/test/cli.test.js` exercises every subcommand's happy path; per-subcommand files are gone.
- All existing CLI tests pass.

## Subsystem 6 — Shared worker-auth module

### Current state

`apps/api/src/index.js` and `apps/dashboard/src/index.js` each define their own `getRequiredEnvString`, `getOptionalEnvString`, `getManagementAuthMode`, `getClerkClient`, plus auth glue (`isValidSharedManagementKey`, `createManagementAuthOptions`, `addUpstreamAuthHeaders`). The two implementations are similar but diverging.

### Target state

A `packages/core/src/worker-auth.js` (or a new `packages/worker-auth` package) exports:

- `getEnvString(env, key, { prefix = "worker" } = {})`
- `getOptionalEnvString(env, key)`
- `getManagementAuthMode(env)`
- `getClerkClient(env, { cache, createClerkClientImpl })`
- `isValidSharedManagementKey(request, managementApiKey)`
- `createManagementAuthOptions(env, { cache, createClerkClientImpl })` returning `{ managementApiKey, managementAuthenticator }`
- `addUpstreamAuthHeaders(headers, request, env, { mode, incomingAuthorization })`

`apps/api` and `apps/dashboard` each import these. Their own `index.js` files drop the duplicated helpers.

### Acceptance criteria

- No auth helper is defined in more than one file across the repo.
- `apps/api/src/index.js` shrinks by at least 40 lines.
- `apps/dashboard/src/index.js` shrinks by at least 40 lines.

## Cross-cutting acceptance criteria

After all six plans land:

- **File-size rule:** no source file exceeds 600 lines unless it has a single-responsibility justification documented inline. (Targets: 1k → decomposable.)
- **Single-source rule:** every utility has exactly one definition. Verified with `grep -r "function toBase64Url" packages apps`.
- **Test parity rule:** no test exercises a copy of code that has a canonical equivalent elsewhere.
- **No dead code:** all duplicated copies are deleted; no `// TODO: refactor` comments left.

## Out of Scope

- Behavior changes (e.g. a new feature, a bug fix unrelated to the cleanup).
- Schema migrations or wire-format changes.
- Worker deployment / Cloudflare config changes.
- New third-party dependencies.

## Order of execution

P0 (blockers — do first):
1. `core` server route table
2. Runtime canonicalization

P1:
3. Storage unification
4. Dashboard decomposition

P2:
5. CLI descriptors
6. Shared worker-auth

These are independent. After P0 lands, P1 and P2 can be parallelized.
