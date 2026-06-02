# Runtime Canonicalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the policy, lease, and crypto utility re-implementations in the runtime package. All helpers come from `@skillpack/protocol` and `@skillpack/crypto`; nothing in `packages/runtime/` redefines them.

**Architecture:** Delete redundant copies. Update imports. Update the one test file that imports the wrong copy. Behavior is preserved by definition (the canonical implementations are already exercised by `packages/protocol/test/policy.test.js`).

**Tech Stack:** Bun, plain JavaScript. The runtime is `.mjs`; the canonical sources are `.js` ESM. Imports work across both.

**Reference spec:** `docs/superpowers/specs/2026-06-01-structural-cleanup.md` (Subsystem 2).

---

## File Structure

- **Modify:** `packages/runtime/src/server.mjs` — delete re-implementations, import from canonical sources
- **Modify:** `packages/runtime/src/index.js` — keep `verifyLeaseForRuntime` here only
- **Modify:** `packages/runtime/src/runtime-meter.mjs` — drop crypto utilities, import from `@skillpack/crypto`
- **Modify:** `packages/runtime/src/server-util.mjs` — keep only genuinely runtime-internal helpers
- **Modify:** `packages/runtime/test/policy-enforcement.test.js` — import from canonical sources
- **Create:** `packages/runtime/test/no-duplicate-definitions.test.js` — guard against regressions

---

### Task 1: Replace runtime's `validatePolicySnapshot` with the canonical import

**Files:**
- Modify: `packages/runtime/src/server.mjs`

The runtime has its own `validatePolicySnapshot` at line 128. The canonical one lives in `packages/protocol/src/policy.js:33`. Replace the local definition with an import.

- [ ] **Step 1: Confirm the runtime import path is already wired**

Read the top of `packages/runtime/src/server.mjs`. Verify it already imports from `@skillpack/protocol` (it should, per the audit). Note the import block.

- [ ] **Step 2: Add `validatePolicySnapshot` to the existing protocol import**

If the existing import block looks like:

```js
import { foo, bar } from "@skillpack/protocol";
```

Extend it to include `validatePolicySnapshot`. If the import doesn't exist, add:

```js
import { validatePolicySnapshot } from "@skillpack/protocol";
```

- [ ] **Step 3: Delete the local definition in `server.mjs`**

Remove the function definition starting at `export function validatePolicySnapshot(policy) {` and ending at its closing brace. Confirm no other in-file callers exist:

```bash
grep -n "validatePolicySnapshot" packages/runtime/src/server.mjs
```

Expected: only the import line remains.

- [ ] **Step 4: Run runtime tests**

Run: `bun test packages/runtime/test/`
Expected: all green. The runtime's policy behavior is unchanged because it now calls the canonical implementation.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/server.mjs
git commit -m "refactor(runtime): import validatePolicySnapshot from @skillpack/protocol"
```

---

### Task 2: Replace remaining policy evaluators

**Files:**
- Modify: `packages/runtime/src/server.mjs`

The runtime also re-implements `evaluateUsageState`, `evaluateTimeState`, `evaluatePolicyDecision`, `evaluateEffectiveTimeWindow`, `evaluatePolicyToolCallDecision`.

- [ ] **Step 1: List local definitions to delete**

```bash
grep -n "^export function evaluate" packages/runtime/src/server.mjs
```

Expected output (approximate):
- `evaluateUsageState`
- `evaluateTimeState`
- `evaluatePolicyDecision`
- `evaluateEffectiveTimeWindow`
- `evaluatePolicyToolCallDecision`

- [ ] **Step 2: Add canonical imports**

Extend the `@skillpack/protocol` import block to include all five names.

- [ ] **Step 3: Delete each local definition**

For each function in the list above, delete the `export function` block. Confirm the grep in step 1 now returns only the import line.

- [ ] **Step 4: Run runtime tests**

Run: `bun test packages/runtime/test/`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/server.mjs
git commit -m "refactor(runtime): import policy evaluators from @skillpack/protocol"
```

---

### Task 3: Replace `validateLeasePayload` with the canonical import

