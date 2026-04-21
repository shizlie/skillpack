import { describe, expect, test } from "bun:test";

import { buildRetrievalMode, combineScores } from "../src/retriever";

describe("retriever", () => {
  test("buildRetrievalMode falls back to lexical when vector disabled", () => {
    const mode = buildRetrievalMode({ vectorEnabled: false, graphEnabled: false });
    expect(mode).toBe("lexical");
  });

  test("combineScores RRF prioritizes docs present in multiple retrievers", () => {
    const merged = combineScores(
      [
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ],
      [
        { id: "b", rank: 1 },
        { id: "c", rank: 2 },
      ],
      [],
    );

    expect(merged[0].id).toBe("b");
  });
});
