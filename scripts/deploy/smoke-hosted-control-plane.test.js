import { describe, expect, test } from "bun:test";

import { smokeHostedControlPlane } from "./smoke-hosted-control-plane.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("smokeHostedControlPlane", () => {
  test("surfaces api health failure", async () => {
    await expect(
      smokeHostedControlPlane({
        apiBaseUrl: "http://127.0.0.1:9",
        dashboardBaseUrl: "http://127.0.0.1:9",
        apiKey: "dev-key",
      })
    ).rejects.toThrow(/ECONNREFUSED|fetch failed|connect/);
  });

  test("fails when dashboard config shows missing production bindings", async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith("/healthz")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/app-config")) {
        return new Response(
          JSON.stringify({
            apiProxyBase: "/api",
            authMode: "unconfigured",
            apiBaseUrlConfigured: false,
            clerkBackendConfigured: false,
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected_url:${url}`);
    };

    await expect(
      smokeHostedControlPlane({
        apiBaseUrl: "https://api.example.com",
        dashboardBaseUrl: "https://dashboard.example.com",
        fetchImpl,
      })
    ).rejects.toThrow(/dashboard_config_invalid_auth_mode/);
  });

  test("checks hosted hierarchy, policy, meter, usage, billing, and dashboard proxy", async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      const request = url instanceof Request ? url : new Request(url, init);
      const parsed = new URL(request.url);
      const bodyText = request.method === "GET" ? "" : await request.text();
      const body = bodyText ? JSON.parse(bodyText) : null;
      calls.push({
        origin: parsed.origin,
        pathname: parsed.pathname,
        search: parsed.search,
        method: request.method,
        apiKey: request.headers.get("x-api-key"),
        authorization: request.headers.get("authorization"),
        body,
      });

      if (parsed.pathname === "/healthz") {
        return jsonResponse({ ok: true });
      }
      if (parsed.pathname === "/app-config") {
        return jsonResponse({
          apiProxyBase: "/api",
          authMode: "clerk",
          apiBaseUrlConfigured: true,
          clerkBackendConfigured: true,
        });
      }
      if (parsed.pathname === "/api/v1/providers") {
        return jsonResponse({ providers: [] });
      }
      if (parsed.pathname === "/v1/providers" && request.method === "GET") {
        return jsonResponse({ providers: [] });
      }
      if (parsed.pathname === "/v1/providers" && request.method === "POST") {
        return jsonResponse({ accepted: true, provider: body });
      }
      if (parsed.pathname === "/v1/providers/smoke-prov/customers") {
        return jsonResponse({ accepted: true, customer: body });
      }
      if (parsed.pathname === "/v1/workspaces") {
        return jsonResponse({ accepted: true, workspace: body });
      }
      if (parsed.pathname === "/v1/policies/issue") {
        return jsonResponse({ accepted: true, policy: body.policy });
      }
      if (parsed.pathname === "/v1/meter/upload") {
        return jsonResponse({ accepted: true, ack: { count: body.events.length } });
      }
      if (parsed.pathname === "/v1/usage/summary") {
        return jsonResponse({
          summary: [
            {
              providerId: "smoke-prov",
              customerId: "smoke-cust",
              workspaceId: "smoke-ws",
              seatId: "smoke-seat",
              tool: "wiki_search",
              unit: "tool_call",
              totalCalls: 2,
            },
          ],
        });
      }
      if (parsed.pathname === "/v1/billing/pricing-rules") {
        return jsonResponse({ accepted: true, pricingRule: body });
      }
      if (parsed.pathname === "/v1/billing/invoices/draft") {
        return jsonResponse({
          accepted: true,
          invoice: {
            invoiceId: body.invoiceId,
            status: "DRAFT",
            totalAmountCents: 20,
          },
        });
      }
      throw new Error(`unexpected ${request.method} ${parsed.pathname}`);
    };

    await expect(
      smokeHostedControlPlane({
        apiBaseUrl: "https://api.example.com",
        dashboardBaseUrl: "https://dashboard.example.com",
        apiKey: "mgmt-key",
        dashboardAuthHeader: "Bearer clerk-session",
        runId: "unit-run",
        fetchImpl,
      })
    ).resolves.toEqual({ ok: true });

    expect(calls.map((call) => `${call.method} ${call.pathname}`)).toEqual([
      "GET /healthz",
      "GET /healthz",
      "GET /app-config",
      "GET /v1/providers",
      "GET /api/v1/providers",
      "POST /v1/providers",
      "POST /v1/providers/smoke-prov/customers",
      "POST /v1/workspaces",
      "POST /v1/policies/issue",
      "POST /v1/meter/upload",
      "GET /v1/usage/summary",
      "POST /v1/billing/pricing-rules",
      "POST /v1/billing/invoices/draft",
    ]);
    expect(calls.find((call) => call.pathname === "/api/v1/providers").authorization).toBe(
      "Bearer clerk-session"
    );
    expect(calls.find((call) => call.pathname === "/v1/meter/upload").body.context).toMatchObject({
      bundleId: "laws-consultant-unit-run",
      leaseJti: "smoke-lease-unit-run",
    });
    expect(calls.find((call) => call.pathname === "/v1/billing/invoices/draft").body.invoiceId).toBe(
      "smoke-invoice-unit-run"
    );
    for (const call of calls.filter(
      (item) => item.origin === "https://api.example.com" && item.pathname !== "/healthz"
    )) {
      expect(call.apiKey).toBe("mgmt-key");
    }
  });

  test("can smoke the hosted api with a clerk bearer token instead of an api key", async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      const request = url instanceof Request ? url : new Request(url, init);
      const parsed = new URL(request.url);
      const bodyText = request.method === "GET" ? "" : await request.text();
      const body = bodyText ? JSON.parse(bodyText) : null;
      calls.push({
        pathname: parsed.pathname,
        method: request.method,
        apiKey: request.headers.get("x-api-key"),
        authorization: request.headers.get("authorization"),
      });

      if (parsed.pathname === "/healthz") return jsonResponse({ ok: true });
      if (parsed.pathname === "/app-config") {
        return jsonResponse({
          apiProxyBase: "/api",
          authMode: "clerk",
          apiBaseUrlConfigured: true,
          clerkBackendConfigured: true,
        });
      }
      if (parsed.pathname === "/v1/providers" && request.method === "GET") {
        return jsonResponse({ providers: [] });
      }
      if (parsed.pathname === "/v1/providers" && request.method === "POST") {
        return jsonResponse({ accepted: true, provider: body });
      }
      if (parsed.pathname === "/v1/providers/smoke-prov/customers") {
        return jsonResponse({ accepted: true, customer: body });
      }
      if (parsed.pathname === "/v1/workspaces") {
        return jsonResponse({ accepted: true, workspace: body });
      }
      if (parsed.pathname === "/v1/policies/issue") {
        return jsonResponse({ accepted: true, policy: body.policy });
      }
      if (parsed.pathname === "/v1/meter/upload") {
        return jsonResponse({ accepted: true, ack: { count: body.events.length } });
      }
      if (parsed.pathname === "/v1/usage/summary") {
        return jsonResponse({
          summary: [{ tool: "wiki_search", unit: "tool_call", totalCalls: 2 }],
        });
      }
      if (parsed.pathname === "/v1/billing/pricing-rules") {
        return jsonResponse({ accepted: true, pricingRule: body });
      }
      if (parsed.pathname === "/v1/billing/invoices/draft") {
        return jsonResponse({
          accepted: true,
          invoice: { invoiceId: body.invoiceId, status: "DRAFT" },
        });
      }
      throw new Error(`unexpected ${request.method} ${parsed.pathname}`);
    };

    await expect(
      smokeHostedControlPlane({
        apiBaseUrl: "https://api.example.com",
        dashboardBaseUrl: "https://dashboard.example.com",
        apiAuthHeader: "Bearer clerk-session",
        runId: "unit-run",
        fetchImpl,
      })
    ).resolves.toEqual({ ok: true });

    for (const call of calls.filter((item) => item.pathname.startsWith("/v1/"))) {
      expect(call.authorization).toBe("Bearer clerk-session");
      expect(call.apiKey).toBe(null);
    }
  });
});
