import crypto from "node:crypto";

import { createManualTimeAttestationContract, createTsaMonitor } from "@skillpack/tsa";
import { createPaymentProviderRegistry } from "./payment-providers.js";
import { createInMemoryLeaseStore } from "./storage.js";
import { matchRoute, routes } from "./routes.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("invalid_json_body");
  }
}

function readApiKey(request) {
  return request.headers.get("x-api-key") ?? request.headers.get("X-Api-Key");
}

function isValidManagementKey(request, managementApiKey) {
  const providedApiKey = readApiKey(request);
  if (
    typeof providedApiKey !== "string" ||
    typeof managementApiKey !== "string" ||
    providedApiKey.length !== managementApiKey.length
  ) {
    return false;
  }
  const hashKey = (key) => crypto.createHash("sha256").update(key).digest();
  return crypto.timingSafeEqual(hashKey(providedApiKey), hashKey(managementApiKey));
}

async function authenticateManagementRequest(
  request,
  { managementApiKey, managementAuthenticator }
) {
  if (typeof managementAuthenticator === "function") {
    try {
      return (await managementAuthenticator(request)) === true
        ? null
        : json({ error: "unauthorized" }, 401);
    } catch {
      return json({ error: "unauthorized" }, 401);
    }
  }
  if (!managementApiKey) {
    return json({ error: "management_api_key_not_configured" }, 503);
  }
  if (!isValidManagementKey(request, managementApiKey)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

function jsonResponse({ status = 200, body } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status, error) {
  return jsonResponse({ status, body: { error } });
}

function findRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const result = matchRoute(route.path, pathname);
    if (result.matches) return { route, params: result.params };
  }
  return null;
}

export function createLicenseFetchHandler({
  signingPrivateKeyPem,
  signingPublicKeyPem,
  leaseStore = createInMemoryLeaseStore(),
  tsaMonitor = createTsaMonitor(),
  attestationContract = createManualTimeAttestationContract(),
  managementApiKey = null,
  managementAuthenticator = null,
  paymentProviders = createPaymentProviderRegistry(),
} = {}) {
  if (!signingPrivateKeyPem || !signingPublicKeyPem) {
    throw new Error("license_server_missing_signing_keys");
  }

  return async function fetch(request) {
    const url = new URL(request.url);
    const nowSec = Math.floor(Date.now() / 1000);

    const found = findRoute(request.method, url.pathname);
    if (!found) return errorResponse(404, "not_found");

    if (found.route.management) {
      const authError = await authenticateManagementRequest(request, {
        managementApiKey,
        managementAuthenticator,
      });
      if (authError) return authError;
    }

    const { route, params } = found;
    /**
     * @typedef {Object} RouteCtx
     * Context object passed to every route handler.
     *
     * @property {any} store — Lease store; see packages/core/src/storage.js
     * @property {any} providers — Payment provider registry; see packages/core/src/payment-providers.js
     * @property {any} tsaMonitor — TSA token monitor
     * @property {any} attestationContract — Manual time attestation contract
     * @property {string} signingPrivateKeyPem — PEM-encoded Ed25519 private signing key
     * @property {string} signingPublicKeyPem — PEM-encoded Ed25519 public signing key
     * @property {string|null} managementApiKey — Management API key (for meter.upload dual-auth)
     * @property {Function|null} managementAuthenticator — Custom management authenticator
     * @property {Request} request — The original incoming Request
     * @property {URL} url — Parsed URL of the request
     * @property {number} nowSec — floor(Date.now()/1000) at request start
     * @property {Record<string,string>} params — Path parameters extracted by the matcher (e.g. { id: 'inv_123' })
     * @property {object|null} body — Parsed JSON body. null for GET/HEAD; an object otherwise.
     */
    const ctx = {
      store: leaseStore,
      providers: paymentProviders,
      tsaMonitor,
      attestationContract,
      signingPrivateKeyPem,
      signingPublicKeyPem,
      managementApiKey,
      managementAuthenticator,
      request,
      url,
      nowSec,
      params,
      body: null,
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      try {
        ctx.body = await readBody(request);
      } catch (error) {
        return errorResponse(400, error.message);
      }
    }

    try {
      const result = await route.handler(ctx);
      if (result === null || result === undefined) {
        return errorResponse(500, "internal_error");
      }
      if (result instanceof Response) return result;
      return jsonResponse(result);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("route_not_implemented")) {
        return errorResponse(500, error.message);
      }
      return errorResponse(500, error instanceof Error ? error.message : "internal_error");
    }
  };
}

export function startLicenseServer(options) {
  const storageMode = options?.storageMode ?? "memory";
  const leaseStore = options?.leaseStore ?? createInMemoryLeaseStore();
  const managementApiKey =
    options?.managementApiKey ??
    process.env.SKILLPACK_API_KEY ??
    null;
  if (!options?.leaseStore && storageMode === "sqlite") {
    throw new Error("license_server_sqlite_store_not_injected");
  }
  const fetch = createLicenseFetchHandler({
    ...options,
    leaseStore,
    managementApiKey,
  });
  const port = options?.port ?? 3001;
  return Bun.serve({ port, fetch });
}
