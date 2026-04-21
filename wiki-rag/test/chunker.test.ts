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

  test("chunk IDs are stable across repeated runs", () => {
    const md = "# A\nhello";
    const first = chunkMarkdown("a.md", md, 500)[0].chunkId;
    const second = chunkMarkdown("a.md", md, 500)[0].chunkId;
    expect(first).toBe(second);
  });
});
