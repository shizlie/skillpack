import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createD1LeaseStore } from "../src/storage-d1.js";

function createTestD1Database() {
  const sqlite = new Database(":memory:");

  function statement(sql, args = []) {
    return {
      bind(...nextArgs) {
        return statement(sql, nextArgs);
      },
      async run() {
        sqlite.query(sql).run(...args);
        return { success: true };
      },
      async first() {
        const row = sqlite.query(sql).get(...args);
        return row ?? null;
      },
      async all() {
        const rows = sqlite.query(sql).all(...args);
        return { results: rows };
      },
    };
  }

  return {
    prepare(sql) {
      return statement(sql);
    },
    async exec(sql) {
      sqlite.exec(sql);
      return { success: true };
    },
    async batch(statements) {
      const out = [];
      for (const stmt of statements) {
        out.push(await stmt.run());
      }
      return out;
    },
    close() {
      sqlite.close(false);
    },
  };
}

async function seedD1Attestations(store) {
  await store.addManualAttestation({
    customerId: "cust-a",
    seatId: "seat-1",
    operatorId: "op-1",
    ticketId: "INC-1",
    reason: "reason-a1",
    attestedAtSec: 1_000,
    recordedAtSec: 1_001,
    source: "manual",
  });
  await store.addManualAttestation({
    customerId: "cust-a",
    seatId: "seat-2",
    operatorId: "op-1",
    ticketId: "INC-2",
    reason: "reason-a2",
    attestedAtSec: 2_000,
    recordedAtSec: 2_001,
    source: "manual",
  });
  await store.addManualAttestation({
    customerId: "cust-b",
    seatId: "seat-1",
    operatorId: "op-2",
    ticketId: "INC-3",
    reason: "reason-b1",
    attestedAtSec: 3_000,
    recordedAtSec: 3_001,
    source: "manual",
  });
}

test("d1 listManualAttestations: returns all when no filters", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });
  await seedD1Attestations(store);
  const all = await store.listManualAttestations();
  expect(all.length).toBe(3);
});

test("d1 listManualAttestations: filters by customerId", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });
  await seedD1Attestations(store);
  const rows = await store.listManualAttestations({ customerId: "cust-a" });
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.customerId === "cust-a")).toBe(true);
});

test("d1 listManualAttestations: filters by seatId", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });
  await seedD1Attestations(store);
  const rows = await store.listManualAttestations({ seatId: "seat-1" });
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.seatId === "seat-1")).toBe(true);
});

test("d1 listManualAttestations: filters by customerId + seatId (AND)", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });
  await seedD1Attestations(store);
  const rows = await store.listManualAttestations({ customerId: "cust-a", seatId: "seat-1" });
  expect(rows.length).toBe(1);
  expect(rows[0].ticketId).toBe("INC-1");
});

test("d1 listManualAttestations: returns empty for no-match", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });
  await seedD1Attestations(store);
  const rows = await store.listManualAttestations({ customerId: "cust-z" });
  expect(rows.length).toBe(0);
});

test("d1 listManualAttestations: undefined filter treated as no-filter", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });
  await seedD1Attestations(store);
  const rows = await store.listManualAttestations({ customerId: undefined, seatId: undefined });
  expect(rows.length).toBe(3);
});

test("d1 getLatestManualAttestation: can scope by ticketId", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });
  await store.addManualAttestation({
    customerId: "cust-ticket",
    seatId: "seat-1",
    operatorId: "op-1",
    ticketId: "INC-1",
    reason: "reason-one",
    attestedAtSec: 1_000,
    recordedAtSec: 1_001,
    source: "manual",
  });
  await store.addManualAttestation({
    customerId: "cust-ticket",
    seatId: "seat-1",
    operatorId: "op-2",
    ticketId: "INC-2",
    reason: "reason-two",
    attestedAtSec: 2_000,
    recordedAtSec: 2_001,
    source: "manual",
  });

  const latest = await store.getLatestManualAttestation("cust-ticket", "seat-1", {
    ticketId: "INC-1",
  });
  expect(latest.ticketId).toBe("INC-1");
});

test("d1 store: commercial hierarchy + usage summary", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });

  const provider = await store.saveProvider({ providerId: "prov-1", name: "Provider One" });
  expect(provider.providerId).toBe("prov-1");

  const customer = await store.saveCustomer("prov-1", {
    customerId: "cust-1",
    name: "Customer One",
  });
  expect(customer.customerId).toBe("cust-1");

  const workspace = await store.saveWorkspace({
    workspaceId: "ws-1",
    providerId: "prov-1",
    customerId: "cust-1",
    name: "Workspace One",
  });
  expect(workspace.status).toBe("ACTIVE");

  await store.appendMeterEvents([
    {
      eventId: "ws-1:seat-1:jti-1:1",
      providerId: "prov-1",
      customerId: "cust-1",
      workspaceId: "ws-1",
      seatId: "seat-1",
      skillId: "laws-consultant",
      bundleId: "laws-consultant-1.0.0",
      leaseId: null,
      leaseJti: "jti-1",
      policyId: "pol-1",
      tool: "wiki_search",
      eventKind: "tool_call",
      usage: { unit: "tool_call", delta: 2 },
      eventSeq: 1,
      eventHash: null,
      prevHash: "h0",
      eventAtSec: 1_800_000_000,
      rawEvent: { seq: 1 },
    },
  ]);

  const summary = await store.getUsageSummary({
    providerId: "prov-1",
    workspaceId: "ws-1",
  });

  expect(summary).toEqual([
    {
      providerId: "prov-1",
      customerId: "cust-1",
      workspaceId: "ws-1",
      seatId: "seat-1",
      skillId: "laws-consultant",
      bundleId: "laws-consultant-1.0.0",
      leaseJti: "jti-1",
      tool: "wiki_search",
      unit: "tool_call",
      totalCalls: 2,
    },
  ]);

  db.close();
});

