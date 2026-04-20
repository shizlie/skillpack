#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Policy loop demo (deterministic local simulation)"

bun run - <<'BUN_EOF'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateEd25519KeyPair } from "./packages/crypto/src/index.js";
import { createLicenseFetchHandler } from "./packages/license-server/src/index.js";
import { runSkillpackCli } from "./packages/cli/src/index.js";

function checkpoint(name, condition, details = "") {
  if (!condition) {
    console.error(`FAIL: ${name}${details ? ` (${details})` : ""}`);
    process.exit(1);
  }
  console.log(`PASS: ${name}${details ? ` (${details})` : ""}`);
}

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

async function runCli(args, fetchImpl) {
  const sink = makeIo();
  const code = await runSkillpackCli(args, sink.io, { fetchImpl });
  const { out, err } = sink.read();
  const parsed = out.trim().length > 0 ? JSON.parse(out) : null;
  return { code, out, err, parsed };
}

function makePolicy({ policyId, budget }) {
  return {
    policyVersion: 1,
    policyId,
    workspaceId: "ws-demo",
    workspacePolicy: { mode: "ENABLED" },
    seatPolicy: {
      defaultMode: "ENABLED",
      seats: { "seat-1": { mode: "ENABLED" } },
    },
    usagePolicy: {
      unit: "tool_call",
      thresholds: { warningPct: 100, hardStopPct: 120 },
      toolBudgets: { wiki_search: budget },
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

function evaluateUsageDecision(policy, currentCount) {
  const nextCount = currentCount + 1;
  const budget = policy.usagePolicy.toolBudgets.wiki_search;
  const warningPct = policy.usagePolicy.thresholds.warningPct;
  const hardStopPct = policy.usagePolicy.thresholds.hardStopPct;
  const pct = (nextCount / budget) * 100;
  if (pct > hardStopPct) {
    return { decision: "DENY", reasonCodes: ["usage_hard_stop"] };
  }
  if (pct >= warningPct) {
    return { decision: "ALLOW_WITH_WARNING", reasonCodes: ["usage_warning"] };
  }
  return { decision: "ALLOW", reasonCodes: [] };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-loop-demo-"));
const policyV1File = path.join(tmp, "policy-v1.json");
const policyV2File = path.join(tmp, "policy-v2.json");
const meterFile = path.join(tmp, "meter.jsonl");
fs.writeFileSync(policyV1File, JSON.stringify(makePolicy({ policyId: "pol-v1", budget: 2 }), null, 2));
fs.writeFileSync(policyV2File, JSON.stringify(makePolicy({ policyId: "pol-v2", budget: 10 }), null, 2));

const keys = generateEd25519KeyPair();
const fetch = createLicenseFetchHandler({
  signingPrivateKeyPem: keys.privateKeyPem,
  signingPublicKeyPem: keys.publicKeyPem,
});

const issueV1 = await runCli(
  ["policy", "issue", "--server-url", "http://local", "--policy-file", policyV1File],
  fetch
);
checkpoint("policy issue v1", issueV1.code === 0 && issueV1.parsed?.accepted === true);

const syncV1 = await runCli(
  ["policy", "sync", "--server-url", "http://local", "--workspace-id", "ws-demo"],
  fetch
);
checkpoint("policy sync v1", syncV1.code === 0 && syncV1.parsed?.policy?.policyId === "pol-v1");

const policyV1 = syncV1.parsed.policy;
const use1 = evaluateUsageDecision(policyV1, 0);
checkpoint("use #1 allows", use1.decision === "ALLOW");
const use2 = evaluateUsageDecision(policyV1, 1);
checkpoint("use #2 warns", use2.decision === "ALLOW_WITH_WARNING" && use2.reasonCodes.includes("usage_warning"));
const use3 = evaluateUsageDecision(policyV1, 2);
checkpoint("use #3 stops", use3.decision === "DENY" && use3.reasonCodes.includes("usage_hard_stop"));

fs.writeFileSync(
  meterFile,
  [
    JSON.stringify({
      prevHash: "h0",
      seq: 1,
      at: 1_800_000_100,
      kind: "tool_call",
      seatId: "seat-1",
      tool: "wiki_search",
      usage: { unit: "tool_call", delta: 1 },
    }),
    JSON.stringify({
      prevHash: "h1",
      seq: 2,
      at: 1_800_000_120,
      kind: "tool_call",
      seatId: "seat-1",
      tool: "wiki_search",
      usage: { unit: "tool_call", delta: 1 },
    }),
    "",
  ].join("\n")
);

const upload = await runCli(
  ["meter", "upload", "--server-url", "http://local", "--workspace-id", "ws-demo", "--file", meterFile],
  fetch
);
checkpoint("meter upload", upload.code === 0 && upload.parsed?.ack?.count === 2);

const summary = await runCli(
  ["usage", "summary", "--server-url", "http://local", "--workspace-id", "ws-demo"],
  fetch
);
const totalCalls = summary.parsed?.summary?.[0]?.totalCalls;
checkpoint("usage summary", summary.code === 0 && totalCalls === 2, `totalCalls=${totalCalls}`);

const issueV2 = await runCli(
  ["policy", "issue", "--server-url", "http://local", "--policy-file", policyV2File],
  fetch
);
checkpoint("policy renew (issue v2)", issueV2.code === 0 && issueV2.parsed?.policy?.policyId === "pol-v2");

const syncV2 = await runCli(
  ["policy", "sync", "--server-url", "http://local", "--workspace-id", "ws-demo", "--policy-id", "pol-v1"],
  fetch
);
checkpoint("policy sync after renew", syncV2.code === 0 && syncV2.parsed?.policy?.policyId === "pol-v2");

const continueAfterRenew = evaluateUsageDecision(syncV2.parsed.policy, 2);
checkpoint("continue after renew", continueAfterRenew.decision === "ALLOW");

console.log("PASS: policy loop demo complete");
BUN_EOF
