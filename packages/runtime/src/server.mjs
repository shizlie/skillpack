#!/usr/bin/env node
// Embedded MCP server for skillpack bundles.
// Self-contained: uses only Node.js built-ins (fs, path, os, crypto, child_process).
// Usage: node server.mjs <bundle.mcpb> [pubkey.pem]

if (parseInt(process.versions.node, 10) < 15) {
  process.stderr.write("server.mjs requires Node.js >= 15. Found: " + process.version + "\n");
  process.exit(1);
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import readline from "node:readline";

// ── base64url ────────────────────────────────────────────────────────────────

function toBase64Url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const padded = value + "===".slice((value.length + 3) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// ── canonical JSON ───────────────────────────────────────────────────────────

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortJson(value[k])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

// ── lease verification (inlined from @skillpack/runtime + @skillpack/crypto) ─

const GENESIS_HASH = "GENESIS";
const DEFAULT_GRACE_SEC = 72 * 60 * 60;

function validateLeasePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("lease_payload_invalid_object");
  }
  for (const key of ["iss", "sub", "iat", "exp", "jti", "leaseCounter"]) {
    if (payload[key] === undefined || payload[key] === null) {
      throw new Error("lease_payload_missing_" + key);
    }
  }
  if (typeof payload.iss !== "string" || payload.iss.length === 0) throw new Error("lease_payload_invalid_iss");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("lease_payload_invalid_sub");
  if (typeof payload.jti !== "string" || payload.jti.length === 0) throw new Error("lease_payload_invalid_jti");
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) throw new Error("lease_payload_invalid_time");
  if (payload.exp <= payload.iat) throw new Error("lease_payload_exp_before_iat");
  if (!Number.isInteger(payload.leaseCounter) || payload.leaseCounter < 0) throw new Error("lease_payload_invalid_counter");
}

function verifyDetached(message, signatureB64Url, publicKeyPem) {
  const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
  return crypto.verify(null, msg, publicKeyPem, fromBase64Url(signatureB64Url));
}

function verifyLeaseForRuntime({ leaseToken, publicKeyPem, nowSec = Math.floor(Date.now() / 1000), graceSec = DEFAULT_GRACE_SEC }) {
  const parts = leaseToken.split(".");
  if (parts.length !== 3) throw new Error("runtime_lease_invalid_format");
  const [headerPart, payloadPart, signaturePart] = parts;
  let header, payload;
  try {
    header = JSON.parse(fromBase64Url(headerPart).toString("utf8"));
    payload = JSON.parse(fromBase64Url(payloadPart).toString("utf8"));
  } catch {
    throw new Error("runtime_lease_invalid_json");
  }
  if (header.alg !== "EdDSA" || header.typ !== "SPK_LEASE" || header.v !== 1) {
    throw new Error("runtime_lease_invalid_header");
  }
  validateLeasePayload(payload);
  if (!verifyDetached(`${headerPart}.${payloadPart}`, signaturePart, publicKeyPem)) {
    throw new Error("runtime_lease_invalid_signature");
  }
  if (nowSec <= payload.exp) return { mode: "active", payload };
  if (nowSec <= payload.exp + graceSec) return { mode: "grace", payload };
  throw new Error("runtime_lease_expired_past_grace");
}

// ── meter (inlined from @skillpack/crypto) ────────────────────────────────────

function validateMeterEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("meter_event_invalid_object");
  if (typeof event.prevHash !== "string" || event.prevHash.length === 0) throw new Error("meter_event_invalid_prev_hash");
  if (!Number.isInteger(event.seq) || event.seq < 0) throw new Error("meter_event_invalid_seq");
  if (!Number.isInteger(event.at) || event.at <= 0) throw new Error("meter_event_invalid_time");
  if (typeof event.kind !== "string" || event.kind.length === 0) throw new Error("meter_event_invalid_kind");
}

function chainMeterEvent({ prevHash = GENESIS_HASH, seq, at, kind, data }, chainKeyB64Url) {
  const event = { prevHash, seq, at, kind, data };
  validateMeterEvent(event);
  if (!chainKeyB64Url) throw new Error("meter_missing_key");
  const canonical = canonicalJson(event);
  const hmac = crypto.createHmac("sha256", fromBase64Url(chainKeyB64Url)).update(canonical).digest();
  return { ...event, hash: toBase64Url(hmac) };
}

