import { expect, test, describe } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { generateEd25519KeyPair } from "@skillpack/crypto";
import { createLicenseFetchHandler } from "@skillpack/core";
import { runSkillpackCli } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentIo = { stdout: { write: () => {} }, stderr: { write: () => {} } };

function captureIo() {
  let out = "", err = "";
  return {
    io: { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) } },
    get out() { return out; },
    get err() { return err; },
  };
}

function mockFetch(res) {
  return async () => new Response(JSON.stringify(res), { status: 200 });
}

function writeKeys() {
  const keys = generateEd25519KeyPair();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sp-keys-"));
  const priv = path.join(d, "priv.pem");
  const pub = path.join(d, "pub.pem");
  fs.writeFileSync(priv, keys.privateKeyPem);
  fs.writeFileSync(pub, keys.publicKeyPem);
  return { priv, pub };
}

// Sync temp JSONL file for meter upload happy-path entry.
const meterFile = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sp-meter-"));
  const p = path.join(d, "e.jsonl");
  fs.writeFileSync(p, '{"prevHash":"h0","seq":1,"at":1800000000,"kind":"tool_call","seatId":"s1","tool":"t1","usage":{"unit":"tool_call","delta":1}}\n');
  return p;
})();

// ---------------------------------------------------------------------------
// Table: happy paths (one entry per server-backed or offline subcommand)
// ---------------------------------------------------------------------------

const S = "http://x"; // mock server-url shorthand

const happyPaths = [
  { args: ["license", "issue", "--server-url", S, "--customer-id", "c1"], res: { leaseToken: "tok" } },
  { args: ["tsa", "manual-attest", "--operator-id", "op-1", "--ticket-id", "INC-1", "--reason", "incident response", "--attested-at-sec", "1800000000"], res: {} },
  { args: ["tsa", "latest-attestation", "--server-url", S, "--customer-id", "c1"], res: { record: {} } },
  { args: ["provider", "create", "--server-url", S, "--provider-id", "p1"], res: { provider: {} } },
  { args: ["customer", "create", "--server-url", S, "--provider-id", "p1", "--customer-id", "c1"], res: { customer: {} } },
  { args: ["workspace", "create", "--server-url", S, "--workspace-id", "ws1", "--provider-id", "p1", "--customer-id", "c1"], res: { workspace: {} } },
  { args: ["policy", "issue", "--server-url", S], res: { accepted: true } },
  { args: ["policy", "sync", "--server-url", S, "--workspace-id", "ws1"], res: { policy: {} } },
  { args: ["meter", "upload", "--server-url", S, "--workspace-id", "ws1", "--file", meterFile], res: { accepted: true } },
  { args: ["usage", "summary", "--server-url", S], res: { summary: [] } },
  { args: ["billing", "pricing-rule", "create", "--server-url", S, "--pricing-rule-id", "pr1", "--provider-id", "p1", "--currency", "usd", "--unit-amount-cents", "100"], res: { pricingRule: {} } },
  { args: ["billing", "invoice", "draft", "--server-url", S, "--provider-id", "p1", "--customer-id", "c1", "--period-start-sec", "1800000000", "--period-end-sec", "1800001000"], res: { invoice: {} } },
  { args: ["billing", "payment-handoff", "create", "--server-url", S, "--invoice-id", "inv1"], res: { url: "http://pay" } },
];

