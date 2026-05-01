import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

import { canonicalJson, signDetached, verifyLeaseToken } from "@skillpack/crypto";
import { createLicenseFetchHandler } from "@skillpack/core";
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

function requireServerUrl(flags) {
  const serverUrl = normalizeServerUrl(flags["server-url"]);
  if (!serverUrl) throw new Error("missing_server_url");
  return serverUrl;
}

function buildServerHeaders(flags) {
  const apiKey = flags["api-key"];
  return apiKey ? { "x-api-key": apiKey } : undefined;
}

function parseJsonLines(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadMeterEvents(filePath) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error("missing_events_file");
  const raw = fs.readFileSync(absolute, "utf8");
  if (!raw.trim()) return [];

  if (absolute.endsWith(".jsonl")) {
    return parseJsonLines(absolute);
  }

  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.events)) return parsed.events;
  throw new Error("meter_events_file_invalid_shape");
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

async function issueLease(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const body = {
    customerId: flags["customer-id"],
    seatId: flags["seat-id"] ?? "default",
    vendorId: flags["vendor-id"] ?? "skillpack-vendor",
    ttlSec: parseIntArg(flags["ttl-sec"], undefined),
    nowSec: parseIntArg(flags["now-sec"], nowSec()),
    lastTsaTokenAtSec: parseIntArg(flags["last-tsa-token-at-sec"], undefined),
    tsaTicketId: flags["tsa-ticket-id"] ?? flags["ticket-id"],
    maxManualAttestationAgeSec: parseIntArg(
      flags["max-manual-attestation-age-sec"],
      undefined
    ),
  };

  const serverUrl = normalizeServerUrl(flags["server-url"]);
  let response;
  if (serverUrl) {
    response = await fetchImpl(
      new Request(`${serverUrl}/v1/leases/issue`, {
        method: "POST",
        headers: buildServerHeaders(flags),
        body: JSON.stringify(body),
      })
    );
  } else {
    const privateKeyPem = readKey(flags["private-key-file"], "private_key_file");
    const publicKeyPem = readKey(flags["public-key-file"], "public_key_file");
    // Internal key for local signing — the private key is the real credential here.
    const localKey = "cli-local-signing";
    const fetch = createLicenseFetchHandler({
      signingPrivateKeyPem: privateKeyPem,
      signingPublicKeyPem: publicKeyPem,
      managementApiKey: localKey,
    });
    response = await fetch(
      new Request("http://local/v1/leases/issue", {
        method: "POST",
        headers: { "x-api-key": localKey },
        body: JSON.stringify(body),
      })
    );
  }
  const bodyJson = await response.json();
  const stderr =
    bodyJson.tsaState?.status === "warning" || bodyJson.tsaState?.status === "expired"
      ? [
          `[skillpack] WARNING: TSA token ${bodyJson.tsaState.status}.`,
          "  Run incident workflow: docs/runbooks/tsa-outage.md",
          "  Manual attestation:",
          "    skillpack tsa manual-attest --server-url <license-server-url> --customer-id <customerId> --seat-id <seatId> --operator-id <operatorId> --ticket-id <ticketId> --reason \"<incident reason>\" --attested-at-sec <unix-sec>",
        ].join("\n") + "\n"
      : "";
  return { status: response.status, body: bodyJson, stderr };
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
  const headers = buildServerHeaders(flags);
  const response = await fetchImpl(
    new Request(`${serverUrl}/v1/tsa/manual-attest`, {
      method: "POST",
      headers,
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
  const headers = buildServerHeaders(flags);
  const ticketParam = flags["ticket-id"]
    ? `&ticketId=${encodeURIComponent(flags["ticket-id"])}`
    : "";
  const response = await fetchImpl(
    new Request(
      `${serverUrl}/v1/tsa/manual-attestations/latest?customerId=${encodeURIComponent(
        flags["customer-id"]
      )}&seatId=${encodeURIComponent(seatId)}${ticketParam}`,
      { method: "GET", headers }
    )
  );
  return { status: response.status, body: await response.json() };
}

function buildPolicyFromFlags(flags) {
  const now = parseIntArg(flags["now-sec"], nowSec());
  const startsAtSec = parseIntArg(flags["starts-at-sec"], now);
  const expiresAtSec = parseIntArg(flags["expires-at-sec"], now + 3600);
  const graceUntilSec = parseIntArg(flags["grace-until-sec"], expiresAtSec + 3600);
  const seatId = flags["seat-id"] ?? "default";

  return {
    policyVersion: 1,
    policyId: flags["policy-id"] ?? `policy-${now}`,
    workspaceId: flags["workspace-id"],
    workspacePolicy: {
      mode: flags["workspace-mode"] ?? "ENABLED",
    },
    seatPolicy: {
      defaultMode: flags["seat-default-mode"] ?? "ENABLED",
      seats: {
        [seatId]: { mode: flags["seat-mode"] ?? "ENABLED" },
      },
    },
    usagePolicy: {
      unit: "tool_call",
      thresholds: {
        warningPct: parseIntArg(flags["warning-pct"], 100),
        hardStopPct: parseIntArg(flags["hard-stop-pct"], 120),
      },
      toolBudgets: {
        wiki_search: parseIntArg(flags["budget-wiki-search"], 5),
      },
    },
    timePolicy: {
      workspace: { startsAtSec, expiresAtSec, graceUntilSec },
      seatOverrides: {
        [seatId]: { startsAtSec, expiresAtSec, graceUntilSec },
      },
    },
  };
}

async function issuePolicy(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const serverUrl = requireServerUrl(flags);
  const headers = buildServerHeaders(flags);
  const policy = flags["policy-file"]
    ? readJson(flags["policy-file"], "policy_file")
    : buildPolicyFromFlags(flags);
  const response = await fetchImpl(
    new Request(`${serverUrl}/v1/policies/issue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ policy }),
    })
  );
  return { status: response.status, body: await response.json() };
}

async function createProvider(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const serverUrl = requireServerUrl(flags);
  const headers = buildServerHeaders(flags);
  if (!flags["provider-id"]) throw new Error("missing_provider_id");
  const response = await fetchImpl(
    new Request(`${serverUrl}/v1/providers`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: flags["provider-id"],
        name: flags.name,
      }),
    })
  );
  return { status: response.status, body: await response.json() };
}

async function createCustomer(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const serverUrl = requireServerUrl(flags);
  const headers = buildServerHeaders(flags);
  if (!flags["provider-id"]) throw new Error("missing_provider_id");
  if (!flags["customer-id"]) throw new Error("missing_customer_id");
  const response = await fetchImpl(
    new Request(
      `${serverUrl}/v1/providers/${encodeURIComponent(flags["provider-id"])}/customers`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          customerId: flags["customer-id"],
          name: flags.name,
        }),
      }
    )
  );
  return { status: response.status, body: await response.json() };
}

async function createWorkspace(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const serverUrl = requireServerUrl(flags);
  const headers = buildServerHeaders(flags);
  if (!flags["workspace-id"]) throw new Error("missing_workspace_id");
  if (!flags["provider-id"]) throw new Error("missing_provider_id");
  if (!flags["customer-id"]) throw new Error("missing_customer_id");
  const response = await fetchImpl(
    new Request(`${serverUrl}/v1/workspaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: flags["workspace-id"],
        providerId: flags["provider-id"],
        customerId: flags["customer-id"],
        name: flags.name,
        status: flags.status,
      }),
    })
  );
  return { status: response.status, body: await response.json() };
}

