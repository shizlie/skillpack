import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLeaseToken, generateEd25519KeyPair } from "../packages/crypto/src/index.js";
import { runSkillpackCli } from "../packages/cli/src/index.js";
import { createLicenseFetchHandler } from "../packages/license-server/src/index.js";

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

async function runCliJson(args, fetchImpl) {
  const sink = makeIo();
  const code = await runSkillpackCli(args, sink.io, { fetchImpl });
  const { out, err } = sink.read();
  const parsed = out.trim() ? JSON.parse(out) : null;
  return { code, parsed, out, err };
}

function createRuntimeClient({ bundlePath, publicKeyPath }) {
  const serverPath = path.resolve("packages/runtime/src/server.mjs");
  const proc = spawn("node", [serverPath, bundlePath, publicKeyPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      SKILLPACK_RUNTIME_SKIP_MAIN: "0",
    },
  });
  let stderrBuffer = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
  });

  let buffer = "";
  const queue = [];
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const next = queue.shift();
      if (!next) continue;
      try {
        next.resolve(JSON.parse(line));
      } catch (error) {
        next.reject(error);
      }
    }
  });

  proc.on("exit", (code, signal) => {
    while (queue.length > 0) {
      const next = queue.shift();
      next.reject(
        new Error(
          `runtime_server_exited: code=${code ?? "null"} signal=${signal ?? "null"} stderr=${stderrBuffer.trim()}`
        )
      );
    }
  });

  async function request(message) {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    return await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(
        () =>
          reject(
            new Error(`runtime_client_timeout: stderr=${stderrBuffer.trim()}`)
          ),
        15000
      );
      queue.push({
        resolve: (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });
    });
  }

  async function close() {
    if (!proc.killed) proc.kill("SIGTERM");
  }

  return { request, close };
}

function writeWikiArchive(inputDir) {
  const tempWikiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-gate-wiki-"));
  const wikiDir = path.join(tempWikiRoot, "wiki");
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(
    path.join(wikiDir, "index.md"),
    "# Laws Consultant Wiki Index\n\n- cybersecurity\n"
  );

  const knowledgeDir = path.join(inputDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  const wikiTarPath = path.join(knowledgeDir, "wiki.tar.gz");
  const tar = spawnSync("tar", ["-czf", wikiTarPath, "-C", tempWikiRoot, "wiki"], {
    encoding: "utf8",
  });
  if (tar.status !== 0) {
    throw new Error(`wiki_tar_failed:${tar.stderr || "unknown"}`);
  }
}

function makePolicy({ nowSec, workspaceMode = "ENABLED", seatDefaultMode = "ENABLED", seatOverrides = {}, budget = 100, workspaceTime }) {
  return {
    policyVersion: 1,
    policyId: `policy-${nowSec}-${workspaceMode}-${seatDefaultMode}-${budget}`,
    workspaceId: "ws-gate-e2e",
    workspacePolicy: { mode: workspaceMode },
    seatPolicy: {
      defaultMode: seatDefaultMode,
      seats: seatOverrides,
    },
    usagePolicy: {
      unit: "tool_call",
      thresholds: { warningPct: 100, hardStopPct: 120 },
      toolBudgets: { wiki_search: budget },
    },
    timePolicy: {
      workspace:
        workspaceTime ?? {
          startsAtSec: nowSec - 3600,
          expiresAtSec: nowSec + 3600,
          graceUntilSec: nowSec + 7200,
        },
      seatOverrides: {},
    },
  };
}

function makeRuntimeBundle({ policy, seatId }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-gate-bundle-"));
  const inputDir = path.join(workDir, "input");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, "SKILL.md"), "# Gate Test Skill\n");
  fs.writeFileSync(path.join(inputDir, "policy.json"), JSON.stringify(policy, null, 2));
  writeWikiArchive(inputDir);

  const keys = generateEd25519KeyPair();
  const privateKeyFile = path.join(workDir, "private.pem");
  const publicKeyFile = path.join(workDir, "public.pem");
  fs.writeFileSync(privateKeyFile, keys.privateKeyPem);
  fs.writeFileSync(publicKeyFile, keys.publicKeyPem);

  const nowSec = Math.floor(Date.now() / 1000);
  const leaseToken = createLeaseToken(
    {
      iss: "vendor-e2e",
      sub: "customer-e2e",
      iat: nowSec - 60,
      exp: nowSec + 86_400,
      jti: `lease-${seatId}-${nowSec}`,
      leaseCounter: 1,
    },
    keys.privateKeyPem
  );

  const licenseFile = path.join(workDir, "license.json");
  fs.writeFileSync(
    licenseFile,
    JSON.stringify(
      {
        leaseToken,
        seatId,
      },
      null,
      2
    )
  );

  const bundlePath = path.join(workDir, "gate-test.mcpb");
  return {
    workDir,
    inputDir,
    privateKeyFile,
    publicKeyFile,
    licenseFile,
    bundlePath,
  };
}

