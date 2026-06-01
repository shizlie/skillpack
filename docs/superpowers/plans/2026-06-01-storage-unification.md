# Storage Backend Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the duplicated D1 and SQLite storage backends with a single shared `createLeaseStore` implementation behind a thin SQL-executor shim. Each backend becomes ≤ 100 lines. The SQL schema, row mappers, and contract exist in exactly one place.

**Architecture:** Introduce a 3-method executor abstraction (`first`, `all`, `run`) plus a `runInTransaction` factory. The shared `createLeaseStore({ exec, runInTransaction })` is the single home for SQL, mappers, and contract. D1 and SQLite each become ≤ 100-line adapters wrapping their native APIs.

**Tech Stack:** Bun (`bun:sqlite` for the in-memory + on-disk SQLite path) and Cloudflare D1 (`db.prepare(...).bind(...)`).

**Reference spec:** `docs/superpowers/specs/2026-06-01-structural-cleanup.md` (Subsystem 3).

---

## File Structure

- **Create:** `packages/core/src/storage-contract.js` — the shared `createLeaseStore({ exec, runInTransaction })`
- **Modify:** `packages/core/src/storage-d1.js` — shrink to the D1 executor adapter
- **Modify:** `packages/core/src/storage-sqlite.js` — shrink to the SQLite executor adapter
- **Modify:** `packages/core/src/storage.js` — re-export `createInMemoryLeaseStore` from the contract module
- **Modify:** `packages/core/src/index.js` — keep public exports stable
- **Create:** `packages/core/test/storage-contract.test.js` — runs the same suite against both backends

---

### Task 1: Define the executor abstraction interface

**Files:**
- Create: `packages/core/src/storage-contract.js`

The contract is: `exec.first(sql, ...args)`, `exec.all(sql, ...args)`, `exec.run(sql, ...args)`, plus `runInTransaction(fn)` for SQLite (no-op for D1 — D1 doesn't expose a public transaction API, so we treat the in-memory equivalent of "best-effort atomic" via sequential runs).

- [ ] **Step 1: Write the executor type comment block**

```js
// packages/core/src/storage-contract.js
//
// Public interface for SQL backends:
//
//   exec.first(sql, ...args)              -> row | null
//   exec.all(sql, ...args)                -> row[]
//   exec.run(sql, ...args)                -> { changes?: number, lastInsertRowid?: number }
//   runInTransaction?(fn)                 -> result of fn()
//
// D1 does not expose a public transaction API; the D1 adapter omits
// runInTransaction and the contract uses sequential runs.
```

- [ ] **Step 2: Move the SQL schema**

Move the D1 `D1_SCHEMA_SQL` block (from `storage-d1.js:3–118`) into `storage-contract.js` as `LEASE_STORE_SCHEMA_SQL`. Split into statements the same way (`D1_SCHEMA_STATEMENTS`).

- [ ] **Step 3: Move the row mappers**

Move `mapPricingRule`, `mapUsageEvent`, `mapInvoice`, `mapPaymentHandoff`, and `normalizeSeatId` from both backend files into `storage-contract.js`. Resolve any minor differences (SQLite stores `unit_amount_cents` as `INTEGER`; D1 also stores `INTEGER`; both return `Number` after the move).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/storage-contract.js
git commit -m "feat(core): scaffold shared storage contract module"
```

---

### Task 2: Implement `createLeaseStore({ exec, runInTransaction })`

**Files:**
- Modify: `packages/core/src/storage-contract.js`

- [ ] **Step 1: Port the contract from `storage-sqlite.js`**

Read `packages/core/src/storage-sqlite.js:474–758`. Port each method into `createLeaseStore`. Use `exec.first/all/run` for queries. Use `runInTransaction` for `appendMeterEvents`.

- [ ] **Step 2: Ensure schema is applied on first use**

Add:

```js
let schemaReady;
async function ensureReady() {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const statement of LEASE_STORE_SCHEMA_STATEMENTS) {
        await exec.run(statement);
      }
    })();
  }
  await schemaReady;
}
```

Wrap every public method body with `await ensureReady();`.

- [ ] **Step 3: Add `close()` for the SQLite path**

The SQLite backend exposes `db.close(false)`. The contract's `close()` should be a no-op unless the adapter injects a closer. Add a `close` slot:

```js
return {
  close() { /* set by adapter if applicable */ },
  // ... all the methods
};
```

- [ ] **Step 4: Write a smoke test for the contract via the in-memory store**

```js
// packages/core/test/storage-contract.test.js
import { describe, test, expect, beforeEach } from "bun:test";
import { createLeaseStore } from "../src/storage-contract.js";

