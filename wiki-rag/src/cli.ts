import { Database } from "bun:sqlite";
import fs from "node:fs";

import { ensureSchema } from "./schema";

type Command = "doctor" | "stats";

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

function openDatabase(dbPath: string, explicit: boolean) {
  if (explicit && !fs.existsSync(dbPath)) {
    console.error(`database not found: ${dbPath}`);
    console.error("Pass an existing --db path or omit --db to use the default database.");
    process.exit(1);
  }

  const db = new Database(dbPath);
  ensureSchema(db);
  return db;
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

function unknownCommand(command: string | undefined): never {
  console.error(`unknown command: ${command ?? ""}`.trim());
  process.exit(1);
}

function main(argv: string[]) {
  const [command] = argv;
  const { dbPath, explicit } = getDatabasePath(argv);

  switch (command as Command | undefined) {
    case "doctor":
      printDoctor(dbPath, explicit);
      return;
    case "stats":
      printStats(dbPath, explicit);
      return;
    default:
      unknownCommand(command);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
