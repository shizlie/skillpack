import crypto from "node:crypto";

import {
  assertMonotonicLeaseCounter,
  createLeaseToken,
  verifyLeaseToken,
} from "@skillpack/crypto";
import {
  validateAcceptedUsageSummaryRow,
  validateCustomerCreateContract,
  validateDirectLeaseCommercialContext,
  validateDirectMeterUploadContract,
  validateLeasePayload,
  validateMeterUploadContract,
  validateInvoiceDraftRequestContract,
  validatePaymentHandoffRequestContract,
  validatePricingRuleContract,
  validatePolicySnapshot,
  validateProviderCreateContract,
  validateWorkspaceCreateContract,
} from "@skillpack/protocol";
import { draftInvoiceFromUsage } from "./billing.js";
import { verifyManagementKey } from "./auth.js";

const DEFAULT_TTL_SEC = 30 * 24 * 60 * 60;
const DEFAULT_MANUAL_ATTESTATION_MAX_AGE_SEC = 4 * 60 * 60;

// --- Dispatch wrapper ---

/**
 * Wraps a handler so its try/catch envelope is centralized. The handler
 * returns `{ status?, body }` (or just `{ body }` for the common 200 case);
 * the wrapper converts thrown errors into `{ status: 400, body: errorEnvelope(error.message) }`.
 *
 * Handlers with non-uniform error paths (e.g. uploadMeter's 401/400/500
 * triple, getInvoice's explicit 404) keep their own try/catch and skip
 * this wrapper. Handlers that need a different error body shape (e.g.
 * verifyLease returns `{ valid: false, error }`) pass a custom envelope.
 */
function dispatch(handler, { errorEnvelope = (msg) => ({ error: msg }) } = {}) {
  return async (ctx) => {
    try {
	return await handler(ctx);
    } catch (error) {
	return { status: 400, body: errorEnvelope(error.message) };
    }
  };
}

// --- Pure helpers ---

function getRequiredString(body, key, errorCode) {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(errorCode);
  return value;
}

function hasDirectLeaseCommercialField(body, key) {
  return body[key] !== undefined && body[key] !== null;
}

function parsePositiveInteger(value, errorCode) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(errorCode);
  return value;
}

function buildMeterUploadAck(events) {
  let seqStart = null;
  let seqEnd = null;
  for (const event of events) {
    if (!Number.isInteger(event.eventSeq)) continue;
    if (seqStart === null || event.eventSeq < seqStart) seqStart = event.eventSeq;
    if (seqEnd === null || event.eventSeq > seqEnd) seqEnd = event.eventSeq;
  }
  return {
    count: events.length,
    range: seqStart === null ? null : { seqStart, seqEnd },
  };
}

// --- Auth helpers (used by meter.upload dual-auth) ---

/**
 * Returns the verified lease payload from x-skillpack-lease-token, or null if absent.
 * Throws if the token is present but fails verification.
 */
function tryDirectLeaseAuth(request, signingPublicKeyPem, nowSec) {
  const leaseToken = request.headers.get("x-skillpack-lease-token");
  if (typeof leaseToken !== "string" || leaseToken.length === 0) return null;
  return verifyLeaseToken(leaseToken, signingPublicKeyPem, { nowSec });
}

/**
 * Management auth check for the meter.upload handler's fallback path.
 * Returns { status, body } on failure, null on success.
 */
async function checkManagementAuth(ctx) {
  return verifyManagementKey(ctx.request, {
    managementApiKey: ctx.managementApiKey,
    managementAuthenticator: ctx.managementAuthenticator,
  });
}

// --- Path matcher ---

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

// --- Route handlers ---

async function createProvider(ctx) {
  const provider = validateProviderCreateContract(ctx.body);
  const saved = await ctx.store.saveProvider(provider);
  return { body: { accepted: true, provider: saved } };
}

async function listProviders(ctx) {
  const providers = await ctx.store.listProviders();
  return { body: { providers } };
}

async function createCustomer(ctx) {
  const customer = validateCustomerCreateContract(ctx.body);
  const saved = await ctx.store.saveCustomer(ctx.params.providerId, customer);
  return { body: { accepted: true, customer: saved } };
}

async function listCustomers(ctx) {
  const customers = await ctx.store.listCustomers(ctx.params.providerId);
  return { body: { customers } };
}

async function createWorkspace(ctx) {
  const workspace = validateWorkspaceCreateContract(ctx.body);
  const saved = await ctx.store.saveWorkspace(workspace);
  return { body: { accepted: true, workspace: saved } };
}

