// apps/dashboard/src/ui/render/usage.js
import { createOutput, escapeHtml, bindAsyncForm } from "../formatters.js";

/**
 * Mount the usage section: meter upload and usage summary view.
 *
 * @param {Document|Element} root
 * @param {{ api, state, onSetMetrics? }} opts
 * @returns {{ refreshUsage: function }}
 */
export function mountUsage(root, { api, state, onSetMetrics }) {
  const $ = (sel) => root.querySelector(sel);
  const out = createOutput($("#usage-output"));

  // ── renderer ──────────────────────────────────────────────────────────────

  function renderUsage() {
    $("#usage-body").innerHTML = state.usage.length
      ? state.usage
          .map(
            (row) =>
              "<tr><td>" +
              escapeHtml(row.providerId) +
              "</td><td>" +
              escapeHtml(row.customerId) +
              "</td><td>" +
              escapeHtml(row.workspaceId) +
              "</td><td>" +
              escapeHtml(row.seatId) +
              "</td><td>" +
              escapeHtml(row.skillId || "—") +
              "</td><td>" +
              escapeHtml(row.tool) +
              "</td><td>" +
              escapeHtml(String(row.totalCalls)) +
              "</td></tr>"
          )
          .join("")
      : '<tr><td colspan="7">No usage rows.</td></tr>';
    onSetMetrics?.();
  }

  // ── data fetcher ──────────────────────────────────────────────────────────

  async function refreshUsage(form = $("#usage-filter-form")) {
    const params = new URLSearchParams();
    const fd = new FormData(form);
    for (const [key, value] of fd.entries()) {
      if (typeof value === "string" && value.trim().length > 0) {
        params.set(key, value.trim());
      }
    }
    const res = await api(
      "/v1/usage/summary" + (params.size ? "?" + params.toString() : "")
    );
    state.usage = res.summary || [];
    renderUsage();
    out.set(res);
  }

  // ── form handler ──────────────────────────────────────────────────────────

  async function handleMeterUpload(event) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget);
    const file = fd.get("file");
    if (!(file instanceof File)) throw new Error("missing_meter_file");
    const text = await file.text();
    const events = text
      .split(/\r?\n/)
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
    for (const key of [
      "providerId",
      "customerId",
      "seatId",
      "skillId",
      "bundleId",
      "leaseJti",
    ]) {
      const value = String(fd.get(key) || "").trim();
      if (value) context[key] = value;
    }

    const res = await api("/v1/meter/upload", {
      method: "POST",
      body: {
        workspaceId: String(fd.get("workspaceId") || "").trim(),
        context,
        events,
      },
    });
    out.set(res);
    await refreshUsage();
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  bindAsyncForm($("#meter-upload-form"), handleMeterUpload, out);

  $("#refresh-usage").addEventListener("click", () => {
    refreshUsage().catch((e) => out.set({ error: e.message }, true));
  });

  $("#usage-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    refreshUsage(event.currentTarget).catch((e) =>
      out.set({ error: e.message }, true)
    );
  });

  return { refreshUsage };
}
