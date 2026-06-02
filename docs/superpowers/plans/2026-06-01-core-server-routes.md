# Core Server Route Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 470-line `if`-chain in `packages/core/src/server.js` with a declarative route table. Shrink the file from 662 to ≤ 200 lines. Eliminate the duplicated `isManagementRoute` so adding a new endpoint only touches one place.

**Architecture:** Introduce `packages/core/src/routes.js` containing the route descriptor table and a small path matcher. `createLicenseFetchHandler` becomes a thin dispatcher that walks the table, applies management auth, parses body, calls the route's handler, and serializes the result. Path parameters (`/v1/billing/invoices/:id/payment-handoff`) are extracted by the matcher. No external router dependency.

**Tech Stack:** Bun, plain JavaScript. The existing `packages/core/test/server.test.js` covers behavior — this plan preserves it.

**Reference spec:** `docs/superpowers/specs/2026-06-01-structural-cleanup.md` (Subsystem 1).

---

## File Structure

- **Create:** `packages/core/src/routes.js` — route table + path matcher
- **Create:** `packages/core/test/routes.test.js` — unit tests for the matcher
- **Create:** `packages/core/test/route-table.test.js` — proves every current route is in the table
- **Modify:** `packages/core/src/server.js` — collapse handler to the dispatcher
- **Modify:** `packages/core/src/index.js` — re-export the new routes module

---

### Task 1: Path matcher with `:param` extraction

**Files:**
- Create: `packages/core/src/routes.js`
- Create: `packages/core/test/routes.test.js`

The matcher must:
- Match exact paths.
- Match paths with one or more `:name` segments and return `{ matches: true, params: { name: "value" } }`.
- Be a single function, no class, no regex compilation in hot path.

- [ ] **Step 1: Write failing matcher tests**

```js
// packages/core/test/routes.test.js
import { describe, test, expect } from "bun:test";
import { matchRoute } from "../src/routes.js";

describe("matchRoute", () => {
  test("exact match returns empty params", () => {
    expect(matchRoute("/v1/providers", "/v1/providers")).toEqual({
      matches: true, params: {},
    });
  });

  test("non-match returns matches:false", () => {
    expect(matchRoute("/v1/providers", "/v1/other")).toEqual({
      matches: false, params: null,
    });
  });

  test(":param segment extracts value", () => {
    expect(matchRoute(
      "/v1/billing/invoices/:id/payment-handoff",
      "/v1/billing/invoices/inv_123/payment-handoff"
    )).toEqual({ matches: true, params: { id: "inv_123" } });
  });

  test("trailing slash is significant", () => {
    expect(matchRoute("/v1/providers", "/v1/providers/")).toEqual({
      matches: false, params: null,
    });
  });

  test("method mismatch is not enforced by matcher (caller's job)", () => {
    // matchRoute is path-only; method filtering is in the dispatcher.
    expect(matchRoute("/v1/providers", "/v1/providers").matches).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/core/test/routes.test.js`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement matchRoute**

```js
// packages/core/src/routes.js
const PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

function compilePattern(pattern) {
  const segments = pattern.split("/");
  const compiled = segments.map((segment) => {
    const paramMatch = PARAM_RE.exec(segment);
    return paramMatch ? { kind: "param", name: paramMatch[1] } : { kind: "lit", value: segment };
  });
  return (path) => {
    const actual = path.split("/");
    if (actual.length !== compiled.length) return null;
    const params = {};
    for (let i = 0; i < compiled.length; i += 1) {
      const c = compiled[i];
      if (c.kind === "lit") {
        if (c.value !== actual[i]) return null;
      } else {
        params[c.name] = decodeURIComponent(actual[i]);
      }
    }
    return params;
  };
}

export function matchRoute(pattern, path) {
  const compiled = compilePattern(pattern);
  const params = compiled(path);
  if (params === null) return { matches: false, params: null };
  return { matches: true, params };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/core/test/routes.test.js`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routes.js packages/core/test/routes.test.js
