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
import { fileURLToPath } from "node:url";
import {
  toBase64Url,
  fromBase64Url,
  sha256Hex,
  canonicalJson,
  isUnsafeArchivePath,
  ensureSafePathWithin,
} from "./server-util.mjs";
import {
  SQLITE_ENGINE,
  LEGACY_ENGINE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SNIPPET_SIZE,
  clampLimit,
  parseBool,
  toPageId,
  readWikiEngineConfig,
  normalizeSqliteRows,
} from "./wiki-rag-shared.mjs";
import { createLocalMeterClient } from "./local-meter-client.mjs";
import { createFileMeterStore } from "./meter-store.mjs";
import {
  createDirectUploadTransport,
  createNoopUploadTransport,
} from "./direct-upload-transport.mjs";
export { readWikiEngineConfig } from "./wiki-rag-shared.mjs";
import {
  validatePolicySnapshot,
  evaluateEffectiveTimeWindow,
  evaluateUsageState,
  evaluateTimeState,
  evaluatePolicyDecision,
  evaluatePolicyToolCallDecision,
} from "@skillpack/protocol";
export {
  validatePolicySnapshot,
  evaluateEffectiveTimeWindow,
  evaluateUsageState,
  evaluateTimeState,
  evaluatePolicyDecision,
  evaluatePolicyToolCallDecision,
};

// ── lease verification (inlined from @skillpack/runtime + @skillpack/crypto) ─

const DEFAULT_GRACE_SEC = 72 * 60 * 60;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// ── wiki (inlined from @skillpack/wiki-mcp) ───────────────────────────────────

