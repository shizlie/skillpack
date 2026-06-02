// Shared auth helpers for Skillpack Cloudflare Workers.
// Both apps/api and apps/dashboard import from here; neither defines its own copy.

export function getEnvString(env, key, { prefix = "worker" } = {}) {
  const value = env?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${prefix}_missing_env_${key}`);
  }
  return value;
}

export function getOptionalEnvString(env, key) {
  const value = env?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getPemFromEnv(env, key, { prefix = "worker" } = {}) {
  const direct = env?.[key];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const base64 = env?.[`${key}_BASE64`];
  if (typeof base64 === "string" && base64.length > 0) {
    if (typeof Buffer === "undefined") {
      throw new Error(`${prefix}_nodejs_compat_required: add nodejs_compat to wrangler.jsonc compatibility_flags`);
    }
    return Buffer.from(base64, "base64").toString("utf8");
  }
  throw new Error(`${prefix}_missing_env_${key}`);
}

/**
 * Returns the management auth mode, consulting env vars in the same order as
 * the dashboard's original binding: SKILLPACK_API_AUTH_MODE takes precedence
 * over SKILLPACK_MANAGEMENT_AUTH_MODE. Any deployment that previously set only
 * SKILLPACK_API_AUTH_MODE will continue to work when T4 migrates the dashboard.
 */
export function getManagementAuthMode(env, { defaultMode = "shared-key" } = {}) {
  const mode = env?.SKILLPACK_API_AUTH_MODE ?? env?.SKILLPACK_MANAGEMENT_AUTH_MODE ?? defaultMode;
  if (mode === "shared-key" || mode === "clerk" || mode === "hybrid") return mode;
  throw new Error("invalid_management_auth_mode");
}

export function getClerkAuthorizedParties(env) {
  const dashboardOrigin = getOptionalEnvString(env, "SKILLPACK_DASHBOARD_ORIGIN");
  return dashboardOrigin ? [dashboardOrigin] : undefined;
}

/**
 * Returns a cached Clerk client keyed on `env` (WeakMap-safe).
 *
 * @param {object} env - Worker environment bindings.
 * @param {object} opts
 * @param {WeakMap} opts.cache - WeakMap keyed on `env`; caller owns lifecycle.
 * @param {Function} opts.createClerkClientImpl - `createClerkClient` from @clerk/backend.
 * @param {boolean} [opts.requirePublishableKey=false] - When true, throws
 *   `worker_missing_env_CLERK_PUBLISHABLE_KEY` if the key is absent. The
 *   dashboard (T4) passes `true`; the API worker (T3) passes `false` or omits it.
 */
export function getClerkClient(env, { cache, createClerkClientImpl, requirePublishableKey = false } = {}) {
  if (cache.has(env)) return cache.get(env);
  const secretKey = getEnvString(env, "CLERK_SECRET_KEY", { prefix: "worker" });
  const publishableKey = requirePublishableKey
    ? getEnvString(env, "CLERK_PUBLISHABLE_KEY", { prefix: "worker" })
    : getOptionalEnvString(env, "CLERK_PUBLISHABLE_KEY");
  const clerkClient = createClerkClientImpl({
    secretKey,
    ...(publishableKey ? { publishableKey } : {}),
  });
  cache.set(env, clerkClient);
  return clerkClient;
}

export async function isValidSharedManagementKey(request, managementApiKey) {
  if (typeof managementApiKey !== "string") return false;
  const providedApiKey = request.headers.get("x-api-key") ?? request.headers.get("X-Api-Key");
  if (typeof providedApiKey !== "string") return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(providedApiKey)),
    crypto.subtle.digest("SHA-256", encoder.encode(managementApiKey)),
  ]);
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let diff = providedBytes.length ^ expectedBytes.length;
  for (let i = 0; i < providedBytes.length && i < expectedBytes.length; i += 1) {
    diff |= providedBytes[i] ^ expectedBytes[i];
  }
  return diff === 0;
}

export function createManagementAuthOptions(env, { cache, createClerkClientImpl, defaultMode }) {
  const mode = getManagementAuthMode(env, { defaultMode });
  if (mode === "shared-key") {
    return {
      mode,
      managementApiKey: getEnvString(env, "SKILLPACK_API_KEY"),
      managementAuthenticator: null,
    };
  }
  if (mode === "clerk") {
    return {
      mode,
      managementApiKey: null,
      managementAuthenticator: (request) =>
        authenticateClerk(request, env, { cache, createClerkClientImpl }),
    };
  }
  const managementApiKey = getOptionalEnvString(env, "SKILLPACK_API_KEY");
  return {
    mode,
    managementApiKey: null,
    managementAuthenticator: async (request) => {
      if (managementApiKey && (await isValidSharedManagementKey(request, managementApiKey))) {
        return true;
      }
      return authenticateClerk(request, env, { cache, createClerkClientImpl });
    },
  };
}

async function authenticateClerk(request, env, { cache, createClerkClientImpl }) {
  const clerkClient = getClerkClient(env, { cache, createClerkClientImpl });
  const authorizedParties = getClerkAuthorizedParties(env);
  const state = await clerkClient.authenticateRequest(request, {
    ...(authorizedParties ? { authorizedParties } : {}),
  });
  return state.isAuthenticated === true && Boolean(state.toAuth()?.userId);
}

export function addUpstreamAuthHeaders(headers, request, env, { defaultMode } = {}) {
  const mode = getManagementAuthMode(env, { defaultMode });
  const incomingAuthorization = request.headers.get("authorization");
  if (mode === "clerk") {
    if (!incomingAuthorization) throw new Error("dashboard_missing_authorization_header");
    headers.set("authorization", incomingAuthorization);
    return;
  }
  if (mode === "hybrid" && incomingAuthorization) {
    headers.set("authorization", incomingAuthorization);
    return;
  }
  const apiKey = mode === "hybrid"
    ? getOptionalEnvString(env, "SKILLPACK_API_KEY")
    : getEnvString(env, "SKILLPACK_API_KEY", { prefix: "dashboard" });
  if (!apiKey) throw new Error("dashboard_missing_env_SKILLPACK_API_KEY");
  headers.set("x-api-key", apiKey);
}
