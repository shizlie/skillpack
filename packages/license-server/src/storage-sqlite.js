import { Database } from "bun:sqlite";

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

    CREATE TABLE IF NOT EXISTS meter_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      seat_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      unit TEXT NOT NULL,
      delta REAL NOT NULL,
      seq INTEGER,
      at_sec INTEGER NOT NULL,
      event_json TEXT NOT NULL
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
  const insertMeterEvent = db.query(
    `
      INSERT INTO meter_events (
        workspace_id, seat_id, tool, unit, delta, seq, at_sec, event_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `
  );
  const selectUsageSummary = db.query(
    `
      SELECT workspace_id, seat_id, tool, SUM(delta) AS total_calls
      FROM meter_events
      WHERE unit = 'tool_call' AND (?1 IS NULL OR workspace_id = ?1)
      GROUP BY workspace_id, seat_id, tool
      ORDER BY workspace_id, seat_id, tool
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
    listManualAttestations() {
      return selectAllAttestations.all().map((row) => ({
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
    appendMeterEvents(workspaceId, events) {
      for (const event of events) {
        const unit = event.usage?.unit ?? event.unit;
        const delta = event.usage?.delta ?? event.delta ?? 1;
        insertMeterEvent.run(
          workspaceId,
          normalizeSeatId(event.seatId),
          event.tool ?? "unknown",
          unit ?? "unknown",
          delta,
          Number.isInteger(event.seq) ? event.seq : null,
          Number.isInteger(event.at) ? event.at : 0,
          JSON.stringify(event)
        );
      }
    },
    getUsageSummary({ workspaceId } = {}) {
      return selectUsageSummary.all(workspaceId ?? null).map((row) => ({
        workspaceId: row.workspace_id,
        seatId: row.seat_id,
        tool: row.tool,
        unit: "tool_call",
        totalCalls: row.total_calls,
      }));
    },
    close() {
      db.close(false);
    },
  };
}
