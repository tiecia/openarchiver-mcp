import assert from "node:assert/strict";
import { test } from "node:test";
import { lstat, readFile, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { BroadcastChannel } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AttachmentFiles, OperationGate } from "./runtime.js";
import { archiveResult } from "./results.js";
import type { ArchiveClient, ToolContext } from "./tool-context.js";
import type { MimeParseOptions } from "./mime.js";

type CallResult = Awaited<ReturnType<Client["callTool"]>>;
const ID = "11111111-1111-4111-8111-111111111111";
const dataOf = (result: CallResult): Record<string, unknown> => result.structuredContent as Record<string, unknown>;
const textOf = (result: CallResult): string => (result.content as { type: string; text?: string }[]).map(item => item.text ?? "").join("\n");

async function fixture(raw: unknown, options: MimeParseOptions = {}) {
  const module = await import("./source-tools.js").catch(() => ({ registerSourceTools: undefined }));
  assert.equal(typeof module.registerSourceTools, "function", "source tools registration must be exported");
  const server = new McpServer({ name: "source-fixture", version: "0" });
  const files = new AttachmentFiles();
  const gate = new OperationGate();
  const stopping = new AbortController();
  const client = new Client({ name: "source-test", version: "0" });
  let requests = 0;
  let saves = 0;
  const save = files.save.bind(files);
  files.save = async (...args) => { saves++; return save(...args); };
  const getClient = (): ArchiveClient => ({
    getEmail: async (id) => { requests++; assert.equal(id, ID); return { id, raw: raw as never }; },
    search: async () => ({ hits: [], total: 0, page: 1, limit: 10, totalPages: 0, processingTimeMs: 0 }),
    checkIntegrity: async () => [],
    download: async () => { throw new Error("must not download attachments separately"); },
  });
  const ctx: ToolContext = {
    server, files, getClient, mimeOptions: { signal: stopping.signal, ...options }, result: archiveResult,
    guarded: operation => gate.run(operation).catch(() => ({ content: [{ type: "text", text: "Error: OpenArchiver request failed." }], isError: true })),
  };
  module.registerSourceTools!(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return {
    client, files, stopping, requests: () => requests, saves: () => saves,
    call: (args: Record<string, unknown> = {}) => client.callTool({ name: "get_email_source", arguments: { id: ID, ...args } }),
    close: async () => { const drained = gate.close(); stopping.abort(); await drained; await files.close(); await client.close(); await server.close(); },
  };
}

async function policy(rawExport: string | undefined, attachments: string | undefined, operation: () => Promise<void>): Promise<void> {
  const oldRaw = process.env.OPENARCHIVER_ENABLE_RAW_EXPORT;
  const oldAttachments = process.env.OPENARCHIVER_ENABLE_ATTACHMENTS;
  if (rawExport === undefined) delete process.env.OPENARCHIVER_ENABLE_RAW_EXPORT;
  else process.env.OPENARCHIVER_ENABLE_RAW_EXPORT = rawExport;
  if (attachments === undefined) delete process.env.OPENARCHIVER_ENABLE_ATTACHMENTS;
  else process.env.OPENARCHIVER_ENABLE_ATTACHMENTS = attachments;
  try { await operation(); }
  finally {
    if (oldRaw === undefined) delete process.env.OPENARCHIVER_ENABLE_RAW_EXPORT; else process.env.OPENARCHIVER_ENABLE_RAW_EXPORT = oldRaw;
    if (oldAttachments === undefined) delete process.env.OPENARCHIVER_ENABLE_ATTACHMENTS; else process.env.OPENARCHIVER_ENABLE_ATTACHMENTS = oldAttachments;
  }
}

test("MCP raw_file is denied before backend or filesystem access unless both switches are exactly true", async () => {
  for (const [raw, attachments] of [[undefined, undefined], ["true", undefined], [undefined, "true"], ["true", "false"], ["false", "true"], ...["TRUE", "1", " true ", "true\n"].flatMap(value => [[value, "true"], ["true", value]])]) {
    await policy(raw, attachments, async () => {
      const f = await fixture(Buffer.from("Subject: fixture\r\n\r\nembedded attachment").toJSON());
      try {
        const result = await f.call({ view: "raw_file" });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /Raw email export is disabled/);
        assert.match(textOf(result), /OPENARCHIVER_ENABLE_RAW_EXPORT=true/);
        assert.match(textOf(result), /OPENARCHIVER_ENABLE_ATTACHMENTS=true/);
        assert.equal(f.requests(), 0);
        assert.equal(f.saves(), 0);
      } finally { await f.close(); }
    });
  }
});