async function listWorkspaces(ctx) {
  const workspaces = await ctx.store.listWorkspaces({
    providerId: ctx.url.searchParams.get("providerId") ?? undefined,
    customerId: ctx.url.searchParams.get("customerId") ?? undefined,
  });
  return { body: { workspaces } };
}

async function issueLease(ctx) {
  const body = ctx.body;
  const customerId = body.customerId;
  const seatId = body.seatId ?? "default";
  const vendorId = body.vendorId ?? "skillpack-vendor";
  const iat = Number.isInteger(body.nowSec) ? body.nowSec : ctx.nowSec;
  const ttlSec =
    Number.isInteger(body.ttlSec) && body.ttlSec > 0 ? body.ttlSec : DEFAULT_TTL_SEC;

  if (typeof customerId !== "string" || customerId.length === 0) {
    throw new Error("issue_missing_customer_id");
  }
  const previousCounter = await ctx.store.getLatestLeaseCounter(customerId, seatId);
  const nextCounter =
    Number.isInteger(previousCounter) && previousCounter >= 0
      ? previousCounter + 1
      : 0;
  assertMonotonicLeaseCounter(previousCounter, nextCounter);

  const payload = {
    iss: vendorId,
    sub: customerId,
    seatId,
    iat,
    exp: iat + ttlSec,
    jti: crypto.randomUUID(),
    leaseCounter: nextCounter,
    providerId: body.providerId,
    workspaceId: body.workspaceId,
    skillId: body.skillId,
    bundleId: body.bundleId,
  };
  validateLeasePayload(payload);
  const hasDirectCommercialContext =
    hasDirectLeaseCommercialField(body, "providerId") ||
    hasDirectLeaseCommercialField(body, "workspaceId") ||
    hasDirectLeaseCommercialField(body, "skillId") ||
    hasDirectLeaseCommercialField(body, "bundleId");
  if (hasDirectCommercialContext) {
    validateDirectLeaseCommercialContext(payload);
  }
  const leaseToken = createLeaseToken(payload, ctx.signingPrivateKeyPem);
  await ctx.store.updateLatestLeaseCounter(customerId, seatId, nextCounter);

  let tsaState = null;
  if (Number.isInteger(body.lastTsaTokenAtSec)) {
    const evaluated = ctx.tsaMonitor.evaluate({
      lastTsaTokenAtSec: body.lastTsaTokenAtSec,
      nowSec: iat,
    });
    tsaState = { ...evaluated, lastTsaTokenAtSec: body.lastTsaTokenAtSec };
    if (tsaState.status === "warning" || tsaState.status === "expired") {
      const maxManualAttestationAgeSec =
        parsePositiveInteger(
          body.maxManualAttestationAgeSec,
          "issue_invalid_max_manual_attestation_age"
        ) ?? DEFAULT_MANUAL_ATTESTATION_MAX_AGE_SEC;
      const ticketId = body.tsaTicketId ?? body.ticketId;
      const latestManualAttestation =
        typeof ticketId === "string" && ticketId.length > 0
          ? await ctx.store.getLatestManualAttestation(customerId, seatId, { ticketId })
          : null;
      tsaState = { ...tsaState, latestManualAttestation, maxManualAttestationAgeSec };
    }
  }

  return { body: { leaseToken, payload, tsaState } };
}

async function verifyLease(ctx) {
  const body = ctx.body;
  const verified = verifyLeaseToken(body.leaseToken, ctx.signingPublicKeyPem, {
    nowSec: Number.isInteger(body.nowSec) ? body.nowSec : ctx.nowSec,
  });
  const seatId = verified.seatId ?? "default";
  const latest = await ctx.store.getLatestLeaseCounter(verified.sub, seatId);
  if (Number.isInteger(latest) && verified.leaseCounter < latest) {
    throw new Error("lease_counter_rewind_detected");
  }
  if (!Number.isInteger(latest) || verified.leaseCounter > latest) {
    await ctx.store.updateLatestLeaseCounter(verified.sub, seatId, verified.leaseCounter);
  }
  return { body: { valid: true, payload: verified } };
}

async function issuePolicy(ctx) {
  const body = ctx.body;
  const snapshot = validatePolicySnapshot(body.policy ?? body);
  const saved = await ctx.store.savePolicySnapshot(snapshot.workspaceId, snapshot);
  return { body: { accepted: true, policy: saved } };
}

