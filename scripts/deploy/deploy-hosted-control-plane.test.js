import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { writeGeneratedConfig } from "./deploy-hosted-control-plane.mjs";

describe("writeGeneratedConfig", () => {
  test("writes generated Wrangler config beside source config so relative main resolves from app root", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-deploy-test-"));
    const appDir = path.join(rootDir, "apps", "api");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "wrangler.jsonc"),
      JSON.stringify({ name: "skillpack-api", main: "src/index.js", vars: { EXISTING: "1" } })
    );

    const generatedPath = writeGeneratedConfig({
      rootDir,
      deployableName: "api",
      deployable: {
        workdir: "apps/api",
        wranglerConfig: "apps/api/wrangler.jsonc",
        publicVars: { SKILLPACK_DASHBOARD_ORIGIN: "https://dashboard.example" },
      },
    });

    expect(path.dirname(generatedPath)).toBe(appDir);
    expect(path.basename(generatedPath)).toBe("wrangler.generated.api.json");
    const generated = JSON.parse(fs.readFileSync(generatedPath, "utf8"));
    expect(generated.main).toBe("src/index.js");
    expect(generated.vars).toEqual({
      EXISTING: "1",
      SKILLPACK_DASHBOARD_ORIGIN: "https://dashboard.example",
    });
  });
});
