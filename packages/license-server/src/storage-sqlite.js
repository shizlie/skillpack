import { Database } from "bun:sqlite";
import { USAGE_UNIT_TOOL_CALL, WORKSPACE_STATUS_ACTIVE } from "@skillpack/protocol";

function normalizeSeatId(seatId) {
  return seatId ?? "default";
}

export function createSqliteLeaseStore({ dbPath = ":memory:" } = {}) {
  const db = new Database(dbPath, { create: true });
  db.exec(`
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
      -- NULL != NULL in SQLite UNIQUE, so this guard only fires when lease_jti is present.
      -- When lease_jti IS NULL, dedup relies on the event_id PRIMARY KEY instead.
      UNIQUE (workspace_id, seat_id, lease_jti, event_seq)
    );
  `);

  const selectCounter = db.query(
    "SELECT lease_counter FROM lease_counters WHERE customer_id = ?1 AND seat_id = ?2"
  );
  const upsertCounter = db.query(
    `
      INSERT INTO lease_counters (customer_id, seat_id, lease_counter)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(customer_id, seat_id)
      DO UPDATE SET lease_counter = excluded.lease_counter
    `
  );
  const insertAttestation = db.query(
    `
      INSERT INTO manual_attestations (
        customer_id, seat_id, operator_id, ticket_id, reason, attested_at_sec, recorded_at_sec, source
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `
  );
  const selectLatestAttestation = db.query(
    `
      SELECT customer_id, seat_id, operator_id, ticket_id, reason, attested_at_sec, recorded_at_sec, source
      FROM manual_attestations
      WHERE customer_id = ?1 AND seat_id = ?2
      ORDER BY recorded_at_sec DESC, id DESC
      LIMIT 1
    `
  );
  const selectAllAttestations = db.query(
    `
      SELECT customer_id, seat_id, operator_id, ticket_id, reason, attested_at_sec, recorded_at_sec, source
      FROM manual_attestations
      WHERE (?1 IS NULL OR customer_id = ?1)
        AND (?2 IS NULL OR seat_id = ?2)
      ORDER BY recorded_at_sec DESC, id DESC
    `
  );
  const upsertPolicySnapshot = db.query(
    `
      INSERT INTO policy_snapshots (workspace_id, policy_id, snapshot_json, updated_at_sec)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(workspace_id)
      DO UPDATE SET
        policy_id = excluded.policy_id,
        snapshot_json = excluded.snapshot_json,
        updated_at_sec = excluded.updated_at_sec
    `
  );
  const selectLatestPolicySnapshot = db.query(
    `
      SELECT snapshot_json
      FROM policy_snapshots
      WHERE workspace_id = ?1
      LIMIT 1
    `
  );
  const selectProvider = db.query(
    `
      SELECT provider_id, name
      FROM providers
      WHERE provider_id = ?1
      LIMIT 1
    `
  );
  const selectProviders = db.query(
    `
      SELECT provider_id, name
      FROM providers
      ORDER BY provider_id
    `
  );
  const upsertProvider = db.query(
    `
      INSERT INTO providers (provider_id, name, updated_at_sec)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(provider_id)
      DO UPDATE SET
        name = COALESCE(excluded.name, providers.name),
        updated_at_sec = excluded.updated_at_sec
    `
  );
  const selectCustomer = db.query(
    `
      SELECT provider_id, customer_id, name
      FROM customers
      WHERE provider_id = ?1 AND customer_id = ?2
      LIMIT 1
    `
  );
  const selectCustomers = db.query(
    `
      SELECT provider_id, customer_id, name
      FROM customers
      WHERE (?1 IS NULL OR provider_id = ?1)
      ORDER BY provider_id, customer_id
    `
  );
  const upsertCustomer = db.query(
    `
      INSERT INTO customers (provider_id, customer_id, name, updated_at_sec)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(provider_id, customer_id)
      DO UPDATE SET
        name = COALESCE(excluded.name, customers.name),
        updated_at_sec = excluded.updated_at_sec
    `
  );
  const selectWorkspace = db.query(
    `
      SELECT workspace_id, provider_id, customer_id, name, status
      FROM workspaces
      WHERE workspace_id = ?1
      LIMIT 1
    `
  );
  const selectWorkspaces = db.query(
    `
      SELECT workspace_id, provider_id, customer_id, name, status
      FROM workspaces
      WHERE (?1 IS NULL OR provider_id = ?1)
        AND (?2 IS NULL OR customer_id = ?2)
      ORDER BY workspace_id
    `
  );
  const upsertWorkspace = db.query(
    `
      INSERT INTO workspaces (
        workspace_id, provider_id, customer_id, name, status, updated_at_sec
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(workspace_id)
      DO UPDATE SET
        name = COALESCE(excluded.name, workspaces.name),
        status = excluded.status,
        updated_at_sec = excluded.updated_at_sec
    `
  );
  const insertUsageEvent = db.query(
    `
      INSERT OR IGNORE INTO accepted_usage_events (
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
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
    `
  );
  const selectUsageSummary = db.query(
    `
      SELECT
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
        tool_name
    `
  );

  return {
    getLatestLeaseCounter(customerId, seatId) {
      const row = selectCounter.get(customerId, normalizeSeatId(seatId));
      return row?.lease_counter;
    },
    updateLatestLeaseCounter(customerId, seatId, leaseCounter) {
      upsertCounter.run(customerId, normalizeSeatId(seatId), leaseCounter);
    },
    addManualAttestation(record) {
      insertAttestation.run(
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
    getLatestManualAttestation(customerId, seatId = "default") {
      const row = selectLatestAttestation.get(customerId, normalizeSeatId(seatId));
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
    listManualAttestations({ customerId, seatId } = {}) {
      return selectAllAttestations.all(customerId ?? null, seatId ?? null).map((row) => ({
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
    savePolicySnapshot(workspaceId, snapshot) {
      upsertPolicySnapshot.run(
        workspaceId,
        snapshot.policyId,
        JSON.stringify(snapshot),
        Math.floor(Date.now() / 1000)
      );
      return snapshot;
    },
    getLatestPolicySnapshot(workspaceId) {
      const row = selectLatestPolicySnapshot.get(workspaceId);
      if (!row) return null;
      return JSON.parse(row.snapshot_json);
    },
    saveProvider(provider) {
      const nowSec = Math.floor(Date.now() / 1000);
      upsertProvider.run(provider.providerId, provider.name ?? null, nowSec);
      const saved = selectProvider.get(provider.providerId);
      return {
        providerId: saved.provider_id,
        name: saved.name ?? null,
      };
    },
    listProviders() {
      return selectProviders.all().map((row) => ({
        providerId: row.provider_id,
        name: row.name ?? null,
      }));
    },
    saveCustomer(providerId, customer) {
      const provider = selectProvider.get(providerId);
      if (!provider) throw new Error("provider_not_found");
      const nowSec = Math.floor(Date.now() / 1000);
      upsertCustomer.run(providerId, customer.customerId, customer.name ?? null, nowSec);
      const saved = selectCustomer.get(providerId, customer.customerId);
      return {
        providerId: saved.provider_id,
        customerId: saved.customer_id,
        name: saved.name ?? null,
      };
    },
    listCustomers(providerId) {
      return selectCustomers.all(providerId ?? null).map((row) => ({
        providerId: row.provider_id,
        customerId: row.customer_id,
        name: row.name ?? null,
      }));
    },
    saveWorkspace(workspace) {
      const provider = selectProvider.get(workspace.providerId);
      if (!provider) throw new Error("provider_not_found");
      const customer = selectCustomer.get(workspace.providerId, workspace.customerId);
      if (!customer) throw new Error("customer_not_found");

      const existing = selectWorkspace.get(workspace.workspaceId);
      if (
        existing &&
        (existing.provider_id !== workspace.providerId ||
          existing.customer_id !== workspace.customerId)
      ) {
        throw new Error("workspace_identity_mismatch");
      }

      const nowSec = Math.floor(Date.now() / 1000);
      upsertWorkspace.run(
        workspace.workspaceId,
        workspace.providerId,
        workspace.customerId,
        workspace.name ?? null,
        workspace.status ?? existing?.status ?? WORKSPACE_STATUS_ACTIVE,
        nowSec
      );
      const saved = selectWorkspace.get(workspace.workspaceId);
      return {
        workspaceId: saved.workspace_id,
        providerId: saved.provider_id,
        customerId: saved.customer_id,
        name: saved.name ?? null,
        status: saved.status,
      };
    },
    listWorkspaces({ providerId, customerId } = {}) {
      return selectWorkspaces.all(providerId ?? null, customerId ?? null).map((row) => ({
        workspaceId: row.workspace_id,
        providerId: row.provider_id,
        customerId: row.customer_id,
        name: row.name ?? null,
        status: row.status,
      }));
    },
    appendMeterEvents: db.transaction((events) => {
      for (const event of events) {
        insertUsageEvent.run(
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
        );
      }
    }),
    getUsageSummary({
      providerId,
      customerId,
      workspaceId,
      seatId,
      skillId,
      bundleId,
    } = {}) {
      return selectUsageSummary
        .all(
          providerId ?? null,
          customerId ?? null,
          workspaceId ?? null,
          seatId ?? null,
          skillId ?? null,
          bundleId ?? null
        )
        .map((row) => ({
          providerId: row.provider_id,
          customerId: row.customer_id,
          workspaceId: row.workspace_id,
          seatId: row.seat_id,
          skillId: row.skill_id ?? null,
          bundleId: row.bundle_id ?? null,
          leaseJti: row.lease_jti ?? null,
          tool: row.tool_name,
          unit: USAGE_UNIT_TOOL_CALL,
          totalCalls: row.total_calls,
        }));
    },
    close() {
      db.close(false);
    },
  };
}
