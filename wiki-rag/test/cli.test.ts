import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureSchema } from "../src/schema";

const decoder = new TextDecoder();
const repoRoot = path.resolve(import.meta.dir, "..", "..");

function runCli(args: string[]) {
  return Bun.spawnSync(["bun", "wiki-rag/src/cli.ts", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function seedStatsDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-rag-cli-"));
  const dbPath = path.join(dir, "wiki-rag.db");
  const db = new Database(dbPath);
  ensureSchema(db);
  db.run("INSERT INTO documents(doc_id, path, title, mtime_ms, content_hash) VALUES (?, ?, ?, ?, ?)", [
    "doc-1",
    "one.md",
    "One",
    1,
    "hash-1",
  ]);
  db.run("INSERT INTO documents(doc_id, path, title, mtime_ms, content_hash) VALUES (?, ?, ?, ?, ?)", [
    "doc-2",
    "two.md",
    "Two",
    2,
    "hash-2",
  ]);
  db.run("INSERT INTO chunks(chunk_id, doc_id, heading_path, ordinal, text, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    "chunk-1",
    "doc-1",
    "One",
    0,
    "alpha",
    0,
    5,
  ]);
  db.run("INSERT INTO chunks(chunk_id, doc_id, heading_path, ordinal, text, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    "chunk-2",
    "doc-1",
    "One > A",
    1,
    "beta",
    6,
    10,
  ]);
  db.run("INSERT INTO chunks(chunk_id, doc_id, heading_path, ordinal, text, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    "chunk-3",
    "doc-2",
    "Two",
    0,
    "gamma",
    0,
    5,
  ]);
  db.close();
  return dbPath;
}

function createWikiRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-rag-cli-wiki-"));
  fs.writeFileSync(path.join(dir, "index.md"), "# Index\n\nAlpha incident response");
  fs.writeFileSync(path.join(dir, "policy.md"), "# Policy\n\nCopyright licensing policy");
  return dir;
}

describe("wiki-rag cli", () => {
  test("doctor reports lexical readiness", () => {
    const result = runCli(["doctor"]);

    expect(result.exitCode).toBe(0);
    expect(decoder.decode(result.stderr)).toBe("");
    expect(decoder.decode(result.stdout)).toContain("lexical: ready");
  });

  test("doctor fails for missing explicit db path", () => {
    const dbPath = path.join(os.tmpdir(), `wiki-rag-missing-doctor-${Date.now()}.db`);
    const result = runCli(["doctor", "--db", dbPath]);

    expect(result.exitCode).toBe(1);
    expect(decoder.decode(result.stdout)).toBe("");
    expect(decoder.decode(result.stderr)).toContain(`database not found: ${dbPath}`);
    expect(decoder.decode(result.stderr)).toContain("omit --db to use the default database");
  });

  test("stats returns json with doc and chunk counts", () => {
    const dbPath = seedStatsDb();
    const result = runCli(["stats", "--db", dbPath]);

    expect(result.exitCode).toBe(0);
    expect(decoder.decode(result.stderr)).toBe("");

    const payload = JSON.parse(decoder.decode(result.stdout));
    expect(payload).toEqual({ docs: 2, chunks: 3 });
  });

  test("stats fails for missing explicit db path", () => {
    const dbPath = path.join(os.tmpdir(), `wiki-rag-missing-stats-${Date.now()}.db`);
    const result = runCli(["stats", "--db", dbPath]);

    expect(result.exitCode).toBe(1);
    expect(decoder.decode(result.stdout)).toBe("");
    expect(decoder.decode(result.stderr)).toContain(`database not found: ${dbPath}`);
    expect(decoder.decode(result.stderr)).toContain("omit --db to use the default database");
  });

  test("unknown command exits non-zero and reports unknown command", () => {
    const result = runCli(["bogus"]);

    expect(result.exitCode).toBe(1);
    expect(decoder.decode(result.stdout)).toBe("");
    expect(decoder.decode(result.stderr)).toContain("unknown command");
  });

  test("index builds sqlite data from a markdown wiki root", () => {
    const wikiRoot = createWikiRoot();
    const dbPath = path.join(os.tmpdir(), `wiki-rag-index-${Date.now()}.db`);
    const result = runCli(["index", "--db", dbPath, "--root", wikiRoot]);

    expect(result.exitCode).toBe(0);
    expect(decoder.decode(result.stderr)).toBe("");
    const payload = JSON.parse(decoder.decode(result.stdout));
    expect(payload.docs).toBe(2);
    expect(payload.chunks).toBeGreaterThanOrEqual(2);
  });

  test("query returns hits json", () => {
    const wikiRoot = createWikiRoot();
    const dbPath = path.join(os.tmpdir(), `wiki-rag-query-${Date.now()}.db`);
    const indexResult = runCli(["index", "--db", dbPath, "--root", wikiRoot]);
    expect(indexResult.exitCode).toBe(0);

    const queryResult = runCli(["query", "--db", dbPath, "--query", "licensing", "--limit", "3"]);
    expect(queryResult.exitCode).toBe(0);
    expect(decoder.decode(queryResult.stderr)).toBe("");
    const payload = JSON.parse(decoder.decode(queryResult.stdout));
    expect(Array.isArray(payload.hits)).toBe(true);
    expect(payload.hits.length).toBeGreaterThan(0);
    expect(payload.hits[0]).toHaveProperty("path");
    expect(payload.hits[0]).toHaveProperty("chunkId");
  });
});
