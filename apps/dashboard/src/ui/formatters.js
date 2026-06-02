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