function normalizePageName(name) {
  const t = (typeof name === "string" ? name : "").trim();
  if (!t) throw new Error("wiki_invalid_page_name");
  return t.endsWith(".md") ? t : t + ".md";
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
    const clamp = clampLimit(limit);
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

function readWikiRagBundleMetadata(extractDir) {
  if (!extractDir) return null;
  const metadataPath = path.join(extractDir, "skill", "knowledge", "wiki-rag.json");
  if (!fs.existsSync(metadataPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch {
    return null;
  }
}

function defaultWikiRagCliPath() {
  const configuredPath = (process.env.RAG_WIKI_RAG_CLI ?? "").trim();
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  const runtimeEmbeddedPath = path.join(__dirname, "wiki-rag-src", "cli.ts");
  if (fs.existsSync(runtimeEmbeddedPath)) {
    return runtimeEmbeddedPath;
  }

  return path.resolve(process.cwd(), "wiki-rag", "src", "cli.ts");
}

function runWikiRagCli({ cliPath, args, env = process.env, cwd = process.cwd() }) {
  const result = spawnSync("bun", [cliPath, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.error) {
    const code = result.error.code ? ` (${result.error.code})` : "";
    throw new Error(`wiki_rag_cli_spawn_failed${code}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(stderr || `wiki_rag_cli_failed:${args.join(" ")}`);
  }
  return (result.stdout ?? "").trim();
}

export function createSqliteWikiSearchRunner({
  wikiDir,
  extractDir,
  dbPath,
  env = process.env,
  cwd = process.cwd(),
  cliPath = defaultWikiRagCliPath(),
  metadata = readWikiRagBundleMetadata(extractDir),
} = {}) {
  const resolvedDbPath =
    dbPath ??
    (metadata?.preindexReady
      ? path.join(extractDir, "skill", "knowledge", "wiki-rag.db")
      : path.join(cwd, ".wiki-rag", "wiki-rag.db"));
  let isReady = false;

  function ensureReady() {
    if (isReady) return;
    fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

    const needsIndex = !fs.existsSync(resolvedDbPath) || metadata?.preindexReady !== true;
    if (needsIndex) {
      runWikiRagCli({
        cliPath,
        cwd,
        env,
        args: ["index", "--db", resolvedDbPath, "--root", wikiDir],
      });
    }
    isReady = true;
  }

  return function sqliteSearch(query, limit = DEFAULT_LIMIT) {
    ensureReady();
    try {
      const out = runWikiRagCli({
        cliPath,
        cwd,
        env,
        args: ["query", "--db", resolvedDbPath, "--query", query, "--limit", String(clampLimit(limit))],
      });
      const parsed = JSON.parse(out || "{}");
      return normalizeSqliteRows(Array.isArray(parsed.hits) ? parsed.hits : [], limit);
    } catch (error) {
      isReady = false;
      throw error;
    }
  };
}

export function createWikiSearchWithFallback({
  engine,
  failOpen,
  legacySearch,
  sqliteSearch,
  log = (message) => process.stderr.write(`${message}\n`),
}) {
  return function search(query, limit) {
    const out = runWikiSearchWithFallbackDetailed({
      engine,
      failOpen,
      legacySearch,
      sqliteSearch,
      query,
      limit,
      log,
    });
    return out.results;
  };
}

export function runWikiSearchWithFallbackDetailed({
  engine,
  failOpen,
  legacySearch,
  sqliteSearch,
  query,
  limit,
  log = (message) => process.stderr.write(`${message}\n`),
}) {
  if (engine !== SQLITE_ENGINE) {
    return {
      results: legacySearch(query, limit),
      pathUsed: LEGACY_ENGINE,
      fallbackUsed: false,
      fallbackReason: null,
    };
  }
  try {
    return {
      results: sqliteSearch(query, limit),
      pathUsed: SQLITE_ENGINE,
      fallbackUsed: false,
      fallbackReason: null,
    };
  } catch (error) {
    if (!failOpen) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    log(`[WARN] sqlite wiki search failed, falling back to legacy: ${reason}`);
    return {
      results: legacySearch(query, limit),
      pathUsed: LEGACY_ENGINE,
      fallbackUsed: true,
      fallbackReason: reason,
    };
  }
}

function formatWikiSearchResult(results) {
  if (results.length === 0) return "No wiki matches found.";
  return results
    .map((r, i) => `${i + 1}. ${r.page} (score=${r.score})\n${r.snippet}`)
    .join("\n\n");
}

// ── MCP JSON-RPC helpers ──────────────────────────────────────────────────────

function ok(id, result) { return { jsonrpc: "2.0", id, result }; }
function err(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

// ── startup ───────────────────────────────────────────────────────────────────

if (process.env.SKILLPACK_RUNTIME_SKIP_MAIN !== "1") {

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
  if (isUnsafeArchivePath(name)) {
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
const runtimeSeatId =
  typeof licenseData.seatId === "string" && licenseData.seatId.length > 0
    ? licenseData.seatId
    : "default";

if (!licenseData.leaseToken) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  process.stderr.write("[ERROR] license.json has no leaseToken — was this bundle built with a valid license?\n");
  process.exit(1);
}

// Verify manifest hash + signature + file hashes before serving any content
// `manifest` is declared here so the verified object is reused downstream — avoid re-reading from disk.
let manifest;
try {
  const manifestPath = path.join(extractDir, "manifest.json");
  const manifestRaw = fs.readFileSync(manifestPath, "utf8");
  manifest = JSON.parse(manifestRaw);
  const manifestCanonical = canonicalJson(manifest);
  const expectedManifestSha = fs.readFileSync(path.join(extractDir, "manifest.sha256"), "utf8").trim();
  const actualManifestSha = sha256Hex(manifestCanonical);
  if (expectedManifestSha !== actualManifestSha) {
    throw new Error("manifest_sha_mismatch");
  }

  const signatureB64Url = fs.readFileSync(path.join(extractDir, "signature.bin"), "utf8").trim();
  const verified = crypto.verify(null, Buffer.from(manifestCanonical), publicKeyPem, fromBase64Url(signatureB64Url));
  if (!verified) {
    throw new Error("manifest_signature_invalid");
  }

  for (const file of manifest.files ?? []) {
    if (!file || typeof file.path !== "string") {
      throw new Error("manifest_file_invalid_path");
    }
    const filePath = ensureSafePathWithin(extractDir, file.path, "manifest_file");
    if (!fs.existsSync(filePath)) throw new Error("manifest_file_missing:" + file.path);
    const bytes = fs.readFileSync(filePath);
    if (bytes.length !== file.size) throw new Error("manifest_size_mismatch:" + file.path);
    if (sha256Hex(bytes) !== file.sha256) throw new Error("manifest_hash_mismatch:" + file.path);
  }
} catch (e) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  process.stderr.write("[ERROR] bundle verification failed: " + e.message + "\n");
  process.exit(1);
}

// Load policy.json only if manifest.files contains skill/policy.json — guarantees signature coverage.
// Files not listed in manifest.files are intentionally not trusted even if physically present.
let policySnapshot = null;
const policyManifestEntry = (manifest.files ?? []).find((f) => f.path === "skill/policy.json");
if (policyManifestEntry) {
  try {
    policySnapshot = validatePolicySnapshot(
      JSON.parse(fs.readFileSync(path.join(extractDir, "skill", "policy.json"), "utf8"))
    );
  } catch (e) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    process.stderr.write("[ERROR] policy validation failed: " + e.message + "\n");
    process.exit(1);
  }
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

// Pre-check all tar entries for path traversal before extracting.
const tarListResult = spawnSync("tar", ["-tzf", wikiArchivePath], { encoding: "utf8" });
if (tarListResult.status !== 0) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(wikiExtractDir, { recursive: true, force: true });
  process.stderr.write("[ERROR] failed to list wiki archive entries: " + (tarListResult.stderr || "") + "\n");
  process.exit(1);
}
for (const entry of (tarListResult.stdout || "").split("\n").filter(Boolean)) {
  if (isUnsafeArchivePath(entry)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(wikiExtractDir, { recursive: true, force: true });
    process.stderr.write("[ERROR] tar path traversal detected in wiki archive: " + entry + "\n");
    process.exit(1);
  }
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

const ragMetadata = readWikiRagBundleMetadata(extractDir);

// Extract wiki-rag-src from signed bundle to bundleDir before cleanup.
// This is the only trusted path for the CLI — it was covered by manifest.sha256 + Ed25519.
const bundledWikiRagSrcDir = path.join(extractDir, "skill", "wiki-rag-src");
const deployedWikiRagSrcDir = path.join(bundleDir, "wiki-rag-src");
if (fs.existsSync(bundledWikiRagSrcDir)) {
  fs.rmSync(deployedWikiRagSrcDir, { recursive: true, force: true });
  fs.cpSync(bundledWikiRagSrcDir, deployedWikiRagSrcDir, { recursive: true });
}
const resolvedCliPath = path.join(deployedWikiRagSrcDir, "cli.ts");

// Clean up .mcpb extract dir — wiki is now in wikiExtractDir
fs.rmSync(extractDir, { recursive: true, force: true });

const wiki = createWikiRepository(wikiDir);
const ragConfig = readWikiEngineConfig(process.env);
const sqliteSearch = createSqliteWikiSearchRunner({
  wikiDir,
  extractDir,
  env: process.env,
  metadata: ragMetadata,
  cliPath: fs.existsSync(resolvedCliPath) ? resolvedCliPath : defaultWikiRagCliPath(),
});

// ── meter setup ───────────────────────────────────────────────────────────────

const meterLogPath = path.join(bundleDir, "meter.jsonl");
const meterStatePath = path.join(bundleDir, "meter-state.json");
const currentLeaseJti = leaseResult.payload.jti;
let meterConsecutiveFailures = 0;
const METER_FAILURE_WARN_THRESHOLD = 3;
const toolUsageBySeat = new Map();
const directMode = process.env.SKILLPACK_SYNC_MODE === "direct";
const controlPlaneBaseUrl =
  typeof process.env.SKILLPACK_CONTROL_PLANE_URL === "string" &&
  process.env.SKILLPACK_CONTROL_PLANE_URL.length > 0
    ? process.env.SKILLPACK_CONTROL_PLANE_URL
    : null;
const meterStore = createFileMeterStore({
  meterLogPath,
  meterStatePath,
  currentLeaseJti,
});
const restoredMeterState = meterStore.readState();
if (restoredMeterState?.toolUsageCounts) {
  for (const [key, value] of Object.entries(restoredMeterState.toolUsageCounts)) {
    if (typeof value === "number" && value >= 0) {
      toolUsageBySeat.set(key, value);
    }
  }
}
const localMeterClient = createLocalMeterClient({
  chainKey:
    restoredMeterState?.chainKey ??
    toBase64Url(crypto.randomBytes(32)),
  leaseToken: licenseData.leaseToken,
  currentLeaseJti,
  context: {
    workspaceId: leaseResult.payload.workspaceId,
    providerId: leaseResult.payload.providerId,
    customerId: leaseResult.payload.sub,
    skillId: leaseResult.payload.skillId,
    bundleId: leaseResult.payload.bundleId,
  },
  meterStore,
  transport:
    directMode && controlPlaneBaseUrl
      ? createDirectUploadTransport({ baseUrl: controlPlaneBaseUrl })
      : createNoopUploadTransport(),
  now: () => Math.floor(Date.now() / 1000),
});
let meterQueue = Promise.resolve();

function persistToolUsageCounts() {
  meterStore.writeState({
    toolUsageCounts: Object.fromEntries(toolUsageBySeat),
    updatedAt: Math.floor(Date.now() / 1000),
  });
}

function warnOnMeterFailure() {
  meterConsecutiveFailures += 1;
  if (meterConsecutiveFailures >= METER_FAILURE_WARN_THRESHOLD) {
    process.stderr.write(
      "[WARN] meter write failed " +
        meterConsecutiveFailures +
        " consecutive times — check disk space and permissions at " +
        meterLogPath +
        "\n"
    );
  }
}

function recordMeterEvent(kind, data = {}) {
  const task = meterQueue.then(async () => {
    try {
      const event = await localMeterClient.appendAndFlush(kind, data);
      if (!event) {
        warnOnMeterFailure();
        return null;
      }
      meterConsecutiveFailures = 0;
      return event;
    } catch {
      warnOnMeterFailure();
      return null;
    }
  });
  meterQueue = task.catch(() => null);
  return task;
}

async function flushMeterQueue() {
  await meterQueue;
  await localMeterClient.flushPending();
}

function getToolUsageCount(seatId, toolName) {
  return toolUsageBySeat.get(`${seatId}::${toolName}`) ?? 0;
}

function incrementToolUsageCount(seatId, toolName) {
  const key = `${seatId}::${toolName}`;
  toolUsageBySeat.set(key, getToolUsageCount(seatId, toolName) + 1);
  persistToolUsageCounts();
}

function evaluatePolicyForToolCall({ policy, seatId, toolName }) {
  return evaluatePolicyToolCallDecision({
    policy,
    seatId,
    toolName,
    currentCount: getToolUsageCount(seatId, toolName),
  });
}

if (localMeterClient.leaseChangedSinceLastSession) {
  await recordMeterEvent("lease_refreshed", { jti: currentLeaseJti });
}

// Log session start
await recordMeterEvent("session_start", {
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
let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  await recordMeterEvent("session_end", { reason });
  await flushMeterQueue();
  cleanup();
  process.exit(0);
}
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

// ── MCP stdio loop ────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
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
          {
            name: "wiki_runtime_info",
            description: "Get runtime lease/bundle metadata from the loaded MCP bundle.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
        await recordMeterEvent("lease_check_failed", { tool: toolName, error: e.message });
        response = err(id, -32603, "lease_expired: " + e.message);
        process.stdout.write(JSON.stringify(response) + "\n");
        return;
      }

      const policyDecision = evaluatePolicyForToolCall({
        policy: policySnapshot,
        seatId: runtimeSeatId,
        toolName,
      });

      if (policyDecision.decision === "DENY") {
        await recordMeterEvent("tool_denied", {
          tool: toolName,
          seatId: runtimeSeatId,
          policyId: policySnapshot?.policyId,
          decision: policyDecision.decision,
          reasonCodes: policyDecision.reasonCodes,
        });
        response = err(
          id,
          -32603,
          "policy_denied: " + policyDecision.reasonCodes.join(",")
        );
        process.stdout.write(JSON.stringify(response) + "\n");
        return;
      }

      await recordMeterEvent("tool_call", {
        tool: toolName,
        seatId: runtimeSeatId,
        policyId: policySnapshot?.policyId,
        decision: policyDecision.decision,
        reasonCodes: policyDecision.reasonCodes,
        usageUnit: "tool_call",
        usageDelta: 1,
      });
      incrementToolUsageCount(runtimeSeatId, toolName);

      if (toolName === "wiki_search") {
        const retrieval = runWikiSearchWithFallbackDetailed({
          engine: ragConfig.engine,
          failOpen: ragConfig.failOpen,
          legacySearch: (query, limit) => wiki.search(query, limit),
          sqliteSearch,
          query: args.query,
          limit: args.limit,
        });
        const results = retrieval.results;
        const bodyText = formatWikiSearchResult(results);
        const warningText = policyDecision.decision === "ALLOW_WITH_WARNING"
          ? `[POLICY WARNING] ${policyDecision.reasonCodes.join(", ")}`
          : null;
        const text = warningText ? `${warningText}\n${bodyText}` : bodyText;
        await recordMeterEvent("tool_success", { tool: toolName, resultCount: results.length });
        response = ok(id, {
          content: [{ type: "text", text }],
          isError: false,
          metadata: {
            retrieval: {
              engineRequested: ragConfig.engine,
              pathUsed: retrieval.pathUsed,
              fallbackUsed: retrieval.fallbackUsed,
              fallbackReason: retrieval.fallbackReason,
            },
            ...(policyDecision.decision === "ALLOW_WITH_WARNING"
              ? {
                  policy: {
                    decision: policyDecision.decision,
                    reasonCodes: policyDecision.reasonCodes,
                    policyId: policySnapshot?.policyId,
                  },
                }
              : {}),
          },
        });
      } else if (toolName === "wiki_read_page") {
        const bodyText = wiki.readPage(args.page);
        const warningText = policyDecision.decision === "ALLOW_WITH_WARNING"
          ? `[POLICY WARNING] ${policyDecision.reasonCodes.join(", ")}`
          : null;
        const text = warningText ? `${warningText}\n${bodyText}` : bodyText;
        await recordMeterEvent("tool_success", { tool: toolName, page: args.page });
        response = ok(id, {
          content: [{ type: "text", text }],
          isError: false,
          metadata:
            policyDecision.decision === "ALLOW_WITH_WARNING"
              ? {
                  policy: {
                    decision: policyDecision.decision,
                    reasonCodes: policyDecision.reasonCodes,
                    policyId: policySnapshot?.policyId,
                  },
                }
              : undefined,
        });
      } else if (toolName === "wiki_runtime_info") {
        const runtimeInfo = {
          source: "mcp_bundle_runtime",
          bundle: {
            bundleId: manifest.bundleId,
            version: manifest.version ?? null,
          },
          lease: {
            mode: leaseResult.mode,
            iss: leaseResult.payload.iss,
            sub: leaseResult.payload.sub,
            iat: leaseResult.payload.iat,
            exp: leaseResult.payload.exp,
          },
          seat: {
            seatId: runtimeSeatId,
          },
          policy: {
            policyId: policySnapshot?.policyId ?? null,
            workspaceId: policySnapshot?.workspaceId ?? null,
            present: policySnapshot !== null,
          },
          retrieval: {
            engineRequested: ragConfig.engine,
            failOpen: ragConfig.failOpen,
            preindexReady: ragMetadata?.preindexReady ?? null,
          },
        };
        await recordMeterEvent("tool_success", { tool: toolName });
        response = ok(id, {
          content: [{ type: "text", text: JSON.stringify(runtimeInfo, null, 2) }],
          isError: false,
          metadata: runtimeInfo,
        });
      } else {
        await recordMeterEvent("tool_unknown", { tool: toolName });
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
    await recordMeterEvent("tool_error", { method, error: e.message });
    response = err(id, -32603, e.message ?? "internal_error");
  }

  process.stdout.write(JSON.stringify(response) + "\n");
});

rl.on("close", () => {
  void shutdown("stdin_closed");
});

process.stderr.write("[skillpack] laws-consultant wiki MCP server ready (lease mode: " + leaseResult.mode + ")\n");
process.stderr.write(
  "[skillpack] wiki retrieval engine=" + ragConfig.engine + " failOpen=" + String(ragConfig.failOpen) + "\n"
);
}
