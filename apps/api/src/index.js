import { createClerkClient } from "@clerk/backend";
import { Hono } from "hono";

import {
  createD1LeaseStore,
  createDodoPaymentProvider,
  createLicenseFetchHandler,
  createManagementAuthOptions,
  createPaymentProviderRegistry,
  createStripePaymentProvider,
  getPemFromEnv,
} from "@skillpack/core";

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
    ...createManagementAuthOptions(env, { cache: workerOptions.clerkClientCache, createClerkClientImpl: workerOptions.createClerkClientImpl }),
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