git commit -m "feat(core): add path matcher with :param extraction"
```

---

### Task 2: Route table covering every current endpoint

**Files:**
- Create: `packages/core/src/routes.js` (extend existing file)
- Create: `packages/core/test/route-table.test.js`

The route table is the source of truth. To verify completeness, write a test that asserts every `(method, pathname)` pair currently handled by `createLicenseFetchHandler` exists in the table.

- [ ] **Step 1: List every current route**

Read `packages/core/src/server.js` and enumerate every `request.method === X && url.pathname === Y` branch. The complete list as of the spec date:

| Method | Pathname |
|---|---|
| GET | `/healthz` |
| POST | `/v1/providers` |
| GET | `/v1/providers` |
| POST | `/v1/providers/:providerId/customers` |
| GET | `/v1/providers/:providerId/customers` |
| POST | `/v1/workspaces` |
| GET | `/v1/workspaces` |
| POST | `/v1/leases/issue` |
| POST | `/v1/leases/verify` |
| POST | `/v1/policies/issue` |
| POST | `/v1/policies/sync` |
| GET | `/v1/usage/summary` |
| POST | `/v1/billing/pricing-rules` |
| GET | `/v1/billing/pricing-rules` |
| POST | `/v1/billing/invoices/draft` |
| GET | `/v1/billing/invoices` |
| GET | `/v1/billing/invoices/:id` |
| POST | `/v1/billing/invoices/:id/payment-handoff` |
| POST | `/v1/meter/upload` |
| POST | `/v1/tsa/manual-attest` |
| GET | `/v1/tsa/manual-attestations` |
| GET | `/v1/tsa/manual-attestations/latest` |

- [ ] **Step 2: Write failing route-table test**

```js
// packages/core/test/route-table.test.js
import { describe, test, expect } from "bun:test";
import { routes } from "../src/routes.js";

const expectedRoutes = [
  ["GET",  "/healthz"],
  ["POST", "/v1/providers"],
  ["GET",  "/v1/providers"],
  ["POST", "/v1/providers/:providerId/customers"],
  ["GET",  "/v1/providers/:providerId/customers"],
  ["POST", "/v1/workspaces"],
  ["GET",  "/v1/workspaces"],
  ["POST", "/v1/leases/issue"],
  ["POST", "/v1/leases/verify"],
  ["POST", "/v1/policies/issue"],
  ["POST", "/v1/policies/sync"],
  ["GET",  "/v1/usage/summary"],
  ["POST", "/v1/billing/pricing-rules"],
  ["GET",  "/v1/billing/pricing-rules"],
  ["POST", "/v1/billing/invoices/draft"],
  ["GET",  "/v1/billing/invoices"],
  ["GET",  "/v1/billing/invoices/:id"],
  ["POST", "/v1/billing/invoices/:id/payment-handoff"],
  ["POST", "/v1/meter/upload"],
  ["POST", "/v1/tsa/manual-attest"],
  ["GET",  "/v1/tsa/manual-attestations"],
  ["GET",  "/v1/tsa/manual-attestations/latest"],
];

