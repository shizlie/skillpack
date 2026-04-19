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
    close() {
      db.close(false);
    },
  };
}
