import { createClerkClient } from "@clerk/backend";
import { Hono } from "hono";

import {
  createD1LeaseStore,
  createDodoPaymentProvider,
  createLicenseFetchHandler,
  createPaymentProviderRegistry,
  createStripePaymentProvider,
} from "@skillpack/core";

function getEnvString(env, key) {
  const value = env?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`worker_missing_env_${key}`);
  }
  return value;
}

function getOptionalEnvString(env, key) {
  const value = env?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getPemFromEnv(env, key) {
  const direct = env?.[key];
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const base64 = env?.[`${key}_BASE64`];
  if (typeof base64 === "string" && base64.length > 0) {
    if (typeof Buffer === "undefined") {
      throw new Error("worker_nodejs_compat_required: add nodejs_compat to wrangler.jsonc compatibility_flags");
    }
    return Buffer.from(base64, "base64").toString("utf8");
  }
  throw new Error(`worker_missing_env_${key}`);
}

function readApiKey(request) {
  return request.headers.get("x-api-key") ?? request.headers.get("X-Api-Key");
}

async function isValidSharedManagementKey(request, managementApiKey) {
  const providedApiKey = readApiKey(request);
  if (typeof providedApiKey !== "string" || typeof managementApiKey !== "string") {
    return false;
  }
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

function getManagementAuthMode(env) {
  const mode = env?.SKILLPACK_MANAGEMENT_AUTH_MODE ?? "shared-key";
  if (mode === "shared-key" || mode === "clerk" || mode === "hybrid") {
    return mode;
  }
  throw new Error("worker_invalid_management_auth_mode");
}

function getClerkAuthorizedParties(env) {
  const dashboardOrigin = getOptionalEnvString(env, "SKILLPACK_DASHBOARD_ORIGIN");
  return dashboardOrigin ? [dashboardOrigin] : undefined;
}

function getClerkClient(env, { clerkClientCache, createClerkClientImpl }) {
  if (clerkClientCache.has(env)) return clerkClientCache.get(env);

  const secretKey = getEnvString(env, "CLERK_SECRET_KEY");
  const publishableKey = getOptionalEnvString(env, "CLERK_PUBLISHABLE_KEY");
  const clerkClient = createClerkClientImpl({
    secretKey,
    ...(publishableKey ? { publishableKey } : {}),
  });
  clerkClientCache.set(env, clerkClient);
  return clerkClient;
}

async function authenticateClerkManagementRequest(request, env, workerOptions) {
  const clerkClient = getClerkClient(env, workerOptions);
  const authorizedParties = getClerkAuthorizedParties(env);
  const state = await clerkClient.authenticateRequest(request, {
    ...(authorizedParties ? { authorizedParties } : {}),
  });
  return state.isAuthenticated === true && Boolean(state.toAuth()?.userId);
}

function createManagementAuthOptions(env, workerOptions) {
  const mode = getManagementAuthMode(env);
  if (mode === "shared-key") {
    return {
      managementApiKey: getEnvString(env, "SKILLPACK_API_KEY"),
      managementAuthenticator: null,
    };
  }
  if (mode === "clerk") {
    return {
      managementApiKey: null,
      managementAuthenticator: (request) =>
        authenticateClerkManagementRequest(request, env, workerOptions),
    };
  }
  const managementApiKey = getOptionalEnvString(env, "SKILLPACK_API_KEY");
  return {
    managementApiKey: null,
    managementAuthenticator: async (request) => {
      if (
        managementApiKey &&
        (await isValidSharedManagementKey(request, managementApiKey))
      ) {
        return true;
      }
      return authenticateClerkManagementRequest(request, env, workerOptions);
    },
  };
}

function getFetchHandler(env, workerOptions) {
  if (workerOptions.handlerCache.has(env)) return workerOptions.handlerCache.get(env);

  const db = env?.DB;
  if (!db || typeof db.prepare !== "function") {
    throw new Error("worker_missing_d1_binding_DB");
  }

  const paymentAdapters = [];
  if (typeof env?.DODO_PAYMENTS_API_KEY === "string" && env.DODO_PAYMENTS_API_KEY.length > 0) {
    paymentAdapters.push(
      createDodoPaymentProvider({
        apiKey: env.DODO_PAYMENTS_API_KEY,
        environment: env.DODO_PAYMENTS_ENVIRONMENT ?? "live",
      })
    );
  }
  if (typeof env?.STRIPE_SECRET_KEY === "string" && env.STRIPE_SECRET_KEY.length > 0) {
    paymentAdapters.push(createStripePaymentProvider({ apiKey: env.STRIPE_SECRET_KEY }));
  }

  const handler = createLicenseFetchHandler({
    signingPrivateKeyPem: getPemFromEnv(env, "SKILLPACK_SIGNING_PRIVATE_KEY_PEM"),
    signingPublicKeyPem: getPemFromEnv(env, "SKILLPACK_SIGNING_PUBLIC_KEY_PEM"),
    ...createManagementAuthOptions(env, workerOptions),
    leaseStore: createD1LeaseStore({ db }),
    paymentProviders: createPaymentProviderRegistry({ providers: paymentAdapters }),
  });

  workerOptions.handlerCache.set(env, handler);
  return handler;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getCorsOrigin(request, env) {
  const configured = env?.SKILLPACK_DASHBOARD_ORIGIN;
  if (typeof configured === "string" && configured.length > 0) {
    return configured;
  }
  return "*";
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", getCorsOrigin(request, env));
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "authorization, content-type, x-api-key, x-skillpack-lease-token"
  );
  headers.set("access-control-max-age", "86400");
  headers.set("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function delegateApi(c, workerOptions) {
  try {
    const fetchHandler = getFetchHandler(c.env, workerOptions);
    const response = await fetchHandler(c.req.raw);
    return withCors(response, c.req.raw, c.env);
  } catch (error) {
    return withCors(
      json(
        {
          error: error instanceof Error ? error.message : "worker_internal_error",
        },
        500
      ),
      c.req.raw,
      c.env
    );
  }
}

export function createApiWorker({ createClerkClientImpl = createClerkClient } = {}) {
  const app = new Hono();
  const workerOptions = {
    clerkClientCache: new WeakMap(),
    createClerkClientImpl,
    handlerCache: new WeakMap(),
  };

  app.options("/v1/*", (c) =>
    withCors(new Response(null, { status: 204 }), c.req.raw, c.env)
  );

  app.get("/healthz", (c) => delegateApi(c, workerOptions));
  app.all("/v1/*", (c) => delegateApi(c, workerOptions));

  app.all("*", () => json({ error: "not_found" }, 404));

  return {
    fetch: app.fetch,
  };
}

export default createApiWorker();
