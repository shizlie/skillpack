import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSchema, listTables } from "../src/schema";

describe("schema", () => {
  test("ensureSchema creates required tables", () => {
    const db = new Database(":memory:");
    ensureSchema(db);

    const tables = listTables(db);
    expect(tables).toContain("documents");
    expect(tables).toContain("chunks");
    expect(tables).toContain("chunks_fts");
  });
});
