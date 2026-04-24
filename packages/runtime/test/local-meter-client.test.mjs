import { describe, expect, test } from "bun:test";
import http from "node:http";

const { createLocalMeterClient } = await import("../src/local-meter-client.mjs");
const { createMemoryMeterStore } = await import("../src/meter-store.mjs");
const { createDirectUploadTransport } = await import(
  "../src/direct-upload-transport.mjs"
);

describe("createLocalMeterClient", () => {
  test("returns after local append and flushes in the background", async () => {
    const uploads = [];
    let releaseUpload = null;
    const transport = {
      upload(batch) {
        uploads.push(batch);
        return new Promise((resolve) => {
          releaseUpload = resolve;
        });
      },
    };

    const client = createLocalMeterClient({
      chainKey: "ZmFrZS1jaGFpbi1rZXk=",
      leaseToken: "lease-token",
      currentLeaseJti: "lease-1",
      context: { workspaceId: "ws-1" },
      meterStore: createMemoryMeterStore(),
      transport,
      flushIntervalMs: 10,
      retryDelayMs: 10,
      now: () => 1_800_000_100,
    });

    const event = await client.appendAndFlush("tool_call", {
      seatId: "seat-1",
      tool: "wiki_search",
      usage: { unit: "tool_call", delta: 1 },
    });

    expect(event.seq).toBe(0);
    expect(client.getPendingEvents()).toHaveLength(1);
    expect(uploads).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(uploads).toHaveLength(1);
    expect(client.getPendingEvents()).toHaveLength(1);

    releaseUpload();
    await client.flushPending();
    expect(client.getPendingEvents()).toHaveLength(0);
  });

  test("keeps pending events when upload fails and clears them after retry", async () => {
    const uploads = [];
    const store = createMemoryMeterStore();
    let fail = true;
    const transport = {
      async upload(batch) {
        if (fail) throw new Error("offline");
        uploads.push(batch);
      },
    };

    const client = createLocalMeterClient({
      chainKey: "ZmFrZS1jaGFpbi1rZXk=",
      leaseToken: "lease-token",
      currentLeaseJti: "lease-1",
      context: {
        workspaceId: "ws-1",
        providerId: "prov-1",
        customerId: "cust-1",
        skillId: "laws-consultant",
        bundleId: "laws-consultant-1.0.0",
      },
      meterStore: store,
      transport,
      flushIntervalMs: 10,
      retryDelayMs: 10,
      now: () => 1_800_000_100,
    });

    await client.appendAndFlush("tool_call", {
      seatId: "seat-1",
      tool: "wiki_search",
      usage: { unit: "tool_call", delta: 1 },
    });
    expect(client.getPendingEvents()).toHaveLength(1);

    const restarted = createLocalMeterClient({
      chainKey: "ZmFrZS1jaGFpbi1rZXk=",
      leaseToken: "lease-token",
      currentLeaseJti: "lease-1",
      context: {
        workspaceId: "ws-1",
        providerId: "prov-1",
        customerId: "cust-1",
        skillId: "laws-consultant",
        bundleId: "laws-consultant-1.0.0",
      },
      meterStore: store,
      transport,
      flushIntervalMs: 10,
      retryDelayMs: 10,
      now: () => 1_800_000_101,
    });
    expect(restarted.getPendingEvents()).toHaveLength(1);

    fail = false;
    await restarted.flushPending();
    expect(restarted.getPendingEvents()).toHaveLength(0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      leaseToken: "lease-token",
      context: { workspaceId: "ws-1" },
    });
    expect(uploads[0].events).toHaveLength(1);
  });

  test("keeps later events when a new append happens during an in-flight upload", async () => {
    const uploads = [];
    const releaseUploads = [];
    const transport = {
      upload(batch) {
        uploads.push(batch);
        return new Promise((resolve) => {
          releaseUploads.push(resolve);
        });
      },
    };

    const client = createLocalMeterClient({
      chainKey: "ZmFrZS1jaGFpbi1rZXk=",
      leaseToken: "lease-token",
      currentLeaseJti: "lease-1",
      context: { workspaceId: "ws-1" },
      meterStore: createMemoryMeterStore(),
      transport,
      flushIntervalMs: 10,
      retryDelayMs: 10,
      now: () => 1_800_000_100,
    });

    await client.appendAndFlush("tool_call", {
      seatId: "seat-1",
      tool: "wiki_search",
      usage: { unit: "tool_call", delta: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(uploads).toHaveLength(1);

    await client.appendAndFlush("tool_call", {
      seatId: "seat-1",
      tool: "wiki_read_page",
      usage: { unit: "tool_call", delta: 1 },
    });
    expect(client.getPendingEvents()).toHaveLength(2);

    releaseUploads.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseUploads.shift()?.();
    await client.flushPending();
    expect(uploads).toHaveLength(2);
    expect(uploads[0].events).toHaveLength(1);
    expect(uploads[1].events).toHaveLength(1);
    expect(client.getPendingEvents()).toHaveLength(0);
  });

  test("rotates to a fresh chain when the lease changes but preserves old pending batches", async () => {
    const uploads = [];
    const store = createMemoryMeterStore();
    let fail = true;
    const transport = {
      async upload(batch) {
        if (fail) throw new Error("offline");
        uploads.push(batch);
      },
    };

    const firstClient = createLocalMeterClient({
      chainKey: "ZmFrZS1jaGFpbi1rZXktMQ==",
      leaseToken: "lease-token-1",
      currentLeaseJti: "lease-1",
      context: { workspaceId: "ws-1" },
      meterStore: store,
      transport,
      flushIntervalMs: 10,
      retryDelayMs: 10,
      now: () => 1_800_000_100,
    });

    const firstEvent = await firstClient.appendAndFlush("tool_call", {
      seatId: "seat-1",
      tool: "wiki_search",
      usage: { unit: "tool_call", delta: 1 },
    });
    expect(firstEvent.seq).toBe(0);

    const rotatedClient = createLocalMeterClient({
      chainKey: "ZmFrZS1jaGFpbi1rZXktMg==",
      leaseToken: "lease-token-2",
      currentLeaseJti: "lease-2",
      context: { workspaceId: "ws-1" },
      meterStore: store,
      transport,
      flushIntervalMs: 10,
      retryDelayMs: 10,
      now: () => 1_800_000_101,
    });

    expect(rotatedClient.leaseChangedSinceLastSession).toBe(true);
    const rotatedEvent = await rotatedClient.appendAndFlush("tool_call", {
      seatId: "seat-1",
      tool: "wiki_read_page",
      usage: { unit: "tool_call", delta: 1 },
    });
    expect(rotatedEvent.seq).toBe(0);
    expect(rotatedClient.getPendingEvents()).toHaveLength(2);

    fail = false;
    await rotatedClient.flushPending();

    expect(uploads).toHaveLength(2);
    expect(uploads[0].leaseToken).toBe("lease-token-1");
    expect(uploads[1].leaseToken).toBe("lease-token-2");
    expect(rotatedClient.getPendingEvents()).toHaveLength(0);
  });

  test("flushes direct-mode uploads through the server contract expected by /v1/meter/upload", async () => {
    let requestHeaders = null;
    let requestBody = null;
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        requestHeaders = request.headers;
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: true, mode: "direct" }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const client = createLocalMeterClient({
      chainKey: "ZmFrZS1jaGFpbi1rZXk=",
      leaseToken: "lease-token-live",
      currentLeaseJti: "lease-live",
      context: {
        workspaceId: "ws-1",
        providerId: "prov-1",
        customerId: "cust-1",
        skillId: "laws-consultant",
        bundleId: "laws-consultant-1.0.0",
      },
      meterStore: createMemoryMeterStore(),
      transport: createDirectUploadTransport({ baseUrl }),
      flushIntervalMs: 10,
      retryDelayMs: 10,
      now: () => 1_800_000_100,
    });

    try {
      await client.appendAndFlush("tool_call", {
        seatId: "seat-1",
        tool: "wiki_search",
        usage: { unit: "tool_call", delta: 1 },
        workspaceId: "forged-workspace",
      });
      await client.flushPending();
      expect(client.getPendingEvents()).toHaveLength(0);
      expect(requestHeaders["x-skillpack-lease-token"]).toBe("lease-token-live");
      expect(requestBody.context).toBeUndefined();
      expect(requestBody.events).toHaveLength(1);
      expect(requestBody.events[0]).toMatchObject({
        kind: "tool_call",
        seq: 0,
        data: {
          tool: "wiki_search",
          usage: { unit: "tool_call", delta: 1 },
          workspaceId: "forged-workspace",
        },
      });
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
