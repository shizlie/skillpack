import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { generateEd25519KeyPair } from "@skillpack/crypto";
import { createLicenseFetchHandler } from "@skillpack/license-server";
import { runSkillpackCli } from "../src/index.js";

function makeIo() {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: { write: (chunk) => (out += chunk) },
      stderr: { write: (chunk) => (err += chunk) },
    },
    read: () => ({ out, err }),
  };
}

function writeKeys() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-cli-"));
  const keys = generateEd25519KeyPair();
  const privateKeyFile = path.join(dir, "private.pem");
  const publicKeyFile = path.join(dir, "public.pem");
  fs.writeFileSync(privateKeyFile, keys.privateKeyPem);
  fs.writeFileSync(publicKeyFile, keys.publicKeyPem);
  return { privateKeyFile, publicKeyFile };
}

function makePolicy(policyId = "pol-1", workspaceMode = "ENABLED") {
  return {
    policyVersion: 1,
    policyId,
    workspaceId: "ws-1",
    workspacePolicy: { mode: workspaceMode },
    seatPolicy: {
      defaultMode: "ENABLED",
      seats: {
        "seat-1": { mode: "ENABLED" },
      },
    },
    usagePolicy: {
      unit: "tool_call",
      thresholds: { warningPct: 100, hardStopPct: 120 },
      toolBudgets: { wiki_search: 10 },
    },
    timePolicy: {
      workspace: {
        startsAtSec: 1_800_000_000,
        expiresAtSec: 1_800_003_600,
        graceUntilSec: 1_800_007_200,
      },
      seatOverrides: {
        "seat-1": {
          startsAtSec: 1_800_000_000,
          expiresAtSec: 1_800_003_600,
          graceUntilSec: 1_800_007_200,
        },
      },
    },
  };
}

test("cli: license issue emits token json", async () => {
  const { privateKeyFile, publicKeyFile } = writeKeys();
  const sink = makeIo();
  const code = await runSkillpackCli(
    [
      "license",
      "issue",
      "--customer-id",
      "cust-1",
      "--private-key-file",
      privateKeyFile,
      "--public-key-file",
      publicKeyFile,
      "--now-sec",
      "1800000000",
    ],
    sink.io
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(sink.read().out);
  expect(typeof parsed.leaseToken).toBe("string");
  expect(parsed.payload.sub).toBe("cust-1");
});

test("cli: tsa manual-attest validates required fields", async () => {
  const sink = makeIo();
  const code = await runSkillpackCli(
    [
      "tsa",
      "manual-attest",
      "--operator-id",
      "op-1",
      "--ticket-id",
      "INC-1",
      "--reason",
      "TSA outage runbook entry",
      "--attested-at-sec",
      "1800000000",
    ],
    sink.io
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(sink.read().out);
  expect(parsed.accepted).toBe(true);
  expect(parsed.record.source).toBe("manual-time-attestation");
});

test("cli: tsa manual-attest posts to server and latest-attestation reads record", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
  });

  const attestSink = makeIo();
  const attestCode = await runSkillpackCli(
    [
      "tsa",
      "manual-attest",
      "--server-url",
      "http://local",
      "--customer-id",
      "cust-9",
      "--seat-id",
      "seat-9",
      "--operator-id",
      "op-9",
      "--ticket-id",
      "INC-9",
      "--reason",
      "Manual attestation submitted during TSA outage workflow",
      "--attested-at-sec",
      "1800000000",
    ],
    attestSink.io,
    { fetchImpl: fetch }
  );
  expect(attestCode).toBe(0);
  const attestParsed = JSON.parse(attestSink.read().out);
  expect(attestParsed.record.customerId).toBe("cust-9");

  const latestSink = makeIo();
  const latestCode = await runSkillpackCli(
    [
      "tsa",
      "latest-attestation",
      "--server-url",
      "http://local",
      "--customer-id",
      "cust-9",
      "--seat-id",
      "seat-9",
    ],
    latestSink.io,
    { fetchImpl: fetch }
  );
  expect(latestCode).toBe(0);
  const latestParsed = JSON.parse(latestSink.read().out);
  expect(latestParsed.record.ticketId).toBe("INC-9");
});

test("cli: policy issue posts policy snapshot", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
  });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-policy-issue-test-"));
  const policyFile = path.join(workspace, "policy.json");
  fs.writeFileSync(policyFile, JSON.stringify(makePolicy("pol-1"), null, 2));

  const sink = makeIo();
  const code = await runSkillpackCli(
    [
      "policy",
      "issue",
      "--server-url",
      "http://local",
      "--policy-file",
      policyFile,
    ],
    sink.io,
    { fetchImpl: fetch }
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(sink.read().out);
  expect(parsed.accepted).toBe(true);
  expect(parsed.policy.policyId).toBe("pol-1");
});

