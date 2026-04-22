import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { generateEd25519KeyPair } from "@skillpack/crypto";
import worker from "../src/index.js";

function createTestD1Database() {
  const sqlite = new Database(":memory:");

  function statement(sql, args = []) {
    return {
      bind(...nextArgs) {
        return statement(sql, nextArgs);
      },
      async run() {
        sqlite.query(sql).run(...args);
        return { success: true };
      },
      async first() {
        const row = sqlite.query(sql).get(...args);
        return row ?? null;
      },
      async all() {
        const rows = sqlite.query(sql).all(...args);
        return { results: rows };
      },
    };
  }

  return {
    prepare(sql) {
      return statement(sql);
    },
    async exec(sql) {
      sqlite.exec(sql);
      return { success: true };
    },
    async batch(statements) {
      const out = [];
      for (const stmt of statements) {
        out.push(await stmt.run());
      }
      return out;
    },
    close() {
      sqlite.close(false);
    },
  };
}

function makePolicy() {
  return {
    policyVersion: 1,
    policyId: "pol-1",
    workspaceId: "ws-1",
    workspacePolicy: { mode: "ENABLED" },
    seatPolicy: {
      defaultMode: "ENABLED",
      seats: { "seat-1": { mode: "ENABLED" } },
    },
    usagePolicy: {
      unit: "tool_call",
      thresholds: { warningPct: 100, hardStopPct: 120 },
      toolBudgets: { wiki_search: 100 },
    },
    timePolicy: {
      workspace: {
        startsAtSec: 1_800_000_000,
        expiresAtSec: 1_800_003_600,
        graceUntilSec: 1_800_007_200,
      },
      seatOverrides: {
        "seat-1": {
          startsAtSec: 1_800_000_000,
          expiresAtSec: 1_800_003_600,
          graceUntilSec: 1_800_007_200,
        },
      },
    },
  };
}

test("worker: provider/customer/workspace + policy + meter + summary", async () => {
  const keys = generateEd25519KeyPair();
  const env = {
    DB: createTestD1Database(),
    SKILLPACK_MANAGEMENT_API_KEY: "mgmt-key",
    SKILLPACK_SIGNING_PRIVATE_KEY_PEM: keys.privateKeyPem,
    SKILLPACK_SIGNING_PUBLIC_KEY_PEM: keys.publicKeyPem,
  };
  const headers = { "content-type": "application/json", "x-api-key": "mgmt-key" };

  const providerRes = await worker.fetch(
    new Request("http://local/v1/providers", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: "prov-1", name: "Provider One" }),
    }),
    env
  );
  expect(providerRes.status).toBe(200);

  const customerRes = await worker.fetch(
    new Request("http://local/v1/providers/prov-1/customers", {
      method: "POST",
      headers,
      body: JSON.stringify({ customerId: "cust-1", name: "Customer One" }),
    }),
    env
  );
  expect(customerRes.status).toBe(200);

  const workspaceRes = await worker.fetch(
    new Request("http://local/v1/workspaces", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "ws-1",
        providerId: "prov-1",
        customerId: "cust-1",
        name: "Workspace One",
      }),
    }),
    env
  );
  expect(workspaceRes.status).toBe(200);

  const policyIssue = await worker.fetch(
    new Request("http://local/v1/policies/issue", {
      method: "POST",
      headers,
      body: JSON.stringify({ policy: makePolicy() }),
    }),
    env
  );
  expect(policyIssue.status).toBe(200);

  const meterUpload = await worker.fetch(
    new Request("http://local/v1/meter/upload", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "ws-1",
        context: {
          providerId: "prov-1",
          customerId: "cust-1",
          skillId: "laws-consultant",
          bundleId: "laws-consultant-1.0.0",
          leaseJti: "jti-1",
        },
        events: [
          {
            prevHash: "h0",
            seq: 1,
            at: 1_800_000_100,
            kind: "tool_call",
            seatId: "seat-1",
            tool: "wiki_search",
            usage: { unit: "tool_call", delta: 2 },
          },
        ],
      }),
    }),
    env
  );
  expect(meterUpload.status).toBe(200);

  const summaryRes = await worker.fetch(
    new Request("http://local/v1/usage/summary?workspaceId=ws-1&providerId=prov-1", {
      method: "GET",
      headers: { "x-api-key": "mgmt-key" },
    }),
    env
  );
  expect(summaryRes.status).toBe(200);
  const summaryBody = await summaryRes.json();
  expect(summaryBody.summary).toEqual([
    {
      providerId: "prov-1",
      customerId: "cust-1",
      workspaceId: "ws-1",
      seatId: "seat-1",
      skillId: "laws-consultant",
      bundleId: "laws-consultant-1.0.0",
      leaseJti: "jti-1",
      tool: "wiki_search",
      unit: "tool_call",
      totalCalls: 2,
    },
  ]);

  env.DB.close();
});

test("worker: accepts signing keys from *_BASE64 env vars", async () => {
  const keys = generateEd25519KeyPair();
  const env = {
    DB: createTestD1Database(),
    SKILLPACK_MANAGEMENT_API_KEY: "mgmt-key",
    SKILLPACK_SIGNING_PRIVATE_KEY_PEM_BASE64: Buffer.from(keys.privateKeyPem, "utf8").toString(
      "base64"
    ),
    SKILLPACK_SIGNING_PUBLIC_KEY_PEM_BASE64: Buffer.from(keys.publicKeyPem, "utf8").toString(
      "base64"
    ),
  };

  const res = await worker.fetch(
    new Request("http://local/v1/leases/issue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerId: "cust-1",
        seatId: "seat-1",
        vendorId: "laws-consultant",
      }),
    }),
    env
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.leaseToken).toBe("string");

  env.DB.close();
});
