# Dashboard UI Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose `apps/dashboard/src/dashboard-ui.js` (1350 lines) into focused files. Move CSS to a real stylesheet. Extract form handling into a small generic helper. Split the JS into per-section render modules. Final file-size target: no file under `apps/dashboard/src/` exceeds 250 lines.

**Architecture:** The dashboard ships as a Cloudflare Worker with bundled assets. Use Wrangler's `text` rule to ship the CSS as a sibling file. Replace the giant JS template literal with a folder of small ES modules, each exporting a `mount(root, { api, formatters })` function. `bootstrap()` calls each `mount()` in order. Form handling is unified via a `wireForm` helper that takes a fields descriptor.

**Tech Stack:** Plain JavaScript, no framework, no new dependencies. The `Worker` environment provides `Request`, `Response`, `URL`.

**Reference spec:** `docs/superpowers/specs/2026-06-01-structural-cleanup.md` (Subsystem 4).

---

## File Structure

- **Modify:** `apps/dashboard/src/index.js` — replace inline string exports with imports
- **Create:** `apps/dashboard/src/ui/index.js` — bootstrap
- **Create:** `apps/dashboard/src/ui/styles.css` — extracted from `dashboardStyles` string
- **Create:** `apps/dashboard/src/ui/api.js` — `proxyFetch`, form helpers
- **Create:** `apps/dashboard/src/ui/formatters.js` — date/epoch/ID formatters
- **Create:** `apps/dashboard/src/ui/render-html.js` — small HTML template tag
- **Create:** `apps/dashboard/src/ui/render/policy.js`
- **Create:** `apps/dashboard/src/ui/render/usage.js`
- **Create:** `apps/dashboard/src/ui/render/billing.js`
- **Create:** `apps/dashboard/src/ui/render/tsa.js`
- **Delete:** `apps/dashboard/src/dashboard-ui.js` (or keep as a thin re-export shim for one release)
- **Modify:** `apps/dashboard/wrangler.jsonc` (or equivalent) — add the CSS asset to the `text` rule

---

### Task 1: Extract CSS to a real file

**Files:**
- Create: `apps/dashboard/src/ui/styles.css`
- Modify: `apps/dashboard/src/dashboard-ui.js`

- [ ] **Step 1: Move the CSS string contents to `styles.css`**

Read `dashboard-ui.js` and locate `export const dashboardStyles = \`...\``. The contents are CSS. Move them verbatim to `apps/dashboard/src/ui/styles.css`.

- [ ] **Step 2: Replace the `dashboardStyles` export**

In `dashboard-ui.js`, replace the export with:

```js
import dashboardStyles from "./ui/styles.css";
export { dashboardStyles };
```

