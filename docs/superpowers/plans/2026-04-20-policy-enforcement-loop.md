# Policy Enforcement Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement workspace+seat policy enforcement (usage/time), warning-only degraded mode, and receiver-platform sync so we can demonstrate issue -> use -> warn -> stop -> renew -> continue.

**Architecture:** Add a signed policy snapshot contract and enforce it locally in runtime on every tool call. Keep lease token for identity/counter/time base, and layer policy decision engine above it. Add meter upload and policy sync endpoints to connect receiver with platform.

**Tech Stack:** Bun + TypeScript/JavaScript monorepo, Hono-style license server handlers, Node runtime script, existing crypto/protocol packages.

---

## File Structure

- Create: `packages/protocol/src/policy.js`
- Create: `packages/protocol/test/policy.test.js`
- Modify: `packages/protocol/src/index.js`
- Modify: `packages/runtime/src/server.mjs`
- Create: `packages/runtime/test/policy-enforcement.test.js`
- Modify: `packages/license-server/src/server.js`
- Modify: `packages/license-server/src/storage.js`
- Modify: `packages/license-server/src/storage-sqlite.js`
- Create: `packages/license-server/test/policy-sync.test.js`
- Modify: `packages/cli/src/index.js`
- Modify: `packages/cli/test/cli.test.js`
- Create: `scripts/demo-policy-loop.sh`
- Modify: `docs/runbooks/receiver-verify-install.md`
- Create: `docs/runbooks/policy-loop-demo.md`

---

### Task 1: Define Policy Contract + Decision Engine in Protocol Package

**Files:**
- Create: `packages/protocol/src/policy.js`
- Create: `packages/protocol/test/policy.test.js`
- Modify: `packages/protocol/src/index.js`

- [ ] **Step 1: Write failing policy contract tests**

```js
// packages/protocol/test/policy.test.js
import { describe, test, expect } from "bun:test";
import {
  validatePolicySnapshot,
  evaluateEffectiveTimeWindow,
  evaluateUsageState,
  evaluatePolicyDecision,
} from "../src/policy.js";

describe("policy snapshot", () => {
  test("accepts valid workspace+seat+usage+time policy", () => {
    const policy = {
      policyVersion: 1,
      policyId: "pol_1",
      workspaceId: "ws_1",
      workspacePolicy: { mode: "ENABLED" },
      seatPolicy: { defaultMode: "ENABLED", seats: { seatA: { mode: "ENABLED" } } },
      usagePolicy: {
        unit: "tool_call",
        thresholds: { warningPct: 100, hardStopPct: 120 },
        toolBudgets: { wiki_search: 100 },
      },
      timePolicy: {
        workspace: { startsAtSec: 100, expiresAtSec: 200, graceUntilSec: 260 },
        seatOverrides: { seatA: { startsAtSec: 120, expiresAtSec: 180, graceUntilSec: 240 } },
      },
    };
    expect(() => validatePolicySnapshot(policy)).not.toThrow();
  });

  test("time precedence uses stricter workspace/seat intersection", () => {
    const out = evaluateEffectiveTimeWindow(
      { startsAtSec: 100, expiresAtSec: 200, graceUntilSec: 260 },
      { startsAtSec: 120, expiresAtSec: 180, graceUntilSec: 240 }
    );
    expect(out.startsAtSec).toBe(120);
    expect(out.expiresAtSec).toBe(180);
    expect(out.graceUntilSec).toBe(240);
  });

  test("usage 100-120 is warning, >120 is hard stop", () => {
    expect(evaluateUsageState({ actual: 100, budget: 100 })).toBe("WARNING");
    expect(evaluateUsageState({ actual: 120, budget: 100 })).toBe("WARNING");
    expect(evaluateUsageState({ actual: 121, budget: 100 })).toBe("HARD_STOP");
  });

  test("workspace disabled denies regardless of seat/time/usage", () => {
    const decision = evaluatePolicyDecision({
      workspaceMode: "DISABLED",
      seatMode: "ENABLED",
      timeState: "ACTIVE",
      usageState: "NORMAL",
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCodes).toContain("workspace_disabled");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/protocol/test/policy.test.js`
Expected: FAIL with module/function not found.

- [ ] **Step 3: Implement policy contract + evaluator**

