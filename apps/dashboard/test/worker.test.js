import { expect, test } from "bun:test";

import worker, { createDashboardWorker } from "../src/index.js";

test("dashboard worker: serves shell and config", async () => {
  const shellRes = await worker.fetch(new Request("http://local/"), {});
  expect(shellRes.status).toBe(200);
  expect(shellRes.headers.get("content-type")).toContain("text/html");
  expect(await shellRes.text()).toContain(
    "Clerk signs the operator in. API calls stay server-side."
  );
  const billingShell = await (
    await worker.fetch(new Request("http://local/"), {})
  ).text();
  expect(billingShell).toContain("Pricing rules and invoice handoffs");
  expect(billingShell).toContain('id="metric-pricing-rules"');
  expect(billingShell).toContain('id="metric-invoices"');
  expect(billingShell).toContain('id="billing-pricing-rule-form"');
  expect(billingShell).toContain('id="billing-invoice-draft-form"');
  expect(billingShell).toContain('id="billing-payment-handoff-form"');
  expect(billingShell).toContain('id="billing-rule-customer"');
  expect(billingShell).toContain('id="billing-invoice-workspace"');
  expect(billingShell).toContain('<option value="manual">manual</option>');
  expect(billingShell).toContain('<option value="dodo">dodo</option>');
  expect(billingShell).toContain('<option value="stripe">stripe</option>');

  const configRes = await worker.fetch(new Request("http://local/app-config"), {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
    SKILLPACK_CLERK_SIGN_IN_URL: "/sign-in",
  });
  expect(configRes.status).toBe(200);
  expect(await configRes.json()).toEqual({
    apiProxyBase: "/api",
    authMode: "clerk",
    apiBaseUrlConfigured: false,
    clerkBackendConfigured: false,
    clerkPublishableKey:
      "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
    clerkFrontendApiHost: "example.clerk.accounts.dev",
    clerkSignInUrl: "/sign-in",
    clerkSignUpUrl: null,
  });
});

test("dashboard worker: serves assets and health", async () => {
  const cssRes = await worker.fetch(new Request("http://local/assets/dashboard.css"), {});
  expect(cssRes.status).toBe(200);
  expect(cssRes.headers.get("content-type")).toContain("text/css");

  const jsRes = await worker.fetch(new Request("http://local/assets/dashboard.js"), {});
  expect(jsRes.status).toBe(200);
  expect(jsRes.headers.get("content-type")).toContain("application/javascript");
  const dashboardScript = await jsRes.text();
  expect(dashboardScript).toContain("/v1/billing/pricing-rules");
  expect(dashboardScript).toContain("/v1/billing/invoices/draft");
  expect(dashboardScript).toContain("/payment-handoff");
  expect(dashboardScript).toContain("syncOptionalSelect");
  expect(dashboardScript).toContain("Any customer");
  expect(dashboardScript).toContain("Any workspace");
  expect(dashboardScript).toContain('bindAsyncForm("#billing-pricing-rule-form"');
  expect(dashboardScript).toContain('bindAsyncForm("#billing-invoice-draft-form"');
  expect(dashboardScript).toContain('bindAsyncForm("#billing-payment-handoff-form"');

  const healthRes = await worker.fetch(new Request("http://local/healthz"), {});
  expect(healthRes.status).toBe(200);
  expect(await healthRes.json()).toEqual({
    ok: true,
    service: "dashboard-worker",
  });
});

test("dashboard worker: proxy rejects unauthenticated requests", async () => {
  const res = await worker.fetch(
    new Request("http://local/api/v1/providers"),
    {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
      CLERK_SECRET_KEY: "sk_test_dummy_secret_key",
      SKILLPACK_API_BASE_URL: "https://api.skillpack.example",
      SKILLPACK_API_KEY: "backend-api-key",
      SKILLPACK_DASHBOARD_ORIGIN: "http://local",
    }
  );
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

test("dashboard worker: proxy can forward clerk bearer auth to api", async () => {
  let upstreamRequest;
  const worker = createDashboardWorker({
    createClerkClientImpl: () => ({
      authenticateRequest: async (request) => ({
        isAuthenticated: request.headers.get("authorization") === "Bearer clerk-ok",
        toAuth: () => ({ userId: "user_1" }),
      }),
    }),
    fetchImpl: async (url, init) => {
      upstreamRequest = { url, init };
      return Response.json({ providers: [] });
    },
  });

  const res = await worker.fetch(
    new Request("http://local/api/v1/providers", {
      headers: { authorization: "Bearer clerk-ok" },
    }),
    {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
      CLERK_SECRET_KEY: "sk_test_dummy_secret_key",
      SKILLPACK_API_BASE_URL: "https://api.skillpack.example",
      SKILLPACK_MANAGEMENT_AUTH_MODE: "clerk",
      SKILLPACK_DASHBOARD_ORIGIN: "http://local",
    }
  );

  expect(res.status).toBe(200);
  expect(upstreamRequest.url).toBe("https://api.skillpack.example/v1/providers");
  expect(upstreamRequest.init.headers.get("authorization")).toBe("Bearer clerk-ok");
  expect(upstreamRequest.init.headers.has("x-api-key")).toBe(false);
  expect(upstreamRequest.init.headers.get("x-skillpack-dashboard-user-id")).toBe("user_1");
});

test("dashboard worker: proxy keeps api-key mode for self-hosted deployments", async () => {
  let upstreamRequest;
  const worker = createDashboardWorker({
    createClerkClientImpl: () => ({
      authenticateRequest: async (request) => ({
        isAuthenticated: request.headers.get("authorization") === "Bearer clerk-ok",
        toAuth: () => ({ userId: "user_1" }),
      }),
    }),
    fetchImpl: async (url, init) => {
      upstreamRequest = { url, init };
      return Response.json({ providers: [] });
    },
  });

  const res = await worker.fetch(
    new Request("http://local/api/v1/providers", {
      headers: { authorization: "Bearer clerk-ok" },
    }),
    {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
      CLERK_SECRET_KEY: "sk_test_dummy_secret_key",
      SKILLPACK_API_BASE_URL: "https://api.skillpack.example",
      SKILLPACK_API_KEY: "backend-api-key",
      SKILLPACK_MANAGEMENT_AUTH_MODE: "shared-key",
      SKILLPACK_DASHBOARD_ORIGIN: "http://local",
    }
  );

  expect(res.status).toBe(200);
  expect(upstreamRequest.init.headers.get("x-api-key")).toBe("backend-api-key");
  expect(upstreamRequest.init.headers.has("authorization")).toBe(false);
});
