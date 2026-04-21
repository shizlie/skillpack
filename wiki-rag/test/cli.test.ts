import { describe, expect, test } from "bun:test";
import path from "node:path";

const decoder = new TextDecoder();
const repoRoot = path.resolve(import.meta.dir, "..", "..");

function runCli(args: string[]) {
  return Bun.spawnSync(["bun", "wiki-rag/src/cli.ts", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("wiki-rag cli", () => {
  test("doctor reports lexical readiness", () => {
    const result = runCli(["doctor"]);

    expect(result.exitCode).toBe(0);
    expect(decoder.decode(result.stderr)).toBe("");
    expect(decoder.decode(result.stdout)).toContain("lexical: ready");
  });

  test("stats returns json with doc and chunk counts", () => {
    const result = runCli(["stats"]);

    expect(result.exitCode).toBe(0);
    expect(decoder.decode(result.stderr)).toBe("");

    const payload = JSON.parse(decoder.decode(result.stdout));
    expect(payload).toEqual({ docs: 0, chunks: 0 });
  });

  test("unknown command exits non-zero and reports unknown command", () => {
    const result = runCli(["bogus"]);

    expect(result.exitCode).toBe(1);
    expect(decoder.decode(result.stdout)).toBe("");
    expect(decoder.decode(result.stderr)).toContain("unknown command");
  });
});
