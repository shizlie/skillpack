import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createMeterChainKey,
  generateEd25519KeyPair,
  verifyMeterChain,
} from "../packages/crypto/src/index.js";
import { runSkillpackCli } from "../packages/cli/src/index.js";
import { createLicenseFetchHandler } from "../packages/license-server/src/index.js";
import { createSqliteLeaseStore } from "../packages/license-server/src/storage-sqlite.js";
import {
  createRuntimeMeter,
  executeWithRuntimeLease,
  verifyLeaseForRuntime,
} from "../packages/runtime/src/index.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-e2e-keys-"));
  const keys = generateEd25519KeyPair();
  const privateKeyFile = path.join(dir, "private.pem");
  const publicKeyFile = path.join(dir, "public.pem");
  fs.writeFileSync(privateKeyFile, keys.privateKeyPem);
  fs.writeFileSync(publicKeyFile, keys.publicKeyPem);
  return { dir, keys, privateKeyFile, publicKeyFile };
}

function createJsonRpcLineClient({ wikiDir }) {
  const scriptPath = path.resolve("packages/wiki-mcp/src/cli.js");
  const proc = spawn("bun", [scriptPath, `--wiki-dir=${wikiDir}`], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr.on("data", () => {});

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
      next.resolve(JSON.parse(line));
    }
  });

  async function request(message) {
    const payload = `${JSON.stringify(message)}\n`;
    proc.stdin.write(payload);
    return await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(
        () => reject(new Error("mcp_client_timeout")),
        5000
      );
      queue.push({ resolve, reject });
      queue[queue.length - 1].resolve = (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      };
      queue[queue.length - 1].reject = (error) => {
        clearTimeout(timeoutId);
        reject(error);
      };
    });
  }

  async function close() {
    if (!proc.killed) proc.kill("SIGTERM");
  }

  return { request, close };
}

const cleanupFns = [];
afterAll(async () => {
  for (const fn of cleanupFns.reverse()) {
    await fn();
  }
});

