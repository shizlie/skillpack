<!-- /autoplan restore point: /Users/baoharryngo/.gstack/projects/shizlie-skillpack/shizlie-dev-next-plan-autoplan-restore-20260501-095508.md -->
# TSA Outage End-to-End Workflow Implementation Plan

> **Autoplan decision:** user selected option B. Execute only Tasks 2 + 3 + 4 + 8 with premise fixes: ticket-scoped manual-attestation lookup and 4-hour default `maxManualAttestationAgeSec`. Defer Tasks 1, 5, 6, and 7 (incident timeline storage/export/end-to-end timeline tests) until a design partner specifies the audit format.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining critical gap from CLAUDE.md: complete the TSA outage incident workflow so an air-gapped customer with no sneakernet operator can keep running under manual time attestation, with attestations flowing automatically from the license server through the lease into the runtime, plus an audit trail and end-to-end test coverage.

**Architecture:** Foundations exist (TSA monitor warnings on `/v1/leases/issue`, `skillpack tsa manual-attest` CLI command, `manual_attestations` storage in SQLite + D1, runtime `verifyLeaseForRuntime` enforcement of `tsaPolicy.manualAttestation`). The gap is wiring: the lease-issue response only returns `tsaState` (status + windows) — it does not embed the latest manual attestation, so the runbook tells operators to manually inject the record into runtime config. We will (a) auto-embed the latest manual attestation into the lease-issue response when TSA freshness is `warning` or `expired`, (b) add a runtime helper that consumes that response to build `tsaPolicy` directly, (c) make the CLI surface incident hints, (d) record an append-only TSA incident timeline (warnings emitted, attestations recorded/used/expired) for audit, (e) add end-to-end test, (f) update runbook + docs.

**Tech Stack:** Bun + TypeScript/JS, `@skillpack/protocol` (Zod schemas + `evaluateTsaTokenFreshness`, `validateManualTimeAttestation`), `@skillpack/tsa` (`createTsaMonitor`, `createManualTimeAttestationContract`), `@skillpack/core` (license server, storage SQLite + D1), `@skillpack/runtime` (lease verification + manual attestation enforcement), `@skillpack/cli` (operator CLI). Tests run with `bun test`.

---

## File Structure

Files this plan touches (full path, single responsibility):

- `packages/core/src/server.js` — embed `latestManualAttestation` into `/v1/leases/issue` response when `tsaState.status` is `warning` or `expired`; emit TSA incident timeline events.
- `packages/core/src/storage.js`, `packages/core/src/storage-sqlite.js`, `packages/core/src/storage-d1.js` — add `appendTsaIncidentEvent` + `listTsaIncidentEvents` methods (parity across the 3 stores).
- `apps/api/migrations/0003_tsa_incidents.sql` — D1 / SQLite migration for `tsa_incident_events` table.
- `packages/runtime/src/index.js` — add `buildTsaPolicyFromLeaseResponse` helper that turns a server lease-issue response into a runtime `tsaPolicy`.
- `apps/cli/src/index.js` — `license issue` surfaces TSA `warning` / `expired` state with actionable runbook hint; wire `latestManualAttestation` through to its output for downstream runtime callers.
- `apps/cli/test/cli.test.js` — coverage for the CLI surface.
- `packages/core/test/license-server.test.js` — coverage for embedding behavior + incident events.
- `packages/runtime/test/runtime.test.js` — coverage for `buildTsaPolicyFromLeaseResponse`.
- `packages/core/test/storage-sqlite.test.js`, `packages/core/test/storage-d1.test.js` — incident event store parity tests.
- `e2e/tsa-outage.test.js` (new) — full happy-path + expiry-path integration test.
- `docs/runbooks/tsa-outage.md` — collapse manual injection step; document automatic embedding.
- `README.md` and `CLAUDE.md` — update "critical gap" status to "shipped".

---

## Task Breakdown

### Task 1: Storage parity — TSA incident event log (memory + SQLite + D1)

**Files:**
- Modify: `packages/core/src/storage.js` — in-memory store
- Modify: `packages/core/src/storage-sqlite.js`
- Modify: `packages/core/src/storage-d1.js`
- Create: `apps/api/migrations/0003_tsa_incidents.sql`
- Modify: `packages/core/test/storage-sqlite.test.js`
- Modify: `packages/core/test/storage-d1.test.js`

The TSA incident log records four event kinds: `tsa_warning_emitted`, `manual_attestation_recorded`, `manual_attestation_used`, `manual_attestation_expired`. Operator + runtime emit; we just persist + list. Schema columns: `event_id` (PRIMARY KEY, ULID-ish caller-supplied string), `kind` (TEXT NOT NULL), `customer_id` (TEXT NOT NULL), `seat_id` (TEXT NOT NULL), `ticket_id` (TEXT NULL), `operator_id` (TEXT NULL), `details_json` (TEXT NULL), `recorded_at_sec` (INTEGER NOT NULL).

- [ ] **Step 1: Write failing migration test for SQLite store**

In `packages/core/test/storage-sqlite.test.js`:

```javascript
test("sqlite tsaIncidentEvents: append + list filtered by customerId/seatId", () => {
  const store = makeStore();
  store.appendTsaIncidentEvent({
    eventId: "evt-1",
    kind: "tsa_warning_emitted",
    customerId: "cust-a",
    seatId: "seat-1",
    ticketId: null,
    operatorId: null,
    details: { secondsRemaining: 120 },
    recordedAtSec: 1_000,
  });
  store.appendTsaIncidentEvent({
    eventId: "evt-2",
    kind: "manual_attestation_recorded",
    customerId: "cust-a",
    seatId: "seat-1",
    ticketId: "INC-1",
    operatorId: "op-1",
    details: { attestedAtSec: 990 },
    recordedAtSec: 1_001,
  });
  store.appendTsaIncidentEvent({
    eventId: "evt-3",
    kind: "tsa_warning_emitted",
    customerId: "cust-b",
    seatId: "seat-1",
    ticketId: null,
    operatorId: null,
    details: null,
    recordedAtSec: 1_002,
  });

  const all = store.listTsaIncidentEvents();
  expect(all.length).toBe(3);

  const onlyA = store.listTsaIncidentEvents({ customerId: "cust-a" });
  expect(onlyA.length).toBe(2);
  expect(onlyA.every((e) => e.customerId === "cust-a")).toBe(true);

  const onlySeat = store.listTsaIncidentEvents({
    customerId: "cust-a",
    seatId: "seat-1",
  });
  expect(onlySeat.length).toBe(2);

  const detailRow = onlyA.find((e) => e.kind === "manual_attestation_recorded");
  expect(detailRow.details).toEqual({ attestedAtSec: 990 });
});
```

