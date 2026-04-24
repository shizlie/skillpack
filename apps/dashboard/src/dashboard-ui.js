export function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>skillpack dashboard</title>
    <meta
      name="description"
      content="Clerk-authenticated dashboard worker for the skillpack control plane."
    />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/assets/dashboard.css" />
  </head>
  <body>
    <div class="shell">
      <header class="hero">
        <div class="hero__copy">
          <p class="eyebrow">skillpack dashboard worker</p>
          <h1>Clerk signs the operator in. API calls stay server-side.</h1>
          <p class="hero__lede">
            The dashboard is now a separate worker with its own auth boundary. It uses Clerk for the
            operator session and proxies backend calls server-side only when needed.
          </p>
          <div class="hero__chips">
            <span>Separate frontend worker</span>
            <span>Protected proxy to backend</span>
            <span>API key stays server-side</span>
          </div>
        </div>

        <aside class="hero__panel">
          <div class="hero__panel-head">
            <div>
              <p class="eyebrow">Access</p>
              <h2>Operator authentication</h2>
            </div>
            <div id="user-root"></div>
          </div>
          <p id="config-summary" class="hero__meta">Loading Clerk configuration...</p>
          <div id="auth-root" class="auth-root"></div>
          <p class="hint">
            If Clerk is not configured, the dashboard will stay locked instead of falling back to a
            browser-visible API key.
          </p>
        </aside>
      </header>

      <main id="app-shell" class="app-shell" hidden>
        <section class="metrics">
          <article><span>Providers</span><strong id="metric-providers">0</strong></article>
          <article><span>Customers</span><strong id="metric-customers">0</strong></article>
          <article><span>Workspaces</span><strong id="metric-workspaces">0</strong></article>
          <article><span>Usage Rows</span><strong id="metric-usage">0</strong></article>
        </section>

        <div class="grid">
          <section class="card">
            <div class="section-head">
              <div>
                <p class="eyebrow">Hierarchy</p>
                <h2>Providers, customers, workspaces</h2>
              </div>
              <button type="button" class="ghost" id="refresh-hierarchy">Refresh</button>
            </div>

            <form id="provider-form" class="form-grid">
              <label><span>Provider ID</span><input name="providerId" required placeholder="prov-1" /></label>
              <label><span>Name</span><input name="name" placeholder="Provider One" /></label>
              <button type="submit">Create provider</button>
            </form>

            <form id="customer-form" class="form-grid">
              <label><span>Provider</span><select name="providerId" id="customer-provider"></select></label>
              <label><span>Customer ID</span><input name="customerId" required placeholder="cust-1" /></label>
              <label><span>Name</span><input name="name" placeholder="Customer One" /></label>
              <button type="submit">Create customer</button>
            </form>

            <form id="workspace-form" class="form-grid">
              <label><span>Provider</span><select name="providerId" id="workspace-provider"></select></label>
              <label><span>Customer</span><select name="customerId" id="workspace-customer"></select></label>
              <label><span>Workspace ID</span><input name="workspaceId" required placeholder="ws-1" /></label>
              <label><span>Name</span><input name="name" placeholder="Workspace One" /></label>
              <label>
                <span>Status</span>
                <select name="status">
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="DISABLED">DISABLED</option>
                </select>
              </label>
              <button type="submit">Create workspace</button>
            </form>

            <div class="triptych">
              <div>
                <h3>Providers</h3>
                <ul id="providers-list" class="entity-list"></ul>
              </div>
              <div>
                <h3>Customers</h3>
                <ul id="customers-list" class="entity-list"></ul>
              </div>
              <div>
                <h3>Workspaces</h3>
                <ul id="workspaces-list" class="entity-list"></ul>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="section-head">
              <div>
                <p class="eyebrow">Policies</p>
                <h2>Issue and sync policy snapshots</h2>
              </div>
            </div>

            <form id="policy-issue-form" class="form-grid">
              <label><span>Policy ID</span><input name="policyId" required placeholder="pol-1" /></label>
              <label><span>Workspace ID</span><input name="workspaceId" required placeholder="ws-1" /></label>
              <label><span>Seat ID</span><input name="seatId" required value="seat-1" /></label>
              <label><span>Tool</span><input name="toolName" required value="wiki_search" /></label>
              <label><span>Budget</span><input name="toolBudget" type="number" min="1" value="100" /></label>
              <label><span>Warning %</span><input name="warningPct" type="number" min="0" value="100" /></label>
              <label><span>Hard stop %</span><input name="hardStopPct" type="number" min="0" value="120" /></label>
              <label><span>Starts at</span><input name="startsAt" type="datetime-local" /></label>
              <label><span>Expires at</span><input name="expiresAt" type="datetime-local" /></label>
              <label><span>Grace until</span><input name="graceUntil" type="datetime-local" /></label>
              <button type="submit">Issue policy</button>
            </form>

            <form id="policy-sync-form" class="form-grid compact">
              <label><span>Workspace ID</span><input name="workspaceId" required placeholder="ws-1" /></label>
              <label><span>Current policy ID</span><input name="policyId" placeholder="optional" /></label>
              <button type="submit">Sync policy</button>
            </form>

            <pre id="policy-output" class="output">Policy responses will appear here.</pre>
          </section>

          <section class="card">
            <div class="section-head">
              <div>
                <p class="eyebrow">Usage</p>
                <h2>Meter uploads and summary queries</h2>
              </div>
              <button type="button" class="ghost" id="refresh-usage">Refresh</button>
            </div>

            <form id="meter-upload-form" class="form-grid">
              <label><span>Workspace ID</span><input name="workspaceId" required placeholder="ws-1" /></label>
              <label><span>Provider ID</span><input name="providerId" placeholder="prov-1" /></label>
              <label><span>Customer ID</span><input name="customerId" placeholder="cust-1" /></label>
              <label><span>Seat ID</span><input name="seatId" placeholder="seat-1" /></label>
              <label><span>Skill ID</span><input name="skillId" placeholder="laws-consultant" /></label>
              <label><span>Bundle ID</span><input name="bundleId" placeholder="laws-consultant-1.0.0" /></label>
              <label><span>Lease JTI</span><input name="leaseJti" placeholder="lease-jti-1" /></label>
              <label class="wide"><span>Meter JSONL</span><input name="file" type="file" accept=".jsonl,.json,.txt" required /></label>
              <button type="submit">Upload meter batch</button>
            </form>

            <form id="usage-filter-form" class="form-grid compact">
              <label><span>Provider</span><input name="providerId" placeholder="optional" /></label>
              <label><span>Customer</span><input name="customerId" placeholder="optional" /></label>
              <label><span>Workspace</span><input name="workspaceId" placeholder="optional" /></label>
              <label><span>Seat</span><input name="seatId" placeholder="optional" /></label>
              <label><span>Skill</span><input name="skillId" placeholder="optional" /></label>
              <label><span>Bundle</span><input name="bundleId" placeholder="optional" /></label>
              <button type="submit">Query summary</button>
            </form>

            <div class="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Customer</th>
                    <th>Workspace</th>
                    <th>Seat</th>
                    <th>Skill</th>
                    <th>Tool</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody id="usage-body"></tbody>
              </table>
            </div>

            <pre id="usage-output" class="output">Usage responses will appear here.</pre>
          </section>

          <section class="card">
            <div class="section-head">
              <div>
                <p class="eyebrow">TSA</p>
                <h2>Manual attestation lane</h2>
              </div>
              <button type="button" class="ghost" id="refresh-attestations">Refresh</button>
            </div>

            <form id="tsa-form" class="form-grid">
              <label><span>Customer ID</span><input name="customerId" required placeholder="cust-1" /></label>
              <label><span>Seat ID</span><input name="seatId" value="default" /></label>
              <label><span>Operator ID</span><input name="operatorId" required placeholder="ops-1" /></label>
              <label><span>Ticket ID</span><input name="ticketId" required placeholder="inc-1" /></label>
              <label class="wide"><span>Reason</span><input name="reason" required placeholder="Manual attestation submitted during TSA outage workflow" /></label>
              <label><span>Attested at</span><input name="attestedAt" type="datetime-local" /></label>
              <button type="submit">Record attestation</button>
            </form>

            <form id="attestation-filter-form" class="form-grid compact">
              <label><span>Customer</span><input name="customerId" placeholder="optional" /></label>
              <label><span>Seat</span><input name="seatId" placeholder="optional" /></label>
              <button type="submit">Filter</button>
            </form>

            <div class="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Seat</th>
                    <th>Operator</th>
                    <th>Ticket</th>
                    <th>Recorded</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody id="attestations-body"></tbody>
              </table>
            </div>

            <pre id="tsa-output" class="output">TSA responses will appear here.</pre>
          </section>
        </div>
      </main>
    </div>

    <script type="module" src="/assets/dashboard.js"></script>
  </body>
