import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { chunkMarkdown } from "./chunker";

export type SearchHit = {
  path: string;
  chunkId: string;
  headingPath: string | null;
  text: string;
};

function walkMarkdown(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return walkMarkdown(fullPath);
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [fullPath] : [];
  });
}

function normalizePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

export async function indexMarkdownDir(db: Database, root: string): Promise<void> {
  const files = walkMarkdown(root);
  const currentPaths = new Set(files.map((filePath) => normalizePath(root, filePath)));

  const tx = db.transaction((paths: string[]) => {
    const existingDocs = db
      .query("SELECT doc_id AS docId, path FROM documents")
      .all() as Array<{ docId: string; path: string }>;

    for (const doc of existingDocs) {
      if (!currentPaths.has(doc.path)) {
        db.run("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE doc_id = ?)", [doc.docId]);
        db.run("DELETE FROM chunks WHERE doc_id = ?", [doc.docId]);
        db.run("DELETE FROM documents WHERE doc_id = ?", [doc.docId]);
      }
    }

    for (const filePath of paths) {
      const markdown = fs.readFileSync(filePath, "utf8");
      const stat = fs.statSync(filePath);
      const relPath = normalizePath(root, filePath);
      const docId = createHash("sha256").update(relPath).digest("hex");
      const contentHash = createHash("sha256").update(markdown).digest("hex");

      db.run(
        "INSERT OR REPLACE INTO documents(doc_id, path, title, mtime_ms, content_hash) VALUES (?, ?, ?, ?, ?)",
        [docId, relPath, null, stat.mtimeMs, contentHash],
      );

      // Delete FTS rows before chunk rows so reindexing cannot leave stale lexical hits behind.
      db.run("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE doc_id = ?)", [docId]);
      db.run("DELETE FROM chunks WHERE doc_id = ?", [docId]);

      const chunks = chunkMarkdown(relPath, markdown);
      for (const chunk of chunks) {
        db.run(
          "INSERT INTO chunks(chunk_id, doc_id, heading_path, ordinal, text, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [chunk.chunkId, docId, chunk.headingPath, chunk.ordinal, chunk.text, chunk.startOffset, chunk.endOffset],
        );
        db.run(
          "INSERT INTO chunks_fts(chunk_id, text, title, heading_path) VALUES (?, ?, ?, ?)",
          [chunk.chunkId, chunk.text, null, chunk.headingPath],
        );
      }
    }
  });

  tx(files);
}

export function searchLexical(db: Database, query: string): SearchHit[] {
  try {
    return db
      .query(
        `
        SELECT d.path AS path, c.chunk_id AS chunkId, c.heading_path AS headingPath, c.text AS text
        FROM chunks_fts
        JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id
        JOIN documents d ON d.doc_id = c.doc_id
        WHERE chunks_fts MATCH ?
        ORDER BY bm25(chunks_fts)
        LIMIT 10
        `,
      )
      .all(query) as SearchHit[];
  } catch {
    return [];
  }
}
