import { describe, test, expect } from "bun:test";
import {
  getEnvString,
  getOptionalEnvString,
  getPemFromEnv,
  getManagementAuthMode,
  getClerkClient,
  isValidSharedManagementKey,
  createManagementAuthOptions,
  addUpstreamAuthHeaders,
  getClerkAuthorizedParties,
} from "../src/worker-auth.js";

// ---------------------------------------------------------------------------
// getEnvString
// ---------------------------------------------------------------------------
describe("worker-auth.getEnvString", () => {
  test("returns value when present", () => {
    expect(getEnvString({ FOO: "bar" }, "FOO")).toBe("bar");
  });
  test("throws for missing key", () => {
    expect(() => getEnvString({}, "FOO")).toThrow(/worker_missing_env_FOO/);
  });
  test("throws for empty string", () => {
    expect(() => getEnvString({ FOO: "" }, "FOO")).toThrow(/worker_missing_env_FOO/);
  });
  test("throws for non-string value", () => {
    expect(() => getEnvString({ FOO: 123 }, "FOO")).toThrow(/worker_missing_env_FOO/);
  });
  test("uses custom prefix in error", () => {
    expect(() => getEnvString({}, "BAR", { prefix: "dashboard" })).toThrow(/dashboard_missing_env_BAR/);
  });
});