**Files:**
- Modify: `packages/runtime/src/server.mjs`
- Modify: `packages/runtime/src/index.js`

The runtime has its own `validateLeasePayload` (or equivalent lease header/payload check) at the top of `server.mjs`. The canonical one is in `packages/protocol/src/index.js`.

- [ ] **Step 1: Locate the local definition**

```bash
grep -n "validateLeasePayload\|lease_invalid\|payload" packages/runtime/src/server.mjs | head -30
```

- [ ] **Step 2: Replace with canonical import**

Add `validateLeasePayload` to the `@skillpack/protocol` import. Delete the local definition. Update any local call sites that previously used a different function name (audit shows `decodeLeaseParts` in `index.js` is fine — keep it).

- [ ] **Step 3: Run runtime tests**

Run: `bun test packages/runtime/test/runtime.test.js`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/src/server.mjs packages/runtime/src/index.js
git commit -m "refactor(runtime): import validateLeasePayload from @skillpack/protocol"
```

---

### Task 4: Consolidate `verifyLeaseForRuntime` into one definition

**Files:**
- Modify: `packages/runtime/src/server.mjs`
- Modify: `packages/runtime/src/index.js`

`verifyLeaseForRuntime` is defined in both `index.js:34` and `server.mjs:74`. Keep the one in `index.js`; have `server.mjs` import it.

- [ ] **Step 1: Confirm the function body is identical in both files**

```bash
diff <(sed -n '/^export function verifyLeaseForRuntime/,/^}/p' packages/runtime/src/index.js) \
     <(sed -n '/^function verifyLeaseForRuntime/,/^}/p' packages/runtime/src/server.mjs)
```

Expected: identical.

- [ ] **Step 2: Add an import in `server.mjs`**

Add at the top of the runtime's protocol import block:

```js
import { verifyLeaseForRuntime } from "./index.js";
```

(Or import from a path that doesn't create a cycle — adjust if `index.js` re-exports from `server.mjs`.)

- [ ] **Step 3: Delete the local definition in `server.mjs`**

Remove the `function verifyLeaseForRuntime({ ... })` block. Confirm only one definition exists:

```bash
grep -rn "^function verifyLeaseForRuntime\|^export function verifyLeaseForRuntime" packages/runtime/src/
```

Expected: one match (in `index.js`).

- [ ] **Step 4: Run runtime tests**

Run: `bun test packages/runtime/test/`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/server.mjs packages/runtime/src/index.js
git commit -m "refactor(runtime): consolidate verifyLeaseForRuntime into single definition"
```

---

### Task 5: Replace crypto utilities in `runtime-meter.mjs`

**Files:**
- Modify: `packages/runtime/src/runtime-meter.mjs`

`runtime-meter.mjs` has its own `toBase64Url`, `fromBase64Url`, `sortJson`, `canonicalJson`. The canonical versions are in `packages/crypto/src/index.js`.

- [ ] **Step 1: Add canonical imports**

```js
import { canonicalJson, toBase64Url, fromBase64Url } from "@skillpack/crypto";
```

- [ ] **Step 2: Delete local definitions**

Remove the four local function definitions. Update any internal `runtimeMeterInternals` export to remove the deleted names.

- [ ] **Step 3: Run tests**

