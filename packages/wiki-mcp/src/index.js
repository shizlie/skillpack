import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_SERVER_INFO = { name: "skillpack-wiki-mcp", version: "0.1.0" };
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const SQLITE_ENGINE = "sqlite";
const LEGACY_ENGINE = "legacy";

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

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function readWikiEngineConfig(env = process.env) {
  const rawEngine = (env.RAG_ENGINE ?? LEGACY_ENGINE).toLowerCase();
  return {
    engine: rawEngine === SQLITE_ENGINE ? SQLITE_ENGINE : LEGACY_ENGINE,
    failOpen: parseBool(env.RAG_FAIL_OPEN, true),
  };
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

function normalizeSqliteRows(rows, limit) {
  return rows.slice(0, clampLimit(limit)).map((row, index) => {
    const page = String(row.path ?? "").replace(/\.md$/i, "");
    return {
      page,
      score: clampLimit(limit) - index,
      snippet: String(row.text ?? "").replace(/\s+/g, " ").trim().slice(0, 220),
    };
  });
}

function createSqliteSearchRunner({
  wikiDir,
  dbPath = path.join(wikiDir, ".wiki-rag.db"),
  cliPath = path.resolve(process.cwd(), "wiki-rag", "src", "cli.ts"),
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  let isReady = false;

  const runCli = (args) => {
    const result = spawnSync("bun", [cliPath, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error((result.stderr ?? "").trim() || `wiki_rag_cli_failed:${args.join(" ")}`);
    }
    return (result.stdout ?? "").trim();
  };

  const ensureReady = () => {
    if (isReady) return;
    runCli(["index", "--db", dbPath, "--root", wikiDir]);
    isReady = true;
  };

  return (query, limit) => {
    ensureReady();
    const output = runCli([
      "query",
      "--db",
      dbPath,
      "--query",
      query,
      "--limit",
      String(clampLimit(limit)),
    ]);
    const parsed = JSON.parse(output || "{}");
    return normalizeSqliteRows(Array.isArray(parsed.hits) ? parsed.hits : [], limit);
  };
}

function createSearchWithFallback({
  engine,
  failOpen,
  legacySearch,
  sqliteSearch,
  log = () => {},
}) {
  return (query, limit) => {
    if (engine !== SQLITE_ENGINE) return legacySearch(query, limit);
    try {
      return sqliteSearch(query, limit);
    } catch (error) {
      if (!failOpen) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      log(`[WARN] sqlite wiki search failed, falling back to legacy: ${reason}`);
      return legacySearch(query, limit);
    }
  };
}

export function createWikiMcpServer({
  wikiDir = path.join(process.cwd(), "verticals/laws-consultant/wiki"),
  protocolVersion = DEFAULT_PROTOCOL_VERSION,
  serverInfo = DEFAULT_SERVER_INFO,
  ragConfig = readWikiEngineConfig(process.env),
  sqliteSearchRunner,
} = {}) {
  const wiki = createWikiRepository({ wikiDir });
  const sqliteSearch =
    sqliteSearchRunner ??
    createSqliteSearchRunner({ wikiDir });
  const search = createSearchWithFallback({
    engine: ragConfig.engine,
    failOpen: ragConfig.failOpen,
    legacySearch: (query, limit) => wiki.search(query, { limit }),
    sqliteSearch: (query, limit) => sqliteSearch(query, limit),
    log: (message) => process.stderr.write(`${message}\n`),
  });

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
            {
              name: "wiki_runtime_info",
              description: "Get available runtime metadata (standalone mode has no lease context).",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        });
      }

      if (method === "tools/call") {
        const name = params.name;
        const args = params.arguments ?? {};
        if (name === "wiki_search") {
          const results = search(args.query, args.limit);
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
        if (name === "wiki_runtime_info") {
          const info = {
            source: "standalone_wiki_mcp",
            bundle: null,
            lease: null,
            seat: null,
            policy: null,
            retrieval: {
              engineRequested: ragConfig.engine,
              failOpen: ragConfig.failOpen,
            },
            note: "No lease/workspace/seat metadata in standalone mode. Use bundled runtime server for full runtime info.",
          };
          return jsonRpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
            isError: false,
            metadata: info,
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
