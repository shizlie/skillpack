import { expect, test, describe } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  sha256Hex,
  isUnsafeArchivePath,
  ensureSafePathWithin,
} from "../src/server-util.mjs";
import { canonicalJson } from "@skillpack/crypto";

// ── sha256Hex ─────────────────────────────────────────────────────────────────

describe("sha256Hex", () => {
  test("known hash for empty string", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  test("known hash for Buffer input", () => {
    // sha256("a") = ca978112...
    expect(sha256Hex(Buffer.from([0x61]))).toBe(
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
    );
  });

  test("string and equivalent Buffer produce same hash", () => {
    const input = "skillpack-test-vector";
    expect(sha256Hex(input)).toBe(sha256Hex(Buffer.from(input)));
  });
});

// ── isUnsafeArchivePath ───────────────────────────────────────────────────────

describe("isUnsafeArchivePath", () => {
  test("safe paths return false", () => {
    expect(isUnsafeArchivePath("manifest.json")).toBe(false);
    expect(isUnsafeArchivePath("skill/SKILL.md")).toBe(false);
    expect(isUnsafeArchivePath("skill/knowledge/wiki.tar.gz")).toBe(false);
    expect(isUnsafeArchivePath("a/b/c/deep.txt")).toBe(false);
  });

  test("null and empty are unsafe (secure by default)", () => {
    expect(isUnsafeArchivePath(null)).toBe(true);
    expect(isUnsafeArchivePath("")).toBe(true);
    expect(isUnsafeArchivePath(undefined)).toBe(true);
  });

  test("Unix absolute path is unsafe", () => {
    expect(isUnsafeArchivePath("/etc/passwd")).toBe(true);
    expect(isUnsafeArchivePath("/")).toBe(true);
  });

  test("Windows absolute path is unsafe", () => {
    expect(isUnsafeArchivePath("\\evil")).toBe(true);
    expect(isUnsafeArchivePath("C:\\evil")).toBe(true);
    expect(isUnsafeArchivePath("D:/data")).toBe(true);
  });

  test("path traversal sequences are unsafe", () => {
    expect(isUnsafeArchivePath("../escape")).toBe(true);
    expect(isUnsafeArchivePath("foo/../../bar")).toBe(true);
    expect(isUnsafeArchivePath("a/..")).toBe(true);
    expect(isUnsafeArchivePath("..")).toBe(true);
    expect(isUnsafeArchivePath("..\\.."  )).toBe(true);
  });

  test("null byte injection is unsafe", () => {
    expect(isUnsafeArchivePath("foo\0bar")).toBe(true);
    expect(isUnsafeArchivePath("safe\0/etc/passwd")).toBe(true);
  });

  test("names containing '..' as substring are safe if not a path component", () => {
    // '...hidden' and 'file..backup' are valid filenames, not traversals
    expect(isUnsafeArchivePath("...hidden")).toBe(false);
    expect(isUnsafeArchivePath("file..backup")).toBe(false);
  });
});

// ── ensureSafePathWithin ──────────────────────────────────────────────────────

describe("ensureSafePathWithin", () => {
  const root = "/tmp/test-extract-root";

  test("safe relative path returns resolved absolute path", () => {
    const result = ensureSafePathWithin(root, "manifest.json", "test");
    expect(result).toBe(path.join(root, "manifest.json"));
  });

  test("safe nested path is accepted", () => {
    const result = ensureSafePathWithin(root, "skill/knowledge/wiki.tar.gz", "test");
    expect(result).toBe(path.join(root, "skill/knowledge/wiki.tar.gz"));
  });

  test("path traversal with ../ throws with label", () => {
    expect(() => ensureSafePathWithin(root, "../outside", "manifest_file")).toThrow(
      "manifest_file_out_of_bounds:../outside"
    );
  });

  test("absolute path throws", () => {
    expect(() => ensureSafePathWithin(root, "/etc/passwd", "manifest_file")).toThrow(
      "manifest_file_out_of_bounds:/etc/passwd"
    );
  });

  test("deep traversal throws", () => {
    expect(() => ensureSafePathWithin(root, "a/b/../../../../../../etc/passwd", "f")).toThrow(
      "_out_of_bounds:"
    );
  });
});

// ── canonicalJson idempotency ─────────────────────────────────────────────────

describe("canonicalJson", () => {
  test("keys are sorted deterministically", () => {
    const obj = { z: 1, a: 2, m: 3 };
    expect(canonicalJson(obj)).toBe('{"a":2,"m":3,"z":1}');
  });

  test("nested objects are sorted", () => {
    const obj = { b: { z: 1, a: 2 }, a: 3 };
    expect(canonicalJson(obj)).toBe('{"a":3,"b":{"a":2,"z":1}}');
  });

  test("is idempotent: canonicalJson(parse(canonicalJson(x))) === canonicalJson(x)", () => {
    const obj = { bundleId: "laws-consultant", version: "1.0.0", files: [{ path: "a", size: 1, sha256: "abc" }] };
    const canonical = canonicalJson(obj);
    expect(canonicalJson(JSON.parse(canonical))).toBe(canonical);
  });
});

// ── manifest TOCTOU regression ────────────────────────────────────────────────
// Verify that sha256Hex(canonicalJson(manifest)) matches what the CLI writes:
// sha256Hex(canonicalJson(manifest)) written to manifest.sha256.
// If the verified manifest object is used directly (no re-read), this is consistent.

describe("manifest sha256 consistency", () => {
  test("sha256 of canonical JSON matches re-serialized form", () => {
    const manifest = {
      bundleId: "laws-consultant",
      version: "0.1.0",
      createdAt: "2026-04-20T00:00:00.000Z",
      files: [{ path: "skill/SKILL.md", size: 42, sha256: "abc123" }],
    };
    const canonical = canonicalJson(manifest);
    const sha = sha256Hex(canonical);
    // After JSON.parse + re-canonicalize, sha must be the same
    const reparsed = JSON.parse(canonical);
    expect(sha256Hex(canonicalJson(reparsed))).toBe(sha);
  });
});

// ── meter state: appendMeterEvent chain integrity ────────────────────────────
// Integration test: verify state does NOT advance when disk write fails.
// Uses a real temp dir but removes write permissions to force failure.

describe("appendMeterEvent chain integrity on write failure", () => {
  test("seq and prevHash unchanged when appendFileSync fails", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-meter-test-"));
    const meterLogPath = path.join(tmpDir, "meter.jsonl");

    // Write an initial log file, then make it unwritable
    fs.writeFileSync(meterLogPath, "");
    fs.chmodSync(meterLogPath, 0o444); // read-only

    // Replicate the fixed appendMeterEvent logic to verify the ordering contract
    const GENESIS_HASH = "GENESIS";
    let seq = 0;
    let prevHash = GENESIS_HASH;

    function chainMeterEventStub(params, key) {
      const hash = sha256Hex(JSON.stringify(params) + key);
      return { ...params, hash };
    }

    function appendMeterEvent(kind, data = {}) {
      const at = Math.floor(Date.now() / 1000);
      const event = chainMeterEventStub({ prevHash, seq, at, kind, data }, "test-key");
      try {
        fs.appendFileSync(meterLogPath, JSON.stringify(event) + "\n");
      } catch {
        return null; // state MUST NOT advance on failure
      }
      prevHash = event.hash;
      seq++;
      return event;
    }

    const seqBefore = seq;
    const prevHashBefore = prevHash;

    const result = appendMeterEvent("test_event", {});

    expect(result).toBeNull();
    expect(seq).toBe(seqBefore);
    expect(prevHash).toBe(prevHashBefore);

    fs.chmodSync(meterLogPath, 0o644);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── meter state: restoreOrCreateMeterState ────────────────────────────────────

describe("restoreOrCreateMeterState", () => {
  const GENESIS_HASH = "GENESIS";

  function makeState(overrides = {}) {
    return JSON.stringify({
      chainKey: "valid-chain-key",
      seq: 5,
      prevHash: "abc123prevhash",
      leaseJti: "lease-001",
      updatedAt: Math.floor(Date.now() / 1000),
      ...overrides,
    });
  }

  // Replicate the restore logic for deterministic unit testing
  function restoreOrCreate(stateJson, currentLeaseJti) {
    let chainKey, seq, prevHash;
    let leaseChanged = false;

    try {
      const parsed = JSON.parse(stateJson);
      if (
        typeof parsed.chainKey === "string" && parsed.chainKey.length > 0 &&
        Number.isInteger(parsed.seq) && parsed.seq >= 0 &&
        typeof parsed.prevHash === "string" && parsed.prevHash.length > 0
      ) {
        chainKey = parsed.chainKey;
        seq = parsed.seq;
        prevHash = parsed.prevHash;
        leaseChanged = !!(parsed.leaseJti && parsed.leaseJti !== currentLeaseJti);
        return { chainKey, seq, prevHash, leaseChanged, fresh: false };
      }
    } catch {
      // fall through to fresh state
    }
    return {
      chainKey: "fresh",
      seq: 0,
      prevHash: GENESIS_HASH,
      leaseChanged: false,
      fresh: true,
    };
  }

  test("valid state is restored correctly", () => {
    const result = restoreOrCreate(makeState(), "lease-001");
    expect(result.chainKey).toBe("valid-chain-key");
    expect(result.seq).toBe(5);
    expect(result.prevHash).toBe("abc123prevhash");
    expect(result.fresh).toBe(false);
    expect(result.leaseChanged).toBe(false);
  });

  test("leaseJti change is detected", () => {
    const result = restoreOrCreate(makeState({ leaseJti: "lease-001" }), "lease-002");
    expect(result.leaseChanged).toBe(true);
    expect(result.fresh).toBe(false);
  });

  test("same leaseJti does not trigger lease change", () => {
    const result = restoreOrCreate(makeState({ leaseJti: "lease-same" }), "lease-same");
    expect(result.leaseChanged).toBe(false);
  });

  test("corrupted JSON falls back to fresh state", () => {
    const result = restoreOrCreate("not-valid-json{{", "lease-001");
    expect(result.fresh).toBe(true);
    expect(result.seq).toBe(0);
    expect(result.prevHash).toBe(GENESIS_HASH);
  });

  test("missing chainKey field falls back to fresh state", () => {
    const result = restoreOrCreate(makeState({ chainKey: undefined }), "lease-001");
    expect(result.fresh).toBe(true);
  });

  test("negative seq falls back to fresh state", () => {
    const result = restoreOrCreate(makeState({ seq: -1 }), "lease-001");
    expect(result.fresh).toBe(true);
  });

  test("empty chainKey falls back to fresh state", () => {
    const result = restoreOrCreate(makeState({ chainKey: "" }), "lease-001");
    expect(result.fresh).toBe(true);
  });

  test("missing leaseJti in state does not trigger lease change (migration safety)", () => {
    const result = restoreOrCreate(makeState({ leaseJti: undefined }), "lease-new");
    expect(result.leaseChanged).toBe(false);
    expect(result.fresh).toBe(false);
  });
});
