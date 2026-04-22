import { Hono } from "hono";

import { createD1LeaseStore, createLicenseFetchHandler } from "@skillpack/license-server";

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

  const handler = createLicenseFetchHandler({
    signingPrivateKeyPem: getPemFromEnv(env, "SKILLPACK_SIGNING_PRIVATE_KEY_PEM"),
    signingPublicKeyPem: getPemFromEnv(env, "SKILLPACK_SIGNING_PUBLIC_KEY_PEM"),
    managementApiKey: getEnvString(env, "SKILLPACK_MANAGEMENT_API_KEY"),
    leaseStore: createD1LeaseStore({ db }),
  });

  handlerCache.set(env, handler);
  return handler;
}

app.all("*", async (c) => {
  try {
    const fetchHandler = getFetchHandler(c.env);
    return await fetchHandler(c.req.raw);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "worker_internal_error",
      },
      500
    );
  }
});

export default {
  fetch: app.fetch,
};
