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
import { createManualTimeAttestationContract, createTsaMonitor } from "@skillpack/tsa";
import { draftInvoiceFromUsage } from "./billing.js";
import { createPaymentProviderRegistry } from "./payment-providers.js";
import { createInMemoryLeaseStore } from "./storage.js";

const DEFAULT_TTL_SEC = 30 * 24 * 60 * 60;

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

function getRequiredString(body, key, errorCode) {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(errorCode);
  }
  return value;
}

function getStoreMethod(leaseStore, methodName) {
  const method = leaseStore?.[methodName];
  if (typeof method !== "function") {
    throw new Error(`lease_store_missing_${methodName}`);
  }
  return method.bind(leaseStore);
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

function authenticateDirectMeterUpload(request, signingPublicKeyPem, nowSec) {
  const leaseToken = request.headers.get("x-skillpack-lease-token");
  if (typeof leaseToken !== "string" || leaseToken.length === 0) {
    return null;
  }
  return verifyLeaseToken(leaseToken, signingPublicKeyPem, { nowSec });
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

function getProviderIdForCustomerRoute(pathname) {
  const match = /^\/v1\/providers\/([^/]+)\/customers$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function isManagementRoute(request, pathname) {
  if (request.method === "GET" && pathname === "/v1/providers") return true;
  if (request.method === "POST" && pathname === "/v1/providers") return true;
  if (request.method === "GET" && pathname === "/v1/workspaces") return true;
  if (request.method === "POST" && pathname === "/v1/workspaces") return true;
  if (
    (request.method === "GET" || request.method === "POST") &&
    getProviderIdForCustomerRoute(pathname)
  ) {
    return true;
  }
  if (request.method === "POST" && pathname === "/v1/leases/issue") return true;
  if (request.method === "POST" && pathname === "/v1/policies/issue") return true;
  if (request.method === "POST" && pathname === "/v1/policies/sync") return true;
  if (request.method === "GET" && pathname === "/v1/usage/summary") return true;
  if (request.method === "POST" && pathname === "/v1/billing/pricing-rules") return true;
  if (request.method === "GET" && pathname === "/v1/billing/pricing-rules") return true;
  if (request.method === "POST" && pathname === "/v1/billing/invoices/draft") return true;
  if (request.method === "GET" && pathname === "/v1/billing/invoices") return true;
  if (
    request.method === "POST" &&
    /^\/v1\/billing\/invoices\/[^/]+\/payment-handoff$/.test(pathname)
  ) {
    return true;
  }
  if (request.method === "POST" && pathname === "/v1/tsa/manual-attest") return true;
  if (request.method === "GET" && pathname === "/v1/tsa/manual-attestations") return true;
  if (request.method === "GET" && pathname === "/v1/tsa/manual-attestations/latest") return true;
  return false;
}

function hasDirectLeaseCommercialField(body, key) {
  return body[key] !== undefined && body[key] !== null;
}

export function createLicenseFetchHandler({
  signingPrivateKeyPem,
  signingPublicKeyPem,
  leaseStore = createInMemoryLeaseStore(),
  tsaMonitor = createTsaMonitor(),
  attestationContract = createManualTimeAttestationContract(),
  managementApiKey = null,
  paymentProviders = createPaymentProviderRegistry(),
} = {}) {
  if (!signingPrivateKeyPem || !signingPublicKeyPem) {
    throw new Error("license_server_missing_signing_keys");
  }

  return async function fetch(request) {
    const url = new URL(request.url);
    const nowSec = Math.floor(Date.now() / 1000);

    if (isManagementRoute(request, url.pathname)) {
      if (!managementApiKey) {
        return json({ error: "management_api_key_not_configured" }, 503);
      }
      if (!isValidManagementKey(request, managementApiKey)) {
        return json({ error: "unauthorized" }, 401);
      }
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "license-server" });
    }

    if (request.method === "POST" && url.pathname === "/v1/providers") {
      try {
        const body = await readBody(request);
        const provider = validateProviderCreateContract(body);
        const saveProvider = getStoreMethod(leaseStore, "saveProvider");
        const saved = await saveProvider(provider);
        return json({ accepted: true, provider: saved });
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/providers") {
      try {
        const listProviders = getStoreMethod(leaseStore, "listProviders");
        const providers = await listProviders();
        return json({ providers });
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }

    const providerIdForCustomerRoute = getProviderIdForCustomerRoute(url.pathname);
    if (request.method === "POST" && providerIdForCustomerRoute) {
      try {
        const body = await readBody(request);
        const customer = validateCustomerCreateContract(body);
        const saveCustomer = getStoreMethod(leaseStore, "saveCustomer");
        const saved = await saveCustomer(providerIdForCustomerRoute, customer);
        return json({ accepted: true, customer: saved });
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }
    }

    if (request.method === "GET" && providerIdForCustomerRoute) {
      try {
        const listCustomers = getStoreMethod(leaseStore, "listCustomers");
        const customers = await listCustomers(providerIdForCustomerRoute);
        return json({ customers });
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/workspaces") {
      try {
        const body = await readBody(request);
        const workspace = validateWorkspaceCreateContract(body);
        const saveWorkspace = getStoreMethod(leaseStore, "saveWorkspace");
        const saved = await saveWorkspace(workspace);
        return json({ accepted: true, workspace: saved });
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/workspaces") {
      try {
        const listWorkspaces = getStoreMethod(leaseStore, "listWorkspaces");
        const workspaces = await listWorkspaces({
          providerId: url.searchParams.get("providerId") ?? undefined,
          customerId: url.searchParams.get("customerId") ?? undefined,
        });
        return json({ workspaces });
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/leases/issue") {
      try {
        const body = await readBody(request);
        const customerId = body.customerId;
        const seatId = body.seatId ?? "default";
        const vendorId = body.vendorId ?? "skillpack-vendor";
        const iat = Number.isInteger(body.nowSec) ? body.nowSec : nowSec;
        const ttlSec =
          Number.isInteger(body.ttlSec) && body.ttlSec > 0
            ? body.ttlSec
            : DEFAULT_TTL_SEC;

        if (typeof customerId !== "string" || customerId.length === 0) {
          throw new Error("issue_missing_customer_id");
        }
        const previousCounter = await leaseStore.getLatestLeaseCounter(
          customerId,
          seatId
        );
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
        const leaseToken = createLeaseToken(payload, signingPrivateKeyPem);
        await leaseStore.updateLatestLeaseCounter(customerId, seatId, nextCounter);

        let tsaState = null;
        if (Number.isInteger(body.lastTsaTokenAtSec)) {
          tsaState = tsaMonitor.evaluate({
            lastTsaTokenAtSec: body.lastTsaTokenAtSec,
            nowSec: iat,
          });
        }

        return json({ leaseToken, payload, tsaState });
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/leases/verify") {
      try {
        const body = await readBody(request);
        const verified = verifyLeaseToken(body.leaseToken, signingPublicKeyPem, {
          nowSec: Number.isInteger(body.nowSec) ? body.nowSec : nowSec,
        });
        const seatId = verified.seatId ?? "default";
        const latest = await leaseStore.getLatestLeaseCounter(verified.sub, seatId);
        if (
          Number.isInteger(latest) &&
          verified.leaseCounter < latest
        ) {
          throw new Error("lease_counter_rewind_detected");
        }
        if (!Number.isInteger(latest) || verified.leaseCounter > latest) {
          await leaseStore.updateLatestLeaseCounter(
            verified.sub,
            seatId,
            verified.leaseCounter
          );
        }
        return json({ valid: true, payload: verified });
      } catch (error) {
        return json({ valid: false, error: error.message }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/policies/issue") {
      try {
        const body = await readBody(request);
        const snapshot = validatePolicySnapshot(body.policy ?? body);
        const savePolicySnapshot = getStoreMethod(leaseStore, "savePolicySnapshot");
        const saved = await savePolicySnapshot(snapshot.workspaceId, snapshot);
        return json({ accepted: true, policy: saved });
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/policies/sync") {
      try {
        const body = await readBody(request);
        const workspaceId = getRequiredString(
          body,
          "workspaceId",
          "policy_sync_missing_workspace_id"
        );
        const policyId =
          typeof body.policyId === "string" && body.policyId.length > 0
            ? body.policyId
            : null;
        const getLatestPolicySnapshot = getStoreMethod(
          leaseStore,
          "getLatestPolicySnapshot"
        );
        const latest = await getLatestPolicySnapshot(workspaceId);
        if (!latest) {
          return json({ notModified: true });
        }
        if (policyId && latest.policyId === policyId) {
          return json({ notModified: true });
        }
        return json({ notModified: false, policy: latest });
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/meter/upload") {
      let validated;
      let mode = "management";
      let body;
      try {
        body = await readBody(request);
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }

      let directLease;
      try {
        directLease = authenticateDirectMeterUpload(request, signingPublicKeyPem, nowSec);
      } catch (error) {
        return json({ accepted: false, error: error.message }, 401);
      }

      try {
        if (directLease) {
          mode = "direct";
          validated = validateDirectMeterUploadContract(body, {
            providerId: directLease.providerId,
            customerId: directLease.sub,
            workspaceId: directLease.workspaceId,
            seatId: directLease.seatId ?? "default",
            skillId: directLease.skillId,
            bundleId: directLease.bundleId,
            leaseJti: directLease.jti,
          });
        } else {
          if (!managementApiKey) {
            return json({ error: "management_api_key_not_configured" }, 503);
          }
          if (!isValidManagementKey(request, managementApiKey)) {
            return json({ error: "unauthorized" }, 401);
          }
          validated = validateMeterUploadContract(body);
        }
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }

      try {
        const appendMeterEvents = getStoreMethod(leaseStore, "appendMeterEvents");
        await appendMeterEvents(validated.events);
        return json({
          accepted: true,
          mode,
          ack: buildMeterUploadAck(validated.events),
        });
      } catch (error) {
        // Storage failure — idempotent, safe to retry the full upload file
        return json({ accepted: false, error: "meter_batch_failed", retryable: true }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/usage/summary") {
      try {
        const getUsageSummary = getStoreMethod(leaseStore, "getUsageSummary");
        const rows = await getUsageSummary({
          providerId: url.searchParams.get("providerId") ?? undefined,
          customerId: url.searchParams.get("customerId") ?? undefined,
          workspaceId: url.searchParams.get("workspaceId") ?? undefined,
          seatId: url.searchParams.get("seatId") ?? undefined,
          skillId: url.searchParams.get("skillId") ?? undefined,
          bundleId: url.searchParams.get("bundleId") ?? undefined,
        });
        const summary = rows.map(validateAcceptedUsageSummaryRow);
        return json({ summary });
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/billing/pricing-rules") {
      try {
        const body = await readBody(request);
        const pricingRule = validatePricingRuleContract(body.pricingRule ?? body);
        const savePricingRule = getStoreMethod(leaseStore, "savePricingRule");
        const saved = await savePricingRule(pricingRule);
        return json({ accepted: true, pricingRule: saved });
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/billing/pricing-rules") {
      try {
        const listPricingRules = getStoreMethod(leaseStore, "listPricingRules");
        const pricingRules = await listPricingRules({
          providerId: url.searchParams.get("providerId") ?? undefined,
          customerId: url.searchParams.get("customerId") ?? undefined,
          workspaceId: url.searchParams.get("workspaceId") ?? undefined,
        });
        return json({ pricingRules });
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/billing/invoices/draft") {
      try {
        const body = await readBody(request);
        const draftRequest = validateInvoiceDraftRequestContract(body);
        const getAcceptedUsageEvents = getStoreMethod(leaseStore, "getAcceptedUsageEvents");
        const listPricingRules = getStoreMethod(leaseStore, "listPricingRules");
        const saveInvoice = getStoreMethod(leaseStore, "saveInvoice");
        const usageEvents = await getAcceptedUsageEvents(draftRequest);
        const pricingRules = await listPricingRules(draftRequest);
        const invoiceId = draftRequest.invoiceId ?? crypto.randomUUID();
        const invoice = draftInvoiceFromUsage({
          ...draftRequest,
          invoiceId,
          usageEvents,
          pricingRules,
        });
        const saved = await saveInvoice(invoice);
        return json({ accepted: true, invoice: saved });
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/billing/invoices") {
      try {
        const listInvoices = getStoreMethod(leaseStore, "listInvoices");
        const invoices = await listInvoices({
          providerId: url.searchParams.get("providerId") ?? undefined,
          customerId: url.searchParams.get("customerId") ?? undefined,
        });
        return json({ invoices });
      } catch (error) {
        return json({ error: error.message }, 400);
      }
    }

    const paymentHandoffMatch =
      /^\/v1\/billing\/invoices\/([^/]+)\/payment-handoff$/.exec(url.pathname);
    if (request.method === "POST" && paymentHandoffMatch) {
      try {
        const invoiceId = decodeURIComponent(paymentHandoffMatch[1]);
        const body = await readBody(request);
        const handoffRequest = validatePaymentHandoffRequestContract(body);
        const provider = paymentProviders.get(handoffRequest.provider);
        if (!provider) throw new Error(`payment_provider_not_configured:${handoffRequest.provider}`);
        const getInvoice = getStoreMethod(leaseStore, "getInvoice");
        const savePaymentHandoff = getStoreMethod(leaseStore, "savePaymentHandoff");
        const invoice = await getInvoice(invoiceId);
        if (!invoice) throw new Error("invoice_not_found");
        const paymentHandoff = await provider.createPaymentHandoff({
          invoice,
          request: handoffRequest,
        });
        const saved = await savePaymentHandoff(paymentHandoff);
        return json({ accepted: true, paymentHandoff: saved });
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/v1/tsa/manual-attest") {
      try {
        const body = await readBody(request);
        const customerId = getRequiredString(
          body,
          "customerId",
          "manual_attestation_missing_customer_id"
        );
        const seatId = body.seatId ?? "default";
        const record = attestationContract.createRecord(body);
        const storedRecord = { ...record, customerId, seatId };
        await leaseStore.addManualAttestation(storedRecord);
        return json({ accepted: true, record: storedRecord });
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/tsa/manual-attestations") {
      try {
        const listManualAttestations = getStoreMethod(
          leaseStore,
          "listManualAttestations"
        );
        const customerId = url.searchParams.get("customerId") ?? undefined;
        const seatId = url.searchParams.get("seatId") ?? undefined;
        const records = await listManualAttestations({ customerId, seatId });
        return json({ records });
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }
    }

    if (
      request.method === "GET" &&
      url.pathname === "/v1/tsa/manual-attestations/latest"
    ) {
      try {
        const customerId = url.searchParams.get("customerId");
        if (!customerId) {
          throw new Error("manual_attestation_missing_customer_id");
        }
        const seatId = url.searchParams.get("seatId") ?? "default";
        const record = await leaseStore.getLatestManualAttestation(customerId, seatId);
        return json({ accepted: true, record });
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }
    }

    return json({ error: "not_found" }, 404);
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
