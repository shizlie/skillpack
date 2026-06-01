# CLI Command Descriptor Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 12 hand-written subcommand functions in `apps/cli/src/index.js` with a single declarative command table. Replace the 16-branch `if/else` dispatcher in `runSkillpackCli` with a tree walk. The file shrinks from 701 to ≤ 200 lines.

**Architecture:** A nested `commands` object keyed by `group → action → descriptor`. Each descriptor declares: which flags are required, how to validate them, how to build the request, and (for non-HTTP subcommands like `bundle build`) a custom executor. A single `runCommand(args, fetchImpl)` walks the tree and dispatches.

**Tech Stack:** Plain JavaScript ESM. The CLI uses Node's `fetch` by default, overridable for tests.

**Reference spec:** `docs/superpowers/specs/2026-06-01-structural-cleanup.md` (Subsystem 5).

---

## File Structure

- **Create:** `apps/cli/src/commands.js` — the descriptor table
- **Create:** `apps/cli/src/runner.js` — `runCommand(args, fetchImpl)` and helpers
- **Modify:** `apps/cli/src/index.js` — keep only `runSkillpackCli`; delegate to `runner.js`
- **Modify:** `apps/cli/test/cli.test.js` — replace per-command hand-written tests with a loop

---

### Task 1: Define the command table skeleton

**Files:**
- Create: `apps/cli/src/commands.js`

Each descriptor is a small object. The minimal schema:

```js
{
  required: ["customer-id", "seat-id"],
  buildRequest: (flags) => ({ method: "POST", path: "/v1/leases/issue", body: {...} }),
  // OR for local-only commands:
  exec: (flags) => { /* returns { status, body, stderr } */ },
}
```

- [ ] **Step 1: Write a placeholder table**

```js
// apps/cli/src/commands.js
//
// Each subcommand is a descriptor. The runner walks the table, validates
// required flags, builds the request (or runs the local exec), and returns
// { status, body, stderr }.

export const commands = {
  license: {
    issue: {
      required: ["customer-id"],
      buildRequest: (flags) => ({
        method: "POST", path: "/v1/leases/issue",
        body: {
          customerId: flags["customer-id"],
          seatId: flags["seat-id"] ?? "default",
          vendorId: flags["vendor-id"] ?? "skillpack-vendor",
          ttlSec: parseIntFlag(flags["ttl-sec"]),
          nowSec: parseIntFlag(flags["now-sec"]) ?? Math.floor(Date.now() / 1000),
          lastTsaTokenAtSec: parseIntFlag(flags["last-tsa-token-at-sec"]),
          tsaTicketId: flags["tsa-ticket-id"] ?? flags["ticket-id"],
          maxManualAttestationAgeSec: parseIntFlag(flags["max-manual-attestation-age-sec"]),
        },
      }),
    },
    verify: {
      required: ["lease-token", "public-key-file"],
      exec: (flags) => {
        // Uses local crypto; no fetch needed.
        // ... move logic from the old verifyLease()
      },
    },
  },
  tsa: {
    "manual-attest": { /* ... */ },
    "latest-attestation": { /* ... */ },
  },
  provider:  { create: { /* ... */ } },
  customer:  { create: { /* ... */ } },
  workspace: { create: { /* ... */ } },
  policy:    { issue: { /* ... */ }, sync: { /* ... */ } },
  meter:     { upload: { /* ... */ } },
  usage:     { summary: { /* ... */ } },
  billing:   {
    "pricing-rule":   { create: { /* ... */ } },
    "invoice":        { draft: { /* ... */ } },
    "payment-handoff":{ create: { /* ... */ } },
  },
  bundle:    { build: { exec: buildBundle } },
};

function parseIntFlag(value) {
  if (value === undefined || value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error("invalid_integer_arg:" + value);
  return parsed;
}
```

(Fill in the placeholders by translating the bodies of the existing `createX`, `issueX`, etc. functions.)

- [ ] **Step 2: Port the body of `issueLease` (already in this task)**

- [ ] **Step 3: Port `verifyLease`**

- [ ] **Step 4: Port `manualAttest`, `latestAttestation`**

