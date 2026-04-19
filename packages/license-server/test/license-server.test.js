import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateEd25519KeyPair } from "@skillpack/crypto";
import { createLicenseFetchHandler, createSqliteLeaseStore } from "../src/index.js";

test("issue + verify lease roundtrip works", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
  });

  const issueRes = await fetch(
    new Request("http://local/v1/leases/issue", {
      method: "POST",
      body: JSON.stringify({
        customerId: "cust-1",
        vendorId: "vendor-1",
        ttlSec: 3600,
        nowSec: 1_800_000_000,
      }),
    })
  );
  expect(issueRes.status).toBe(200);
  const issueBody = await issueRes.json();
  expect(typeof issueBody.leaseToken).toBe("string");
  expect(issueBody.payload.leaseCounter).toBe(0);

  const verifyRes = await fetch(
    new Request("http://local/v1/leases/verify", {
      method: "POST",
      body: JSON.stringify({
        leaseToken: issueBody.leaseToken,
        nowSec: 1_800_000_100,
      }),
    })
  );
  expect(verifyRes.status).toBe(200);
  const verifyBody = await verifyRes.json();
  expect(verifyBody.valid).toBe(true);
  expect(verifyBody.payload.sub).toBe("cust-1");
});

test("verify rejects lease counter rewind", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
  });

  const issue1 = await fetch(
    new Request("http://local/v1/leases/issue", {
      method: "POST",
      body: JSON.stringify({ customerId: "cust-2", nowSec: 1_800_000_000 }),
    })
  );
  const first = await issue1.json();

  const issue2 = await fetch(
    new Request("http://local/v1/leases/issue", {
      method: "POST",
      body: JSON.stringify({ customerId: "cust-2", nowSec: 1_800_000_100 }),
    })
  );
  const second = await issue2.json();
  expect(second.payload.leaseCounter).toBe(1);

  const verifyOlder = await fetch(
    new Request("http://local/v1/leases/verify", {
      method: "POST",
      body: JSON.stringify({
        leaseToken: first.leaseToken,
        nowSec: 1_800_000_200,
      }),
    })
  );
  expect(verifyOlder.status).toBe(400);
  const verifyBody = await verifyOlder.json();
  expect(verifyBody.error).toContain("lease_counter_rewind_detected");
});

test("manual TSA attestation endpoint accepts contract payload", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
  });

  const res = await fetch(
    new Request("http://local/v1/tsa/manual-attest", {
      method: "POST",
      body: JSON.stringify({
        customerId: "cust-2",
        seatId: "seat-a",
        operatorId: "ops",
        ticketId: "INC-42",
        reason: "TSA outage incident response for offline customer",
        attestedAtSec: 1_800_000_000,
      }),
    })
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.accepted).toBe(true);
  expect(body.record.source).toBe("manual-time-attestation");
  expect(body.record.customerId).toBe("cust-2");
  expect(body.record.seatId).toBe("seat-a");
});

test("lease issue exposes TSA warning state when token is near expiry", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
  });
  const now = 1_800_000_000;
  const res = await fetch(
    new Request("http://local/v1/leases/issue", {
      method: "POST",
      body: JSON.stringify({
        customerId: "cust-3",
        nowSec: now,
        lastTsaTokenAtSec: now - (7 * 24 * 60 * 60 - 60),
      }),
    })
  );
  const body = await res.json();
  expect(body.tsaState.status).toBe("warning");
});

test("manual TSA attestation latest endpoint returns most recent per customer+seat", async () => {
  const keys = generateEd25519KeyPair();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-license-server-"));
  const dbPath = path.join(dir, "lease-store.sqlite");
  const leaseStore = createSqliteLeaseStore({ dbPath });
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    leaseStore,
  });

  const first = await fetch(
    new Request("http://local/v1/tsa/manual-attest", {
      method: "POST",
      body: JSON.stringify({
        customerId: "cust-4",
        seatId: "seat-1",
        operatorId: "op-1",
        ticketId: "INC-1",
        reason: "TSA outage handled for first escalation path",
        attestedAtSec: 1_800_000_010,
      }),
    })
  );
  expect(first.status).toBe(200);

  const second = await fetch(
    new Request("http://local/v1/tsa/manual-attest", {
      method: "POST",
      body: JSON.stringify({
        customerId: "cust-4",
        seatId: "seat-1",
        operatorId: "op-2",
        ticketId: "INC-2",
        reason: "TSA outage follow-up attestation after operator handoff",
        attestedAtSec: 1_800_000_020,
      }),
    })
  );
  expect(second.status).toBe(200);

  const latest = await fetch(
    new Request(
      "http://local/v1/tsa/manual-attestations/latest?customerId=cust-4&seatId=seat-1",
      { method: "GET" }
    )
  );
  expect(latest.status).toBe(200);
  const latestBody = await latest.json();
  expect(latestBody.accepted).toBe(true);
  expect(latestBody.record.ticketId).toBe("INC-2");
});