describe("route table", () => {
  test("contains every (method,path) pair from the current handler", () => {
    const present = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const [method, path] of expectedRoutes) {
      expect(present.has(`${method} ${path}`)).toBe(true);
    }
  });

  test("every route has a handler function", () => {
    for (const r of routes) {
      expect(typeof r.handler).toBe("function");
    }
  });

  test("no two routes share the same (method, path)", () => {
    const seen = new Set();
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  // (method, path) → expected management flag value.
  // Routes without this key have no `management` field (open or self-authed).
  // /v1/leases/verify is the open SDK endpoint (no auth required).
  // /v1/meter/upload does dual-auth inside its own handler body.
  const expectedManagement = {
    "GET /v1/usage/summary": true,
    "GET /v1/providers": true,
    "GET /v1/workspaces": true,
    "GET /v1/providers/:providerId/customers": true,
    "GET /v1/billing/pricing-rules": true,
    "GET /v1/billing/invoices": true,
    "GET /v1/billing/invoices/:id": true,
    "GET /v1/tsa/manual-attestations": true,
    "GET /v1/tsa/manual-attestations/latest": true,
    "POST /v1/providers": true,
    "POST /v1/workspaces": true,
    "POST /v1/providers/:providerId/customers": true,
    "POST /v1/leases/issue": true,
    "POST /v1/policies/issue": true,
    "POST /v1/policies/sync": true,
    "POST /v1/billing/pricing-rules": true,
    "POST /v1/billing/invoices/draft": true,
    "POST /v1/billing/invoices/:id/payment-handoff": true,
    "POST /v1/tsa/manual-attest": true,
    // /healthz, /v1/leases/verify, /v1/meter/upload have no management flag.
  };

  test("management flag matches expected auth model", () => {
    const byKey = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
    for (const [key, expected] of Object.entries(expectedManagement)) {
      const route = byKey.get(key);
      expect(route).toBeDefined();
      expect(Boolean(route.management)).toBe(Boolean(expected));
    }
    for (const path of ["/healthz", "/v1/leases/verify", "/v1/meter/upload"]) {
      for (const route of routes) {
        if (route.path === path) {
          expect(route.management).toBeUndefined();
        }
      }
    }
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `bun test packages/core/test/route-table.test.js`
Expected: FAIL — `routes` is not exported yet.

- [ ] **Step 4: Build the route table skeleton**

Append to `packages/core/src/routes.js`:

```js
// Body of each handler is filled in by Task 3. For now, placeholders that
// throw so the dispatcher wiring can be tested in isolation.
function placeholder(name) {
  return async () => {
    throw new Error(`route_not_implemented:${name}`);
  };
}

export const routes = [
  { method: "GET",  path: "/healthz",                                       handler: placeholder("healthz") },
  { method: "POST", path: "/v1/providers",                                  management: true, handler: placeholder("providers.create") },
  { method: "GET",  path: "/v1/providers",                                  management: true, handler: placeholder("providers.list") },
  { method: "POST", path: "/v1/providers/:providerId/customers",             management: true, handler: placeholder("customers.create") },
  { method: "GET",  path: "/v1/providers/:providerId/customers",             management: true, handler: placeholder("customers.list") },
  { method: "POST", path: "/v1/workspaces",                                 management: true, handler: placeholder("workspaces.create") },
  { method: "GET",  path: "/v1/workspaces",                                 management: true, handler: placeholder("workspaces.list") },
  { method: "POST", path: "/v1/leases/issue",                               management: true, handler: placeholder("leases.issue") },
  { method: "POST", path: "/v1/leases/verify",                                                   handler: placeholder("leases.verify") },
  { method: "POST", path: "/v1/policies/issue",                             management: true, handler: placeholder("policies.issue") },
  { method: "POST", path: "/v1/policies/sync",                              management: true, handler: placeholder("policies.sync") },
  { method: "GET",  path: "/v1/usage/summary",                              management: true, handler: placeholder("usage.summary") },
  { method: "POST", path: "/v1/billing/pricing-rules",                      management: true, handler: placeholder("billing.pricing-rules.create") },
  { method: "GET",  path: "/v1/billing/pricing-rules",                      management: true, handler: placeholder("billing.pricing-rules.list") },
  { method: "POST", path: "/v1/billing/invoices/draft",                     management: true, handler: placeholder("billing.invoices.draft") },
  { method: "GET",  path: "/v1/billing/invoices",                           management: true, handler: placeholder("billing.invoices.list") },
  { method: "GET",  path: "/v1/billing/invoices/:id",                       management: true, handler: placeholder("billing.invoices.get") },
  { method: "POST", path: "/v1/billing/invoices/:id/payment-handoff",       management: true, handler: placeholder("billing.invoices.payment-handoff") },
  { method: "POST", path: "/v1/meter/upload",                                                    handler: placeholder("meter.upload") },
  { method: "POST", path: "/v1/tsa/manual-attest",                          management: true, handler: placeholder("tsa.manual-attest") },
  { method: "GET",  path: "/v1/tsa/manual-attestations",                    management: true, handler: placeholder("tsa.manual-attestations.list") },
  { method: "GET",  path: "/v1/tsa/manual-attestations/latest",            management: true, handler: placeholder("tsa.manual-attestations.latest") },
];
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test packages/core/test/route-table.test.js`
Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/routes.js packages/core/test/route-table.test.js
git commit -m "feat(core): declare route table for all 22 license-server endpoints"
```

---

### Task 3: Wire a dispatcher in `createLicenseFetchHandler` that uses the table

**Files:**
- Modify: `packages/core/src/server.js`
- Create: `packages/core/test/dispatcher.test.js` (or reuse existing `server.test.js` if the new test is a superset)

The dispatcher replaces the `if`-chain. Behavior must match the current handler exactly for at least three representative routes. Then we migrate the rest in Task 4.

**Auth model — three cases the dispatcher must honour:**

- **Management** (`management: true`): the dispatcher calls `authenticateManagementRequest` before invoking the handler. The vast majority of routes fall here.
- **Open** (no `management` flag, e.g. `/healthz`, `/v1/leases/verify`): the dispatcher does no auth at all. `/v1/leases/verify` is the client-side SDK endpoint — any caller may POST to it.
- **Self-authed** (no `management` flag, e.g. `/v1/meter/upload`): the dispatcher does no auth, but the route's own handler performs dual-mode auth (it first tries `authenticateDirectMeterUpload` via the `x-skillpack-lease-token` header; if that fails it falls through to `authenticateManagementRequest`). The route descriptor carries no flag; the auth logic lives entirely inside the handler body.

The dispatcher must only run management auth when `route.management === true`. A missing or falsy flag is the neutral default — the dispatcher passes the request straight to the handler.

- [ ] **Step 1: Write failing dispatcher test (table-driven)**

```js
// packages/core/test/dispatcher.test.js
import { describe, test, expect } from "bun:test";
import { createLicenseFetchHandler } from "../src/server.js";
import { createInMemoryLeaseStore } from "../src/storage.js";

const handler = createLicenseFetchHandler({
  signingPrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  signingPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
  leaseStore: createInMemoryLeaseStore(),
  managementApiKey: "test-key",
});

async function call(path, init = {}) {
  const request = new Request(`http://local${path}`, init);
  return handler(request);
}

describe("dispatcher routes through the table", () => {
  test("GET /healthz returns 200 without auth", async () => {
    const res = await call("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "license-server" });
  });

  test("POST /v1/providers without management key returns 401", async () => {
    const res = await call("/v1/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "p1" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /v1/providers with valid management key reaches the handler", async () => {
    const res = await call("/v1/providers", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ providerId: "p1", name: "Acme" }),
    });
    // Placeholder handlers throw, so the dispatcher must return 500 with that error.
    // Once Task 4 lands, this should be 201 with a created provider.
    const body = await res.json();
    expect(body.error).toContain("providers.create");
  });

  test("unknown route returns 404", async () => {
    const res = await call("/v1/nonexistent");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/core/test/dispatcher.test.js`
Expected: FAIL (current code uses `if`-chain; this test expects dispatcher-shaped errors).

- [ ] **Step 3: Replace the handler body in `server.js`**

Open `packages/core/src/server.js`. Keep imports, `json`, `readBody`, `getRequiredString`, `getStoreMethod`, `getProviderIdForCustomerRoute`, `isManagementRoute`, `authenticateManagementRequest`, `hasDirectLeaseCommercialField`, `parsePositiveInteger`. Delete the entire body of `fetch(request)` (lines ~187–660). Replace with:

```js
import { matchRoute, routes } from "./routes.js";

function jsonResponse({ status = 200, body } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status, error) {
  return jsonResponse({ status, body: { error } });
}

function findRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const result = matchRoute(route.path, pathname);
    if (result.matches) return { route, params: result.params };
  }
  return null;
}

function isManagementMatched(method, pathname) {
  for (const route of routes) {
    if (!route.management) continue;
    if (route.method !== method) continue;
    if (matchRoute(route.path, pathname).matches) return true;
  }
  return false;
}

return async function fetch(request) {
  const url = new URL(request.url);
  const nowSec = Math.floor(Date.now() / 1000);

  if (isManagementMatched(request.method, url.pathname)) {
    const authError = await authenticateManagementRequest(request, {
      managementApiKey,
      managementAuthenticator,
    });
    if (authError) return authError;
  }

  const found = findRoute(request.method, url.pathname);
  if (!found) return errorResponse(404, "not_found");

  const { route, params } = found;
  const ctx = {
    store: leaseStore,
    providers: paymentProviders,
    tsaMonitor,
    attestationContract,
    request,
    url,
    nowSec,
    params,
    body: null,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      ctx.body = await readBody(request);
    } catch (error) {
      return errorResponse(400, error.message);
    }
  }

  try {
    const result = await route.handler(ctx);
    if (result instanceof Response) return result;
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("route_not_implemented")) {
      return errorResponse(500, error.message);
    }
    return errorResponse(500, error instanceof Error ? error.message : "internal_error");
  }
};
```

- [ ] **Step 4: Run dispatcher tests**

Run: `bun test packages/core/test/dispatcher.test.js`
Expected: 4 passing.

- [ ] **Step 5: Run full core test suite**

Run: `bun test packages/core/`
Expected: All previous tests in `server.test.js` fail because the original `if`-chain handlers are gone. That's expected; Task 4 ports them.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/server.js packages/core/test/dispatcher.test.js
git commit -m "refactor(core): route handler through declarative table"
```

---

### Task 4: Port every original handler into the route table

**Files:**
- Modify: `packages/core/src/routes.js`

Migrate the 22 `if`-branch bodies one route at a time. Each migration is a small, behavior-preserving move. Run the full test suite after each batch of ~5 routes to catch regressions early.

- [ ] **Step 1: Port `/healthz`**

```js
// in routes.js
{ method: "GET", path: "/healthz", handler: () => ({ status: 200, body: { ok: true, service: "license-server" } }) },
```

Run: `bun test packages/core/test/server.test.js packages/core/test/dispatcher.test.js`
Expected: any healthz tests pass.

- [ ] **Step 2: Port provider routes (POST + GET)**

The body of the original branches lives in `server.js` around lines 203–230. Translate:

```js
async function providersCreate(ctx) {
  const body = validateProviderCreateContract(ctx.body);
  const saveProvider = ctx.store.saveProvider ?? getStoreMethod(ctx.store, "saveProvider");
  const saved = await saveProvider(body);
  return { status: 201, body: { provider: saved } };
}
async function providersList(ctx) {
  const listProviders = ctx.store.listProviders ?? getStoreMethod(ctx.store, "listProviders");
  return { status: 200, body: { providers: await listProviders() } };
}
```

Replace the placeholders in the table. Add `getStoreMethod` to the imports at the top of `routes.js`.

- [ ] **Step 3: Port customer routes (POST + GET)**

The customer route needs `ctx.params.providerId`. Use the original `getProviderIdForCustomerRoute`-equivalent logic, or directly read from `ctx.params.providerId` (now the matcher handles it).

- [ ] **Step 4: Port workspace routes (POST + GET)**

- [ ] **Step 5: Port lease routes (issue, verify)**

- [ ] **Step 6: Port policy routes (issue, sync)**

- [ ] **Step 7: Port usage summary**

- [ ] **Step 8: Port billing routes (pricing-rules create + list, invoices draft + list + get + payment-handoff)**

- [ ] **Step 9: Port meter upload**

- [ ] **Step 10: Port TSA routes (manual-attest, manual-attestations list, latest)**

- [ ] **Step 11: Run full test suite**

Run: `bun test packages/core/`
Expected: all of `server.test.js`, `dispatcher.test.js`, `routes.test.js`, `route-table.test.js` pass.

- [ ] **Step 12: Commit**

```bash
git add packages/core/src/routes.js
git commit -m "refactor(core): port all 22 license-server endpoints into route table"
```

---

### Task 5: Delete `isManagementRoute` and shrink `server.js`

**Files:**
- Modify: `packages/core/src/server.js`
- Modify: `packages/core/src/index.js`

The standalone `isManagementRoute` function and the `getProviderIdForCustomerRoute` helper are no longer needed — `isManagementMatched` from Task 3 and `ctx.params.providerId` from the matcher replace them.

- [ ] **Step 1: Delete dead helpers from `server.js`**

Remove `isManagementRoute` and `getProviderIdForCustomerRoute`. Confirm no references remain:

```bash
grep -n "isManagementRoute\|getProviderIdForCustomerRoute" packages/core/src/
```

Expected: no matches.

- [ ] **Step 2: Re-export the routes module from `core/src/index.js`**

```js
// packages/core/src/index.js
export { routes, matchRoute } from "./routes.js";
```

- [ ] **Step 3: Verify `server.js` is ≤ 200 lines**

```bash
wc -l packages/core/src/server.js
```

Expected: ≤ 200. If over, identify leftover helpers and move them into `routes.js` or a new `helpers.js` sibling.

- [ ] **Step 4: Run full test suite**

Run: `bun test packages/`
Expected: all green. Worker-level tests in `apps/api/test/` and `apps/dashboard/test/` should also pass since they only call `createLicenseFetchHandler`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/server.js packages/core/src/index.js
git commit -m "refactor(core): remove duplicated management-route checks; shrink server.js to <=200 lines"
```

---

## Acceptance criteria

- `packages/core/src/server.js` ≤ 200 lines (was 662).
- `isManagementRoute` and `getProviderIdForCustomerRoute` are deleted.
- Adding a new endpoint requires editing only `routes.js` (and any new store method).
- All existing tests in `packages/core/`, `apps/api/`, and `apps/dashboard/` pass unchanged.
- `wc -l packages/core/src/server.js` reports ≤ 200.

## Out of scope

- Changing route behavior or response shapes.
- Migrating the runtime to use the new table (covered by the runtime canonicalization plan).
- Touching the dashboard or CLI.
