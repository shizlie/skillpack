import { describe, expect, test } from "bun:test";
import { resolveHostedManifest } from "./resolve-hosted-manifest.mjs";

describe("resolveHostedManifest", () => {
  test("binds worker vars from explicit manifest inputs", () => {
    const manifest = {
      schemaVersion: 1,
      inputs: {
        apiPublicBaseUrl: { required: true },
        dashboardPublicOrigin: { required: true },
      },
      deployables: {
        api: {
          workdir: "apps/api",
          wranglerConfig: "apps/api/wrangler.jsonc",
          publicVars: {
            SKILLPACK_DASHBOARD_ORIGIN: { fromInput: "dashboardPublicOrigin" },
          },
          secrets: [
            "SKILLPACK_API_KEY",
            "SKILLPACK_SIGNING_PRIVATE_KEY_PEM",
            "SKILLPACK_SIGNING_PUBLIC_KEY_PEM",
          ],
        },
        dashboard: {
          workdir: "apps/dashboard",
          wranglerConfig: "apps/dashboard/wrangler.jsonc",
          publicVars: {
            SKILLPACK_API_BASE_URL: { fromInput: "apiPublicBaseUrl" },
            SKILLPACK_DASHBOARD_ORIGIN: { fromInput: "dashboardPublicOrigin" },
          },
          secrets: [
            "SKILLPACK_API_KEY",
            "CLERK_SECRET_KEY",
            "CLERK_PUBLISHABLE_KEY",
          ],
        },
      },
    };

    const resolved = resolveHostedManifest(manifest, {
      apiPublicBaseUrl: "https://skillpack-api.example.workers.dev",
      dashboardPublicOrigin:
        "https://skillpack-dashboard.example.workers.dev",
    });

    expect(resolved.deployables.api.publicVars.SKILLPACK_DASHBOARD_ORIGIN).toBe(
      "https://skillpack-dashboard.example.workers.dev"
    );
    expect(
      resolved.deployables.dashboard.publicVars.SKILLPACK_API_BASE_URL
    ).toBe("https://skillpack-api.example.workers.dev");
  });
});
