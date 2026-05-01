import { describe, expect, test } from "bun:test";

import { validateHostedDeployEnv } from "./check-hosted-deploy-env.mjs";

describe("validateHostedDeployEnv", () => {
  test("reports every missing hosted smoke variable and app secret", () => {
    expect(() => validateHostedDeployEnv({})).toThrow(
      /hosted_deploy_missing_configuration:SKILLPACK_API_BASE_URL,SKILLPACK_DASHBOARD_ORIGIN,SKILLPACK_API_KEY_OR_SMOKE_API_AUTH_HEADER/
    );
  });

  test("accepts the configured hosted smoke environment", () => {
    expect(
      validateHostedDeployEnv({
        SKILLPACK_API_BASE_URL: "https://skillpack-api.example.workers.dev",
        SKILLPACK_DASHBOARD_ORIGIN: "https://skillpack-dashboard.example.workers.dev",
        SKILLPACK_API_KEY: "mgmt-key",
      })
    ).toEqual({ ok: true });
  });

  test("accepts a clerk api auth header instead of a shared api key", () => {
    expect(
      validateHostedDeployEnv({
        SKILLPACK_API_BASE_URL: "https://skillpack-api.example.workers.dev",
        SKILLPACK_DASHBOARD_ORIGIN: "https://skillpack-dashboard.example.workers.dev",
        SMOKE_API_AUTH_HEADER: "Bearer clerk-session",
      })
    ).toEqual({ ok: true });
  });
});
