import { renderDashboardHtml as build } from "./ui/render-html.js";
import dashboardStyles from "./ui/styles.css";
export { dashboardStyles };

export function renderDashboardHtml() {
  return build({ scriptUrl: "/assets/dashboard.js", styleUrl: "/assets/dashboard.css" });
}


export const dashboardScript = `
const state = {
  config: null,
  providers: [],
  customers: [],
  workspaces: [],
  usage: [],
  pricingRules: [],
  invoices: [],
  paymentHandoffs: [],
  attestations: [],
  clerkLoaded: false,
};

function $(selector) {
  return document.querySelector(selector);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setOutput(selector, value, isError = false) {
  const node = $(selector);
  if (!node) return;
  node.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  node.classList.toggle("is-error", isError);
}

function toEpochSec(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function toLocalValue(ms) {
  const date = new Date(ms);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return yyyy + "-" + mm + "-" + dd + "T" + hh + ":" + min;
}

function formString(formData, key) {
  return String(formData.get(key) || "").trim();
}

function optionalFormString(formData, key) {
  const value = formString(formData, key);
  return value.length > 0 ? value : undefined;
}

function formNumber(formData, key, fallback = 0) {
  const value = Number(formData.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function optionalFormNumber(formData, key) {
  const raw = formString(formData, key);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function dateRangeLabel(startSec, endSec) {
  if (!startSec || !endSec) return "unknown period";
  return new Date(startSec * 1000).toLocaleDateString() + " - " + new Date(endSec * 1000).toLocaleDateString();
}

function formatMoneyCents(cents, currency = "USD") {
  const amount = Number(cents || 0) / 100;
  return currency + " " + amount.toFixed(2);
}

function setDefaultTimes() {
  const now = Date.now();
  $("#policy-issue-form").elements.startsAt.value = toLocalValue(now);
  $("#policy-issue-form").elements.expiresAt.value = toLocalValue(now + 24 * 60 * 60 * 1000);
  $("#policy-issue-form").elements.graceUntil.value = toLocalValue(now + 72 * 60 * 60 * 1000);
  $("#tsa-form").elements.attestedAt.value = toLocalValue(now);
  $("#billing-invoice-draft-form").elements.periodStart.value = toLocalValue(now - 30 * 24 * 60 * 60 * 1000);
  $("#billing-invoice-draft-form").elements.periodEnd.value = toLocalValue(now);
}

async function loadConfig() {
  const response = await fetch("/app-config");
  state.config = await response.json();
  $("#config-summary").textContent =
    "Auth mode: " +
    state.config.authMode +
    " · Clerk host: " +
    (state.config.clerkFrontendApiHost || "missing") +
    " · Proxy base: " +
    (state.config.apiProxyBase || "missing");
}

async function loadScript(src, attributes = {}) {
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.defer = true;
    script.crossOrigin = "anonymous";
    for (const [key, value] of Object.entries(attributes)) {
      script.setAttribute(key, value);
    }
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("script_load_failed"));
    document.head.appendChild(script);
  });
}

async function ensureClerk() {
  if (state.clerkLoaded) return window.Clerk;
  if (!state.config?.clerkPublishableKey || !state.config?.clerkFrontendApiHost) {
    throw new Error("clerk_not_configured");
  }

  const host = state.config.clerkFrontendApiHost;
  await loadScript("https://" + host + "/npm/@clerk/ui@1/dist/ui.browser.js");
  await loadScript(
    "https://" + host + "/npm/@clerk/clerk-js@6/dist/clerk.browser.js",
    { "data-clerk-publishable-key": state.config.clerkPublishableKey }
  );

  await window.Clerk.load({
    ui: { ClerkUI: window.__internal_ClerkUICtor },
  });
  state.clerkLoaded = true;
  return window.Clerk;
}

function showAuthenticatedShell() {
  $("#auth-root").innerHTML = "";
  $("#app-shell").hidden = false;
}

function showLockedShell(message) {
  $("#app-shell").hidden = true;
  $("#auth-root").innerHTML = '<div class="output is-error">' + escapeHtml(message) + "</div>";
}

async function renderAuthState() {
  const clerk = await ensureClerk();
  const authRoot = $("#auth-root");
  const userRoot = $("#user-root");
  authRoot.innerHTML = "";
  userRoot.innerHTML = "";

  if (clerk.isSignedIn) {
    showAuthenticatedShell();
    const userButton = document.createElement("div");
    userRoot.appendChild(userButton);
    clerk.mountUserButton(userButton);
    await refreshAll();
    return;
  }

  $("#app-shell").hidden = true;
  const signIn = document.createElement("div");
  authRoot.appendChild(signIn);
  clerk.mountSignIn(signIn, {
    signUpUrl: state.config.clerkSignUpUrl || undefined,
  });
}

async function getSessionToken() {
  const clerk = await ensureClerk();
  if (!clerk.session) {
    throw new Error("clerk_session_missing");
  }
  const token = await clerk.session.getToken();
  if (!token) {
    throw new Error("clerk_token_missing");
  }
  return token;
}

async function proxyFetch(path, { method = "GET", body } = {}) {
  const token = await getSessionToken();
  const response = await fetch((state.config.apiProxyBase || "/api") + path, {
    method,
    headers: {
      "authorization": "Bearer " + token,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "request_failed");
  }
  return data;
}

function setMetrics() {
  $("#metric-providers").textContent = String(state.providers.length);
  $("#metric-customers").textContent = String(state.customers.length);
  $("#metric-workspaces").textContent = String(state.workspaces.length);
  $("#metric-usage").textContent = String(state.usage.length);
  $("#metric-pricing-rules").textContent = String(state.pricingRules.length);
  $("#metric-invoices").textContent = String(state.invoices.length);
}

function syncSelect(node, items, valueKey, label, placeholder) {
  if (!node) return;
  const previous = node.value;
  const options = [];
  if (placeholder) {
    options.push('<option value="">' + escapeHtml(placeholder) + "</option>");
  }
  for (const item of items) {
    options.push(
      '<option value="' + escapeHtml(item[valueKey]) + '">' +
      escapeHtml(label(item)) +
      "</option>"
    );
  }
  node.innerHTML = options.join("");
  if (items.some((item) => item[valueKey] === previous)) {
    node.value = previous;
  } else if (items[0]) {
    node.value = items[0][valueKey];
  }
}

function syncOptionalSelect(node, items, valueKey, label, placeholder) {
  if (!node) return;
  const previous = node.value;
  const options = ['<option value="">' + escapeHtml(placeholder) + "</option>"];
  for (const item of items) {
    options.push(
      '<option value="' + escapeHtml(item[valueKey]) + '">' +
      escapeHtml(label(item)) +
      "</option>"
    );
  }
  node.innerHTML = options.join("");
  node.value = items.some((item) => item[valueKey] === previous) ? previous : "";
}

function refreshWorkspaceCustomerOptions() {
  const providerId = $("#workspace-provider").value;
  const customers = state.customers.filter((customer) => !providerId || customer.providerId === providerId);
  syncSelect(
    $("#workspace-customer"),
    customers,
    "customerId",
    (customer) => customer.customerId,
    "Create customer first"
  );
}

function customersForProvider(providerId) {
  return state.customers.filter((customer) => !providerId || customer.providerId === providerId);
}

function workspacesForProviderCustomer(providerId, customerId) {
  return state.workspaces.filter(
    (workspace) =>
      (!providerId || workspace.providerId === providerId) &&
      (!customerId || workspace.customerId === customerId)
  );
}

function refreshBillingCustomerOptions(prefix) {
  const providerId = $("#billing-" + prefix + "-provider").value;
  const sync = prefix === "rule" ? syncOptionalSelect : syncSelect;
  sync(
    $("#billing-" + prefix + "-customer"),
    customersForProvider(providerId),
    "customerId",
    (customer) => customer.customerId,
    prefix === "rule" ? "Any customer" : "Create customer first"
  );
}

function refreshBillingWorkspaceOptions(prefix) {
  const providerId = $("#billing-" + prefix + "-provider").value;
  const customerId = $("#billing-" + prefix + "-customer").value;
  syncOptionalSelect(
    $("#billing-" + prefix + "-workspace"),
    workspacesForProviderCustomer(providerId, customerId),
    "workspaceId",
    (workspace) => workspace.workspaceId,
    "Any workspace"
  );
}

function refreshBillingSelectOptions() {
  for (const prefix of ["rule", "invoice"]) {
    syncSelect(
      $("#billing-" + prefix + "-provider"),
      state.providers,
      "providerId",
      (provider) => provider.providerId,
      "Create provider first"
    );
    refreshBillingCustomerOptions(prefix);
    refreshBillingWorkspaceOptions(prefix);
  }
  syncSelect(
    $("#billing-handoff-invoice"),
    state.invoices,
    "invoiceId",
    (invoice) => invoice.invoiceId + " · " + formatMoneyCents(invoice.totalAmountCents, invoice.currency),
    "Draft invoice first"
  );
}

function renderHierarchy() {
  $("#providers-list").innerHTML = state.providers.length
    ? state.providers.map((provider) => "<li><strong>" + escapeHtml(provider.providerId) + "</strong><span>" + escapeHtml(provider.name || "Unnamed provider") + "</span></li>").join("")
    : "<li>No providers yet.</li>";
  $("#customers-list").innerHTML = state.customers.length
    ? state.customers.map((customer) => "<li><strong>" + escapeHtml(customer.customerId) + "</strong><span>" + escapeHtml(customer.providerId + (customer.name ? " · " + customer.name : "")) + "</span></li>").join("")
    : "<li>No customers yet.</li>";
  $("#workspaces-list").innerHTML = state.workspaces.length
    ? state.workspaces.map((workspace) => "<li><strong>" + escapeHtml(workspace.workspaceId) + "</strong><span>" + escapeHtml(workspace.providerId + " / " + workspace.customerId + " / " + workspace.status) + "</span></li>").join("")
    : "<li>No workspaces yet.</li>";
  syncSelect($("#customer-provider"), state.providers, "providerId", (provider) => provider.providerId, "Create provider first");
  syncSelect($("#workspace-provider"), state.providers, "providerId", (provider) => provider.providerId, "Create provider first");
  refreshWorkspaceCustomerOptions();
  refreshBillingSelectOptions();
  setMetrics();
}

function renderUsage() {
  $("#usage-body").innerHTML = state.usage.length
    ? state.usage.map((row) => "<tr><td>" + escapeHtml(row.providerId) + "</td><td>" + escapeHtml(row.customerId) + "</td><td>" + escapeHtml(row.workspaceId) + "</td><td>" + escapeHtml(row.seatId) + "</td><td>" + escapeHtml(row.skillId || "—") + "</td><td>" + escapeHtml(row.tool) + "</td><td>" + escapeHtml(String(row.totalCalls)) + "</td></tr>").join("")
    : '<tr><td colspan="7">No usage rows.</td></tr>';
  setMetrics();
}

function renderAttestations() {
  $("#attestations-body").innerHTML = state.attestations.length
    ? state.attestations.map((row) => "<tr><td>" + escapeHtml(row.customerId) + "</td><td>" + escapeHtml(row.seatId || "default") + "</td><td>" + escapeHtml(row.operatorId) + "</td><td>" + escapeHtml(row.ticketId) + "</td><td>" + escapeHtml(new Date(row.recordedAtSec * 1000).toLocaleString()) + "</td><td>" + escapeHtml(row.reason) + "</td></tr>").join("")
    : '<tr><td colspan="6">No manual attestations.</td></tr>';
}

function renderBilling() {
  $("#pricing-rules-list").innerHTML = state.pricingRules.length
    ? state.pricingRules.map((rule) => "<li><strong>" + escapeHtml(rule.pricingRuleId) + "</strong><span>" + escapeHtml(rule.providerId + " / " + (rule.customerId || "any customer") + " / " + (rule.tool || "any tool") + " / " + formatMoneyCents(rule.unitAmountCents, rule.currency)) + "</span></li>").join("")
    : "<li>No pricing rules yet.</li>";

  $("#invoices-list").innerHTML = state.invoices.length
    ? state.invoices.map((invoice) => "<li><strong>" + escapeHtml(invoice.invoiceId) + "</strong><span>" + escapeHtml(invoice.customerId + " / " + invoice.status + " / " + formatMoneyCents(invoice.totalAmountCents, invoice.currency)) + "</span></li>").join("")
    : "<li>No draft invoices yet.</li>";

  $("#handoffs-list").innerHTML = state.paymentHandoffs.length
    ? state.paymentHandoffs.slice(-5).reverse().map((handoff) => "<li><strong>" + escapeHtml(handoff.provider) + "</strong><span>" + escapeHtml(handoff.invoiceId + " / " + handoff.status + (handoff.checkoutUrl ? " / " + handoff.checkoutUrl : "")) + "</span></li>").join("")
    : "<li>No handoffs created in this session.</li>";

  $("#invoices-body").innerHTML = state.invoices.length
    ? state.invoices.map((invoice) => "<tr><td>" + escapeHtml(invoice.invoiceId) + "</td><td>" + escapeHtml(invoice.customerId) + "</td><td>" + escapeHtml(invoice.status) + "</td><td>" + escapeHtml(dateRangeLabel(invoice.periodStartSec, invoice.periodEndSec)) + "</td><td>" + escapeHtml(formatMoneyCents(invoice.totalAmountCents, invoice.currency)) + "</td></tr>").join("")
    : '<tr><td colspan="5">No invoices drafted yet.</td></tr>';

  refreshBillingSelectOptions();
  setMetrics();
}

async function refreshHierarchy() {
  const providers = await proxyFetch("/v1/providers");
  state.providers = providers.providers || [];
  const customers = await Promise.all(
    state.providers.map((provider) =>
      proxyFetch("/v1/providers/" + encodeURIComponent(provider.providerId) + "/customers")
    )
  );
  state.customers = customers.flatMap((response) => response.customers || []);
  const workspaces = await proxyFetch("/v1/workspaces");
  state.workspaces = workspaces.workspaces || [];
  renderHierarchy();
}

async function refreshUsage(form = $("#usage-filter-form")) {
  const params = new URLSearchParams();
  const formData = new FormData(form);
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && value.trim().length > 0) {
      params.set(key, value.trim());
    }
  }
  const response = await proxyFetch("/v1/usage/summary" + (params.size ? "?" + params.toString() : ""));
  state.usage = response.summary || [];
  renderUsage();
  setOutput("#usage-output", response);
}

async function refreshAttestations(form = $("#attestation-filter-form")) {
  const params = new URLSearchParams();
  const formData = new FormData(form);
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && value.trim().length > 0) {
      params.set(key, value.trim());
    }
  }
  const response = await proxyFetch("/v1/tsa/manual-attestations" + (params.size ? "?" + params.toString() : ""));
  state.attestations = response.records || [];
  renderAttestations();
  setOutput("#tsa-output", response);
}

async function refreshBilling() {
  const pricingRules = await proxyFetch("/v1/billing/pricing-rules");
  state.pricingRules = pricingRules.pricingRules || [];
  const invoices = await proxyFetch("/v1/billing/invoices");
  state.invoices = invoices.invoices || [];
  renderBilling();
  setOutput("#billing-output", {
    pricingRules: state.pricingRules.length,
    invoices: state.invoices.length,
  });
}

async function refreshAll() {
  await refreshHierarchy();
  await refreshUsage();
  await refreshBilling();
  await refreshAttestations();
}

async function handleProviderSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const response = await proxyFetch("/v1/providers", {
    method: "POST",
    body: {
      providerId: String(formData.get("providerId") || "").trim(),
      name: String(formData.get("name") || "").trim() || undefined,
    },
  });
  setOutput("#policy-output", response);
  event.currentTarget.reset();
  await refreshHierarchy();
}

async function handleCustomerSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const providerId = String(formData.get("providerId") || "").trim();
  const response = await proxyFetch("/v1/providers/" + encodeURIComponent(providerId) + "/customers", {
    method: "POST",
    body: {
      customerId: String(formData.get("customerId") || "").trim(),
      name: String(formData.get("name") || "").trim() || undefined,
    },
  });
  setOutput("#policy-output", response);
  event.currentTarget.reset();
  await refreshHierarchy();
}

async function handleWorkspaceSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const response = await proxyFetch("/v1/workspaces", {
    method: "POST",
    body: {
      workspaceId: String(formData.get("workspaceId") || "").trim(),
      providerId: String(formData.get("providerId") || "").trim(),
      customerId: String(formData.get("customerId") || "").trim(),
      name: String(formData.get("name") || "").trim() || undefined,
      status: String(formData.get("status") || "").trim() || undefined,
    },
  });
  setOutput("#policy-output", response);
  event.currentTarget.reset();
  await refreshHierarchy();
}

async function handlePolicyIssue(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const seatId = String(formData.get("seatId") || "").trim();
  const toolName = String(formData.get("toolName") || "").trim();
  const startsAtSec = toEpochSec(String(formData.get("startsAt") || ""));
  const expiresAtSec = toEpochSec(String(formData.get("expiresAt") || ""));
  const graceUntilSec = toEpochSec(String(formData.get("graceUntil") || ""));
  const response = await proxyFetch("/v1/policies/issue", {
    method: "POST",
    body: {
      policy: {
        policyVersion: 1,
        policyId: String(formData.get("policyId") || "").trim(),
        workspaceId: String(formData.get("workspaceId") || "").trim(),
        workspacePolicy: { mode: "ENABLED" },
        seatPolicy: {
          defaultMode: "ENABLED",
          seats: { [seatId]: { mode: "ENABLED" } },
        },
        usagePolicy: {
          unit: "tool_call",
          thresholds: {
            warningPct: Number(formData.get("warningPct") || 100),
            hardStopPct: Number(formData.get("hardStopPct") || 120),
          },
          toolBudgets: {
            [toolName]: Number(formData.get("toolBudget") || 100),
          },
        },
        timePolicy: {
          workspace: { startsAtSec, expiresAtSec, graceUntilSec },
          seatOverrides: {
            [seatId]: { startsAtSec, expiresAtSec, graceUntilSec },
          },
        },
      },
    },
  });
  setOutput("#policy-output", response);
}

async function handlePolicySync(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const response = await proxyFetch("/v1/policies/sync", {
    method: "POST",
    body: {
      workspaceId: String(formData.get("workspaceId") || "").trim(),
      policyId: String(formData.get("policyId") || "").trim() || undefined,
    },
  });
  setOutput("#policy-output", response);
}

async function handleMeterUpload(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("missing_meter_file");
  }
  const text = await file.text();
  const events = text
    .split(/\\r?\\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error("invalid_jsonl_line_" + (index + 1));
      }
    });

  const context = {};
  for (const key of ["providerId", "customerId", "seatId", "skillId", "bundleId", "leaseJti"]) {
    const value = String(formData.get(key) || "").trim();
    if (value) context[key] = value;
  }

  const response = await proxyFetch("/v1/meter/upload", {
    method: "POST",
    body: {
      workspaceId: String(formData.get("workspaceId") || "").trim(),
      context,
      events,
    },
  });
  setOutput("#usage-output", response);
  await refreshUsage();
}

async function handleBillingPricingRuleSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const paymentProvider = {
    provider: formString(formData, "paymentProvider") || "manual",
    productId: optionalFormString(formData, "productId"),
    priceId: optionalFormString(formData, "priceId"),
  };
  const response = await proxyFetch("/v1/billing/pricing-rules", {
    method: "POST",
    body: {
      pricingRuleId: formString(formData, "pricingRuleId"),
      providerId: formString(formData, "providerId"),
      customerId: optionalFormString(formData, "customerId"),
      workspaceId: optionalFormString(formData, "workspaceId"),
      skillId: optionalFormString(formData, "skillId"),
      bundleId: optionalFormString(formData, "bundleId"),
      tool: optionalFormString(formData, "tool"),
      currency: formString(formData, "currency") || "USD",
      unitAmountCents: formNumber(formData, "unitAmountCents"),
      includedUnits: optionalFormNumber(formData, "includedUnits"),
      minimumAmountCents: optionalFormNumber(formData, "minimumAmountCents"),
      paymentProvider,
    },
  });
  setOutput("#billing-output", response);
  event.currentTarget.reset();
  event.currentTarget.elements.currency.value = "USD";
  event.currentTarget.elements.unitAmountCents.value = "25";
  event.currentTarget.elements.includedUnits.value = "0";
  event.currentTarget.elements.minimumAmountCents.value = "0";
  await refreshBilling();
}

async function handleBillingInvoiceDraft(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const response = await proxyFetch("/v1/billing/invoices/draft", {
    method: "POST",
    body: {
      invoiceId: optionalFormString(formData, "invoiceId"),
      providerId: formString(formData, "providerId"),
      customerId: formString(formData, "customerId"),
      workspaceId: optionalFormString(formData, "workspaceId"),
      periodStartSec: toEpochSec(formString(formData, "periodStart")),
      periodEndSec: toEpochSec(formString(formData, "periodEnd")),
      currency: optionalFormString(formData, "currency"),
    },
  });
  setOutput("#billing-output", response);
  await refreshBilling();
}

async function handleBillingPaymentHandoff(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const invoiceId = formString(formData, "invoiceId");
  const customer =
    optionalFormString(formData, "customerEmail") || optionalFormString(formData, "customerName")
      ? {
          email: optionalFormString(formData, "customerEmail"),
          name: optionalFormString(formData, "customerName"),
        }
      : undefined;
  const response = await proxyFetch("/v1/billing/invoices/" + encodeURIComponent(invoiceId) + "/payment-handoff", {
    method: "POST",
    body: {
      provider: formString(formData, "provider") || "manual",
      returnUrl: optionalFormString(formData, "returnUrl"),
      customer,
    },
  });
  if (response.paymentHandoff) {
    state.paymentHandoffs.push(response.paymentHandoff);
  }
  renderBilling();
  setOutput("#billing-output", response);
}

async function handleTsaSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const response = await proxyFetch("/v1/tsa/manual-attest", {
    method: "POST",
    body: {
      customerId: String(formData.get("customerId") || "").trim(),
      seatId: String(formData.get("seatId") || "").trim() || "default",
      operatorId: String(formData.get("operatorId") || "").trim(),
      ticketId: String(formData.get("ticketId") || "").trim(),
      reason: String(formData.get("reason") || "").trim(),
      attestedAtSec: toEpochSec(String(formData.get("attestedAt") || "")),
    },
  });
  setOutput("#tsa-output", response);
  await refreshAttestations();
}

function bindAsyncForm(selector, handler, outputSelector) {
  $(selector).addEventListener("submit", (event) => {
    handler(event).catch((error) => {
      setOutput(outputSelector, { error: error.message }, true);
    });
  });
}

async function bootstrap() {
  await loadConfig();
  setDefaultTimes();

  try {
    const clerk = await ensureClerk();
    clerk.addListener(() => {
      renderAuthState().catch((error) => {
        showLockedShell(error.message);
      });
    });
    await renderAuthState();
  } catch (error) {
    showLockedShell(error.message || "clerk_init_failed");
  }

  $("#refresh-hierarchy").addEventListener("click", () => {
    refreshHierarchy().catch((error) => setOutput("#policy-output", { error: error.message }, true));
  });
  $("#refresh-usage").addEventListener("click", () => {
    refreshUsage().catch((error) => setOutput("#usage-output", { error: error.message }, true));
  });
  $("#refresh-billing").addEventListener("click", () => {
    refreshBilling().catch((error) => setOutput("#billing-output", { error: error.message }, true));
  });
  $("#refresh-attestations").addEventListener("click", () => {
    refreshAttestations().catch((error) => setOutput("#tsa-output", { error: error.message }, true));
  });
  $("#workspace-provider").addEventListener("change", refreshWorkspaceCustomerOptions);
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

  bindAsyncForm("#provider-form", handleProviderSubmit, "#policy-output");
  bindAsyncForm("#customer-form", handleCustomerSubmit, "#policy-output");
  bindAsyncForm("#workspace-form", handleWorkspaceSubmit, "#policy-output");
  bindAsyncForm("#policy-issue-form", handlePolicyIssue, "#policy-output");
  bindAsyncForm("#policy-sync-form", handlePolicySync, "#policy-output");
  bindAsyncForm("#meter-upload-form", handleMeterUpload, "#usage-output");
  bindAsyncForm("#billing-pricing-rule-form", handleBillingPricingRuleSubmit, "#billing-output");
  bindAsyncForm("#billing-invoice-draft-form", handleBillingInvoiceDraft, "#billing-output");
  bindAsyncForm("#billing-payment-handoff-form", handleBillingPaymentHandoff, "#billing-output");
  bindAsyncForm("#tsa-form", handleTsaSubmit, "#tsa-output");

  $("#usage-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    refreshUsage(event.currentTarget).catch((error) => {
      setOutput("#usage-output", { error: error.message }, true);
    });
  });
  $("#attestation-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    refreshAttestations(event.currentTarget).catch((error) => {
      setOutput("#tsa-output", { error: error.message }, true);
    });
  });
}

bootstrap().catch((error) => {
  showLockedShell(error.message || "dashboard_bootstrap_failed");
});
`;