</html>`;
}

export const dashboardStyles = `
:root {
  --bg: #f4efe6;
  --surface: rgba(255, 252, 247, 0.84);
  --ink: #13212f;
  --muted: #5f6d7d;
  --line: rgba(19, 33, 47, 0.12);
  --teal: #1d9a8b;
  --navy: #243b53;
  --cream: #fff7ea;
  --mono: "IBM Plex Mono", monospace;
  --sans: "Space Grotesk", sans-serif;
  --shadow: 0 24px 60px rgba(19, 33, 47, 0.12);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  color: var(--ink);
  font-family: var(--sans);
  background:
    radial-gradient(circle at top left, rgba(29,154,139,0.18), transparent 28%),
    radial-gradient(circle at top right, rgba(36,59,83,0.14), transparent 30%),
    linear-gradient(180deg, #f7f1e8 0%, #efe5d4 100%);
}

.shell {
  width: min(1440px, calc(100% - 28px));
  margin: 0 auto;
  padding: 20px 0 64px;
}

.hero, .card, .metrics article {
  background: var(--surface);
  border: 1px solid rgba(255,255,255,0.6);
  box-shadow: var(--shadow);
  backdrop-filter: blur(16px);
}

.hero {
  display: grid;
  grid-template-columns: 1.2fr 0.95fr;
  gap: 18px;
  padding: 24px;
  border-radius: 30px;
}

.eyebrow {
  margin: 0 0 10px;
  color: var(--teal);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 0.75rem;
  font-weight: 700;
}

.hero h1, .card h2 { margin: 0; line-height: 1; }
.hero h1 { font-size: clamp(2.3rem, 5vw, 4.6rem); max-width: 12ch; }
.hero__lede, .hero__meta, .hint, td { color: var(--muted); }

.hero__chips, .metrics, .triptych {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.hero__chips span {
  padding: 9px 12px;
  border-radius: 999px;
  background: rgba(255,255,255,0.88);
  border: 1px solid rgba(19,33,47,0.08);
  font-size: 0.76rem;
}

.hero__panel {
  padding: 18px;
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(255,247,234,0.92), rgba(255,255,255,0.72));
}

.hero__panel-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}

