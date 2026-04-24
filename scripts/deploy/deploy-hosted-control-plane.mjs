import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { resolveHostedManifest } from "./resolve-hosted-manifest.mjs";

function parseJsonc(text) {
  return JSON.parse(
    text
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
  );
}

function runCommand(command, args, options, errorCode) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(errorCode);
  }
}

function requirePublicVars(deployable) {
  for (const [key, value] of Object.entries(deployable.publicVars ?? {})) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`deploy_manifest_missing_public_var:${key}`);
    }
  }
}

function writeGeneratedConfig({ rootDir, deployableName, deployable }) {
  const sourceConfigPath = path.join(rootDir, deployable.wranglerConfig);
  const sourceConfig = parseJsonc(fs.readFileSync(sourceConfigPath, "utf8"));
  const mergedConfig = {
    ...sourceConfig,
    vars: {
      ...(sourceConfig.vars ?? {}),
      ...(deployable.publicVars ?? {}),
    },
  };

  const generatedDir = path.join(rootDir, deployable.workdir, ".wrangler");
  fs.mkdirSync(generatedDir, { recursive: true });
  const generatedConfigPath = path.join(
    generatedDir,
    `skillpack.generated.${deployableName}.json`
  );
  fs.writeFileSync(generatedConfigPath, JSON.stringify(mergedConfig, null, 2) + "\n");
  return generatedConfigPath;
}

function printRequiredBindings(resolved) {
  const summary = Object.fromEntries(
    Object.entries(resolved.deployables).map(([name, deployable]) => [
      name,
      {
        publicVars: Object.keys(deployable.publicVars ?? {}),
        secrets: [...(deployable.secrets ?? [])],
      },
    ])
  );
  process.stdout.write(
    JSON.stringify(
      {
        deployManifestBindings: summary,
      },
      null,
      2
    ) + "\n"
  );
}

function deployWithResolvedVars({ rootDir, deployableName, deployable }) {
  requirePublicVars(deployable);
  const generatedConfigPath = writeGeneratedConfig({
    rootDir,
    deployableName,
    deployable,
  });

  if (deployableName === "api") {
    runCommand(
      "bun",
      ["run", "--cwd", deployable.workdir, "d1:migrate:remote"],
      { cwd: rootDir },
      "deploy_api_remote_migration_failed"
    );
  }

  runCommand(
    "bunx",
    [
      "wrangler",
      "deploy",
      "--cwd",
      deployable.workdir,
      "--config",
      generatedConfigPath,
    ],
    { cwd: rootDir },
    `deploy_failed:${deployableName}`
  );
}

if (import.meta.main) {
  const rootDir = process.cwd();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(rootDir, "deploy/hosted-control-plane.manifest.json"), "utf8")
  );
  const inputs = JSON.parse(process.argv[2]);
  const resolved = resolveHostedManifest(manifest, inputs);
  printRequiredBindings(resolved);
  for (const [name, deployable] of Object.entries(resolved.deployables)) {
    deployWithResolvedVars({ rootDir, deployableName: name, deployable });
  }
}
