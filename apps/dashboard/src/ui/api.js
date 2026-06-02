// apps/dashboard/src/ui/api.js

/**
 * Create a thin API client.
 *
 * IMPORTANT: construct this inside `bootstrap()` after `loadConfig()` resolves,
 * NOT at module scope. The current `dashboard-ui.js` reads `state.config.apiProxyBase`
 * at call time; `createApi` captures `baseUrl` at construction time, so the api
 * instance must be rebuilt if the base URL changes (which it does during initial
 * config load).
 *
 * @param {object} [options]
 * @param {string}   [options.baseUrl="/api"]    Prefix for every path.
 * @param {function} [options.getToken]          Async fn that returns a Bearer
 *                                               token string.  When provided,
 *                                               an Authorization header is
 *                                               injected on every request —
 *                                               matching the behaviour of
 *                                               proxyFetch() in dashboard-ui.js.
 */
export function createApi({ baseUrl = "/api", getToken } = {}) {
  async function call(path, { method = "GET", body, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };

    if (getToken) {
      const token = await getToken();
      init.headers["authorization"] = "Bearer " + token;
    }

    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      body: text ? safeJson(text) : null,
    };
  }

  return { call };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Generic form-to-API submission helper.
 *
 * Suitable for flat form shapes: each form field maps to a top-level body property.
 * For forms with nested objects, File inputs, or complex transformations,
 * write a custom handler instead.
 *
 * Requires the form element to have `data-endpoint="<path>"` (and optionally
 * `data-method="<method>"`; default is POST).
 *
 * @param {HTMLFormElement} formEl
 * @param {object} options
 * @param {Record<string, function|null>} options.fields
 *   Map of field name → parse function.  Receives (rawValue, formData).
 *   Pass null to use the raw string value unchanged.
 * @param {{ set(value: unknown, isError?: boolean): void }} options.output
 *   Output controller (e.g. from createOutput()).
 * @param {{ call: function }} options.api
 *   Api instance from createApi().
 * @param {function} [options.onSuccess]
 *   Called with the response body when status < 400.
 */
export function wireForm(formEl, { fields, output, api, onSuccess }) {
  formEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const endpoint = formEl.dataset.endpoint;
    if (!endpoint) {
      throw new Error("wireForm: missing data-endpoint on form " + (formEl.id ?? formEl.tagName));
    }
    const data = new FormData(event.currentTarget);
    const body = {};
    for (const [name, parse] of Object.entries(fields)) {
      const raw = data.get(name);
      body[name] = parse ? parse(raw, data) : raw;
    }
    try {
      const result = await api.call(endpoint, {
        method: formEl.dataset.method ?? "POST",
        body,
      });
      output.set(result.body ?? result, !result.ok);
      if (result.ok && onSuccess) await onSuccess(result.body);
    } catch (error) {
      output.set({ error: error.message }, true);
    }
  });
}
