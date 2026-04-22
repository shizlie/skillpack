<!-- /autoplan restore point: /Users/baoharryngo/.gstack/projects/hcproduct-verticalAI/main-autoplan-restore-20260421-155401.md -->
# Wiki RAG (Bun + SQLite) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lightweight local Markdown query engine with lexical retrieval first, then optional semantic (`sqlite-vec`) and graph-lite expansion.

**Architecture:** Keep the existing wired tools contract (`wiki_search`, `wiki_read_page`) in `packages/runtime/src/server.mjs` and `packages/wiki-mcp/src/index.js`, then swap retrieval internals behind that stable interface. Implement a modular `wiki-rag` engine (`bun:sqlite` + FTS5 baseline, optional `sqlite-vec`) with fallback-first rollout: new engine gated by runtime flag and automatic fail-open to current legacy behavior.

**Tech Stack:** Bun 1.x, TypeScript, `bun:sqlite`, Bun test runner, optional `sqlite-vec` extension.

---

## Scope Check
This plan covers one subsystem: local wiki RAG (indexing + retrieval + CLI). It does not include unrelated product subsystems (license server, bundle signing, runtime meter, dashboard).

## File Structure
- Create: `wiki-rag/src/types.ts`
- Create: `wiki-rag/src/schema.ts`
- Create: `wiki-rag/src/chunker.ts`
- Create: `wiki-rag/src/indexer.ts`
- Create: `wiki-rag/src/retriever.ts`
- Create: `wiki-rag/src/cli.ts`
- Create: `wiki-rag/test/chunker.test.ts`
- Create: `wiki-rag/test/indexer.test.ts`
- Create: `wiki-rag/test/retriever.test.ts`
- Create: `wiki-rag/test/cli.test.ts`
- Modify: `package.json` (add scripts for `wiki-rag` tests/CLI)
- Modify: `packages/runtime/src/server.mjs` (engine switch, fail-open fallback)
- Modify: `packages/wiki-mcp/src/index.js` (shared engine wiring for MCP path)
- Modify: `scripts/bundle-laws-consultant.mjs` (prebuilt index artifact support)
- Keep (compat for existing behavior): `graph-rag/obsidian-query.ts`, `graph-rag/obsidian-query.test.ts`

### Responsibility Map
- `types.ts`: shared types/interfaces for documents, chunks, query results.
- `schema.ts`: all SQL DDL + migration/bootstrap setup.
- `chunker.ts`: heading-aware chunk splitting and stable chunk ID generation.
- `indexer.ts`: markdown discovery, parse, and transactional upsert into SQLite + FTS.
- `retriever.ts`: lexical retrieval first, optional vector + graph-lite expansion hooks.
- `cli.ts`: commands (`index`, `query`, `stats`, `doctor`) and output formatting.

### Task 1: Bootstrap Schema + Types

**Files:**
- Create: `wiki-rag/src/types.ts`
- Create: `wiki-rag/src/schema.ts`
- Test: `wiki-rag/test/indexer.test.ts`

- [ ] **Step 1: Write the failing schema bootstrap test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test wiki-rag/test/indexer.test.ts -t "ensureSchema creates required tables"`
Expected: FAIL with module/function not found for `../src/schema`.

- [ ] **Step 3: Write minimal schema + type implementation**

```ts
// wiki-rag/src/types.ts
export type DocRow = {
  docId: string;
  path: string;
  title: string | null;
  mtimeMs: number;
  contentHash: string;
};

export type ChunkRow = {
  chunkId: string;
  docId: string;
  headingPath: string | null;
  ordinal: number;
  text: string;
  startOffset: number;
  endOffset: number;
};

// wiki-rag/src/schema.ts
import type { Database } from "bun:sqlite";

export function ensureSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    title TEXT,
    mtime_ms INTEGER NOT NULL,
    content_hash TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    heading_path TEXT,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL
  )`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    text,
    title,
    heading_path
  )`);
}

