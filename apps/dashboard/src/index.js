import { createClerkClient } from "@clerk/backend";
import { Hono } from "hono";

import {
  dashboardScript,
  dashboardStyles,
  renderDashboardHtml,
} from "./dashboard-ui.js";

const app = new Hono();
const clerkClientCache = new WeakMap();

function getPublishableKey(env) {
  const value =
    env?.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
    env?.CLERK_PUBLISHABLE_KEY ??
    null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getSecretKey(env) {
  const value = env?.CLERK_SECRET_KEY ?? null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decodeFrontendApiHost(publishableKey) {
  if (typeof publishableKey !== "string" || !publishableKey.startsWith("pk_")) {
    return null;
  }
  const segments = publishableKey.split("_");
  if (segments.length < 3) return null;
  const encoded = segments.slice(2).join("_");
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    if (typeof atob === "function") {
      return atob(normalized).replace(/\$$/, "");
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(normalized, "base64").toString("utf8").replace(/\$$/, "");
    }
  } catch {
    return null;
  }
  return null;
}

function getDashboardOrigin(request, env) {
  const configured = env?.SKILLPACK_DASHBOARD_ORIGIN;
  if (typeof configured === "string" && configured.length > 0) {
    return configured;
  }
  return new URL(request.url).origin;
}

function getClerkClient(env) {
  if (clerkClientCache.has(env)) return clerkClientCache.get(env);

  const publishableKey = getPublishableKey(env);
  const secretKey = getSecretKey(env);
  if (!publishableKey) throw new Error("dashboard_missing_clerk_publishable_key");
  if (!secretKey) throw new Error("dashboard_missing_clerk_secret_key");

  const clerkClient = createClerkClient({
    publishableKey,
    secretKey,
  });
  clerkClientCache.set(env, clerkClient);
  return clerkClient;
}

async function authenticateDashboardRequest(request, env) {
  const clerkClient = getClerkClient(env);
  const state = await clerkClient.authenticateRequest(request, {
    authorizedParties: [getDashboardOrigin(request, env)],
  });
  if (!state.isAuthenticated) {
    return null;
  }
  return state.toAuth();
}

function getRequiredEnvString(env, key) {
  const value = env?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`dashboard_missing_env_${key}`);
  }
  return value;
}

// Any authenticated Clerk user gets full management access — intentional for v1 single-operator
// model. Add RBAC here if multi-tenant operators are introduced post-LOI.
async function proxyApiRequest(c) {
  const auth = await authenticateDashboardRequest(c.req.raw, c.env);
  if (!auth?.userId) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const apiBaseUrl = getRequiredEnvString(c.env, "SKILLPACK_API_BASE_URL");
  const apiKey = getRequiredEnvString(c.env, "SKILLPACK_API_MANAGEMENT_KEY");

  const incoming = new URL(c.req.raw.url);
  const strippedPath = incoming.pathname.slice("/api".length) || "/";
  if (strippedPath.includes("..")) {
    return c.json({ error: "invalid_path" }, 400);
  }
  const upstreamUrl = new URL(strippedPath + incoming.search, apiBaseUrl);

  const headers = new Headers();
  const contentType = c.req.raw.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("x-api-key", apiKey);
  headers.set("x-skillpack-dashboard-user-id", auth.userId);

  const response = await fetch(upstreamUrl.toString(), {
    method: c.req.raw.method,
    headers,
    body:
      c.req.raw.method === "GET" || c.req.raw.method === "HEAD"
        ? undefined
        : await c.req.raw.text(),
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

app.get("/healthz", (c) =>
  c.json({ ok: true, service: "dashboard-worker" })
);

app.get("/app-config", (c) => {
  const publishableKey = getPublishableKey(c.env);
  const secretKey = getSecretKey(c.env);
  return c.json({
    apiProxyBase: "/api",
    authMode: publishableKey ? "clerk" : "unconfigured",
    apiBaseUrlConfigured:
      typeof c.env?.SKILLPACK_API_BASE_URL === "string" &&
      c.env.SKILLPACK_API_BASE_URL.length > 0,
    apiManagementConfigured:
      typeof c.env?.SKILLPACK_API_MANAGEMENT_KEY === "string" &&
      c.env.SKILLPACK_API_MANAGEMENT_KEY.length > 0,
    clerkBackendConfigured: Boolean(secretKey),
    clerkPublishableKey: publishableKey,
    clerkFrontendApiHost: decodeFrontendApiHost(publishableKey),
    clerkSignInUrl: c.env?.SKILLPACK_CLERK_SIGN_IN_URL ?? null,
    clerkSignUpUrl: c.env?.SKILLPACK_CLERK_SIGN_UP_URL ?? null,
  });
});

app.get("/assets/dashboard.css", () =>
  new Response(dashboardStyles, {
    headers: { "content-type": "text/css; charset=utf-8" },
  })
);

app.get("/assets/dashboard.js", () =>
  new Response(dashboardScript, {
    headers: { "content-type": "application/javascript; charset=utf-8" },
  })
);

app.all("/api/*", proxyApiRequest);

app.get("/", (c) => c.html(renderDashboardHtml()));
app.get("*", (c) => c.html(renderDashboardHtml()));

export default {
  fetch: app.fetch,
};
