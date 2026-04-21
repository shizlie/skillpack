import crypto from "node:crypto";

import {
  assertMonotonicLeaseCounter,
  createLeaseToken,
  verifyLeaseToken,
} from "@skillpack/crypto";
import {
  validateLeasePayload,
  validateMeterEvent,
  validatePolicySnapshot,
} from "@skillpack/protocol";
import { createManualTimeAttestationContract, createTsaMonitor } from "@skillpack/tsa";
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

function isManagementRoute(request, pathname) {
  if (request.method === "POST" && pathname === "/v1/policies/issue") return true;
  if (request.method === "POST" && pathname === "/v1/policies/sync") return true;
  if (request.method === "POST" && pathname === "/v1/meter/upload") return true;
  if (request.method === "GET" && pathname === "/v1/usage/summary") return true;
  return false;
}

export function createLicenseFetchHandler({
  signingPrivateKeyPem,
  signingPublicKeyPem,
  leaseStore = createInMemoryLeaseStore(),
  tsaMonitor = createTsaMonitor(),
  attestationContract = createManualTimeAttestationContract(),
  managementApiKey = null,
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
      const providedApiKey = readApiKey(request);
      if (providedApiKey !== managementApiKey) {
        return json({ error: "unauthorized" }, 401);
      }
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "license-server" });
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
        const previousCounter = leaseStore.getLatestLeaseCounter(
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
        };
        validateLeasePayload(payload);
        const leaseToken = createLeaseToken(payload, signingPrivateKeyPem);
        leaseStore.updateLatestLeaseCounter(customerId, seatId, nextCounter);

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
        const latest = leaseStore.getLatestLeaseCounter(verified.sub, seatId);
        if (
          Number.isInteger(latest) &&
          verified.leaseCounter < latest
        ) {
          throw new Error("lease_counter_rewind_detected");
        }
        if (!Number.isInteger(latest) || verified.leaseCounter > latest) {
          leaseStore.updateLatestLeaseCounter(
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
        const saved = savePolicySnapshot(snapshot.workspaceId, snapshot);
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
        const latest = getLatestPolicySnapshot(workspaceId);
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
      try {
        const body = await readBody(request);
        const workspaceId = getRequiredString(
          body,
          "workspaceId",
          "meter_upload_missing_workspace_id"
        );
        if (!Array.isArray(body.events)) {
          throw new Error("meter_upload_missing_events");
        }
        const validated = body.events.map((event) => {
          validateMeterEvent(event);
          if (typeof event.seatId !== "string" || event.seatId.length === 0) {
            throw new Error("meter_event_invalid_seat_id");
          }
          if (typeof event.tool !== "string" || event.tool.length === 0) {
            throw new Error("meter_event_invalid_tool");
          }
          const usage = event.usage ?? { unit: event.unit, delta: event.delta };
          if (usage?.unit !== "tool_call") {
            throw new Error("meter_event_invalid_usage_unit");
          }
          if (!Number.isFinite(usage?.delta) || usage.delta <= 0) {
            throw new Error("meter_event_invalid_usage_delta");
          }
          return { ...event, usage };
        });

        const appendMeterEvents = getStoreMethod(leaseStore, "appendMeterEvents");
        appendMeterEvents(workspaceId, validated);

        let seqStart = null;
        let seqEnd = null;
        for (const event of validated) {
          if (!Number.isInteger(event.seq)) continue;
          if (seqStart === null || event.seq < seqStart) seqStart = event.seq;
          if (seqEnd === null || event.seq > seqEnd) seqEnd = event.seq;
        }
        return json({
          accepted: true,
          ack: {
            count: validated.length,
            range: seqStart === null ? null : { seqStart, seqEnd },
          },
        });
      } catch (error) {
        return json({ accepted: false, error: error.message }, 400);
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/usage/summary") {
      try {
        const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
        const getUsageSummary = getStoreMethod(leaseStore, "getUsageSummary");
        const summary = getUsageSummary({ workspaceId });
        return json({ summary });
      } catch (error) {
        return json({ error: error.message }, 400);
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
        leaseStore.addManualAttestation(storedRecord);
        return json({ accepted: true, record: storedRecord });
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
        const record = leaseStore.getLatestManualAttestation(customerId, seatId);
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
    process.env.SKILLPACK_MANAGEMENT_API_KEY ??
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
