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

  test("chunk IDs differ for repeated normalized text in the same heading path", () => {
    const md = "# Title\nsame text\nsame text";
    const chunks = chunkMarkdown("docs/runbook.md", md, 10);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].headingPath).toBe("Title");
    expect(chunks[1].headingPath).toBe("Title");
    expect(chunks[0].chunkId).not.toBe(chunks[1].chunkId);
  });

  test("single long lines stay isolated even when longer than maxChars", () => {
    const md = "# Title\nshort\n" + "x".repeat(32) + "\nend";
    const chunks = chunkMarkdown("docs/runbook.md", md, 8);

    expect(chunks).toHaveLength(3);
    expect(chunks[1].text).toBe("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(chunks[1].text.length).toBeGreaterThan(8);
    expect(chunks[2].text).toBe("end");
  });
});
