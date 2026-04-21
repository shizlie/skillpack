import { expect, test } from "bun:test";

import { generateEd25519KeyPair } from "@skillpack/crypto";
import { createLicenseFetchHandler } from "../src/index.js";

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
      workspaceId: "ws-1",
      seatId: "seat-1",
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
