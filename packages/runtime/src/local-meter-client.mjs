import { GENESIS_HASH, createRuntimeMeter } from "./runtime-meter.mjs";

function isValidState(state) {
  return (
    typeof state?.chainKey === "string" &&
    state.chainKey.length > 0 &&
    Number.isInteger(state.seq) &&
    state.seq >= 0 &&
    typeof state.prevHash === "string" &&
    state.prevHash.length > 0
  );
}

export function createLocalMeterClient({
  chainKey,
  leaseToken,
  currentLeaseJti,
  context = {},
  meterStore,
  transport,
  flushIntervalMs = 250,
  retryDelayMs = 2_000,
  now = () => Math.floor(Date.now() / 1000),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof currentLeaseJti !== "string" || currentLeaseJti.length === 0) {
    throw new Error("local_meter_client_missing_lease_jti");
  }
  if (!meterStore) throw new Error("local_meter_client_missing_meter_store");
  if (!transport?.upload) throw new Error("local_meter_client_missing_transport");

  const restoredState = meterStore.readState?.() ?? null;
  const leaseChangedSinceLastSession =
    typeof restoredState?.leaseJti === "string" &&
    restoredState.leaseJti.length > 0 &&
    restoredState.leaseJti !== currentLeaseJti;
  const useRestoredChain =
    !leaseChangedSinceLastSession && isValidState(restoredState);
  const activeChainKey = useRestoredChain ? restoredState.chainKey : chainKey;

  const meter = createRuntimeMeter({
    chainKey: activeChainKey,
    startSeq: useRestoredChain ? restoredState.seq : 0,
    startPrevHash: useRestoredChain ? restoredState.prevHash : GENESIS_HASH,
  });
  meterStore.restoreAllClaimedBatches?.();

  function persistState() {
    const state = meter.state();
    meterStore.writeState?.({
      chainKey: activeChainKey,
      seq: state.seq,
      prevHash: state.prevHash,
      leaseJti: currentLeaseJti,
      updatedAt: now(),
    });
  }

  function refreshPendingBatches() {
    return meterStore.listPendingBatches?.() ?? [];
  }

  function refreshRetainedBatches() {
    const state = meterStore.readState?.() ?? {};
    return [
      ...(Array.isArray(state.inFlightBatches) ? state.inFlightBatches : []),
      ...(Array.isArray(state.pendingBatches) ? state.pendingBatches : []),
    ];
  }

  let flushTimer = null;
  let flushTask = null;

  function clearScheduledFlush() {
    if (flushTimer !== null) {
      clearTimeoutImpl(flushTimer);
      flushTimer = null;
    }
  }

  function scheduleFlush(delayMs = flushIntervalMs) {
    if (flushTask || flushTimer !== null) {
      return;
    }
    flushTimer = setTimeoutImpl(() => {
      flushTimer = null;
      void runScheduledFlush();
    }, Math.max(0, delayMs));
  }

  async function appendAndFlush(kind, data = {}) {
    const priorState = meter.state();
    const event = meter.append(kind, data, now());
    try {
      meterStore.appendPendingBatchEvent?.({
        leaseJti: currentLeaseJti,
        leaseToken,
        context,
        event,
      });
    } catch {
      meter.restore(priorState);
      return null;
    }
    persistState();
    scheduleFlush(flushIntervalMs);
    return event;
  }

  async function flushPendingInternal() {
    let batch = meterStore.claimPendingBatch?.() ?? refreshPendingBatches()[0] ?? null;
    while (batch) {
      try {
        await transport.upload({
          leaseToken: batch.leaseToken,
          context: batch.context,
          events: [...batch.events],
        });
        meterStore.acknowledgeClaimedBatch?.(batch.leaseJti) ??
          meterStore.acknowledgePendingBatch?.(batch.leaseJti);
        persistState();
      } catch {
        meterStore.restoreClaimedBatch?.(batch.leaseJti);
        return false;
      }
      batch = meterStore.claimPendingBatch?.() ?? refreshPendingBatches()[0] ?? null;
    }
    return true;
  }

  async function runScheduledFlush() {
    if (flushTask) {
      return flushTask;
    }
    let flushed = false;
    flushTask = (async () => {
      flushed = await flushPendingInternal();
      return flushed;
    })();
    try {
      return await flushTask;
    } finally {
      flushTask = null;
      if (refreshPendingBatches().length > 0) {
        scheduleFlush(flushed ? flushIntervalMs : retryDelayMs);
      }
    }
  }

  async function flushPending() {
    clearScheduledFlush();
    const activeFlush = flushTask;
    if (activeFlush) {
      await activeFlush;
      if (refreshPendingBatches().length === 0) {
        return true;
      }
    }
    return runScheduledFlush();
  }

  if (refreshPendingBatches().length > 0) {
    scheduleFlush(0);
  }

  return {
    appendAndFlush,
    flushPending,
    getPendingEvents() {
      return refreshRetainedBatches().flatMap((batch) => batch.events);
    },
    leaseChangedSinceLastSession,
  };
}
