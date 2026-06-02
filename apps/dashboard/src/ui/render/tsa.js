// apps/dashboard/src/ui/render/tsa.js
import {
  createOutput,
  escapeHtml,
  bindAsyncForm,
  toEpochSec,
} from "../formatters.js";

/**
 * Mount the TSA section: manual attestation submission and history view.
 *
 * @param {Document|Element} root
 * @param {{ api, state }} opts
 * @returns {{ refreshAttestations: function }}
 */
export function mountTsa(root, { api, state }) {
  const $ = (sel) => root.querySelector(sel);
  const out = createOutput($("#tsa-output"));

  // ── renderer ──────────────────────────────────────────────────────────────

  function renderAttestations() {
    $("#attestations-body").innerHTML = state.attestations.length
      ? state.attestations
          .map(
            (row) =>
              "<tr><td>" +
              escapeHtml(row.customerId) +
              "</td><td>" +
              escapeHtml(row.seatId || "default") +
              "</td><td>" +
              escapeHtml(row.operatorId) +
              "</td><td>" +
              escapeHtml(row.ticketId) +
              "</td><td>" +
              escapeHtml(new Date(row.recordedAtSec * 1000).toLocaleString()) +
              "</td><td>" +
              escapeHtml(row.reason) +
              "</td></tr>"
          )
          .join("")
      : '<tr><td colspan="6">No manual attestations.</td></tr>';
  }

  // ── data fetcher ──────────────────────────────────────────────────────────

  async function refreshAttestations(form = $("#attestation-filter-form")) {
    const params = new URLSearchParams();
    const fd = new FormData(form);
    for (const [key, value] of fd.entries()) {
      if (typeof value === "string" && value.trim().length > 0) {
        params.set(key, value.trim());
      }
    }
    const res = await api(
      "/v1/tsa/manual-attestations" +
        (params.size ? "?" + params.toString() : "")
    );
    state.attestations = res.records || [];
    renderAttestations();
    out.set(res);
  }

  // ── form handler ──────────────────────────────────────────────────────────

  async function handleTsaSubmit(event) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const res = await api("/v1/tsa/manual-attest", {
      method: "POST",
      body: {
        customerId: String(fd.get("customerId") || "").trim(),
        seatId: String(fd.get("seatId") || "").trim() || "default",
        operatorId: String(fd.get("operatorId") || "").trim(),
        ticketId: String(fd.get("ticketId") || "").trim(),
        reason: String(fd.get("reason") || "").trim(),
        attestedAtSec: toEpochSec(String(fd.get("attestedAt") || "")),
      },
    });
    out.set(res);
    await refreshAttestations();
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  bindAsyncForm("#tsa-form", handleTsaSubmit, out);

  $("#refresh-attestations").addEventListener("click", () => {
    refreshAttestations().catch((e) => out.set({ error: e.message }, true));
  });

  $("#attestation-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    refreshAttestations(event.currentTarget).catch((e) =>
      out.set({ error: e.message }, true)
    );
  });

  return { refreshAttestations };
}
