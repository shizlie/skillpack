import { describe, expect, test } from "bun:test";
import {
  parseBool,
  readWikiEngineConfig,
  clampLimit,
  normalizeSqliteRows,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "../src/wiki-rag-shared.mjs";

process.env.SKILLPACK_RUNTIME_SKIP_MAIN = "1";
const { runWikiSearchWithFallbackDetailed } = await import("../src/server.mjs");

describe("parseBool", () => {
  test.each([
    ["1", true],
    ["true", true],
    ["yes", true],
    ["on", true],
    ["TRUE", true],
    ["YES", true],
    ["On", true],
  ])("truthy value %s -> true", (value, expected) => {
    expect(parseBool(value, false)).toBe(expected);
  });

  test.each([
    ["0", false],
    ["false", false],
    ["no", false],
    ["off", false],
    ["FALSE", false],
    ["NO", false],
    ["Off", false],
  ])("falsy value %s -> false", (value, expected) => {
    expect(parseBool(value, true)).toBe(expected);
  });

  test.each([[""], [undefined], [null]])(
    "empty/absent value %s returns fallback",
    (value) => {
      expect(parseBool(value, "sentinel")).toBe("sentinel");
    }
  );

  test("whitespace-padded value is trimmed", () => {
    expect(parseBool("  true  ", false)).toBe(true);
    expect(parseBool("  0  ", true)).toBe(false);
  });

  test("unrecognised value returns fallback", () => {
    expect(parseBool("maybe", "fallback")).toBe("fallback");
  });
});

describe("readWikiEngineConfig", () => {
  test("defaults to legacy + fail-open true", () => {
    expect(readWikiEngineConfig({})).toEqual({ engine: "legacy", failOpen: true });
  });

  test("sqlite engine enabled by env", () => {
    const cfg = readWikiEngineConfig({ RAG_ENGINE: "sqlite" });
    expect(cfg.engine).toBe("sqlite");
  });

  test("unknown engine string coerces to legacy", () => {
    const cfg = readWikiEngineConfig({ RAG_ENGINE: "faiss" });
    expect(cfg.engine).toBe("legacy");
  });

  test("fail-open can be disabled", () => {
    const cfg = readWikiEngineConfig({ RAG_FAIL_OPEN: "false" });
    expect(cfg.failOpen).toBe(false);
  });
});

describe("clampLimit", () => {
  test("clamps below 1 to DEFAULT_LIMIT", () => {
    expect(clampLimit(0)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(-5)).toBe(DEFAULT_LIMIT);
  });

  test("clamps above MAX_LIMIT", () => {
    expect(clampLimit(MAX_LIMIT + 1)).toBe(MAX_LIMIT);
    expect(clampLimit(999)).toBe(MAX_LIMIT);
  });

  test("non-integer falls back to DEFAULT_LIMIT", () => {
    expect(clampLimit(3.7)).toBe(DEFAULT_LIMIT);
    expect(clampLimit("10")).toBe(DEFAULT_LIMIT);
  });

  test("valid in-range integer passes through", () => {
    expect(clampLimit(3)).toBe(3);
    expect(clampLimit(MAX_LIMIT)).toBe(MAX_LIMIT);
  });
});

describe("normalizeSqliteRows", () => {
  const makeRow = (path, text) => ({ path, text, chunkId: "c", headingPath: null });

  test("strips .md extension from path", () => {
    const rows = [makeRow("alpha.md", "text")];
    expect(normalizeSqliteRows(rows, 5)[0].page).toBe("alpha");
  });

  test("assigns descending scores", () => {
    const rows = [makeRow("a.md", "t1"), makeRow("b.md", "t2"), makeRow("c.md", "t3")];
    const out = normalizeSqliteRows(rows, 5);
    expect(out[0].score).toBeGreaterThan(out[1].score);
    expect(out[1].score).toBeGreaterThan(out[2].score);
  });

  test("truncates rows to clamped limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => makeRow(`p${i}.md`, "t"));
    expect(normalizeSqliteRows(rows, 3).length).toBe(3);
  });

  test("normalises whitespace in snippet", () => {
    const rows = [makeRow("p.md", "hello   world\n\nnewline")];
    expect(normalizeSqliteRows(rows, 5)[0].snippet).toBe("hello world newline");
  });
});

describe("runWikiSearchWithFallbackDetailed metadata", () => {
  const legacyRow = { page: "p", score: 1, snippet: "s" };
  const sqliteRow = { page: "q", score: 5, snippet: "t" };

  test("sqlite success path: pathUsed=sqlite, fallbackUsed=false", () => {
    const out = runWikiSearchWithFallbackDetailed({
      engine: "sqlite",
      failOpen: true,
      legacySearch: () => [legacyRow],
      sqliteSearch: () => [sqliteRow],
      query: "q",
      limit: 5,
      log: () => {},
    });
    expect(out.pathUsed).toBe("sqlite");
    expect(out.fallbackUsed).toBe(false);
    expect(out.fallbackReason).toBeNull();
    expect(out.results[0].page).toBe("q");
  });

  test("sqlite failure + fail-open: pathUsed=legacy, fallbackUsed=true, reason set", () => {
    const out = runWikiSearchWithFallbackDetailed({
      engine: "sqlite",
      failOpen: true,
      legacySearch: () => [legacyRow],
      sqliteSearch: () => {
        throw new Error("db_gone");
      },
      query: "q",
      limit: 5,
      log: () => {},
    });
    expect(out.pathUsed).toBe("legacy");
    expect(out.fallbackUsed).toBe(true);
    expect(out.fallbackReason).toBe("db_gone");
    expect(out.results[0].page).toBe("p");
  });

  test("legacy engine: pathUsed=legacy, fallbackUsed=false, sqlite never called", () => {
    let sqliteCalled = false;
    const out = runWikiSearchWithFallbackDetailed({
      engine: "legacy",
      failOpen: false,
      legacySearch: () => [legacyRow],
      sqliteSearch: () => {
        sqliteCalled = true;
        return [];
      },
      query: "q",
      limit: 5,
      log: () => {},
    });
    expect(out.pathUsed).toBe("legacy");
    expect(out.fallbackUsed).toBe(false);
    expect(out.fallbackReason).toBeNull();
    expect(sqliteCalled).toBe(false);
  });

  test("fail-open disabled: sqlite error propagates", () => {
    expect(() =>
      runWikiSearchWithFallbackDetailed({
        engine: "sqlite",
        failOpen: false,
        legacySearch: () => [],
        sqliteSearch: () => {
          throw new Error("fatal");
        },
        query: "q",
        limit: 5,
        log: () => {},
      })
    ).toThrow("fatal");
  });
});