- [ ] **Step 5: Port `createProvider`, `createCustomer`, `createWorkspace`**

- [ ] **Step 6: Port `issuePolicy`, `syncPolicy`**

- [ ] **Step 7: Port `uploadMeter`, `usageSummary`**

- [ ] **Step 8: Port `createPricingRule`, `draftInvoice`, `createPaymentHandoff`**

- [ ] **Step 9: Port `buildBundle` (this one uses `exec`, not `buildRequest`)**

- [ ] **Step 10: Commit**

```bash
git add apps/cli/src/commands.js
git commit -m "feat(cli): declare command descriptor table"
```

---

### Task 2: Build the runner

**Files:**
- Create: `apps/cli/src/runner.js`

- [ ] **Step 1: Implement `runCommand`**

```js
// apps/cli/src/runner.js
import { commands } from "./commands.js";
import { parseArgMap, buildServerHeaders, normalizeServerUrl, requireServerUrl } from "./arg-helpers.js";
import { fetchWithRequest } from "./http.js";

export async function runCommand(args, fetchImpl = fetch) {
  const group = args[0];
  const action = args[1];
  const flags = parseArgMap(args.slice(2));
  const descriptor = commands[group]?.[action];
  if (!descriptor) return { status: 2, stderr: usageString(), body: null };

  for (const flag of descriptor.required ?? []) {
    if (!flags[flag]) {
      return { status: 1, stderr: `missing_${flag.replace(/-/g, "_")}\n`, body: null };
    }
  }

  if (descriptor.exec) {
    return descriptor.exec(flags);
  }

  const serverUrl = requireServerUrl(flags);
  const request = descriptor.buildRequest(flags);
  const response = await fetchWithRequest(serverUrl, request, {
    headers: buildServerHeaders(flags),
    fetchImpl,
  });
  return { status: response.status, body: response.body };
}
```

- [ ] **Step 2: Extract the small arg-helpers**

Move `parseArgMap`, `buildServerHeaders`, `normalizeServerUrl`, `requireServerUrl`, `readKey`, `readJson` from the current `index.js` to a new `arg-helpers.js` so the runner can import them.

- [ ] **Step 3: Add `fetchWithRequest`**

```js
// apps/cli/src/http.js
export async function fetchWithRequest(serverUrl, { method, path, body }, { headers, fetchImpl }) {
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetchImpl(new Request(`${serverUrl}${path}`, init));
  return { status: response.status, body: await response.json() };
}
```

- [ ] **Step 4: Implement `usageString`**

```js
function usageString() {
  return [
    "usage: skillpack <group> <action> [flags]",
    "groups:",
    "  license issue|verify",
    "  tsa manual-attest|latest-attestation",
    "  bundle build",
    "  provider create | customer create | workspace create",
    "  policy issue|sync",
    "  meter upload | usage summary",
    "  billing pricing-rule create | invoice draft | payment-handoff create",
  ].join("\n") + "\n";
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/runner.js apps/cli/src/arg-helpers.js apps/cli/src/http.js
git commit -m "feat(cli): introduce runner with command table dispatch"
```

---

### Task 3: Shrink `index.js` to the public entry

**Files:**
- Modify: `apps/cli/src/index.js`

- [ ] **Step 1: Replace the body of `index.js`**

```js
// apps/cli/src/index.js
export { runCommand } from "./runner.js";

import { runCommand } from "./runner.js";

export async function runSkillpackCli(args, io = process, { fetchImpl = fetch } = {}) {
  const result = await runCommand(args, fetchImpl);
  if (result.status === 2) { io.stderr.write(result.stderr); return 2; }
  if (result.status >= 400) { io.stderr.write(JSON.stringify(result.body) + "\n"); return 1; }
  if (result.stderr) io.stderr.write(result.stderr);
  io.stdout.write(JSON.stringify(result.body) + "\n");
  return 0;
}
```

- [ ] **Step 2: Delete the old subcommand functions and dispatcher**

Remove every `async function createX`, `async function issueX`, etc. and the giant `if/else` chain in `runSkillpackCli`. Confirm:

