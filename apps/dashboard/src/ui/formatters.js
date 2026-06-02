// apps/dashboard/src/ui/formatters.js

export function formString(formData, key) {
  return String(formData.get(key) || "").trim();
}

export function optionalFormString(formData, key) {
  const value = formString(formData, key);
  return value.length > 0 ? value : undefined;
}

export function formNumber(formData, key, fallback = 0) {
  const value = Number(formData.get(key));
  return Number.isFinite(value) ? value : fallback;
}

export function optionalFormNumber(formData, key) {
  const raw = formString(formData, key);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function toEpochSec(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function toLocalValue(ms) {
  const date = new Date(ms);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return yyyy + "-" + mm + "-" + dd + "T" + hh + ":" + min;
}

export function dateRangeLabel(startSec, endSec) {
  if (!startSec || !endSec) return "unknown period";
  return (
    new Date(startSec * 1000).toLocaleDateString() +
    " - " +
    new Date(endSec * 1000).toLocaleDateString()
  );
}

export function formatMoneyCents(cents, currency = "USD") {
  const amount = Number(cents || 0) / 100;
  return currency + " " + amount.toFixed(2);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Creates an output controller bound to a DOM element.
 * Mirrors the logic of setOutput() in dashboard-ui.js but accepts an element
 * directly rather than a CSS selector string.
 *
 * @param {Element} el
 */
export function createOutput(el) {
  return {
    set(value, isError = false) {
      el.textContent =
        typeof value === "string" ? value : JSON.stringify(value, null, 2);
      el.classList.toggle("is-error", isError);
    },
  };
}

/**
 * Populate a <select> with items, preserving the previous selection where
 * possible.  Adds an optional leading placeholder option.
 */
export function syncSelect(node, items, valueKey, label, placeholder) {
  if (!node) return;
  const previous = node.value;
  const options = [];
  if (placeholder) {
    options.push('<option value="">' + escapeHtml(placeholder) + "</option>");
  }
  for (const item of items) {
    options.push(
      '<option value="' +
        escapeHtml(item[valueKey]) +
        '">' +
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

/**
 * Like syncSelect but always includes a blank "any" option and defaults to
 * the empty value when the previous selection is no longer present.
 */
export function syncOptionalSelect(node, items, valueKey, label, placeholder) {
  if (!node) return;
  const previous = node.value;
  const options = [
    '<option value="">' + escapeHtml(placeholder) + "</option>",
  ];
  for (const item of items) {
    options.push(
      '<option value="' +
        escapeHtml(item[valueKey]) +
        '">' +
        escapeHtml(label(item)) +
        "</option>"
    );
  }
  node.innerHTML = options.join("");
  node.value = items.some((item) => item[valueKey] === previous)
    ? previous
    : "";
}

/**
 * Attach an async submit handler to a form, routing caught errors to an
 * output controller.
 *
 * @param {string} selector  CSS selector for the <form> element.
 * @param {function} handler Async function receiving the submit event.
 * @param {{ set(value: unknown, isError?: boolean): void }} output
 */
export function bindAsyncForm(el, handler, output) {
  el.addEventListener("submit", (event) => {
    handler(event).catch((error) => {
      output.set({ error: error.message }, true);
    });
  });
}
