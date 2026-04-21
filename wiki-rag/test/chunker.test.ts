import { describe, expect, test } from "bun:test";
import { chunkMarkdown } from "../src/chunker";

describe("chunker", () => {
  test("splits by heading and preserves headingPath", () => {
    const md = "# Title\nIntro\n## Policy\nRule A\n## Incident\nRule B";
    const chunks = chunkMarkdown("docs/runbook.md", md, 500);

    expect(chunks.length).toBe(3);
    expect(chunks[1].headingPath).toBe("Title > Policy");
    expect(chunks[2].headingPath).toBe("Title > Incident");
  });

  test("skipped heading levels do not create empty path segments", () => {
    const md = "# Title\nIntro\n### Deep Topic\nRule A";
    const chunks = chunkMarkdown("docs/runbook.md", md, 500);

    expect(chunks.length).toBe(2);
    expect(chunks[1].headingPath).toBe("Title > Deep Topic");
  });

  test("chunk IDs are stable across repeated runs", () => {
    const md = "# A\nhello";
    const first = chunkMarkdown("a.md", md, 500)[0].chunkId;
    const second = chunkMarkdown("a.md", md, 500)[0].chunkId;
    expect(first).toBe(second);
  });

  test("chunk IDs ignore ordinal position", () => {
    const firstDoc = "# A\nsame\n# B\ncontent";
    const secondDoc = "# A\nsame\n# X\nother\n# B\ncontent";

    const first = chunkMarkdown("a.md", firstDoc, 500)[1].chunkId;
    const second = chunkMarkdown("a.md", secondDoc, 500)[2].chunkId;

    expect(first).toBe(second);
  });
});
