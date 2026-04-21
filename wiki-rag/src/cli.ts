import { Database } from "bun:sqlite";

import { ensureSchema } from "./schema";

type Command = "index" | "query" | "doctor" | "stats";

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
  openDatabase();
  console.log(JSON.stringify({ docs: 0, chunks: 0 }));
}

function runIndex() {
  openDatabase();
  console.log("index: ready");
}

function runQuery(args: string[]) {
  openDatabase();
  const query = args.filter((arg) => !arg.startsWith("-")).join(" ").trim();
  console.log(JSON.stringify({ query, results: [] }));
}

function unknownCommand(command: string | undefined): never {
  console.error(`unknown command: ${command ?? ""}`.trim());
  process.exit(1);
}

function main(argv: string[]) {
  const [command, ...args] = argv;

  switch (command as Command | undefined) {
    case "index":
      runIndex();
      return;
    case "query":
      runQuery(args);
      return;
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