(Bundler compatibility depends on the asset pipeline. If a raw import isn't supported, use `?raw`.)

- [ ] **Step 3: Verify the dashboard still loads**

Run the dashboard worker and load `assets/dashboard.css` directly. Expected: same content as before.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/ui/styles.css apps/dashboard/src/dashboard-ui.js
git commit -m "refactor(dashboard): extract CSS to a real file"
```

---

### Task 2: Build the form-helper primitives

**Files:**
- Create: `apps/dashboard/src/ui/api.js`
- Create: `apps/dashboard/src/ui/formatters.js`

- [ ] **Step 1: Implement `api.js`**

```js
// apps/dashboard/src/ui/api.js
export function createApi({ baseUrl = "/api" } = {}) {
  async function call(path, { method = "GET", body, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    return {
      status: response.status,
      body: text ? safeJson(text) : null,
    };
  }
  return { call };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

export function wireForm(formEl, { fields, output, api, onSuccess }) {
  formEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = {};
    for (const [name, parse] of Object.entries(fields)) {
      const raw = data.get(name);
      body[name] = parse ? parse(raw, data) : raw;
    }
    try {
      const result = await api.call(formEl.dataset.endpoint, {
        method: formEl.dataset.method ?? "POST",
        body,
      });
      output.set(result);
      if (result.status < 400 && onSuccess) await onSuccess(result.body);
    } catch (error) {
      output.set({ error: error.message }, true);
    }
  });
}
```

- [ ] **Step 2: Implement `formatters.js`**

Move the existing `formString`, `optionalFormString`, `formNumber`, `optionalFormNumber`, `toEpochSec`, `setOutput` helpers from `dashboard-ui.js` to `formatters.js`. Replace `setOutput` with a small `Output` class that exposes `.set(value, isError)`:

```js
export function createOutput(el) {
  return {
    set(value, isError = false) {
      el.textContent = JSON.stringify(value, null, 2);
      el.dataset.error = isError ? "1" : "0";
    },
  };
}
```

- [ ] **Step 3: Verify nothing else references the old helpers**

```bash
grep -n "formString\|optionalFormString\|formNumber\|optionalFormNumber\|toEpochSec\|setOutput" apps/dashboard/src/dashboard-ui.js
```

Expected: zero matches. The dashboard-ui.js now imports them from the new location.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/ui/api.js apps/dashboard/src/ui/formatters.js apps/dashboard/src/dashboard-ui.js
git commit -m "refactor(dashboard): introduce api + formatters modules with wireForm helper"
```

---

### Task 3: Build the HTML renderer

**Files:**
- Create: `apps/dashboard/src/ui/render-html.js`
- Modify: `apps/dashboard/src/dashboard-ui.js`

- [ ] **Step 1: Move the HTML to a template tag**

```js
// apps/dashboard/src/ui/render-html.js
export function renderDashboardHtml({ scriptUrl, styleUrl }) {
  return /* html */`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Skillpack Dashboard</title>
  <link rel="stylesheet" href="${styleUrl}" />
</head>
<body>
  <main id="app">…existing body…</main>
  <script type="module" src="${scriptUrl}"></script>
</body>
</html>`;
}
```

The `…existing body…` is the same markup that was previously in the `renderDashboardHtml()` string literal in `dashboard-ui.js`. Move it verbatim.

- [ ] **Step 2: Wire it into `dashboard-ui.js`**

Replace the `renderDashboardHtml` definition with:

```js
import { renderDashboardHtml as build } from "./ui/render-html.js";
export function renderDashboardHtml() {
  return build({ scriptUrl: "/assets/dashboard.js", styleUrl: "/assets/dashboard.css" });
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/ui/render-html.js apps/dashboard/src/dashboard-ui.js
git commit -m "refactor(dashboard): move HTML to render-html.js template"
```

---

### Task 4: Split the JS into per-section render modules

**Files:**
- Create: `apps/dashboard/src/ui/render/policy.js`
- Create: `apps/dashboard/src/ui/render/usage.js`
- Create: `apps/dashboard/src/ui/render/billing.js`
- Create: `apps/dashboard/src/ui/render/tsa.js`
- Create: `apps/dashboard/src/ui/index.js`
- Delete: `apps/dashboard/src/dashboard-ui.js` (or trim to re-exports)

Each render module exports a `mount(root, { api, formatters })` function. The body of each is the existing JS in `dashboard-ui.js` for that section, refactored to use the new `wireForm` and `api.call` helpers.

- [ ] **Step 1: Move the policy section**

Read the `handleProviderSubmit`, `handleCustomerSubmit`, `handleWorkspaceSubmit`, `handlePolicyIssue`, `handlePolicySync`, `refreshHierarchy` blocks in `dashboard-ui.js`. Move them to `render/policy.js`. Replace each with `wireForm(formEl, { fields, output, api, onSuccess })`.

- [ ] **Step 2: Move the usage section**

Move `handleMeterUpload`, `refreshUsage`, `refreshUsage`-filter wiring to `render/usage.js`.

- [ ] **Step 3: Move the billing section**

Move `handleBillingPricingRuleSubmit`, `handleBillingInvoiceDraft`, `handleBillingPaymentHandoff`, `refreshBilling` to `render/billing.js`.

- [ ] **Step 4: Move the TSA section**

Move `handleTsaSubmit`, `refreshAttestations` to `render/tsa.js`.

- [ ] **Step 5: Build the bootstrap module**

```js
// apps/dashboard/src/ui/index.js
import { renderPolicy } from "./render/policy.js";
import { renderUsage } from "./render/usage.js";
import { renderBilling } from "./render/billing.js";
import { renderTsa } from "./render/tsa.js";
import { createApi } from "./api.js";
import { createFormatters } from "./formatters.js";

export async function bootstrap() {
  const api = createApi();
  const formatters = createFormatters();
  await renderPolicy(document, { api, formatters });
  await renderUsage(document, { api, formatters });
  await renderBilling(document, { api, formatters });
  await renderTsa(document, { api, formatters });
}
```

- [ ] **Step 6: Wire the bootstrap into the asset script**

In `dashboard-ui.js`, replace the giant `dashboardScript` template literal with:

```js
import { bootstrap } from "./ui/index.js";
export const dashboardScript = `import("/assets/dashboard.module.js").then((m) => m.bootstrap());`;
```

…and create `apps/dashboard/src/dashboard.module.js`:

```js
// apps/dashboard/src/dashboard.module.js
import { bootstrap } from "./ui/index.js";
bootstrap().catch((error) => {
  document.body.innerHTML = `<pre>${error.message}</pre>`;
});
```

(The exact module-loading shape depends on the asset bundler; the goal is to ship the new modules as ES modules that the entry script imports.)

- [ ] **Step 7: Verify the dashboard still works end-to-end**

Run the dashboard worker. Click through the policy, usage, billing, and TSA sections. Submit at least one form per section. Expected: behavior identical to before.

- [ ] **Step 8: Delete `dashboard-ui.js`**

If the file is now ≤ 50 lines of pure re-exports, keep it. Otherwise, delete it and update `apps/dashboard/src/index.js` to import from the new locations.

- [ ] **Step 9: Commit**

```bash
git add apps/dashboard/src/ui apps/dashboard/src/dashboard-ui.js apps/dashboard/src/dashboard.module.js
git commit -m "refactor(dashboard): split UI into per-section render modules"
```

---

### Task 5: Verify file-size targets

**Files:** none (verification only)

- [ ] **Step 1: Check sizes**

```bash
wc -l apps/dashboard/src/ui/index.js \
      apps/dashboard/src/ui/api.js \
      apps/dashboard/src/ui/formatters.js \
      apps/dashboard/src/ui/render-html.js \
      apps/dashboard/src/ui/render/*.js
```

Expected: every file ≤ 250 lines.

- [ ] **Step 2: Check `dashboard-ui.js`**

```bash
wc -l apps/dashboard/src/dashboard-ui.js
```

Expected: ≤ 50 lines (or 0 if deleted).

- [ ] **Step 3: Commit any stragglers**

If sizes aren't met, identify the largest remaining file and continue splitting. Commit any further refactors.

---

## Acceptance criteria

- No file under `apps/dashboard/src/` exceeds 250 lines.
- The CSS lives in a real `.css` file.
- The HTML is built by a small template-tag function.
- Form handling is unified through `wireForm`.
- The dashboard still functions as a Worker asset with the same routes and behavior.
- `apps/dashboard/src/dashboard-ui.js` is ≤ 50 lines or deleted.

## Out of scope

- Adding new dashboard features.
- Changing the worker routing in `apps/dashboard/src/index.js` (other than the CSS asset rule).
- Replacing the plain-JS approach with a framework.
