const DEFAULT_TSA_MAX_TOKEN_AGE_SEC = 7 * 24 * 60 * 60;
const DEFAULT_TSA_WARNING_WINDOW_SEC = 24 * 60 * 60;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateLeasePayload(payload) {
  if (!isPlainObject(payload)) throw new Error("lease_payload_invalid_object");

  const required = ["iss", "sub", "iat", "exp", "jti", "leaseCounter"];
  for (const key of required) {
    if (payload[key] === undefined || payload[key] === null) {
      throw new Error(`lease_payload_missing_${key}`);
    }
  }

  if (typeof payload.iss !== "string" || payload.iss.length === 0) {
    throw new Error("lease_payload_invalid_iss");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("lease_payload_invalid_sub");
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    throw new Error("lease_payload_invalid_jti");
  }
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) {
    throw new Error("lease_payload_invalid_time");
  }
  if (payload.exp <= payload.iat) {
    throw new Error("lease_payload_exp_before_iat");
  }
  if (!Number.isInteger(payload.leaseCounter) || payload.leaseCounter < 0) {
    throw new Error("lease_payload_invalid_counter");
  }

  return payload;
}

export function validateMeterEvent(event) {
  if (!isPlainObject(event)) throw new Error("meter_event_invalid_object");
  if (typeof event.prevHash !== "string" || event.prevHash.length === 0) {
    throw new Error("meter_event_invalid_prev_hash");
  }
  if (!Number.isInteger(event.seq) || event.seq < 0) {
    throw new Error("meter_event_invalid_seq");
  }
  if (!Number.isInteger(event.at) || event.at <= 0) {
    throw new Error("meter_event_invalid_time");
  }
  if (typeof event.kind !== "string" || event.kind.length === 0) {
    throw new Error("meter_event_invalid_kind");
  }
  return event;
}

export function assertMonotonicLeaseCounter(previousCounter, nextCounter) {
  if (!Number.isInteger(nextCounter) || nextCounter < 0) {
    throw new Error("lease_counter_invalid_next");
  }
  if (previousCounter === undefined || previousCounter === null) return;
  if (!Number.isInteger(previousCounter) || previousCounter < 0) {
    throw new Error("lease_counter_invalid_previous");
  }
  if (nextCounter <= previousCounter) {
    throw new Error("lease_counter_not_monotonic");
  }
}

export function validateManualTimeAttestation(input) {
  if (!isPlainObject(input)) throw new Error("manual_attestation_invalid_object");
  const required = ["operatorId", "ticketId", "reason", "attestedAtSec"];
  for (const key of required) {
    if (input[key] === undefined || input[key] === null) {
      throw new Error(`manual_attestation_missing_${key}`);
    }
  }
  if (typeof input.operatorId !== "string" || input.operatorId.length === 0) {
    throw new Error("manual_attestation_invalid_operator_id");
  }
  if (typeof input.ticketId !== "string" || input.ticketId.length === 0) {
    throw new Error("manual_attestation_invalid_ticket_id");
  }
  if (typeof input.reason !== "string" || input.reason.trim().length < 8) {
    throw new Error("manual_attestation_invalid_reason");
  }
  if (!Number.isInteger(input.attestedAtSec) || input.attestedAtSec <= 0) {
    throw new Error("manual_attestation_invalid_time");
  }
  return input;
}

export function evaluateTsaTokenFreshness(
  lastTsaTokenAtSec,
  nowSec,
  {
    maxTokenAgeSec = DEFAULT_TSA_MAX_TOKEN_AGE_SEC,
    warningWindowSec = DEFAULT_TSA_WARNING_WINDOW_SEC,
  } = {}
) {
  if (!Number.isInteger(lastTsaTokenAtSec) || lastTsaTokenAtSec <= 0) {
    throw new Error("tsa_invalid_last_token_time");
  }
  if (!Number.isInteger(nowSec) || nowSec <= 0) {
    throw new Error("tsa_invalid_now_time");
  }
  if (!Number.isInteger(maxTokenAgeSec) || maxTokenAgeSec <= 0) {
    throw new Error("tsa_invalid_max_age");
  }
  if (!Number.isInteger(warningWindowSec) || warningWindowSec < 0) {
    throw new Error("tsa_invalid_warning_window");
  }

  const ageSec = nowSec - lastTsaTokenAtSec;
  const expiresInSec = maxTokenAgeSec - ageSec;
  if (expiresInSec <= 0) {
    return { status: "expired", ageSec, expiresInSec };
  }
  if (expiresInSec <= warningWindowSec) {
    return { status: "warning", ageSec, expiresInSec };
  }
  return { status: "fresh", ageSec, expiresInSec };
}

export const protocolInternals = {
  DEFAULT_TSA_MAX_TOKEN_AGE_SEC,
  DEFAULT_TSA_WARNING_WINDOW_SEC,
};

export * from "./policy.js";
export * from "./commercial.js";
