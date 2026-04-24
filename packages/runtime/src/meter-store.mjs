import fs from "node:fs";
import path from "node:path";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePendingBatch(batch) {
  if (!isPlainObject(batch)) return null;
  if (typeof batch.leaseJti !== "string" || batch.leaseJti.length === 0) return null;
  if (typeof batch.leaseToken !== "string" || batch.leaseToken.length === 0) return null;
  if (!Array.isArray(batch.events)) return null;
  return {
    leaseJti: batch.leaseJti,
    leaseToken: batch.leaseToken,
    context: isPlainObject(batch.context) ? { ...batch.context } : {},
    events: batch.events.filter(
      (event) => isPlainObject(event) && Number.isInteger(event.seq)
    ),
  };
}

function normalizeToolUsageCounts(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, count]) => typeof key === "string" && Number.isFinite(count) && count >= 0
    )
  );
}

function normalizeState(state) {
  if (!isPlainObject(state)) return null;
  const pendingBatches = Array.isArray(state.pendingBatches)
    ? state.pendingBatches.map(normalizePendingBatch).filter(Boolean)
    : [];
  const inFlightBatches = Array.isArray(state.inFlightBatches)
    ? state.inFlightBatches.map(normalizePendingBatch).filter(Boolean)
    : [];
  return {
    chainKey:
      typeof state.chainKey === "string" && state.chainKey.length > 0
        ? state.chainKey
        : null,
    seq: Number.isInteger(state.seq) && state.seq >= 0 ? state.seq : null,
    prevHash:
      typeof state.prevHash === "string" && state.prevHash.length > 0
        ? state.prevHash
        : null,
    leaseJti:
      typeof state.leaseJti === "string" && state.leaseJti.length > 0
        ? state.leaseJti
        : null,
    pendingBatches,
    inFlightBatches,
    toolUsageCounts: normalizeToolUsageCounts(state.toolUsageCounts),
    updatedAt:
      Number.isInteger(state.updatedAt) && state.updatedAt > 0
        ? state.updatedAt
        : null,
  };
}

function mergeState(currentState, patch) {
  const merged = {
    ...(currentState ?? {}),
    ...(patch ?? {}),
  };
  return normalizeState(merged);
}

function ensureBatch(state, leaseJti, leaseToken, context) {
  const pendingBatches = Array.isArray(state.pendingBatches)
    ? [...state.pendingBatches]
    : [];
  const existingIndex = pendingBatches.findIndex((batch) => batch.leaseJti === leaseJti);
  if (existingIndex >= 0) {
    const current = pendingBatches[existingIndex];
    pendingBatches[existingIndex] = {
      ...current,
      leaseToken:
        typeof leaseToken === "string" && leaseToken.length > 0
          ? leaseToken
          : current.leaseToken,
      context: isPlainObject(context) ? { ...context } : current.context,
      events: [...current.events],
    };
    state.pendingBatches = pendingBatches;
    return pendingBatches[existingIndex];
  }
  const created = {
    leaseJti,
    leaseToken,
    context: isPlainObject(context) ? { ...context } : {},
    events: [],
  };
  pendingBatches.push(created);
  state.pendingBatches = pendingBatches;
  return created;
}

export function createMemoryMeterStore(initialState = null) {
  let state = normalizeState(initialState) ?? normalizeState({});

  return {
    readState() {
      return clone(state);
    },
    writeState(patch = {}) {
      state = mergeState(state, patch) ?? normalizeState({});
      return clone(state);
    },
    listPendingBatches() {
      return clone(state.pendingBatches ?? []);
    },
    claimPendingBatch() {
      const nextState = clone(state);
      const [batch, ...rest] = nextState.pendingBatches ?? [];
      if (!batch) return null;
      nextState.pendingBatches = rest;
      nextState.inFlightBatches = [...(nextState.inFlightBatches ?? []), batch];
      state = mergeState(state, nextState) ?? normalizeState({});
      return clone(batch);
    },
    appendPendingBatchEvent({ leaseJti, leaseToken, context, event }) {
      const nextState = clone(state);
      const batch = ensureBatch(nextState, leaseJti, leaseToken, context);
      batch.events.push(clone(event));
      state = mergeState(state, nextState) ?? normalizeState({});
      return clone(event);
    },
    acknowledgeClaimedBatch(leaseJti) {
      state = mergeState(state, {
        inFlightBatches: (state.inFlightBatches ?? []).filter(
          (batch) => batch.leaseJti !== leaseJti
        ),
      });
      return clone(state);
    },
    restoreClaimedBatch(leaseJti) {
      const claimed = (state.inFlightBatches ?? []).find(
        (batch) => batch.leaseJti === leaseJti
      );
      if (!claimed) return clone(state);
      state = mergeState(state, {
        inFlightBatches: (state.inFlightBatches ?? []).filter(
          (batch) => batch.leaseJti !== leaseJti
        ),
        pendingBatches: [claimed, ...(state.pendingBatches ?? [])],
      });
      return clone(state);
    },
    restoreAllClaimedBatches() {
      state = mergeState(state, {
        pendingBatches: [
          ...(state.inFlightBatches ?? []),
          ...(state.pendingBatches ?? []),
        ],
        inFlightBatches: [],
      });
      return clone(state);
    },
    acknowledgePendingBatch(leaseJti) {
      state = mergeState(state, {
        pendingBatches: (state.pendingBatches ?? []).filter(
          (batch) => batch.leaseJti !== leaseJti
        ),
      });
      return clone(state);
    },
  };
}

