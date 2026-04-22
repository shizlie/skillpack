import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { indexMarkdownDir, searchLexical } from "../src/indexer";
import { ensureSchema, listTables } from "../src/schema";

describe("indexer", () => {
  test("indexes markdown files into documents/chunks/fts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-rag-index-"));
    fs.mkdirSync(path.join(root, "nested"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "nested", "alpha.md"),
      "# Alpha\nHospital policy baseline\n\n## Notes\nEscalate immediately.",
      "utf8",
    );
    fs.writeFileSync(path.join(root, "ignore.txt"), "Hospital should not be indexed", "utf8");

    const db = new Database(":memory:");
    ensureSchema(db);

    await indexMarkdownDir(db, root);

    const hits = searchLexical(db, "Hospital");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toContain("nested/alpha.md");
    expect(hits[0].text).toContain("Hospital policy baseline");
  });

  test("reindex prunes deleted markdown files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-rag-prune-"));
    const keepPath = path.join(root, "keep.md");
    const dropPath = path.join(root, "drop.md");

    fs.writeFileSync(keepPath, "# Keep\nHospital stays indexed", "utf8");
    fs.writeFileSync(dropPath, "# Drop\nThis document will be removed", "utf8");

    const db = new Database(":memory:");
    ensureSchema(db);

    await indexMarkdownDir(db, root);
    fs.unlinkSync(dropPath);

    await indexMarkdownDir(db, root);

    expect(searchLexical(db, "removed")).toEqual([]);
    expect(searchLexical(db, "Hospital").map((hit) => hit.path)).toEqual(["keep.md"]);

    const docs = db.query("SELECT path FROM documents ORDER BY path").all() as Array<{ path: string }>;
    expect(docs).toEqual([{ path: "keep.md" }]);

    const chunks = db.query("SELECT COUNT(*) AS count FROM chunks").all() as Array<{ count: number }>;
    const ftsRows = db.query("SELECT COUNT(*) AS count FROM chunks_fts").all() as Array<{ count: number }>;
    expect(chunks[0].count).toBe(1);
    expect(ftsRows[0].count).toBe(1);
  });

  test("searchLexical returns empty results for malformed queries", () => {
    const db = new Database(":memory:");
    ensureSchema(db);

    expect(() => searchLexical(db, '"')).not.toThrow();
    expect(searchLexical(db, '"')).toEqual([]);
  });

  test("searchLexical falls back to sanitized tokens for punctuation-heavy queries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-rag-sanitize-"));
    fs.writeFileSync(
      path.join(root, "policy.md"),
      "# Policy\nfoo-bar rollout policy: escalate to compliance.",
      "utf8",
    );

    const db = new Database(":memory:");
    ensureSchema(db);

    await indexMarkdownDir(db, root);

    expect(searchLexical(db, "foo-bar").map((hit) => hit.path)).toEqual(["policy.md"]);
    expect(searchLexical(db, "policy:").map((hit) => hit.path)).toEqual(["policy.md"]);
  });
});

describe("schema", () => {
  test("ensureSchema creates required tables", () => {
    const db = new Database(":memory:");
    ensureSchema(db);

    const tables = listTables(db);
    expect(tables).toHaveLength(3);
    expect(tables).toEqual(["chunks", "chunks_fts", "documents"]);
  });

  test("listTables ignores extra non-canonical tables", () => {
    const db = new Database(":memory:");
    ensureSchema(db);
    db.run("CREATE TABLE tmp_debug (id INTEGER PRIMARY KEY)");

    const tables = listTables(db);
    expect(tables).toHaveLength(3);
    expect(tables).toEqual(["chunks", "chunks_fts", "documents"]);
  });
});
