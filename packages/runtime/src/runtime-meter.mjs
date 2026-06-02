import crypto from "node:crypto";
import { canonicalJson, toBase64Url, fromBase64Url } from "@skillpack/crypto";

export const GENESIS_HASH = "GENESIS";


function validateMeterEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("meter_event_invalid_object");
  }
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
}

export function chainMeterEvent(
  { prevHash = GENESIS_HASH, seq, at, kind, data },
  chainKeyB64Url
) {
  const event = { prevHash, seq, at, kind, data };
  validateMeterEvent(event);
  if (!chainKeyB64Url) throw new Error("meter_missing_key");
  const canonical = canonicalJson(event);
  const hash = crypto
    .createHmac("sha256", fromBase64Url(chainKeyB64Url))
    .update(canonical)
    .digest();
  return {
    ...event,
    hash: toBase64Url(hash),
  };
}

export function createRuntimeMeter({
  chainKey,
  startSeq = 0,
  startPrevHash = GENESIS_HASH,
} = {}) {
  let seq = startSeq;
  let prevHash = startPrevHash;
  const events = [];

  return {
    append(kind, data = {}, at = Math.floor(Date.now() / 1000)) {
      const event = chainMeterEvent({ prevHash, seq, at, kind, data }, chainKey);
      events.push(event);
      prevHash = event.hash;
      seq += 1;
      return event;
    },
    restore(state = {}) {
      seq = Number.isInteger(state.seq) && state.seq >= 0 ? state.seq : startSeq;
      prevHash =
        typeof state.prevHash === "string" && state.prevHash.length > 0
          ? state.prevHash
          : startPrevHash;
    },
    state() {
      return { seq, prevHash };
    },
    getEvents() {
      return [...events];
    },
  };
}

export const runtimeMeterInternals = {
  canonicalJson,
  fromBase64Url,
  toBase64Url,
};
