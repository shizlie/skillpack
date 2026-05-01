import { USAGE_UNIT_TOOL_CALL, WORKSPACE_STATUS_ACTIVE } from "@skillpack/protocol";

const D1_SCHEMA_SQL = `
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
const D1_SCHEMA_STATEMENTS = D1_SCHEMA_SQL.split(";")
  .map((statement) => statement.trim())
  .filter(Boolean)
  .map((statement) => statement.replace(/\s+/g, " ").trim());

function normalizeSeatId(seatId) {
  return seatId ?? "default";
}

function mapPricingRule(row) {
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

function mapUsageEvent(row) {
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

async function firstRow(db, sql, ...params) {
  return await db.prepare(sql).bind(...params).first();
}

async function allRows(db, sql, ...params) {
  const out = await db.prepare(sql).bind(...params).all();
  return out?.results ?? [];
}

async function runStmt(db, sql, ...params) {
  await db.prepare(sql).bind(...params).run();
}

export async function ensureD1Schema(db) {
  for (const statement of D1_SCHEMA_STATEMENTS) {
    await db.prepare(statement).run();
  }
}

export function createD1LeaseStore({ db }) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("d1_store_missing_db");
  }

  let schemaReady = null;
  async function ensureReady() {
    if (!schemaReady) schemaReady = ensureD1Schema(db);
    await schemaReady;
  }

  return {
    async getLatestLeaseCounter(customerId, seatId) {
      await ensureReady();
      const row = await firstRow(
        db,
        "SELECT lease_counter FROM lease_counters WHERE customer_id = ?1 AND seat_id = ?2",
        customerId,
        normalizeSeatId(seatId)
      );
      return row?.lease_counter;
    },
    async updateLatestLeaseCounter(customerId, seatId, leaseCounter) {
      await ensureReady();
      await runStmt(
        db,
        `INSERT INTO lease_counters (customer_id, seat_id, lease_counter)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(customer_id, seat_id)
         DO UPDATE SET lease_counter = excluded.lease_counter`,
        customerId,
        normalizeSeatId(seatId),
        leaseCounter
      );
    },
    async addManualAttestation(record) {
      await ensureReady();
      await runStmt(
        db,
        `INSERT INTO manual_attestations (
          customer_id, seat_id, operator_id, ticket_id, reason, attested_at_sec, recorded_at_sec, source
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        record.customerId,
        normalizeSeatId(record.seatId),
        record.operatorId,
        record.ticketId,
        record.reason,
        record.attestedAtSec,
        record.recordedAtSec,
        record.source
      );
    },
    async getLatestManualAttestation(customerId, seatId = "default", { ticketId } = {}) {
      await ensureReady();
      const row = await firstRow(
        db,
        `SELECT customer_id, seat_id, operator_id, ticket_id, reason, attested_at_sec, recorded_at_sec, source
         FROM manual_attestations
         WHERE customer_id = ?1 AND seat_id = ?2
           AND (?3 IS NULL OR ticket_id = ?3)
         ORDER BY recorded_at_sec DESC, id DESC
         LIMIT 1`,
        customerId,
        normalizeSeatId(seatId),
        ticketId ?? null
      );
      if (!row) return null;
      return {
        customerId: row.customer_id,
        seatId: row.seat_id,
        operatorId: row.operator_id,
        ticketId: row.ticket_id,
        reason: row.reason,
        attestedAtSec: row.attested_at_sec,
        recordedAtSec: row.recorded_at_sec,
        source: row.source,
      };
    },
    async listManualAttestations({ customerId, seatId } = {}) {
      await ensureReady();
      const rows = await allRows(
        db,
        `SELECT customer_id, seat_id, operator_id, ticket_id, reason, attested_at_sec, recorded_at_sec, source
         FROM manual_attestations
         WHERE (?1 IS NULL OR customer_id = ?1)
           AND (?2 IS NULL OR seat_id = ?2)
         ORDER BY recorded_at_sec DESC, id DESC`,
        customerId ?? null,
        seatId ?? null
      );
      return rows.map((row) => ({
        customerId: row.customer_id,
        seatId: row.seat_id,
        operatorId: row.operator_id,
        ticketId: row.ticket_id,
        reason: row.reason,
        attestedAtSec: row.attested_at_sec,
        recordedAtSec: row.recorded_at_sec,
        source: row.source,
      }));
    },
    async savePolicySnapshot(workspaceId, snapshot) {
      await ensureReady();
      await runStmt(
        db,
        `INSERT INTO policy_snapshots (workspace_id, policy_id, snapshot_json, updated_at_sec)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(workspace_id)
         DO UPDATE SET
           policy_id = excluded.policy_id,
           snapshot_json = excluded.snapshot_json,
           updated_at_sec = excluded.updated_at_sec`,
        workspaceId,
        snapshot.policyId,
        JSON.stringify(snapshot),
        Math.floor(Date.now() / 1000)
      );
      return snapshot;
    },
    async getLatestPolicySnapshot(workspaceId) {
      await ensureReady();
      const row = await firstRow(
        db,
        `SELECT snapshot_json
         FROM policy_snapshots
         WHERE workspace_id = ?1
         LIMIT 1`,
        workspaceId
      );
      if (!row) return null;
      return JSON.parse(row.snapshot_json);
    },
    async saveProvider(provider) {
      await ensureReady();
      const nowSec = Math.floor(Date.now() / 1000);
      await runStmt(
        db,
        `INSERT INTO providers (provider_id, name, updated_at_sec)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(provider_id)
         DO UPDATE SET
           name = COALESCE(excluded.name, providers.name),
           updated_at_sec = excluded.updated_at_sec`,
        provider.providerId,
        provider.name ?? null,
        nowSec
      );
      const saved = await firstRow(
        db,
        `SELECT provider_id, name
         FROM providers
         WHERE provider_id = ?1
         LIMIT 1`,
        provider.providerId
      );
      return {
        providerId: saved.provider_id,
        name: saved.name ?? null,
      };
    },
    async listProviders() {
      await ensureReady();
      const rows = await allRows(
        db,
        `SELECT provider_id, name
         FROM providers
         ORDER BY provider_id`
      );
      return rows.map((row) => ({
        providerId: row.provider_id,
        name: row.name ?? null,
      }));
    },
    async saveCustomer(providerId, customer) {
      await ensureReady();
      const provider = await firstRow(
        db,
        `SELECT provider_id
         FROM providers
         WHERE provider_id = ?1
         LIMIT 1`,
        providerId
      );
      if (!provider) throw new Error("provider_not_found");

      const nowSec = Math.floor(Date.now() / 1000);
      await runStmt(
        db,
        `INSERT INTO customers (provider_id, customer_id, name, updated_at_sec)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(provider_id, customer_id)
         DO UPDATE SET
           name = COALESCE(excluded.name, customers.name),
           updated_at_sec = excluded.updated_at_sec`,
        providerId,
        customer.customerId,
        customer.name ?? null,
        nowSec
      );
      const saved = await firstRow(
        db,
        `SELECT provider_id, customer_id, name
         FROM customers
         WHERE provider_id = ?1 AND customer_id = ?2
         LIMIT 1`,
        providerId,
        customer.customerId
      );
      return {
        providerId: saved.provider_id,
        customerId: saved.customer_id,
        name: saved.name ?? null,
      };
    },
    async listCustomers(providerId) {
      await ensureReady();
      const rows = await allRows(
        db,
        `SELECT provider_id, customer_id, name
         FROM customers
         WHERE (?1 IS NULL OR provider_id = ?1)
         ORDER BY provider_id, customer_id`,
        providerId ?? null
      );
      return rows.map((row) => ({
        providerId: row.provider_id,
        customerId: row.customer_id,
        name: row.name ?? null,
      }));
    },
    async saveWorkspace(workspace) {
      await ensureReady();
      const provider = await firstRow(
        db,
        `SELECT provider_id
         FROM providers
         WHERE provider_id = ?1
         LIMIT 1`,
        workspace.providerId
      );
      if (!provider) throw new Error("provider_not_found");

      const customer = await firstRow(
        db,
        `SELECT customer_id
         FROM customers
         WHERE provider_id = ?1 AND customer_id = ?2
         LIMIT 1`,
        workspace.providerId,
        workspace.customerId
      );
      if (!customer) throw new Error("customer_not_found");

      const existing = await firstRow(
        db,
        `SELECT workspace_id, provider_id, customer_id, name, status
         FROM workspaces
         WHERE workspace_id = ?1
         LIMIT 1`,
        workspace.workspaceId
      );
      if (
        existing &&
        (existing.provider_id !== workspace.providerId ||
          existing.customer_id !== workspace.customerId)
      ) {
        throw new Error("workspace_identity_mismatch");
      }

      const nowSec = Math.floor(Date.now() / 1000);
      await runStmt(
        db,
        `INSERT INTO workspaces (
          workspace_id, provider_id, customer_id, name, status, updated_at_sec
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(workspace_id)
        DO UPDATE SET
          name = COALESCE(excluded.name, workspaces.name),
          status = excluded.status,
          updated_at_sec = excluded.updated_at_sec
        WHERE workspaces.provider_id = excluded.provider_id
          AND workspaces.customer_id = excluded.customer_id`,
        workspace.workspaceId,
        workspace.providerId,
        workspace.customerId,
        workspace.name ?? null,
        workspace.status ?? existing?.status ?? WORKSPACE_STATUS_ACTIVE,
        nowSec
      );
      const saved = await firstRow(
        db,
        `SELECT workspace_id, provider_id, customer_id, name, status
         FROM workspaces
         WHERE workspace_id = ?1
         LIMIT 1`,
        workspace.workspaceId
      );
      if (
        saved.provider_id !== workspace.providerId ||
        saved.customer_id !== workspace.customerId
      ) {
        throw new Error("workspace_identity_mismatch");
      }
      return {
        workspaceId: saved.workspace_id,
        providerId: saved.provider_id,
        customerId: saved.customer_id,
        name: saved.name ?? null,
        status: saved.status,
      };
    },
    async listWorkspaces({ providerId, customerId } = {}) {
      await ensureReady();
      const rows = await allRows(
        db,
        `SELECT workspace_id, provider_id, customer_id, name, status
         FROM workspaces
         WHERE (?1 IS NULL OR provider_id = ?1)
           AND (?2 IS NULL OR customer_id = ?2)
         ORDER BY workspace_id`,
        providerId ?? null,
        customerId ?? null
      );
      return rows.map((row) => ({
        workspaceId: row.workspace_id,
        providerId: row.provider_id,
        customerId: row.customer_id,
        name: row.name ?? null,
        status: row.status,
      }));
    },
    async appendMeterEvents(events) {
      await ensureReady();
      if (!Array.isArray(events) || events.length === 0) return;
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO accepted_usage_events (
          event_id,
          provider_id,
          customer_id,
          workspace_id,
          seat_id,
          skill_id,
          bundle_id,
          lease_id,
          lease_jti,
          policy_id,
          tool_name,
          event_kind,
          usage_unit,
          usage_delta,
          event_seq,
          event_hash,
          prev_hash,
          event_at_sec,
          event_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`
      );
      const batched = events.map((event) =>
        stmt.bind(
          event.eventId,
          event.providerId,
          event.customerId,
          event.workspaceId,
          normalizeSeatId(event.seatId),
          event.skillId ?? null,
          event.bundleId ?? null,
          event.leaseId ?? null,
          event.leaseJti ?? null,
          event.policyId ?? null,
          event.tool,
          event.eventKind,
          event.usage.unit,
          event.usage.delta,
          event.eventSeq,
          event.eventHash ?? null,
          event.prevHash,
          event.eventAtSec,
          JSON.stringify(event.rawEvent)
        )
      );
      await db.batch(batched);
    },
    async savePricingRule(rule) {
      await ensureReady();
      await runStmt(
        db,
        `INSERT INTO pricing_rules (
          pricing_rule_id, provider_id, customer_id, workspace_id, skill_id, bundle_id,
          tool_name, unit, currency, unit_amount_cents, included_units,
          minimum_amount_cents, status, payment_provider_json, updated_at_sec
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        ON CONFLICT(pricing_rule_id)
        DO UPDATE SET
          provider_id = excluded.provider_id,
          customer_id = excluded.customer_id,
          workspace_id = excluded.workspace_id,
          skill_id = excluded.skill_id,
          bundle_id = excluded.bundle_id,
          tool_name = excluded.tool_name,
          unit = excluded.unit,
          currency = excluded.currency,
          unit_amount_cents = excluded.unit_amount_cents,
          included_units = excluded.included_units,
          minimum_amount_cents = excluded.minimum_amount_cents,
          status = excluded.status,
          payment_provider_json = excluded.payment_provider_json,
          updated_at_sec = excluded.updated_at_sec`,
        rule.pricingRuleId,
        rule.providerId,
        rule.customerId ?? null,
        rule.workspaceId ?? null,
        rule.skillId ?? null,
        rule.bundleId ?? null,
        rule.tool ?? null,
        rule.unit,
        rule.currency,
        rule.unitAmountCents,
        rule.includedUnits,
        rule.minimumAmountCents,
        rule.status,
        rule.paymentProvider ? JSON.stringify(rule.paymentProvider) : null,
        Math.floor(Date.now() / 1000)
      );
      return rule;
    },
    async listPricingRules({ providerId, customerId, workspaceId } = {}) {
      await ensureReady();
      const rows = await allRows(
        db,
        `SELECT *
         FROM pricing_rules
         WHERE (?1 IS NULL OR provider_id = ?1)
           AND (?2 IS NULL OR customer_id IS NULL OR customer_id = ?2)
           AND (?3 IS NULL OR workspace_id IS NULL OR workspace_id = ?3)
         ORDER BY pricing_rule_id`,
        providerId ?? null,
        customerId ?? null,
        workspaceId ?? null
      );
      return rows.map(mapPricingRule);
    },
    async getAcceptedUsageEvents({
      providerId,
      customerId,
      workspaceId,
      periodStartSec,
      periodEndSec,
    } = {}) {
      await ensureReady();
      const rows = await allRows(
        db,
        `SELECT *
         FROM accepted_usage_events
         WHERE usage_unit = 'tool_call'
           AND (?1 IS NULL OR provider_id = ?1)
           AND (?2 IS NULL OR customer_id = ?2)
           AND (?3 IS NULL OR workspace_id = ?3)
           AND (?4 IS NULL OR event_at_sec >= ?4)
           AND (?5 IS NULL OR event_at_sec < ?5)
         ORDER BY event_at_sec, event_seq`,
        providerId ?? null,
        customerId ?? null,
        workspaceId ?? null,
        periodStartSec ?? null,
        periodEndSec ?? null
      );
      return rows.map(mapUsageEvent);
    },
    async saveInvoice(invoice) {
      await ensureReady();
      await runStmt(
        db,
        `INSERT INTO invoices (
          invoice_id, provider_id, customer_id, workspace_id, status, currency,
          period_start_sec, period_end_sec, subtotal_amount_cents,
          total_amount_cents, invoice_json, updated_at_sec
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(invoice_id)
        DO UPDATE SET
          provider_id = excluded.provider_id,
          customer_id = excluded.customer_id,
          workspace_id = excluded.workspace_id,
          status = excluded.status,
          currency = excluded.currency,
          period_start_sec = excluded.period_start_sec,
          period_end_sec = excluded.period_end_sec,
          subtotal_amount_cents = excluded.subtotal_amount_cents,
          total_amount_cents = excluded.total_amount_cents,
          invoice_json = excluded.invoice_json,
          updated_at_sec = excluded.updated_at_sec`,
        invoice.invoiceId,
        invoice.providerId,
        invoice.customerId,
        invoice.workspaceId ?? null,
        invoice.status,
        invoice.currency,
        invoice.periodStartSec,
        invoice.periodEndSec,
        invoice.subtotalAmountCents,
        invoice.totalAmountCents,
        JSON.stringify(invoice),
        Math.floor(Date.now() / 1000)
      );
      return invoice;
    },
    async getInvoice(invoiceId) {
      await ensureReady();
      const row = await firstRow(
        db,
        "SELECT invoice_json FROM invoices WHERE invoice_id = ?1 LIMIT 1",
        invoiceId
      );
      return row ? JSON.parse(row.invoice_json) : null;
    },
    async listInvoices({ providerId, customerId } = {}) {
      await ensureReady();
      const rows = await allRows(
        db,
        `SELECT invoice_json
         FROM invoices
         WHERE (?1 IS NULL OR provider_id = ?1)
           AND (?2 IS NULL OR customer_id = ?2)
         ORDER BY invoice_id`,
        providerId ?? null,
        customerId ?? null
      );
      return rows.map((row) => JSON.parse(row.invoice_json));
    },
    async savePaymentHandoff(handoff) {
      await ensureReady();
      await runStmt(
        db,
        `INSERT INTO payment_handoffs (
          invoice_id, provider, status, checkout_url, external_id, handoff_json, updated_at_sec
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(invoice_id)
        DO UPDATE SET
          provider = excluded.provider,
          status = excluded.status,
          checkout_url = excluded.checkout_url,
          external_id = excluded.external_id,
          handoff_json = excluded.handoff_json,
          updated_at_sec = excluded.updated_at_sec`,
        handoff.invoiceId,
        handoff.provider,
        handoff.status,
        handoff.checkoutUrl ?? null,
        handoff.externalId ?? null,
        JSON.stringify(handoff),
        Math.floor(Date.now() / 1000)
      );
      return handoff;
    },
    async getUsageSummary({
      providerId,
      customerId,
      workspaceId,
      seatId,
      skillId,
      bundleId,
    } = {}) {
      await ensureReady();
      const rows = await allRows(
        db,
        `SELECT
           provider_id,
           customer_id,
           workspace_id,
           seat_id,
           skill_id,
           bundle_id,
           lease_jti,
           tool_name,
           usage_unit,
           SUM(usage_delta) AS total_calls
         FROM accepted_usage_events
         WHERE usage_unit = 'tool_call'
           AND (?1 IS NULL OR provider_id = ?1)
           AND (?2 IS NULL OR customer_id = ?2)
           AND (?3 IS NULL OR workspace_id = ?3)
           AND (?4 IS NULL OR seat_id = ?4)
           AND (?5 IS NULL OR skill_id = ?5)
           AND (?6 IS NULL OR bundle_id = ?6)
         GROUP BY
           provider_id,
           customer_id,
           workspace_id,
           seat_id,
           skill_id,
           bundle_id,
           lease_jti,
           tool_name,
           usage_unit
         ORDER BY
           provider_id,
           customer_id,
           workspace_id,
           seat_id,
           skill_id,
           bundle_id,
           lease_jti,
           tool_name`,
        // ?1=providerId ?2=customerId ?3=workspaceId ?4=seatId ?5=skillId ?6=bundleId
        providerId ?? null,
        customerId ?? null,
        workspaceId ?? null,
        seatId ?? null,
        skillId ?? null,
        bundleId ?? null
      );
      return rows.map((row) => ({
        providerId: row.provider_id,
        customerId: row.customer_id,
        workspaceId: row.workspace_id,
        seatId: row.seat_id,
        skillId: row.skill_id ?? null,
        bundleId: row.bundle_id ?? null,
        leaseJti: row.lease_jti ?? null,
        tool: row.tool_name,
        unit: USAGE_UNIT_TOOL_CALL,
        totalCalls: Number(row.total_calls ?? 0),
      }));
    },
  };
}
