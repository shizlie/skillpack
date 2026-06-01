const PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

const _compileCache = new Map();
function compilePattern(pattern) {
  const cached = _compileCache.get(pattern);
  if (cached) return cached;
  const segments = pattern.split("/");
  const compiled = segments.map((segment) => {
    const paramMatch = PARAM_RE.exec(segment);
    return paramMatch ? { kind: "param", name: paramMatch[1] } : { kind: "lit", value: segment };
  });
  const fn = (path) => {
    const actual = path.split("/");
    if (actual.length !== compiled.length) return null;
    const params = {};
    for (let i = 0; i < compiled.length; i += 1) {
      const c = compiled[i];
      if (c.kind === "lit") {
        if (c.value !== actual[i]) return null;
      } else {
        let decoded;
        try { decoded = decodeURIComponent(actual[i]); } catch { return null; }
        params[c.name] = decoded;
      }
    }
    return params;
  };
  _compileCache.set(pattern, fn);
  return fn;
}

export function matchRoute(pattern, path) {
  const compiled = compilePattern(pattern);
  const params = compiled(path);
  if (params === null) return { matches: false, params: null };
  return { matches: true, params };
}

// Body of each handler is filled in by Task 3. For now, placeholders that
// throw so the dispatcher wiring can be tested in isolation.
function placeholder(name) {
  return async () => {
    throw new Error(`route_not_implemented:${name}`);
  };
}

export const routes = [
  { method: "GET",  path: "/healthz",                                       handler: async () => ({ status: 200, body: { ok: true, service: "license-server" } }) },
  { method: "POST", path: "/v1/providers",                                  management: true, handler: placeholder("providers.create") },
  { method: "GET",  path: "/v1/providers",                                  management: true, handler: placeholder("providers.list") },
  { method: "POST", path: "/v1/providers/:providerId/customers",             management: true, handler: placeholder("customers.create") },
  { method: "GET",  path: "/v1/providers/:providerId/customers",             management: true, handler: placeholder("customers.list") },
  { method: "POST", path: "/v1/workspaces",                                 management: true, handler: placeholder("workspaces.create") },
  { method: "GET",  path: "/v1/workspaces",                                 management: true, handler: placeholder("workspaces.list") },
  { method: "POST", path: "/v1/leases/issue",                               management: true, handler: placeholder("leases.issue") },
  { method: "POST", path: "/v1/leases/verify",                                                   handler: placeholder("leases.verify") },
  { method: "POST", path: "/v1/policies/issue",                             management: true, handler: placeholder("policies.issue") },
  { method: "POST", path: "/v1/policies/sync",                              management: true, handler: placeholder("policies.sync") },
  { method: "GET",  path: "/v1/usage/summary",                              management: true, handler: placeholder("usage.summary") },
  { method: "POST", path: "/v1/billing/pricing-rules",                      management: true, handler: placeholder("billing.pricing-rules.create") },
  { method: "GET",  path: "/v1/billing/pricing-rules",                      management: true, handler: placeholder("billing.pricing-rules.list") },
  { method: "POST", path: "/v1/billing/invoices/draft",                     management: true, handler: placeholder("billing.invoices.draft") },
  { method: "GET",  path: "/v1/billing/invoices",                           management: true, handler: placeholder("billing.invoices.list") },
  { method: "GET",  path: "/v1/billing/invoices/:id",                       management: true, handler: placeholder("billing.invoices.get") },
  { method: "POST", path: "/v1/billing/invoices/:id/payment-handoff",       management: true, handler: placeholder("billing.invoices.payment-handoff") },
  { method: "POST", path: "/v1/meter/upload",                                                    handler: placeholder("meter.upload") },
  { method: "POST", path: "/v1/tsa/manual-attest",                          management: true, handler: placeholder("tsa.manual-attest") },
  { method: "GET",  path: "/v1/tsa/manual-attestations",                    management: true, handler: placeholder("tsa.manual-attestations.list") },
  { method: "GET",  path: "/v1/tsa/manual-attestations/latest",             management: true, handler: placeholder("tsa.manual-attestations.latest") },
];
