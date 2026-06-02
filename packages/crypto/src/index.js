import crypto from "node:crypto";
import {
  assertMonotonicLeaseCounter,
  validateLeasePayload,
  validateMeterEvent,
} from "@skillpack/protocol";

const LEASE_VERSION = "spk1";
const DEFAULT_CLOCK_SKEW_SEC = 300;
const GENESIS_HASH = "GENESIS";

export function toBase64Url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function fromBase64Url(value) {
  const padded = value + "===".slice((value.length + 3) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortJson(value[k])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

export function generateEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
}

export function signDetached(message, privateKeyPem) {
  const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
  const signature = crypto.sign(null, msg, privateKeyPem);
  return toBase64Url(signature);
}

export function verifyDetached(message, signatureB64Url, publicKeyPem) {
  const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
  const signature = fromBase64Url(signatureB64Url);
  return crypto.verify(null, msg, publicKeyPem, signature);
}

export function createLeaseToken(payload, privateKeyPem) {
  validateLeasePayload(payload);
  const header = { alg: "EdDSA", typ: "SPK_LEASE", v: 1 };
  const signedPayload = {
    ...payload,
    v: LEASE_VERSION,
  };
  const headerPart = toBase64Url(canonicalJson(header));
  const payloadPart = toBase64Url(canonicalJson(signedPayload));
  const message = `${headerPart}.${payloadPart}`;
  const sigPart = signDetached(message, privateKeyPem);
  return `${headerPart}.${payloadPart}.${sigPart}`;
}

export function verifyLeaseToken(
  token,
  publicKeyPem,
  options = {}
) {
  const { nowSec = Math.floor(Date.now() / 1000), clockSkewSec = DEFAULT_CLOCK_SKEW_SEC } =
    options;

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("lease_token_invalid_format");
  const [headerPart, payloadPart, sigPart] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(fromBase64Url(headerPart).toString("utf8"));
    payload = JSON.parse(fromBase64Url(payloadPart).toString("utf8"));
  } catch {
    throw new Error("lease_token_invalid_json");
  }

  if (header.alg !== "EdDSA" || header.typ !== "SPK_LEASE" || header.v !== 1) {
    throw new Error("lease_token_invalid_header");
  }
  if (payload.v !== LEASE_VERSION) throw new Error("lease_token_invalid_version");
  validateLeasePayload(payload);

  const message = `${headerPart}.${payloadPart}`;
  if (!verifyDetached(message, sigPart, publicKeyPem)) {
    throw new Error("lease_token_invalid_signature");
  }

  if (payload.nbf !== undefined && nowSec + clockSkewSec < payload.nbf) {
    throw new Error("lease_token_not_yet_valid");
  }
  if (nowSec - clockSkewSec > payload.exp) {
    throw new Error("lease_token_expired");
  }
  return payload;
}

export function createMeterChainKey() {
  return toBase64Url(crypto.randomBytes(32));
}

export function chainMeterEvent({ prevHash = GENESIS_HASH, seq, at, kind, data }, chainKeyB64Url) {
  validateMeterEvent({ prevHash, seq, at, kind, data });
  if (!chainKeyB64Url) throw new Error("meter_missing_key");

  const event = { prevHash, seq, at, kind, data };
  const canonical = canonicalJson(event);
  const hmac = crypto
    .createHmac("sha256", fromBase64Url(chainKeyB64Url))
    .update(canonical)
    .digest();
  return {
    ...event,
    hash: toBase64Url(hmac),
  };
}

export function verifyMeterChain(events, chainKeyB64Url) {
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < events.length; i += 1) {
    const item = events[i];
    if (item.prevHash !== expectedPrev) {
      throw new Error(`meter_invalid_prev_hash_at_${i}`);
    }
    const rebuilt = chainMeterEvent(
      {
        prevHash: item.prevHash,
        seq: item.seq,
        at: item.at,
        kind: item.kind,
        data: item.data,
      },
      chainKeyB64Url
    );
    if (rebuilt.hash !== item.hash) {
      throw new Error(`meter_hash_mismatch_at_${i}`);
    }
    expectedPrev = item.hash;
  }
  return true;
}

export const leaseTokenInternals = {
  toBase64Url,
  fromBase64Url,
  LEASE_VERSION,
  DEFAULT_CLOCK_SKEW_SEC,
  GENESIS_HASH,
};

export { assertMonotonicLeaseCounter };