describe("full journey e2e", () => {
  test("journey A: license issue/verify/runtime works", async () => {
    const { privateKeyFile, publicKeyFile } = writeKeys();
    const issueIo = makeIo();
    const issueCode = await runSkillpackCli(
      [
        "license",
        "issue",
        "--customer-id",
        "cust-e2e-a",
        "--seat-id",
        "seat-a",
        "--private-key-file",
        privateKeyFile,
        "--public-key-file",
        publicKeyFile,
        "--now-sec",
        "1800000000",
      ],
      issueIo.io
    );
    expect(issueCode).toBe(0);
    const issued = JSON.parse(issueIo.read().out);
    expect(typeof issued.leaseToken).toBe("string");

    const verifyIo = makeIo();
    const verifyCode = await runSkillpackCli(
      [
        "license",
        "verify",
        "--lease-token",
        issued.leaseToken,
        "--public-key-file",
        publicKeyFile,
        "--now-sec",
        "1800000300",
      ],
      verifyIo.io
    );
    expect(verifyCode).toBe(0);
    const verified = JSON.parse(verifyIo.read().out);
    expect(verified.valid).toBe(true);

    const chainKey = createMeterChainKey();
    const meter = createRuntimeMeter({ chainKey });
    const out = await executeWithRuntimeLease({
      leaseToken: issued.leaseToken,
      publicKeyPem: fs.readFileSync(publicKeyFile, "utf8"),
      nowSec: 1_800_000_100,
      meter,
      run: async () => ({ ok: true }),
    });
    expect(out.mode).toBe("active");
    expect(verifyMeterChain(meter.getEvents(), chainKey)).toBe(true);
  });

  test("journey B: TSA outage manual-attestation flow works end-to-end", async () => {
    const { keys, privateKeyFile, publicKeyFile } = writeKeys();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-e2e-lease-store-"));
    const dbPath = path.join(dir, "lease-store.sqlite");
    const store = createSqliteLeaseStore({ dbPath });
    cleanupFns.push(async () => store.close?.());

    const mgmtKey = "test-e2e-journey-b-key";
    const fetch = createLicenseFetchHandler({
      signingPrivateKeyPem: keys.privateKeyPem,
      signingPublicKeyPem: keys.publicKeyPem,
      leaseStore: store,
      managementApiKey: mgmtKey,
    });

    const issueIo = makeIo();
    const issueCode = await runSkillpackCli(
      [
        "license",
        "issue",
        "--customer-id",
        "cust-e2e-b",
        "--seat-id",
        "seat-b",
        "--private-key-file",
        privateKeyFile,
        "--public-key-file",
        publicKeyFile,
        "--now-sec",
        "1800000000",
        "--last-tsa-token-at-sec",
        String(1_800_000_000 - 8 * 24 * 60 * 60),
      ],
      issueIo.io
    );
    expect(issueCode).toBe(0);
    const issued = JSON.parse(issueIo.read().out);
    expect(issued.tsaState.status).toBe("expired");

    const attestIo = makeIo();
    const attestCode = await runSkillpackCli(
      [
        "tsa",
        "manual-attest",
        "--server-url",
        "http://local",
        "--api-key",
        mgmtKey,
        "--customer-id",
        "cust-e2e-b",
        "--seat-id",
        "seat-b",
        "--operator-id",
        "op-e2e",
        "--ticket-id",
        "INC-E2E-1",
        "--reason",
        "Manual attestation submitted during upstream TSA outage",
        "--attested-at-sec",
        "1800000005",
      ],
      attestIo.io,
      { fetchImpl: fetch }
    );
    expect(attestCode).toBe(0);

    const latestIo = makeIo();
    const latestCode = await runSkillpackCli(
      [
        "tsa",
        "latest-attestation",
        "--server-url",
        "http://local",
        "--api-key",
        mgmtKey,
        "--customer-id",
        "cust-e2e-b",
        "--seat-id",
        "seat-b",
      ],
      latestIo.io,
      { fetchImpl: fetch }
    );
    expect(latestCode).toBe(0);
    const latest = JSON.parse(latestIo.read().out);
    expect(latest.record.ticketId).toBe("INC-E2E-1");

    const lease = verifyLeaseForRuntime({
      leaseToken: issued.leaseToken,
      publicKeyPem: fs.readFileSync(publicKeyFile, "utf8"),
      nowSec: 1_800_000_010,
      tsaPolicy: {
        lastTsaTokenAtSec: 1_800_000_000 - 8 * 24 * 60 * 60,
        manualAttestation: latest.record,
        maxManualAttestationAgeSec: 24 * 60 * 60,
      },
    });
    expect(lease.tsa.status).toBe("expired");
    expect(lease.tsa.manualAttestationUsed).toBe(true);
  });

  test("journey C: wiki MCP stdio flow works", async () => {
    const wikiDir = path.resolve("verticals/laws-consultant/wiki");
    const client = createJsonRpcLineClient({ wikiDir });
    cleanupFns.push(async () => client.close());

    const init = await client.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(init.result.serverInfo.name).toBe("skillpack-wiki-mcp");

    const tools = await client.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(tools.result.tools.some((t) => t.name === "wiki_search")).toBe(true);

    const resources = await client.request({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/list",
      params: {},
    });
    expect(resources.result.resources.some((r) => r.uri === "wiki://index")).toBe(true);

    const search = await client.request({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "wiki_search",
        arguments: { query: "cybersecurity", limit: 3 },
      },
    });
    expect(search.result.isError).toBe(false);
    expect(search.result.content[0].text.length).toBeGreaterThan(0);

    const read = await client.request({
      jsonrpc: "2.0",
      id: 5,
      method: "resources/read",
      params: { uri: "wiki://index" },
    });
    expect(read.result.contents[0].text).toContain("# Laws Consultant Wiki Index");
  });
});
