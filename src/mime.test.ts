import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseMime, type MimeParseOptions } from "./mime.js";

async function headers(raw: Uint8Array, options?: MimeParseOptions): Promise<{ headers: { name: string; value: string }[]; truncated: boolean }> {
  const module = await import("./mime.js") as unknown as { parseHeaders: (raw: Uint8Array, options?: MimeParseOptions) => Promise<{ headers: { name: string; value: string }[]; truncated: boolean }> };
  assert.equal(typeof module.parseHeaders, "function", "headers parser must be exported separately");
  return module.parseHeaders(raw, options);
}

test("isolated headers preserve original order, duplicates and unfolded values without body or attachment bytes", async () => {
  const raw = Buffer.from('Received: literal first\r\nReceived: literal second\r\nTo: a@example.test,\r\n\tb@example.test\r\nX-Hostile: <script>do not execute</script> https://invalid.test\r\n\r\nbody-secret attachment-secret');
  assert.deepEqual(await headers(raw), {
    headers: [
      { name: "Received", value: "literal first" },
      { name: "Received", value: "literal second" },
      { name: "To", value: "a@example.test, b@example.test" },
      { name: "X-Hostile", value: "<script>do not execute</script> https://invalid.test" },
    ],
    truncated: false,
  });
});
test("isolated MIME parsing returns only the text body, never parsed headers or attachments", async () => {
  const raw = Buffer.from([
    'Subject: private subject',
    'X-Api-Key: secret-key',
    'Content-Type: multipart/mixed; boundary="fixture"',
    '',
    '--fixture',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Plain fixture body',
    '--fixture',
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="private-path-secret.txt"',
    '',
    'attachment-secret',
    '--fixture--',
  ].join("\r\n"));
  const result = await parseMime(raw);
  assert.deepEqual(result, { body: "Plain fixture body" });
  assert.doesNotMatch(JSON.stringify(result), /private|secret|attachment/);
});

test("worker HTML-only fallback removes markup, hidden content and image URLs", async () => {
  const raw = Buffer.from('Content-Type: text/html; charset=utf-8\r\n\r\n<p>HTML fixture &amp; body</p><script>hidden-secret</script><img src="https://tracker.invalid/pixel"><a href="https://secret.invalid">label</a>');
  const result = await parseMime(raw);
  assert.match(result.body, /HTML fixture & body/);
  assert.match(result.body, /label/);
  assert.doesNotMatch(result.body, /<|hidden-secret|tracker|secret\.invalid/);
});

test("worker returns a visibly truncated body within 64000 characters", async () => {
  const result = await parseMime(Buffer.from("Content-Type: text/plain\r\n\r\n" + "x".repeat(100_000)));
  assert.equal(result.body.length, 64_000);
  assert.match(result.body, /\[TRUNCATED:.*\]$/);
});

test("headers scanner bounds count and bytes with explicit truncation, rejecting giant malformed lines", async () => {
  const countLimited = await headers(Buffer.from(Array.from({ length: 201 }, (_, i) => `X-${i}: value`).join("\r\n") + "\r\n\r\nsecret"));
  assert.equal(countLimited.headers.length, 200);
  assert.equal(countLimited.truncated, true);
  const byteLimited = await headers(Buffer.from(Array.from({ length: 50 }, (_, i) => `X-${i}: ${"x".repeat(1000)}`).join("\r\n") + "\r\n\r\nsecret"));
  assert.equal(byteLimited.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(byteLimited)) < 34_000);
  for (const malformed of ["x".repeat(100_000), "X: " + "x".repeat(8193), " continuation\r\n", "Bad Name: x\r\n", "X: a\rb\r\n", "X: a\u0000b\r\n", "N".repeat(129) + ": x\r\n", "X: " + ("x\r\n ").repeat(5000)]) {
    await assert.rejects(headers(Buffer.from(malformed)), /^Error: Email parsing failed\.$/);
  }
  assert.deepEqual(await headers(Buffer.from("X: one\nX: two\n\nprivate")), { headers: [{ name: "X", value: "one" }, { name: "X", value: "two" }], truncated: false });
});

test("headers preserve non-ASCII whitespace and encoded words as literal untrusted values", async () => {
  assert.deepEqual(await headers(Buffer.from("Subject: =?UTF-8?Q?literal?=\r\nX-Unicode: \u00a0data\u00a0\t\r\n \u00a0fold\u00a0\r\n\r\nbody")), {
    headers: [
      { name: "Subject", value: "=?UTF-8?Q?literal?=" },
      { name: "X-Unicode", value: "\u00a0data\u00a0 \u00a0fold\u00a0" },
    ], truncated: false,
  });
});

