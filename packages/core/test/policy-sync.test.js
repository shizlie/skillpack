import { expect, test } from "bun:test";

import { generateEd25519KeyPair } from "@skillpack/crypto";
import { createLicenseFetchHandler } from "../src/index.js";
import { createSqliteLeaseStore } from "../src/storage-sqlite.js";

function makePolicy({ policyId, workspaceId = "ws-1", workspaceMode = "ENABLED" }) {
  return {
    policyVersion: 1,
    policyId,
    workspaceId,
    workspacePolicy: { mode: workspaceMode },
    seatPolicy: {
      defaultMode: "ENABLED",
      seats: {
        "seat-1": { mode: "ENABLED" },
      },
    },
    usagePolicy: {
      unit: "tool_call",
      thresholds: { warningPct: 100, hardStopPct: 120 },
      toolBudgets: { wiki_search: 100 },
    },
    timePolicy: {
      workspace: { startsAtSec: 1_800_000_000, expiresAtSec: 1_800_003_600, graceUntilSec: 1_800_007_200 },
      seatOverrides: {
        "seat-1": { startsAtSec: 1_800_000_000, expiresAtSec: 1_800_003_600, graceUntilSec: 1_800_007_200 },
      },
    },
  };
}

test("policy issue + sync + not_modified + meter upload + usage summary + disable propagation", async () => {
  const keys = generateEd25519KeyPair();
  const managementApiKey = "test-management-key";
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey,
  });
  const headers = { "x-api-key": managementApiKey };

  const policyV1 = makePolicy({ policyId: "pol-1", workspaceMode: "ENABLED" });
  const issueV1 = await fetch(
    new Request("http://local/v1/policies/issue", {
      method: "POST",
      headers,
      body: JSON.stringify({ policy: policyV1 }),
    })
  );
  expect(issueV1.status).toBe(200);
  const issueV1Body = await issueV1.json();
  expect(issueV1Body.accepted).toBe(true);
  expect(issueV1Body.policy.policyId).toBe("pol-1");

  const syncFirst = await fetch(
    new Request("http://local/v1/policies/sync", {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: "ws-1" }),
    })
  );
  expect(syncFirst.status).toBe(200);
  const syncFirstBody = await syncFirst.json();
  expect(syncFirstBody.notModified).toBe(false);
  expect(syncFirstBody.policy.policyId).toBe("pol-1");
  expect(syncFirstBody.policy.workspacePolicy.mode).toBe("ENABLED");

  const syncNotModified = await fetch(
    new Request("http://local/v1/policies/sync", {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: "ws-1", policyId: "pol-1" }),
    })
  );
  expect(syncNotModified.status).toBe(200);
  const syncNotModifiedBody = await syncNotModified.json();
  expect(syncNotModifiedBody.notModified).toBe(true);

  const upload = await fetch(
    new Request("http://local/v1/meter/upload", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "ws-1",
        context: {
          providerId: "prov-1",
          customerId: "cust-1",
          skillId: "skill-1",
          bundleId: "bundle-1",
          leaseJti: "lease-jti-1",
        },
        events: [
          {
            prevHash: "h0",
            seq: 10,
            at: 1_800_000_100,
            kind: "tool_call",
            seatId: "seat-1",
            tool: "wiki_search",
            usage: { unit: "tool_call", delta: 2 },
          },
          {
            prevHash: "h1",
            seq: 11,
            at: 1_800_000_120,
            kind: "tool_call",
            seatId: "seat-1",
            tool: "wiki_search",
            usage: { unit: "tool_call", delta: 3 },
          },
        ],
      }),
    })
  );
  expect(upload.status).toBe(200);
  const uploadBody = await upload.json();
  expect(uploadBody.accepted).toBe(true);
  expect(uploadBody.ack.count).toBe(2);
  expect(uploadBody.ack.range.seqStart).toBe(10);
  expect(uploadBody.ack.range.seqEnd).toBe(11);

  const summaryRes = await fetch(
    new Request("http://local/v1/usage/summary?workspaceId=ws-1", {
      method: "GET",
      headers,
    })
  );
  expect(summaryRes.status).toBe(200);
  const summaryBody = await summaryRes.json();
  expect(summaryBody.summary).toEqual([
    {
      providerId: "prov-1",
      customerId: "cust-1",
      workspaceId: "ws-1",
      seatId: "seat-1",
      skillId: "skill-1",
      bundleId: "bundle-1",
      leaseJti: "lease-jti-1",
      tool: "wiki_search",
      unit: "tool_call",
      totalCalls: 5,
    },
  ]);

  const policyV2 = makePolicy({ policyId: "pol-2", workspaceMode: "DISABLED" });
  const issueV2 = await fetch(
    new Request("http://local/v1/policies/issue", {
      method: "POST",
      headers,
      body: JSON.stringify({ policy: policyV2 }),
    })
  );
  expect(issueV2.status).toBe(200);

  const syncAfterDisable = await fetch(
    new Request("http://local/v1/policies/sync", {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: "ws-1", policyId: "pol-1" }),
    })
  );
  expect(syncAfterDisable.status).toBe(200);
  const syncAfterDisableBody = await syncAfterDisable.json();
  expect(syncAfterDisableBody.notModified).toBe(false);
  expect(syncAfterDisableBody.policy.policyId).toBe("pol-2");
  expect(syncAfterDisableBody.policy.workspacePolicy.mode).toBe("DISABLED");
});