export function createFileMeterStore({
  meterLogPath,
  meterStatePath,
  currentLeaseJti,
} = {}) {
  function readFileState() {
    try {
      if (!meterStatePath || !fs.existsSync(meterStatePath)) return normalizeState({});
      return normalizeState(JSON.parse(fs.readFileSync(meterStatePath, "utf8"))) ??
        normalizeState({});
    } catch {
      return normalizeState({});
    }
  }

  function writeFileState(state) {
    if (!meterStatePath) return clone(state);
    try {
      fs.mkdirSync(path.dirname(meterStatePath), { recursive: true });
      fs.writeFileSync(
        meterStatePath,
        JSON.stringify(
          {
            ...state,
            leaseJti: state.leaseJti ?? currentLeaseJti ?? null,
          },
          null,
          2
        ) + "\n",
        { mode: 0o600 }
      );
    } catch {
      // Non-fatal; keep best-effort parity with the existing runtime behavior.
    }
    return clone(state);
  }

  return {
    readState() {
      return clone(readFileState());
    },
    writeState(patch = {}) {
      const nextState = mergeState(readFileState(), patch) ?? normalizeState({});
      return writeFileState(nextState);
    },
    listPendingBatches() {
      return clone(readFileState().pendingBatches ?? []);
    },
    claimPendingBatch() {
      const nextState = readFileState();
      const [batch, ...rest] = nextState.pendingBatches ?? [];
      if (!batch) return null;
      nextState.pendingBatches = rest;
      nextState.inFlightBatches = [...(nextState.inFlightBatches ?? []), batch];
      writeFileState(nextState);
      return clone(batch);
    },
    appendPendingBatchEvent({ leaseJti, leaseToken, context, event }) {
      if (!meterLogPath) throw new Error("meter_store_missing_log_path");
      fs.mkdirSync(path.dirname(meterLogPath), { recursive: true });
      fs.appendFileSync(meterLogPath, JSON.stringify(event) + "\n");
      const nextState = readFileState();
      const batch = ensureBatch(nextState, leaseJti, leaseToken, context);
      batch.events.push(clone(event));
      writeFileState(nextState);
      return clone(event);
    },
    acknowledgeClaimedBatch(leaseJti) {
      const nextState = mergeState(readFileState(), {
        inFlightBatches: (readFileState().inFlightBatches ?? []).filter(
          (batch) => batch.leaseJti !== leaseJti
        ),
      });
      return writeFileState(nextState);
    },
    restoreClaimedBatch(leaseJti) {
      const currentState = readFileState();
      const claimed = (currentState.inFlightBatches ?? []).find(
        (batch) => batch.leaseJti === leaseJti
      );
      if (!claimed) return clone(currentState);
      const nextState = mergeState(currentState, {
        inFlightBatches: (currentState.inFlightBatches ?? []).filter(
          (batch) => batch.leaseJti !== leaseJti
        ),
        pendingBatches: [claimed, ...(currentState.pendingBatches ?? [])],
      });
      return writeFileState(nextState);
    },
    restoreAllClaimedBatches() {
      const currentState = readFileState();
      const nextState = mergeState(currentState, {
        pendingBatches: [
          ...(currentState.inFlightBatches ?? []),
          ...(currentState.pendingBatches ?? []),
        ],
        inFlightBatches: [],
      });
      return writeFileState(nextState);
    },
    acknowledgePendingBatch(leaseJti) {
      const nextState = mergeState(readFileState(), {
        pendingBatches: (readFileState().pendingBatches ?? []).filter(
          (batch) => batch.leaseJti !== leaseJti
        ),
      });
      return writeFileState(nextState);
    },
  };
}
