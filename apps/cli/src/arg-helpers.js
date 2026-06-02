import fs from "node:fs";
import path from "node:path";

export function parseArgMap(args) {
  const map = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      map[key] = true;
      continue;
    }
    map[key] = next;
    i += 1;
  }
  return map;
}

export function readKey(filePath, flagName) {
  if (!filePath) throw new Error(`missing_${flagName}`);
  return fs.readFileSync(filePath, "utf8");
}

export function readJson(filePath, flagName) {
  if (!filePath) throw new Error(`missing_${flagName}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function normalizeServerUrl(serverUrl) {
  if (!serverUrl) return null;
  return serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
}

export function parseIntArg(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error("invalid_integer_arg");
  return parsed;
}

export function requireServerUrl(flags) {
  const serverUrl = normalizeServerUrl(flags["server-url"]);
  if (!serverUrl) throw new Error("missing_server_url");
  return serverUrl;
}

export function buildServerHeaders(flags) {
  const apiKey = flags["api-key"];
  return apiKey ? { "x-api-key": apiKey } : undefined;
}

function parseJsonLines(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function loadMeterEvents(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error("missing_events_file");
  const raw = fs.readFileSync(absolute, "utf8");
  if (!raw.trim()) return [];

  if (absolute.endsWith(".jsonl")) {
    return parseJsonLines(absolute);
  }

  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.events)) return parsed.events;
  throw new Error("meter_events_file_invalid_shape");
}
