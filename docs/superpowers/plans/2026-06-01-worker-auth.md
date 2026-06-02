# Shared Worker Auth Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the auth helpers duplicated between `apps/api/src/index.js` and `apps/dashboard/src/index.js` into a shared `packages/core/src/worker-auth.js` module. Each worker keeps its own wiring but imports the canonical helpers.

**Architecture:** A stateless-ish module exposing `getEnvString`, `getOptionalEnvString`, `getPemFromEnv`, `getManagementAuthMode`, `getClerkClient`, `isValidSharedManagementKey`, `createManagementAuthOptions`, `addUpstreamAuthHeaders`, `getClerkAuthorizedParties`. The two workers each import the names they need and pass their own cache objects.

**Tech Stack:** Plain JavaScript ESM. The auth module is browser/Worker-agnostic — no Node-only built-ins.

**Reference spec:** `docs/superpowers/specs/2026-06-01-structural-cleanup.md` (Subsystem 6).

---

## File Structure

- **Create:** `packages/core/src/worker-auth.js`
- **Create:** `packages/core/test/worker-auth.test.js`
- **Modify:** `apps/api/src/index.js` — drop duplicated helpers, import from `worker-auth`
- **Modify:** `apps/dashboard/src/index.js` — drop duplicated helpers, import from `worker-auth`
- **Modify:** `packages/core/src/index.js` — re-export the new module

---

### Task 1: Create the worker-auth module

**Files:**
- Create: `packages/core/src/worker-auth.js`

- [ ] **Step 1: Move the env helpers**

```js
// packages/core/src/worker-auth.js
export function getEnvString(env, key, { prefix = "worker" } = {}) {
  const value = env?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${prefix}_missing_env_${key}`);
  }
  return value;
}

export function getOptionalEnvString(env, key) {
  const value = env?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getPemFromEnv(env, key, { prefix = "worker" } = {}) {
  const direct = env?.[key];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const base64 = env?.[`${key}_BASE64`];
  if (typeof base64 === "string" && base64.length > 0) {
    if (typeof Buffer === "undefined") {
      throw new Error(`${prefix}_nodejs_compat_required: add nodejs_compat to wrangler.jsonc compatibility_flags`);
    }
    return Buffer.from(base64, "base64").toString("utf8");
  }
  throw new Error(`${prefix}_missing_env_${key}`);
}
```

- [ ] **Step 2: Move the management-auth-mode helpers**

```js
export function getManagementAuthMode(env, { defaultMode = "shared-key" } = {}) {
  const mode = env?.SKILLPACK_MANAGEMENT_AUTH_MODE ?? env?.SKILLPACK_API_AUTH_MODE ?? defaultMode;
  if (mode === "shared-key" || mode === "clerk" || mode === "hybrid") return mode;
  throw new Error("invalid_management_auth_mode");
}

export function getClerkAuthorizedParties(env) {
  const dashboardOrigin = getOptionalEnvString(env, "SKILLPACK_DASHBOARD_ORIGIN");
  return dashboardOrigin ? [dashboardOrigin] : undefined;
}
```

- [ ] **Step 3: Move the Clerk-client factory and shared-key validator**

```js
export function getClerkClient(env, { cache, createClerkClientImpl }) {
  if (cache.has(env)) return cache.get(env);
  const secretKey = getEnvString(env, "CLERK_SECRET_KEY", { prefix: "worker" });
  const publishableKey = getOptionalEnvString(env, "CLERK_PUBLISHABLE_KEY");
  const clerkClient = createClerkClientImpl({
    secretKey,
    ...(publishableKey ? { publishableKey } : {}),
  });
  cache.set(env, clerkClient);
  return clerkClient;
}

export async function isValidSharedManagementKey(request, managementApiKey) {
  if (typeof managementApiKey !== "string") return false;
  const providedApiKey = request.headers.get("x-api-key") ?? request.headers.get("X-Api-Key");
  if (typeof providedApiKey !== "string") return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(providedApiKey)),
    crypto.subtle.digest("SHA-256", encoder.encode(managementApiKey)),
  ]);
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let diff = providedBytes.length ^ expectedBytes.length;
  for (let i = 0; i < providedBytes.length && i < expectedBytes.length; i += 1) {
    diff |= providedBytes[i] ^ expectedBytes[i];
  }
  return diff === 0;
}
```

- [ ] **Step 4: Move the auth-options factory**

```js
export function createManagementAuthOptions(env, { cache, createClerkClientImpl, defaultMode }) {
  const mode = getManagementAuthMode(env, { defaultMode });
  if (mode === "shared-key") {
    return {
      mode,
      managementApiKey: getEnvString(env, "SKILLPACK_API_KEY"),
      managementAuthenticator: null,
    };
  }
  if (mode === "clerk") {
    return {
      mode,
      managementApiKey: null,
      managementAuthenticator: (request) =>
        authenticateClerk(request, env, { cache, createClerkClientImpl }),
    };
  }
  const managementApiKey = getOptionalEnvString(env, "SKILLPACK_API_KEY");
  return {
    mode,
    managementApiKey: null,
    managementAuthenticator: async (request) => {
      if (managementApiKey && (await isValidSharedManagementKey(request, managementApiKey))) {
        return true;
      }
      return authenticateClerk(request, env, { cache, createClerkClientImpl });
    },
  };
}

