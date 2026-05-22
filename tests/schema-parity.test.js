import { SCHEMA_DDL } from "../packages/core/src/schema.js";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert";

function extractCreateTableStatements(sql) {
  const seen = new Map();
  const regex = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([^;]+)\)/gi;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    const tableName = match[1];
    const body = match[2];
    // Extract column names
    const columns = body
      .split(",")
      .map((line) => {
        const colMatch = line.trim().match(/^(\w+)/);
        return colMatch ? colMatch[1] : null;
      })
      .filter(Boolean)
      .sort();
    seen.set(tableName, { tableName, columns });
  }
  return Array.from(seen.values()).sort((a, b) => a.tableName.localeCompare(b.tableName));
}

const migrationFiles = ["apps/api/migrations/0001_init.sql", "apps/api/migrations/0002_billing.sql"];

let migrationSql = "";
for (const file of migrationFiles) {
  try {
    migrationSql += "\n" + readFileSync(file, "utf-8");
  } catch {
    console.warn(`Migration file not found: ${file}`);
  }
}

const schemaTables = extractCreateTableStatements(SCHEMA_DDL);
const migrationTables = extractCreateTableStatements(migrationSql);

test("schema parity: all tables match between schema.js and migrations", () => {
  const schemaNames = schemaTables.map((t) => t.tableName);
  const migrationNames = migrationTables.map((t) => t.tableName);
  
  assert.deepStrictEqual(
    schemaNames,
    migrationNames,
    `Table mismatch: schema has [${schemaNames.join(", ")}], migrations have [${migrationNames.join(", ")}]`
  );
  
  for (const schemaTable of schemaTables) {
    const migrationTable = migrationTables.find((t) => t.tableName === schemaTable.tableName);
    assert(migrationTable, `Table ${schemaTable.tableName} missing from migrations`);
    assert.deepStrictEqual(
      schemaTable.columns,
      migrationTable.columns,
      `Column mismatch in ${schemaTable.tableName}: schema has [${schemaTable.columns.join(", ")}], migrations have [${migrationTable.columns.join(", ")}]`
    );
  }
});