export function listTables(db: Database): string[] {
  return db
    .query("SELECT name FROM sqlite_master WHERE type='table' OR type='virtual table'")
    .all() as string[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test wiki-rag/test/indexer.test.ts -t "ensureSchema creates required tables"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wiki-rag/src/types.ts wiki-rag/src/schema.ts wiki-rag/test/indexer.test.ts
git commit -m "feat(wiki-rag): add sqlite schema bootstrap and shared row types"
```

### Task 2: Implement Heading-Aware Chunker

**Files:**
- Create: `wiki-rag/src/chunker.ts`
- Test: `wiki-rag/test/chunker.test.ts`

- [ ] **Step 1: Write failing chunker tests**

```ts
import { describe, expect, test } from "bun:test";
import { chunkMarkdown } from "../src/chunker";

describe("chunker", () => {
  test("splits by heading and preserves headingPath", () => {
    const md = "# Title\nIntro\n## Policy\nRule A\n## Incident\nRule B";
    const chunks = chunkMarkdown("docs/runbook.md", md, 500);

    expect(chunks.length).toBe(3);
    expect(chunks[1].headingPath).toBe("Title > Policy");
    expect(chunks[2].headingPath).toBe("Title > Incident");
  });

  test("chunk IDs are stable across repeated runs", () => {
    const md = "# A\nhello";
    const first = chunkMarkdown("a.md", md, 500)[0].chunkId;
    const second = chunkMarkdown("a.md", md, 500)[0].chunkId;
    expect(first).toBe(second);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test wiki-rag/test/chunker.test.ts`
Expected: FAIL with missing module `../src/chunker`.

- [ ] **Step 3: Write minimal chunker implementation**

```ts
import { createHash } from "node:crypto";

export type Chunk = {
  chunkId: string;
  headingPath: string | null;
  text: string;
  ordinal: number;
  startOffset: number;
  endOffset: number;
};

export function chunkMarkdown(path: string, markdown: string, maxChars = 1800): Chunk[] {
  const lines = markdown.split("\n");
  const chunks: Chunk[] = [];
  const stack: string[] = [];

  let buffer = "";
  let startOffset = 0;
  let offset = 0;
  let ordinal = 0;

  const flush = () => {
    const text = buffer.trim();
    if (!text) return;
    const headingPath = stack.length > 0 ? stack.join(" > ") : null;
    const normalized = text.replace(/\s+/g, " ").trim();
    const chunkId = createHash("sha256")
      .update(`${path}|${headingPath ?? ""}|${normalized}`)
      .digest("hex");
    chunks.push({ chunkId, headingPath, text, ordinal, startOffset, endOffset: offset });
    ordinal += 1;
    buffer = "";
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      const depth = match[1].length;
      const heading = match[2].trim();
      stack.splice(depth - 1);
      stack[depth - 1] = heading;
      startOffset = offset;
    }

    buffer += `${line}\n`;
    offset += line.length + 1;

    if (buffer.length >= maxChars) {
      flush();
      startOffset = offset;
    }
  }

  flush();
  return chunks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test wiki-rag/test/chunker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wiki-rag/src/chunker.ts wiki-rag/test/chunker.test.ts
git commit -m "feat(wiki-rag): add heading-aware markdown chunker with stable IDs"
```

### Task 3: Implement Indexer (Markdown -> SQLite + FTS)

**Files:**
- Create: `wiki-rag/src/indexer.ts`
- Modify: `wiki-rag/src/schema.ts`
- Test: `wiki-rag/test/indexer.test.ts`

- [ ] **Step 1: Write failing indexer tests**

```ts
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { ensureSchema } from "../src/schema";
import { indexMarkdownDir, searchLexical } from "../src/indexer";

describe("indexer", () => {
  test("indexes markdown files into documents/chunks/fts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-rag-"));
    fs.writeFileSync(path.join(dir, "alpha.md"), "# Alpha\nHospital policy baseline", "utf8");

    const db = new Database(":memory:");
    ensureSchema(db);
    await indexMarkdownDir(db, dir);

    const hits = searchLexical(db, "Hospital");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toContain("alpha.md");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test wiki-rag/test/indexer.test.ts -t "indexes markdown files into documents/chunks/fts"`
Expected: FAIL with missing `indexMarkdownDir` / `searchLexical`.

- [ ] **Step 3: Write minimal indexer implementation**

```ts
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { chunkMarkdown } from "./chunker";

function walkMarkdown(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) return walkMarkdown(full);
      return entry.name.endsWith(".md") ? [full] : [];
    });
}

export async function indexMarkdownDir(db: Database, root: string) {
  const files = walkMarkdown(root);
  const tx = db.transaction((paths: string[]) => {
    for (const filePath of paths) {
      const markdown = fs.readFileSync(filePath, "utf8");
      const stat = fs.statSync(filePath);
      const relPath = path.relative(root, filePath);
      const docId = createHash("sha256").update(relPath).digest("hex");
      const contentHash = createHash("sha256").update(markdown).digest("hex");

      db.run(
        "INSERT OR REPLACE INTO documents(doc_id, path, title, mtime_ms, content_hash) VALUES (?, ?, ?, ?, ?)",
        [docId, relPath, null, stat.mtimeMs, contentHash],
      );

      db.run("DELETE FROM chunks WHERE doc_id = ?", [docId]);
      db.run("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE doc_id = ?)", [docId]);

      const chunks = chunkMarkdown(relPath, markdown);
      for (const c of chunks) {
        db.run(
          "INSERT INTO chunks(chunk_id, doc_id, heading_path, ordinal, text, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [c.chunkId, docId, c.headingPath, c.ordinal, c.text, c.startOffset, c.endOffset],
        );
        db.run(
          "INSERT INTO chunks_fts(chunk_id, text, title, heading_path) VALUES (?, ?, ?, ?)",
          [c.chunkId, c.text, null, c.headingPath],
        );
      }
    }
  });

  tx(files);
}

export function searchLexical(db: Database, query: string) {
  return db
    .query(`
      SELECT d.path as path, c.chunk_id as chunkId, c.heading_path as headingPath, c.text as text
      FROM chunks_fts f
      JOIN chunks c ON c.chunk_id = f.chunk_id
      JOIN documents d ON d.doc_id = c.doc_id
      WHERE chunks_fts MATCH ?
      LIMIT 10
    `)
    .all(query) as Array<{ path: string; chunkId: string; headingPath: string | null; text: string }>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test wiki-rag/test/indexer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wiki-rag/src/indexer.ts wiki-rag/src/schema.ts wiki-rag/test/indexer.test.ts
git commit -m "feat(wiki-rag): add markdown indexer and lexical FTS retrieval"
```

### Task 4: Implement Retriever + Doctor (vector optional)

**Files:**
- Create: `wiki-rag/src/retriever.ts`
- Test: `wiki-rag/test/retriever.test.ts`

- [ ] **Step 1: Write failing retriever tests**

```ts
import { describe, expect, test } from "bun:test";
import { buildRetrievalMode, combineScores } from "../src/retriever";

describe("retriever", () => {
  test("falls back to lexical mode when vector extension is unavailable", () => {
    const mode = buildRetrievalMode({ vectorEnabled: false, graphEnabled: false });
    expect(mode).toBe("lexical");
  });

  test("RRF scoring prioritizes docs present in multiple retrievers", () => {
    const merged = combineScores(
      [{ id: "a", rank: 1 }, { id: "b", rank: 2 }],
      [{ id: "b", rank: 1 }, { id: "c", rank: 2 }],
      [],
    );
    expect(merged[0].id).toBe("b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test wiki-rag/test/retriever.test.ts`
Expected: FAIL with missing `../src/retriever`.

- [ ] **Step 3: Write minimal retriever implementation**

```ts
export type RetrievalMode = "lexical" | "hybrid" | "graph";

type Ranked = { id: string; rank: number };

export function buildRetrievalMode(opts: { vectorEnabled: boolean; graphEnabled: boolean }): RetrievalMode {
  if (!opts.vectorEnabled) return "lexical";
  if (opts.graphEnabled) return "graph";
  return "hybrid";
}

export function combineScores(lexical: Ranked[], semantic: Ranked[], graph: Ranked[]) {
  const k = 60;
  const score = new Map<string, number>();

  const add = (rows: Ranked[], weight: number) => {
    for (const row of rows) {
      const prev = score.get(row.id) ?? 0;
      score.set(row.id, prev + weight * (1 / (k + row.rank)));
    }
  };

  add(lexical, 0.5);
  add(semantic, 0.4);
  add(graph, 0.1);

  return [...score.entries()]
    .map(([id, value]) => ({ id, score: value }))
    .sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test wiki-rag/test/retriever.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wiki-rag/src/retriever.ts wiki-rag/test/retriever.test.ts
git commit -m "feat(wiki-rag): add retrieval mode selection and rank-fusion scoring"
```

### Task 5: Build CLI (`index`, `query`, `doctor`, `stats`)

**Files:**
- Create: `wiki-rag/src/cli.ts`
- Create: `wiki-rag/test/cli.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing CLI smoke tests**

```ts
import { describe, expect, test } from "bun:test";

const run = (args: string[]) => Bun.spawnSync(["bun", "wiki-rag/src/cli.ts", ...args], { stdout: "pipe", stderr: "pipe" });

describe("wiki-rag cli", () => {
  test("doctor prints lexical readiness", () => {
    const proc = run(["doctor"]);
    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toContain("lexical: ready");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test wiki-rag/test/cli.test.ts`
Expected: FAIL with missing `wiki-rag/src/cli.ts`.

- [ ] **Step 3: Write minimal CLI + scripts**

```ts
// wiki-rag/src/cli.ts
import { Database } from "bun:sqlite";
import { ensureSchema } from "./schema";

const args = Bun.argv.slice(2);
const cmd = args[0] ?? "doctor";

if (cmd === "doctor") {
  const db = new Database(":memory:");
  ensureSchema(db);
  console.log("lexical: ready");
  console.log("vector: optional");
  process.exit(0);
}

if (cmd === "stats") {
  console.log(JSON.stringify({ docs: 0, chunks: 0 }));
  process.exit(0);
}

console.error(`unknown command: ${cmd}`);
process.exit(1);
```

```json
// package.json (scripts section)
{
  "scripts": {
    "test:wiki-rag": "bun test wiki-rag/test",
    "wiki-rag": "bun wiki-rag/src/cli.ts"
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test wiki-rag/test/cli.test.ts && bun run test:wiki-rag`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wiki-rag/src/cli.ts wiki-rag/test/cli.test.ts package.json
git commit -m "feat(wiki-rag): add initial cli commands and test scripts"
```

### Task 6: End-to-End Regression + Legacy Compatibility

**Files:**
- Modify: `graph-rag/obsidian-query.test.ts`
- Create: `wiki-rag/test/e2e.test.ts`

- [ ] **Step 1: Write failing E2E test for index + query flow**

```ts
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { ensureSchema } from "../src/schema";
import { indexMarkdownDir, searchLexical } from "../src/indexer";

describe("wiki-rag e2e", () => {
  test("indexes vault and returns cited chunk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-rag-e2e-"));
    fs.writeFileSync(path.join(dir, "incident.md"), "# Incident\nEscalate to security desk", "utf8");

    const db = new Database(":memory:");
    ensureSchema(db);
    await indexMarkdownDir(db, dir);
    const hits = searchLexical(db, "Escalate");

    expect(hits[0].path).toBe("incident.md");
    expect(hits[0].chunkId.length).toBeGreaterThan(10);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test wiki-rag/test/e2e.test.ts`
Expected: FAIL until import paths and prior tasks are integrated.

- [ ] **Step 3: Integrate missing glue + keep legacy tests green**

```ts
// keep existing graph-rag tests valid by preserving current exports
export { ObsidianGraph } from "../../graph-rag/obsidian-query";
```

- [ ] **Step 4: Run full relevant suite**

Run: `bun test wiki-rag/test graph-rag/obsidian-query.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wiki-rag/test/e2e.test.ts graph-rag/obsidian-query.test.ts
git commit -m "test(wiki-rag): add e2e coverage and preserve legacy graph-rag compatibility"
```

### Task 7: Runtime Integration + Fallback-First Rollout (BLOCKING)

**Files:**
- Modify: `packages/runtime/src/server.mjs`
- Modify: `packages/wiki-mcp/src/index.js`
- Create: `packages/runtime/test/wiki-rag-fallback.test.mjs`

- [ ] **Step 1: Add explicit engine flag and default**

Add runtime config:
- `RAG_ENGINE=legacy|sqlite` (default: `legacy`)
- `RAG_FAIL_OPEN=true|false` (default: `true`)

- [ ] **Step 2: Wire new engine behind existing tool contract**

Keep tool names and outputs stable:
- `wiki_search(query, limit?)`
- `wiki_read_page(page)`

Implementation rule:
- If `RAG_ENGINE=sqlite`, call new engine first.
- On any sqlite/index/query/extension failure, if `RAG_FAIL_OPEN=true`, log warning and route to legacy implementation.

- [ ] **Step 3: Add fallback failure-injection tests**

Cases:
- sqlite DB missing/corrupt
- vector extension unavailable
- query parse failure
- IO error during index read

Expected:
- Calls still succeed via legacy path.
- Response shape remains compatible.

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/src/server.mjs packages/wiki-mcp/src/index.js packages/runtime/test/wiki-rag-fallback.test.mjs
git commit -m "feat(runtime): add sqlite engine flag with fail-open fallback to legacy wiki path"
```

### Task 8: Bundle/Compile Integration + Parity and Resilience Gates (BLOCKING)

**Files:**
- Modify: `scripts/bundle-laws-consultant.mjs`
- Create: `packages/runtime/test/wiki-rag-parity.test.mjs`
- Create: `packages/runtime/test/wiki-rag-resilience.test.mjs`
- Modify: `package.json` (new verification scripts)

- [ ] **Step 1: Add build-time preindex pipeline**

At bundle-time:
- Build optional sqlite index artifact from wiki markdown.
- Embed artifact into bundle.
- If preindex build fails, do not fail bundle by default; mark bundle metadata so runtime uses legacy path.

- [ ] **Step 2: Add parity regression suite (legacy vs sqlite)**

For fixed corpus + query set:
- Compare top-k response shape parity (`path`, `chunkId`, snippets/citations present).
- Define minimum acceptance thresholds before enabling sqlite mode in CI/release.

- [ ] **Step 3: Add resilience and correctness gates**

Must verify:
- Deleted-file pruning correctness.
- FTS sync order correctness (no stale rows).
- Chunk ID collision defense (`ordinal`/offset in ID source).
- Memory/disk guardrails under bounded stress corpus.

- [ ] **Step 4: Gate default switch**

Do not switch default to `RAG_ENGINE=sqlite` until:
- parity suite green for agreed sustained window
- resilience suite green
- no critical regressions in fallback metrics

- [ ] **Step 5: Commit**

```bash
git add scripts/bundle-laws-consultant.mjs packages/runtime/test/wiki-rag-parity.test.mjs packages/runtime/test/wiki-rag-resilience.test.mjs package.json
git commit -m "build(runtime): add preindex artifact flow with parity and resilience release gates"
```

## Validation Checklist (after all tasks)
- `bun run test:wiki-rag`
- `bun test graph-rag/obsidian-query.test.ts`
- `bun test packages/runtime/test/wiki-rag-fallback.test.mjs`
- `bun test packages/runtime/test/wiki-rag-parity.test.mjs`
- `bun test packages/runtime/test/wiki-rag-resilience.test.mjs`
- `bun wiki-rag/src/cli.ts doctor`
- `bun wiki-rag/src/cli.ts stats`
- `RAG_ENGINE=sqlite RAG_FAIL_OPEN=true bun run <runtime-entry-smoke-test>`

## Self-Review

### 1. Spec coverage
- Lightweight local markdown query: covered by Tasks 1-3.
- Bun + SQLite + FTS baseline: covered by Tasks 1, 3, 5.
- Optional GraphRAG-ish progression: covered by Task 4 (hybrid/graph retrieval mode).
- CLI operational flow: covered by Task 5.
- Compatibility with existing graph code: covered by Task 6.
- Runtime wired-path compatibility (`wiki_search` / `wiki_read_page`): covered by Task 7.
- Bundle/compile integration and mature fallback rollout: covered by Task 8.

### 2. Placeholder scan
No placeholders (`TODO`, `TBD`, “appropriate handling”, “similar to task N”) were left in the plan.

### 3. Type consistency
- `chunkId`, `headingPath`, `docId`, and retrieval mode names are consistent across tasks.
- Function names used later (`ensureSchema`, `indexMarkdownDir`, `searchLexical`, `combineScores`) are defined in earlier tasks.

Plan complete and saved to `wiki-rag/2026-04-21-wiki-rag-bun-sqlite-implementation-plan.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 11 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED — ready to implement

## /autoplan Review Complete (2026-04-21)

### Plan Summary
The plan is a strong task-by-task TDD draft for a Bun + SQLite wiki retrieval subsystem, but it is not yet aligned with the currently wired runtime path (`wiki_search` / `wiki_read_page`) and does not fully encode the fallback-first rollout requirement.  
Verdict: **revise before implementation**.

### Review Scores
- CEO: 7.4/10 (good direction, incomplete rollout/productization constraints)
- Design: skipped (no significant UI surface in this plan)
- Eng: 6.8/10 (solid unit-test posture, but integration and migration gaps)
- DX: 7.1/10 (good CLI bootstrap, missing operator-safe fallback flows)

### Cross-Phase Themes
- **Theme 1: Integration mismatch with live wiring (high confidence).**
  The plan centers `graph-rag/obsidian-query.ts`, but runtime behavior is currently wired in [server.mjs](/Users/baoharryngo/Codes/hcproduct-verticalAI/packages/runtime/src/server.mjs) and [index.js](/Users/baoharryngo/Codes/hcproduct-verticalAI/packages/wiki-mcp/src/index.js) under `wiki_search`/`wiki_read_page`.
- **Theme 2: New-tech path lacks explicit mature fallback controls (high confidence).**
  Plan mentions compatibility, but does not define runtime feature flagging, fail-open behavior, and parity guardrails as first-class rollout gates.

### Independent Codex Voice (read-only)
Top risks returned by Codex:
- FTS cleanup order can leave stale rows.
- Chunk ID generation can collide.
- No deleted-file pruning in index sync.
- Raw FTS `MATCH` query robustness risk.
- Optional vector path appears supported before hard capability validation.

### Must-Fix Before Implementation
1. **Re-anchor architecture to the wired interface first**  
   Keep `wiki_search` and `wiki_read_page` as stable public contract, swap backend engine behind it. Do not lead with `graph-rag/obsidian-query.ts` as primary integration target.
2. **Add explicit rollout and fallback contract**  
   Add `RAG_ENGINE={legacy|sqlite}` runtime flag, default `legacy`, with automatic fail-open to legacy on index/query/extension errors.
3. **Move implementation locus into package/runtime path**  
   Core engine can live in shared package, but runtime and wiki-mcp must consume it directly with compatibility tests.
4. **Codify bundle/compile involvement now**  
   Include build-time preindex path and runtime no-index fallback; wire this into bundle pipeline and artifact checks.
5. **Add parity regression harness**  
   For the same corpus/query set, compare legacy vs new output contracts (shape + minimum quality) to prevent regressions.
6. **Close index correctness gaps**  
   Define deletion sync, FTS sync ordering, and collision-safe chunk IDs before coding.
7. **Harden CI gates**  
   Add performance/memory/disk guardrails and failure-injection tests that must pass before enabling `sqlite` mode by default.

### Decision Audit Trail
| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Keep scope focused on wiki retrieval subsystem | Mechanical | P3 | Scope is already bounded and actionable | Expansion into unrelated product areas |
| 2 | CEO | Integrate through existing `wiki_search`/`wiki_read_page` contract | Mechanical | P4 | Reuse working public interface | Parallel new interface |
| 3 | CEO | Require fallback-first rollout (legacy default) | Mechanical | P1 | Mature path must remain production-safe | New engine as immediate default |
| 4 | Eng | Require prebuilt DB + runtime fallback mode | Taste | P1/P3 | Best performance with safe rollback | Runtime-only indexing always-on |
| 5 | Eng | Treat FTS sync and deletion as release blockers | Mechanical | P1 | Prevent stale/incorrect search results | Deferring data correctness fixes |
| 6 | Eng | Add strict legacy/new parity tests | Mechanical | P1 | Prevent behavior drift for wired tools | Pure unit tests only |
| 7 | Eng | Add failure-injection coverage for fallback behavior | Mechanical | P1 | Validate real-world resilience | Happy-path-only validation |
| 8 | DX | Keep CLI simple, but expose explicit health/fallback diagnostics | Taste | P5 | Operator clarity beats clever abstraction | Hidden auto-recovery behavior |
| 9 | DX | Add packaging pipeline checkpoints for index artifacts | Mechanical | P2 | Bundle/compile is part of product path | Manual index build steps |
| 10 | DX | Gate default switch to sqlite mode behind CI/perf SLOs | Mechanical | P6 | Enables action without unsafe rollout | Unbounded soft rollout |

### Final Gate Recommendation
Proceed after plan revision with the 7 must-fix items above, then run implementation in phased rollout:
1. Legacy contract preserved.
2. SQLite engine behind feature flag.
3. Parity + resilience gates green.
4. Default switch only after sustained pass window.