async function authenticateClerk(request, env, { cache, createClerkClientImpl }) {
  const clerkClient = getClerkClient(env, { cache, createClerkClientImpl });
  const authorizedParties = getClerkAuthorizedParties(env);
  const state = await clerkClient.authenticateRequest(request, {
    ...(authorizedParties ? { authorizedParties } : {}),
  });
  return state.isAuthenticated === true && Boolean(state.toAuth()?.userId);
}
```

- [ ] **Step 5: Move the upstream-auth-header helper for the dashboard**

```js
export function addUpstreamAuthHeaders(headers, request, env, { defaultMode } = {}) {
  const mode = getManagementAuthMode(env, { defaultMode });
  const incomingAuthorization = request.headers.get("authorization");
  if (mode === "clerk") {
    if (!incomingAuthorization) throw new Error("dashboard_missing_authorization_header");
    headers.set("authorization", incomingAuthorization);
    return;
  }
  if (mode === "hybrid" && incomingAuthorization) {
    headers.set("authorization", incomingAuthorization);
    return;
  }
  const apiKey = mode === "hybrid"
    ? getOptionalEnvString(env, "SKILLPACK_API_KEY")
    : getEnvString(env, "SKILLPACK_API_KEY", { prefix: "dashboard" });
  if (!apiKey) throw new Error("dashboard_missing_env_SKILLPACK_API_KEY");
  headers.set("x-api-key", apiKey);
}
```

- [ ] **Step 6: Re-export from `core/src/index.js`**

```js
// packages/core/src/index.js
export * from "./worker-auth.js";
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/worker-auth.js packages/core/src/index.js
git commit -m "feat(core): add shared worker-auth module"
```

---

### Task 2: Add tests for the module

**Files:**
- Create: `packages/core/test/worker-auth.test.js`

- [ ] **Step 1: Write unit tests**

```js
// packages/core/test/worker-auth.test.js
import { describe, test, expect } from "bun:test";
import {
  getEnvString,
  getOptionalEnvString,
  getManagementAuthMode,
  isValidSharedManagementKey,
  createManagementAuthOptions,
  addUpstreamAuthHeaders,
} from "../src/worker-auth.js";

describe("getEnvString", () => {
  test("returns the value when present", () => {
    expect(getEnvString({ K: "v" }, "K")).toBe("v");
  });
  test("throws with the configured prefix", () => {
    expect(() => getEnvString({}, "K", { prefix: "dashboard" })).toThrow("dashboard_missing_env_K");
  });
});

describe("getManagementAuthMode", () => {
  test("defaults to shared-key when no env var", () => {
    expect(getManagementAuthMode({})).toBe("shared-key");
  });
  test("honors SKILLPACK_API_AUTH_MODE", () => {
    expect(getManagementAuthMode({ SKILLPACK_API_AUTH_MODE: "clerk" })).toBe("clerk");
  });
  test("rejects unknown modes", () => {
    expect(() => getManagementAuthMode({ SKILLPACK_API_AUTH_MODE: "x" })).toThrow();
  });
});

describe("isValidSharedManagementKey", () => {
  test("returns true for matching key", async () => {
    const request = new Request("http://x", { headers: { "x-api-key": "secret" } });
    expect(await isValidSharedManagementKey(request, "secret")).toBe(true);
  });
  test("returns false for mismatching key", async () => {
    const request = new Request("http://x", { headers: { "x-api-key": "other" } });
    expect(await isValidSharedManagementKey(request, "secret")).toBe(false);
  });
  test("returns false when no key provided", async () => {
    expect(await isValidSharedManagementKey(new Request("http://x"), "secret")).toBe(false);
  });
});

describe("addUpstreamAuthHeaders", () => {
  test("shared-key mode sets x-api-key", () => {
    const headers = new Headers();
    addUpstreamAuthHeaders(headers, new Request("http://x"), { SKILLPACK_API_KEY: "k" });
    expect(headers.get("x-api-key")).toBe("k");
  });
  test("clerk mode forwards authorization", () => {
    const headers = new Headers();
    const request = new Request("http://x", { headers: { authorization: "Bearer t" } });
    addUpstreamAuthHeaders(headers, request, { SKILLPACK_API_AUTH_MODE: "clerk" });
    expect(headers.get("authorization")).toBe("Bearer t");
  });
  test("clerk mode throws if no authorization header", () => {
    const headers = new Headers();
    expect(() => addUpstreamAuthHeaders(headers, new Request("http://x"), { SKILLPACK_API_AUTH_MODE: "clerk" }))
      .toThrow("dashboard_missing_authorization_header");
  });
});