// ── wiki (inlined from @skillpack/wiki-mcp) ───────────────────────────────────

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

function normalizePageName(name) {
  const t = (typeof name === "string" ? name : "").trim();
  if (!t) throw new Error("wiki_invalid_page_name");
  return t.endsWith(".md") ? t : t + ".md";
}

function toPageId(fileName) {
  return fileName.replace(/\.md$/i, "");
}

function countMatches(content, query) {
  const lower = content.toLowerCase();
  const target = query.toLowerCase();
  let from = 0, total = 0;
  while (true) {
    const idx = lower.indexOf(target, from);
    if (idx === -1) break;
    total++;
    from = idx + target.length;
  }
  return total;
}

function snippetAround(content, query, size = 220) {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return content.slice(0, size);
  const start = Math.max(0, idx - Math.floor(size / 2));
  return content.slice(start, start + size);
}

function createWikiRepository(wikiDir) {
  const wikiRoot = path.resolve(wikiDir);
  function listPages() {
    return fs.readdirSync(wikiRoot).filter((f) => f.endsWith(".md")).sort();
  }
  function readPage(pageName) {
    const fileName = normalizePageName(pageName);
    const abs = path.resolve(wikiRoot, fileName);
    const rel = path.relative(wikiRoot, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("wiki_page_out_of_bounds");
    return fs.readFileSync(abs, "utf8");
  }
  function search(query, limit = DEFAULT_LIMIT) {
    if (typeof query !== "string" || !query.trim()) throw new Error("wiki_missing_query");
    const clamp = Math.min(Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT, MAX_LIMIT);
    const scored = [];
    for (const file of listPages()) {
      const content = readPage(file);
      const score = countMatches(content, query);
      if (!score) continue;
      scored.push({ page: toPageId(file), score, snippet: snippetAround(content, query).replace(/\s+/g, " ").trim() });
    }
    scored.sort((a, b) => b.score - a.score || a.page.localeCompare(b.page));
    return scored.slice(0, clamp);
  }
  return { listPages, readPage, search };
}

// ── MCP JSON-RPC helpers ──────────────────────────────────────────────────────

function ok(id, result) { return { jsonrpc: "2.0", id, result }; }
function err(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

// ── startup ───────────────────────────────────────────────────────────────────

const bundlePath = process.argv[2];
if (!bundlePath) {
  process.stderr.write("usage: node server.mjs <bundle.mcpb> [pubkey.pem]\n");
  process.exit(2);
}

const absBundlePath = path.resolve(bundlePath);
if (!fs.existsSync(absBundlePath)) {
  process.stderr.write("[ERROR] bundle not found: " + absBundlePath + "\n");
  process.exit(1);
}

// Derive public key path: same dir, same basename, .public.pem extension
const bundleBasename = path.basename(absBundlePath, ".mcpb");
const bundleDir = path.dirname(absBundlePath);
const defaultPubKeyPath = path.join(bundleDir, bundleBasename + ".public.pem");
const pubKeyPath = process.argv[3] ? path.resolve(process.argv[3]) : defaultPubKeyPath;

if (!fs.existsSync(pubKeyPath)) {
  process.stderr.write("[ERROR] public key not found: " + pubKeyPath + "\n");
  process.stderr.write("        Pass the public key as argv[3] or place it alongside the bundle.\n");
  process.exit(1);
}

const publicKeyPem = fs.readFileSync(pubKeyPath, "utf8");

// Unzip .mcpb to temp dir
const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-runtime-"));
fs.chmodSync(extractDir, 0o700);

// Guard against zip path traversal before extracting
const listResult = spawnSync("unzip", ["-l", absBundlePath], { encoding: "utf8" });
if (listResult.status !== 0) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  process.stderr.write("[ERROR] cannot read bundle: unzip -l failed\n");
  process.exit(1);
}
for (const line of (listResult.stdout || "").split("\n").slice(3)) {
  const name = line.trim().split(/\s+/).slice(3).join(" ");
  if (!name || name === "---" || name === "Name") continue;
  if (name.startsWith("/") || name.includes("../")) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    process.stderr.write("[ERROR] zip path traversal detected: " + name + "\n");
    process.exit(1);
  }
}

