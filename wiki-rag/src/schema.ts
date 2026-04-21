import type { Database } from "bun:sqlite";

export function ensureSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    title TEXT,
    mtime_ms INTEGER NOT NULL,
    content_hash TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    heading_path TEXT,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL
  )`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    text,
    title,
    heading_path
  )`);
}

export function listTables(db: Database): string[] {
  return db
    .query(
      "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row: { name: string }) => row.name);
}
