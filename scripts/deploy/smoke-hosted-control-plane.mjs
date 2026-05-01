export async function smokeHostedControlPlane({
  apiBaseUrl,
  dashboardBaseUrl,
  apiKey,
  apiAuthHeader,
  dashboardAuthHeader,
  runId = String(Date.now()),
  fetchImpl = fetch,
}) {
  const buildApiHeaders = ({ includeContentType = true } = {}) => {
    const headers = includeContentType ? { "content-type": "application/json" } : {};
    if (typeof apiAuthHeader === "string" && apiAuthHeader.length > 0) {
      headers.authorization = apiAuthHeader;
    } else if (typeof apiKey === "string" && apiKey.length > 0) {
      headers["x-api-key"] = apiKey;
    }
    return headers;
  };
  const apiHeaders = buildApiHeaders();
  const nowSec = Math.floor(Date.now() / 1000);
  const ids = {
    providerId: "smoke-prov",
    customerId: "smoke-cust",
    workspaceId: "smoke-ws",
    seatId: "smoke-seat",
    skillId: "laws-consultant",
    bundleId: `laws-consultant-${runId}`,
    policyId: `smoke-policy-${runId}`,
    leaseJti: `smoke-lease-${runId}`,
    pricingRuleId: `smoke-price-${runId}`,
    invoiceId: `smoke-invoice-${runId}`,
  };

  async function requestJson(url, options = {}) {
    const response = await fetchImpl(url, options);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw new Error(`${options.method ?? "GET"} ${new URL(url).pathname} failed:${response.status}`);
    }
    if (body?.accepted === false) {
      throw new Error(`${options.method ?? "GET"} ${new URL(url).pathname} rejected:${body.error}`);
    }
    return body;
  }

  const apiHealth = await fetchImpl(`${apiBaseUrl}/healthz`);
  if (!apiHealth.ok) {
    throw new Error(`api_health_failed:${apiHealth.status}`);
  }

  const dashboardHealth = await fetchImpl(`${dashboardBaseUrl}/healthz`);
  if (!dashboardHealth.ok) {
    throw new Error(`dashboard_health_failed:${dashboardHealth.status}`);
  }

  const configRes = await fetchImpl(`${dashboardBaseUrl}/app-config`);
  if (!configRes.ok) {
    throw new Error(`dashboard_config_failed:${configRes.status}`);
  }
  const config = await configRes.json();
  if (config.apiProxyBase !== "/api") {
    throw new Error("dashboard_config_invalid_proxy_base");
  }
  if (config.authMode !== "clerk") {
    throw new Error("dashboard_config_invalid_auth_mode");
  }
  if (config.apiBaseUrlConfigured !== true) {
    throw new Error("dashboard_config_missing_api_base_url");
  }
  if (config.clerkBackendConfigured !== true) {
    throw new Error("dashboard_config_missing_clerk_secret");
  }

  if (typeof apiKey === "string" && apiKey.length > 0) {
    const providersRes = await fetchImpl(`${apiBaseUrl}/v1/providers`, {
      headers: { "x-api-key": apiKey },
    });
    if (!providersRes.ok) {
      throw new Error(`api_key_failed:${providersRes.status}`);
    }
  }

  if (typeof apiAuthHeader === "string" && apiAuthHeader.length > 0) {
    const providersRes = await fetchImpl(`${apiBaseUrl}/v1/providers`, {
      headers: { authorization: apiAuthHeader },
    });
    if (!providersRes.ok) {
      throw new Error(`api_auth_header_failed:${providersRes.status}`);
    }
  }

  if (typeof dashboardAuthHeader === "string" && dashboardAuthHeader.length > 0) {
    const proxyRes = await fetchImpl(`${dashboardBaseUrl}/api/v1/providers`, {
      headers: { authorization: dashboardAuthHeader },
    });
    if (!proxyRes.ok) {
      throw new Error(`dashboard_proxy_failed:${proxyRes.status}`);
    }
  }

  await requestJson(`${apiBaseUrl}/v1/providers`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      providerId: ids.providerId,
      name: "Smoke Provider",
    }),
  });
  await requestJson(`${apiBaseUrl}/v1/providers/${encodeURIComponent(ids.providerId)}/customers`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      customerId: ids.customerId,
      name: "Smoke Customer",
    }),
  });
  await requestJson(`${apiBaseUrl}/v1/workspaces`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      workspaceId: ids.workspaceId,
      providerId: ids.providerId,
      customerId: ids.customerId,
      name: "Smoke Workspace",
    }),
  });
  await requestJson(`${apiBaseUrl}/v1/policies/issue`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      policy: {
        policyVersion: 1,
        policyId: ids.policyId,
        workspaceId: ids.workspaceId,
        workspacePolicy: { mode: "ENABLED" },
        seatPolicy: {
          defaultMode: "ENABLED",
          seats: { [ids.seatId]: { mode: "ENABLED" } },
        },
        usagePolicy: {
          unit: "tool_call",
          thresholds: { warningPct: 100, hardStopPct: 120 },
          toolBudgets: { wiki_search: 100 },
        },
        timePolicy: {
          workspace: {
            startsAtSec: nowSec - 60,
            expiresAtSec: nowSec + 3600,
            graceUntilSec: nowSec + 7200,
          },
          seatOverrides: {
            [ids.seatId]: {
              startsAtSec: nowSec - 60,
              expiresAtSec: nowSec + 3600,
              graceUntilSec: nowSec + 7200,
            },
          },
        },
      },
    }),
  });
  await requestJson(`${apiBaseUrl}/v1/meter/upload`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      workspaceId: ids.workspaceId,
      context: {
        providerId: ids.providerId,
        customerId: ids.customerId,
        workspaceId: ids.workspaceId,
        seatId: ids.seatId,
        skillId: ids.skillId,
        bundleId: ids.bundleId,
        leaseJti: ids.leaseJti,
        policyId: ids.policyId,
      },
      events: [
        {
          prevHash: "GENESIS",
          seq: 0,
          at: nowSec,
          kind: "tool_call",
          seatId: ids.seatId,
          tool: "wiki_search",
          usage: { unit: "tool_call", delta: 2 },
        },
      ],
    }),
  });
  const usage = await requestJson(
    `${apiBaseUrl}/v1/usage/summary?providerId=${encodeURIComponent(
      ids.providerId
    )}&workspaceId=${encodeURIComponent(ids.workspaceId)}`,
    { headers: buildApiHeaders({ includeContentType: false }) }
  );
  const totalCalls = (usage.summary ?? []).reduce(
    (sum, row) => sum + Number(row.totalCalls ?? 0),
    0
  );
  if (!(totalCalls > 0)) {
    throw new Error("usage_summary_missing_smoke_usage");
  }

  await requestJson(`${apiBaseUrl}/v1/billing/pricing-rules`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      pricingRuleId: ids.pricingRuleId,
      providerId: ids.providerId,
      customerId: ids.customerId,
      workspaceId: ids.workspaceId,
      skillId: ids.skillId,
      tool: "wiki_search",
      currency: "USD",
      unitAmountCents: 10,
    }),
  });
  const invoice = await requestJson(`${apiBaseUrl}/v1/billing/invoices/draft`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({
      invoiceId: ids.invoiceId,
      providerId: ids.providerId,
      customerId: ids.customerId,
      workspaceId: ids.workspaceId,
      periodStartSec: nowSec - 60,
      periodEndSec: nowSec + 60,
    }),
  });
  if (invoice.invoice?.status !== "DRAFT") {
    throw new Error("billing_invoice_draft_missing");
  }

  return { ok: true };
}

function parseArgs(argv) {
  return Object.fromEntries(
    argv.map((arg) => {
      const [key, ...valueParts] = arg.replace(/^--/, "").split("=");
      return [key, valueParts.join("=")];
    })
  );
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  await smokeHostedControlPlane({
    apiBaseUrl: args["api-base-url"],
    dashboardBaseUrl: args["dashboard-base-url"],
    apiKey: args["api-key"],
    apiAuthHeader:
      args["api-auth-header"] ??
      (args["api-bearer-token"] ? `Bearer ${args["api-bearer-token"]}` : undefined),
    dashboardAuthHeader: args["dashboard-auth-header"],
    runId: args["run-id"],
  });
  console.log(JSON.stringify({ ok: true }));
}