.auth-root {
  min-height: 340px;
  margin-top: 14px;
}

.app-shell[hidden] {
  display: none;
}

.metrics {
  margin: 18px 0;
}

.metrics article {
  flex: 1 1 180px;
  padding: 18px;
  border-radius: 22px;
}

.metrics span {
  display: block;
  margin-bottom: 8px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.72rem;
}

.metrics strong { font-size: 2.4rem; }

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}

.card {
  padding: 22px;
  border-radius: 28px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: start;
  margin-bottom: 18px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.form-grid.compact {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.wide { grid-column: span 2; }

label {
  display: grid;
  gap: 8px;
}

label span, th {
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

input, select, button {
  min-height: 46px;
  width: 100%;
  border-radius: 14px;
  border: 1px solid var(--line);
  padding: 12px 14px;
  font: inherit;
}

input, select {
  background: rgba(255,255,255,0.9);
  color: var(--ink);
}

button {
  cursor: pointer;
  font-weight: 700;
  color: white;
  background: linear-gradient(135deg, var(--teal), var(--navy));
}

.ghost {
  color: var(--ink);
  background: rgba(255,255,255,0.88);
}

.entity-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 10px;
}

.entity-list li {
  padding: 12px 14px;
  border-radius: 16px;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(19,33,47,0.06);
}

.entity-list strong {
  display: block;
}

.table-shell {
  overflow: auto;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.72);
}

table {
  width: 100%;
  min-width: 680px;
  border-collapse: collapse;
}

th, td {
  padding: 14px 16px;
  text-align: left;
  border-bottom: 1px solid rgba(19,33,47,0.08);
}

th {
  background: var(--cream);
}

.output {
  margin: 16px 0 0;
  min-height: 110px;
  padding: 16px;
  border-radius: 18px;
  background: #0f1822;
  color: #d4f5ef;
  font-family: var(--mono);
  overflow: auto;
}

.is-error {
  color: #ff9d9d;
}

.hint {
  margin: 12px 0 0;
  font-size: 0.78rem;
}

@media (max-width: 1080px) {
  .hero, .grid, .form-grid, .form-grid.compact {
    grid-template-columns: 1fr;
  }

  .wide {
    grid-column: auto;
  }
}
`;

export const dashboardScript = `
const state = {
  config: null,
  providers: [],
  customers: [],
  workspaces: [],
  usage: [],
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

function setDefaultTimes() {
  const now = Date.now();
  $("#policy-issue-form").elements.startsAt.value = toLocalValue(now);
  $("#policy-issue-form").elements.expiresAt.value = toLocalValue(now + 24 * 60 * 60 * 1000);
  $("#policy-issue-form").elements.graceUntil.value = toLocalValue(now + 72 * 60 * 60 * 1000);
  $("#tsa-form").elements.attestedAt.value = toLocalValue(now);
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

async function refreshAll() {
  await refreshHierarchy();
  await refreshUsage();
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
  $("#refresh-attestations").addEventListener("click", () => {
    refreshAttestations().catch((error) => setOutput("#tsa-output", { error: error.message }, true));
  });
  $("#workspace-provider").addEventListener("change", refreshWorkspaceCustomerOptions);

  bindAsyncForm("#provider-form", handleProviderSubmit, "#policy-output");
  bindAsyncForm("#customer-form", handleCustomerSubmit, "#policy-output");
  bindAsyncForm("#workspace-form", handleWorkspaceSubmit, "#policy-output");
  bindAsyncForm("#policy-issue-form", handlePolicyIssue, "#policy-output");
  bindAsyncForm("#policy-sync-form", handlePolicySync, "#policy-output");
  bindAsyncForm("#meter-upload-form", handleMeterUpload, "#usage-output");
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
