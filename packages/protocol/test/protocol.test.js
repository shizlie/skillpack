import { expect, test } from "bun:test";

import {
  assertMonotonicLeaseCounter,
  evaluateTsaTokenFreshness,
  validateLeasePayload,
  validateManualTimeAttestation,
  validateMeterEvent,
} from "../src/index.js";

test("validateLeasePayload accepts valid payload", () => {
  expect(() =>
    validateLeasePayload({
      iss: "vendor-1",
      sub: "customer-1",
      iat: 1_800_000_000,
      exp: 1_800_000_100,
      jti: "lease-1",
      leaseCounter: 1,
    })
  ).not.toThrow();
});

test("validateMeterEvent rejects invalid sequence", () => {
  expect(() =>
    validateMeterEvent({
      prevHash: "GENESIS",
      seq: -1,
      at: 1_800_000_000,
      kind: "invoke",
      data: {},
    })
  ).toThrow(/meter_event_invalid_seq/);
});

test("assertMonotonicLeaseCounter enforces strict increase", () => {
  expect(() => assertMonotonicLeaseCounter(3, 3)).toThrow(
    /lease_counter_not_monotonic/
  );
  expect(() => assertMonotonicLeaseCounter(3, 4)).not.toThrow();
});

test("validateManualTimeAttestation enforces required fields", () => {
  expect(() =>
    validateManualTimeAttestation({
      operatorId: "alice",
      ticketId: "INC-123",
      reason: "TSA outage response procedure",
      attestedAtSec: 1_800_000_000,
    })
  ).not.toThrow();
});

test("evaluateTsaTokenFreshness returns warning and expired states", () => {
  const now = 1_800_000_000;
  const warning = evaluateTsaTokenFreshness(now - (7 * 24 * 60 * 60 - 60), now);
  expect(warning.status).toBe("warning");

  const expired = evaluateTsaTokenFreshness(now - (7 * 24 * 60 * 60 + 1), now);
  expect(expired.status).toBe("expired");
});
