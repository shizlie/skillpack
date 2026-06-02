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

describe("createLeaseStore (contract via bun:sqlite)", () => {
  test("saveProvider round-trips", async () => {
    const store = createLeaseStore(makeExec());
    const saved = await store.saveProvider({ providerId: "p1", name: "Acme" });
    expect(saved.providerId).toBe("p1");
    expect(saved.name).toBe("Acme");
    const list = await store.listProviders();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Acme");
  });

  test("saveCustomer requires existing provider", async () => {
    const store = createLeaseStore(makeExec());
    await expect(
      store.saveCustomer("nonexistent", { customerId: "c1" })
    ).rejects.toThrow("provider_not_found");
  });

  test("saveWorkspace round-trips", async () => {
    const store = createLeaseStore(makeExec());
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

  test("appendMeterEvents is atomic", async () => {
    const store = createLeaseStore(makeExec());
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
    const store = createLeaseStore(makeExec());
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
    const store = createLeaseStore(makeExec());
    expect(await store.getLatestLeaseCounter("c1", "s1")).toBeUndefined();
    await store.updateLatestLeaseCounter("c1", "s1", 42);
    expect(await store.getLatestLeaseCounter("c1", "s1")).toBe(42);
  });

  test("manualAttestation round-trips", async () => {
    const store = createLeaseStore(makeExec());
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
    const store = createLeaseStore(makeExec());
    const snap = { policyId: "pol1", rules: [] };
    await store.savePolicySnapshot("w1", snap);
    const got = await store.getLatestPolicySnapshot("w1");
    expect(got.policyId).toBe("pol1");
  });

  test("pricingRule round-trips", async () => {
    const store = createLeaseStore(makeExec());
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
    const store = createLeaseStore(makeExec());
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
    const store = createLeaseStore(makeExec());
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
    const store = createLeaseStore(makeExec());
    expect(() => store.close()).not.toThrow();
  });

  test("schema init is idempotent (ensureReady called twice)", async () => {
    const store = createLeaseStore(makeExec());
    // Two calls to any method triggers ensureReady twice (memoized)
    await store.listProviders();
    await store.listProviders();
  });
});

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
