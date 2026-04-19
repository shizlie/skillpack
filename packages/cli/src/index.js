import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

import { canonicalJson, signDetached, verifyLeaseToken } from "@skillpack/crypto";
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

function readJson(filePath, flagName) {
  if (!filePath) throw new Error(`missing_${flagName}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function normalizeServerUrl(serverUrl) {
  if (!serverUrl) return null;
  return serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
}

function parseIntArg(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error("invalid_integer_arg");
  return parsed;
}

function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function listFilesRecursively(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(absolute);
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function copyDirRecursively(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursively(src, dst);
      continue;
    }
    if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
}

function requireZipBinary() {
  const check = spawnSync("zip", ["-v"], { stdio: "ignore" });
  if (check.status !== 0) {
    throw new Error("missing_zip_binary");
  }
}

function zipDirectory(inputDir, outputFile) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const result = spawnSync("zip", ["-rq", outputFile, "."], {
    cwd: inputDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`zip_failed:${result.stderr?.trim() || "unknown"}`);
  }
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

async function manualAttest(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const contract = createManualTimeAttestationContract();
  const record = contract.createRecord({
    operatorId: flags["operator-id"],
    ticketId: flags["ticket-id"],
    reason: flags.reason,
    attestedAtSec: parseIntArg(flags["attested-at-sec"], undefined),
  });
  const serverUrl = normalizeServerUrl(flags["server-url"]);
  if (!serverUrl) {
    return { status: 200, body: { accepted: true, record } };
  }
  const response = await fetchImpl(
    new Request(`${serverUrl}/v1/tsa/manual-attest`, {
      method: "POST",
      body: JSON.stringify({
        customerId: flags["customer-id"],
        seatId: flags["seat-id"] ?? "default",
        operatorId: record.operatorId,
        ticketId: record.ticketId,
        reason: record.reason,
        attestedAtSec: record.attestedAtSec,
      }),
    })
  );
  return { status: response.status, body: await response.json() };
}

async function latestAttestation(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const serverUrl = normalizeServerUrl(flags["server-url"]);
  if (!serverUrl) throw new Error("missing_server_url");
  if (!flags["customer-id"]) throw new Error("missing_customer_id");
  const seatId = flags["seat-id"] ?? "default";
  const response = await fetchImpl(
    new Request(
      `${serverUrl}/v1/tsa/manual-attestations/latest?customerId=${encodeURIComponent(
        flags["customer-id"]
      )}&seatId=${encodeURIComponent(seatId)}`,
      { method: "GET" }
    )
  );
  return { status: response.status, body: await response.json() };
}

function buildBundle(commandArgs) {
  const flags = parseArgMap(commandArgs);
  const inputDir = flags["input-dir"];
  if (!inputDir) throw new Error("missing_input_dir");
  const resolvedInputDir = path.resolve(inputDir);
  if (!fs.existsSync(resolvedInputDir) || !fs.statSync(resolvedInputDir).isDirectory()) {
    throw new Error("invalid_input_dir");
  }

  requireZipBinary();
  const bundleId = flags["bundle-id"] ?? path.basename(resolvedInputDir);
  const version = flags.version ?? "0.1.0";
  const outputFile = path.resolve(
    flags["output-file"] ?? path.join("dist", `${bundleId}-${version}.mcpb`)
  );
  const licenseFile = flags["license-file"];
  const privateKeyFile = flags["private-key-file"];

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-bundle-"));
  try {
    const stagingDir = path.join(tempRoot, "staging");
    const skillDir = path.join(stagingDir, "skill");
    copyDirRecursively(resolvedInputDir, skillDir);

    const skillFiles = listFilesRecursively(skillDir).map((absolute) => {
      const relativePath = path.relative(stagingDir, absolute).split(path.sep).join("/");
      const bytes = fs.readFileSync(absolute);
      return {
        path: relativePath,
        size: bytes.length,
        sha256: sha256Hex(bytes),
      };
    });

    const manifest = {
      bundleId,
      version,
      createdAt: new Date().toISOString(),
      files: skillFiles,
    };
    const manifestJson = canonicalJson(manifest);
    fs.writeFileSync(path.join(stagingDir, "manifest.json"), `${manifestJson}\n`);
    fs.writeFileSync(
      path.join(stagingDir, "manifest.sha256"),
      `${sha256Hex(manifestJson)}\n`
    );

    if (licenseFile) {
      const license = readJson(licenseFile, "license_file");
      fs.writeFileSync(
        path.join(stagingDir, "license.json"),
        `${JSON.stringify(license, null, 2)}\n`
      );
    }

    if (privateKeyFile) {
      const privateKeyPem = readKey(privateKeyFile, "private_key_file");
      const signature = signDetached(manifestJson, privateKeyPem);
      fs.writeFileSync(path.join(stagingDir, "signature.bin"), `${signature}\n`);
    }

    zipDirectory(stagingDir, outputFile);
    return {
      status: 200,
      body: {
        bundleId,
        version,
        outputFile,
        signed: Boolean(privateKeyFile),
        embeddedLicense: Boolean(licenseFile),
        fileCount: skillFiles.length,
      },
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function runSkillpackCli(
  args,
  io = process,
  { fetchImpl = fetch } = {}
) {
  const group = args[0];
  const action = args[1];
  try {
    let result;
    if (group === "license" && action === "issue") {
      result = await issueLease(args.slice(2));
    } else if (group === "license" && action === "verify") {
      result = verifyLease(args.slice(2));
    } else if (group === "tsa" && action === "manual-attest") {
      result = await manualAttest(args.slice(2), fetchImpl);
    } else if (group === "tsa" && action === "latest-attestation") {
      result = await latestAttestation(args.slice(2), fetchImpl);
    } else if (group === "bundle" && action === "build") {
      result = buildBundle(args.slice(2));
    } else {
      io.stderr.write(
        "usage: skillpack license issue|verify ... OR skillpack tsa manual-attest|latest-attestation ... OR skillpack bundle build ...\n"
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
