import { describe, test, expect } from "bun:test";
import { routes } from "../src/routes.js";

const expectedRoutes = [
  ["GET",  "/healthz"],
  ["POST", "/v1/providers"],
  ["GET",  "/v1/providers"],
  ["POST", "/v1/providers/:providerId/customers"],
  ["GET",  "/v1/providers/:providerId/customers"],
  ["POST", "/v1/workspaces"],
  ["GET",  "/v1/workspaces"],
  ["POST", "/v1/leases/issue"],
  ["POST", "/v1/leases/verify"],
  ["POST", "/v1/policies/issue"],
  ["POST", "/v1/policies/sync"],
  ["GET",  "/v1/usage/summary"],
  ["POST", "/v1/billing/pricing-rules"],
  ["GET",  "/v1/billing/pricing-rules"],
  ["POST", "/v1/billing/invoices/draft"],
  ["GET",  "/v1/billing/invoices"],
  ["GET",  "/v1/billing/invoices/:id"],
  ["POST", "/v1/billing/invoices/:id/payment-handoff"],
  ["POST", "/v1/meter/upload"],
  ["POST", "/v1/tsa/manual-attest"],
  ["GET",  "/v1/tsa/manual-attestations"],
  ["GET",  "/v1/tsa/manual-attestations/latest"],
];

describe("route table", () => {
  test("contains every (method,path) pair from the current handler", () => {
    const present = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const [method, path] of expectedRoutes) {
      expect(present.has(`${method} ${path}`)).toBe(true);
    }
  });

  test("every route has a handler function", () => {
    for (const r of routes) {
      expect(typeof r.handler).toBe("function");
    }
  });

  test("no two routes share the same (method, path)", () => {
    const seen = new Set();
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
