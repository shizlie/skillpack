import { expect, test } from "bun:test";

import {
  createLeaseToken,
  createMeterChainKey,
  generateEd25519KeyPair,
  verifyMeterChain,
} from "@skillpack/crypto";
import {
  createRuntimeMeter,
  executeWithRuntimeLease,
  verifyLeaseForRuntime,
} from "../src/index.js";

function buildLease(privateKeyPem, exp) {
  return createLeaseToken(
    {
      iss: "vendor-1",
      sub: "customer-1",
      iat: 1_800_000_000,
      exp,
      jti: `lease-${exp}`,
      leaseCounter: 1,
    },
    privateKeyPem
  );
}

test("runtime lease: active and grace modes are accepted", () => {
  const keys = generateEd25519KeyPair();
  const lease = buildLease(keys.privateKeyPem, 1_800_000_100);

  const active = verifyLeaseForRuntime({
    leaseToken: lease,
    publicKeyPem: keys.publicKeyPem,
    nowSec: 1_800_000_050,
  });
  expect(active.mode).toBe("active");

  const grace = verifyLeaseForRuntime({
    leaseToken: lease,
    publicKeyPem: keys.publicKeyPem,
    nowSec: 1_800_000_200,
    graceSec: 200,
  });
  expect(grace.mode).toBe("grace");
});

test("runtime lease: past grace is rejected", () => {
  const keys = generateEd25519KeyPair();
  const lease = buildLease(keys.privateKeyPem, 1_800_000_100);
  expect(() =>
    verifyLeaseForRuntime({
      leaseToken: lease,
      publicKeyPem: keys.publicKeyPem,
      nowSec: 1_800_000_500,
      graceSec: 100,
    })
  ).toThrow(/runtime_lease_expired_past_grace/);
});

test("executeWithRuntimeLease emits meter events and runs action", async () => {
  const keys = generateEd25519KeyPair();
  const chainKey = createMeterChainKey();
  const meter = createRuntimeMeter({ chainKey });
  const lease = buildLease(keys.privateKeyPem, 1_800_000_100);

  const out = await executeWithRuntimeLease({
    leaseToken: lease,
    publicKeyPem: keys.publicKeyPem,
    nowSec: 1_800_000_050,
    meter,
    run: async () => ({ ok: true }),
  });
  expect(out.mode).toBe("active");
  expect(out.result.ok).toBe(true);
  const events = meter.getEvents();
  expect(events.length).toBe(2);
  expect(events[0].kind).toBe("runtime_start");
  expect(events[1].kind).toBe("runtime_success");
  expect(verifyMeterChain(events, chainKey)).toBe(true);
});
