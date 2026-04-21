import { Database } from "bun:sqlite";

import { ensureSchema } from "./schema";

type Command = "doctor" | "stats";

function openDatabase() {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

function printDoctor() {
  openDatabase();
  console.log("database: ready");
  console.log("schema: ready");
  console.log("lexical: ready");
  console.log("vector: disabled");
  console.log("graph: disabled");
}

function printStats() {
  const db = openDatabase();
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

  switch (command as Command | undefined) {
    case "doctor":
      printDoctor();
      return;
    case "stats":
      printStats();
      return;
    default:
      unknownCommand(command);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
