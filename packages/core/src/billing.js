import { validatePricingRuleContract } from "@skillpack/protocol";

function dimensionMatches(ruleValue, usageValue) {
  return ruleValue === null || ruleValue === undefined || ruleValue === usageValue;
}

function ruleSpecificity(rule) {
  return [
    rule.customerId,
    rule.workspaceId,
    rule.skillId,
    rule.bundleId,
    rule.tool,
  ].filter((value) => value !== null && value !== undefined).length;
}

export function findPricingRuleForUsage(usage, pricingRules) {
  const matches = pricingRules
    .filter((rawRule) => {
      const rule = validatePricingRuleContract(rawRule);
      if (rule.status !== "ACTIVE") return false;
      if (rule.providerId !== usage.providerId) return false;
      if (!dimensionMatches(rule.customerId, usage.customerId)) return false;
      if (!dimensionMatches(rule.workspaceId, usage.workspaceId)) return false;
      if (!dimensionMatches(rule.skillId, usage.skillId)) return false;
      if (!dimensionMatches(rule.bundleId, usage.bundleId)) return false;
      if (!dimensionMatches(rule.tool, usage.tool)) return false;
      return rule.unit === usage.unit;
    })
    .map(validatePricingRuleContract)
    .sort((a, b) => {
      const bySpecificity = ruleSpecificity(b) - ruleSpecificity(a);
      if (bySpecificity !== 0) return bySpecificity;
      return a.pricingRuleId.localeCompare(b.pricingRuleId);
    });

  return matches[0] ?? null;
}

function groupUsageEvents(events) {
  const groups = new Map();
  for (const event of events) {
    if (event.usage?.unit !== "tool_call") continue;
    const key = JSON.stringify([
      event.providerId,
      event.customerId,
      event.workspaceId,
      event.seatId,
      event.skillId ?? null,
      event.bundleId ?? null,
      event.tool,
      event.usage.unit,
    ]);
    const existing = groups.get(key);
    if (existing) {
      existing.quantity += event.usage.delta;
      continue;
    }
    groups.set(key, {
      providerId: event.providerId,
      customerId: event.customerId,
      workspaceId: event.workspaceId,
      seatId: event.seatId,
      skillId: event.skillId ?? null,
      bundleId: event.bundleId ?? null,
      tool: event.tool,
      unit: event.usage.unit,
      quantity: event.usage.delta,
    });
  }
  return Array.from(groups.values()).sort((a, b) =>
    [
      a.providerId,
      a.customerId,
      a.workspaceId,
      a.seatId,
      a.skillId ?? "",
      a.bundleId ?? "",
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
          b.tool,
        ].join("::")
      )
  );
}

export function draftInvoiceFromUsage({
  invoiceId,
  providerId,
  customerId,
  workspaceId = null,
  periodStartSec,
  periodEndSec,
  currency = null,
  usageEvents,
  pricingRules,
}) {
  const lines = [];
  for (const usage of groupUsageEvents(usageEvents)) {
    const rule = findPricingRuleForUsage(usage, pricingRules);
    if (!rule) {
      throw new Error(`pricing_rule_not_found:${usage.providerId}:${usage.customerId}:${usage.tool}`);
    }
    const invoiceCurrency = currency ?? rule.currency;
    if (lines.length > 0 && lines[0].currency !== invoiceCurrency) {
      throw new Error("invoice_currency_mismatch");
    }
    const billableQuantity = Math.max(0, usage.quantity - rule.includedUnits);
    const usageAmount = Math.round(billableQuantity * rule.unitAmountCents);
    const amountCents = Math.max(usageAmount, rule.minimumAmountCents);
    lines.push({
      invoiceLineId: `${invoiceId}:${rule.pricingRuleId}:${lines.length + 1}`,
      invoiceId,
      pricingRuleId: rule.pricingRuleId,
      providerId: usage.providerId,
      customerId: usage.customerId,
      workspaceId: usage.workspaceId,
      seatId: usage.seatId,
      skillId: usage.skillId,
      bundleId: usage.bundleId,
      tool: usage.tool,
      unit: usage.unit,
      quantity: usage.quantity,
      billableQuantity,
      currency: invoiceCurrency,
      unitAmountCents: rule.unitAmountCents,
      amountCents,
      periodStartSec,
      periodEndSec,
      paymentProvider: rule.paymentProvider,
    });
  }

  const subtotalAmountCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return {
    invoiceId,
    providerId,
    customerId,
    workspaceId,
    status: "DRAFT",
    currency: currency ?? lines[0]?.currency ?? "USD",
    periodStartSec,
    periodEndSec,
    subtotalAmountCents,
    totalAmountCents: subtotalAmountCents,
    lines,
  };
}