Run: `bun test packages/runtime/test/`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/src/runtime-meter.mjs
git commit -m "refactor(runtime): import crypto utilities from @skillpack/crypto in runtime-meter"
```

---

### Task 6: Trim `server-util.mjs` to runtime-internal helpers only

**Files:**
- Modify: `packages/runtime/src/server-util.mjs`

`server-util.mjs` re-exports `toBase64Url`, `fromBase64Url`, `sortJson`, `canonicalJson`, plus `sha256Hex`, `isUnsafeArchivePath`, `ensureSafePathWithin`. The first four are duplicates of `@skillpack/crypto`. The latter three are genuinely runtime-internal.

- [ ] **Step 1: Delete the four duplicate definitions**

Remove `toBase64Url`, `fromBase64Url`, `sortJson`, `canonicalJson` from `server-util.mjs`. Keep `sha256Hex`, `isUnsafeArchivePath`, `ensureSafePathWithin`.

- [ ] **Step 2: Update `server.mjs` imports**

`server.mjs` currently imports the deleted helpers from `./server-util.mjs`. Switch those imports to `@skillpack/crypto`:

```js
import { canonicalJson, toBase64Url, fromBase64Url } from "@skillpack/crypto";
import { sha256Hex, isUnsafeArchivePath, ensureSafePathWithin } from "./server-util.mjs";
```

- [ ] **Step 3: Run tests**

Run: `bun test packages/runtime/test/server-security.test.js packages/runtime/test/`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/src/server-util.mjs packages/runtime/src/server.mjs
git commit -m "refactor(runtime): drop duplicate crypto utilities from server-util.mjs"
```

---

### Task 7: Fix the test that imports the wrong copy

**Files:**
- Modify: `packages/runtime/test/policy-enforcement.test.js`

`policy-enforcement.test.js:4` imports `validatePolicySnapshot` and `evaluatePolicyToolCallDecision` from `../src/server.mjs`. After Tasks 1 and 2, those names are no longer exported from `server.mjs`.

- [ ] **Step 1: Update the import**

Change the import to:

```js
import { validatePolicySnapshot, evaluatePolicyToolCallDecision } from "@skillpack/protocol";
```

- [ ] **Step 2: Run the test**

Run: `bun test packages/runtime/test/policy-enforcement.test.js`
Expected: green.

- [ ] **Step 3: Verify there's no semantic drift**

Diff each test's expected output against the canonical `packages/protocol/test/policy.test.js` — they should cover the same surface. If the runtime tests have unique cases not in the protocol tests, keep them; if they only duplicate, delete this file.

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/test/policy-enforcement.test.js
git commit -m "test(runtime): import policy helpers from canonical @skillpack/protocol"
```

---

### Task 8: Add a guard test against regressions

**Files:**
- Create: `packages/runtime/test/no-duplicate-definitions.test.js`

A short test that fails if any of the canonical utility names is re-defined in `packages/runtime/src/`.

- [ ] **Step 1: Write the guard test**

```js
// packages/runtime/test/no-duplicate-definitions.test.js
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  "function toBase64Url",
  "function fromBase64Url",
  "function sortJson",
  "function canonicalJson",
  "function validatePolicySnapshot",
  "function evaluateUsageState",
  "function evaluateTimeState",
  "function evaluatePolicyDecision",
  "function evaluatePolicyToolCallDecision",
  "function evaluateEffectiveTimeWindow",
  "function validateLeasePayload",
];

const ROOT = join(import.meta.dir, "..", "src");

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.endsWith(".js") || entry.endsWith(".mjs")) out.push(full);
  }
  return out;
}

describe("runtime does not redefine canonical utilities", () => {
  for (const file of listJsFiles(ROOT)) {
    const content = readFileSync(file, "utf8");
    for (const snippet of FORBIDDEN) {
      test(`${file} must not contain "${snippet}"`, () => {
        expect(content.includes(snippet)).toBe(false);
      });
    }
  }
});
```

- [ ] **Step 2: Run the test**

Run: `bun test packages/runtime/test/no-duplicate-definitions.test.js`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add packages/runtime/test/no-duplicate-definitions.test.js
git commit -m "test(runtime): guard against canonical-utility redefinition"
```

---

## Acceptance criteria

- No function with a name matching `toBase64Url|fromBase64Url|sortJson|canonicalJson|validatePolicySnapshot|evaluatePolicyToolCallDecision|evaluateUsageState|evaluateTimeState|evaluatePolicyDecision|evaluateLeasePayload|verifyLeaseForRuntime` is defined in more than one file across `packages/`.
- `packages/runtime/src/server.mjs` shrinks by at least 200 lines.
- All existing runtime tests pass.
- The new guard test passes.

## Out of scope

- Behavior changes to policy decisions or lease validation.
- Adding new policy features.
- Touching the dashboard, CLI, or core server.
