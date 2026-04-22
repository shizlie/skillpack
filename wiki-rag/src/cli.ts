import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { indexMarkdownDir, searchLexical } from "./indexer";
import { ensureSchema } from "./schema";

type Command = "doctor" | "stats" | "index" | "query";

type DatabaseArg = {
  dbPath: string;
  explicit: boolean;
};

function getDatabasePath(args: string[]): DatabaseArg {
  const dbIndex = args.indexOf("--db");
  if (dbIndex === -1) {
    return { dbPath: ":memory:", explicit: false };
  }

  const dbPath = args[dbIndex + 1];
  if (!dbPath || dbPath.startsWith("--")) {
    console.error("missing value for --db. Pass an existing database path or omit --db to use the default database.");
    process.exit(1);
  }

  return { dbPath, explicit: true };
}

function openDatabase(dbPath: string, explicit: boolean, options?: { requireExisting?: boolean }) {
  const requireExisting = options?.requireExisting ?? true;
  if (explicit && requireExisting && !fs.existsSync(dbPath)) {
    console.error(`database not found: ${dbPath}`);
    console.error("Pass an existing --db path or omit --db to use the default database.");
    process.exit(1);
  }

  const db = new Database(dbPath);
  ensureSchema(db);
  return db;
}

function getArgValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`missing value for ${flag}`);
    process.exit(1);
  }
  return value;
}

function printDoctor(dbPath: string, explicit: boolean) {
  openDatabase(dbPath, explicit);
  console.log("database: ready");
  console.log("schema: ready");
  console.log("lexical: ready");
  console.log("vector: disabled");
  console.log("graph: disabled");
}

function printStats(dbPath: string, explicit: boolean) {
  const db = openDatabase(dbPath, explicit);
  const docsRow = db.query("SELECT COUNT(*) AS count FROM documents").get() as { count: number };
  const chunksRow = db.query("SELECT COUNT(*) AS count FROM chunks").get() as { count: number };

  console.log(JSON.stringify({ docs: docsRow.count, chunks: chunksRow.count }));
}

async function runIndex(dbPath: string, explicit: boolean, argv: string[]) {
  const rootArg = getArgValue(argv, "--root");
  if (!rootArg) {
    console.error("missing --root. Pass the wiki markdown directory to index.");
    process.exit(1);
  }

  const root = path.resolve(rootArg);
  if (!fs.existsSync(root)) {
    console.error(`wiki root not found: ${root}`);
    process.exit(1);
  }

  const db = openDatabase(dbPath, explicit, { requireExisting: false });
  await indexMarkdownDir(db, root);
  const docsRow = db.query("SELECT COUNT(*) AS count FROM documents").get() as { count: number };
  const chunksRow = db.query("SELECT COUNT(*) AS count FROM chunks").get() as { count: number };
  console.log(JSON.stringify({ docs: docsRow.count, chunks: chunksRow.count, indexedRoot: root }));
}

function runQuery(dbPath: string, explicit: boolean, argv: string[]) {
  const query = getArgValue(argv, "--query");
  if (!query) {
    console.error("missing --query. Pass a search query.");
    process.exit(1);
  }

  const limitRaw = getArgValue(argv, "--limit");
  let limit = 10;
  if (limitRaw !== null) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error("invalid --limit. Pass a positive integer.");
      process.exit(1);
    }
    limit = parsed;
  }

  const db = openDatabase(dbPath, explicit);
  const rows = searchLexical(db, query).slice(0, limit);
  console.log(JSON.stringify({ hits: rows }, null, 2));
}

function unknownCommand(command: string | undefined): never {
  console.error(`unknown command: ${command ?? ""}`.trim());
  process.exit(1);
}

async function main(argv: string[]) {
  const [command] = argv;
  const { dbPath, explicit } = getDatabasePath(argv);

  switch (command as Command | undefined) {
    case "doctor":
      printDoctor(dbPath, explicit);
      return;
    case "stats":
      printStats(dbPath, explicit);
      return;
    case "index":
      await runIndex(dbPath, explicit, argv);
      return;
    case "query":
      runQuery(dbPath, explicit, argv);
      return;
    default:
      unknownCommand(command);
  }
}

if (import.meta.main) {
  void main(process.argv.slice(2));
}
