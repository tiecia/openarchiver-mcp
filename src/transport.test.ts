import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { OpenArchiverClient, OpenArchiverError } from "./client.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function clientWith(response: Response): OpenArchiverClient {
  return new OpenArchiverClient("https://host/api/v1", "test-secret", async () => response);
}

describe("bounded secure transport", () => {
  it("does not trust a stream exception merely named OpenArchiverError", async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.error(new OpenArchiverError("private-secret")); },
    }));
    await assert.rejects(clientWith(response).download("a/b"), (error: unknown) => error instanceof OpenArchiverError && error.message === "Failed to read OpenArchiver response body.");
  });
  it("checks Content-Length for identity-encoded bodies", async () => {
    const response = new Response("{}", { headers: { "content-length": "1", "content-encoding": "identity" } });
    await assert.rejects(clientWith(response).search({ keywords: "x" }), /Content-Length/);
  });
  it("rejects a nonzero Content-Length with no body", async () => {
    await assert.rejects(clientWith(new Response(null, { headers: { "content-length": "2" } })).download("a/b"), /Content-Length/);
  });
  it("bounds decoded bodies without comparing compressed Content-Length to decoded bytes", async () => {
    const compressed = gzipSync(Buffer.from('{"hits":[]}'));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length });
      res.end(compressed);
    });
    const base = await listen(server);
    try {
      const client = new OpenArchiverClient(base, "key", fetch, 2000, { allowHttpLoopback: true });
      assert.deepEqual(await client.search({ keywords: "x" }), { hits: [] });
    } finally { await close(server); }
  });
  it("sanitizes stream read failures and attempts cancellation", async () => {
    for (const operation of ["search", "download"] as const) {
      let cancelled = false;
      const response = new Response("unused");
      Object.defineProperty(response, "body", { value: {
        getReader() { return {
          read: async () => { throw new Error("private-secret stream failure"); },
          cancel: async () => { cancelled = true; },
          releaseLock() {},
        }; },
      } });
      const client = clientWith(response);
      await assert.rejects(operation === "search" ? client.search({ keywords: "x" }) : client.download("a/b"), (error: unknown) => {
        assert.ok(error instanceof OpenArchiverError);
        assert.equal(error.message, "Failed to read OpenArchiver response body.");
        return true;
      });
      assert.equal(cancelled, true);
    }
  });
  it("rejects unsafe download limits before fetching", async () => {
    let fetched = 0;
    const client = new OpenArchiverClient("https://host", "key", async () => { fetched++; return new Response("x"); });
    for (const limit of [0, -1, 1.5, NaN, Infinity, 10485761, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(client.download("a/b", limit), /maxBytes must be a safe positive integer no greater than 10485760/);
    }
    assert.equal(fetched, 0);
  });
  it("enforces a caller's smaller attachment byte cap", { timeout: 1000 }, async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(5)); },
      cancel() { cancelled = true; },
    }));
    await assert.rejects(clientWith(response).download("a/b", 4), /Response exceeds the 4 byte limit/);
    assert.equal(cancelled, true);
    assert.equal((await clientWith(new Response("1234")).download("a/b", 4)).bytes.length, 4);
  });
  it("rejects misleading Content-Length rather than trusting the header", async () => {
    for (const length of ["0", "1", "3"]) {
      await assert.rejects(clientWith(new Response("{}", { headers: { "content-length": length } })).search({ keywords: "x" }), /Content-Length/);
      await assert.rejects(clientWith(new Response("ab", { headers: { "content-length": length } })).download("a/b"), /Content-Length/);
    }
  });
  it("rejects malformed or over-cap Content-Length before reading and cancels", { timeout: 1000 }, async () => {
    for (const operation of ["search", "download"] as const) {
      for (const length of ["-1", "1.5", "1e3", "NaN", "3, 3", "9007199254740992", "33554433"]) {
        let cancelled = false;
        const response = new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode("{}")); },
          cancel() { cancelled = true; },
        }), { headers: { "content-length": length } });
        const client = clientWith(response);
        await assert.rejects(operation === "search" ? client.search({ keywords: "x" }) : client.download("a/b"), OpenArchiverError);
        assert.equal(cancelled, true, `${operation}: ${length}`);
      }
    }
  });
  it("bounds chunked attachments to the fixed 10 MiB cap and cancels overflow", async () => {
    let sent = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const response = new Response(new ReadableStream({
      pull(controller) { if (sent++ < 12) controller.enqueue(chunk); else controller.close(); },
      cancel() { cancelled = true; },
    }));
    await assert.rejects(clientWith(response).download("a/b"), /Response exceeds the 10485760 byte limit/);
    assert.equal(cancelled, true);
  });
  it("rejects chunked JSON over 32 MiB and cancels each JSON endpoint body", async () => {
    for (const operation of ["search", "getEmail", "checkIntegrity"] as const) {
      let sent = 0;
      let cancelled = false;
      const chunk = new Uint8Array(1024 * 1024).fill(32);
      const response = new Response(new ReadableStream({
        pull(controller) {
          if (sent++ < 33) controller.enqueue(chunk);
          else { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }
        },
        cancel() { cancelled = true; },
      }));
      const client = clientWith(response);
      const promise = operation === "search" ? client.search({ keywords: "x" }) : client[operation]("id");
      await assert.rejects(promise, /Response exceeds the 33554432 byte limit/);
      assert.equal(cancelled, true);
    }
  });
  it("sanitizes malformed JSON parse errors for every JSON endpoint", async () => {
    for (const operation of ["search", "getEmail", "checkIntegrity"] as const) {
      const client = clientWith(new Response('private-secret invalid JSON'));
      const promise = operation === "search" ? client.search({ keywords: "x" }) : client[operation]("id");
      await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof OpenArchiverError);
        assert.equal(error.message, "Invalid JSON response from OpenArchiver.");
        return true;
      });
    }
  });
  it("discards and cancels error bodies without reflecting secrets", { timeout: 1000 }, async () => {
    for (const status of [302, 403, 500]) {
      let cancelled = false;
      const response = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("test-secret private archive body")); },
        cancel() { cancelled = true; },
      }), { status });
      await assert.rejects(clientWith(response).search({ keywords: "private" }), (error: unknown) => {
        assert.ok(error instanceof OpenArchiverError);
        assert.equal(error.status, status);
        assert.doesNotMatch(error.message, /test-secret|private archive/);
        if (status === 403) assert.match(error.message, /OPENARCHIVER_API_KEY/);
        return true;
      });
      assert.equal(cancelled, true);
    }
  });
  it("does not expose fetch exception secrets", async () => {
    const client = new OpenArchiverClient("https://host", "test-secret", async () => { throw new Error("test-secret https://private-host/private-query"); });
    await assert.rejects(client.search({ keywords: "private" }), (error: unknown) => {
      assert.ok(error instanceof OpenArchiverError);
      assert.equal(error.message, "Request to OpenArchiver failed. Check connectivity and request timeout.");
      return true;
    });
  });
  it("does not forward the API key to a real loopback redirect target", async () => {
    const leaked: string[] = [];
    const sink = createServer((req, res) => { leaked.push(String(req.headers["x-api-key"])); res.end("{}"); });
    const sinkBase = await listen(sink);
    const source = createServer((_req, res) => { res.writeHead(302, { location: `${sinkBase}/capture` }); res.end(); });
    const base = await listen(source);
    try {
      const client = new OpenArchiverClient(base, "synthetic-redirect-secret", fetch, 2000, { allowHttpLoopback: true });
      await assert.rejects(client.search({ keywords: "private" }), OpenArchiverError);
      assert.deepEqual(leaked, []);
    } finally {
      await Promise.all([close(source), close(sink)]);
    }
  });
});
