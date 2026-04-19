import fs from "node:fs";

import { verifyLeaseToken } from "@skillpack/crypto";
import { createLicenseFetchHandler } from "@skillpack/license-server";
import { createManualTimeAttestationContract } from "@skillpack/tsa";

function parseArgMap(args) {
  const map = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      map[key] = true;
      continue;
    }
    map[key] = next;
    i += 1;
  }
  return map;
}

function readKey(filePath, flagName) {
  if (!filePath) throw new Error(`missing_${flagName}`);
  return fs.readFileSync(filePath, "utf8");
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function parseIntArg(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error("invalid_integer_arg");
  return parsed;
}

async function issueLease(commandArgs) {
  const flags = parseArgMap(commandArgs);
  const privateKeyPem = readKey(flags["private-key-file"], "private_key_file");
  const publicKeyPem = readKey(flags["public-key-file"], "public_key_file");
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: privateKeyPem,
    signingPublicKeyPem: publicKeyPem,
  });

  const body = {
    customerId: flags["customer-id"],
    seatId: flags["seat-id"] ?? "default",
    vendorId: flags["vendor-id"] ?? "skillpack-vendor",
    ttlSec: parseIntArg(flags["ttl-sec"], undefined),
    nowSec: parseIntArg(flags["now-sec"], nowSec()),
    lastTsaTokenAtSec: parseIntArg(flags["last-tsa-token-at-sec"], undefined),
  };

  const response = await fetch(
    new Request("http://local/v1/leases/issue", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
  return { status: response.status, body: await response.json() };
}

function verifyLease(commandArgs) {
  const flags = parseArgMap(commandArgs);
  const publicKeyPem = readKey(flags["public-key-file"], "public_key_file");
  if (!flags["lease-token"]) throw new Error("missing_lease_token");
  const payload = verifyLeaseToken(flags["lease-token"], publicKeyPem, {
    nowSec: parseIntArg(flags["now-sec"], nowSec()),
  });
  return { status: 200, body: { valid: true, payload } };
}

function manualAttest(commandArgs) {
  const flags = parseArgMap(commandArgs);
  const contract = createManualTimeAttestationContract();
  const record = contract.createRecord({
    operatorId: flags["operator-id"],
    ticketId: flags["ticket-id"],
    reason: flags.reason,
    attestedAtSec: parseIntArg(flags["attested-at-sec"], undefined),
  });
  return { status: 200, body: { accepted: true, record } };
}

export async function runSkillpackCli(args, io = process) {
  const group = args[0];
  const action = args[1];
  try {
    let result;
    if (group === "license" && action === "issue") {
      result = await issueLease(args.slice(2));
    } else if (group === "license" && action === "verify") {
      result = verifyLease(args.slice(2));
    } else if (group === "tsa" && action === "manual-attest") {
      result = manualAttest(args.slice(2));
    } else {
      io.stderr.write(
        "usage: skillpack license issue|verify ... OR skillpack tsa manual-attest ...\n"
      );
      return 2;
    }

    if (result.status >= 400) {
      io.stderr.write(`${JSON.stringify(result.body)}\n`);
      return 1;
    }
    io.stdout.write(`${JSON.stringify(result.body)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    return 1;
  }
}
