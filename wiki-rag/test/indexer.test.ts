import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureSchema } from "../src/schema";
import { indexMarkdownDir, searchLexical } from "../src/indexer";

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
});
