import { expect, test } from "bun:test";

import worker from "../src/index.js";

test("dashboard worker: serves shell and config", async () => {
  const shellRes = await worker.fetch(new Request("http://local/"), {});
  expect(shellRes.status).toBe(200);
  expect(shellRes.headers.get("content-type")).toContain("text/html");
  expect(await shellRes.text()).toContain(
    "Clerk signs the operator in. The browser never sees the backend key."
  );

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
    apiManagementConfigured: false,
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
      SKILLPACK_API_MANAGEMENT_KEY: "backend-mgmt-key",
      SKILLPACK_DASHBOARD_ORIGIN: "http://local",
    }
  );
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});
