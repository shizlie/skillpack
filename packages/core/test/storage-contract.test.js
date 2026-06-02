import { describe, test, expect } from "bun:test";
import { createLeaseStore } from "../src/storage-contract.js";
import { Database } from "bun:sqlite";

function makeExec() {
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

// D1 stand-in: bun:sqlite is used as the SQL engine (D1 is also SQLite-based,
// so the dialect — including ON CONFLICT upserts and ?1-style params — is
// fully compatible). The meaningful difference is the deliberate omission of
// runInTransaction: D1 does not expose a synchronous transaction API, so
// storage-contract falls back to sequential awaits for appendMeterEvents.
// This exercises the non-transactional code path that runs in production
// against real D1. A Map-backed SQL mock would need to parse ON CONFLICT
// upserts, COALESCE(excluded.*), SUM/GROUP BY, and numbered params — that
// complexity is not warranted here when the SQL dialect is identical.
function makeD1MockExec() {
  const db = new Database(":memory:");
  return {
    exec: {
      first: (sql, ...args) => db.query(sql).get(...args),
      all:   (sql, ...args) => db.query(sql).all(...args),
      run:   (sql, ...args) => db.query(sql).run(...args),
    },
    // No runInTransaction — matches D1's constraint.
  };
}

const backends = {
  sqlite: () => makeExec(),
  d1:     () => makeD1MockExec(),
};

for (const [name, makeExecImpl] of Object.entries(backends)) {
  describe(`createLeaseStore via ${name} executor`, () => {
    test("saveProvider round-trips", async () => {
      const store = createLeaseStore(makeExecImpl());
      const saved = await store.saveProvider({ providerId: "p1", name: "Acme" });
      expect(saved.providerId).toBe("p1");
      expect(saved.name).toBe("Acme");
      const list = await store.listProviders();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("Acme");
    });

    test("saveCustomer requires existing provider", async () => {
      const store = createLeaseStore(makeExecImpl());
      await expect(
        store.saveCustomer("nonexistent", { customerId: "c1" })
      ).rejects.toThrow("provider_not_found");
    });

    test("saveWorkspace round-trips", async () => {
      const store = createLeaseStore(makeExecImpl());
      await store.saveProvider({ providerId: "p1", name: "Acme" });
      await store.saveCustomer("p1", { customerId: "c1", name: "Cust" });
      const ws = await store.saveWorkspace({
        workspaceId: "w1", providerId: "p1", customerId: "c1", name: "WS",
      });
      expect(ws.workspaceId).toBe("w1");
      expect(ws.status).toBe("ACTIVE");
      const list = await store.listWorkspaces();
      expect(list).toHaveLength(1);
    });

    test("appendMeterEvents writes events and is queryable", async () => {
      const store = createLeaseStore(makeExecImpl());
      await store.appendMeterEvents([{
        eventId: "e1", providerId: "p1", customerId: "c1", workspaceId: "w1",
        seatId: "default", tool: "wiki_search", eventKind: "tool_call",
        usage: { unit: "tool_call", delta: 1 }, eventSeq: 0, eventHash: null,
        prevHash: "GENESIS", eventAtSec: 100, rawEvent: {},
      }]);
      const summary = await store.getUsageSummary({ workspaceId: "w1" });
      expect(summary).toHaveLength(1);
      expect(summary[0].totalCalls).toBe(1);
    });

    test("appendMeterEvents ignores duplicates", async () => {
      const store = createLeaseStore(makeExecImpl());
      const event = {
        eventId: "e1", providerId: "p1", customerId: "c1", workspaceId: "w1",
        seatId: "default", tool: "wiki_search", eventKind: "tool_call",
        usage: { unit: "tool_call", delta: 1 }, eventSeq: 0, eventHash: null,
        prevHash: "GENESIS", eventAtSec: 100, rawEvent: {},
      };
      await store.appendMeterEvents([event]);
      await store.appendMeterEvents([event]);
      const summary = await store.getUsageSummary({ workspaceId: "w1" });
      expect(summary[0].totalCalls).toBe(1);
    });

    test("leaseCounter round-trips", async () => {
      const store = createLeaseStore(makeExecImpl());
      expect(await store.getLatestLeaseCounter("c1", "s1")).toBeUndefined();
      await store.updateLatestLeaseCounter("c1", "s1", 42);
      expect(await store.getLatestLeaseCounter("c1", "s1")).toBe(42);
    });

    test("manualAttestation round-trips", async () => {
      const store = createLeaseStore(makeExecImpl());
      await store.addManualAttestation({
        customerId: "c1", seatId: "s1", operatorId: "op1",
        ticketId: "t1", reason: "test", attestedAtSec: 1000,
        recordedAtSec: 1001, source: "manual",
      });
      const r = await store.getLatestManualAttestation("c1", "s1");
      expect(r).not.toBeNull();
      expect(r.ticketId).toBe("t1");
      const all = await store.listManualAttestations({ customerId: "c1" });
      expect(all).toHaveLength(1);
    });

    test("policySnapshot round-trips", async () => {
      const store = createLeaseStore(makeExecImpl());
      const snap = { policyId: "pol1", rules: [] };
      await store.savePolicySnapshot("w1", snap);
      const got = await store.getLatestPolicySnapshot("w1");
      expect(got.policyId).toBe("pol1");
    });

    test("pricingRule round-trips", async () => {
      const store = createLeaseStore(makeExecImpl());
      const rule = {
        pricingRuleId: "pr1", providerId: "p1", customerId: null,
        workspaceId: null, skillId: null, bundleId: null, tool: null,
        unit: "tool_call", currency: "USD", unitAmountCents: 25,
        includedUnits: 0, minimumAmountCents: 0, status: "ACTIVE",
        paymentProvider: null,
      };
      await store.savePricingRule(rule);
      const list = await store.listPricingRules({ providerId: "p1" });
      expect(list).toHaveLength(1);
      expect(list[0].unitAmountCents).toBe(25);
    });

    test("invoice save+get round-trips", async () => {
      const store = createLeaseStore(makeExecImpl());
      const inv = {
        invoiceId: "inv1", providerId: "p1", customerId: "c1",
        workspaceId: null, status: "draft", currency: "USD",
        periodStartSec: 0, periodEndSec: 1000,
        subtotalAmountCents: 100, totalAmountCents: 100,
      };
      await store.saveInvoice(inv);
      const got = await store.getInvoice("inv1");
      expect(got.invoiceId).toBe("inv1");
      const list = await store.listInvoices({ providerId: "p1" });
      expect(list).toHaveLength(1);
    });

    test("paymentHandoff save+get round-trips", async () => {
      const store = createLeaseStore(makeExecImpl());
      const h = {
        invoiceId: "inv1", provider: "stripe", status: "pending",
        checkoutUrl: "https://example.com", externalId: "ext1",
      };
      await store.savePaymentHandoff(h);
      const got = await store.getPaymentHandoff("inv1");
      expect(got.invoiceId).toBe("inv1");
      expect(got.provider).toBe("stripe");
    });

    test("close() is a no-op", () => {
      const store = createLeaseStore(makeExecImpl());
      expect(() => store.close()).not.toThrow();
    });

    test("schema init is idempotent (ensureReady called twice)", async () => {
      const store = createLeaseStore(makeExecImpl());
      // Two calls to any method triggers ensureReady twice (memoized)
      await store.listProviders();
      await store.listProviders();
    });

    test("getAcceptedUsageEvents filters by period", async () => {
      const store = createLeaseStore(makeExecImpl());
      const base = {
        eventId: "e1", providerId: "p1", customerId: "c1", workspaceId: "w1",
        seatId: "default", tool: "wiki_search", eventKind: "tool_call",
        usage: { unit: "tool_call", delta: 1 }, eventSeq: 0, eventHash: null,
        prevHash: "GENESIS", rawEvent: {},
      };
      await store.appendMeterEvents([
        { ...base, eventId: "e1", eventAtSec: 40 },
        { ...base, eventId: "e2", eventAtSec: 100 },
      ]);
      const filtered = await store.getAcceptedUsageEvents({
        workspaceId: "w1", periodStartSec: 50, periodEndSec: 150,
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].eventId).toBe("e2");
      expect(filtered[0].eventAtSec).toBe(100);
      expect(filtered[0].workspaceId).toBe("w1");
      const all = await store.getAcceptedUsageEvents({ workspaceId: "w1" });
      expect(all).toHaveLength(2);
    });

    test("saveWorkspace throws customer_not_found when customer absent", async () => {
      const store = createLeaseStore(makeExecImpl());
      await store.saveProvider({ providerId: "p1", name: "Acme" });
      await expect(
        store.saveWorkspace({
          workspaceId: "w1", providerId: "p1", customerId: "c1", name: "WS",
        })
      ).rejects.toThrow("customer_not_found");
    });

    test("saveWorkspace throws workspace_identity_mismatch on provider change", async () => {
      const store = createLeaseStore(makeExecImpl());
      await store.saveProvider({ providerId: "p1", name: "Acme" });
      await store.saveProvider({ providerId: "p2", name: "Beta" });
      await store.saveCustomer("p1", { customerId: "c1", name: "Cust" });
      await store.saveCustomer("p2", { customerId: "c2", name: "Cust2" });
      await store.saveWorkspace({
        workspaceId: "w1", providerId: "p1", customerId: "c1", name: "WS",
      });
      await expect(
        store.saveWorkspace({
          workspaceId: "w1", providerId: "p2", customerId: "c2", name: "WS",
        })
      ).rejects.toThrow("workspace_identity_mismatch");
    });

    test("listCustomers returns customers for a provider", async () => {
      const store = createLeaseStore(makeExecImpl());
      await store.saveProvider({ providerId: "p1", name: "Acme" });
      await store.saveCustomer("p1", { customerId: "c1", name: "C1" });
      const list = await store.listCustomers("p1");
      expect(list).toHaveLength(1);
      expect(list[0].customerId).toBe("c1");
      const empty = await store.listCustomers("nonexistent");
      expect(empty).toHaveLength(0);
    });
  });
}

describe("storage-contract mappers", () => {
  test("normalizeSeatId null/undefined -> 'default'", async () => {
    const { normalizeSeatId } = await import("../src/storage-contract.js");
    expect(normalizeSeatId(undefined)).toBe("default");
    expect(normalizeSeatId(null)).toBe("default");
    expect(normalizeSeatId("seat-1")).toBe("seat-1");
  });

  test("LEASE_STORE_SCHEMA_STATEMENTS has 10 CREATE TABLE statements", async () => {
    const mod = await import("../src/storage-contract.js");
    expect(mod.LEASE_STORE_SCHEMA_STATEMENTS.length).toBe(10);
    expect(mod.LEASE_STORE_SCHEMA_STATEMENTS.every((s) => s.startsWith("CREATE TABLE"))).toBe(true);
  });

  test("mapPricingRule coerces numeric fields from strings", async () => {
    const { mapPricingRule } = await import("../src/storage-contract.js");
    const result = mapPricingRule({
      pricing_rule_id: "pr1", provider_id: "p1", customer_id: null,
      workspace_id: null, skill_id: null, bundle_id: null, tool_name: null,
      unit: "tool_call", currency: "USD",
      unit_amount_cents: "25", included_units: "0", minimum_amount_cents: "0",
      status: "ACTIVE", payment_provider_json: null,
    });
    expect(typeof result.unitAmountCents).toBe("number");
    expect(result.unitAmountCents).toBe(25);
    expect(typeof result.includedUnits).toBe("number");
    expect(typeof result.minimumAmountCents).toBe("number");
  });

  test("mapUsageEvent coerces numeric fields from strings", async () => {
    const { mapUsageEvent } = await import("../src/storage-contract.js");
    const result = mapUsageEvent({
      event_id: "e1", provider_id: "p1", customer_id: "c1",
      workspace_id: "w1", seat_id: "default",
      skill_id: null, bundle_id: null, lease_id: null, lease_jti: null,
      policy_id: null, tool_name: "wiki_search", event_kind: "tool_call",
      usage_unit: "tool_call", usage_delta: "1",
      event_seq: "0", event_hash: null, prev_hash: "GENESIS",
      event_at_sec: "100", event_json: "{}",
    });
    expect(typeof result.usage.delta).toBe("number");
    expect(result.usage.delta).toBe(1);
    expect(typeof result.eventSeq).toBe("number");
    expect(typeof result.eventAtSec).toBe("number");
  });

  test("mapManualAttestation maps snake_case to camelCase", async () => {
    const { mapManualAttestation } = await import("../src/storage-contract.js");
    const row = {
      customer_id: "c1", seat_id: "s1", operator_id: "op1",
      ticket_id: "t1", reason: "r", attested_at_sec: 1, recorded_at_sec: 2,
      source: "manual",
    };
    const r = mapManualAttestation(row);
    expect(r.customerId).toBe("c1");
    expect(r.attestedAtSec).toBe(1);
  });

  test("mapInvoice parses JSON blob", async () => {
    const { mapInvoice } = await import("../src/storage-contract.js");
    const row = { invoice_json: JSON.stringify({ invoiceId: "i1" }) };
    expect(mapInvoice(row).invoiceId).toBe("i1");
  });

  test("mapPaymentHandoff parses JSON blob", async () => {
    const { mapPaymentHandoff } = await import("../src/storage-contract.js");
    const row = { handoff_json: JSON.stringify({ invoiceId: "i1" }) };
    expect(mapPaymentHandoff(row).invoiceId).toBe("i1");
  });
});
