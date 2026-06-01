// Pure utility functions shared between server.mjs and the test suite.
// No side effects. Only Node.js built-ins.

import path from "node:path";
import crypto from "node:crypto";

export function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return crypto.createHash("sha256").update(buf).digest("hex");
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
