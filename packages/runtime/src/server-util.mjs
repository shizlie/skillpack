// Pure utility functions shared between server.mjs and the test suite.
// No side effects. Only Node.js built-ins.

import path from "node:path";
import crypto from "node:crypto";

export function toBase64Url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value) {
  const padded = value + "===".slice((value.length + 3) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortJson(value[k])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

export function isUnsafeArchivePath(name) {
  if (!name) return true;
  if (name.startsWith("/") || name.startsWith("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(name)) return true;
  if (name.includes("\0")) return true;
  return /(^|[\\/])\.\.(?:[\\/]|$)/.test(name);
}

export function ensureSafePathWithin(rootDir, relPath, label) {
  const abs = path.resolve(rootDir, relPath);
  const rel = path.relative(rootDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(label + "_out_of_bounds:" + relPath);
  }
  return abs;
}
