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

describe("wiki-rag cli", () => {
  test("doctor reports lexical readiness", () => {
    const result = runCli(["doctor"]);

    expect(result.exitCode).toBe(0);
    expect(decoder.decode(result.stderr)).toBe("");
    expect(decoder.decode(result.stdout)).toContain("lexical: ready");
  });

  test("stats returns json with doc and chunk counts", () => {
    const dbPath = seedStatsDb();
    const result = runCli(["stats", "--db", dbPath]);

    expect(result.exitCode).toBe(0);
    expect(decoder.decode(result.stderr)).toBe("");

    const payload = JSON.parse(decoder.decode(result.stdout));
    expect(payload).toEqual({ docs: 2, chunks: 3 });
  });

  test("unknown command exits non-zero and reports unknown command", () => {
    const result = runCli(["bogus"]);

    expect(result.exitCode).toBe(1);
    expect(decoder.decode(result.stdout)).toBe("");
    expect(decoder.decode(result.stderr)).toContain("unknown command");
  });
});
