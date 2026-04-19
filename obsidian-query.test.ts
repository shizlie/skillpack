import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ObsidianGraph } from "./obsidian-query";

const tempDirs: string[] = [];

function makeVault(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-graph-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ObsidianGraph", () => {
  test("ingest + query returns expanded context for linked notes", async () => {
    const vault = makeVault({
      "Alpha.md": "Cybersecurity controls for hospitals. [[Beta|Runbook]]",
      "Beta.md": "Incident response checklist and escalation path.",
    });
    const graph = new ObsidianGraph();
    await graph.ingest(vault);

    const context = graph.query("Cybersecurity");
    expect(context).toContain("PRIMARY NOTE: Alpha");
    expect(context).toContain("RELATED CONTEXT FROM LINKS");
    expect(context).toContain("Related: Beta");
  });

  test("query returns no-match message when keyword is absent", async () => {
    const vault = makeVault({
      "Only.md": "Single file with no relevant keyword",
    });
    const graph = new ObsidianGraph();
    await graph.ingest(vault);

    expect(graph.query("nonexistent-keyword")).toBe("No matches found.");
  });

  test("getContext returns empty string for unknown note id", () => {
    const graph = new ObsidianGraph();
    expect(graph.getContext("missing-note")).toBe("");
  });
});
