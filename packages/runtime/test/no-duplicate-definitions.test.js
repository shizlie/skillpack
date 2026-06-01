import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  "function toBase64Url",
  "function fromBase64Url",
  "function sortJson",
  "function canonicalJson",
  "function validatePolicySnapshot",
  "function evaluateUsageState",
  "function evaluateTimeState",
  "function evaluatePolicyDecision",
  "function evaluatePolicyToolCallDecision",
  "function evaluateEffectiveTimeWindow",
  "function validateLeasePayload",
];

const ROOT = join(import.meta.dir, "..", "src");

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.endsWith(".js") || entry.endsWith(".mjs")) out.push(full);
  }
  return out;
}

describe("runtime does not redefine canonical utilities", () => {
  for (const file of listJsFiles(ROOT)) {
    const content = readFileSync(file, "utf8");
    for (const snippet of FORBIDDEN) {
      test(`${file} must not contain "${snippet}"`, () => {
        expect(content.includes(snippet)).toBe(false);
      });
    }
  }
});