describe("createManagementAuthOptions", () => {
  test("shared-key returns apiKey + no authenticator", () => {
    const opts = createManagementAuthOptions({ SKILLPACK_API_KEY: "k" }, { cache: new WeakMap(), createClerkClientImpl: () => ({}) });
    expect(opts.managementApiKey).toBe("k");
    expect(opts.managementAuthenticator).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test packages/core/test/worker-auth.test.js`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add packages/core/test/worker-auth.test.js
git commit -m "test(core): cover worker-auth helpers"
```

---

### Task 3: Migrate `apps/api/src/index.js`

**Files:**
- Modify: `apps/api/src/index.js`

- [ ] **Step 1: Replace local definitions with imports**

Remove the local `getEnvString`, `getOptionalEnvString`, `getPemFromEnv`, `readApiKey`, `isValidSharedManagementKey`, `getManagementAuthMode`, `getClerkAuthorizedParties`, `getClerkClient`, `authenticateClerkManagementRequest`, `createManagementAuthOptions` from `apps/api/src/index.js`. Add:

```js
import {
  getEnvString,
  getOptionalEnvString,
  getPemFromEnv,
  isValidSharedManagementKey,
  getClerkAuthorizedParties,
  getClerkClient,
  createManagementAuthOptions,
} from "@skillpack/core";
```

(Note: `readApiKey` is no longer needed externally — `isValidSharedManagementKey` reads the header itself.)

- [ ] **Step 2: Update internal call sites**

If the API worker referenced the old function names (e.g. `authenticateClerkManagementRequest`), replace with calls that go through `createManagementAuthOptions`. The license server in `packages/core/src/server.js` still has its own `authenticateManagementRequest` that the worker calls. That helper takes `{ managementApiKey, managementAuthenticator }` — keep that contract intact.

- [ ] **Step 3: Run API tests**

Run: `bun test apps/api/test/`
Expected: green.

- [ ] **Step 4: Verify file size**

```bash
wc -l apps/api/src/index.js
```

Expected: shrunk by ≥ 40 lines (was 235; target ≤ 195).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/index.js
git commit -m "refactor(api): import auth helpers from @skillpack/core/worker-auth"
```

---

### Task 4: Migrate `apps/dashboard/src/index.js`

**Files:**
- Modify: `apps/dashboard/src/index.js`

- [ ] **Step 1: Replace local definitions with imports**

Remove the local `getRequiredEnvString`, `getOptionalEnvString`, `getDashboardOrigin` (or keep it if it's not duplicated), `getClerkClient`, `getManagementAuthMode`, `addUpstreamAuthHeaders`, `authenticateDashboardRequest`. Add:

```js
import {
  getEnvString as getRequiredEnvString,
  getOptionalEnvString,
  getClerkClient,
  getManagementAuthMode,
  addUpstreamAuthHeaders,
} from "@skillpack/core";
```

(Adjust prefix to `"dashboard"` in the wrapper or pass it through `addUpstreamAuthHeaders`'s `{ defaultMode }` option.)

- [ ] **Step 2: Update internal call sites**

`proxyApiRequest` calls `authenticateDashboardRequest` and `addUpstreamAuthHeaders`. Both should now resolve through the shared module.

- [ ] **Step 3: Run dashboard tests**

Run: `bun test apps/dashboard/test/`
Expected: green.

- [ ] **Step 4: Verify file size**

```bash
wc -l apps/dashboard/src/index.js
```

Expected: shrunk by ≥ 40 lines (was 215; target ≤ 175).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/index.js
git commit -m "refactor(dashboard): import auth helpers from @skillpack/core/worker-auth"
```

---

### Task 5: Verify single-source rule

**Files:** none (verification only)

- [ ] **Step 1: No duplicate definitions**

```bash
grep -rn "^function getEnvString\|^function getOptionalEnvString\|^function getManagementAuthMode\|^function addUpstreamAuthHeaders\|^function isValidSharedManagementKey\|^function getClerkClient" packages/ apps/
```

Expected: one definition of each, all in `packages/core/src/worker-auth.js`.

- [ ] **Step 2: Run full test suite**

Run: `bun test packages/ apps/`
Expected: all green.

- [ ] **Step 3: Commit any stragglers**

If the file-size targets weren't met, identify the leftover helpers and continue splitting. Commit when the goals are met.

---

## Acceptance criteria

- No auth helper is defined in more than one file across the repo.
- `apps/api/src/index.js` and `apps/dashboard/src/index.js` each shrink by ≥ 40 lines.
- All existing tests in `packages/core/`, `apps/api/`, and `apps/dashboard/` pass.
- Adding a new auth mode (e.g. `mtls`, `clerk-jwt-claim`) requires editing only `worker-auth.js` and one test file.

## Out of scope

- Adding a new auth mode.
- Changing auth behavior or wire format.
- Migrating to a different auth library.
