import { parseArgs } from "node:util";
import { createLicenseFetchHandler } from "@skillpack/core";
import { createBetterSqlite3LeaseStore } from "@skillpack/core/storage-better-sqlite3";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readKeyFromEnvOrFile } from "./key-utils.js";
import { serveSelfHostedDashboard } from "./dashboard.js";
import { runMigrations } from "./db-migrate.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3001" },
    db: { type: "string", default: "./skillpack.db" },
    "api-key": { type: "string" },
    "signing-private-key": { type: "string" },
    "signing-public-key": { type: "string" },
    dashboard: { type: "boolean", default: true },
    migrate: { type: "boolean", default: true },
  },
});

const signingPrivateKeyPem = readKeyFromEnvOrFile(
  "SKILLPACK_SIGNING_PRIVATE_KEY_PEM",
  values["signing-private-key"]
);
const signingPublicKeyPem = readKeyFromEnvOrFile(
  "SKILLPACK_SIGNING_PUBLIC_KEY_PEM",
  values["signing-public-key"]
);
const managementApiKey = values["api-key"] ?? process.env.SKILLPACK_API_KEY;

if (!managementApiKey) {
  console.error("FATAL: --api-key or SKILLPACK_API_KEY required");
  process.exit(1);
}

if (!signingPrivateKeyPem || !signingPublicKeyPem) {
  console.error("FATAL: --signing-private-key and --signing-public-key (or env vars) required");
  process.exit(1);
}

const leaseStore = createBetterSqlite3LeaseStore({ dbPath: values.db });

function getDefaultMigrationsDir() {
  const packagedMigrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));
  if (existsSync(packagedMigrationsDir)) {
    return packagedMigrationsDir;
  }
  return fileURLToPath(new URL("../../api/migrations/", import.meta.url));
}

// Access the raw db for migrations
if (values.migrate && leaseStore.db) {
  const migrationsDir =
    process.env.SKILLPACK_MIGRATIONS_DIR ??
    getDefaultMigrationsDir();
  runMigrations(leaseStore.db, { migrationsDir });
} else if (values.migrate) {
  console.warn("WARNING: Cannot run migrations — leaseStore.db not exposed");
}

const handler = createLicenseFetchHandler({
  signingPrivateKeyPem,
  signingPublicKeyPem,
  managementApiKey,
  leaseStore,
});

const app = new Hono();
app.all("/v1/*", (c) => handler(c.req.raw));
app.get("/healthz", (c) => c.json({ status: "ok", mode: "self-hosted" }));

if (values.dashboard) {
  app.get("/*", serveSelfHostedDashboard({ apiKey: managementApiKey }));
}

serve({ fetch: app.fetch, port: Number(values.port) });
console.log(`skillpack self-hosted listening on :${values.port}`);
console.log(`  database: ${values.db}`);
console.log(`  dashboard: ${values.dashboard ? "enabled" : "disabled"}`);
console.log(`  tsa: manual-attestation mode (record via POST /v1/tsa/manual-attest or skillpack CLI)`);