const unzipResult = spawnSync("unzip", ["-q", absBundlePath, "-d", extractDir], { encoding: "utf8" });
if (unzipResult.status !== 0) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  process.stderr.write("[ERROR] failed to extract bundle\n");
  process.exit(1);
}

// Read license.json
const licenseJsonPath = path.join(extractDir, "license.json");
if (!fs.existsSync(licenseJsonPath)) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  process.stderr.write("[ERROR] license.json missing from bundle\n");
  process.exit(1);
}
const licenseData = JSON.parse(fs.readFileSync(licenseJsonPath, "utf8"));

if (!licenseData.leaseToken) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  process.stderr.write("[ERROR] license.json has no leaseToken — was this bundle built with a valid license?\n");
  process.exit(1);
}

// Verify lease
let leaseResult;
try {
  leaseResult = verifyLeaseForRuntime({ leaseToken: licenseData.leaseToken, publicKeyPem });
} catch (e) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  process.stderr.write("[ERROR] lease verification failed: " + e.message + "\n");
  process.exit(1);
}

if (leaseResult.mode === "grace") {
  process.stderr.write("[WARNING] lease is in grace period — renew soon to avoid service interruption\n");
}

// Find bundleId from manifest
const manifestPath = path.join(extractDir, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const bundleId = manifest.bundleId;

// Extract wiki.tar.gz to secure temp dir
const wikiExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-wiki-"));
fs.chmodSync(wikiExtractDir, 0o700);

// The CLI copies inputDir contents directly to skill/ (no bundleId subdirectory)
const wikiArchivePath = path.join(extractDir, "skill", "knowledge", "wiki.tar.gz");
if (!fs.existsSync(wikiArchivePath)) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(wikiExtractDir, { recursive: true, force: true });
  process.stderr.write("[ERROR] wiki archive missing from bundle at: skill/knowledge/wiki.tar.gz\n");
  process.exit(1);
}

const tarResult = spawnSync("tar", ["-xzf", wikiArchivePath, "-C", wikiExtractDir], { encoding: "utf8" });
if (tarResult.status !== 0) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(wikiExtractDir, { recursive: true, force: true });
  process.stderr.write("[ERROR] failed to extract wiki archive: " + (tarResult.stderr || "") + "\n");
  process.exit(1);
}

// wiki.tar.gz was created from verticalRoot with `tar -czf ... wiki` so it extracts to wikiExtractDir/wiki/
const wikiDir = path.join(wikiExtractDir, "wiki");
if (!fs.existsSync(wikiDir)) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(wikiExtractDir, { recursive: true, force: true });
  process.stderr.write("[ERROR] wiki directory not found after extraction\n");
  process.exit(1);
}

// Clean up .mcpb extract dir — wiki is now in wikiExtractDir
fs.rmSync(extractDir, { recursive: true, force: true });

const wiki = createWikiRepository(wikiDir);

// ── meter setup ───────────────────────────────────────────────────────────────

const chainKey = toBase64Url(crypto.randomBytes(32));
let meterSeq = 0;
let meterPrevHash = GENESIS_HASH;
const meterLogPath = path.join(bundleDir, "meter.jsonl");

function appendMeterEvent(kind, data = {}) {
  const at = Math.floor(Date.now() / 1000);
  const event = chainMeterEvent({ prevHash: meterPrevHash, seq: meterSeq, at, kind, data }, chainKey);
  meterPrevHash = event.hash;
  meterSeq++;
  try {
    fs.appendFileSync(meterLogPath, JSON.stringify(event) + "\n");
  } catch {
    // non-fatal: meter write failure should not stop the server
  }
  return event;
}

// Log session start
appendMeterEvent("session_start", {
  bundleId,
  version: manifest.version,
  sub: leaseResult.payload.sub,
  mode: leaseResult.mode,
});

// ── cleanup on exit ───────────────────────────────────────────────────────────

