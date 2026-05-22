import { after, before, describe, test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { generateEd25519KeyPair } from "@skillpack/crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";

async function waitForPort(port, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      if (res.ok) return;
    } catch {}
    await setTimeout(200);
  }
  throw new Error(`Server did not start on port ${port} within ${timeoutMs}ms`);
}

async function getOpenPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

if (typeof Bun === "undefined") describe("self-hosted server", () => {
  let baseUrl;
  let server;
  let stderr = "";

  before(async () => {
    const port = await getOpenPort();
    const keys = generateEd25519KeyPair();

    server = spawn(
      process.execPath,
      ["src/cli.js", "--port", String(port), "--db", ":memory:", "--api-key", "test-api-key"],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          SKILLPACK_SIGNING_PRIVATE_KEY_PEM: keys.privateKeyPem,
          SKILLPACK_SIGNING_PUBLIC_KEY_PEM: keys.publicKeyPem,
        },
        stdio: ["ignore", "ignore", "pipe"],
      }
    );
    server.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    try {
      await waitForPort(port);
    } catch (error) {
      throw new Error(`${error.message}\n${stderr}`);
    }
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server?.kill();
  });

  test("serves health and protects management routes with the shared key", async () => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.strictEqual(health.status, 200, stderr);
    assert.deepStrictEqual(await health.json(), { status: "ok", mode: "self-hosted" });

    const unauthorized = await fetch(`${baseUrl}/v1/providers`);
    assert.strictEqual(unauthorized.status, 401, stderr);

    const authorized = await fetch(`${baseUrl}/v1/providers`, {
      headers: { "x-api-key": "test-api-key" },
    });
    assert.strictEqual(authorized.status, 200, stderr);
    assert.deepStrictEqual(await authorized.json(), { providers: [] });
  });
});
