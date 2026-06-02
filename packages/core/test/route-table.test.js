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

// (method, path) → expected management flag value.
// Absent key (undefined) means the route has no `management` field at all
// (i.e. is not a management route). True means the dispatcher must run
// management auth before the handler. False is allowed but not used yet.
//
// The exceptions — /v1/leases/verify (open SDK endpoint) and
// /v1/meter/upload (dual-auth handled inside its own handler) — are
// deliberately NOT in the management set. They are not in the original
// server.js isManagementRoute() function either.
const expectedManagement = {
  "GET /v1/usage/summary": true,
  "GET /v1/providers": true,
  "GET /v1/workspaces": true,
  "GET /v1/providers/:providerId/customers": true,
  "GET /v1/billing/pricing-rules": true,
  "GET /v1/billing/invoices": true,
  "GET /v1/billing/invoices/:id": true,
  "GET /v1/tsa/manual-attestations": true,
  "GET /v1/tsa/manual-attestations/latest": true,
  "POST /v1/providers": true,
  "POST /v1/workspaces": true,
  "POST /v1/providers/:providerId/customers": true,
  "POST /v1/leases/issue": true,
  "POST /v1/policies/issue": true,
  "POST /v1/policies/sync": true,
  "POST /v1/billing/pricing-rules": true,
  "POST /v1/billing/invoices/draft": true,
  "POST /v1/billing/invoices/:id/payment-handoff": true,
  "POST /v1/tsa/manual-attest": true,
  // /healthz, /v1/leases/verify, /v1/meter/upload have no management flag.
};

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

  test("management flag matches expected auth model", () => {
    const byKey = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
    for (const [key, expected] of Object.entries(expectedManagement)) {
      const route = byKey.get(key);
      expect(route).toBeDefined();
      expect(Boolean(route.management)).toBe(Boolean(expected));
    }
    // Routes that should NOT be management routes:
    for (const path of ["/healthz", "/v1/leases/verify", "/v1/meter/upload"]) {
      for (const route of routes) {
        if (route.path === path) {
          expect(route.management).toBeUndefined();
        }
      }
    }
  });
});
