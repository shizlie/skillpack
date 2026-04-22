import { describe, expect, test } from "bun:test";

process.env.SKILLPACK_RUNTIME_SKIP_MAIN = "1";
const { createWikiSearchWithFallback } = await import("../src/server.mjs");

function shape(results) {
  return results.map((row) => ({
    page: typeof row.page,
    score: typeof row.score,
    snippet: typeof row.snippet,
  }));
}

describe("wiki rag parity", () => {
  test("sqlite path keeps response shape compatible with legacy", () => {
    const legacyRows = [
      { page: "alpha", score: 2, snippet: "legacy alpha" },
      { page: "beta", score: 1, snippet: "legacy beta" },
    ];

    const sqliteRows = [
      { page: "alpha", score: 10, snippet: "sqlite alpha" },
      { page: "beta", score: 9, snippet: "sqlite beta" },
    ];

    const legacySearch = () => legacyRows;
    const sqliteSearch = () => sqliteRows;

    const sqliteEngineSearch = createWikiSearchWithFallback({
      engine: "sqlite",
      failOpen: true,
      legacySearch,
      sqliteSearch,
      log: () => {},
    });

    const out = sqliteEngineSearch("alpha", 5);
    expect(shape(out)).toEqual(shape(legacyRows));
    expect(out.length).toBe(2);
    expect(out[0].page).toBe("alpha");
  });

  test("legacy mode ignores sqlite and returns legacy ranking", () => {
    const legacySearch = () => [{ page: "legacy-only", score: 1, snippet: "fallback" }];
    const sqliteSearch = () => [{ page: "sqlite", score: 100, snippet: "should not be used" }];

    const search = createWikiSearchWithFallback({
      engine: "legacy",
      failOpen: true,
      legacySearch,
      sqliteSearch,
      log: () => {},
    });

    const out = search("query", 5);
    expect(out).toEqual([{ page: "legacy-only", score: 1, snippet: "fallback" }]);
  });
});
