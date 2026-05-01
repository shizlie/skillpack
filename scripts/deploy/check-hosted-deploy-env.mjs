const REQUIRED_KEYS = [
  "SKILLPACK_API_BASE_URL",
  "SKILLPACK_DASHBOARD_ORIGIN",
];

export function validateHostedDeployEnv(env = process.env) {
  const missing = REQUIRED_KEYS.filter((key) => {
    const value = env[key];
    return typeof value !== "string" || value.length === 0;
  });
  const hasApiKey =
    typeof env.SKILLPACK_API_KEY === "string" && env.SKILLPACK_API_KEY.length > 0;
  const hasApiAuthHeader =
    typeof env.SMOKE_API_AUTH_HEADER === "string" && env.SMOKE_API_AUTH_HEADER.length > 0;
  if (!hasApiKey && !hasApiAuthHeader) {
    missing.push("SKILLPACK_API_KEY_OR_SMOKE_API_AUTH_HEADER");
  }

  if (missing.length > 0) {
    throw new Error(`hosted_deploy_missing_configuration:${missing.join(",")}`);
  }

  return { ok: true };
}

if (import.meta.main) {
  try {
    validateHostedDeployEnv(process.env);
    console.log(JSON.stringify({ ok: true }));
  } catch (error) {
    console.error(error.message);
    console.error(
      "Set SKILLPACK_API_BASE_URL, SKILLPACK_DASHBOARD_ORIGIN, and either SKILLPACK_API_KEY or SMOKE_API_AUTH_HEADER before running hosted smoke verification."
    );
    process.exit(1);
  }
}