async function syncPolicy(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const serverUrl = requireServerUrl(flags);
  const headers = buildServerHeaders(flags);
  if (!flags["workspace-id"]) throw new Error("missing_workspace_id");
  const response = await fetchImpl(
    new Request(`${serverUrl}/v1/policies/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: flags["workspace-id"],
        policyId: flags["policy-id"],
      }),
    })
  );
  return { status: response.status, body: await response.json() };
}

async function uploadMeter(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const serverUrl = requireServerUrl(flags);
  const headers = buildServerHeaders(flags);
  if (!flags["workspace-id"]) throw new Error("missing_workspace_id");
  const filePath = flags.file ?? flags["events-file"];
  if (!filePath) throw new Error("missing_file");
  const events = loadMeterEvents(filePath);
  const context = {
    providerId: flags["provider-id"],
    customerId: flags["customer-id"],
    workspaceId: flags["workspace-id"],
    seatId: flags["seat-id"],
    skillId: flags["skill-id"],
    bundleId: flags["bundle-id"],
    leaseId: flags["lease-id"],
    leaseJti: flags["lease-jti"],
    policyId: flags["policy-id"],
  };
  const normalizedContext = Object.fromEntries(
    Object.entries(context).filter(([, value]) => typeof value === "string" && value.length > 0)
  );
  const response = await fetchImpl(
    new Request(`${serverUrl}/v1/meter/upload`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: flags["workspace-id"],
        ...(Object.keys(normalizedContext).length > 0 ? { context: normalizedContext } : {}),
        events,
      }),
    })
  );
  return { status: response.status, body: await response.json() };
}

async function usageSummary(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const serverUrl = requireServerUrl(flags);
  const headers = buildServerHeaders(flags);
  const url = new URL(`${serverUrl}/v1/usage/summary`);
  const filters = {
    providerId: flags["provider-id"],
    customerId: flags["customer-id"],
    workspaceId: flags["workspace-id"],
    seatId: flags["seat-id"],
    skillId: flags["skill-id"],
    bundleId: flags["bundle-id"],
  };
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value.length > 0) {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetchImpl(
    new Request(url.toString(), {
      method: "GET",
      headers,
    })
  );
  return { status: response.status, body: await response.json() };
}

async function createPricingRule(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const serverUrl = requireServerUrl(flags);
  const headers = buildServerHeaders(flags);
  if (!flags["pricing-rule-id"]) throw new Error("missing_pricing_rule_id");
  if (!flags["provider-id"]) throw new Error("missing_provider_id");
  if (!flags.currency) throw new Error("missing_currency");
  const unitAmountCents = parseIntArg(flags["unit-amount-cents"], null);
  if (unitAmountCents === null) throw new Error("missing_unit_amount_cents");
  const paymentProvider =
    flags["payment-provider"] || flags["payment-product-id"] || flags["payment-price-id"]
      ? {
          provider: flags["payment-provider"] ?? "manual",
          productId: flags["payment-product-id"],
          priceId: flags["payment-price-id"],
        }
      : undefined;
  const response = await fetchImpl(
    new Request(`${serverUrl}/v1/billing/pricing-rules`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        pricingRuleId: flags["pricing-rule-id"],
        providerId: flags["provider-id"],
        customerId: flags["customer-id"],
        workspaceId: flags["workspace-id"],
        skillId: flags["skill-id"],
        bundleId: flags["bundle-id"],
        tool: flags.tool,
        currency: flags.currency,
        unitAmountCents,
        includedUnits: parseIntArg(flags["included-units"], undefined),
        minimumAmountCents: parseIntArg(flags["minimum-amount-cents"], undefined),
        status: flags.status,
        paymentProvider,
      }),
    })
  );
  return { status: response.status, body: await response.json() };
}

async function draftInvoice(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const serverUrl = requireServerUrl(flags);
  const headers = buildServerHeaders(flags);
  if (!flags["provider-id"]) throw new Error("missing_provider_id");
  if (!flags["customer-id"]) throw new Error("missing_customer_id");
  const periodStartSec = parseIntArg(flags["period-start-sec"], undefined);
  const periodEndSec = parseIntArg(flags["period-end-sec"], undefined);
  if (!Number.isInteger(periodStartSec)) throw new Error("missing_period_start_sec");
  if (!Number.isInteger(periodEndSec)) throw new Error("missing_period_end_sec");
  const response = await fetchImpl(
    new Request(`${serverUrl}/v1/billing/invoices/draft`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        invoiceId: flags["invoice-id"],
        providerId: flags["provider-id"],
        customerId: flags["customer-id"],
        workspaceId: flags["workspace-id"],
        periodStartSec,
        periodEndSec,
        currency: flags.currency,
      }),
    })
  );
  return { status: response.status, body: await response.json() };
}

async function createPaymentHandoff(commandArgs, fetchImpl) {
  const flags = parseArgMap(commandArgs);
  const serverUrl = requireServerUrl(flags);
  const headers = buildServerHeaders(flags);
  if (!flags["invoice-id"]) throw new Error("missing_invoice_id");
  const customer =
    flags["customer-email"] || flags["customer-name"]
      ? { email: flags["customer-email"], name: flags["customer-name"] }
      : undefined;
  const response = await fetchImpl(
    new Request(
      `${serverUrl}/v1/billing/invoices/${encodeURIComponent(flags["invoice-id"])}/payment-handoff`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider: flags.provider ?? "manual",
          returnUrl: flags["return-url"],
          customer,
        }),
      }
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
      result = await issueLease(args.slice(2), fetchImpl);
    } else if (group === "license" && action === "verify") {
      result = verifyLease(args.slice(2));
    } else if (group === "tsa" && action === "manual-attest") {
      result = await manualAttest(args.slice(2), fetchImpl);
    } else if (group === "tsa" && action === "latest-attestation") {
      result = await latestAttestation(args.slice(2), fetchImpl);
    } else if (group === "bundle" && action === "build") {
      result = buildBundle(args.slice(2));
    } else if (group === "provider" && action === "create") {
      result = await createProvider(args.slice(2), fetchImpl);
    } else if (group === "customer" && action === "create") {
      result = await createCustomer(args.slice(2), fetchImpl);
    } else if (group === "workspace" && action === "create") {
      result = await createWorkspace(args.slice(2), fetchImpl);
    } else if (group === "policy" && action === "issue") {
      result = await issuePolicy(args.slice(2), fetchImpl);
    } else if (group === "policy" && action === "sync") {
      result = await syncPolicy(args.slice(2), fetchImpl);
    } else if (group === "meter" && action === "upload") {
      result = await uploadMeter(args.slice(2), fetchImpl);
    } else if (group === "usage" && action === "summary") {
      result = await usageSummary(args.slice(2), fetchImpl);
    } else if (group === "billing" && action === "pricing-rule" && args[2] === "create") {
      result = await createPricingRule(args.slice(3), fetchImpl);
    } else if (group === "billing" && action === "invoice" && args[2] === "draft") {
      result = await draftInvoice(args.slice(3), fetchImpl);
    } else if (group === "billing" && action === "payment-handoff" && args[2] === "create") {
      result = await createPaymentHandoff(args.slice(3), fetchImpl);
    } else {
      io.stderr.write(
        "usage: skillpack license issue|verify ... OR skillpack tsa manual-attest|latest-attestation ... OR skillpack bundle build ... OR skillpack provider create ... OR skillpack customer create ... OR skillpack workspace create ... OR skillpack policy issue|sync ... OR skillpack meter upload ... OR skillpack usage summary ... OR skillpack billing pricing-rule create|invoice draft|payment-handoff create ...\n"
      );
      return 2;
    }

    if (result.status >= 400) {
      io.stderr.write(`${JSON.stringify(result.body)}\n`);
      return 1;
    }
    if (result.stderr) {
      io.stderr.write(result.stderr);
    }
    io.stdout.write(`${JSON.stringify(result.body)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    return 1;
  }
}
