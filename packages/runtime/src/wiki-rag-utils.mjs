export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 20;
export const SQLITE_ENGINE = "sqlite";
export const LEGACY_ENGINE = "legacy";

export function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function clampLimit(limit) {
  return Math.min(Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT, MAX_LIMIT);
}

export function toPageId(fileName) {
  return fileName.replace(/\.md$/i, "");
}

export function normalizeSqliteRows(rows, limit) {
  return rows.slice(0, clampLimit(limit)).map((row, index) => {
    const pathText = typeof row.path === "string" ? row.path : "";
    const page = toPageId(pathText);
    const text = typeof row.text === "string" ? row.text : "";
    return {
      page,
      score: clampLimit(limit) - index,
      snippet: text.replace(/\s+/g, " ").trim().slice(0, 220),
    };
  });
}

export function readWikiEngineConfig(env = process.env) {
  const rawEngine = (env.RAG_ENGINE ?? LEGACY_ENGINE).toLowerCase();
  const engine = rawEngine === SQLITE_ENGINE ? SQLITE_ENGINE : LEGACY_ENGINE;
  const failOpen = parseBool(env.RAG_FAIL_OPEN, true);
  return { engine, failOpen };
}
