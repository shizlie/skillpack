import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSchema, listTables } from "../src/schema";

describe("schema", () => {
  test("ensureSchema creates required tables", () => {
    const db = new Database(":memory:");
    ensureSchema(db);

    const tables = listTables(db);
    expect(tables).toHaveLength(3);
    expect(tables).toEqual(["chunks", "chunks_fts", "documents"]);
  });
});
