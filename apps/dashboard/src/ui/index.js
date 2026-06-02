// apps/dashboard/src/ui/index.js
// Browser entry point — bundled by dashboard-ui.js via Bun.build().
import { createApi } from "./api.js";
import { escapeHtml, toLocalValue } from "./formatters.js";
import { mountPolicy } from "./render/policy.js";
import { mountUsage } from "./render/usage.js";
import { mountBilling } from "./render/billing.js";
import { mountTsa } from "./render/tsa.js";

// ── shared state ─────────────────────────────────────────────────────────────

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

// ── DOM utilities ─────────────────────────────────────────────────────────────

function $(selector) {
  return document.querySelector(selector);
}

function setMetrics() {
  $("#metric-providers").textContent = String(state.providers.length);
  $("#metric-customers").textContent = String(state.customers.length);
  $("#metric-workspaces").textContent = String(state.workspaces.length);
  $("#metric-usage").textContent = String(state.usage.length);
  $("#metric-pricing-rules").textContent = String(state.pricingRules.length);
  $("#metric-invoices").textContent = String(state.invoices.length);
}

function setDefaultTimes() {
  const now = Date.now();
  $("#policy-issue-form").elements.startsAt.value = toLocalValue(now);
  $("#policy-issue-form").elements.expiresAt.value = toLocalValue(
    now + 24 * 60 * 60 * 1000
  );
  $("#policy-issue-form").elements.graceUntil.value = toLocalValue(
    now + 72 * 60 * 60 * 1000
  );
  $("#tsa-form").elements.attestedAt.value = toLocalValue(now);
  $("#billing-invoice-draft-form").elements.periodStart.value = toLocalValue(
    now - 30 * 24 * 60 * 60 * 1000
  );
  $("#billing-invoice-draft-form").elements.periodEnd.value = toLocalValue(now);
}

// ── config ───────────────────────────────────────────────────────────────────

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

// ── Clerk auth ────────────────────────────────────────────────────────────────

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
  if (
    !state.config?.clerkPublishableKey ||
    !state.config?.clerkFrontendApiHost
  ) {
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

async function getSessionToken() {
  const clerk = await ensureClerk();
  if (!clerk.session) throw new Error("clerk_session_missing");
  const token = await clerk.session.getToken();
  if (!token) throw new Error("clerk_token_missing");
  return token;
}

function showAuthenticatedShell() {
  $("#auth-root").innerHTML = "";
  $("#app-shell").hidden = false;
}

function showLockedShell(message) {
  $("#app-shell").hidden = true;
  $("#auth-root").innerHTML =
    '<div class="output is-error">' + escapeHtml(message) + "</div>";
}

async function renderAuthState(refreshAll) {
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

// ── bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrap() {
  await loadConfig();
  setDefaultTimes();

  // createApi is constructed post-loadConfig so baseUrl is correct.
  const rawApi = createApi({
    baseUrl: state.config?.apiProxyBase ?? "/api",
    getToken: getSessionToken,
  });

  // Thin wrapper matching proxyFetch semantics: throws on error, returns body.
  async function api(path, options) {
    const { ok, body } = await rawApi.call(path, options);
    if (!ok) throw new Error(body?.error ?? "request_failed");
    return body;
  }

  // Mount billing first so refreshBillingSelectOptions is available for policy.
  const { refreshBilling, refreshBillingSelectOptions } = mountBilling(
    document,
    { api, state, onSetMetrics: setMetrics }
  );

  const { refreshHierarchy } = mountPolicy(document, {
    api,
    state,
    onBillingSelectsRefresh: refreshBillingSelectOptions,
    onSetMetrics: setMetrics,
  });

  const { refreshUsage } = mountUsage(document, {
    api,
    state,
    onSetMetrics: setMetrics,
  });

  const { refreshAttestations } = mountTsa(document, { api, state });

  async function refreshAll() {
    await refreshHierarchy();
    await refreshUsage();
    await refreshBilling();
    await refreshAttestations();
  }

  try {
    const clerk = await ensureClerk();
    clerk.addListener(() => {
      renderAuthState(refreshAll).catch((error) => {
        showLockedShell(error.message);
      });
    });
    await renderAuthState(refreshAll);
  } catch (error) {
    showLockedShell(error.message || "clerk_init_failed");
  }
}

bootstrap().catch((error) => {
  showLockedShell(error.message || "dashboard_bootstrap_failed");
});