describe("runSkillpackCli happy paths", () => {
  for (const { args, res } of happyPaths) {
    test(`${args.slice(0, 2).join(" ")}`, async () => {
      expect(await runSkillpackCli(args, silentIo, { fetchImpl: mockFetch(res) })).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Table: missing-required-flag → exit 1
// ---------------------------------------------------------------------------

const requiredFlagCases = [
  { args: ["license", "issue"],                                                                                              missing: "customer-id" },
  { args: ["license", "verify", "--public-key-file", "x.pem"],                                                              missing: "lease-token" },
  { args: ["tsa", "latest-attestation", "--customer-id", "c1"],                                                             missing: "server-url" },
  { args: ["provider", "create", "--server-url", S],                                                                        missing: "provider-id" },
  { args: ["customer", "create", "--server-url", S, "--provider-id", "p1"],                                                  missing: "customer-id" },
  { args: ["workspace", "create", "--server-url", S, "--provider-id", "p1", "--customer-id", "c1"],                         missing: "workspace-id" },
  { args: ["policy", "issue"],                                                                                               missing: "server-url" },
  { args: ["policy", "sync", "--server-url", S],                                                                             missing: "workspace-id" },
  { args: ["meter", "upload", "--server-url", S],                                                                            missing: "workspace-id" },
  { args: ["usage", "summary"],                                                                                              missing: "server-url" },
  { args: ["billing", "pricing-rule", "create", "--server-url", S, "--pricing-rule-id", "pr1", "--provider-id", "p1", "--currency", "usd"], missing: "unit-amount-cents" },
  { args: ["billing", "invoice", "draft", "--server-url", S, "--provider-id", "p1", "--customer-id", "c1", "--period-start-sec", "1800000000"], missing: "period-end-sec" },
  { args: ["billing", "payment-handoff", "create", "--server-url", S],                                                      missing: "invoice-id" },
  { args: ["bundle", "build"],                                                                                               missing: "input-dir" },
];

describe("runSkillpackCli missing required flag", () => {
  for (const { args, missing } of requiredFlagCases) {
    test(`${args.slice(0, 2).join(" ")} needs --${missing}`, async () => {
      expect(await runSkillpackCli(args, silentIo, { fetchImpl: mockFetch({}) })).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Targeted tests — unique behaviors not captured by the tables above
// ---------------------------------------------------------------------------

test("license issue offline emits token json", async () => {
  const { priv, pub } = writeKeys();
  const sink = captureIo();
  const code = await runSkillpackCli(
    ["license", "issue", "--customer-id", "cust-1", "--private-key-file", priv, "--public-key-file", pub, "--now-sec", "1800000000"],
    sink.io
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(sink.out);
  expect(typeof parsed.leaseToken).toBe("string");
  expect(parsed.payload.sub).toBe("cust-1");
});

test("license issue prints TSA outage hint to stderr", async () => {
  const { priv, pub } = writeKeys();
  const sink = captureIo();
  await runSkillpackCli(
    ["license", "issue", "--customer-id", "cust-1", "--private-key-file", priv, "--public-key-file", pub,
      "--now-sec", "1800000000", "--last-tsa-token-at-sec", String(1_800_000_000 - 8 * 24 * 60 * 60)],
    sink.io
  );
  expect(JSON.parse(sink.out).tsaState.status).toBe("expired");
  expect(sink.err).toMatch(/TSA token expired/);
  expect(sink.err).toMatch(/docs\/runbooks\/tsa-outage\.md/);
  expect(sink.err).toMatch(/skillpack tsa manual-attest/);
});

test("tsa manual-attest server fallback posts to server", async () => {
  const keys = generateEd25519KeyPair();
  const mgmtKey = "test-key";
  const fetchImpl = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
    managementApiKey: mgmtKey,
  });
  const sink = captureIo();
  const code = await runSkillpackCli(
    ["tsa", "manual-attest", "--server-url", "http://local", "--api-key", mgmtKey,
      "--customer-id", "cust-t", "--seat-id", "s1", "--operator-id", "op-1",
      "--ticket-id", "INC-1", "--reason", "incident response", "--attested-at-sec", "1800000000"],
    sink.io, { fetchImpl }
  );
  expect(code).toBe(0);
  expect(JSON.parse(sink.out).record.customerId).toBe("cust-t");
});

test("bundle build creates .mcpb artifact", async () => {
  const zipCheck = spawnSync("zip", ["-v"], { stdio: "ignore" });
  if (zipCheck.status !== 0) return;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sp-bundle-"));
  const inputDir = path.join(ws, "skill-src");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, "README.md"), "# Demo\n");
  fs.writeFileSync(path.join(inputDir, "config.json"), '{"k":"v"}\n');
  const { priv } = writeKeys();
  const outputFile = path.join(ws, "out", "demo.mcpb");
  const sink = captureIo();
  const code = await runSkillpackCli(
    ["bundle", "build", "--input-dir", inputDir, "--bundle-id", "demo", "--version", "1.0.0",
      "--private-key-file", priv, "--output-file", outputFile],
    sink.io
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(sink.out);
  expect(parsed.bundleId).toBe("demo");
  expect(parsed.signed).toBe(true);
  expect(parsed.fileCount).toBe(2);
  expect(fs.existsSync(outputFile)).toBe(true);
  expect(fs.statSync(outputFile).size).toBeGreaterThan(0);
});