test("meter upload re-upload is idempotent — same events not double-counted (SQLite)", async () => {
  const keys = generateEd25519KeyPair();
  const mgmtKey = "test-key-dedup";
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: mgmtKey,
    leaseStore: createSqliteLeaseStore(),
  });

  const body = JSON.stringify({
    workspaceId: "ws-dedup",
    context: { providerId: "prov-1", customerId: "cust-1", leaseJti: "jti-dedup" },
    events: [
      { prevHash: "h0", seq: 0, at: 1_800_000_000, kind: "tool_call", seatId: "seat-1", tool: "wiki_search", usage: { unit: "tool_call", delta: 1 } },
    ],
  });
  const headers = { "content-type": "application/json", "x-api-key": mgmtKey };

  const first = await fetch(new Request("http://local/v1/meter/upload", { method: "POST", headers, body }));
  expect((await first.json()).accepted).toBe(true);

  const second = await fetch(new Request("http://local/v1/meter/upload", { method: "POST", headers, body }));
  expect((await second.json()).accepted).toBe(true);

  const summary = await (await fetch(new Request("http://local/v1/usage/summary?workspaceId=ws-dedup", { headers }))).json();
  expect(summary.summary).toHaveLength(1);
  expect(summary.summary[0].totalCalls).toBe(1);
});

test("meter upload with invalid contract returns 400", async () => {
  const keys = generateEd25519KeyPair();
  const mgmtKey = "test-key-invalid";
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: mgmtKey,
  });

  const res = await fetch(
    new Request("http://local/v1/meter/upload", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": mgmtKey },
      body: JSON.stringify({ events: [] }),
    })
  );
  expect(res.status).toBe(400);
  const resBody = await res.json();
  expect(resBody.accepted).toBe(false);
});

test("usage summary multi-dimension filter returns only matching rows", async () => {
  const keys = generateEd25519KeyPair();
  const mgmtKey = "test-key-mf";
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: mgmtKey,
  });

  const headers = { "content-type": "application/json", "x-api-key": mgmtKey };
  const mkEvent = (seq, seatId, tool) => ({
    prevHash: "h0",
    seq,
    at: 1_800_000_000 + seq,
    kind: "tool_call",
    seatId,
    tool,
    usage: { unit: "tool_call", delta: 1 },
  });

  await fetch(new Request("http://local/v1/meter/upload", {
    method: "POST", headers,
    body: JSON.stringify({ workspaceId: "ws-mf", context: { customerId: "cust-A", providerId: "prov-A", leaseJti: "jti-mf-a" }, events: [mkEvent(1, "seat-1", "wiki_search")] }),
  }));
  await fetch(new Request("http://local/v1/meter/upload", {
    method: "POST", headers,
    body: JSON.stringify({ workspaceId: "ws-mf", context: { customerId: "cust-B", providerId: "prov-B", leaseJti: "jti-mf-b" }, events: [mkEvent(2, "seat-2", "wiki_read_page")] }),
  }));

  const res = await fetch(new Request("http://local/v1/usage/summary?workspaceId=ws-mf&providerId=prov-A", { headers }));
  const { summary } = await res.json();
  expect(summary).toHaveLength(1);
  expect(summary[0].providerId).toBe("prov-A");
  expect(summary[0].tool).toBe("wiki_search");
});

test("management endpoints require api key when configured", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: "required-key",
  });

  const issueNoKey = await fetch(
    new Request("http://local/v1/policies/issue", {
      method: "POST",
      body: JSON.stringify({ policy: makePolicy({ policyId: "pol-auth" }) }),
    })
  );
  expect(issueNoKey.status).toBe(401);

  const summaryWrongKey = await fetch(
    new Request("http://local/v1/usage/summary?workspaceId=ws-1", {
      method: "GET",
      headers: { "x-api-key": "wrong-key" },
    })
  );
  expect(summaryWrongKey.status).toBe(401);
});

test("meter upload re-upload is idempotent — same events not double-counted (in-memory)", async () => {
  const keys = generateEd25519KeyPair();
  const mgmtKey = "test-key-mem-dedup";
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: mgmtKey,
  });

  const body = JSON.stringify({
    workspaceId: "ws-mem-dedup",
    context: { providerId: "prov-1", customerId: "cust-1", leaseJti: "jti-mem-dedup" },
    events: [
      { prevHash: "h0", seq: 0, at: 1_800_000_000, kind: "tool_call", seatId: "seat-1", tool: "wiki_search", usage: { unit: "tool_call", delta: 1 } },
    ],
  });
  const headers = { "content-type": "application/json", "x-api-key": mgmtKey };

  await fetch(new Request("http://local/v1/meter/upload", { method: "POST", headers, body }));
  await fetch(new Request("http://local/v1/meter/upload", { method: "POST", headers, body }));

  const summary = await (await fetch(new Request("http://local/v1/usage/summary?workspaceId=ws-mem-dedup", { headers }))).json();
  expect(summary.summary).toHaveLength(1);
  expect(summary.summary[0].totalCalls).toBe(1);
});
