/**
 * Runtime-portable crypto utilities.
 *
 * Uses the Web Crypto API (available in CF Workers, Node ≥ 15, Bun)
 * so the same code runs everywhere without conditional imports.
 */

/**
 * SHA-256 hash of a string, returned as a Uint8Array.
 * Replacement for `crypto.createHash("sha256").update(key).digest()`.
 */
export async function sha256Hash(input) {
  const encoder = new TextEncoder();
  const data = typeof input === "string" ? encoder.encode(input) : input;
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

/**
 * Constant-time comparison of two Uint8Array values.
 * Replacement for `crypto.timingSafeEqual(a, b)`.
 *
 * Uses the XOR-accumulation pattern: compares all bytes
 * regardless of early mismatches, then checks the length
 * difference as well.
 */
export function timingSafeEqualUint8(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
    throw new Error("timingSafeEqualUint8 requires Uint8Array arguments");
  }
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Random UUID using the global Web Crypto API.
 * Available in CF Workers (nodejs_compat), Node ≥ 15, Bun.
 */
export function randomUUID() {
  return crypto.randomUUID();
}

/**
 * Async shared-key validation using Web Crypto SHA-256
 * and constant-time comparison.
 *
 * Replaces the sync `isValidManagementKey` that used
 * `node:crypto.createHash` + `crypto.timingSafeEqual`.
 */
export async function isValidManagementKey(providedApiKey, managementApiKey) {
  if (
    typeof providedApiKey !== "string" ||
    typeof managementApiKey !== "string"
  ) {
    return false;
  }
  const [providedHash, expectedHash] = await Promise.all([
    sha256Hash(providedApiKey),
    sha256Hash(managementApiKey),
  ]);
  return timingSafeEqualUint8(providedHash, expectedHash);
}