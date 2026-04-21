import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureSchema } from "../src/schema";
import { indexMarkdownDir, searchLexical } from "../src/indexer";

const tempDirs: string[] = [];

function makeVault(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-rag-e2e-"));
  tempDirs.push(dir);

  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }

  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("wiki-rag e2e", () => {
  test("indexes markdown and returns lexical hits from the same database", async () => {
    const vault = makeVault({
      "alpha.md": "# Alpha\n\nHospital intake policy baseline.\n\n## Escalation\nNotify the on-call lead.",
      "nested/beta.md": "# Beta\n\nUnrelated note.\n\n## Follow-up\nHospital discharge checklist.",
      "ignore.txt": "Hospital text in a non-markdown file should not be indexed.",
    });

    const db = new Database(":memory:");
    ensureSchema(db);

    await indexMarkdownDir(db, vault);

    const hits = searchLexical(db, "Hospital");

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((hit) => hit.path)).toContain("alpha.md");
    expect(hits.map((hit) => hit.path)).toContain("nested/beta.md");
    expect(hits.some((hit) => hit.path.endsWith(".txt"))).toBe(false);
    expect(hits[0].text.toLowerCase()).toContain("hospital");
  });
});