test("d1 store: meter idempotency with INSERT OR IGNORE", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });

  await store.appendMeterEvents([
    {
      eventId: "ws-1:seat-1::1",
      providerId: "prov-1",
      customerId: "cust-1",
      workspaceId: "ws-1",
      seatId: "seat-1",
      skillId: null,
      bundleId: null,
      leaseId: null,
      leaseJti: null,
      policyId: null,
      tool: "wiki_search",
      eventKind: "tool_call",
      usage: { unit: "tool_call", delta: 1 },
      eventSeq: 1,
      eventHash: null,
      prevHash: "h0",
      eventAtSec: 1_800_000_001,
      rawEvent: { seq: 1 },
    },
  ]);

  await store.appendMeterEvents([
    {
      eventId: "ws-1:seat-1::1",
      providerId: "prov-1",
      customerId: "cust-1",
      workspaceId: "ws-1",
      seatId: "seat-1",
      skillId: null,
      bundleId: null,
      leaseId: null,
      leaseJti: null,
      policyId: null,
      tool: "wiki_search",
      eventKind: "tool_call",
      usage: { unit: "tool_call", delta: 1 },
      eventSeq: 1,
      eventHash: null,
      prevHash: "h0",
      eventAtSec: 1_800_000_001,
      rawEvent: { seq: 1 },
    },
  ]);

  const summary = await store.getUsageSummary({ workspaceId: "ws-1" });
  expect(summary).toHaveLength(1);
  expect(summary[0].totalCalls).toBe(1);

  db.close();
});

test("d1 store: saveCustomer rejects unknown provider", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });

  await expect(
    store.saveCustomer("nonexistent-provider", { customerId: "cust-1" })
  ).rejects.toThrow("provider_not_found");

  db.close();
});

test("d1 store: saveWorkspace rejects unknown provider", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });

  await expect(
    store.saveWorkspace({ workspaceId: "ws-1", providerId: "nonexistent", customerId: "cust-1" })
  ).rejects.toThrow("provider_not_found");

  db.close();
});

test("d1 store: saveWorkspace rejects unknown customer", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });

  await store.saveProvider({ providerId: "prov-1", name: "P1" });

  await expect(
    store.saveWorkspace({ workspaceId: "ws-1", providerId: "prov-1", customerId: "nonexistent" })
  ).rejects.toThrow("customer_not_found");

  db.close();
});

test("d1 store: saveWorkspace rejects identity mismatch on existing workspace", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });

  await store.saveProvider({ providerId: "prov-1", name: "P1" });
  await store.saveProvider({ providerId: "prov-2", name: "P2" });
  await store.saveCustomer("prov-1", { customerId: "cust-1" });
  await store.saveCustomer("prov-2", { customerId: "cust-1" });

  await store.saveWorkspace({
    workspaceId: "ws-1",
    providerId: "prov-1",
    customerId: "cust-1",
    name: "original",
  });

  await expect(
    store.saveWorkspace({
      workspaceId: "ws-1",
      providerId: "prov-2",
      customerId: "cust-1",
      name: "hijack",
    })
  ).rejects.toThrow("workspace_identity_mismatch");

  const rows = await store.listWorkspaces({ providerId: "prov-1" });
  expect(rows.length).toBe(1);
  expect(rows[0].providerId).toBe("prov-1");
  expect(rows[0].name).toBe("original");

  db.close();
});

test("d1 store: saveWorkspace ON CONFLICT WHERE clause skips update on identity mismatch (TOCTOU defense)", async () => {
  const db = createTestD1Database();
  const store = createD1LeaseStore({ db });

  await store.saveProvider({ providerId: "prov-1", name: "P1" });
  await store.saveProvider({ providerId: "prov-2", name: "P2" });
  await store.saveCustomer("prov-1", { customerId: "cust-1" });
  await store.saveCustomer("prov-2", { customerId: "cust-1" });

  await store.saveWorkspace({
    workspaceId: "ws-1",
    providerId: "prov-1",
    customerId: "cust-1",
    name: "original",
  });

  // Bypass app-layer read-check-write: invoke raw upsert with mismatched identity.
  // Simulates TOCTOU race where existing-row read returned null but another writer
  // inserted between the read and our write.
  await db
    .prepare(
      `INSERT INTO workspaces (
        workspace_id, provider_id, customer_id, name, status, updated_at_sec
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(workspace_id)
      DO UPDATE SET
        name = COALESCE(excluded.name, workspaces.name),
        status = excluded.status,
        updated_at_sec = excluded.updated_at_sec
      WHERE workspaces.provider_id = excluded.provider_id
        AND workspaces.customer_id = excluded.customer_id`
    )
    .bind("ws-1", "prov-2", "cust-1", "hijacked", "ACTIVE", 9_999)
    .run();

  const rows = await store.listWorkspaces({});
  expect(rows.length).toBe(1);
  expect(rows[0].providerId).toBe("prov-1");
  expect(rows[0].name).toBe("original");

  db.close();
});
