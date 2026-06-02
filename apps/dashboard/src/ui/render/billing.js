// apps/dashboard/src/ui/render/billing.js
import {
  createOutput,
  syncSelect,
  syncOptionalSelect,
  escapeHtml,
  bindAsyncForm,
  formString,
  optionalFormString,
  formNumber,
  optionalFormNumber,
  toEpochSec,
  dateRangeLabel,
  formatMoneyCents,
} from "../formatters.js";

/**
 * Mount the billing section: pricing rules, invoice drafting, and payment
 * handoffs.
 *
 * @param {Document|Element} root
 * @param {{ api, state, onSetMetrics? }} opts
 * @returns {{ refreshBilling: function, refreshBillingSelectOptions: function }}
 */
export function mountBilling(root, { api, state, onSetMetrics }) {
  const $ = (sel) => root.querySelector(sel);
  const out = createOutput($("#billing-output"));
  const E = escapeHtml;

  // ── cascading select helpers ──────────────────────────────────────────────

  function refreshBillingCustomerOptions(prefix) {
    const providerId = $("#billing-" + prefix + "-provider").value;
    const customers = state.customers.filter(
      (c) => !providerId || c.providerId === providerId
    );
    const sync = prefix === "rule" ? syncOptionalSelect : syncSelect;
    sync(
      $("#billing-" + prefix + "-customer"),
      customers,
      "customerId",
      (c) => c.customerId,
      prefix === "rule" ? "Any customer" : "Create customer first"
    );
  }

  function refreshBillingWorkspaceOptions(prefix) {
    const providerId = $("#billing-" + prefix + "-provider").value;
    const customerId = $("#billing-" + prefix + "-customer").value;
    const workspaces = state.workspaces.filter(
      (w) =>
        (!providerId || w.providerId === providerId) &&
        (!customerId || w.customerId === customerId)
    );
    syncOptionalSelect(
      $("#billing-" + prefix + "-workspace"),
      workspaces,
      "workspaceId",
      (w) => w.workspaceId,
      "Any workspace"
    );
  }

  function refreshBillingSelectOptions() {
    for (const prefix of ["rule", "invoice"]) {
      syncSelect(
        $("#billing-" + prefix + "-provider"),
        state.providers,
        "providerId",
        (p) => p.providerId,
        "Create provider first"
      );
      refreshBillingCustomerOptions(prefix);
      refreshBillingWorkspaceOptions(prefix);
    }
    syncSelect(
      $("#billing-handoff-invoice"),
      state.invoices,
      "invoiceId",
      (inv) => inv.invoiceId + " · " + formatMoneyCents(inv.totalAmountCents, inv.currency),
      "Draft invoice first"
    );
  }

  // ── renderer ──────────────────────────────────────────────────────────────

  function renderBilling() {
    const FM = formatMoneyCents;

    $("#pricing-rules-list").innerHTML = state.pricingRules.length
      ? state.pricingRules.map((r) =>
          `<li><strong>${E(r.pricingRuleId)}</strong><span>${E(r.providerId + " / " + (r.customerId || "any customer") + " / " + (r.tool || "any tool") + " / " + FM(r.unitAmountCents, r.currency))}</span></li>`
        ).join("")
      : "<li>No pricing rules yet.</li>";

    $("#invoices-list").innerHTML = state.invoices.length
      ? state.invoices.map((inv) =>
          `<li><strong>${E(inv.invoiceId)}</strong><span>${E(inv.customerId + " / " + inv.status + " / " + FM(inv.totalAmountCents, inv.currency))}</span></li>`
        ).join("")
      : "<li>No draft invoices yet.</li>";

    $("#handoffs-list").innerHTML = state.paymentHandoffs.length
      ? state.paymentHandoffs.slice(-5).reverse().map((h) =>
          `<li><strong>${E(h.provider)}</strong><span>${E(h.invoiceId + " / " + h.status + (h.checkoutUrl ? " / " + h.checkoutUrl : ""))}</span></li>`
        ).join("")
      : "<li>No handoffs created in this session.</li>";

    $("#invoices-body").innerHTML = state.invoices.length
      ? state.invoices.map((inv) =>
          `<tr><td>${E(inv.invoiceId)}</td><td>${E(inv.customerId)}</td><td>${E(inv.status)}</td><td>${E(dateRangeLabel(inv.periodStartSec, inv.periodEndSec))}</td><td>${E(FM(inv.totalAmountCents, inv.currency))}</td></tr>`
        ).join("")
      : '<tr><td colspan="5">No invoices drafted yet.</td></tr>';

    refreshBillingSelectOptions();
    onSetMetrics?.();
  }

  // ── data fetcher ──────────────────────────────────────────────────────────

  async function refreshBilling() {
    const pr = await api("/v1/billing/pricing-rules");
    state.pricingRules = pr.pricingRules || [];
    const inv = await api("/v1/billing/invoices");
    state.invoices = inv.invoices || [];
    renderBilling();
    out.set({ pricingRules: state.pricingRules.length, invoices: state.invoices.length });
  }

  // ── form handlers ─────────────────────────────────────────────────────────

  async function handleBillingPricingRuleSubmit(event) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const paymentProvider = {
      provider: formString(fd, "paymentProvider") || "manual",
      productId: optionalFormString(fd, "productId"),
      priceId: optionalFormString(fd, "priceId"),
    };
    const res = await api("/v1/billing/pricing-rules", {
      method: "POST",
      body: {
        pricingRuleId: formString(fd, "pricingRuleId"),
        providerId: formString(fd, "providerId"),
        customerId: optionalFormString(fd, "customerId"),
        workspaceId: optionalFormString(fd, "workspaceId"),
        skillId: optionalFormString(fd, "skillId"),
        bundleId: optionalFormString(fd, "bundleId"),
        tool: optionalFormString(fd, "tool"),
        currency: formString(fd, "currency") || "USD",
        unitAmountCents: formNumber(fd, "unitAmountCents"),
        includedUnits: optionalFormNumber(fd, "includedUnits"),
        minimumAmountCents: optionalFormNumber(fd, "minimumAmountCents"),
        paymentProvider,
      },
    });
    out.set(res);
    event.currentTarget.reset();
    event.currentTarget.elements.currency.value = "USD";
    event.currentTarget.elements.unitAmountCents.value = "25";
    event.currentTarget.elements.includedUnits.value = "0";
    event.currentTarget.elements.minimumAmountCents.value = "0";
    await refreshBilling();
  }

  async function handleBillingInvoiceDraft(event) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const res = await api("/v1/billing/invoices/draft", {
      method: "POST",
      body: {
        invoiceId: optionalFormString(fd, "invoiceId"),
        providerId: formString(fd, "providerId"),
        customerId: formString(fd, "customerId"),
        workspaceId: optionalFormString(fd, "workspaceId"),
        periodStartSec: toEpochSec(formString(fd, "periodStart")),
        periodEndSec: toEpochSec(formString(fd, "periodEnd")),
        currency: optionalFormString(fd, "currency"),
      },
    });
    out.set(res);
    await refreshBilling();
  }

  async function handleBillingPaymentHandoff(event) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const invoiceId = formString(fd, "invoiceId");
    const customer =
      optionalFormString(fd, "customerEmail") || optionalFormString(fd, "customerName")
        ? {
            email: optionalFormString(fd, "customerEmail"),
            name: optionalFormString(fd, "customerName"),
          }
        : undefined;
    const res = await api(
      "/v1/billing/invoices/" + encodeURIComponent(invoiceId) + "/payment-handoff",
      {
        method: "POST",
        body: {
          provider: formString(fd, "provider") || "manual",
          returnUrl: optionalFormString(fd, "returnUrl"),
          customer,
        },
      }
    );
    if (res.paymentHandoff) state.paymentHandoffs.push(res.paymentHandoff);
    renderBilling();
    out.set(res);
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  bindAsyncForm("#billing-pricing-rule-form", handleBillingPricingRuleSubmit, out);
  bindAsyncForm("#billing-invoice-draft-form", handleBillingInvoiceDraft, out);
  bindAsyncForm("#billing-payment-handoff-form", handleBillingPaymentHandoff, out);

  $("#billing-rule-provider").addEventListener("change", () => {
    refreshBillingCustomerOptions("rule");
    refreshBillingWorkspaceOptions("rule");
  });
  $("#billing-rule-customer").addEventListener("change", () => refreshBillingWorkspaceOptions("rule"));
  $("#billing-invoice-provider").addEventListener("change", () => {
    refreshBillingCustomerOptions("invoice");
    refreshBillingWorkspaceOptions("invoice");
  });
  $("#billing-invoice-customer").addEventListener("change", () => refreshBillingWorkspaceOptions("invoice"));

  $("#refresh-billing").addEventListener("click", () => {
    refreshBilling().catch((e) => out.set({ error: e.message }, true));
  });

  return { refreshBilling, refreshBillingSelectOptions };
}
