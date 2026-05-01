import { expect, test } from "bun:test";

import {
  createLeaseToken,
  createMeterChainKey,
  generateEd25519KeyPair,
  verifyMeterChain,
} from "@skillpack/crypto";
import {
  buildTsaPolicyFromLeaseResponse,
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

test("runtime TSA policy: expired token requires manual attestation", () => {
  const keys = generateEd25519KeyPair();
  const lease = buildLease(keys.privateKeyPem, 1_800_000_500);
  expect(() =>
    verifyLeaseForRuntime({
      leaseToken: lease,
      publicKeyPem: keys.publicKeyPem,
      nowSec: 1_800_000_550,
      tsaPolicy: {
        lastTsaTokenAtSec: 1_800_000_550 - 8 * 24 * 60 * 60,
      },
    })
  ).toThrow(/runtime_tsa_expired_manual_attestation_required/);
});

test("runtime TSA policy: accepts fresh manual attestation for expired token", () => {
  const keys = generateEd25519KeyPair();
  const nowSec = 1_800_000_550;
  const lastTsaTokenAtSec = nowSec - 8 * 24 * 60 * 60;
  const lease = buildLease(keys.privateKeyPem, 1_800_000_500);
  const out = verifyLeaseForRuntime({
    leaseToken: lease,
    publicKeyPem: keys.publicKeyPem,
    nowSec,
    tsaPolicy: {
      lastTsaTokenAtSec,
      manualAttestation: {
        operatorId: "op-1",
        ticketId: "INC-99",
        reason: "Validated trusted wall-clock during upstream TSA outage",
        attestedAtSec: nowSec - 300,
        recordedAtSec: nowSec - 280,
      },
      maxManualAttestationAgeSec: 3600,
    },
  });
  expect(out.mode).toBe("grace");
  expect(out.tsa.status).toBe("expired");
  expect(out.tsa.manualAttestationUsed).toBe(true);
});

test("buildTsaPolicyFromLeaseResponse hydrates manual attestation with 4h default", () => {
  const attestation = {
    operatorId: "op-1",
    ticketId: "INC-1",
    reason: "Validated trusted wall-clock during upstream TSA outage",
    attestedAtSec: 1_800_000_000,
    recordedAtSec: 1_800_000_001,
    source: "manual-time-attestation",
  };
  const policy = buildTsaPolicyFromLeaseResponse({
    tsaState: {
      status: "expired",
      ageSec: 700_000,
      expiresInSec: -95_200,
      lastTsaTokenAtSec: 1_799_300_000,
      latestManualAttestation: attestation,
    },
  });
  expect(policy).toEqual({
    lastTsaTokenAtSec: 1_799_300_000,
    manualAttestation: attestation,
    maxManualAttestationAgeSec: 4 * 60 * 60,
  });
  expect(buildTsaPolicyFromLeaseResponse({ tsaState: null })).toBeNull();
});

test("direct upload transport uses node built-ins and leaves spool intact on failure", async () => {
  const { createDirectUploadTransport } = await import(
    "../src/direct-upload-transport.mjs"
  );
  const transport = createDirectUploadTransport({
    baseUrl: "http://127.0.0.1:9",
    timeoutMs: 100,
  });

  await expect(
    transport.upload({
      leaseToken: "lease-token",
      context: { workspaceId: "ws-1" },
      events: [],
    })
  ).rejects.toThrow();
});
