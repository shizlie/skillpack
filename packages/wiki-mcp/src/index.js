import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_SERVER_INFO = { name: "skillpack-wiki-mcp", version: "0.1.0" };
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

function normalizePageName(pageName) {
  if (typeof pageName !== "string" || pageName.trim().length === 0) {
    throw new Error("wiki_invalid_page_name");
  }
  const trimmed = pageName.trim();
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

function toPageId(fileName) {
  return fileName.replace(/\.md$/i, "");
}

function pageUri(pageId) {
  return `wiki://page/${encodeURIComponent(pageId)}`;
}

function parsePageUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("wiki://page/")) return null;
  return decodeURIComponent(uri.slice("wiki://page/".length));
}

function clampLimit(limit) {
  if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

function countMatches(content, query) {
  const lower = content.toLowerCase();
  const target = query.toLowerCase();
  let from = 0;
  let total = 0;
  while (true) {
    const idx = lower.indexOf(target, from);
    if (idx === -1) break;
    total += 1;
    from = idx + target.length;
  }
  return total;
}

function snippetAround(content, query, size = 220) {
  const lower = content.toLowerCase();
  const target = query.toLowerCase();
  const idx = lower.indexOf(target);
  if (idx === -1) return content.slice(0, size);
  const start = Math.max(0, idx - Math.floor(size / 2));
  return content.slice(start, start + size);
}

export function createWikiRepository({ wikiDir } = {}) {
  if (!wikiDir) throw new Error("wiki_missing_dir");
  const wikiRoot = path.resolve(wikiDir);

  function listPages() {
    return readdirSync(wikiDir)
      .filter((file) => file.endsWith(".md"))
      .sort((a, b) => a.localeCompare(b));
  }

  function readPage(pageName) {
    const fileName = normalizePageName(pageName);
    const absolutePath = path.resolve(wikiRoot, fileName);
    const relativePath = path.relative(wikiRoot, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error("wiki_page_out_of_bounds");
    }
    return readFileSync(absolutePath, "utf8");
  }

  function search(query, { limit = DEFAULT_LIMIT } = {}) {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new Error("wiki_missing_query");
    }
    const files = listPages();
    const scored = [];
    for (const file of files) {
      const content = readPage(file);
      const score = countMatches(content, query);
      if (score === 0) continue;
      scored.push({
        page: toPageId(file),
        score,
        snippet: snippetAround(content, query).replace(/\s+/g, " ").trim(),
      });
    }
    scored.sort((a, b) => b.score - a.score || a.page.localeCompare(b.page));
    return scored.slice(0, clampLimit(limit));
  }

  return {
    wikiDir,
    listPages,
    readPage,
    search,
  };
}

function formatSearchResult(results) {
  if (results.length === 0) return "No wiki matches found.";
  return results
    .map(
      (row, idx) =>
        `${idx + 1}. ${row.page} (score=${row.score})\n${row.snippet}`
    )
    .join("\n\n");
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function createWikiMcpServer({
  wikiDir = path.join(process.cwd(), "verticals/laws-consultant/wiki"),
  protocolVersion = DEFAULT_PROTOCOL_VERSION,
  serverInfo = DEFAULT_SERVER_INFO,
} = {}) {
  const wiki = createWikiRepository({ wikiDir });

  async function handle(request) {
    const { id, method, params = {} } = request ?? {};
    try {
      if (method === "initialize") {
        return jsonRpcResult(id, {
          protocolVersion,
          serverInfo,
          capabilities: {
            tools: {},
            resources: {},
          },
        });
      }

      if (method === "tools/list") {
        return jsonRpcResult(id, {
          tools: [
            {
              name: "wiki_search",
              description: "Search the local wiki markdown corpus.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
                },
                required: ["query"],
              },
            },
            {
              name: "wiki_read_page",
              description: "Read one wiki markdown page by name.",
              inputSchema: {
                type: "object",
                properties: {
                  page: { type: "string" },
                },
                required: ["page"],
              },
            },
          ],
        });
      }

      if (method === "tools/call") {
        const name = params.name;
        const args = params.arguments ?? {};
        if (name === "wiki_search") {
          const results = wiki.search(args.query, { limit: args.limit });
          return jsonRpcResult(id, {
            content: [{ type: "text", text: formatSearchResult(results) }],
            isError: false,
          });
        }
        if (name === "wiki_read_page") {
          const text = wiki.readPage(args.page);
          return jsonRpcResult(id, {
            content: [{ type: "text", text }],
            isError: false,
          });
        }
        return jsonRpcError(id, -32602, "unknown_tool");
      }

      if (method === "resources/list") {
        const pages = wiki.listPages().map((file) => toPageId(file));
        const resources = [
          {
            uri: "wiki://index",
            name: "Wiki Index",
            description: "Primary wiki index markdown page.",
            mimeType: "text/markdown",
          },
          ...pages.map((page) => ({
            uri: pageUri(page),
            name: page,
            description: `Wiki page: ${page}`,
            mimeType: "text/markdown",
          })),
        ];
        return jsonRpcResult(id, { resources });
      }

      if (method === "resources/read") {
        const uri = params.uri;
        if (uri === "wiki://index") {
          return jsonRpcResult(id, {
            contents: [
              {
                uri,
                mimeType: "text/markdown",
                text: wiki.readPage("index"),
              },
            ],
          });
        }
        const page = parsePageUri(uri);
        if (!page) return jsonRpcError(id, -32602, "invalid_resource_uri");
        return jsonRpcResult(id, {
          contents: [
            {
              uri,
              mimeType: "text/markdown",
              text: wiki.readPage(page),
            },
          ],
        });
      }

      return jsonRpcError(id, -32601, "method_not_found");
    } catch (error) {
      return jsonRpcError(id, -32603, error.message ?? "internal_error");
    }
  }

  return {
    handle,
    wiki,
  };
}
