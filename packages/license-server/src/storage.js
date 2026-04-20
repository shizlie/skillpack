export function createInMemoryLeaseStore() {
  const counters = new Map();
  const manualAttestations = [];
  const policies = new Map();
  const meterEvents = [];

  function key(customerId, seatId = "default") {
    return `${customerId}::${seatId}`;
  }

  return {
    getLatestLeaseCounter(customerId, seatId) {
      return counters.get(key(customerId, seatId));
    },
    updateLatestLeaseCounter(customerId, seatId, leaseCounter) {
      counters.set(key(customerId, seatId), leaseCounter);
    },
    addManualAttestation(record) {
      manualAttestations.push(record);
    },
    getLatestManualAttestation(customerId, seatId = "default") {
      for (let i = manualAttestations.length - 1; i >= 0; i -= 1) {
        const record = manualAttestations[i];
        if (record.customerId !== customerId) continue;
        if ((record.seatId ?? "default") !== seatId) continue;
        return record;
      }
      return null;
    },
    listManualAttestations() {
      return [...manualAttestations];
    },
    savePolicySnapshot(workspaceId, snapshot) {
      policies.set(workspaceId, snapshot);
      return snapshot;
    },
    getLatestPolicySnapshot(workspaceId) {
      return policies.get(workspaceId) ?? null;
    },
    appendMeterEvents(workspaceId, events) {
      for (const event of events) {
        meterEvents.push({ workspaceId, ...event });
      }
    },
    getUsageSummary({ workspaceId } = {}) {
      const totals = new Map();
      for (const event of meterEvents) {
        if (workspaceId && event.workspaceId !== workspaceId) continue;
        const unit = event.usage?.unit ?? event.unit;
        if (unit !== "tool_call") continue;
        const delta = event.usage?.delta ?? event.delta ?? 1;
        if (!Number.isFinite(delta)) continue;
        const seatId = event.seatId ?? "default";
        const tool = event.tool ?? "unknown";
        const key = `${event.workspaceId}::${seatId}::${tool}`;
        const current = totals.get(key);
        if (current) {
          current.totalCalls += delta;
          continue;
        }
        totals.set(key, {
          workspaceId: event.workspaceId,
          seatId,
          tool,
          unit: "tool_call",
          totalCalls: delta,
        });
      }
      return Array.from(totals.values());
    },
  };
}
