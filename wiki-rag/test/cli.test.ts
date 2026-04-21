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
});
