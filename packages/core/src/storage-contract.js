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
//

const LEASE_STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lease_counters (
  customer_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  lease_counter INTEGER NOT NULL,
  PRIMARY KEY (customer_id, seat_id)
);

CREATE TABLE IF NOT EXISTS manual_attestations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  attested_at_sec INTEGER NOT NULL,
  recorded_at_sec INTEGER NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_snapshots (
  workspace_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  updated_at_sec INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  provider_id TEXT PRIMARY KEY,
  name TEXT,
  updated_at_sec INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  provider_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT,
  updated_at_sec INTEGER NOT NULL,
  PRIMARY KEY (provider_id, customer_id)
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL,
  updated_at_sec INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accepted_usage_events (
  event_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  skill_id TEXT,
  bundle_id TEXT,
  lease_id TEXT,
  lease_jti TEXT,
  policy_id TEXT,
  tool_name TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  usage_unit TEXT NOT NULL,
  usage_delta REAL NOT NULL,
  event_seq INTEGER NOT NULL,
  event_hash TEXT,
  prev_hash TEXT NOT NULL,
  event_at_sec INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  UNIQUE (workspace_id, seat_id, lease_jti, event_seq)
);

CREATE TABLE IF NOT EXISTS pricing_rules (
  pricing_rule_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  customer_id TEXT,
  workspace_id TEXT,
  skill_id TEXT,
  bundle_id TEXT,
  tool_name TEXT,
  unit TEXT NOT NULL,
  currency TEXT NOT NULL,
  unit_amount_cents INTEGER NOT NULL,
  included_units REAL NOT NULL,
  minimum_amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  payment_provider_json TEXT,
  updated_at_sec INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  invoice_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  workspace_id TEXT,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  period_start_sec INTEGER NOT NULL,
  period_end_sec INTEGER NOT NULL,
  subtotal_amount_cents INTEGER NOT NULL,
  total_amount_cents INTEGER NOT NULL,
  invoice_json TEXT NOT NULL,
  updated_at_sec INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_handoffs (
  invoice_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  checkout_url TEXT,
  external_id TEXT,
  handoff_json TEXT NOT NULL,
  updated_at_sec INTEGER NOT NULL
);
`;

const LEASE_STORE_SCHEMA_STATEMENTS = LEASE_STORE_SCHEMA_SQL.split(";")
  .map((statement) => statement.trim())
  .filter(Boolean)
  .map((statement) => statement.replace(/\s+/g, " ").trim());

export function normalizeSeatId(seatId) {
  return seatId ?? "default";
}

export function mapPricingRule(row) {
  return {
    pricingRuleId: row.pricing_rule_id,
    providerId: row.provider_id,
    customerId: row.customer_id ?? null,
    workspaceId: row.workspace_id ?? null,
    skillId: row.skill_id ?? null,
    bundleId: row.bundle_id ?? null,
    tool: row.tool_name ?? null,
    unit: row.unit,
    currency: row.currency,
    unitAmountCents: Number(row.unit_amount_cents),
    includedUnits: Number(row.included_units),
    minimumAmountCents: Number(row.minimum_amount_cents),
    status: row.status,
    paymentProvider: row.payment_provider_json ? JSON.parse(row.payment_provider_json) : null,
  };
}

export function mapUsageEvent(row) {
  return {
    eventId: row.event_id,
    providerId: row.provider_id,
    customerId: row.customer_id,
    workspaceId: row.workspace_id,
    seatId: row.seat_id,
    skillId: row.skill_id ?? null,
    bundleId: row.bundle_id ?? null,
    leaseId: row.lease_id ?? null,
    leaseJti: row.lease_jti ?? null,
    policyId: row.policy_id ?? null,
    tool: row.tool_name,
    eventKind: row.event_kind,
    usage: { unit: row.usage_unit, delta: Number(row.usage_delta) },
    eventSeq: Number(row.event_seq),
    eventHash: row.event_hash ?? null,
    prevHash: row.prev_hash,
    eventAtSec: Number(row.event_at_sec),
    rawEvent: row.event_json ? JSON.parse(row.event_json) : {},
  };
}

export { LEASE_STORE_SCHEMA_SQL, LEASE_STORE_SCHEMA_STATEMENTS };
