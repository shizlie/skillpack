import { expect, test } from "bun:test";

import { createSqliteLeaseStore } from "../src/storage-sqlite.js";

function makeStore() {
  return createSqliteLeaseStore({ dbPath: ":memory:" });
}

async function seedAttestations(store) {
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

test("sqlite listManualAttestations: returns all when no filters", async () => {
  const store = makeStore();
  await seedAttestations(store);
  const all = await store.listManualAttestations();
  expect(all.length).toBe(3);
});

test("sqlite listManualAttestations: filters by customerId", async () => {
  const store = makeStore();
  await seedAttestations(store);
  const rows = await store.listManualAttestations({ customerId: "cust-a" });
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.customerId === "cust-a")).toBe(true);
});

test("sqlite listManualAttestations: filters by seatId", async () => {
  const store = makeStore();
  await seedAttestations(store);
  const rows = await store.listManualAttestations({ seatId: "seat-1" });
  expect(rows.length).toBe(2);
  expect(rows.every((r) => r.seatId === "seat-1")).toBe(true);
});

test("sqlite listManualAttestations: filters by customerId + seatId (AND)", async () => {
  const store = makeStore();
  await seedAttestations(store);
  const rows = await store.listManualAttestations({ customerId: "cust-a", seatId: "seat-1" });
  expect(rows.length).toBe(1);
  expect(rows[0].ticketId).toBe("INC-1");
});

test("sqlite listManualAttestations: returns empty for no-match", async () => {
  const store = makeStore();
  await seedAttestations(store);
  const rows = await store.listManualAttestations({ customerId: "cust-z" });
  expect(rows.length).toBe(0);
});

test("sqlite listManualAttestations: undefined filter treated as no-filter", async () => {
  const store = makeStore();
  await seedAttestations(store);
  const rows = await store.listManualAttestations({ customerId: undefined, seatId: undefined });
  expect(rows.length).toBe(3);
});

test("sqlite listManualAttestations: empty store returns empty array", async () => {
  const store = makeStore();
  expect(await store.listManualAttestations()).toEqual([]);
});

test("sqlite listManualAttestations: result shape is correct", async () => {
  const store = makeStore();
  await store.addManualAttestation({
    customerId: "cust-x",
    seatId: "seat-x",
    operatorId: "op-x",
    ticketId: "INC-X",
    reason: "reason-x",
    attestedAtSec: 5_000,
    recordedAtSec: 5_001,
    source: "manual",
  });
  const [row] = await store.listManualAttestations({ customerId: "cust-x" });
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

test("sqlite getLatestManualAttestation: can scope by ticketId", async () => {
  const store = makeStore();
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

test("sqlite saveWorkspace: rejects identity mismatch on existing workspace", async () => {
  const store = makeStore();
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
});
