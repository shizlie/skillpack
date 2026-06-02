// apps/cli/src/commands.js
//
// Command descriptor table for the skillpack CLI.
// Each subcommand is a descriptor. The runner (runner.js) walks the table,
// validates required flags, builds the request (or runs the local exec),
// and returns { status, body, stderr }.
//
// Shape:
//   buildRequest: (flags) => { method, path, body }   — pure-HTTP commands;
//       runner prepends server-url and injects auth headers.
//   exec: async?(flags, fetchImpl?) => { status, body, stderr? }
//       — commands with local logic, offline paths, or non-trivial URL building.
//   required: string[]  — flag names the runner validates before dispatching.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

import { canonicalJson, signDetached, verifyLeaseToken } from "@skillpack/crypto";
import { createLicenseFetchHandler } from "@skillpack/core";
import { createManualTimeAttestationContract } from "@skillpack/tsa";
import { readKey, readJson, nowSec, normalizeServerUrl, buildServerHeaders, parseJsonLines, loadMeterEvents } from "./arg-helpers.js";
import { DESCRIPTOR } from "./descriptor.js";

function parseIntFlag(value, fallback = undefined) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error("invalid_integer_arg:" + value);
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

function buildPolicyFromFlags(flags) {
  const now = parseIntFlag(flags["now-sec"], nowSec());
  const startsAtSec = parseIntFlag(flags["starts-at-sec"], now);
  const expiresAtSec = parseIntFlag(flags["expires-at-sec"], now + 3600);
  const graceUntilSec = parseIntFlag(flags["grace-until-sec"], expiresAtSec + 3600);
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
        warningPct: parseIntFlag(flags["warning-pct"], 100),
        hardStopPct: parseIntFlag(flags["hard-stop-pct"], 120),
      },
      toolBudgets: {
        wiki_search: parseIntFlag(flags["budget-wiki-search"], 5),
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

// ---------------------------------------------------------------------------
// Command descriptor table
// ---------------------------------------------------------------------------

export const commands = {
  license: {
    // Dual-path: online (server-url) or offline (private-key-file + public-key-file).
    // Uses exec rather than buildRequest because the offline path uses
    // createLicenseFetchHandler and the response carries TSA warning stderr.
    issue: {
      required: ["customer-id"],
      exec: async (flags, fetchImpl) => {
        const body = {
          customerId: flags["customer-id"],
          seatId: flags["seat-id"] ?? "default",
          vendorId: flags["vendor-id"] ?? "skillpack-vendor",
          ttlSec: parseIntFlag(flags["ttl-sec"]),
          nowSec: parseIntFlag(flags["now-sec"], nowSec()),
          lastTsaTokenAtSec: parseIntFlag(flags["last-tsa-token-at-sec"]),
          tsaTicketId: flags["tsa-ticket-id"] ?? flags["ticket-id"],
          maxManualAttestationAgeSec: parseIntFlag(flags["max-manual-attestation-age-sec"]),
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
          const localFetch = createLicenseFetchHandler({
            signingPrivateKeyPem: privateKeyPem,
            signingPublicKeyPem: publicKeyPem,
            managementApiKey: localKey,
          });
          response = await localFetch(
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
                '    skillpack tsa manual-attest --server-url <license-server-url> --customer-id <customerId> --seat-id <seatId> --operator-id <operatorId> --ticket-id <ticketId> --reason "<incident reason>" --attested-at-sec <unix-sec>',
              ].join("\n") + "\n"
            : "";
        return { status: response.status, body: bodyJson, stderr };
      },
    },
    verify: {
      required: ["lease-token", "public-key-file"],
      exec: (flags) => {
        const publicKeyPem = readKey(flags["public-key-file"], "public_key_file");
        const payload = verifyLeaseToken(flags["lease-token"], publicKeyPem, {
          nowSec: parseIntFlag(flags["now-sec"], nowSec()),
        });
        return { status: 200, body: { valid: true, payload } };
      },
    },
  },

  tsa: {
    // Dual-path: if no server-url, returns the created record locally without
    // persisting it. Useful for offline attestation workflows.
    "manual-attest": {
      required: [],
      exec: async (flags, fetchImpl) => {
        const contract = createManualTimeAttestationContract();
        const record = contract.createRecord({
          operatorId: flags["operator-id"],
          ticketId: flags["ticket-id"],
          reason: flags.reason,
          attestedAtSec: parseIntFlag(flags["attested-at-sec"]),
        });
        const serverUrl = normalizeServerUrl(flags["server-url"]);
        if (!serverUrl) {
          return { status: 200, body: { accepted: true, record } };
        }
        const response = await fetchImpl(
          new Request(`${serverUrl}/v1/tsa/manual-attest`, {
            method: "POST",
            headers: buildServerHeaders(flags),
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
      },
    },
    // GET with query-string construction — uses exec rather than buildRequest.
    "latest-attestation": {
      required: ["server-url", "customer-id"],
      exec: async (flags, fetchImpl) => {
        const serverUrl = normalizeServerUrl(flags["server-url"]);
        if (!serverUrl) throw new Error("missing_server_url");
        if (!flags["customer-id"]) throw new Error("missing_customer_id");
        const seatId = flags["seat-id"] ?? "default";
        const ticketParam = flags["ticket-id"]
          ? `&ticketId=${encodeURIComponent(flags["ticket-id"])}`
          : "";
        const response = await fetchImpl(
          new Request(
            `${serverUrl}/v1/tsa/manual-attestations/latest?customerId=${encodeURIComponent(
              flags["customer-id"]
            )}&seatId=${encodeURIComponent(seatId)}${ticketParam}`,
            { method: "GET", headers: buildServerHeaders(flags) }
          )
        );
        return { status: response.status, body: await response.json() };
      },
    },
  },

  provider: {
    create: {
      required: ["server-url", "provider-id"],
      buildRequest: (flags) => ({
        method: "POST",
        path: "/v1/providers",
        body: {
          providerId: flags["provider-id"],
          name: flags.name,
        },
      }),
    },
  },

  customer: {
    create: {
      required: ["server-url", "provider-id", "customer-id"],
      buildRequest: (flags) => ({
        method: "POST",
        path: `/v1/providers/${encodeURIComponent(flags["provider-id"])}/customers`,
        body: {
          customerId: flags["customer-id"],
          name: flags.name,
        },
      }),
    },
  },

  workspace: {
    create: {
      required: ["server-url", "workspace-id", "provider-id", "customer-id"],
      buildRequest: (flags) => ({
        method: "POST",
        path: "/v1/workspaces",
        body: {
          workspaceId: flags["workspace-id"],
          providerId: flags["provider-id"],
          customerId: flags["customer-id"],
          name: flags.name,
          status: flags.status,
        },
      }),
    },
  },

  policy: {
    // exec because it optionally reads a policy file from disk.
    issue: {
      required: ["server-url"],
      exec: async (flags, fetchImpl) => {
        const serverUrl = normalizeServerUrl(flags["server-url"]);
        if (!serverUrl) throw new Error("missing_server_url");
        const policy = flags["policy-file"]
          ? readJson(flags["policy-file"], "policy_file")
          : buildPolicyFromFlags(flags);
        const response = await fetchImpl(
          new Request(`${serverUrl}/v1/policies/issue`, {
            method: "POST",
            headers: buildServerHeaders(flags),
            body: JSON.stringify({ policy }),
          })
        );
        return { status: response.status, body: await response.json() };
      },
    },
    sync: {
      required: ["server-url", "workspace-id"],
      buildRequest: (flags) => ({
        method: "POST",
        path: "/v1/policies/sync",
        body: {
          workspaceId: flags["workspace-id"],
          policyId: flags["policy-id"],
        },
      }),
    },
  },

  meter: {
    // exec because it reads and parses a meter events file from disk.
    upload: {
      required: ["server-url", "workspace-id"],
      exec: async (flags, fetchImpl) => {
        const serverUrl = normalizeServerUrl(flags["server-url"]);
        if (!serverUrl) throw new Error("missing_server_url");
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
          Object.entries(context).filter(
            ([, value]) => typeof value === "string" && value.length > 0
          )
        );
        const response = await fetchImpl(
          new Request(`${serverUrl}/v1/meter/upload`, {
            method: "POST",
            headers: buildServerHeaders(flags),
            body: JSON.stringify({
              workspaceId: flags["workspace-id"],
              ...(Object.keys(normalizedContext).length > 0 ? { context: normalizedContext } : {}),
              events,
            }),
          })
        );
        return { status: response.status, body: await response.json() };
      },
    },
  },

  usage: {
    // exec because it builds a GET URL with optional query parameters.
    summary: {
      required: ["server-url"],
      exec: async (flags, fetchImpl) => {
        const serverUrl = normalizeServerUrl(flags["server-url"]);
        if (!serverUrl) throw new Error("missing_server_url");
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
            headers: buildServerHeaders(flags),
          })
        );
        return { status: response.status, body: await response.json() };
      },
    },
  },

  billing: {
    "pricing-rule": {
      // exec because it conditionally assembles a nested paymentProvider object.
      create: {
        required: ["server-url", "pricing-rule-id", "provider-id", "currency", "unit-amount-cents"],
        exec: async (flags, fetchImpl) => {
          const serverUrl = normalizeServerUrl(flags["server-url"]);
          if (!serverUrl) throw new Error("missing_server_url");
          if (!flags["pricing-rule-id"]) throw new Error("missing_pricing_rule_id");
          if (!flags["provider-id"]) throw new Error("missing_provider_id");
          if (!flags.currency) throw new Error("missing_currency");
          const unitAmountCents = parseIntFlag(flags["unit-amount-cents"], null);
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
              headers: buildServerHeaders(flags),
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
                includedUnits: parseIntFlag(flags["included-units"]),
                minimumAmountCents: parseIntFlag(flags["minimum-amount-cents"]),
                status: flags.status,
                paymentProvider,
              }),
            })
          );
          return { status: response.status, body: await response.json() };
        },
      },
    },
    invoice: {
      // exec because period-start-sec and period-end-sec require integer validation.
      draft: {
        required: [
          "server-url",
          "provider-id",
          "customer-id",
          "period-start-sec",
          "period-end-sec",
        ],
        exec: async (flags, fetchImpl) => {
          const serverUrl = normalizeServerUrl(flags["server-url"]);
          if (!serverUrl) throw new Error("missing_server_url");
          if (!flags["provider-id"]) throw new Error("missing_provider_id");
          if (!flags["customer-id"]) throw new Error("missing_customer_id");
          const periodStartSec = parseIntFlag(flags["period-start-sec"]);
          const periodEndSec = parseIntFlag(flags["period-end-sec"]);
          if (!Number.isInteger(periodStartSec)) throw new Error("missing_period_start_sec");
          if (!Number.isInteger(periodEndSec)) throw new Error("missing_period_end_sec");
          const response = await fetchImpl(
            new Request(`${serverUrl}/v1/billing/invoices/draft`, {
              method: "POST",
              headers: buildServerHeaders(flags),
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
        },
      },
    },
    "payment-handoff": {
      // exec because the invoice-id appears URL-encoded in the path.
      create: {
        required: ["server-url", "invoice-id"],
        exec: async (flags, fetchImpl) => {
          const serverUrl = normalizeServerUrl(flags["server-url"]);
          if (!serverUrl) throw new Error("missing_server_url");
          if (!flags["invoice-id"]) throw new Error("missing_invoice_id");
          const customer =
            flags["customer-email"] || flags["customer-name"]
              ? { email: flags["customer-email"], name: flags["customer-name"] }
              : undefined;
          const response = await fetchImpl(
            new Request(
              `${serverUrl}/v1/billing/invoices/${encodeURIComponent(
                flags["invoice-id"]
              )}/payment-handoff`,
              {
                method: "POST",
                headers: buildServerHeaders(flags),
                body: JSON.stringify({
                  provider: flags.provider ?? "manual",
                  returnUrl: flags["return-url"],
                  customer,
                }),
              }
            )
          );
          return { status: response.status, body: await response.json() };
        },
      },
    },
  },

  bundle: {
    build: {
      required: ["input-dir"],
      exec: (flags) => {
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
      },
    },
  },
};

// Tag every leaf descriptor at module load. The tree is at most three levels
// deep (group → action → subAction); leaves carry required/buildRequest/exec.
function tagDescriptors(node) {
  for (const value of Object.values(node)) {
    if (value === null || typeof value !== "object") continue;
    if (value.required !== undefined || value.buildRequest !== undefined || value.exec !== undefined) {
      value[DESCRIPTOR] = true;
    } else {
      tagDescriptors(value);
    }
  }
}
tagDescriptors(commands);
