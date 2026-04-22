import { expect, test } from "bun:test";

import { createSqliteLeaseStore } from "../src/storage-sqlite.js";

function makeStore() {
  return createSqliteLeaseStore({ dbPath: ":memory:" });
}

function seedAttestations(store) {
  store.addManualAttestation({
    customerId: "cust-a",
    seatId: "seat-1",
    operatorId: "op-1",
    ticketId: "INC-1",
    reason: "reason-a1",
    attestedAtSec: 1_000,
    recordedAtSec: 1_001,
    source: "manual",
  });
  store.addManualAttestation({
    customerId: "cust-a",
    seatId: "seat-2",
    operatorId: "op-1",
    ticketId: "INC-2",
    reason: "reason-a2",
    attestedAtSec: 2_000,
    recordedAtSec: 2_001,
    source: "manual",
  });
  store.addManualAttestation({
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

test("sqlite listManualAttestations: returns all when no filters", () => {
  const store = makeStore();
  seedAttestations(store);
  const all = store.listManualAttestations();
  expect(all.length).toBe(3);
});

test("sqlite listManualAttestations: filters by customerId", () => {
  const store = makeStore();
  seedAttestations(store);
  const rows = store.listManualAttestations({ customerId: "cust-a" });
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.customerId === "cust-a")).toBe(true);
});

test("sqlite listManualAttestations: filters by seatId", () => {
  const store = makeStore();
  seedAttestations(store);
  const rows = store.listManualAttestations({ seatId: "seat-1" });
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.seatId === "seat-1")).toBe(true);
});

test("sqlite listManualAttestations: filters by customerId + seatId (AND)", () => {
  const store = makeStore();
  seedAttestations(store);
  const rows = store.listManualAttestations({ customerId: "cust-a", seatId: "seat-1" });
  expect(rows.length).toBe(1);
  expect(rows[0].ticketId).toBe("INC-1");
});

test("sqlite listManualAttestations: returns empty for no-match", () => {
  const store = makeStore();
  seedAttestations(store);
  const rows = store.listManualAttestations({ customerId: "cust-z" });
  expect(rows.length).toBe(0);
});

test("sqlite listManualAttestations: undefined filter treated as no-filter", () => {
  const store = makeStore();
  seedAttestations(store);
  const rows = store.listManualAttestations({ customerId: undefined, seatId: undefined });
  expect(rows.length).toBe(3);
});

test("sqlite listManualAttestations: empty store returns empty array", () => {
  const store = makeStore();
  expect(store.listManualAttestations()).toEqual([]);
});

test("sqlite listManualAttestations: result shape is correct", () => {
  const store = makeStore();
  store.addManualAttestation({
    customerId: "cust-x",
    seatId: "seat-x",
    operatorId: "op-x",
    ticketId: "INC-X",
    reason: "reason-x",
    attestedAtSec: 5_000,
    recordedAtSec: 5_001,
    source: "manual",
  });
  const [row] = store.listManualAttestations({ customerId: "cust-x" });
  expect(row).toMatchObject({
    customerId: "cust-x",
    seatId: "seat-x",
    operatorId: "op-x",
    ticketId: "INC-X",
    reason: "reason-x",
    attestedAtSec: 5_000,
    recordedAtSec: 5_001,
    source: "manual",
  });
});
