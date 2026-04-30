import { USAGE_UNIT_TOOL_CALL, WORKSPACE_STATUS_ACTIVE } from "@skillpack/protocol";

export function createInMemoryLeaseStore() {
  const counters = new Map();
  const manualAttestations = [];
  const policies = new Map();
  const meterEvents = [];
  const providers = new Map();
  const customers = new Map();
  const workspaces = new Map();
  const pricingRules = new Map();
  const invoices = new Map();
  const paymentHandoffs = new Map();

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
    listManualAttestations({ customerId, seatId } = {}) {
      return manualAttestations.filter((r) => {
        if (customerId && r.customerId !== customerId) return false;
        if (seatId && (r.seatId ?? "default") !== seatId) return false;
        return true;
      });
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
    listProviders() {
      return Array.from(providers.values()).sort((a, b) =>
        a.providerId.localeCompare(b.providerId)
      );
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
    listCustomers(providerId) {
      return Array.from(customers.values())
        .filter((customer) => !providerId || customer.providerId === providerId)
        .sort((a, b) =>
          `${a.providerId}::${a.customerId}`.localeCompare(
            `${b.providerId}::${b.customerId}`
          )
        );
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
    listWorkspaces({ providerId, customerId } = {}) {
      return Array.from(workspaces.values())
        .filter((workspace) => {
          if (providerId && workspace.providerId !== providerId) return false;
          if (customerId && workspace.customerId !== customerId) return false;
          return true;
        })
        .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
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
    savePricingRule(rule) {
      pricingRules.set(rule.pricingRuleId, { ...rule });
      return pricingRules.get(rule.pricingRuleId);
    },
    listPricingRules({ providerId, customerId, workspaceId } = {}) {
      return Array.from(pricingRules.values())
        .filter((rule) => {
          if (providerId && rule.providerId !== providerId) return false;
          if (customerId && rule.customerId && rule.customerId !== customerId) return false;
          if (workspaceId && rule.workspaceId && rule.workspaceId !== workspaceId) return false;
          return true;
        })
        .sort((a, b) => a.pricingRuleId.localeCompare(b.pricingRuleId));
    },
    getAcceptedUsageEvents({
      providerId,
      customerId,
      workspaceId,
      periodStartSec,
      periodEndSec,
    } = {}) {
      return meterEvents
        .filter((event) => {
          if (providerId && event.providerId !== providerId) return false;
          if (customerId && event.customerId !== customerId) return false;
          if (workspaceId && event.workspaceId !== workspaceId) return false;
          if (Number.isInteger(periodStartSec) && event.eventAtSec < periodStartSec) return false;
          if (Number.isInteger(periodEndSec) && event.eventAtSec >= periodEndSec) return false;
          return true;
        })
        .map((event) => ({ ...event, usage: { ...event.usage } }));
    },
    saveInvoice(invoice) {
      invoices.set(invoice.invoiceId, { ...invoice, lines: invoice.lines.map((line) => ({ ...line })) });
      return invoices.get(invoice.invoiceId);
    },
    getInvoice(invoiceId) {
      const invoice = invoices.get(invoiceId);
      return invoice ? { ...invoice, lines: invoice.lines.map((line) => ({ ...line })) } : null;
    },
    listInvoices({ providerId, customerId } = {}) {
      return Array.from(invoices.values())
        .filter((invoice) => {
          if (providerId && invoice.providerId !== providerId) return false;
          if (customerId && invoice.customerId !== customerId) return false;
          return true;
        })
        .sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
    },
    savePaymentHandoff(handoff) {
      paymentHandoffs.set(handoff.invoiceId, { ...handoff });
      return paymentHandoffs.get(handoff.invoiceId);
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
