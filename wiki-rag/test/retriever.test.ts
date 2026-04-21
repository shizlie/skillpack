import { describe, expect, test } from "bun:test";

import { buildRetrievalMode, combineScores, doctorRetrieval } from "../src/retriever";

describe("retriever", () => {
  test("buildRetrievalMode falls back to lexical when vector disabled", () => {
    const mode = buildRetrievalMode({ vectorEnabled: false, graphEnabled: false });
    expect(mode).toBe("lexical");
  });

  test("buildRetrievalMode returns hybrid when vector is enabled without graph", () => {
    const mode = buildRetrievalMode({ vectorEnabled: true, graphEnabled: false });
    expect(mode).toBe("hybrid");
  });

  test("buildRetrievalMode returns graph when vector and graph are enabled", () => {
    const mode = buildRetrievalMode({ vectorEnabled: true, graphEnabled: true });
    expect(mode).toBe("graph");
  });

  test("doctorRetrieval reports lexical fallback when vector is disabled", () => {
    const report = doctorRetrieval({ vectorEnabled: false, graphEnabled: true });
    expect(report).toEqual({
      mode: "lexical",
      lexical: "ready",
      vector: "disabled",
      graph: "disabled",
      fallback: "vector disabled; using lexical mode",
    });
  });

  test("combineScores RRF prioritizes docs present in multiple retrievers", () => {
    const merged = combineScores(
      [
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ],
      [
        { id: "a", rank: 1 },
        { id: "c", rank: 2 },
      ],
      [
        { id: "c", rank: 1 },
      ],
    );

    expect(merged.map((entry) => entry.id)).toEqual(["a", "c", "b"]);
    expect(merged[0].score).toBeGreaterThan(merged[1].score);
    expect(merged[1].score).toBeGreaterThan(merged[2].score);
  });
});