// ---------------------------------------------------------------------------
// getOptionalEnvString
// ---------------------------------------------------------------------------
describe("worker-auth.getOptionalEnvString", () => {
  test("returns value when present", () => {
    expect(getOptionalEnvString({ FOO: "bar" }, "FOO")).toBe("bar");
  });
  test("returns null when missing", () => {
    expect(getOptionalEnvString({}, "FOO")).toBeNull();
  });
  test("returns null for empty string", () => {
    expect(getOptionalEnvString({ FOO: "" }, "FOO")).toBeNull();
  });
  test("returns null for non-string value", () => {
    expect(getOptionalEnvString({ FOO: 42 }, "FOO")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getPemFromEnv
// ---------------------------------------------------------------------------
describe("worker-auth.getPemFromEnv", () => {
  test("returns direct PEM value", () => {
    expect(getPemFromEnv({ MY_KEY: "-----BEGIN" }, "MY_KEY")).toBe("-----BEGIN");
  });
  test("decodes base64 fallback via _BASE64 suffix", () => {
    const pem = "hello pem";
    const b64 = Buffer.from(pem).toString("base64");
    expect(getPemFromEnv({ MY_KEY_BASE64: b64 }, "MY_KEY")).toBe(pem);
  });
  test("throws when neither key is present", () => {
    expect(() => getPemFromEnv({}, "MY_KEY")).toThrow(/worker_missing_env_MY_KEY/);
  });
  test("prefers direct key over base64 fallback", () => {
    const b64 = Buffer.from("from_base64").toString("base64");
    expect(getPemFromEnv({ MY_KEY: "direct", MY_KEY_BASE64: b64 }, "MY_KEY")).toBe("direct");
  });
});

// ---------------------------------------------------------------------------
// getManagementAuthMode
// ---------------------------------------------------------------------------
describe("worker-auth.getManagementAuthMode", () => {
  test("prefers SKILLPACK_API_AUTH_MODE for backward compat", () => {
    expect(getManagementAuthMode({ SKILLPACK_API_AUTH_MODE: "clerk" })).toBe("clerk");
  });
  test("falls back to SKILLPACK_MANAGEMENT_AUTH_MODE when API_AUTH_MODE absent", () => {
    expect(getManagementAuthMode({ SKILLPACK_MANAGEMENT_AUTH_MODE: "shared-key" })).toBe("shared-key");
  });
  test("SKILLPACK_API_AUTH_MODE wins over SKILLPACK_MANAGEMENT_AUTH_MODE when both set", () => {
    expect(
      getManagementAuthMode({
        SKILLPACK_API_AUTH_MODE: "clerk",
        SKILLPACK_MANAGEMENT_AUTH_MODE: "shared-key",
      })
    ).toBe("clerk");
  });
  test("defaults to shared-key", () => {
    expect(getManagementAuthMode({})).toBe("shared-key");
  });
  test("accepts hybrid mode", () => {
    expect(getManagementAuthMode({ SKILLPACK_API_AUTH_MODE: "hybrid" })).toBe("hybrid");
  });
  test("throws on unrecognized mode", () => {
    expect(() => getManagementAuthMode({ SKILLPACK_API_AUTH_MODE: "oauth" })).toThrow(
      "invalid_management_auth_mode"
    );
  });
  test("custom defaultMode is used when no env var set", () => {
    expect(getManagementAuthMode({}, { defaultMode: "clerk" })).toBe("clerk");
  });
});

// ---------------------------------------------------------------------------
// getClerkClient — requirePublishableKey option
// ---------------------------------------------------------------------------
describe("worker-auth.getClerkClient requirePublishableKey", () => {
  test("throws when requirePublishableKey: true and no publishable key", () => {
    const cache = new WeakMap();
    expect(() =>
      getClerkClient(
        { CLERK_SECRET_KEY: "secret" },
        {
          cache,
          createClerkClientImpl: () => ({}),
          requirePublishableKey: true,
        }
      )
    ).toThrow(/CLERK_PUBLISHABLE_KEY/);
  });

  test("succeeds when requirePublishableKey: true and publishable key present", () => {
    const cache = new WeakMap();
    const result = getClerkClient(
      { CLERK_SECRET_KEY: "secret", CLERK_PUBLISHABLE_KEY: "pk_test" },
      { cache, createClerkClientImpl: () => ({ _type: "clerk" }), requirePublishableKey: true }
    );
    expect(result).toBeDefined();
  });

  test("succeeds without requirePublishableKey and no publishable key", () => {
    const cache = new WeakMap();
    const result = getClerkClient(
      { CLERK_SECRET_KEY: "secret" },
      { cache, createClerkClientImpl: () => ({ _type: "clerk" }) }
    );
    expect(result).toBeDefined();
  });

  test("returns cached instance on second call", () => {
    const cache = new WeakMap();
    const env = { CLERK_SECRET_KEY: "secret" };
    let callCount = 0;
    const impl = () => { callCount++; return {}; };
    const a = getClerkClient(env, { cache, createClerkClientImpl: impl });
    const b = getClerkClient(env, { cache, createClerkClientImpl: impl });
    expect(a).toBe(b);
    expect(callCount).toBe(1);
  });

  test("passes publishableKey to impl when present", () => {
    const cache = new WeakMap();
    let received;
    const impl = (opts) => { received = opts; return {}; };
    getClerkClient(
      { CLERK_SECRET_KEY: "sk", CLERK_PUBLISHABLE_KEY: "pk" },
      { cache, createClerkClientImpl: impl }
    );
    expect(received).toEqual({ secretKey: "sk", publishableKey: "pk" });
  });

  test("omits publishableKey from impl when absent and not required", () => {
    const cache = new WeakMap();
    let received;
    const impl = (opts) => { received = opts; return {}; };
    getClerkClient(
      { CLERK_SECRET_KEY: "sk" },
      { cache, createClerkClientImpl: impl }
    );
    expect(received).toEqual({ secretKey: "sk" });
  });
});

// ---------------------------------------------------------------------------
// isValidSharedManagementKey
// ---------------------------------------------------------------------------
describe("worker-auth.isValidSharedManagementKey", () => {
  function makeRequest(key) {
    return new Request("https://example.com", {
      headers: key ? { "x-api-key": key } : {},
    });
  }

  test("returns true for matching key", async () => {
    expect(await isValidSharedManagementKey(makeRequest("my-secret"), "my-secret")).toBe(true);
  });

  test("returns false for wrong key", async () => {
    expect(await isValidSharedManagementKey(makeRequest("wrong"), "my-secret")).toBe(false);
  });

  test("returns false when header absent", async () => {
    expect(await isValidSharedManagementKey(makeRequest(null), "my-secret")).toBe(false);
  });

  test("returns false when managementApiKey is not a string", async () => {
    expect(await isValidSharedManagementKey(makeRequest("key"), null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createManagementAuthOptions
// ---------------------------------------------------------------------------
describe("worker-auth.createManagementAuthOptions", () => {
  const cache = new WeakMap();
  const createClerkClientImpl = () => ({});

  test("shared-key mode returns managementApiKey and null authenticator", () => {
    const opts = createManagementAuthOptions(
      { SKILLPACK_API_AUTH_MODE: "shared-key", SKILLPACK_API_KEY: "k" },
      { cache, createClerkClientImpl, defaultMode: "shared-key" }
    );
    expect(opts.mode).toBe("shared-key");
    expect(opts.managementApiKey).toBe("k");
    expect(opts.managementAuthenticator).toBeNull();
  });

  test("clerk mode returns null apiKey and function authenticator", () => {
    const opts = createManagementAuthOptions(
      { SKILLPACK_API_AUTH_MODE: "clerk", CLERK_SECRET_KEY: "sk" },
      { cache, createClerkClientImpl, defaultMode: "shared-key" }
    );
    expect(opts.mode).toBe("clerk");
    expect(opts.managementApiKey).toBeNull();
    expect(typeof opts.managementAuthenticator).toBe("function");
  });

  test("hybrid mode returns null apiKey and function authenticator", () => {
    const opts = createManagementAuthOptions(
      {
        SKILLPACK_API_AUTH_MODE: "hybrid",
        SKILLPACK_API_KEY: "k",
        CLERK_SECRET_KEY: "sk",
      },
      { cache, createClerkClientImpl, defaultMode: "shared-key" }
    );
    expect(opts.mode).toBe("hybrid");
    expect(opts.managementApiKey).toBeNull();
    expect(typeof opts.managementAuthenticator).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// addUpstreamAuthHeaders
// ---------------------------------------------------------------------------
describe("worker-auth.addUpstreamAuthHeaders", () => {
  function makeRequest(authHeader) {
    return new Request("https://example.com", {
      headers: authHeader ? { authorization: authHeader } : {},
    });
  }

  test("clerk mode forwards authorization header", () => {
    const headers = new Headers();
    addUpstreamAuthHeaders(
      headers,
      makeRequest("Bearer tok"),
      { SKILLPACK_API_AUTH_MODE: "clerk" }
    );
    expect(headers.get("authorization")).toBe("Bearer tok");
  });

  test("clerk mode throws when authorization header missing", () => {
    const headers = new Headers();
    expect(() =>
      addUpstreamAuthHeaders(headers, makeRequest(null), { SKILLPACK_API_AUTH_MODE: "clerk" })
    ).toThrow("dashboard_missing_authorization_header");
  });

  test("shared-key mode sets x-api-key header", () => {
    const headers = new Headers();
    addUpstreamAuthHeaders(
      headers,
      makeRequest(null),
      { SKILLPACK_API_AUTH_MODE: "shared-key", SKILLPACK_API_KEY: "my-key" }
    );
    expect(headers.get("x-api-key")).toBe("my-key");
  });

  test("shared-key mode throws when SKILLPACK_API_KEY missing", () => {
    const headers = new Headers();
    expect(() =>
      addUpstreamAuthHeaders(headers, makeRequest(null), { SKILLPACK_API_AUTH_MODE: "shared-key" })
    ).toThrow(/dashboard_missing_env_SKILLPACK_API_KEY/);
  });

  test("hybrid mode forwards authorization when present", () => {
    const headers = new Headers();
    addUpstreamAuthHeaders(
      headers,
      makeRequest("Bearer tok"),
      { SKILLPACK_API_AUTH_MODE: "hybrid", SKILLPACK_API_KEY: "k" }
    );
    expect(headers.get("authorization")).toBe("Bearer tok");
  });

  test("hybrid mode falls back to x-api-key when authorization absent", () => {
    const headers = new Headers();
    addUpstreamAuthHeaders(
      headers,
      makeRequest(null),
      { SKILLPACK_API_AUTH_MODE: "hybrid", SKILLPACK_API_KEY: "fallback-key" }
    );
    expect(headers.get("x-api-key")).toBe("fallback-key");
  });

  test("hybrid mode throws dashboard_missing_env_SKILLPACK_API_KEY when no key and no authorization", () => {
    const headers = new Headers();
    // SKILLPACK_API_KEY absent in hybrid — getOptionalEnvString returns null → throws
    expect(() =>
      addUpstreamAuthHeaders(headers, makeRequest(null), { SKILLPACK_API_AUTH_MODE: "hybrid" })
    ).toThrow("dashboard_missing_env_SKILLPACK_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// getClerkAuthorizedParties
// ---------------------------------------------------------------------------
describe("worker-auth.getClerkAuthorizedParties", () => {
  test("returns [origin] when SKILLPACK_DASHBOARD_ORIGIN is set", () => {
    expect(getClerkAuthorizedParties({ SKILLPACK_DASHBOARD_ORIGIN: "https://example.com" })).toEqual(["https://example.com"]);
  });
  test("returns undefined when SKILLPACK_DASHBOARD_ORIGIN is absent", () => {
    expect(getClerkAuthorizedParties({})).toBeUndefined();
  });
});