test("cli: policy sync returns latest policy", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
  });
  await fetch(
    new Request("http://local/v1/policies/issue", {
      method: "POST",
      body: JSON.stringify({ policy: makePolicy("pol-2", "DISABLED") }),
    })
  );

  const sink = makeIo();
  const code = await runSkillpackCli(
    [
      "policy",
      "sync",
      "--server-url",
      "http://local",
      "--workspace-id",
      "ws-1",
      "--policy-id",
      "pol-1",
    ],
    sink.io,
    { fetchImpl: fetch }
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(sink.read().out);
  expect(parsed.notModified).toBe(false);
  expect(parsed.policy.policyId).toBe("pol-2");
  expect(parsed.policy.workspacePolicy.mode).toBe("DISABLED");
});

test("cli: meter upload ingests events from jsonl", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
  });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-meter-upload-test-"));
  const eventsFile = path.join(workspace, "meter.jsonl");
  fs.writeFileSync(
    eventsFile,
    [
      JSON.stringify({
        prevHash: "h0",
        seq: 1,
        at: 1_800_000_001,
        kind: "tool_call",
        seatId: "seat-1",
        tool: "wiki_search",
        usage: { unit: "tool_call", delta: 2 },
      }),
      JSON.stringify({
        prevHash: "h1",
        seq: 2,
        at: 1_800_000_002,
        kind: "tool_call",
        seatId: "seat-1",
        tool: "wiki_search",
        usage: { unit: "tool_call", delta: 1 },
      }),
      "",
    ].join("\n")
  );

  const sink = makeIo();
  const code = await runSkillpackCli(
    [
      "meter",
      "upload",
      "--server-url",
      "http://local",
      "--workspace-id",
      "ws-1",
      "--file",
      eventsFile,
    ],
    sink.io,
    { fetchImpl: fetch }
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(sink.read().out);
  expect(parsed.accepted).toBe(true);
  expect(parsed.ack.count).toBe(2);
  expect(parsed.ack.range.seqStart).toBe(1);
  expect(parsed.ack.range.seqEnd).toBe(2);
});

test("cli: usage summary prints totals", async () => {
  const keys = generateEd25519KeyPair();
  const fetch = createLicenseFetchHandler({
    signingPrivateKeyPem: keys.privateKeyPem,
    signingPublicKeyPem: keys.publicKeyPem,
  });
  await fetch(
    new Request("http://local/v1/meter/upload", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: "ws-1",
        events: [
          {
            prevHash: "h10",
            seq: 10,
            at: 1_800_000_100,
            kind: "tool_call",
            seatId: "seat-1",
            tool: "wiki_search",
            usage: { unit: "tool_call", delta: 2 },
          },
          {
            prevHash: "h11",
            seq: 11,
            at: 1_800_000_120,
            kind: "tool_call",
            seatId: "seat-1",
            tool: "wiki_search",
            usage: { unit: "tool_call", delta: 3 },
          },
        ],
      }),
    })
  );

  const sink = makeIo();
  const code = await runSkillpackCli(
    [
      "usage",
      "summary",
      "--server-url",
      "http://local",
      "--workspace-id",
      "ws-1",
    ],
    sink.io,
    { fetchImpl: fetch }
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(sink.read().out);
  expect(parsed.summary).toEqual([
    {
      workspaceId: "ws-1",
      seatId: "seat-1",
      tool: "wiki_search",
      unit: "tool_call",
      totalCalls: 5,
    },
  ]);
});

test("cli: bundle build creates .mcpb artifact", async () => {
  const zipCheck = spawnSync("zip", ["-v"], { stdio: "ignore" });
  if (zipCheck.status !== 0) return;

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-bundle-test-"));
  const inputDir = path.join(workspace, "skill-src");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, "README.md"), "# Demo Skill\n");
  fs.writeFileSync(path.join(inputDir, "config.json"), '{"k":"v"}\n');

  const keys = generateEd25519KeyPair();
  const privateKeyFile = path.join(workspace, "private.pem");
  fs.writeFileSync(privateKeyFile, keys.privateKeyPem);
  const outputFile = path.join(workspace, "out", "demo.mcpb");

  const sink = makeIo();
  const code = await runSkillpackCli(
    [
      "bundle",
      "build",
      "--input-dir",
      inputDir,
      "--bundle-id",
      "demo-skill",
      "--version",
      "1.2.3",
      "--private-key-file",
      privateKeyFile,
      "--output-file",
      outputFile,
    ],
    sink.io
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(sink.read().out);
  expect(parsed.bundleId).toBe("demo-skill");
  expect(parsed.signed).toBe(true);
  expect(parsed.fileCount).toBe(2);
  expect(fs.existsSync(outputFile)).toBe(true);
  expect(fs.statSync(outputFile).size).toBeGreaterThan(0);
});