function makeExec() {
  // bun:sqlite is convenient for the in-memory path; this test is the
  // "does the contract work with a real SQL engine" check.
  const { Database } = require("bun:sqlite");
  const db = new Database(":memory:");
  return {
    exec: {
      first: (sql, ...args) => db.query(sql).get(...args),
      all:   (sql, ...args) => db.query(sql).all(...args),
      run:   (sql, ...args) => db.query(sql).run(...args),
    },
    runInTransaction: (fn) => db.transaction(fn)(),
  };
}

describe("createLeaseStore (contract via bun:sqlite)", () => {
  test("saveProvider round-trips", async () => {
    const store = createLeaseStore(makeExec());
    const saved = await store.saveProvider({ providerId: "p1", name: "Acme" });
    expect(saved.providerId).toBe("p1");
    expect((await store.listProviders())[0].name).toBe("Acme");
  });

  test("appendMeterEvents is atomic", async () => {
    const store = createLeaseStore(makeExec());
    await store.appendMeterEvents([{
      eventId: "e1", providerId: "p1", customerId: "c1", workspaceId: "w1",
      seatId: "default", tool: "wiki_search", eventKind: "tool_call",
      usage: { unit: "tool_call", delta: 1 }, eventSeq: 0, eventHash: null,
      prevHash: "GENESIS", eventAtSec: 100, rawEvent: {},
    }]);
    const summary = await store.getUsageSummary({ workspaceId: "w1" });
    expect(summary[0].totalCalls).toBe(1);
  });
});
```

- [ ] **Step 5: Run the test**

Run: `bun test packages/core/test/storage-contract.test.js`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/storage-contract.js packages/core/test/storage-contract.test.js
git commit -m "feat(core): implement shared createLeaseStore contract"
```

---

### Task 3: Replace `storage-sqlite.js` with the thin adapter

**Files:**
- Modify: `packages/core/src/storage-sqlite.js`

- [ ] **Step 1: Rewrite the file**

```js
// packages/core/src/storage-sqlite.js
import { Database } from "bun:sqlite";
import { createLeaseStore } from "./storage-contract.js";

export function createSqliteLeaseStore({ dbPath = ":memory:" } = {}) {
  const db = new Database(dbPath, { create: true });
  const exec = {
    first: (sql, ...args) => db.query(sql).get(...args),
    all:   (sql, ...args) => db.query(sql).all(...args),
    run:   (sql, ...args) => db.query(sql).run(...args),
  };
  const store = createLeaseStore({ exec, runInTransaction: (fn) => db.transaction(fn)() });
  return { ...store, close() { db.close(false); } };
}
```

- [ ] **Step 2: Confirm the existing SQLite tests pass**

Run: `bun test packages/core/test/storage-sqlite.test.js` (or whatever the existing test is named)
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/storage-sqlite.js
git commit -m "refactor(core): shrink storage-sqlite.js to thin bun:sqlite adapter"
```

---

### Task 4: Replace `storage-d1.js` with the thin adapter

**Files:**
- Modify: `packages/core/src/storage-d1.js`

- [ ] **Step 1: Rewrite the file**

```js
// packages/core/src/storage-d1.js
import { createLeaseStore } from "./storage-contract.js";

export async function ensureD1Schema(db) {
  const exec = wrapD1(db).exec;
  for (const statement of LEASE_STORE_SCHEMA_STATEMENTS) {
    await exec.run(statement);
  }
}

function wrapD1(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("d1_store_missing_db");
  }
  return {
    exec: {
      first: async (sql, ...args) => db.prepare(sql).bind(...args).first(),
      all:   async (sql, ...args) => (await db.prepare(sql).bind(...args).all())?.results ?? [],
      run:   async (sql, ...args) => db.prepare(sql).bind(...args).run(),
    },
  };
}

export function createD1LeaseStore({ db }) {
  return createLeaseStore(wrapD1(db));
}
```

- [ ] **Step 2: Update callers of `ensureD1Schema`**

`apps/api/src/index.js` and any other caller that used `ensureD1Schema` directly should now rely on the lazy `ensureReady` inside `createLeaseStore`. If a caller needs eager schema setup, call `createD1LeaseStore({ db }).ensureReady?.()` — or, more cleanly, expose an `ensureSchema` function from the contract module that both backends can use.

- [ ] **Step 3: Run D1 tests**

Run: `bun test packages/core/`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/storage-d1.js
git commit -m "refactor(core): shrink storage-d1.js to thin D1 adapter"
```

