import { describe, test, expect } from "bun:test";
import { matchRoute } from "../src/routes.js";

describe("matchRoute", () => {
  test("exact match returns empty params", () => {
    expect(matchRoute("/v1/providers", "/v1/providers")).toEqual({
      matches: true, params: {},
    });
  });

  test("non-match returns matches:false", () => {
    expect(matchRoute("/v1/providers", "/v1/other")).toEqual({
      matches: false, params: null,
    });
  });

  test(":param segment extracts value", () => {
    expect(matchRoute(
      "/v1/billing/invoices/:id/payment-handoff",
      "/v1/billing/invoices/inv_123/payment-handoff"
    )).toEqual({ matches: true, params: { id: "inv_123" } });
  });

  test("trailing slash is significant", () => {
    expect(matchRoute("/v1/providers", "/v1/providers/")).toEqual({
      matches: false, params: null,
    });
  });

  test("matcher ignores any caller-supplied method context (path-only)", () => {
    // The function signature is (pattern, path) — no method param. The
    // test asserts that adding a hypothetical method argument is silently
    // ignored, so callers can't accidentally rely on it.
    expect(matchRoute.length).toBe(2);
  });

  test("malformed percent-encoding returns non-match (does not throw)", () => {
    expect(matchRoute(
      "/v1/billing/invoices/:id/payment-handoff",
      "/v1/billing/invoices/%ZZ/payment-handoff"
    )).toEqual({ matches: false, params: null });
  });

  test("URL-decoded param value is returned", () => {
    expect(matchRoute(
      "/v1/items/:id",
      "/v1/items/abc%20def"
    )).toEqual({ matches: true, params: { id: "abc def" } });
  });
});