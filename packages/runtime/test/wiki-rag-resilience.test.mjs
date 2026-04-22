import { describe, expect, test } from "bun:test";

process.env.SKILLPACK_RUNTIME_SKIP_MAIN = "1";
const { createWikiSearchWithFallback } = await import("../src/server.mjs");

describe("wiki rag resilience gates", () => {
  test("repeated sqlite failures continue to serve legacy results", () => {
    let sqliteCalls = 0;
    const search = createWikiSearchWithFallback({
      engine: "sqlite",
      failOpen: true,
      legacySearch: () => [{ page: "index", score: 1, snippet: "legacy" }],
      sqliteSearch: () => {
        sqliteCalls += 1;
        throw new Error("sqlite_io_error");
      },
      log: () => {},
    });

    const first = search("one", 5);
    const second = search("two", 5);

    expect(sqliteCalls).toBe(2);
    expect(first[0].page).toBe("index");
    expect(second[0].page).toBe("index");
  });

  test("sqlite success path bypasses fallback", () => {
    const search = createWikiSearchWithFallback({
      engine: "sqlite",
      failOpen: true,
      legacySearch: () => [{ page: "legacy", score: 1, snippet: "legacy" }],
      sqliteSearch: () => [{ page: "sqlite", score: 5, snippet: "sqlite" }],
      log: () => {},
    });

    const out = search("policy", 5);
    expect(out).toEqual([{ page: "sqlite", score: 5, snippet: "sqlite" }]);
  });
});
