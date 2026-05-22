import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(repoRoot, "apps", "self-hosted");
const outputRoot = path.join(packageRoot, "dist", "npm");

function toNpmVersion(version) {
  const parts = version.trim().split(".");
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
    return `${parts[0]}.${parts[1]}.${parts[2]}-${parts[3]}`;
  }
  return version.trim();
}

rmSync(outputRoot, { force: true, recursive: true });
mkdirSync(outputRoot, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(packageRoot, "src", "cli.js")],
  external: ["better-sqlite3"],
  outdir: outputRoot,
  target: "node",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const bundledCli = path.join(outputRoot, "cli.js");
const cliSource = readFileSync(bundledCli, "utf8");
writeFileSync(bundledCli, `#!/usr/bin/env node\n${cliSource}`, { mode: 0o755 });

cpSync(path.join(repoRoot, "apps", "api", "migrations"), path.join(outputRoot, "migrations"), {
  recursive: true,
});

const packageVersion = toNpmVersion(readFileSync(path.join(repoRoot, "VERSION"), "utf8"));
writeFileSync(
  path.join(outputRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "@skillpack/self-hosted",
      version: packageVersion,
      description: "Self-hosted Skillpack control plane for Node and SQLite.",
      type: "module",
      bin: { "skillpack-server": "cli.js" },
      files: ["cli.js", "migrations/"],
      dependencies: {
        "better-sqlite3": "^11.8.2",
      },
      engines: { node: ">=20.0.0" },
    },
    null,
    2
  )}\n`
);