function parseToolCallEvents(meterLogPath) {
  if (!fs.existsSync(meterLogPath)) return [];
  return fs
    .readFileSync(meterLogPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.kind === "tool_call")
    .map((event) => ({
      prevHash: event.prevHash,
      seq: event.seq,
      at: event.at,
      kind: event.kind,
      seatId: event.data?.seatId,
      tool: event.data?.tool,
      usage: {
        unit: event.data?.usageUnit ?? "tool_call",
        delta: event.data?.usageDelta ?? 1,
      },
    }));
}

const cleanupFns = [];
afterAll(async () => {
  for (const fn of cleanupFns.reverse()) {
    await fn();
  }
});

describe("policy gating full-loop e2e", () => {
  test(
    "workspace/seat/time/usage gates enforce expected decisions in full runtime loop",
    async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const scenarios = [
      {
        name: "workspace_disabled",
        seatId: "seat-1",
        policy: makePolicy({ nowSec, workspaceMode: "DISABLED" }),
        calls: 1,
        expectedDecisions: ["DENY"],
        expectedReasons: [["workspace_disabled"]],
        expectedUploadedCalls: 0,
      },
      {
        name: "seat_disabled",
        seatId: "seat-1",
        policy: makePolicy({
          nowSec,
          seatDefaultMode: "ENABLED",
          seatOverrides: { "seat-1": { mode: "DISABLED" } },
        }),
        calls: 1,
        expectedDecisions: ["DENY"],
        expectedReasons: [["seat_disabled"]],
        expectedUploadedCalls: 0,
      },
      {
        name: "time_not_started",
        seatId: "seat-1",
        policy: makePolicy({
          nowSec,
          workspaceTime: {
            startsAtSec: nowSec + 60,
            expiresAtSec: nowSec + 3600,
            graceUntilSec: nowSec + 7200,
          },
        }),
        calls: 1,
        expectedDecisions: ["DENY"],
        expectedReasons: [["time_not_started"]],
        expectedUploadedCalls: 0,
      },
      {
        name: "time_grace_warning",
        seatId: "seat-1",
        policy: makePolicy({
          nowSec,
          budget: 100,
          workspaceTime: {
            startsAtSec: nowSec - 7200,
            expiresAtSec: nowSec - 1,
            graceUntilSec: nowSec + 3600,
          },
        }),
        calls: 1,
        expectedDecisions: ["ALLOW_WITH_WARNING"],
        expectedReasons: [["time_grace"]],
        expectedUploadedCalls: 1,
      },
      {
        name: "usage_allow_warning_deny",
        seatId: "seat-1",
        policy: makePolicy({ nowSec, budget: 2 }),
        calls: 3,
        expectedDecisions: ["ALLOW", "ALLOW_WITH_WARNING", "DENY"],
        expectedReasons: [[], ["usage_warning"], ["usage_hard_stop"]],
        expectedUploadedCalls: 2,
      },
    ];

    for (const scenario of scenarios) {
      const serverKeys = generateEd25519KeyPair();
      const managementApiKey = "e2e-management-key";
      const fetch = createLicenseFetchHandler({
        signingPrivateKeyPem: serverKeys.privateKeyPem,
        signingPublicKeyPem: serverKeys.publicKeyPem,
        managementApiKey,
      });

      const policyPath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-policy-")),
        "policy.json"
      );
      fs.writeFileSync(policyPath, JSON.stringify(scenario.policy, null, 2));

      const issue = await runCliJson(
        [
          "policy",
          "issue",
          "--server-url",
          "http://local",
          "--api-key",
          managementApiKey,
          "--policy-file",
          policyPath,
        ],
        fetch
      );
      expect(issue.code).toBe(0);
      expect(issue.parsed?.accepted).toBe(true);

      const sync = await runCliJson(
        [
          "policy",
          "sync",
          "--server-url",
          "http://local",
          "--api-key",
          managementApiKey,
          "--workspace-id",
          "ws-gate-e2e",
        ],
        fetch
      );
      expect(sync.code).toBe(0);
      expect(sync.parsed?.notModified).toBe(false);
      const syncedPolicy = sync.parsed?.policy;
      expect(syncedPolicy?.workspaceId).toBe("ws-gate-e2e");

      const bundle = makeRuntimeBundle({
        policy: syncedPolicy,
        seatId: scenario.seatId,
      });
      cleanupFns.push(async () => fs.rmSync(bundle.workDir, { recursive: true, force: true }));

      const build = await runCliJson([
        "bundle",
        "build",
        "--input-dir",
        bundle.inputDir,
        "--bundle-id",
        "gate-test",
        "--version",
        "1.0.0",
        "--output-file",
        bundle.bundlePath,
        "--private-key-file",
        bundle.privateKeyFile,
        "--license-file",
        bundle.licenseFile,
      ]);
      expect(build.code).toBe(0);
      expect(fs.existsSync(bundle.bundlePath)).toBe(true);

      const client = createRuntimeClient({
        bundlePath: bundle.bundlePath,
        publicKeyPath: bundle.publicKeyFile,
      });
      cleanupFns.push(async () => client.close());

      const init = await client.request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      expect(init.result.serverInfo.name).toBe("skillpack-wiki-mcp");

      const decisions = [];
      const reasons = [];
      for (let i = 0; i < scenario.calls; i += 1) {
        const response = await client.request({
          jsonrpc: "2.0",
          id: 10 + i,
          method: "tools/call",
          params: {
            name: "wiki_search",
            arguments: { query: "cybersecurity", limit: 1 },
          },
        });

        if (response.error) {
          const text = String(response.error.message ?? "");
          const reasonText = text.startsWith("policy_denied:")
            ? text.slice("policy_denied:".length)
            : "";
          decisions.push("DENY");
          reasons.push(reasonText ? reasonText.split(",").map((r) => r.trim()) : []);
          continue;
        }

        const policyMeta = response.result?.metadata?.policy;
        if (policyMeta?.decision === "ALLOW_WITH_WARNING") {
          decisions.push("ALLOW_WITH_WARNING");
          reasons.push(policyMeta.reasonCodes ?? []);
        } else {
          decisions.push("ALLOW");
          reasons.push([]);
        }
      }

      expect(decisions).toEqual(scenario.expectedDecisions);
      expect(reasons).toEqual(scenario.expectedReasons);

      await client.close();

      const runtimeEvents = parseToolCallEvents(
        path.join(path.dirname(bundle.bundlePath), "meter.jsonl")
      );
      expect(runtimeEvents.length).toBe(scenario.expectedUploadedCalls);

      const eventsFile = path.join(bundle.workDir, `upload-${scenario.name}.json`);
      fs.writeFileSync(eventsFile, JSON.stringify(runtimeEvents, null, 2));

      const upload = await runCliJson(
        [
          "meter",
          "upload",
          "--server-url",
          "http://local",
          "--api-key",
          managementApiKey,
          "--workspace-id",
          "ws-gate-e2e",
          "--file",
          eventsFile,
        ],
        fetch
      );
      expect(upload.code).toBe(0);
      expect(upload.parsed?.accepted).toBe(true);
      expect(upload.parsed?.ack?.count).toBe(scenario.expectedUploadedCalls);

      const summary = await runCliJson(
        [
          "usage",
          "summary",
          "--server-url",
          "http://local",
          "--api-key",
          managementApiKey,
          "--workspace-id",
          "ws-gate-e2e",
        ],
        fetch
      );
      expect(summary.code).toBe(0);
      const totalCalls =
        summary.parsed?.summary?.reduce((acc, row) => acc + (row.totalCalls ?? 0), 0) ?? 0;
      expect(totalCalls).toBe(scenario.expectedUploadedCalls);
    }
    },
    120_000
  );
});