function cleanup() {
  try { fs.rmSync(wikiExtractDir, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { appendMeterEvent("session_end", { reason: "SIGINT" }); cleanup(); process.exit(0); });
process.on("SIGTERM", () => { appendMeterEvent("session_end", { reason: "SIGTERM" }); cleanup(); process.exit(0); });

// ── MCP stdio loop ────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    const response = err(null, -32700, "parse_error");
    process.stdout.write(JSON.stringify(response) + "\n");
    return;
  }

  const { id, method, params = {} } = request;

  let response;
  try {
    if (method === "initialize") {
      response = ok(id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "skillpack-wiki-mcp", version: manifest.version ?? "0.1.0" },
        capabilities: { tools: {}, resources: {} },
      });
    } else if (method === "tools/list") {
      response = ok(id, {
        tools: [
          {
            name: "wiki_search",
            description: "Search the laws-consultant wiki. License-metered.",
            inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT } }, required: ["query"] },
          },
          {
            name: "wiki_read_page",
            description: "Read one wiki page by name. License-metered.",
            inputSchema: { type: "object", properties: { page: { type: "string" } }, required: ["page"] },
          },
        ],
      });
    } else if (method === "tools/call") {
      const toolName = params.name;
      const args = params.arguments ?? {};

      // Verify lease freshness before each tool call
      try {
        verifyLeaseForRuntime({ leaseToken: licenseData.leaseToken, publicKeyPem });
      } catch (e) {
        appendMeterEvent("lease_check_failed", { tool: toolName, error: e.message });
        response = err(id, -32603, "lease_expired: " + e.message);
        process.stdout.write(JSON.stringify(response) + "\n");
        return;
      }

      appendMeterEvent("tool_call", { tool: toolName });

      if (toolName === "wiki_search") {
        const results = wiki.search(args.query, args.limit);
        const text = results.length === 0
          ? "No wiki matches found."
          : results.map((r, i) => `${i + 1}. ${r.page} (score=${r.score})\n${r.snippet}`).join("\n\n");
        appendMeterEvent("tool_success", { tool: toolName, resultCount: results.length });
        response = ok(id, { content: [{ type: "text", text }], isError: false });
      } else if (toolName === "wiki_read_page") {
        const text = wiki.readPage(args.page);
        appendMeterEvent("tool_success", { tool: toolName, page: args.page });
        response = ok(id, { content: [{ type: "text", text }], isError: false });
      } else {
        appendMeterEvent("tool_unknown", { tool: toolName });
        response = err(id, -32602, "unknown_tool: " + toolName);
      }
    } else if (method === "resources/list") {
      const pages = wiki.listPages().map((f) => toPageId(f));
      response = ok(id, {
        resources: [
          { uri: "wiki://index", name: "Wiki Index", mimeType: "text/markdown" },
          ...pages.map((p) => ({ uri: "wiki://page/" + encodeURIComponent(p), name: p, mimeType: "text/markdown" })),
        ],
      });
    } else if (method === "resources/read") {
      const uri = params.uri ?? "";
      let pageId;
      if (uri === "wiki://index") {
        pageId = "index";
      } else if (uri.startsWith("wiki://page/")) {
        pageId = decodeURIComponent(uri.slice("wiki://page/".length));
      } else {
        response = err(id, -32602, "invalid_resource_uri");
        process.stdout.write(JSON.stringify(response) + "\n");
        return;
      }
      const text = wiki.readPage(pageId);
      response = ok(id, { contents: [{ uri, mimeType: "text/markdown", text }] });
    } else if (method === "notifications/initialized") {
      // No response needed for notifications
      return;
    } else {
      response = err(id, -32601, "method_not_found");
    }
  } catch (e) {
    appendMeterEvent("tool_error", { method, error: e.message });
    response = err(id, -32603, e.message ?? "internal_error");
  }

  process.stdout.write(JSON.stringify(response) + "\n");
});

rl.on("close", () => {
  appendMeterEvent("session_end", { reason: "stdin_closed" });
  cleanup();
  process.exit(0);
});

process.stderr.write("[skillpack] laws-consultant wiki MCP server ready (lease mode: " + leaseResult.mode + ")\n");
