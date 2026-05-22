import Database from "better-sqlite3";
import { WORKSPACE_STATUS_ACTIVE } from "@skillpack/protocol";
import {
  SCHEMA_DDL,
  buildSelectQuery,
  normalizeSeatId,
  normalizeTimestamp,
  mapPricingRule,
  mapUsageEvent,
  mapUsageSummary,
  buildUsageEventParams,
  buildPricingRuleParams,
  buildInvoiceParams,
  buildPaymentHandoffParams,
  buildAttestationParams,
} from "./schema.js";

export function createBetterSqlite3LeaseStore({ dbPath = "./skillpack.db" } = {}) {
  const db = new Database(dbPath);
  db.exec(SCHEMA_DDL);

  return {
    db,
    getLatestLeaseCounter(customerId, seatId) {
      const row = db.prepare(buildSelectQuery("lease_counters", ["lease_counter"], "customer_id = ?1 AND seat_id = ?2")).get(customerId, normalizeSeatId(seatId));
      return row?.lease_counter;
    },
    updateLatestLeaseCounter(customerId, seatId, leaseCounter) {
      db.prepare(`INSERT INTO lease_counters (customer_id,seat_id,lease_counter) VALUES (?1,?2,?3) ON CONFLICT(customer_id,seat_id) DO UPDATE SET lease_counter=excluded.lease_counter`).run(customerId, normalizeSeatId(seatId), leaseCounter);
    },
    addManualAttestation(record) {
      db.prepare(`INSERT INTO manual_attestations (customer_id,seat_id,operator_id,ticket_id,reason,attested_at_sec,recorded_at_sec,source) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`).run(...buildAttestationParams(record));
    },
    getLatestManualAttestation(customerId, seatId = "default", { ticketId } = {}) {
      const row = db.prepare(`SELECT customer_id,seat_id,operator_id,ticket_id,reason,attested_at_sec,recorded_at_sec,source FROM manual_attestations WHERE customer_id=?1 AND seat_id=?2 AND (?3 IS NULL OR ticket_id=?3) ORDER BY recorded_at_sec DESC,id DESC LIMIT 1`).get(customerId, normalizeSeatId(seatId), ticketId ?? null);
      if (!row) return null;
      return { customerId: row.customer_id, seatId: row.seat_id, operatorId: row.operator_id, ticketId: row.ticket_id, reason: row.reason, attestedAtSec: row.attested_at_sec, recordedAtSec: row.recorded_at_sec, source: row.source };
    },
    listManualAttestations({ customerId, seatId } = {}) {
      return db.prepare(`SELECT customer_id,seat_id,operator_id,ticket_id,reason,attested_at_sec,recorded_at_sec,source FROM manual_attestations WHERE (?1 IS NULL OR customer_id=?1) AND (?2 IS NULL OR seat_id=?2) ORDER BY recorded_at_sec DESC,id DESC`).all(customerId ?? null, seatId ?? null).map((row) => ({ customerId: row.customer_id, seatId: row.seat_id, operatorId: row.operator_id, ticketId: row.ticket_id, reason: row.reason, attestedAtSec: row.attested_at_sec, recordedAtSec: row.recorded_at_sec, source: row.source }));
    },
    savePolicySnapshot(workspaceId, snapshot) {
      db.prepare(`INSERT INTO policy_snapshots (workspace_id,policy_id,snapshot_json,updated_at_sec) VALUES (?1,?2,?3,?4) ON CONFLICT(workspace_id) DO UPDATE SET policy_id=excluded.policy_id,snapshot_json=excluded.snapshot_json,updated_at_sec=excluded.updated_at_sec`).run(workspaceId, snapshot.policyId, JSON.stringify(snapshot), normalizeTimestamp());
      return snapshot;
    },
    getLatestPolicySnapshot(workspaceId) {
      const row = db.prepare(buildSelectQuery("policy_snapshots", ["snapshot_json"], "workspace_id = ?1", null, 1)).get(workspaceId);
      return row ? JSON.parse(row.snapshot_json) : null;
    },
    saveProvider(provider) {
      const nowSec = normalizeTimestamp();
      db.prepare(`INSERT INTO providers (provider_id,name,updated_at_sec) VALUES (?1,?2,?3) ON CONFLICT(provider_id) DO UPDATE SET name=COALESCE(excluded.name,providers.name),updated_at_sec=excluded.updated_at_sec`).run(provider.providerId, provider.name ?? null, nowSec);
      const saved = db.prepare(buildSelectQuery("providers", ["provider_id", "name"], "provider_id = ?1", null, 1)).get(provider.providerId);
      return { providerId: saved.provider_id, name: saved.name ?? null };
    },
    listProviders() {
      return db.prepare(buildSelectQuery("providers", ["provider_id", "name"], null, "provider_id")).all().map((row) => ({ providerId: row.provider_id, name: row.name ?? null }));
    },
    saveCustomer(providerId, customer) {
      const provider = db.prepare(buildSelectQuery("providers", ["provider_id"], "provider_id = ?1", null, 1)).get(providerId);
      if (!provider) throw new Error("provider_not_found");
      const nowSec = normalizeTimestamp();
      db.prepare(`INSERT INTO customers (provider_id,customer_id,name,updated_at_sec) VALUES (?1,?2,?3,?4) ON CONFLICT(provider_id,customer_id) DO UPDATE SET name=COALESCE(excluded.name,customers.name),updated_at_sec=excluded.updated_at_sec`).run(providerId, customer.customerId, customer.name ?? null, nowSec);
      const saved = db.prepare(buildSelectQuery("customers", ["provider_id", "customer_id", "name"], "provider_id = ?1 AND customer_id = ?2", null, 1)).get(providerId, customer.customerId);
      return { providerId: saved.provider_id, customerId: saved.customer_id, name: saved.name ?? null };
    },
    listCustomers(providerId) {
      return db.prepare(buildSelectQuery("customers", ["provider_id", "customer_id", "name"], "(?1 IS NULL OR provider_id = ?1)", "provider_id, customer_id")).all(providerId ?? null).map((row) => ({ providerId: row.provider_id, customerId: row.customer_id, name: row.name ?? null }));
    },
    saveWorkspace(workspace) {
      const provider = db.prepare(buildSelectQuery("providers", ["provider_id"], "provider_id = ?1", null, 1)).get(workspace.providerId);
      if (!provider) throw new Error("provider_not_found");
      const customer = db.prepare(buildSelectQuery("customers", ["customer_id"], "provider_id = ?1 AND customer_id = ?2", null, 1)).get(workspace.providerId, workspace.customerId);
      if (!customer) throw new Error("customer_not_found");
      const existing = db.prepare(buildSelectQuery("workspaces", ["workspace_id", "provider_id", "customer_id", "name", "status"], "workspace_id = ?1", null, 1)).get(workspace.workspaceId);
      if (existing && (existing.provider_id !== workspace.providerId || existing.customer_id !== workspace.customerId)) throw new Error("workspace_identity_mismatch");
      const nowSec = normalizeTimestamp();
      db.prepare(`INSERT INTO workspaces (workspace_id,provider_id,customer_id,name,status,updated_at_sec) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(workspace_id) DO UPDATE SET name=COALESCE(excluded.name,workspaces.name),status=excluded.status,updated_at_sec=excluded.updated_at_sec WHERE workspaces.provider_id=excluded.provider_id AND workspaces.customer_id=excluded.customer_id`).run(workspace.workspaceId, workspace.providerId, workspace.customerId, workspace.name ?? null, workspace.status ?? existing?.status ?? WORKSPACE_STATUS_ACTIVE, nowSec);
      const saved = db.prepare(buildSelectQuery("workspaces", ["workspace_id", "provider_id", "customer_id", "name", "status"], "workspace_id = ?1", null, 1)).get(workspace.workspaceId);
      if (saved.provider_id !== workspace.providerId || saved.customer_id !== workspace.customerId) throw new Error("workspace_identity_mismatch");
      return { workspaceId: saved.workspace_id, providerId: saved.provider_id, customerId: saved.customer_id, name: saved.name ?? null, status: saved.status };
    },
    listWorkspaces({ providerId, customerId } = {}) {
      return db.prepare(buildSelectQuery("workspaces", ["workspace_id", "provider_id", "customer_id", "name", "status"], "(?1 IS NULL OR provider_id = ?1) AND (?2 IS NULL OR customer_id = ?2)", "workspace_id")).all(providerId ?? null, customerId ?? null).map((row) => ({ workspaceId: row.workspace_id, providerId: row.provider_id, customerId: row.customer_id, name: row.name ?? null, status: row.status }));
    },
    appendMeterEvents(events) {
      const insert = db.prepare(`INSERT OR IGNORE INTO accepted_usage_events (event_id,provider_id,customer_id,workspace_id,seat_id,skill_id,bundle_id,lease_id,lease_jti,policy_id,tool_name,event_kind,usage_unit,usage_delta,event_seq,event_hash,prev_hash,event_at_sec,event_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`);
      const tx = db.transaction((items) => { for (const event of items) insert.run(...buildUsageEventParams(event)); });
      tx(events);
    },
    savePricingRule(rule) {
      db.prepare(`INSERT INTO pricing_rules (pricing_rule_id,provider_id,customer_id,workspace_id,skill_id,bundle_id,tool_name,unit,currency,unit_amount_cents,included_units,minimum_amount_cents,status,payment_provider_json,updated_at_sec) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15) ON CONFLICT(pricing_rule_id) DO UPDATE SET provider_id=excluded.provider_id,customer_id=excluded.customer_id,workspace_id=excluded.workspace_id,skill_id=excluded.skill_id,bundle_id=excluded.bundle_id,tool_name=excluded.tool_name,unit=excluded.unit,currency=excluded.currency,unit_amount_cents=excluded.unit_amount_cents,included_units=excluded.included_units,minimum_amount_cents=excluded.minimum_amount_cents,status=excluded.status,payment_provider_json=excluded.payment_provider_json,updated_at_sec=excluded.updated_at_sec`).run(...buildPricingRuleParams(rule, normalizeTimestamp()));
      return rule;
    },
    listPricingRules({ providerId, customerId, workspaceId } = {}) {
      return db.prepare(`SELECT * FROM pricing_rules WHERE (?1 IS NULL OR provider_id=?1) AND (?2 IS NULL OR customer_id IS NULL OR customer_id=?2) AND (?3 IS NULL OR workspace_id IS NULL OR workspace_id=?3) ORDER BY pricing_rule_id`).all(providerId ?? null, customerId ?? null, workspaceId ?? null).map(mapPricingRule);
    },
    getAcceptedUsageEvents({ providerId, customerId, workspaceId, periodStartSec, periodEndSec } = {}) {
      return db.prepare(`SELECT * FROM accepted_usage_events WHERE usage_unit='tool_call' AND (?1 IS NULL OR provider_id=?1) AND (?2 IS NULL OR customer_id=?2) AND (?3 IS NULL OR workspace_id=?3) AND (?4 IS NULL OR event_at_sec>=?4) AND (?5 IS NULL OR event_at_sec<?5) ORDER BY event_at_sec,event_seq`).all(providerId ?? null, customerId ?? null, workspaceId ?? null, periodStartSec ?? null, periodEndSec ?? null).map(mapUsageEvent);
    },
    saveInvoice(invoice) {
      db.prepare(`INSERT INTO invoices (invoice_id,provider_id,customer_id,workspace_id,status,currency,period_start_sec,period_end_sec,subtotal_amount_cents,total_amount_cents,invoice_json,updated_at_sec) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(invoice_id) DO UPDATE SET provider_id=excluded.provider_id,customer_id=excluded.customer_id,workspace_id=excluded.workspace_id,status=excluded.status,currency=excluded.currency,period_start_sec=excluded.period_start_sec,period_end_sec=excluded.period_end_sec,subtotal_amount_cents=excluded.subtotal_amount_cents,total_amount_cents=excluded.total_amount_cents,invoice_json=excluded.invoice_json,updated_at_sec=excluded.updated_at_sec`).run(...buildInvoiceParams(invoice, normalizeTimestamp()));
      return invoice;
    },
    getInvoice(invoiceId) {
      const row = db.prepare(buildSelectQuery("invoices", ["invoice_json"], "invoice_id = ?1", null, 1)).get(invoiceId);
      return row ? JSON.parse(row.invoice_json) : null;
    },
    listInvoices({ providerId, customerId } = {}) {
      return db.prepare(buildSelectQuery("invoices", ["invoice_json"], "(?1 IS NULL OR provider_id = ?1) AND (?2 IS NULL OR customer_id = ?2)", "invoice_id")).all(providerId ?? null, customerId ?? null).map((row) => JSON.parse(row.invoice_json));
    },
    savePaymentHandoff(handoff) {
      db.prepare(`INSERT INTO payment_handoffs (invoice_id,provider,status,checkout_url,external_id,handoff_json,updated_at_sec) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(invoice_id) DO UPDATE SET provider=excluded.provider,status=excluded.status,checkout_url=excluded.checkout_url,external_id=excluded.external_id,handoff_json=excluded.handoff_json,updated_at_sec=excluded.updated_at_sec`).run(...buildPaymentHandoffParams(handoff, normalizeTimestamp()));
      return handoff;
    },
    getUsageSummary({ providerId, customerId, workspaceId, seatId, skillId, bundleId } = {}) {
      return db.prepare(`SELECT provider_id,customer_id,workspace_id,seat_id,skill_id,bundle_id,lease_jti,tool_name,usage_unit,SUM(usage_delta) AS total_calls FROM accepted_usage_events WHERE usage_unit='tool_call' AND (?1 IS NULL OR provider_id=?1) AND (?2 IS NULL OR customer_id=?2) AND (?3 IS NULL OR workspace_id=?3) AND (?4 IS NULL OR seat_id=?4) AND (?5 IS NULL OR skill_id=?5) AND (?6 IS NULL OR bundle_id=?6) GROUP BY provider_id,customer_id,workspace_id,seat_id,skill_id,bundle_id,lease_jti,tool_name,usage_unit ORDER BY provider_id,customer_id,workspace_id,seat_id,skill_id,bundle_id,lease_jti,tool_name`).all(providerId ?? null, customerId ?? null, workspaceId ?? null, seatId ?? null, skillId ?? null, bundleId ?? null).map(mapUsageSummary);
    },
    close() {
      db.close();
    },
  };
}
