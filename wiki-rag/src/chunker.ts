import { createHash } from "node:crypto";

export type Chunk = {
  chunkId: string;
  headingPath: string | null;
  text: string;
  ordinal: number;
  startOffset: number;
  endOffset: number;
};

function headingLevel(line: string): number | null {
  const match = /^(#{1,6})\s+/.exec(line);
  return match ? match[1].length : null;
}

function buildChunkId(path: string, headingPath: string | null, ordinal: number, text: string): string {
  return createHash("sha256")
    .update(path)
    .update("\0")
    .update(headingPath ?? "")
    .update("\0")
    .update(String(ordinal))
    .update("\0")
    .update(text.replace(/\s+/g, " ").trim())
    .digest("hex");
}

function makeChunk(
  path: string,
  headingPath: string | null,
  ordinal: number,
  text: string,
  startOffset: number,
  endOffset: number,
): Chunk | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  return {
    chunkId: buildChunkId(path, headingPath, ordinal, trimmed),
    headingPath,
    text: trimmed,
    ordinal,
    startOffset,
    endOffset,
  };
}

export function chunkMarkdown(path: string, markdown: string, maxChars = 1800): Chunk[] {
  const chunks: Chunk[] = [];
  const headingStack: string[] = [];

  let ordinal = 0;
  let buffer = "";
  let bufferStart = 0;
  let cursor = 0;

  const flush = () => {
    const headingPath = headingStack.length > 0 ? headingStack.join(" > ") : null;
    const chunk = makeChunk(path, headingPath, ordinal, buffer, bufferStart, cursor);
    if (chunk) {
      chunks.push(chunk);
      ordinal += 1;
    }
    buffer = "";
  };

  const appendLine = (line: string, lineStart: number, lineEnd: number) => {
    if (!buffer) {
      bufferStart = lineStart;
    }

    const nextBuffer = buffer ? `${buffer}\n${line}` : line;
    if (buffer && nextBuffer.length > maxChars) {
      flush();
      bufferStart = lineStart;
      buffer = line;
      cursor = lineEnd;
      return;
    }

    buffer = nextBuffer;
    cursor = lineEnd;
  };

  const lines = markdown.split("\n");
  let lineStart = 0;

  for (const line of lines) {
    const lineEnd = lineStart + line.length;
    const level = headingLevel(line);

    if (level) {
      flush();
      headingStack.splice(level - 1);
      headingStack[level - 1] = line.replace(/^#{1,6}\s+/, "").trim();
      bufferStart = lineEnd;
      buffer = "";
      cursor = lineEnd;
    } else {
      appendLine(line, lineStart, lineEnd);
    }

    lineStart = lineEnd + 1;
  }

  flush();

  return chunks;
}
