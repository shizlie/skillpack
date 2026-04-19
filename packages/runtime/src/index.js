import {
  chainMeterEvent,
  leaseTokenInternals,
  verifyDetached,
} from "@skillpack/crypto";
import {
  evaluateTsaTokenFreshness,
  validateLeasePayload,
  validateManualTimeAttestation,
} from "@skillpack/protocol";

const DEFAULT_GRACE_SEC = 72 * 60 * 60;
const DEFAULT_MANUAL_ATTESTATION_MAX_AGE_SEC = 24 * 60 * 60;

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
  tsaPolicy,
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

  let mode = "active";
  if (nowSec <= payload.exp) {
    mode = "active";
  } else if (nowSec <= payload.exp + graceSec) {
    mode = "grace";
  } else {
    throw new Error("runtime_lease_expired_past_grace");
  }

  if (!tsaPolicy) return { mode, payload, tsa: null };

  const tsaState = evaluateTsaTokenFreshness(tsaPolicy.lastTsaTokenAtSec, nowSec, {
    maxTokenAgeSec: tsaPolicy.maxTokenAgeSec,
    warningWindowSec: tsaPolicy.warningWindowSec,
  });

  let manualAttestationUsed = false;
  if (tsaState.status === "expired") {
    const record = tsaPolicy.manualAttestation;
    if (!record) throw new Error("runtime_tsa_expired_manual_attestation_required");
    validateManualTimeAttestation(record);
    if (!Number.isInteger(record.recordedAtSec) || record.recordedAtSec <= 0) {
      throw new Error("runtime_manual_attestation_invalid_recorded_time");
    }
    if (record.attestedAtSec > nowSec || record.recordedAtSec > nowSec) {
      throw new Error("runtime_manual_attestation_from_future");
    }
    if (record.attestedAtSec < tsaPolicy.lastTsaTokenAtSec) {
      throw new Error("runtime_manual_attestation_stale");
    }
    const maxManualAttestationAgeSec =
      tsaPolicy.maxManualAttestationAgeSec ??
      DEFAULT_MANUAL_ATTESTATION_MAX_AGE_SEC;
    if (
      !Number.isInteger(maxManualAttestationAgeSec) ||
      maxManualAttestationAgeSec <= 0
    ) {
      throw new Error("runtime_manual_attestation_invalid_max_age");
    }
    if (nowSec - record.attestedAtSec > maxManualAttestationAgeSec) {
      throw new Error("runtime_manual_attestation_expired");
    }
    manualAttestationUsed = true;
  }

  return { mode, payload, tsa: { ...tsaState, manualAttestationUsed } };
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
  tsaPolicy,
  meter,
  run,
}) {
  const lease = verifyLeaseForRuntime({
    leaseToken,
    publicKeyPem,
    nowSec,
    graceSec,
    tsaPolicy,
  });
  meter?.append(
    "runtime_start",
    {
      mode: lease.mode,
      sub: lease.payload.sub,
      tsaStatus: lease.tsa?.status ?? null,
      tsaManualAttestationUsed: lease.tsa?.manualAttestationUsed ?? false,
    },
    nowSec
  );

  try {
    const result = await run({ lease: lease.payload, mode: lease.mode, tsa: lease.tsa });
    meter?.append("runtime_success", { mode: lease.mode, tsaStatus: lease.tsa?.status ?? null }, nowSec);
    return { mode: lease.mode, result, payload: lease.payload, tsa: lease.tsa };
  } catch (error) {
    meter?.append("runtime_failure", { error: error.message }, nowSec);
    throw error;
  }
}

export const runtimeInternals = {
  decodeLeaseParts,
  DEFAULT_GRACE_SEC,
  DEFAULT_MANUAL_ATTESTATION_MAX_AGE_SEC,
};