test("headers reject invalid UTF8 bytes instead of replacing supposedly literal values", async () => {
  for (const invalid of [Buffer.from([0xe9]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80])]) {
    const raw = Buffer.concat([Buffer.from("X-Secret: UTF8_SECRET "), invalid, Buffer.from("\r\n\r\nbody-secret")]);
    await assert.rejects(headers(raw), /^Error: Email parsing failed\.$/);
  }
  // Valid non-ASCII header values remain literal, and body bytes are not decoded.
  assert.deepEqual(await headers(Buffer.concat([Buffer.from("X-Unicode: café\r\n\r\n"), Buffer.from([0xe9])])), {
    headers: [{ name: "X-Unicode", value: "café" }], truncated: false,
  });
});

test("headers worker replies reject extra fields, malformed entries and every output budget violation", async () => {
  for (const reply of [
    { headers: [], truncated: false, body: "secret" },
    { headers: [], truncated: "false" },
    { headers: [{ name: "X", value: "v", attachments: ["secret"] }], truncated: false },
    { headers: [{ name: "Bad Name", value: "v" }], truncated: false },
    { headers: [{ name: "Bad:Name", value: "v" }], truncated: false },
    { headers: [{ name: "N".repeat(129), value: "v" }], truncated: false },
    { headers: [{ name: "X", value: 123 }], truncated: false },
    { headers: [{ name: "X", value: "a\r\nb" }], truncated: false },
    { headers: [{ name: "X", value: "x".repeat(4097) }], truncated: false },
    { headers: Array.from({ length: 201 }, () => ({ name: "X", value: "v" })), truncated: false },
    { headers: Array.from({ length: 10 }, () => ({ name: "X", value: "x".repeat(4000) })), truncated: false },
    { headers: Array.from({ length: 10 }, () => ({ name: "X", value: "界".repeat(1300) })), truncated: false },
    { headers: [null], truncated: false }, null, { body: "secret" },
  ]) {
    const workerUrl = fixtureWorker(`import { parentPort } from 'node:worker_threads'; parentPort.postMessage(${JSON.stringify(reply)});`);
    await assert.rejects(headers(Buffer.alloc(0), { workerUrl }), /^Error: Email parsing failed\.$/);
  }
  const workerUrl = fixtureWorker("import { parentPort } from 'node:worker_threads'; parentPort.postMessage(Object.assign([], { headers: [], truncated: false }));");
  await assert.rejects(headers(Buffer.alloc(0), { workerUrl }), /^Error: Email parsing failed\.$/);
});

