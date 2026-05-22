import { test } from "node:test";
import assert from "node:assert";
import { sha256Hash, timingSafeEqualUint8, isValidManagementKey } from "../src/crypto-utils.js";
import crypto from "node:crypto";

test("sha256Hash matches node:crypto", async () => {
  const input = "test-key-123";
  const webHash = await sha256Hash(input);
  const nodeHash = crypto.createHash("sha256").update(input).digest();
  assert.deepStrictEqual(webHash, new Uint8Array(nodeHash));
});

test("timingSafeEqualUint8 rejects mismatched lengths", () => {
  const result = timingSafeEqualUint8(new Uint8Array(4), new Uint8Array(5));
  assert.strictEqual(result, false);
});

test("isValidManagementKey constant-time rejects wrong key", async () => {
  const valid = await isValidManagementKey("wrong-key", "correct-key-12345");
  assert.strictEqual(valid, false);
});

test("isValidManagementKey accepts correct key", async () => {
  const valid = await isValidManagementKey("correct-key-12345", "correct-key-12345");
  assert.strictEqual(valid, true);
});
