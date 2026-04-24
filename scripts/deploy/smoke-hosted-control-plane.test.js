import { describe, expect, test } from "bun:test";

import { smokeHostedControlPlane } from "./smoke-hosted-control-plane.mjs";

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
});
