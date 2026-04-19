import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createWikiMcpServer, createWikiRepository } from "../src/index.js";

function createFixtureWiki() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-wiki-mcp-"));
  fs.writeFileSync(
    path.join(dir, "index.md"),
    "# Index\n\n- [[alpha]]\n- [[beta]]\n"
  );
  fs.writeFileSync(
    path.join(dir, "alpha.md"),
    "# Alpha\n\nCybersecurity controls and incident response."
  );
  fs.writeFileSync(
    path.join(dir, "beta.md"),
    "# Beta\n\nCopyright reciprocity and licensing."
  );
  return dir;
}

test("wiki repository lists/reads/searches pages", () => {
  const wikiDir = createFixtureWiki();
  const repo = createWikiRepository({ wikiDir });

  const pages = repo.listPages();
  expect(pages).toEqual(["alpha.md", "beta.md", "index.md"]);

  const alpha = repo.readPage("alpha");
  expect(alpha).toContain("Cybersecurity controls");

  const search = repo.search("incident");
  expect(search.length).toBe(1);
  expect(search[0].page).toBe("alpha");
});

test("mcp server handles initialize/tools/resources/read/search", async () => {
  const wikiDir = createFixtureWiki();
  const mcp = createWikiMcpServer({ wikiDir });

  const init = await mcp.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  expect(init.result.capabilities.tools).toEqual({});

  const tools = await mcp.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  expect(tools.result.tools.length).toBe(2);

  const search = await mcp.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "wiki_search",
      arguments: { query: "copyright" },
    },
  });
  expect(search.result.isError).toBe(false);
  expect(search.result.content[0].text).toContain("beta");

  const resources = await mcp.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "resources/list",
    params: {},
  });
  expect(resources.result.resources.length).toBe(4);

  const read = await mcp.handle({
    jsonrpc: "2.0",
    id: 5,
    method: "resources/read",
    params: { uri: "wiki://page/alpha" },
  });
  expect(read.result.contents[0].text).toContain("# Alpha");
});