```js
// packages/protocol/src/policy.js
export function validatePolicySnapshot(policy) {
  // validate required fields + enums + threshold ordering
}

export function evaluateEffectiveTimeWindow(workspaceWindow, seatWindow) {
  // stricter wins via intersection; seat optional
}

export function evaluateUsageState({ actual, budget, warningPct = 100, hardStopPct = 120 }) {
  // NORMAL | WARNING | HARD_STOP
}

export function evaluateTimeState({ nowSec, startsAtSec, expiresAtSec, graceUntilSec }) {
  // ACTIVE | GRACE | EXPIRED | NOT_STARTED
}

export function evaluatePolicyDecision({ workspaceMode, seatMode, timeState, usageState }) {
  // returns { decision: ALLOW|ALLOW_WITH_WARNING|DENY, reasonCodes: [] }
}
```

- [ ] **Step 4: Export API from protocol index**

```js
// packages/protocol/src/index.js
export * from "./policy.js";
```

- [ ] **Step 5: Run tests to pass**

Run: `bun test packages/protocol/test/policy.test.js packages/protocol/test/protocol.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/policy.js packages/protocol/src/index.js packages/protocol/test/policy.test.js
git commit -m "feat(protocol): add policy snapshot contract and decision engine"
```

---

### Task 2: Enforce Policy in Runtime Server

**Files:**
- Modify: `packages/runtime/src/server.mjs`
- Create: `packages/runtime/test/policy-enforcement.test.js`

- [ ] **Step 1: Write failing runtime enforcement tests**

```js
// packages/runtime/test/policy-enforcement.test.js
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";

test("runtime denies when workspace disabled", () => {
  // setup temp bundle + policy with workspace DISABLED, then assert non-0/tool denial
});

test("runtime warns (not degrades) at 100-120 usage", () => {
  // invoke calls into warning zone, assert calls still succeed and warning emitted
});

test("runtime denies above 120 usage", () => {
  // invoke call above hard stop, assert denial
});

test("runtime time policy uses stricter seat window", () => {
  // seat override expires sooner than workspace; assert denial after seat grace
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/runtime/test/policy-enforcement.test.js`
Expected: FAIL.

- [ ] **Step 3: Add policy loading + decision checks to runtime**

```js
// packages/runtime/src/server.mjs
// 1) load/verify signed policy snapshot from bundle
// 2) resolve seat mode and effective time window (workspace+seat)
// 3) evaluate usage state from meter counters (tool_call)
// 4) apply decision ALLOW / ALLOW_WITH_WARNING / DENY
// 5) include warning metadata when ALLOW_WITH_WARNING
```

- [ ] **Step 4: Update meter events with policy/decision fields**

```js
appendMeterEvent("tool_call", {
  tool: toolName,
  decision: decision.decision,
  reasonCodes: decision.reasonCodes,
  usageUnit: "tool_call",
  usageDelta: 1,
  policyId,
  seatId,
});
```

- [ ] **Step 5: Run tests to pass**

Run: `bun test packages/runtime/test/runtime.test.js packages/runtime/test/policy-enforcement.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/server.mjs packages/runtime/test/policy-enforcement.test.js
git commit -m "feat(runtime): enforce workspace-seat usage/time policy with warning-only degraded mode"
```

---

### Task 3: Add Platform Policy Sync + Meter Upload APIs

**Files:**
- Modify: `packages/license-server/src/server.js`
- Modify: `packages/license-server/src/storage.js`
- Modify: `packages/license-server/src/storage-sqlite.js`
- Create: `packages/license-server/test/policy-sync.test.js`

- [ ] **Step 1: Write failing API tests**

```js
// packages/license-server/test/policy-sync.test.js
import { test, expect } from "bun:test";

test("POST /v1/policies/issue returns signed policy snapshot", async () => {});
test("POST /v1/policies/sync returns not_modified when policyId matches", async () => {});
test("POST /v1/meter/upload persists and returns ack range", async () => {});
test("workspace disable reflects on next sync", async () => {});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/license-server/test/policy-sync.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement server handlers**

```js
// packages/license-server/src/server.js
// POST /v1/policies/issue
// POST /v1/policies/sync
// POST /v1/meter/upload
// GET  /v1/usage/summary
```

- [ ] **Step 4: Extend storage adapters**

```js
// storage.js + storage-sqlite.js
// savePolicySnapshot(workspaceId, snapshot)
// getLatestPolicySnapshot(workspaceId)
// appendMeterEvents(workspaceId, events)
// getUsageSummary({ workspaceId, fromSec, toSec })
```

- [ ] **Step 5: Run tests to pass**

Run: `bun test packages/license-server/test/license-server.test.js packages/license-server/test/policy-sync.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/license-server/src/server.js packages/license-server/src/storage.js packages/license-server/src/storage-sqlite.js packages/license-server/test/policy-sync.test.js
git commit -m "feat(license-server): add policy issue/sync and meter upload APIs"
```

---

### Task 4: Add CLI Control Commands for Policy + Meter Loop

**Files:**
- Modify: `packages/cli/src/index.js`
- Modify: `packages/cli/test/cli.test.js`

- [ ] **Step 1: Write failing CLI tests**

```js
// packages/cli/test/cli.test.js
import { test, expect } from "bun:test";