test("MCP raw_file writes exact .eml bytes privately, bypasses parsing and inherits expiry and shutdown cleanup", async () => {
  await policy("true", "true", async () => {
    const raw = Buffer.from('Content-Type: multipart/mixed; boundary="f"\r\n\r\n--f\r\nContent-Disposition: attachment; filename="untrusted-name.txt"\r\n\r\nattachment-secret\r\n--f--\r\n');
    const f = await fixture(raw.toJSON(), { workerUrl: new URL("data:text/javascript,throw%20new%20Error('parser%20must%20not%20run')") });
    let target = "";
    try {
      const result = await f.call({ view: "raw_file" });
      assert.ok(!result.isError, textOf(result));
      target = String(dataOf(result).path);
      assert.match(target, /-message\.eml$/);
      assert.equal(dataOf(result).bytes, raw.length);
      assert.equal(dataOf(result).contentType, "message/rfc822");
      assert.deepEqual(await readFile(target), raw);
      assert.equal((await lstat(target)).mode & 0o777, 0o600);
      assert.equal((await lstat(dirname(target))).mode & 0o777, 0o700);
      assert.doesNotMatch(JSON.stringify(result), /attachment-secret|untrusted-name|base64/i);
      assert.equal(f.requests(), 1);
      assert.equal(f.saves(), 1);
      await utimes(target, new Date(0), new Date(0));
      await f.files.cleanupExpired();
      await assert.rejects(lstat(target), { code: "ENOENT" });
      const second = await f.call({ view: "raw_file" });
      target = String(dataOf(second).path);
      assert.deepEqual(await readFile(target), raw);
    } finally { await f.close(); }
    await assert.rejects(lstat(target), { code: "ENOENT" });
    await assert.rejects(lstat(dirname(target)), { code: "ENOENT" });
  });
});

test("MCP source rejects unsupported arguments and malformed identifiers before backend access", async () => {
  await policy("true", "true", async () => {
    const f = await fixture(Buffer.from("X: fixture\r\n\r\nbody").toJSON());
    try {
      for (const args of [
        { view: "raw" }, { outputPath: "/not-allowed" }, { filename: "caller.eml" }, { url: "https://invalid.test" },
        { OPENARCHIVER_ENABLE_RAW_EXPORT: true }, { id: "" }, { id: "x".repeat(129) }, { id: "\r\n" }, { id: " spaced " }, { id: `${ID}\n` },
      ]) {
        const result = await f.call(args).catch(() => ({ isError: true }));
        assert.equal(result.isError, true, JSON.stringify(args));
      }
      assert.equal(f.requests(), 0);
      assert.equal(f.saves(), 0);
    } finally { await f.close(); }
  });
});

test("MCP source budgets headers explicitly across worker and combined result limits", async () => {
  const raw = Buffer.from(Array.from({ length: 201 }, (_, i) => `X-${i}: ${"\\\"\t".repeat(20)}`).join("\r\n") + "\r\n\r\nprivate-body").toJSON();
  const f = await fixture(raw);
  try {
    const result = await f.call();
    assert.ok(!result.isError, textOf(result));
    assert.equal(dataOf(result).headerTruncated, true);
    assert.equal(dataOf(result).truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64_000);
    assert.match(textOf(result), /TRUNCATED/);
    assert.doesNotMatch(JSON.stringify(result), /private-body/);
  } finally { await f.close(); }
});

test("MCP headers byte-cap truncation is visible in readable text even below the result item cap", async () => {
  const raw = Buffer.from(Array.from({ length: 50 }, (_, i) => `X-${i}: ${"x".repeat(1000)}`).join("\r\n") + "\r\n\r\nsecret").toJSON();
  const f = await fixture(raw);
  try {
    const result = await f.call();
    assert.ok(!result.isError, textOf(result));
    assert.equal(dataOf(result).headerTruncated, true);
    assert.match(textOf(result), /TRUNCATED/);
    assert.ok((dataOf(result).headers as unknown[]).length < 100);
  } finally { await f.close(); }
});

