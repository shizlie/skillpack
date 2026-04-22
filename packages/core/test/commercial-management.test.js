import { expect, test } from "bun:test";

import { generateEd25519KeyPair } from "@skillpack/crypto";
import { createLicenseFetchHandler } from "../src/index.js";
import { createSqliteLeaseStore } from "../src/storage-sqlite.js";

function makeHandler(overrides = {}) {
  const keys = generateEd25519KeyPair();
  return createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: "mgmt-key",
    ...overrides,
  });
}

test("commercial api: create provider -> customer -> workspace", async () => {
  const fetch = makeHandler();
  const headers = { "x-api-key": "mgmt-key" };

  const providerRes = await fetch(
    new Request("http://local/v1/providers", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: "prov-1", name: "Provider One" }),
    })
  );
  expect(providerRes.status).toBe(200);
  const providerBody = await providerRes.json();
  expect(providerBody).toEqual({
    accepted: true,
    provider: { providerId: "prov-1", name: "Provider One" },
  });

  const customerRes = await fetch(
    new Request("http://local/v1/providers/prov-1/customers", {
      method: "POST",
      headers,
      body: JSON.stringify({ customerId: "cust-1", name: "Customer One" }),
    })
  );
  expect(customerRes.status).toBe(200);
  const customerBody = await customerRes.json();
  expect(customerBody).toEqual({
    accepted: true,
    customer: {
      providerId: "prov-1",
      customerId: "cust-1",
      name: "Customer One",
    },
  });

  const workspaceRes = await fetch(
    new Request("http://local/v1/workspaces", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "ws-1",
        providerId: "prov-1",
        customerId: "cust-1",
        name: "Workspace One",
      }),
    })
  );
  expect(workspaceRes.status).toBe(200);
  const workspaceBody = await workspaceRes.json();
  expect(workspaceBody).toEqual({
    accepted: true,
    workspace: {
      workspaceId: "ws-1",
      providerId: "prov-1",
      customerId: "cust-1",
      name: "Workspace One",
      status: "ACTIVE",
    },
  });
});

test("commercial api: rejects workspace when provider/customer hierarchy missing", async () => {
  const fetch = makeHandler();
  const headers = { "x-api-key": "mgmt-key" };

  const missingProvider = await fetch(
    new Request("http://local/v1/providers/prov-missing/customers", {
      method: "POST",
      headers,
      body: JSON.stringify({ customerId: "cust-1", name: "Customer One" }),
    })
  );
  expect(missingProvider.status).toBe(400);
  expect((await missingProvider.json()).error).toBe("provider_not_found");

  await fetch(
    new Request("http://local/v1/providers", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: "prov-1", name: "Provider One" }),
    })
  );

  const missingCustomer = await fetch(
    new Request("http://local/v1/workspaces", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "ws-1",
        providerId: "prov-1",
        customerId: "cust-missing",
      }),
    })
  );
  expect(missingCustomer.status).toBe(400);
  expect((await missingCustomer.json()).error).toBe("customer_not_found");
});

test("commercial api: sqlite store enforces workspace identity binding", async () => {
  const fetch = makeHandler({ leaseStore: createSqliteLeaseStore() });
  const headers = { "x-api-key": "mgmt-key" };

  await fetch(
    new Request("http://local/v1/providers", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: "prov-1", name: "Provider One" }),
    })
  );
  await fetch(
    new Request("http://local/v1/providers/prov-1/customers", {
      method: "POST",
      headers,
      body: JSON.stringify({ customerId: "cust-1", name: "Customer One" }),
    })
  );
  await fetch(
    new Request("http://local/v1/providers/prov-1/customers", {
      method: "POST",
      headers,
      body: JSON.stringify({ customerId: "cust-2", name: "Customer Two" }),
    })
  );
  await fetch(
    new Request("http://local/v1/workspaces", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "ws-1",
        providerId: "prov-1",
        customerId: "cust-1",
      }),
    })
  );

  const mismatch = await fetch(
    new Request("http://local/v1/workspaces", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "ws-1",
        providerId: "prov-1",
        customerId: "cust-2",
      }),
    })
  );
  expect(mismatch.status).toBe(400);
  expect((await mismatch.json()).error).toBe("workspace_identity_mismatch");
});

test("commercial api routes require management api key", async () => {
  const fetch = makeHandler();

  const noKey = await fetch(
    new Request("http://local/v1/providers", {
      method: "POST",
      body: JSON.stringify({ providerId: "prov-1", name: "Provider One" }),
    })
  );
  expect(noKey.status).toBe(401);

  const customerNoKey = await fetch(
    new Request("http://local/v1/providers/prov-1/customers", {
      method: "POST",
      body: JSON.stringify({ customerId: "cust-1", name: "Customer One" }),
    })
  );
  expect(customerNoKey.status).toBe(401);

  const workspaceNoKey = await fetch(
    new Request("http://local/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "ws-1", providerId: "prov-1", customerId: "cust-1" }),
    })
  );
  expect(workspaceNoKey.status).toBe(401);
});

test("commercial api: create provider with no name returns null name", async () => {
  const fetch = makeHandler();
  const headers = { "x-api-key": "mgmt-key" };

  const res = await fetch(
    new Request("http://local/v1/providers", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: "prov-noname" }),
    })
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.provider.name).toBeNull();
});
