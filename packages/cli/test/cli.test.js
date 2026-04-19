import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
