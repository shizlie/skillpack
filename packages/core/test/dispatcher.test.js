import { describe, test, expect } from "bun:test";
import { createLicenseFetchHandler } from "../src/server.js";
import { createInMemoryLeaseStore } from "../src/storage.js";

const handler = createLicenseFetchHandler({
  signingPrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  signingPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
  leaseStore: createInMemoryLeaseStore(),
  managementApiKey: "test-key",
});

async function call(path, init = {}) {
  const request = new Request(`http://local${path}`, init);
  return handler(request);
}

describe("dispatcher routes through the table", () => {
  test("GET /healthz returns 200 without auth", async () => {
    const res = await call("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "license-server" });
  });

  test("POST /v1/providers without management key returns 401", async () => {
    const res = await call("/v1/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "p1" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /v1/providers with valid management key reaches the handler", async () => {
    const res = await call("/v1/providers", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ providerId: "p1", name: "Acme" }),
    });
    // Placeholder handlers throw, so the dispatcher must return 500 with that error.
    // Once Task 4 lands, this should be 201 with a created provider.
    const body = await res.json();
    expect(body.error).toContain("providers.create");
  });

  test("unknown route returns 404", async () => {
    const res = await call("/v1/nonexistent");
    expect(res.status).toBe(404);
  });

  test("POST /v1/leases/verify is open (no management key required)", async () => {
    // /v1/leases/verify is the client-side SDK endpoint. No auth at dispatcher level.
    const res = await call("/v1/leases/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseToken: "fake" }),
    });
    // Placeholder throws, but auth must NOT have rejected the request first.
    const body = await res.json();
    expect(body.error).toContain("leases.verify");
  });

  test("POST /v1/meter/upload is open at dispatcher (handler does its own auth)", async () => {
    // /v1/meter/upload has dual-auth in the handler — dispatcher must not enforce management.
    const res = await call("/v1/meter/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "w1", events: [] }),
    });
    const body = await res.json();
    expect(body.error).toContain("meter.upload");
  });
});
