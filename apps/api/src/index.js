import { Hono } from "hono";

import {
  createD1LeaseStore,
  createDodoPaymentProvider,
  createLicenseFetchHandler,
  createPaymentProviderRegistry,
  createStripePaymentProvider,
} from "@skillpack/core";

const app = new Hono();

// CF Worker env is a stable object per isolate lifetime (same reference for every request in the isolate).
// WeakMap keyed on env gives us free per-isolate caching and correct test isolation (each test has its own env).
const handlerCache = new WeakMap();

function getEnvString(env, key) {
  const value = env?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`worker_missing_env_${key}`);
  }
  return value;
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

function getFetchHandler(env) {
  if (handlerCache.has(env)) return handlerCache.get(env);

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
    managementApiKey: getEnvString(env, "SKILLPACK_API_KEY"),
    leaseStore: createD1LeaseStore({ db }),
    paymentProviders: createPaymentProviderRegistry({ providers: paymentAdapters }),
  });

  handlerCache.set(env, handler);
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
    "content-type, x-api-key, x-skillpack-lease-token"
  );
  headers.set("access-control-max-age", "86400");
  headers.set("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function delegateApi(c) {
  try {
    const fetchHandler = getFetchHandler(c.env);
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

app.options("/v1/*", (c) =>
  withCors(new Response(null, { status: 204 }), c.req.raw, c.env)
);

app.get("/healthz", delegateApi);
app.all("/v1/*", delegateApi);

app.all("*", () => json({ error: "not_found" }, 404));

export default {
  fetch: app.fetch,
};