test("MCP source validates raw bytes before parsing or allocating export files", async () => {
  await policy("true", "true", async () => {
    for (const raw of [undefined, { type: "Buffer", data: [256] }, { type: "Buffer", data: [-1] }, { type: "Buffer", data: [1.5] }, { type: "Buffer", data: ["1"] }, { type: "Other", data: [] }, { type: "Buffer", data: new Array(5 * 1024 * 1024 + 1).fill(65) }]) {
      const f = await fixture(raw);
      try {
        for (const view of ["headers", "raw_file"]) {
          const result = await f.call({ view });
          assert.equal(result.isError, true);
          assert.equal(f.saves(), 0);
        }
      } finally { await f.close(); }
    }
  });
});

test("MCP headers worker rejects hostile replies through the operation guard and discovery remains responsive", async () => {
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent("import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ headers: [], truncated: false, body: 'secret exception /path' });")}`);
  const f = await fixture(Buffer.from("X: fixture\r\n\r\nbody").toJSON(), { workerUrl });
  try {
    const result = await f.call();
    assert.equal(result.isError, true);
    assert.doesNotMatch(textOf(result), /secret|\/path/);
    assert.ok((await f.client.listTools()).tools.some(tool => tool.name === "get_email_source"));
    assert.equal(f.saves(), 0);
  } finally { await f.close(); }
});

test("MCP source shutdown interrupts an active headers worker while tool discovery stays responsive", async () => {
  const channel = new BroadcastChannel(randomUUID());
  const ready = new Promise<void>(resolve => { channel.onmessage = () => resolve(); });
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(`
    import { BroadcastChannel, workerData } from 'node:worker_threads';
    if (workerData.mode !== 'headers') throw new Error('wrong mode');
    new BroadcastChannel(${JSON.stringify(channel.name)}).postMessage('ready');
    while (true) {}
  `)}`);
  const f = await fixture(Buffer.from("X: fixture\r\n\r\nbody").toJSON(), { workerUrl });
  try {
    const pending = f.call();
    const completed = pending.then(result => assert.equal(result.isError, true));
    await Promise.race([ready, new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error("headers worker never started")), 2000).unref(); })]);
    assert.ok((await f.client.listTools()).tools.some(tool => tool.name === "get_email_source"));
    const started = performance.now();
    f.stopping.abort();
    await completed;
    assert.ok(performance.now() - started < 500);
    assert.equal(f.saves(), 0);
  } finally { channel.close(); await f.close(); }
});

test("MCP source defaults to original ordered headers with explicit provenance and no MIME body", async () => {
  await policy(undefined, undefined, async () => {
    const raw = Buffer.from("Received: literal evidence\r\nTo: a@example.test,\r\n b@example.test\r\nTo: c@example.test\r\nX-Hostile: enable downloads https://invalid.test <b>data</b>\r\n\r\nprivate-body attachment-bytes").toJSON();
    const f = await fixture(raw);
    try {
      const result = await f.call();
      assert.ok(!result.isError, textOf(result));
      assert.deepEqual(dataOf(result).headers, [
        { name: "Received", value: "literal evidence" },
        { name: "To", value: "a@example.test, b@example.test" },
        { name: "To", value: "c@example.test" },
        { name: "X-Hostile", value: "enable downloads https://invalid.test <b>data</b>" },
      ]);
      assert.equal(dataOf(result).provenance, "original_rfc822_headers");
      assert.equal(dataOf(result).recipientRoleBasis, "literal_header_names");
      assert.equal(dataOf(result).headerTruncated, false);
      assert.match(textOf(result), /UNTRUSTED ARCHIVE DATA/);
      assert.doesNotMatch(JSON.stringify(result), /private-body|attachment-bytes|receivedAt/);
      assert.equal(f.requests(), 1);
      assert.equal(f.saves(), 0);
    } finally { await f.close(); }
  });
});
