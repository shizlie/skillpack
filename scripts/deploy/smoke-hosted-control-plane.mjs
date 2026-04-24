export async function smokeHostedControlPlane({
  apiBaseUrl,
  dashboardBaseUrl,
  apiKey,
  fetchImpl = fetch,
}) {
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
  });
  console.log(JSON.stringify({ ok: true }));
}