---

### Task 5: Fold `storage.js` (in-memory) into the contract

**Files:**
- Modify: `packages/core/src/storage.js`

- [ ] **Step 1: Replace the in-memory implementation with a re-export**

The in-memory store is currently used by tests and as the default for `createLicenseFetchHandler`. After the contract refactor, the in-memory store is just a contract instance backed by an in-memory executor.

- [ ] **Step 2: Use `bun:sqlite` `:memory:` as the in-memory backend**

```js
// packages/core/src/storage.js
import { Database } from "bun:sqlite";
import { createLeaseStore } from "./storage-contract.js";

export function createInMemoryLeaseStore() {
  const db = new Database(":memory:");
  const exec = {
    first: (sql, ...args) => db.query(sql).get(...args),
    all:   (sql, ...args) => db.query(sql).all(...args),
    run:   (sql, ...args) => db.query(sql).run(...args),
  };
  return createLeaseStore({ exec, runInTransaction: (fn) => db.transaction(fn)() });
}
```

(If a true in-memory `Map`-backed implementation is desired, write a custom executor that maps SQL strings to `Map.get/set` — but reusing `bun:sqlite :memory:` is simpler and tests the same contract.)

- [ ] **Step 3: Run all storage tests**

Run: `bun test packages/core/`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/storage.js
git commit -m "refactor(core): in-memory store uses shared contract over bun:sqlite :memory:"
```

---

### Task 6: Parameterize the contract test against both backends

**Files:**
- Modify: `packages/core/test/storage-contract.test.js`

The contract test should run once for the in-memory (SQLite `:memory:`) backend and once for the D1 backend using a mock D1 implementation.

- [ ] **Step 1: Add a D1 mock executor**

```js
function makeD1MockExec() {
  // Use a real Cloudflare D1 binding if available; otherwise, use
  // bun:sqlite as a stand-in (the contract doesn't care about dialect).
  // For a true mock, see packages/core/test/d1-mock-exec.js.
  return makeExec();  // reuse the bun:sqlite executor
}
```

For real D1 coverage, add an integration test that hits a `wrangler dev` instance — but that belongs in the worker test suite, not here.

- [ ] **Step 2: Add a parameterized test loop**

```js
const backends = {
  sqlite: () => makeExec(),
  d1:     () => makeD1MockExec(),
};

for (const [name, makeExec] of Object.entries(backends)) {
  describe(`createLeaseStore via ${name} executor`, () => {
    test("round-trips provider", async () => {
      const store = createLeaseStore(makeExec());
      // ... same as Task 2
    });
  });
}
```

- [ ] **Step 3: Run the test**

Run: `bun test packages/core/test/storage-contract.test.js`
Expected: green for both backends.

- [ ] **Step 4: Commit**

```bash
git add packages/core/test/storage-contract.test.js
git commit -m "test(core): exercise storage contract against multiple backends"
```

---

### Task 7: Verify file-size targets

**Files:** none (verification only)

- [ ] **Step 1: Check sizes**

```bash
wc -l packages/core/src/storage-d1.js packages/core/src/storage-sqlite.js packages/core/src/storage.js packages/core/src/storage-contract.js
```

Expected: each backend adapter ≤ 100 lines; the contract module may be longer (it's the single home for SQL + mappers).

- [ ] **Step 2: Confirm no duplicated SQL or mappers**

```bash
grep -n "mapPricingRule\|mapUsageEvent\|mapInvoice\|mapPaymentHandoff\|normalizeSeatId" packages/core/src/
```

Expected: exactly one definition of each, in `storage-contract.js`.

- [ ] **Step 3: Run full test suite**

Run: `bun test packages/`
Expected: all green.

---

## Acceptance criteria

- `storage-d1.js` and `storage-sqlite.js` are each ≤ 100 lines.
- The SQL schema, row mappers, and contract implementation live in exactly one file (`storage-contract.js`).
- The contract test passes against both backends.
- All existing tests in `packages/core/` pass without modification of their assertions.

## Out of scope

- Adding new storage tables or columns.
- Switching to a different SQL engine.
- Touching the runtime or dashboard.
