#!/usr/bin/env bun
import path from "node:path";
import { createWikiMcpServer } from "./index.js";

const wikiDirFlag = process.argv.find((arg) => arg.startsWith("--wiki-dir="));
const wikiDir = wikiDirFlag
  ? path.resolve(wikiDirFlag.slice("--wiki-dir=".length))
  : undefined;

const server = createWikiMcpServer({ wikiDir });

let buffer = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      const out = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse_error" },
      };
      process.stdout.write(`${JSON.stringify(out)}\n`);
      continue;
    }
    const response = await server.handle(request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
});