test("cli: policy issue outputs snapshot", async () => {});
test("cli: policy sync fetches latest", async () => {});
test("cli: meter upload posts batch", async () => {});
test("cli: usage summary prints workspace/seat/tool totals", async () => {});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/cli/test/cli.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement commands**

```text
skillpack policy issue --workspace-id ... --seat-id ... --workspace-mode ... --seat-mode ... --budget-wiki-search ...
skillpack policy sync --server-url ... --workspace-id ... --policy-id ...
skillpack meter upload --server-url ... --workspace-id ... --file ~/.skillpack/bundles/<bundle>/meter.jsonl
skillpack usage summary --server-url ... --workspace-id ...
```

- [ ] **Step 4: Run tests to pass**

Run: `bun test packages/cli/test/cli.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.js packages/cli/test/cli.test.js
git commit -m "feat(cli): add policy and meter loop control commands"
```

---

### Task 5: End-to-End Value Demo Script

**Files:**
- Create: `scripts/demo-policy-loop.sh`
- Modify: `scripts/test-receiver-e2e.sh`

- [ ] **Step 1: Write failing E2E expectations in script**

```bash
# expected checkpoints:
# 1) issue lease/policy
# 2) normal calls
# 3) warning state at >=100%
# 4) deny at >120%
# 5) renew and continue
```

- [ ] **Step 2: Implement demo script**

```bash
#!/usr/bin/env bash
set -euo pipefail
# orchestrate local server + receiver runtime + meter upload + usage summary
# print concise PASS/FAIL checkpoints
```

- [ ] **Step 3: Integrate into automated suite**

Run: `bash scripts/demo-policy-loop.sh`
Expected: all checkpoints PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/demo-policy-loop.sh scripts/test-receiver-e2e.sh
git commit -m "test(e2e): add policy enforcement value-loop demo"
```

---

### Task 6: Documentation + Runbook Sync

**Files:**
- Create: `docs/runbooks/policy-loop-demo.md`
- Modify: `docs/runbooks/receiver-verify-install.md`
- Modify: `README.md`

- [ ] **Step 1: Document policy model and decision order**

```md
- workspace mode > seat mode > time state > usage state
- warning-only degraded behavior
- hard stop conditions
```

- [ ] **Step 2: Add operator commands for renew/revoke/sync**

```bash
skillpack policy issue ...
skillpack policy sync ...
skillpack usage summary ...
```

- [ ] **Step 3: Add “10-minute value demo” section in README**

```md
issue -> use -> warn -> stop -> renew -> continue
```

- [ ] **Step 4: Verify docs are consistent with CLI/runtime behavior**

Run: `rg -n "120|warning-only|workspace|seat|policy sync|usage summary" docs README.md`
Expected: no contradictory wording.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/policy-loop-demo.md docs/runbooks/receiver-verify-install.md README.md
git commit -m "docs: add policy-loop runbook and value demonstration guide"
```

---

## Final Verification Gate

- [ ] Run: `bun test`
Expected: PASS.

- [ ] Run: `bun run test:receiver-e2e`
Expected: PASS.

- [ ] Run: `bash scripts/demo-policy-loop.sh`
Expected: PASS with all value-loop checkpoints.

- [ ] Run: `git diff --stat origin/main`
Expected: only planned files changed.

---

## Spec Coverage Check

- Workspace policy mode enable/disable: covered (Tasks 1,2,3)
- Seat policy mode enable/disable: covered (Tasks 1,2,3)
- Usage tool_call warning/hard-stop: covered (Tasks 1,2,5)
- Time policy workspace-only and workspace+seat stricter-wins: covered (Tasks 1,2)
- Hybrid offline behavior: covered (Task 2)
- Platform-receiver connection (issue/sync/meter/summary): covered (Tasks 3,4,5)
- End-to-end value proof loop: covered (Task 5 + docs in Task 6)

No uncovered spec requirements.
