import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureSchema } from "../src/schema";
import { indexMarkdownDir, searchLexical } from "../src/indexer";

function makeVault(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-rag-e2e-"));

  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }

  return dir;
}

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const decoder = new TextDecoder();

function runCli(args: string[]) {
  return Bun.spawnSync(["bun", "wiki-rag/src/cli.ts", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("wiki-rag e2e", () => {
  test("indexes markdown, persists to sqlite, and reports stats through the CLI boundary", async () => {
    const vaultDir = makeVault({
      "alpha.md": "# Alpha\n\nHospital intake policy baseline.\n\n## Escalation\nNotify the on-call lead.",
      "nested/beta.md": "# Beta\n\nUnrelated note.\n\n## Follow-up\nHospital discharge checklist.",
      "ignore.txt": "Hospital text in a non-markdown file should not be indexed.",
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-rag-db-"));
    const dbPath = path.join(tempDir, "wiki-rag.db");

    try {
      const db = new Database(dbPath);
      ensureSchema(db);
      await indexMarkdownDir(db, vaultDir);
      db.close();

      const statsResult = runCli(["stats", "--db", dbPath]);
      expect(statsResult.exitCode).toBe(0);
      expect(decoder.decode(statsResult.stderr)).toBe("");

      const payload = JSON.parse(decoder.decode(statsResult.stdout)) as { docs: number; chunks: number };
      expect(payload.docs).toBeGreaterThan(0);
      expect(payload.chunks).toBeGreaterThan(0);

      const reopened = new Database(dbPath);
      const hits = searchLexical(reopened, "Hospital");
      reopened.close();

      expect(hits.length).toBeGreaterThan(0);
      expect(hits.map((hit) => hit.path)).toContain("alpha.md");
      expect(hits.map((hit) => hit.path)).toContain("nested/beta.md");
      expect(hits.some((hit) => hit.path.endsWith(".txt"))).toBe(false);
      expect(hits[0].text.toLowerCase()).toContain("hospital");
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
