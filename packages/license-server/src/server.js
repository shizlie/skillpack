import crypto from "node:crypto";

import {
  assertMonotonicLeaseCounter,
  createLeaseToken,
  verifyLeaseToken,
} from "@skillpack/crypto";
import { validateLeasePayload } from "@skillpack/protocol";
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

export function createLicenseFetchHandler({
  signingPrivateKeyPem,
  signingPublicKeyPem,
  leaseStore = createInMemoryLeaseStore(),
  tsaMonitor = createTsaMonitor(),
  attestationContract = createManualTimeAttestationContract(),
} = {}) {
  if (!signingPrivateKeyPem || !signingPublicKeyPem) {
    throw new Error("license_server_missing_signing_keys");
  }

  return async function fetch(request) {
    const url = new URL(request.url);
    const nowSec = Math.floor(Date.now() / 1000);

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
  if (!options?.leaseStore && storageMode === "sqlite") {
    throw new Error("license_server_sqlite_store_not_injected");
  }
  const fetch = createLicenseFetchHandler({ ...options, leaseStore });
  const port = options?.port ?? 3001;
  return Bun.serve({ port, fetch });
}
