// apps/dashboard/src/ui/render/policy.js
import {
  createOutput,
  syncSelect,
  escapeHtml,
  bindAsyncForm,
  toEpochSec,
} from "../formatters.js";

/**
 * Mount the policy section: providers, customers, workspaces, and policy
 * issue/sync forms.
 *
 * @param {Document|Element} root
 * @param {{ api, state, onBillingSelectsRefresh?, onSetMetrics? }} opts
 * @returns {{ refreshHierarchy: function }}
 */
export function mountPolicy(root, { api, state, onBillingSelectsRefresh, onSetMetrics }) {
  const $ = (sel) => root.querySelector(sel);
  const out = createOutput($("#policy-output"));

  // ── internal DOM helpers ──────────────────────────────────────────────────

  function refreshWorkspaceCustomerOptions() {
    const providerId = $("#workspace-provider").value;
    const customers = state.customers.filter(
      (c) => !providerId || c.providerId === providerId
    );
    syncSelect(
      $("#workspace-customer"),
      customers,
      "customerId",
      (c) => c.customerId,
      "Create customer first"
    );
  }

  function renderHierarchy() {
    $("#providers-list").innerHTML = state.providers.length
      ? state.providers
          .map(
            (p) =>
              "<li><strong>" +
              escapeHtml(p.providerId) +
              "</strong><span>" +
              escapeHtml(p.name || "Unnamed provider") +
              "</span></li>"
          )
          .join("")
      : "<li>No providers yet.</li>";

    $("#customers-list").innerHTML = state.customers.length
      ? state.customers
          .map(
            (c) =>
              "<li><strong>" +
              escapeHtml(c.customerId) +
              "</strong><span>" +
              escapeHtml(c.providerId + (c.name ? " · " + c.name : "")) +
              "</span></li>"
          )
          .join("")
      : "<li>No customers yet.</li>";

    $("#workspaces-list").innerHTML = state.workspaces.length
      ? state.workspaces
          .map(
            (w) =>
              "<li><strong>" +
              escapeHtml(w.workspaceId) +
              "</strong><span>" +
              escapeHtml(
                w.providerId + " / " + w.customerId + " / " + w.status
              ) +
              "</span></li>"
          )
          .join("")
      : "<li>No workspaces yet.</li>";

    syncSelect(
      $("#customer-provider"),
      state.providers,
      "providerId",
      (p) => p.providerId,
      "Create provider first"
    );
    syncSelect(
      $("#workspace-provider"),
      state.providers,
      "providerId",
      (p) => p.providerId,
      "Create provider first"
    );
    refreshWorkspaceCustomerOptions();
    onBillingSelectsRefresh?.();
    onSetMetrics?.();
  }

  // ── data fetchers ─────────────────────────────────────────────────────────

  async function refreshHierarchy() {
    const providers = await api("/v1/providers");
    state.providers = providers.providers || [];
    const customerPages = await Promise.all(
      state.providers.map((p) =>
        api("/v1/providers/" + encodeURIComponent(p.providerId) + "/customers")
      )
    );
    state.customers = customerPages.flatMap((r) => r.customers || []);
    const workspaces = await api("/v1/workspaces");
    state.workspaces = workspaces.workspaces || [];
    renderHierarchy();
  }

  // ── form handlers ─────────────────────────────────────────────────────────

  async function handleProviderSubmit(event) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const res = await api("/v1/providers", {
      method: "POST",
      body: {
        providerId: String(fd.get("providerId") || "").trim(),
        name: String(fd.get("name") || "").trim() || undefined,
      },
    });
    out.set(res);
    event.currentTarget.reset();
    await refreshHierarchy();
  }

  async function handleCustomerSubmit(event) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const providerId = String(fd.get("providerId") || "").trim();
    const res = await api(
      "/v1/providers/" + encodeURIComponent(providerId) + "/customers",
      {
        method: "POST",
        body: {
          customerId: String(fd.get("customerId") || "").trim(),
          name: String(fd.get("name") || "").trim() || undefined,
        },
      }
    );
    out.set(res);
    event.currentTarget.reset();
    await refreshHierarchy();
  }

  async function handleWorkspaceSubmit(event) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const res = await api("/v1/workspaces", {
      method: "POST",
      body: {
        workspaceId: String(fd.get("workspaceId") || "").trim(),
        providerId: String(fd.get("providerId") || "").trim(),
        customerId: String(fd.get("customerId") || "").trim(),
        name: String(fd.get("name") || "").trim() || undefined,
        status: String(fd.get("status") || "").trim() || undefined,
      },
    });
    out.set(res);
    event.currentTarget.reset();
    await refreshHierarchy();
  }

  async function handlePolicyIssue(event) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const seatId = String(fd.get("seatId") || "").trim();
    const toolName = String(fd.get("toolName") || "").trim();
    const startsAtSec = toEpochSec(String(fd.get("startsAt") || ""));
    const expiresAtSec = toEpochSec(String(fd.get("expiresAt") || ""));
    const graceUntilSec = toEpochSec(String(fd.get("graceUntil") || ""));
    const res = await api("/v1/policies/issue", {
      method: "POST",
      body: {
        policy: {
          policyVersion: 1,
          policyId: String(fd.get("policyId") || "").trim(),
          workspaceId: String(fd.get("workspaceId") || "").trim(),
          workspacePolicy: { mode: "ENABLED" },
          seatPolicy: {
            defaultMode: "ENABLED",
            seats: { [seatId]: { mode: "ENABLED" } },
          },
          usagePolicy: {
            unit: "tool_call",
            thresholds: {
              warningPct: Number(fd.get("warningPct") || 100),
              hardStopPct: Number(fd.get("hardStopPct") || 120),
            },
            toolBudgets: { [toolName]: Number(fd.get("toolBudget") || 100) },
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
    out.set(res);
  }

  async function handlePolicySync(event) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const res = await api("/v1/policies/sync", {
      method: "POST",
      body: {
        workspaceId: String(fd.get("workspaceId") || "").trim(),
        policyId: String(fd.get("policyId") || "").trim() || undefined,
      },
    });
    out.set(res);
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  bindAsyncForm($("#provider-form"), handleProviderSubmit, out);
  bindAsyncForm($("#customer-form"), handleCustomerSubmit, out);
  bindAsyncForm($("#workspace-form"), handleWorkspaceSubmit, out);
  bindAsyncForm($("#policy-issue-form"), handlePolicyIssue, out);
  bindAsyncForm($("#policy-sync-form"), handlePolicySync, out);

  $("#refresh-hierarchy").addEventListener("click", () => {
    refreshHierarchy().catch((e) => out.set({ error: e.message }, true));
  });
  $("#workspace-provider").addEventListener("change", refreshWorkspaceCustomerOptions);

  return { refreshHierarchy };
}
