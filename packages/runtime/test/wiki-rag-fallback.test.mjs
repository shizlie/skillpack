import { describe, expect, test } from "bun:test";

process.env.SKILLPACK_RUNTIME_SKIP_MAIN = "1";
const { createWikiSearchWithFallback, readWikiEngineConfig } = await import("../src/server.mjs");

function makeLegacySearch() {
  return (query) => [
    {
      page: "alpha",
      score: 3,
      snippet: `legacy snippet for ${query}`,
    },
  ];
}

describe("wiki rag fallback", () => {
  test("db missing/corrupt falls back to legacy when fail-open enabled", () => {
    const sqliteSearch = () => {
      throw new Error("sqlite_db_missing");
    };
    const search = createWikiSearchWithFallback({
      engine: "sqlite",
      failOpen: true,
      legacySearch: makeLegacySearch(),
      sqliteSearch,
      log: () => {},
    });

    const out = search("incident", 5);
    expect(out[0].page).toBe("alpha");
    expect(out[0].snippet).toContain("legacy snippet");
  });

  test("vector extension unavailable falls back to legacy", () => {
    const sqliteSearch = () => {
      throw new Error("vector_extension_unavailable");
    };
    const search = createWikiSearchWithFallback({
      engine: "sqlite",
      failOpen: true,
      legacySearch: makeLegacySearch(),
      sqliteSearch,
      log: () => {},
    });

    const out = search("copyright", 5);
    expect(out[0].page).toBe("alpha");
  });

  test("query parse failure falls back to legacy", () => {
    const sqliteSearch = () => {
      throw new Error("query_parse_failure");
    };
    const search = createWikiSearchWithFallback({
      engine: "sqlite",
      failOpen: true,
      legacySearch: makeLegacySearch(),
      sqliteSearch,
      log: () => {},
    });

    const out = search("\"unterminated", 5);
    expect(out[0].page).toBe("alpha");
  });

  test("io error during index read falls back to legacy", () => {
    const sqliteSearch = () => {
      throw new Error("io_error_during_index_read");
    };
    const search = createWikiSearchWithFallback({
      engine: "sqlite",
      failOpen: true,
      legacySearch: makeLegacySearch(),
      sqliteSearch,
      log: () => {},
    });

    const out = search("licensing", 5);
    expect(out[0].page).toBe("alpha");
  });

  test("fail-open disabled surfaces sqlite errors", () => {
    const search = createWikiSearchWithFallback({
      engine: "sqlite",
      failOpen: false,
      legacySearch: makeLegacySearch(),
      sqliteSearch: () => {
        throw new Error("sqlite_corrupt");
      },
      log: () => {},
    });

    expect(() => search("policy", 5)).toThrow(/sqlite_corrupt/);
  });

  test("config defaults to legacy + fail-open true", () => {
    const cfg = readWikiEngineConfig({});
    expect(cfg).toEqual({ engine: "legacy", failOpen: true });
  });
});