test("headers deadline and shutdown terminate actual CPU-loop workers before settling", async () => {
  const workerUrl = fixtureWorker(`
    import { workerData } from 'node:worker_threads';
    if (workerData.mode !== 'headers') throw new Error('wrong mode');
    const state = new Int32Array(workerData.raw.buffer);
    Atomics.store(state, 0, 1);
    while (true) Atomics.add(state, 1, 1);
  `);
  for (const shutdown of [false, true]) {
    const state = new Int32Array(new SharedArrayBuffer(8));
    const controller = new AbortController();
    const started = performance.now();
    const pending = headers(new Uint8Array(state.buffer), { workerUrl, signal: controller.signal, ...(shutdown ? {} : { timeoutMs: 500 }) });
    const rejected = assert.rejects(pending, /^Error: Email parsing failed\.$/);
    if (shutdown) {
      while (Atomics.load(state, 0) === 0) {
        assert.ok(performance.now() - started < 2000, "headers loop must start");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const abortAt = performance.now();
      controller.abort(new Error("private reason"));
      await rejected;
      assert.ok(performance.now() - abortAt < 500);
    } else {
      await rejected;
      assert.ok(performance.now() - started < 1500);
    }
    assert.equal(Atomics.load(state, 0), 1);
    const stopped = Atomics.load(state, 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(Atomics.load(state, 1), stopped);
  }
});

test("headers use bounded V8 resources and reject pre-aborted work without starting a worker", async () => {
  const workerUrl = fixtureWorker(`
    import { parentPort, resourceLimits } from 'node:worker_threads';
    parentPort.postMessage({ headers: [{ name: 'X-Limits', value: JSON.stringify(resourceLimits) }], truncated: false });
  `);
  const parsed = await headers(Buffer.alloc(0), { workerUrl });
  const limits = JSON.parse(parsed.headers[0].value);
  assert.equal(limits.maxOldGenerationSizeMb, 128);
  assert.equal(limits.maxYoungGenerationSizeMb, 16);
  assert.equal(limits.stackSizeMb, 4);
  const state = new Int32Array(new SharedArrayBuffer(4));
  const markStarted = fixtureWorker(`import { workerData } from 'node:worker_threads'; Atomics.store(new Int32Array(workerData.raw.buffer), 0, 1);`);
  await assert.rejects(headers(new Uint8Array(state.buffer), { workerUrl: markStarted, signal: AbortSignal.abort() }), /^Error: Email parsing failed\.$/);
  assert.equal(Atomics.load(state, 0), 0);
});

function fixtureWorker(source: string): URL {
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

test("deadline terminates an actual CPU-loop worker before rejecting", async () => {
  const state = new Int32Array(new SharedArrayBuffer(8));
  const workerUrl = fixtureWorker(`
    import { workerData } from 'node:worker_threads';
    const state = new Int32Array(workerData.raw.buffer);
    Atomics.store(state, 0, 1);
    while (true) Atomics.add(state, 1, 1);
  `);
  const started = performance.now();
  await assert.rejects(parseMime(new Uint8Array(state.buffer), { workerUrl, timeoutMs: 500 }), /^Error: Email parsing failed\.$/);
  assert.ok(performance.now() - started < 1500);
  assert.equal(Atomics.load(state, 0), 1, "the fixture must actually run its CPU loop");
  const stoppedAt = Atomics.load(state, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(Atomics.load(state, 1), stoppedAt, "rejection must await worker termination");
});

test("shutdown abort terminates a running CPU-loop worker without leaking the abort reason", async () => {
  const state = new Int32Array(new SharedArrayBuffer(8));
  const workerUrl = fixtureWorker(`
    import { workerData } from 'node:worker_threads';
    const state = new Int32Array(workerData.raw.buffer);
    Atomics.store(state, 0, 1);
    while (true) Atomics.add(state, 1, 1);
  `);
  const controller = new AbortController();
  const pending = parseMime(new Uint8Array(state.buffer), { workerUrl, signal: controller.signal });
  const rejected = assert.rejects(pending, /^Error: Email parsing failed\.$/);
  const waiting = performance.now();
  while (Atomics.load(state, 0) === 0) {
    assert.ok(performance.now() - waiting < 2000, "CPU-loop worker must start before its deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const started = performance.now();
  controller.abort(new Error("secret abort reason /private/path"));
  await rejected;
  assert.ok(performance.now() - started < 500, "shutdown must not wait for the parse deadline");
  const stoppedAt = Atomics.load(state, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(Atomics.load(state, 1), stoppedAt);
});

test("workers use explicit bounded V8 heap and stack limits", async () => {
  const workerUrl = fixtureWorker(`
    import { parentPort, resourceLimits } from 'node:worker_threads';
    parentPort.postMessage({ body: JSON.stringify(resourceLimits) });
  `);
  const result = await parseMime(Buffer.alloc(0), { workerUrl });
  const limits = JSON.parse(result.body);
  assert.equal(limits.maxOldGenerationSizeMb, 128);
  assert.equal(limits.maxYoungGenerationSizeMb, 16);
  assert.equal(limits.stackSizeMb, 4);
});

test("worker replies reject metadata and over-budget or non-string body messages", async () => {
  for (const reply of [
    { body: "body", attachments: ["secret-key /private/path"] },
    { body: "x".repeat(64_001) },
    { body: { secret: "secret-key /private/path" } },
    null,
  ]) {
    const workerUrl = fixtureWorker(`import { parentPort } from 'node:worker_threads'; parentPort.postMessage(${JSON.stringify(reply)});`);
    await assert.rejects(parseMime(Buffer.alloc(0), { workerUrl }), /^Error: Email parsing failed\.$/);
  }
});

test("worker crashes, early exit and startup errors have fixed sanitized errors", async () => {
  for (const workerUrl of [
    fixtureWorker(`throw new Error('secret-key /private/path attacker instructions');`),
    fixtureWorker(`process.exit(0);`),
    new URL("https://secret.invalid/private-path"),
  ]) {
    await assert.rejects(parseMime(Buffer.alloc(0), { workerUrl }), /^Error: Email parsing failed\.$/);
  }
});

test("already-aborted parsing rejects before starting its worker", async () => {
  const state = new Int32Array(new SharedArrayBuffer(4));
  const workerUrl = fixtureWorker(`
    import { workerData } from 'node:worker_threads';
    Atomics.store(new Int32Array(workerData.raw.buffer), 0, 1);
  `);
  await assert.rejects(parseMime(new Uint8Array(state.buffer), {
    workerUrl, signal: AbortSignal.abort(new Error("secret abort reason")),
  }), /^Error: Email parsing failed\.$/);
  assert.equal(Atomics.load(state, 0), 0);
});

test("npm package includes the compiled relative worker entrypoint and its dependencies", async () => {
  const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--ignore-scripts", "--offline", "--json"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { files: { path: string }[] }[] | Record<string, { files: { path: string }[] }>;
  // npm 12 keys results by package name; older supported npm versions return an array.
  const [pkg] = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const files = new Set(pkg.files.map((file) => file.path));
  for (const file of ["dist/mime-worker.js", "dist/mime.js", "dist/format.js", "dist/html-safety.js"]) assert.ok(files.has(file), file);
  assert.ok(!files.has("dist/mime.test.js"));
});
