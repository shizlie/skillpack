import { expect, test } from "bun:test";

import {
  chainMeterEvent,
  createLeaseToken,
  createMeterChainKey,
  generateEd25519KeyPair,
  signDetached,
  verifyDetached,
  verifyLeaseToken,
  verifyMeterChain,
} from "../src/index.js";

test("ed25519 detached signature: valid message verifies", () => {
  const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair();
  const msg = "skillpack-crypto-signature-smoke";
  const sig = signDetached(msg, privateKeyPem);
  expect(verifyDetached(msg, sig, publicKeyPem)).toBe(true);
});

test("ed25519 detached signature: tampered message fails", () => {
  const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair();
  const sig = signDetached("original", privateKeyPem);
  expect(verifyDetached("tampered", sig, publicKeyPem)).toBe(false);
});

test("lease token: roundtrip verify returns payload", () => {
  const now = 1_800_000_000;
  const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair();
  const token = createLeaseToken(
    {
      iss: "vendor-1",
      sub: "customer-1",
      iat: now,
      exp: now + 3600,
      jti: "lease-abc",
      leaseCounter: 4,
    },
    privateKeyPem
  );
  const payload = verifyLeaseToken(token, publicKeyPem, { nowSec: now + 60 });
  expect(payload.iss).toBe("vendor-1");
  expect(payload.leaseCounter).toBe(4);
});

test("lease token: payload tamper fails signature", () => {
  const now = 1_800_000_000;
  const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair();
  const token = createLeaseToken(
    {
      iss: "vendor-1",
      sub: "customer-1",
      iat: now,
      exp: now + 3600,
      jti: "lease-abc",
      leaseCounter: 4,
    },
    privateKeyPem
  );

  const [header, payload, signature] = token.split(".");
  const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  decoded.sub = "attacker";
  const tamperedPayload = Buffer.from(JSON.stringify(decoded))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  expect(() =>
    verifyLeaseToken(`${header}.${tamperedPayload}.${signature}`, publicKeyPem, {
      nowSec: now + 60,
    })
  ).toThrow(/lease_token_invalid_signature/);
});

test("lease token: expiry and nbf checks enforced", () => {
  const now = 1_800_000_000;
  const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair();

  const notYet = createLeaseToken(
    {
      iss: "vendor-1",
      sub: "customer-1",
      iat: now,
      nbf: now + 120,
      exp: now + 3600,
      jti: "lease-not-yet",
      leaseCounter: 1,
    },
    privateKeyPem
  );
  expect(() =>
    verifyLeaseToken(notYet, publicKeyPem, { nowSec: now, clockSkewSec: 0 })
  ).toThrow(/lease_token_not_yet_valid/);

  const expired = createLeaseToken(
    {
      iss: "vendor-1",
      sub: "customer-1",
      iat: now - 500,
      exp: now - 100,
      jti: "lease-expired",
      leaseCounter: 2,
    },
    privateKeyPem
  );
  expect(() =>
    verifyLeaseToken(expired, publicKeyPem, { nowSec: now, clockSkewSec: 0 })
  ).toThrow(/lease_token_expired/);
});

test("meter chain: valid chain verifies", () => {
  const key = createMeterChainKey();
  const t = 1_800_000_000;
  const e0 = chainMeterEvent(
    { prevHash: "GENESIS", seq: 0, at: t, kind: "invoke", data: { skill: "legal-review" } },
    key
  );
  const e1 = chainMeterEvent(
    { prevHash: e0.hash, seq: 1, at: t + 5, kind: "invoke", data: { skill: "legal-review" } },
    key
  );
  expect(verifyMeterChain([e0, e1], key)).toBe(true);
});

test("meter chain: tampered event is detected", () => {
  const key = createMeterChainKey();
  const t = 1_800_000_000;
  const e0 = chainMeterEvent(
    { prevHash: "GENESIS", seq: 0, at: t, kind: "invoke", data: { calls: 1 } },
    key
  );
  const e1 = chainMeterEvent(
    { prevHash: e0.hash, seq: 1, at: t + 5, kind: "invoke", data: { calls: 2 } },
    key
  );
  const tampered = { ...e1, data: { calls: 999 } };
  expect(() => verifyMeterChain([e0, tampered], key)).toThrow(
    /meter_hash_mismatch/
  );
});