async function syncPolicy(ctx) {
  const body = ctx.body;
  const workspaceId = getRequiredString(body, "workspaceId", "policy_sync_missing_workspace_id");
  const policyId =
    typeof body.policyId === "string" && body.policyId.length > 0 ? body.policyId : null;
  const latest = await ctx.store.getLatestPolicySnapshot(workspaceId);
  if (!latest) return { body: { notModified: true } };
  if (policyId && latest.policyId === policyId) return { body: { notModified: true } };
  return { body: { notModified: false, policy: latest } };
}
async function uploadMeter(ctx) {
  // 1. Try direct lease auth via x-skillpack-lease-token header.
  let directLease;
  try {
    directLease = tryDirectLeaseAuth(ctx.request, ctx.signingPublicKeyPem, ctx.nowSec);
  } catch (error) {
    return { status: 401, body: { accepted: false, error: error.message } };
  }

  // 2. Validate payload (and fall back to management auth if no direct lease).
  let validated;
  let mode = "management";
  try {
    if (directLease) {
      mode = "direct";
      validated = validateDirectMeterUploadContract(ctx.body, {
        providerId: directLease.providerId,
        customerId: directLease.sub,
        workspaceId: directLease.workspaceId,
        seatId: directLease.seatId ?? "default",
        skillId: directLease.skillId,
        bundleId: directLease.bundleId,
        leaseJti: directLease.jti,
      });
    } else {
      const authFail = await checkManagementAuth(ctx);
      if (authFail) return authFail;
      validated = validateMeterUploadContract(ctx.body);
    }
  } catch (error) {
    return { status: 400, body: { accepted: false, error: error.message } };
  }

  // 3. Persist events.
  try {
    await ctx.store.appendMeterEvents(validated.events);
    return { body: { accepted: true, mode, ack: buildMeterUploadAck(validated.events) } };
  } catch {
    return { status: 500, body: { accepted: false, error: "meter_batch_failed", retryable: true } };
  }
}

async function getUsageSummary(ctx) {
  const rows = await ctx.store.getUsageSummary({
    providerId: ctx.url.searchParams.get("providerId") ?? undefined,
    customerId: ctx.url.searchParams.get("customerId") ?? undefined,
    workspaceId: ctx.url.searchParams.get("workspaceId") ?? undefined,
    seatId: ctx.url.searchParams.get("seatId") ?? undefined,
    skillId: ctx.url.searchParams.get("skillId") ?? undefined,
    bundleId: ctx.url.searchParams.get("bundleId") ?? undefined,
  });
  const summary = rows.map(validateAcceptedUsageSummaryRow);
  return { body: { summary } };
}

async function createPricingRule(ctx) {
  const pricingRule = validatePricingRuleContract(ctx.body.pricingRule ?? ctx.body);
  const saved = await ctx.store.savePricingRule(pricingRule);
  return { body: { accepted: true, pricingRule: saved } };
}

async function listPricingRules(ctx) {
  const pricingRules = await ctx.store.listPricingRules({
    providerId: ctx.url.searchParams.get("providerId") ?? undefined,
    customerId: ctx.url.searchParams.get("customerId") ?? undefined,
    workspaceId: ctx.url.searchParams.get("workspaceId") ?? undefined,
  });
  return { body: { pricingRules } };
}

async function draftInvoice(ctx) {
  const draftRequest = validateInvoiceDraftRequestContract(ctx.body);
  const usageEvents = await ctx.store.getAcceptedUsageEvents(draftRequest);
  const pricingRules = await ctx.store.listPricingRules(draftRequest);
  const invoiceId = draftRequest.invoiceId ?? crypto.randomUUID();
  const invoice = draftInvoiceFromUsage({
    ...draftRequest,
    invoiceId,
    usageEvents,
    pricingRules,
  });
  const saved = await ctx.store.saveInvoice(invoice);
  return { body: { accepted: true, invoice: saved } };
}

async function listInvoices(ctx) {
  const invoices = await ctx.store.listInvoices({
    providerId: ctx.url.searchParams.get("providerId") ?? undefined,
    customerId: ctx.url.searchParams.get("customerId") ?? undefined,
  });
  return { body: { invoices } };
}

async function getInvoice(ctx) {
  const invoice = await ctx.store.getInvoice(ctx.params.id);
  if (!invoice) {
    return { status: 404, body: { error: "invoice_not_found" } };
  }
  return { body: { invoice } };
}

