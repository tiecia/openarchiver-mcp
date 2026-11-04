import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseMime } from "./mime.js";
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
