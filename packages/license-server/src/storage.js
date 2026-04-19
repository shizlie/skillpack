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
    listManualAttestations() {
      return [...manualAttestations];
    },
  };
}