- [ ] **Step 2: Run failing test**

Run: `bun test packages/core/test/storage-sqlite.test.js`
Expected: FAIL with `store.appendTsaIncidentEvent is not a function`.

- [ ] **Step 3: Implement TSA incident table + methods in SQLite store**

In `packages/core/src/storage-sqlite.js`, add table to the schema bootstrap section near the other `CREATE TABLE IF NOT EXISTS` blocks:

```javascript
db.exec(`
  CREATE TABLE IF NOT EXISTS tsa_incident_events (
    event_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    seat_id TEXT NOT NULL,
    ticket_id TEXT,
    operator_id TEXT,
    details_json TEXT,
    recorded_at_sec INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tsa_incident_events_customer_seat
    ON tsa_incident_events(customer_id, seat_id, recorded_at_sec);
`);
```

Add prepared statements (place beside other prepared statements):

```javascript
const insertTsaIncidentEvent = db.query(`
  INSERT INTO tsa_incident_events (
    event_id, kind, customer_id, seat_id, ticket_id, operator_id, details_json, recorded_at_sec
  ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
`);
const selectTsaIncidentEvents = db.query(`
  SELECT event_id, kind, customer_id, seat_id, ticket_id, operator_id, details_json, recorded_at_sec
  FROM tsa_incident_events
  WHERE (?1 IS NULL OR customer_id = ?1)
    AND (?2 IS NULL OR seat_id = ?2)
  ORDER BY recorded_at_sec, event_id
`);
```

Expose in returned store object:

```javascript
appendTsaIncidentEvent(event) {
  insertTsaIncidentEvent.run(
    event.eventId,
    event.kind,
    event.customerId,
    event.seatId,
    event.ticketId ?? null,
    event.operatorId ?? null,
    event.details == null ? null : JSON.stringify(event.details),
    event.recordedAtSec
  );
},
listTsaIncidentEvents({ customerId, seatId } = {}) {
  return selectTsaIncidentEvents
    .all(customerId ?? null, seatId ?? null)
    .map((row) => ({
      eventId: row.event_id,
      kind: row.kind,
      customerId: row.customer_id,
      seatId: row.seat_id,
      ticketId: row.ticket_id ?? null,
      operatorId: row.operator_id ?? null,
      details: row.details_json == null ? null : JSON.parse(row.details_json),
      recordedAtSec: row.recorded_at_sec,
    }));
},
```

- [ ] **Step 4: Run SQLite test to verify pass**

Run: `bun test packages/core/test/storage-sqlite.test.js`
Expected: PASS (existing 23 tests + the new one).

- [ ] **Step 5: Repeat parity tests for D1 store**

In `packages/core/test/storage-d1.test.js`, add a structurally identical test (`async`, with `createTestD1Database`).

- [ ] **Step 6: Run failing D1 test**

Run: `bun test packages/core/test/storage-d1.test.js`
Expected: FAIL.

- [ ] **Step 7: Add migration file `apps/api/migrations/0003_tsa_incidents.sql`**

```sql
CREATE TABLE IF NOT EXISTS tsa_incident_events (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  ticket_id TEXT,
  operator_id TEXT,
  details_json TEXT,
  recorded_at_sec INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tsa_incident_events_customer_seat
  ON tsa_incident_events(customer_id, seat_id, recorded_at_sec);
```

- [ ] **Step 8: Implement D1 store methods**

In `packages/core/src/storage-d1.js`, add the table to the `BOOTSTRAP_SQL` constant (or wherever D1 schema bootstrap lives — match existing tables' style). Then implement `appendTsaIncidentEvent` and `listTsaIncidentEvents` using the existing `runStmt` / `allRows` helpers and the same column shape.

- [ ] **Step 9: Run D1 test to verify pass**

Run: `bun test packages/core/test/storage-d1.test.js`
Expected: PASS.

- [ ] **Step 10: Add the same methods to the in-memory store**

In `packages/core/src/storage.js`, add an internal array `tsaIncidentEvents = []` and the two methods, mirroring the same shape returned by SQLite (deep clone `details` to avoid aliasing).

- [ ] **Step 11: Run full core suite**

Run: `bun test packages/core/test`
Expected: all tests pass (existing 47 + the 2 new ones).

- [ ] **Step 12: Commit**

```bash
git add apps/api/migrations/0003_tsa_incidents.sql \
        packages/core/src/storage.js \
        packages/core/src/storage-sqlite.js \
        packages/core/src/storage-d1.js \
        packages/core/test/storage-sqlite.test.js \
        packages/core/test/storage-d1.test.js
git commit -m "feat(core): add tsa_incident_events store (memory + SQLite + D1)"
```

---

### Task 2: Embed `latestManualAttestation` in lease-issue response

**Files:**
- Modify: `packages/core/src/server.js:280-305`
- Modify: `packages/core/test/license-server.test.js`

When `tsaState.status` is `warning` or `expired`, the server should attach the latest matching manual attestation (or `null` if none exists) plus the configured `maxManualAttestationAgeSec`, so the runtime can build `tsaPolicy` without a separate fetch. Look up via `leaseStore.getLatestManualAttestation(customerId, seatId)`. Also append a `tsa_warning_emitted` incident event to the new event log when status transitions to warning/expired.

- [ ] **Step 1: Write failing license-server test for embedded attestation**

In `packages/core/test/license-server.test.js`, add:

```javascript
test("license-server: lease issue embeds latestManualAttestation when tsaState=expired", async () => {
  const { app, store } = createTestLicenseServer();

  // seed manual attestation
  await store.addManualAttestation({
    customerId: "cust-a",
    seatId: "seat-1",
    operatorId: "op-1",
    ticketId: "INC-1",
    reason: "tsa link down",
    attestedAtSec: 5_000,
    recordedAtSec: 5_001,
    source: "manual-time-attestation",
  });

  const res = await app.fetch(
    new Request("http://t/v1/leases/issue", {
      method: "POST",
      body: JSON.stringify({
        customerId: "cust-a",
        seatId: "seat-1",
        // ... existing required body fields ...
        lastTsaTokenAtSec: 1_000, // very old → expired
      }),
    })
  );
  const body = await res.json();
  expect(body.tsaState.status).toBe("expired");
  expect(body.tsaState.latestManualAttestation).toBeTruthy();
  expect(body.tsaState.latestManualAttestation.ticketId).toBe("INC-1");
  expect(body.tsaState.maxManualAttestationAgeSec).toBeGreaterThan(0);

  const events = store.listTsaIncidentEvents({ customerId: "cust-a" });
  expect(events.find((e) => e.kind === "tsa_warning_emitted")).toBeTruthy();
});
```

(Use the existing helper that builds a license-server test fixture with seeded provider/customer/seat/policy. If no helper exists, follow the pattern of the existing `license-server.test.js` `lease issue` cases.)

- [ ] **Step 2: Run failing test**

Run: `bun test packages/core/test/license-server.test.js`
Expected: FAIL — `latestManualAttestation` is `undefined`.

- [ ] **Step 3: Update server.js to embed attestation + emit incident event**

In `packages/core/src/server.js`, replace the `tsaState` block at lines 294-302 with:

```javascript
let tsaState = null;
if (Number.isInteger(body.lastTsaTokenAtSec)) {
  const evaluated = tsaMonitor.evaluate({
    lastTsaTokenAtSec: body.lastTsaTokenAtSec,
    nowSec: iat,
  });
  tsaState = { ...evaluated };
  if (evaluated.status === "warning" || evaluated.status === "expired") {
    const latest =
      typeof leaseStore.getLatestManualAttestation === "function"
        ? await leaseStore.getLatestManualAttestation(customerId, seatId)
        : null;
    tsaState.latestManualAttestation = latest ?? null;
    tsaState.maxManualAttestationAgeSec =
      DEFAULT_MANUAL_ATTESTATION_MAX_AGE_SEC; // imported from runtime constants
    if (typeof leaseStore.appendTsaIncidentEvent === "function") {
      await leaseStore.appendTsaIncidentEvent({
        eventId: `tsa-warn-${customerId}-${seatId}-${iat}`,
        kind: "tsa_warning_emitted",
        customerId,
        seatId,
        ticketId: null,
        operatorId: null,
        details: { tsaStatus: evaluated.status, lastTsaTokenAtSec: body.lastTsaTokenAtSec },
        recordedAtSec: iat,
      });
    }
  }
}

return json({ leaseToken, payload, tsaState });
```

Add at the top of `server.js`:

```javascript
import { DEFAULT_MANUAL_ATTESTATION_MAX_AGE_SEC } from "@skillpack/runtime";
```

(If `@skillpack/runtime` isn't already an importable peer for `@skillpack/core` in `packages/core/package.json`, instead define `DEFAULT_MANUAL_ATTESTATION_MAX_AGE_SEC = 24 * 60 * 60` locally in `server.js` to avoid a new dependency edge — pick whichever keeps the dep graph clean. The runtime constant should remain the source of truth; the server only mirrors it.)

- [ ] **Step 4: Run server test to verify pass**

Run: `bun test packages/core/test/license-server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/server.js packages/core/test/license-server.test.js
git commit -m "feat(core): embed latest manual attestation in lease-issue response"
```

---

### Task 3: Runtime helper `buildTsaPolicyFromLeaseResponse`

**Files:**
- Modify: `packages/runtime/src/index.js`
- Modify: `packages/runtime/test/runtime.test.js`

Add a single small function that takes the server's lease-issue response shape (`{ tsaState }`) and builds a `tsaPolicy` ready for `verifyLeaseForRuntime`. Returns `null` if `tsaState` is `null` (no TSA enforcement requested). This closes the manual-injection gap from the runbook.

- [ ] **Step 1: Write failing test**

In `packages/runtime/test/runtime.test.js`:

```javascript
test("buildTsaPolicyFromLeaseResponse: passes through fresh state with no attestation", () => {
  const policy = buildTsaPolicyFromLeaseResponse({
    tsaState: { status: "fresh", lastTsaTokenAtSec: 1_000 },
  });
  expect(policy).toEqual({
    lastTsaTokenAtSec: 1_000,
    manualAttestation: null,
    maxManualAttestationAgeSec: DEFAULT_MANUAL_ATTESTATION_MAX_AGE_SEC,
  });
});

test("buildTsaPolicyFromLeaseResponse: hydrates manualAttestation when expired", () => {
  const att = {
    customerId: "cust-a",
    seatId: "seat-1",
    operatorId: "op-1",
    ticketId: "INC-1",
    reason: "tsa link down",
    attestedAtSec: 5_000,
    recordedAtSec: 5_001,
    source: "manual-time-attestation",
  };
  const policy = buildTsaPolicyFromLeaseResponse({
    tsaState: {
      status: "expired",
      lastTsaTokenAtSec: 1_000,
      latestManualAttestation: att,
      maxManualAttestationAgeSec: 12 * 3600,
    },
  });
  expect(policy.manualAttestation).toEqual(att);
  expect(policy.maxManualAttestationAgeSec).toBe(12 * 3600);
});

test("buildTsaPolicyFromLeaseResponse: returns null when no tsaState", () => {
  expect(buildTsaPolicyFromLeaseResponse({})).toBeNull();
  expect(buildTsaPolicyFromLeaseResponse({ tsaState: null })).toBeNull();
});
```

Update the test file's import line to include the new symbol.

- [ ] **Step 2: Run failing test**

Run: `bun test packages/runtime/test/runtime.test.js`
Expected: FAIL — symbol not exported.

- [ ] **Step 3: Implement helper**

In `packages/runtime/src/index.js`, append:

```javascript
export function buildTsaPolicyFromLeaseResponse(response) {
  const tsaState = response?.tsaState;
  if (!tsaState) return null;
  return {
    lastTsaTokenAtSec: tsaState.lastTsaTokenAtSec,
    manualAttestation: tsaState.latestManualAttestation ?? null,
    maxManualAttestationAgeSec:
      tsaState.maxManualAttestationAgeSec ??
      DEFAULT_MANUAL_ATTESTATION_MAX_AGE_SEC,
  };
}
```

Make sure `DEFAULT_MANUAL_ATTESTATION_MAX_AGE_SEC` is included in the existing `export {` list at the bottom of the file (it already is — line 140 of current source).

- [ ] **Step 4: Run runtime tests**

Run: `bun test packages/runtime/test/runtime.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/index.js packages/runtime/test/runtime.test.js
git commit -m "feat(runtime): buildTsaPolicyFromLeaseResponse helper"
```

---

### Task 4: CLI surfaces TSA warning/expired with runbook hint

**Files:**
- Modify: `apps/cli/src/index.js`
- Modify: `apps/cli/test/cli.test.js`

When the operator runs `skillpack license issue` and the server returns `tsaState.status` of `warning` or `expired`, print a clearly-formatted message pointing at `docs/runbooks/tsa-outage.md` and the `skillpack tsa manual-attest` command, including ticket-ID + reason placeholders. Output should appear on stderr (so the leaseToken on stdout stays pipeline-friendly).

- [ ] **Step 1: Write failing CLI test**

In `apps/cli/test/cli.test.js`, add:

```javascript
test("cli license issue: prints TSA warning hint to stderr when tsaState=expired", async () => {
  const fetchImpl = stubFetch({
    "POST /v1/leases/issue": () =>
      okJson({
        leaseToken: "stub.lease.token",
        payload: { sub: "cust-a", exp: 9_999_999 },
        tsaState: {
          status: "expired",
          lastTsaTokenAtSec: 100,
          latestManualAttestation: null,
          maxManualAttestationAgeSec: 86400,
        },
      }),
  });
  const stderr = captureStderr();
  await runCli(
    [
      "license", "issue",
      "--server-url", "http://t",
      "--customer-id", "cust-a",
      "--seat-id", "seat-1",
      "--last-tsa-token-at-sec", "100",
    ],
    fetchImpl
  );
  const text = stderr.read();
  expect(text).toMatch(/TSA token (expired|warning)/i);
  expect(text).toMatch(/docs\/runbooks\/tsa-outage\.md/);
  expect(text).toMatch(/skillpack tsa manual-attest/);
});
```

(Use whatever fixture/helper style `cli.test.js` already uses for stubbing fetch + capturing stderr. If none exist, write minimal helpers inside the test file.)

- [ ] **Step 2: Run failing test**

Run: `bun test apps/cli/test/cli.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement CLI hint**

In `apps/cli/src/index.js`, locate the `license issue` handler around line 167 (where `lastTsaTokenAtSec` is parsed) and the response handler after the fetch. After parsing the response body, add:

```javascript
if (response.tsaState && (response.tsaState.status === "warning" || response.tsaState.status === "expired")) {
  process.stderr.write(
    [
      `[skillpack] WARNING: TSA token ${response.tsaState.status}.`,
      `  Run incident workflow: docs/runbooks/tsa-outage.md`,
      `  Manual attest:`,
      `    skillpack tsa manual-attest \\`,
      `      --server-url <url> --customer-id <customerId> --seat-id <seatId> \\`,
      `      --operator-id <operatorId> --ticket-id <ticketId> \\`,
      `      --reason "<incident reason>" --attested-at-sec $(date +%s)`,
      "",
    ].join("\n")
  );
}
```

Keep stdout = the JSON the operator was already getting — do not change stdout shape.

- [ ] **Step 4: Run CLI tests**

Run: `bun test apps/cli/test/cli.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/index.js apps/cli/test/cli.test.js
git commit -m "feat(cli): surface TSA outage hint with runbook + manual-attest command"
```

---

### Task 5: Server emits `manual_attestation_recorded` incident event

**Files:**
- Modify: `packages/core/src/server.js` (POST `/v1/tsa/manual-attest` handler near line 536)
- Modify: `packages/core/test/license-server.test.js`

The manual-attest endpoint already persists the attestation. Append a `manual_attestation_recorded` event to the new TSA incident log so audit can reconstruct the incident timeline.

- [ ] **Step 1: Write failing test**

In `packages/core/test/license-server.test.js`:

```javascript
test("license-server: POST /v1/tsa/manual-attest appends incident event", async () => {
  const { app, store } = createTestLicenseServer();
  await app.fetch(
    new Request("http://t/v1/tsa/manual-attest", {
      method: "POST",
      body: JSON.stringify({
        customerId: "cust-a",
        seatId: "seat-1",
        operatorId: "op-1",
        ticketId: "INC-1",
        reason: "tsa link down",
        attestedAtSec: 5_000,
      }),
    })
  );
  const events = store.listTsaIncidentEvents({ customerId: "cust-a" });
  const recorded = events.find((e) => e.kind === "manual_attestation_recorded");
  expect(recorded).toBeTruthy();
  expect(recorded.ticketId).toBe("INC-1");
  expect(recorded.operatorId).toBe("op-1");
});
```

- [ ] **Step 2: Run failing test**

Run: `bun test packages/core/test/license-server.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement event emit in `/v1/tsa/manual-attest` handler**

In `packages/core/src/server.js`, after the line `await leaseStore.addManualAttestation(storedRecord);` (~line 547), add:

```javascript
if (typeof leaseStore.appendTsaIncidentEvent === "function") {
  await leaseStore.appendTsaIncidentEvent({
    eventId: `manual-attest-${storedRecord.customerId}-${storedRecord.seatId}-${storedRecord.recordedAtSec}`,
    kind: "manual_attestation_recorded",
    customerId: storedRecord.customerId,
    seatId: storedRecord.seatId,
    ticketId: storedRecord.ticketId,
    operatorId: storedRecord.operatorId,
    details: { attestedAtSec: storedRecord.attestedAtSec, reason: storedRecord.reason },
    recordedAtSec: storedRecord.recordedAtSec,
  });
}
```

- [ ] **Step 4: Run server tests**

Run: `bun test packages/core/test/license-server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/server.js packages/core/test/license-server.test.js
git commit -m "feat(core): emit manual_attestation_recorded incident event"
```

---

### Task 6: GET endpoint to read TSA incident timeline

**Files:**
- Modify: `packages/core/src/server.js` (add `GET /v1/tsa/incident-events`)
- Modify: `packages/core/test/license-server.test.js`

Operators / dashboard need read access to the timeline. Add a small GET endpoint mirroring the shape of `GET /v1/tsa/manual-attestations`. Auth: same management-key gate the other ops endpoints use (see how `manual-attestations` is gated in `server.js` lines 134-136 — preserve that pattern; do not add a new auth boundary).

- [ ] **Step 1: Write failing test**

```javascript
test("license-server: GET /v1/tsa/incident-events returns events filtered by customer", async () => {
  const { app, store } = createTestLicenseServer();
  store.appendTsaIncidentEvent({
    eventId: "evt-1",
    kind: "tsa_warning_emitted",
    customerId: "cust-a",
    seatId: "seat-1",
    ticketId: null,
    operatorId: null,
    details: null,
    recordedAtSec: 1_000,
  });
  const res = await app.fetch(
    new Request("http://t/v1/tsa/incident-events?customerId=cust-a", { method: "GET" })
  );
  const body = await res.json();
  expect(body.events.length).toBe(1);
  expect(body.events[0].kind).toBe("tsa_warning_emitted");
});
```

- [ ] **Step 2: Run failing test**

Run: `bun test packages/core/test/license-server.test.js`
Expected: FAIL — 404 / route not found.

- [ ] **Step 3: Implement GET endpoint**

In `packages/core/src/server.js`, near the existing `manual-attestations` GET handlers (~line 554), add the route. Match the existing list endpoint style (use `getStoreMethod`, parse `customerId` + `seatId` from query string, return `{ events }`). Add the route to the management-key gate guard near line 134:

```javascript
if (request.method === "GET" && pathname === "/v1/tsa/incident-events") return true;
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/test/license-server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/server.js packages/core/test/license-server.test.js
git commit -m "feat(core): GET /v1/tsa/incident-events for incident timeline"
```

---

### Task 7: End-to-end TSA outage integration test

**Files:**
- Create: `e2e/tsa-outage.test.js`

Drive the full path with bun test: spin up the in-process license server (in-memory store), issue a lease with `lastTsaTokenAtSec` very old → assert tsaState=expired with `latestManualAttestation: null` → record a manual attest via the CLI helper or direct fetch → re-issue lease → assert `latestManualAttestation` is now embedded → call `buildTsaPolicyFromLeaseResponse` → call `verifyLeaseForRuntime` and assert it returns `mode=active` and `tsa.manualAttestationUsed=true` → fetch `/v1/tsa/incident-events` and assert at least one `tsa_warning_emitted` and one `manual_attestation_recorded` event.

- [ ] **Step 1: Write the e2e test**

```javascript
import { expect, test } from "bun:test";
import { createLicenseServer } from "@skillpack/core";
import { createMemoryLeaseStore } from "@skillpack/core/storage";
import {
  buildTsaPolicyFromLeaseResponse,
  verifyLeaseForRuntime,
} from "@skillpack/runtime";

test("e2e: TSA outage workflow — warning, manual attest, runtime accepts", async () => {
  // 1. boot in-process server
  const store = createMemoryLeaseStore();
  // ... seed provider/customer/seat/policy/keys exactly as other e2e tests do

  const app = createLicenseServer({
    leaseStore: store,
    signingPrivateKeyPem: TEST_PRIVATE_KEY,
    signingPublicKeyPem: TEST_PUBLIC_KEY,
    // ...
  });

  // 2. issue lease with stale TSA → expect expired + null attestation
  const issue1 = await app.fetch(
    new Request("http://t/v1/leases/issue", {
      method: "POST",
      body: JSON.stringify({
        customerId: "cust-a",
        seatId: "seat-1",
        // ...other required fields...
        lastTsaTokenAtSec: 100,
      }),
    })
  );
  const body1 = await issue1.json();
  expect(body1.tsaState.status).toBe("expired");
  expect(body1.tsaState.latestManualAttestation).toBeNull();

  // 3. record manual attestation
  const now = Math.floor(Date.now() / 1000);
  await app.fetch(
    new Request("http://t/v1/tsa/manual-attest", {
      method: "POST",
      body: JSON.stringify({
        customerId: "cust-a",
        seatId: "seat-1",
        operatorId: "op-1",
        ticketId: "INC-1",
        reason: "tsa link down",
        attestedAtSec: now,
      }),
    })
  );

  // 4. re-issue lease, attestation now embedded
  const issue2 = await app.fetch(
    new Request("http://t/v1/leases/issue", {
      method: "POST",
      body: JSON.stringify({
        customerId: "cust-a",
        seatId: "seat-1",
        lastTsaTokenAtSec: 100,
        // ...
      }),
    })
  );
  const body2 = await issue2.json();
  expect(body2.tsaState.latestManualAttestation).toBeTruthy();
  expect(body2.tsaState.latestManualAttestation.ticketId).toBe("INC-1");

  // 5. runtime accepts
  const tsaPolicy = buildTsaPolicyFromLeaseResponse(body2);
  const verified = verifyLeaseForRuntime({
    leaseToken: body2.leaseToken,
    publicKeyPem: TEST_PUBLIC_KEY,
    nowSec: now,
    tsaPolicy,
  });
  expect(verified.tsa.manualAttestationUsed).toBe(true);
  expect(verified.mode).toBe("active");

  // 6. timeline contains both events
  const tl = await app.fetch(
    new Request("http://t/v1/tsa/incident-events?customerId=cust-a", { method: "GET" })
  );
  const tlBody = await tl.json();
  const kinds = tlBody.events.map((e) => e.kind);
  expect(kinds).toContain("tsa_warning_emitted");
  expect(kinds).toContain("manual_attestation_recorded");
});
```

(If the existing `e2e/` directory uses different bootstrap helpers, follow them — do not invent a new fixture style. This test should be the most realistic representation of the operator workflow.)

- [ ] **Step 2: Run**

Run: `bun test e2e/tsa-outage.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/tsa-outage.test.js
git commit -m "test(e2e): TSA outage workflow happy path"
```

---

### Task 8: Sync runbook + docs

**Files:**
- Modify: `docs/runbooks/tsa-outage.md`
- Modify: `README.md` (relevant TSA / threat-model section)
- Modify: `CLAUDE.md` (the "Critical gap to implement" section)

The manual-injection step in the runbook (current step 4) is no longer required — the lease-issue response embeds `latestManualAttestation`. Update step 4 to reflect that the runtime calls `buildTsaPolicyFromLeaseResponse` automatically; operator-side action is just the manual-attest CLI command.

- [ ] **Step 1: Edit runbook**

Replace step 4 in `docs/runbooks/tsa-outage.md` with:

```markdown
4. The next lease-issue response automatically embeds `tsaState.latestManualAttestation`. Runtime calls `buildTsaPolicyFromLeaseResponse(response)` from `@skillpack/runtime` and resumes. No manual injection of attestation records is required.
```

Add a new section at the end:

```markdown
## Audit timeline

Operator can read the incident timeline via:

`GET /v1/tsa/incident-events?customerId=<customerId>&seatId=<seatId>`

Events emitted: `tsa_warning_emitted`, `manual_attestation_recorded`. Use this to attach a complete timeline to the incident ticket.
```

- [ ] **Step 2: Update CLAUDE.md "Critical gap"**

Replace the "Critical gap to implement" block (the bullet list of TSA mitigations) with:

```markdown
## Closed gaps (formerly critical)

TSA outage workflow for air-gapped customers with no sneakernet operator: shipped end-to-end. Server `/v1/leases/issue` emits warnings and embeds latest manual attestation; runtime helper `buildTsaPolicyFromLeaseResponse` resumes execution; CLI surfaces the runbook hint; an append-only TSA incident timeline is queryable via `/v1/tsa/incident-events`. See `docs/runbooks/tsa-outage.md`.
```

- [ ] **Step 3: Update README.md**

In whichever README section discusses TSA / threat model / air-gap support, add a one-line update noting the workflow is shipped + link to the runbook. Do not duplicate the runbook content.

- [ ] **Step 4: Mark TODOS.md item complete**

The TSA workflow item is implicit in the "Critical gap" tracker, but if there is a TODOS.md entry for it, mark `[x]`.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/tsa-outage.md CLAUDE.md README.md TODOS.md
git commit -m "docs: TSA outage workflow shipped — sync runbook, README, CLAUDE"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 2: Manual smoke (optional but recommended)**

If a hosted dev server is reachable:
```bash
SKILLPACK_API=http://localhost:8787 bun apps/cli/src/index.js license issue \
  --server-url $SKILLPACK_API \
  --customer-id cust-smoke --seat-id seat-1 \
  --last-tsa-token-at-sec 100
# Expect TSA warning hint on stderr + valid leaseToken on stdout.
```

- [ ] **Step 3: Final commit (if anything was tweaked)**

```bash
git add -p
git commit -m "chore: TSA outage workflow polish"
```

---

## NOT in scope

- Recovery path that auto-clears manual attestations once a fresh TSA token arrives. The current 24h `maxManualAttestationAgeSec` already drops stale attestations naturally; explicit auto-clear can ship later if operators ask for it.
- Dashboard UI for the incident timeline (the `/v1/tsa/incident-events` endpoint is read-ready; a dashboard pane is a follow-up task — file under `Dashboard API hardening` in TODOS.md).
- TSA token re-fetch / sneakernet automation. Out of scope per design doc.
- LLM eval gate on the runbook prose. v1.

---

## /autoplan — Phase 1: CEO Review

### Step 0A: Premise challenge

Premises this plan embeds:
- **P-A:** Air-gapped customer + no sneakernet operator is a real customer scenario worth solving pre-LOI.
- **P-B:** Operators want automatic attestation embedding rather than explicit per-incident injection.
- **P-C:** Audit timeline belongs in the license server (vs in the runtime's HMAC-chained meter log, where the customer's compliance officer actually reads).
- **P-D:** `maxManualAttestationAgeSec=24h` is the right default window.
- **P-E:** Read-access to incident timeline only needs management-key gating (no per-customer auth boundary).
- **P-F:** "Closing the critical gap" called out in CLAUDE.md is high-leverage work right now (vs. distribution, first LOI, security trust docs).

### Step 0B: Existing code leverage map

Already shipped: `evaluateTsaTokenFreshness`, `validateManualTimeAttestation`, `createTsaMonitor`, `createManualTimeAttestationContract`, `POST /v1/leases/issue` returning `tsaState`, `POST /v1/tsa/manual-attest`, manual-attestation storage parity (memory + SQLite + D1), `verifyLeaseForRuntime` enforcing TSA expiry + manual-attestation freshness with `tsa.manualAttestationUsed`, CLI `skillpack tsa manual-attest` + `skillpack tsa latest-attestation`, draft runbook.

Sub-problem → existing code:
- "Surface TSA expiry to operator" → `tsaMonitor.evaluate` already emits `tsa_token_expiring_soon` / `tsa_token_expired` codes.
- "Persist manual attestation" → `addManualAttestation` + `getLatestManualAttestation` exist in all 3 stores.
- "Runtime enforces attestation" → `verifyLeaseForRuntime` already does this; only missing piece is the wiring to populate `tsaPolicy.manualAttestation` from server response.
- "Operator runbook" → `docs/runbooks/tsa-outage.md` exists.

### Step 0C: Dream state

CURRENT: foundations exist; runbook tells operator to "manually inject attestation into runtime config" — undefined how.
THIS PLAN (full 9 tasks): server auto-embeds latest attestation, runtime helper consumes it, CLI hints operator, append-only TSA incident timeline + GET endpoint + e2e test + docs sync.
12-MONTH IDEAL: customer-policy-driven attestation windows, ticket-scoped attestations (no carry-forward), per-customer fail-open vs fail-closed mode, audit emitted in customer's preferred format (SIEM-pushed CEF/syslog or hosted JSON), runtime-side audit chain as source of truth, dashboard pane for operators.

Delta from "this plan" → 12-month ideal: the plan's incident timeline as a server-side JSON-pulled-via-HTTP audit may not match the format any future regulated buyer asks for; risk of rewrite.

### Step 0C-bis: Implementation alternatives

| Approach | Effort | Risk | Pros | Cons |
|---|---|---|---|---|
| **A. Full 9 tasks (current plan)** | ~5 days CC | Medium | Complete workflow, audit trail, e2e coverage | Ships audit subsystem in 3 stores + endpoint + migration before any buyer specifies the format; couples cross-package surface to a corner case; 24h constant arbitrary |
| **B. Minimal cut: Tasks 2+3+4+8** | ~2 days CC | Low | Closes the actual operator UX gap (auto-embed + runtime helper + CLI hint + runbook polish); zero new endpoints; zero new migrations | No structured audit trail; operators rely on existing meter log + manual-attestation list endpoint |
| **C. Stop entirely** | 0 | Low | Foundations are sufficient; mark `/v1/tsa/manual-attest` + `latest-attestation` + runbook step 4 as "manual injection by ops" and ship as-is to first design partner | "Critical gap" stays open in CLAUDE.md; operator runbook remains under-specified |

### Step 0D: Mode = SELECTIVE EXPANSION

Auto-decisions on scope adjustments:
- Eventid collision risk in `tsa-warn-${customerId}-${seatId}-${iat}`: **MECHANICAL** auto-fix — append a random suffix or use ULID. Principle: P5 explicit. Logged below.
- 24h hardcoded `maxManualAttestationAgeSec`: **MECHANICAL** auto-fix — accept policy-driven override; default 4h instead of 24h. Principle: P5 + P1 (security stake). Logged.
- Read-auth scoping (`/v1/tsa/incident-events` per-customer rather than just management-key): **MECHANICAL** auto-fix if Task 6 ships — multi-tenant data leak risk is not taste. Logged.
- Audit lives in server vs runtime: **TASTE DECISION** — split-the-difference (write to both server-side log and runtime meter log) is in blast radius and < 1d, but doubles persistence surface. Mark for final gate.

### Step 0E: Temporal interrogation

- HOUR 1: server `/v1/leases/issue` returns `tsaState=expired`. CLI prints runbook hint to stderr.
- HOUR 1: operator runs `skillpack tsa manual-attest --ticket-id INC-1 ...`.
- HOUR 1+epsilon: next lease-issue call returns embedded attestation. Runtime resumes via `buildTsaPolicyFromLeaseResponse`.
- HOUR 6: another seat in same customer org hits expiry — auto-embed picks up the SAME attestation record? Per Claude finding (Premise B): plan does not scope by ticket. Risk of accidental carry-forward across seats and tickets within the 24h window.

### Step 0F: Mode confirmation

Mode selected: SELECTIVE EXPANSION on the scope; both models challenge the underlying premises. Premise gate is required before continuing.

### Step 0.5: Dual Voices

#### CODEX SAYS (CEO — strategy challenge)

> Plan assumes TSA outage is a critical buyer blocker. Not proven. Pre-LOI, pre-revenue — this may be engineering theater. The "air-gapped + no sneakernet" persona is suspiciously specific and if real comes with FedRAMP-ish controls, audit exports, key custody requirements far beyond this feature. Manual time attestation creates a sanctioned bypass; regulated buyers may ask "what prevents revenue leakage, backdated usage, abuse?" Audit logs don't restore trust if the control itself becomes discretionary. Runtime continuity as default may not match defense/legal/finance preference for fail-closed; product likely needs policy modes by customer/risk class. Incident timeline premature: lower-cost move is auto-embed + stop; defer GET endpoint + storage parity until buyer specifies audit format. The plan does not sharpen the commercial wedge — differentiation cannot be "we handle TSA outage", it must be "we make MCP/AI skills commercially distributable into offline regulated environments faster than any alternative." Cross-package coupling around a corner case becomes architectural drag if product pivots. `latestManualAttestation` semantically wrong: incident response needs ticket-scoped approval, not "most recent record". 24h is arbitrary. Make TSA optional for v1 pilots; ship advanced assurance mode later. Scope decisions likely to look foolish in 6 months: D1/SQLite/memory parity for incident log, GET endpoint without buyer audit-format requirement, treating "no dashboard UI" as acceptable while building dashboard-ready backend, marking critical gap as shipped when actual market-critical gap is distribution + onboarding + trust docs + first design partner commitment.

#### CLAUDE SUBAGENT (CEO — strategic independence)

> Verdict: competent execution but solves a pre-LOI ghost problem. ~9 tasks of eng burned on hypothetical workflow. Findings (severity ranked):
>
> - **CRITICAL**: wrong problem, wrong time. Defer Tasks 1, 5, 6, 7 (incident-timeline subsystem). Ship Tasks 2+3+4+8 only — closes actual operator UX gap in ~2 days vs ~5.
> - **HIGH**: Premise B wrong — auto-embed without ticket scoping silently re-uses old INC's attestation. Require runtime/CLI to pass ticketId; scope `getLatestManualAttestation` by ticket or by `recordedAtSec >= currentIncidentStartSec`.
> - **HIGH**: Premise D unjustified — 24h is too long for permission gate (one stolen attestation = 24h of free skill execution) and too short for real air-gap incidents. Make policy-driven, default 4h.
> - **HIGH**: Premise E too coarse — operator at Hospital A could read Hospital B's incident events with same management key. Scope auth by tenant/customerId.
> - **MEDIUM**: Premise C wrong place — air-gapped customers can't read their own server-side timeline. Audit belongs in runtime's HMAC-chained meter log; server-side log is hosted convenience.
> - **MEDIUM**: eventId collision — `tsa-warn-${customerId}-${seatId}-${iat}` collides if two warnings emit in same second. Use ULID or random suffix.
> - **MEDIUM**: 6-month regret — first design-partner LOI specifies different audit format (SIEM-pushed CEF/syslog), all 6 audit tasks rewritten.
> - **MEDIUM**: alternatives never considered — (a) wait until design-partner specifies format, (b) emit to stderr/structured logs for SIEM ingest, (c) auto-embed and stop.
> - **LOW**: competitive risk near-zero. Threat is "no customer cares enough" not "someone solves first".
>
> Recommended cut: Ship Task 2 (with ticket-scoped lookup) + 3 + 4 + 8. ~2 days. Defer 1, 5, 6, 7. Delete 24h hardcoded constant; replace with policy-driven value.

#### CEO Dual Voices — Consensus Table

```
═══════════════════════════════════════════════════════════════
  Dimension                            Claude   Codex   Consensus
  ──────────────────────────────────── ──────── ──────── ─────────
  1. Premises valid?                   NO       NO       DISAGREE-WITH-PLAN (both)
  2. Right problem to solve?           NO       NO       DISAGREE-WITH-PLAN (both)
  3. Scope calibration correct?        NO       NO       DISAGREE-WITH-PLAN (both)
  4. Alternatives sufficiently         NO       NO       DISAGREE-WITH-PLAN (both)
     explored?
  5. Competitive/market risks          PARTIAL  NO       DISAGREE-WITH-PLAN (both)
     covered?
  6. 6-month trajectory sound?         NO       NO       DISAGREE-WITH-PLAN (both)
═══════════════════════════════════════════════════════════════
```

Both voices converge on a USER CHALLENGE: cut scope from 9 tasks to 4 (Tasks 2 + 3 + 4 + 8), fix premise B (ticket-scoped attestation), and replace P-D 24h constant with policy-driven default (4h).

### Sections 1-10 (CEO review skill)

Given both voices converge on scope reduction, sections 1-10 below are conditional on the user's response to the premise + user challenge gate. If the user accepts the cut, Sections 1-10 will be re-run on the reduced scope. If the user rejects the cut, Sections 1-10 will be run on the full 9-task plan.

Examined-but-not-flagged at this stage (foundations are clean):
- Section 2 (Error & Rescue Registry): existing manual-attestation contract already returns clear validation errors; the new auto-embed path adds no new error classes beyond `manual_attestation_*` already in runtime. No findings.
- Section 4 (Performance): single extra DB read per lease-issue when status=warning/expired. Negligible.
- Section 5 (Security): see Claude finding HIGH on read-auth scoping; bundled into the user challenge.

### Failure Modes Registry (CEO scope)

| Mode | Trigger | Current handling | Risk |
|---|---|---|---|
| Carry-forward attestation | Auto-embed picks up old INC's record | None (plan does not scope by ticket) | Operator unaware that old attestation is gating new incident |
| Cross-tenant read | Operator at A reads B's events | Management-key only | Multi-tenant data leak |
| EventId collision | Two warnings in same second | PRIMARY KEY conflict | Silent loss of warning event |
| Stale 24h window | Stolen attestation reused | Expiry only | 24h of free skill execution after compromise |

### Dream state delta

This plan, as written, leaves us further from the 12-month ideal in two ways: (a) the audit format is hard-coded as JSON-over-HTTP-pulled, which buyers may reject in favor of SIEM-pushed CEF/syslog; (b) the carry-forward risk creates a soft-trust hole that regulated buyers will catch in diligence. Reduced-scope cut (Tasks 2+3+4+8) + ticket scoping closes both gaps.

### Phase 1 Completion Summary

- 0/6 dimensions confirmed across both voices (full unanimous DISAGREE-WITH-PLAN on scope).
- 1 USER CHALLENGE (scope cut to 4 tasks).
- 4 mechanical auto-decisions logged below.
- Premise gate: REQUIRED before any further phase runs.

### Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale |
|---|---|---|---|---|---|
| 1 | CEO | Use ULID for `eventId` instead of `tsa-warn-${customerId}-${seatId}-${iat}` | Mechanical | P5 explicit | PK collision in same-second warnings; ULID is what the plan prose claims anyway |
| 2 | CEO | Replace hardcoded 24h `maxManualAttestationAgeSec` with policy-driven value, default 4h | Mechanical | P1 + P5 | Stolen attestation = 24h free execution; policy-driven matches existing customer-policy pattern |
| 3 | CEO | Scope `getLatestManualAttestation` by `ticketId` parameter when embedding into lease-issue response | Mechanical | P5 explicit | Without ticket scoping, plan silently carries forward old INC's attestation across new incidents |
| 4 | CEO | If Task 6 ships, scope `/v1/tsa/incident-events` auth by customer tenant rather than only management-key | Mechanical | P1 + P5 | Multi-tenant read leak; not a taste call |

---

## What already exists (foundations we build on)

- `@skillpack/protocol`: `evaluateTsaTokenFreshness`, `validateManualTimeAttestation` Zod schema.
- `@skillpack/tsa`: `createTsaMonitor`, `createManualTimeAttestationContract`.
- `@skillpack/core`: `POST /v1/leases/issue` returns `tsaState`; `POST /v1/tsa/manual-attest` persists records; SQLite + D1 + memory stores all implement `addManualAttestation` + `listManualAttestations` + `getLatestManualAttestation`.
- `@skillpack/runtime`: `verifyLeaseForRuntime` enforces TSA policy and manual-attestation freshness, surfaces `tsa.manualAttestationUsed`.
- `@skillpack/cli`: `skillpack tsa manual-attest` and `skillpack tsa latest-attestation` commands.
- `docs/runbooks/tsa-outage.md`: existing runbook draft (we polish it in Task 8).
