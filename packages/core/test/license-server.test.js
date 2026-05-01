import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateEd25519KeyPair } from "@skillpack/crypto";
import { createInMemoryLeaseStore, createLicenseFetchHandler } from "../src/index.js";
import { createSqliteLeaseStore } from "../src/storage-sqlite.js";

test("issue + verify lease roundtrip works", async () => {
  const keys = generateEd25519KeyPair();
  const mgmtKey = "test-issue-verify-key";
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: mgmtKey,
  });

  const issueRes = await fetch(
    new Request("http://local/v1/leases/issue", {
      method: "POST",
      headers: { "x-api-key": mgmtKey },
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
  const mgmtKey = "test-rewind-key";
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: mgmtKey,
  });

  const issue1 = await fetch(
    new Request("http://local/v1/leases/issue", {
      method: "POST",
      headers: { "x-api-key": mgmtKey },
      body: JSON.stringify({ customerId: "cust-2", nowSec: 1_800_000_000 }),
    })
  );
  const first = await issue1.json();

  const issue2 = await fetch(
    new Request("http://local/v1/leases/issue", {
      method: "POST",
      headers: { "x-api-key": mgmtKey },
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
  const mgmtKey = "test-tsa-key";
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: mgmtKey,
  });

  const res = await fetch(
    new Request("http://local/v1/tsa/manual-attest", {
      method: "POST",
      headers: { "x-api-key": mgmtKey },
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

test("management routes can use a custom authenticator instead of x-api-key", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementAuthenticator: async (request) =>
      request.headers.get("authorization") === "Bearer clerk-session",
  });

  const unauthorized = await fetch(
    new Request("http://local/v1/providers", {
      method: "GET",
      headers: { authorization: "Bearer wrong" },
    })
  );
  expect(unauthorized.status).toBe(401);
  expect(await unauthorized.json()).toEqual({ error: "unauthorized" });

  const authorized = await fetch(
    new Request("http://local/v1/providers", {
      method: "GET",
      headers: { authorization: "Bearer clerk-session" },
    })
  );
  expect(authorized.status).toBe(200);
  expect(await authorized.json()).toEqual({ providers: [] });
});

test("management meter upload can use a custom authenticator", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementAuthenticator: async (request) =>
      request.headers.get("authorization") === "Bearer clerk-session",
  });

  const res = await fetch(
    new Request("http://local/v1/meter/upload", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer clerk-session",
      },
      body: JSON.stringify({
        workspaceId: "ws-1",
        context: {
          providerId: "prov-1",
          customerId: "cust-1",
          workspaceId: "ws-1",
        },
        events: [
          {
            prevHash: "GENESIS",
            seq: 0,
            at: 1_800_000_100,
            kind: "tool_call",
            seatId: "seat-1",
            tool: "wiki_search",
            usage: { unit: "tool_call", delta: 1 },
          },
        ],
      }),
    })
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    accepted: true,
    mode: "management",
    ack: { count: 1 },
  });
});

test("lease issue exposes TSA warning state when token is near expiry", async () => {
  const keys = generateEd25519KeyPair();
  const mgmtKey = "test-tsa-warning-key";
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: mgmtKey,
  });
  const now = 1_800_000_000;
  const res = await fetch(
    new Request("http://local/v1/leases/issue", {
      method: "POST",
      headers: { "x-api-key": mgmtKey },
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

test("lease issue embeds ticket-scoped manual attestation when TSA is expired", async () => {
  const keys = generateEd25519KeyPair();
  const mgmtKey = "test-tsa-embed-key";
  const leaseStore = createInMemoryLeaseStore();
  await leaseStore.addManualAttestation({
    customerId: "cust-tsa",
    seatId: "seat-1",
    operatorId: "op-1",
    ticketId: "INC-1",
    reason: "TSA outage incident response approved",
    attestedAtSec: 1_800_000_010,
    recordedAtSec: 1_800_000_011,
    source: "manual-time-attestation",
  });
  await leaseStore.addManualAttestation({
    customerId: "cust-tsa",
    seatId: "seat-1",
    operatorId: "op-2",
    ticketId: "INC-2",
    reason: "Different TSA outage incident response approved",
    attestedAtSec: 1_800_000_020,
    recordedAtSec: 1_800_000_021,
    source: "manual-time-attestation",
  });
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    leaseStore,
    managementApiKey: mgmtKey,
  });
  const now = 1_800_000_100;

  const res = await fetch(
    new Request("http://local/v1/leases/issue", {
      method: "POST",
      headers: { "x-api-key": mgmtKey },
      body: JSON.stringify({
        customerId: "cust-tsa",
        seatId: "seat-1",
        nowSec: now,
        lastTsaTokenAtSec: now - 8 * 24 * 60 * 60,
        tsaTicketId: "INC-1",
      }),
    })
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.tsaState.status).toBe("expired");
  expect(body.tsaState.latestManualAttestation.ticketId).toBe("INC-1");
  expect(body.tsaState.maxManualAttestationAgeSec).toBe(4 * 60 * 60);
});

test("manual TSA attestation latest endpoint returns most recent per customer+seat", async () => {
  const keys = generateEd25519KeyPair();
  const mgmtKey = "test-tsa-latest-key";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-license-server-"));
  const dbPath = path.join(dir, "lease-store.sqlite");
  const leaseStore = createSqliteLeaseStore({ dbPath });
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    leaseStore,
    managementApiKey: mgmtKey,
  });
  const headers = { "x-api-key": mgmtKey };

  const first = await fetch(
    new Request("http://local/v1/tsa/manual-attest", {
      method: "POST",
      headers,
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
      headers,
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
      { method: "GET", headers }
    )
  );
  expect(latest.status).toBe(200);
  const latestBody = await latest.json();
  expect(latestBody.accepted).toBe(true);
  expect(latestBody.record.ticketId).toBe("INC-2");
});
