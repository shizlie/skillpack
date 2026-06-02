// @ts-check
export function renderDashboardHtml({ scriptUrl, styleUrl }) {
  return /* html */`<!doctype html>
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
    <link rel="stylesheet" href="${styleUrl}" />
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
          <article><span>Pricing Rules</span><strong id="metric-pricing-rules">0</strong></article>
          <article><span>Invoices</span><strong id="metric-invoices">0</strong></article>
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
                <p class="eyebrow">Billing</p>
                <h2>Pricing rules and invoice handoffs</h2>
              </div>
              <button type="button" class="ghost" id="refresh-billing">Refresh</button>
            </div>

            <form id="billing-pricing-rule-form" class="form-grid">
              <label><span>Rule ID</span><input name="pricingRuleId" required placeholder="price-search" /></label>
              <label><span>Provider</span><select name="providerId" id="billing-rule-provider"></select></label>
              <label><span>Customer</span><select name="customerId" id="billing-rule-customer"></select></label>
              <label><span>Workspace</span><select name="workspaceId" id="billing-rule-workspace"></select></label>
              <label><span>Skill ID</span><input name="skillId" placeholder="laws-consultant" /></label>
              <label><span>Bundle ID</span><input name="bundleId" placeholder="laws-consultant-1.0.0" /></label>
              <label><span>Tool</span><input name="tool" placeholder="wiki_search" /></label>
              <label><span>Currency</span><input name="currency" required value="USD" /></label>
              <label><span>Unit cents</span><input name="unitAmountCents" type="number" min="0" required value="25" /></label>
              <label><span>Included units</span><input name="includedUnits" type="number" min="0" value="0" /></label>
              <label><span>Minimum cents</span><input name="minimumAmountCents" type="number" min="0" value="0" /></label>
              <label>
                <span>Payment</span>
                <select name="paymentProvider">
                  <option value="manual">manual</option>
                  <option value="dodo">dodo</option>
                  <option value="stripe">stripe</option>
                </select>
              </label>
              <label><span>Dodo product</span><input name="productId" placeholder="prod_..." /></label>
              <label><span>Stripe price</span><input name="priceId" placeholder="price_..." /></label>
              <button type="submit">Create price</button>
            </form>

            <form id="billing-invoice-draft-form" class="form-grid compact">
              <label><span>Invoice ID</span><input name="invoiceId" placeholder="auto" /></label>
              <label><span>Provider</span><select name="providerId" id="billing-invoice-provider"></select></label>
              <label><span>Customer</span><select name="customerId" id="billing-invoice-customer"></select></label>
              <label><span>Workspace</span><select name="workspaceId" id="billing-invoice-workspace"></select></label>
              <label><span>Period start</span><input name="periodStart" type="datetime-local" /></label>
              <label><span>Period end</span><input name="periodEnd" type="datetime-local" /></label>
              <label><span>Currency</span><input name="currency" placeholder="rule default" /></label>
              <button type="submit">Draft invoice</button>
            </form>

            <form id="billing-payment-handoff-form" class="form-grid compact">
              <label><span>Invoice</span><select name="invoiceId" id="billing-handoff-invoice"></select></label>
              <label>
                <span>Provider</span>
                <select name="provider">
                  <option value="manual">manual</option>
                  <option value="dodo">dodo</option>
                  <option value="stripe">stripe</option>
                </select>
              </label>
              <label><span>Return URL</span><input name="returnUrl" placeholder="https://vendor.example/paid" /></label>
              <label><span>Customer email</span><input name="customerEmail" type="email" placeholder="ops@example.com" /></label>
              <label><span>Customer name</span><input name="customerName" placeholder="Ops Lead" /></label>
              <button type="submit">Create handoff</button>
            </form>

            <div class="triptych">
              <div>
                <h3>Pricing rules</h3>
                <ul id="pricing-rules-list" class="entity-list"></ul>
              </div>
              <div>
                <h3>Invoices</h3>
                <ul id="invoices-list" class="entity-list"></ul>
              </div>
              <div>
                <h3>Latest handoffs</h3>
                <ul id="handoffs-list" class="entity-list"></ul>
              </div>
            </div>

            <div class="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Customer</th>
                    <th>Status</th>
                    <th>Period</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody id="invoices-body"></tbody>
              </table>
            </div>

            <pre id="billing-output" class="output">Billing responses will appear here.</pre>
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

    <script type="module" src="${scriptUrl}"></script>
  </body>
</html>`;
}
