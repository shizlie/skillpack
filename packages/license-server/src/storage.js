export function createInMemoryLeaseStore() {
  const counters = new Map();
  const manualAttestations = [];

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
  };
}
