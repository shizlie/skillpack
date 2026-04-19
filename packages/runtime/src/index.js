import {
  chainMeterEvent,
  leaseTokenInternals,
  verifyDetached,
} from "@skillpack/crypto";
import { validateLeasePayload } from "@skillpack/protocol";

const DEFAULT_GRACE_SEC = 72 * 60 * 60;

function decodeLeaseParts(leaseToken) {
  const parts = leaseToken.split(".");
  if (parts.length !== 3) throw new Error("runtime_lease_invalid_format");
  const [headerPart, payloadPart, signaturePart] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(
      leaseTokenInternals.fromBase64Url(headerPart).toString("utf8")
    );
    payload = JSON.parse(
      leaseTokenInternals.fromBase64Url(payloadPart).toString("utf8")
    );
  } catch {
    throw new Error("runtime_lease_invalid_json");
  }
  return { headerPart, payloadPart, signaturePart, header, payload };
}

export function verifyLeaseForRuntime({
  leaseToken,
  publicKeyPem,
  nowSec = Math.floor(Date.now() / 1000),
  graceSec = DEFAULT_GRACE_SEC,
}) {
  const { headerPart, payloadPart, signaturePart, header, payload } =
    decodeLeaseParts(leaseToken);
  if (header.alg !== "EdDSA" || header.typ !== "SPK_LEASE" || header.v !== 1) {
    throw new Error("runtime_lease_invalid_header");
  }
  validateLeasePayload(payload);
  const signed = `${headerPart}.${payloadPart}`;
  if (!verifyDetached(signed, signaturePart, publicKeyPem)) {
    throw new Error("runtime_lease_invalid_signature");
  }

  if (nowSec <= payload.exp) return { mode: "active", payload };
  if (nowSec <= payload.exp + graceSec) return { mode: "grace", payload };
  throw new Error("runtime_lease_expired_past_grace");
}

export function createRuntimeMeter({
  chainKey,
  startSeq = 0,
  startPrevHash = leaseTokenInternals.GENESIS_HASH,
}) {
  const events = [];
  let seq = startSeq;
  let prevHash = startPrevHash;

  function append(kind, data = {}, at = Math.floor(Date.now() / 1000)) {
    const event = chainMeterEvent({ prevHash, seq, at, kind, data }, chainKey);
    events.push(event);
    prevHash = event.hash;
    seq += 1;
    return event;
  }

  return {
    append,
    getEvents: () => [...events],
    state: () => ({ seq, prevHash }),
  };
}

export async function executeWithRuntimeLease({
  leaseToken,
  publicKeyPem,
  nowSec,
  graceSec = DEFAULT_GRACE_SEC,
  meter,
  run,
}) {
  const lease = verifyLeaseForRuntime({
    leaseToken,
    publicKeyPem,
    nowSec,
    graceSec,
  });
  meter?.append("runtime_start", { mode: lease.mode, sub: lease.payload.sub }, nowSec);

  try {
    const result = await run({ lease: lease.payload, mode: lease.mode });
    meter?.append("runtime_success", { mode: lease.mode }, nowSec);
    return { mode: lease.mode, result, payload: lease.payload };
  } catch (error) {
    meter?.append("runtime_failure", { error: error.message }, nowSec);
    throw error;
  }
}

export const runtimeInternals = {
  decodeLeaseParts,
  DEFAULT_GRACE_SEC,
};
