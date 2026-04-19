import { expect, test } from "bun:test";

import {
  createManualTimeAttestationContract,
  createTsaMonitor,
} from "../src/index.js";

test("tsa monitor emits warning hook near expiry", () => {
  const warnings = [];
  const monitor = createTsaMonitor({
    onWarning: (warning) => warnings.push(warning),
  });
  const now = 1_800_000_000;
  const state = monitor.evaluate({
    lastTsaTokenAtSec: now - (7 * 24 * 60 * 60 - 30),
    nowSec: now,
  });

  expect(state.status).toBe("warning");
  expect(warnings.length).toBe(1);
  expect(warnings[0].code).toBe("tsa_token_expiring_soon");
});

test("manual time-attestation contract validates and creates record", () => {
  const contract = createManualTimeAttestationContract({
    nowSec: () => 1_800_000_123,
  });
  const record = contract.createRecord({
    operatorId: "ops-user",
    ticketId: "INC-999",
    reason: "TSA upstream outage for air-gapped incident response",
    attestedAtSec: 1_800_000_000,
  });

  expect(record.recordedAtSec).toBe(1_800_000_123);
  expect(record.source).toBe("manual-time-attestation");
});