```bash
wc -l apps/cli/src/index.js
```

Expected: ≤ 50 lines.

- [ ] **Step 3: Run existing CLI tests**

Run: `bun test apps/cli/test/`
Expected: most pass; some that targeted the now-removed internal helpers may need updating. Proceed to Task 4.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/index.js
git commit -m "refactor(cli): shrink index.js to public entry; delegate to runner"
```

---

### Task 4: Replace per-command tests with a table-driven loop

**Files:**
- Modify: `apps/cli/test/cli.test.js`

The existing test file (849 lines) hand-writes happy-path + missing-flag tests for each of 12 commands. After the refactor, a single loop covers them all.

- [ ] **Step 1: Define a "happy path" per subcommand**

```js
// apps/cli/test/cli.test.js
import { describe, test, expect, beforeEach } from "bun:test";
import { runCommand } from "../src/runner.js";

const happyPaths = [
  { args: ["license", "issue", "--customer-id", "c1"], mockResponse: { tsaState: { status: "ok" } } },
  { args: ["policy", "issue", "--server-url", "http://x", "--workspace-id", "w1"], mockResponse: { policyId: "p1" } },
  // ... one entry per descriptor
];

let recordedRequest;
function makeMockFetch(mockResponse) {
  return async (request) => {
    recordedRequest = request;
    return new Response(JSON.stringify(mockResponse), { status: 200 });
  };
}

describe("runCommand happy paths", () => {
  for (const { args, mockResponse } of happyPaths) {
    test(`runs ${args.slice(0, 2).join(" ")}`, async () => {
      const result = await runCommand(args, makeMockFetch(mockResponse));
      expect(result.status).toBe(200);
      expect(result.body).toEqual(mockResponse);
    });
  }
});
```

- [ ] **Step 2: Add missing-flag tests via a loop**

```js
const requiredFlagCases = [
  { args: ["license", "issue"], missing: "customer-id" },
  { args: ["policy", "issue", "--server-url", "http://x"], missing: "workspace-id" },
  // ... one per descriptor with at least one `required` flag
];

describe("runCommand missing-required-flag", () => {
  for (const { args, missing } of requiredFlagCases) {
    test(`${args.slice(0, 2).join(" ")} requires --${missing}`, async () => {
      const result = await runCommand(args, makeMockFetch({}));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`missing_${missing.replace(/-/g, "_")}`);
    });
  }
});
```

- [ ] **Step 3: Keep a few targeted tests**

For non-trivial behavior (offline `lease issue`, `bundle build` zip handling, `tsa manual-attest` server fallback), keep hand-written tests. These are unique and worth the cost.

- [ ] **Step 4: Run tests**

Run: `bun test apps/cli/test/`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/test/cli.test.js
git commit -m "test(cli): table-driven tests across all subcommands"
```

---

### Task 5: Verify file-size targets

**Files:** none (verification only)

- [ ] **Step 1: Check sizes**

```bash
wc -l apps/cli/src/index.js apps/cli/src/runner.js apps/cli/src/commands.js apps/cli/src/arg-helpers.js apps/cli/src/http.js
```

Expected: `index.js` ≤ 50, `runner.js` ≤ 100, `commands.js` ≤ 300, helpers each ≤ 50.

- [ ] **Step 2: Run full test suite**

Run: `bun test apps/cli/test/`
Expected: all green.

- [ ] **Step 3: Confirm no duplicates**

```bash
grep -rn "createProvider\|createCustomer\|issueLease\|uploadMeter" apps/cli/src/
```

Expected: at most one definition per name, all in `commands.js`.

---

## Acceptance criteria

- `apps/cli/src/index.js` ≤ 50 lines.
- `commands.js` is the single home for subcommand definitions.
- Adding a new subcommand requires editing only `commands.js` (and possibly adding a test case to the table).
- All existing CLI tests pass.
- The per-subcommand test file is replaced by a single loop.

## Out of scope

- Adding new subcommands.
- Changing the wire format or response shapes.
- Switching to a real CLI framework (commander, yargs, etc.).
