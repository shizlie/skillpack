import { Database } from "bun:sqlite";

import { ensureSchema } from "./schema";

type Command = "doctor" | "stats";

function getDatabasePath(args: string[]): string {
  const dbIndex = args.indexOf("--db");
  if (dbIndex === -1) {
    return ":memory:";
  }

  const dbPath = args[dbIndex + 1];
  return dbPath && !dbPath.startsWith("--") ? dbPath : ":memory:";
}

function openDatabase(dbPath: string) {
  const db = new Database(dbPath);
  ensureSchema(db);
  return db;
}

function printDoctor(dbPath: string) {
  openDatabase(dbPath);
  console.log("database: ready");
  console.log("schema: ready");
  console.log("lexical: ready");
  console.log("vector: disabled");
  console.log("graph: disabled");
}

function printStats(dbPath: string) {
  const db = openDatabase(dbPath);
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
  const dbPath = getDatabasePath(argv);

  switch (command as Command | undefined) {
    case "doctor":
      printDoctor(dbPath);
      return;
    case "stats":
      printStats(dbPath);
      return;
    default:
      unknownCommand(command);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