async function createPaymentHandoff(ctx) {
  const invoiceId = ctx.params.id;
  const handoffRequest = validatePaymentHandoffRequestContract(ctx.body);
  const provider = ctx.providers.get(handoffRequest.provider);
  if (!provider) {
    throw new Error(`payment_provider_not_configured:${handoffRequest.provider}`);
  }
  const invoice = await ctx.store.getInvoice(invoiceId);
  if (!invoice) throw new Error("invoice_not_found");
  const paymentHandoff = await provider.createPaymentHandoff({ invoice, request: handoffRequest });
  const saved = await ctx.store.savePaymentHandoff(paymentHandoff);
  return { body: { accepted: true, paymentHandoff: saved } };
}

async function manualAttest(ctx) {
  const body = ctx.body;
  const customerId = getRequiredString(
    body,
    "customerId",
    "manual_attestation_missing_customer_id"
  );
  const seatId = body.seatId ?? "default";
  const record = ctx.attestationContract.createRecord(body);
  const storedRecord = { ...record, customerId, seatId };
  await ctx.store.addManualAttestation(storedRecord);
  return { body: { accepted: true, record: storedRecord } };
}

async function listManualAttestations(ctx) {
  const customerId = ctx.url.searchParams.get("customerId") ?? undefined;
  const seatId = ctx.url.searchParams.get("seatId") ?? undefined;
  const records = await ctx.store.listManualAttestations({ customerId, seatId });
  return { body: { records } };
}

async function getLatestManualAttestation(ctx) {
  const customerId = ctx.url.searchParams.get("customerId");
  if (!customerId) throw new Error("manual_attestation_missing_customer_id");
  const seatId = ctx.url.searchParams.get("seatId") ?? "default";
  const ticketId = ctx.url.searchParams.get("ticketId") ?? undefined;
  const record = await ctx.store.getLatestManualAttestation(customerId, seatId, { ticketId });
  return { body: { accepted: true, record } };
}


export const routes = [
  { method: "GET",  path: "/healthz",                                        handler: async () => ({ body: { ok: true, service: "license-server" } }) },
  { method: "POST", path: "/v1/providers",                                   management: true, handler: dispatch(createProvider) },
  { method: "GET",  path: "/v1/providers",                                   management: true, handler: dispatch(listProviders) },
  { method: "POST", path: "/v1/providers/:providerId/customers",              management: true, handler: dispatch(createCustomer) },
  { method: "GET",  path: "/v1/providers/:providerId/customers",              management: true, handler: dispatch(listCustomers) },
  { method: "POST", path: "/v1/workspaces",                                  management: true, handler: dispatch(createWorkspace) },
  { method: "GET",  path: "/v1/workspaces",                                  management: true, handler: dispatch(listWorkspaces) },
  { method: "POST", path: "/v1/leases/issue",                                management: true, handler: dispatch(issueLease) },
  { method: "POST", path: "/v1/leases/verify",                                                 handler: dispatch(verifyLease, { errorEnvelope: (msg) => ({ valid: false, error: msg }) }) },
  { method: "POST", path: "/v1/policies/issue",                              management: true, handler: dispatch(issuePolicy) },
  { method: "POST", path: "/v1/policies/sync",                               management: true, handler: dispatch(syncPolicy) },
  { method: "GET",  path: "/v1/usage/summary",                               management: true, handler: dispatch(getUsageSummary) },
  { method: "POST", path: "/v1/billing/pricing-rules",                       management: true, handler: dispatch(createPricingRule) },
  { method: "GET",  path: "/v1/billing/pricing-rules",                       management: true, handler: dispatch(listPricingRules) },
  { method: "POST", path: "/v1/billing/invoices/draft",                      management: true, handler: dispatch(draftInvoice) },
  { method: "GET",  path: "/v1/billing/invoices",                            management: true, handler: dispatch(listInvoices) },
  { method: "GET",  path: "/v1/billing/invoices/:id",                        management: true, handler: getInvoice },
  { method: "POST", path: "/v1/billing/invoices/:id/payment-handoff",        management: true, handler: dispatch(createPaymentHandoff) },
  { method: "POST", path: "/v1/meter/upload",                                                  handler: uploadMeter },
  { method: "POST", path: "/v1/tsa/manual-attest",                           management: true, handler: dispatch(manualAttest) },
  { method: "GET",  path: "/v1/tsa/manual-attestations",                     management: true, handler: dispatch(listManualAttestations) },
  { method: "GET",  path: "/v1/tsa/manual-attestations/latest",              management: true, handler: dispatch(getLatestManualAttestation) },
];
