import { USAGE_UNIT_TOOL_CALL, WORKSPACE_STATUS_ACTIVE } from "@skillpack/protocol";

export function createInMemoryLeaseStore() {
  const counters = new Map();
  const manualAttestations = [];
  const policies = new Map();
  const meterEvents = [];
  const providers = new Map();
  const customers = new Map();
  const workspaces = new Map();

  function key(customerId, seatId = "default") {
    return `${customerId}::${seatId}`;
  }

  function customerKey(providerId, customerId) {
    return `${providerId}::${customerId}`;
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
    saveProvider(provider) {
      const existing = providers.get(provider.providerId);
      const saved = {
        providerId: provider.providerId,
        name: provider.name ?? existing?.name ?? null,
      };
      providers.set(saved.providerId, saved);
      return saved;
    },
    saveCustomer(providerId, customer) {
      if (!providers.has(providerId)) {
        throw new Error("provider_not_found");
      }
      const mapKey = customerKey(providerId, customer.customerId);
      const existing = customers.get(mapKey);
      const saved = {
        providerId,
        customerId: customer.customerId,
        name: customer.name ?? existing?.name ?? null,
      };
      customers.set(mapKey, saved);
      return saved;
    },
    saveWorkspace(workspace) {
      if (!providers.has(workspace.providerId)) {
        throw new Error("provider_not_found");
      }
      if (!customers.has(customerKey(workspace.providerId, workspace.customerId))) {
        throw new Error("customer_not_found");
      }
      const existing = workspaces.get(workspace.workspaceId);
      if (
        existing &&
        (existing.providerId !== workspace.providerId ||
          existing.customerId !== workspace.customerId)
      ) {
        throw new Error("workspace_identity_mismatch");
      }
      const saved = {
        workspaceId: workspace.workspaceId,
        providerId: workspace.providerId,
        customerId: workspace.customerId,
        name: workspace.name ?? existing?.name ?? null,
        status: workspace.status ?? existing?.status ?? WORKSPACE_STATUS_ACTIVE,
      };
      workspaces.set(saved.workspaceId, saved);
      return saved;
    },
    appendMeterEvents(events) {
      const seen = new Set(meterEvents.map((e) => e.eventId));
      for (const event of events) {
        if (!seen.has(event.eventId)) {
          seen.add(event.eventId);
          meterEvents.push({ ...event });
        }
      }
    },
    getUsageSummary({
      providerId,
      customerId,
      workspaceId,
      seatId,
      skillId,
      bundleId,
    } = {}) {
      const totals = new Map();
      for (const event of meterEvents) {
        if (providerId && event.providerId !== providerId) continue;
        if (customerId && event.customerId !== customerId) continue;
        if (workspaceId && event.workspaceId !== workspaceId) continue;
        if (seatId && event.seatId !== seatId) continue;
        if (skillId && event.skillId !== skillId) continue;
        if (bundleId && event.bundleId !== bundleId) continue;
        const unit = event.usage?.unit;
        if (unit !== USAGE_UNIT_TOOL_CALL) continue;
        const delta = event.usage?.delta;
        if (!Number.isFinite(delta)) continue;
        const keyParts = [
          event.providerId,
          event.customerId,
          event.workspaceId,
          event.seatId,
          event.skillId ?? "",
          event.bundleId ?? "",
          event.leaseJti ?? "",
          event.tool,
          unit,
        ];
        const key = JSON.stringify(keyParts);
        const current = totals.get(key);
        if (current) {
          current.totalCalls += delta;
          continue;
        }
        totals.set(key, {
          providerId: event.providerId,
          customerId: event.customerId,
          workspaceId: event.workspaceId,
          seatId: event.seatId,
          skillId: event.skillId ?? null,
          bundleId: event.bundleId ?? null,
          leaseJti: event.leaseJti ?? null,
          tool: event.tool,
          unit: USAGE_UNIT_TOOL_CALL,
          totalCalls: delta,
        });
      }
      return Array.from(totals.values()).sort((a, b) =>
        [
          a.providerId,
          a.customerId,
          a.workspaceId,
          a.seatId,
          a.skillId ?? "",
          a.bundleId ?? "",
          a.leaseJti ?? "",
          a.tool,
        ]
          .join("::")
          .localeCompare(
            [
              b.providerId,
              b.customerId,
              b.workspaceId,
              b.seatId,
              b.skillId ?? "",
              b.bundleId ?? "",
              b.leaseJti ?? "",
              b.tool,
            ].join("::")
          )
      );
    },
  };
}
