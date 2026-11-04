import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AttachmentFiles, OperationGate, validateRawEmail } from "./runtime.js";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

test("exclusive filename collisions never overwrite or remove the existing file", async (t) => {
  const files = new AttachmentFiles();
  const original = crypto.randomUUID;
  t.mock.method(crypto, "randomUUID", () => "00000000-0000-4000-8000-000000000000");
  syncBuiltinESMExports();
  try {
    const first = await files.save(Buffer.from("original"), "same.txt");
    await assert.rejects(files.save(Buffer.from("replacement"), "same.txt"));
    assert.equal(await readFile(first, "utf8"), "original");
  } finally {
    t.mock.restoreAll();
    crypto.randomUUID = original;
    syncBuiltinESMExports();
    await files.close();
  }
});

test("raw MIME byte validation accepts the exact five-MiB boundary and absent raw data", () => {
  assert.equal(validateRawEmail(null), undefined);
  assert.equal(validateRawEmail(undefined), undefined);
  const data = Array(5 * 1024 * 1024).fill(255);
  assert.equal(validateRawEmail({ type: "Buffer", data }), data);
  for (const byte of [NaN, Infinity, undefined, true, {}, -0.1]) {
    assert.throws(() => validateRawEmail({ type: "Buffer", data: [byte] }));
  }
});

test("handoff slots do not start queued work after shutdown begins", async () => {
  const gate = new OperationGate();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let finishFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { finishFirst = resolve; });
  const first = gate.run(() => firstBlocked);
  const second = gate.run(async () => { await blocked; });
  let ran = false;
  const queued = gate.run(async () => { ran = true; });
  const rejected = assert.rejects(queued);
  // The gate's first-promise reaction transfers a slot, then the next reaction
  // closes it before the queued callback's continuation can resume.
  const closed = firstBlocked.then(() => gate.close());
  finishFirst();
  release();
  await Promise.all([first, second, rejected, closed]);
  assert.equal(ran, false);
});

test("raw MIME validation rejects sparse arrays rather than silently zero-filling holes", () => {
  assert.throws(() => validateRawEmail({ type: "Buffer", data: Array(2) }));
});

test("replaced private-directory symlinks are rejected before writes or expiry traversal", async () => {
  const files = new AttachmentFiles();
  const first = await files.save(Buffer.from("original"), "first");
  const directory = dirname(first);
  const moved = `${directory}-moved`;
  const outside = await mkdtemp(join(tmpdir(), "oa-outside-"));
  await rename(directory, moved);
  await symlink(outside, directory);
  try {
    await assert.rejects(files.save(Buffer.from("escape"), "escape"));
    await assert.rejects(files.cleanupExpired());
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(directory);
    await rename(moved, directory);
    await files.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test("temp storage caps file count even for empty downloads", async () => {
  const files = new AttachmentFiles();
  try {
    const results = await Promise.allSettled(Array.from({ length: 101 }, () => files.save(Buffer.alloc(0), "empty")));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 100);
  } finally { await files.close(); }
});

test("closing the operation gate rejects queued work and waits for active work", async () => {
  const gate = new OperationGate();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let finished = false;
  let queuedRan = false;
  const active = gate.run(async () => { await blocked; finished = true; });
  const second = gate.run(async () => { await blocked; });
  const queued = gate.run(async () => { queuedRan = true; });
  const rejected = assert.rejects(queued);
  const closing = gate.close();
  await rejected;
  await assert.rejects(gate.run(async () => {}));
  assert.equal(finished, false);
  release();
  await Promise.all([active, second, closing]);
  assert.equal(finished, true);
  assert.equal(queuedRan, false);
});

test("temp storage reserves concurrent writes within a fixed 100 MiB total budget", async () => {
  const files = new AttachmentFiles();
  const block = Buffer.alloc(10 * 1024 * 1024);
  try {
    const results = await Promise.allSettled(Array.from({ length: 11 }, () => files.save(block, "data.bin")));
    const saved = results.filter((result) => result.status === "fulfilled");
    assert.equal(saved.length, 10);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const dir = dirname((saved[0] as PromiseFulfilledResult<string>).value);
    const names = await readdir(dir);
    const sizes = await Promise.all(names.map(async (name) => (await lstat(join(dir, name))).size));
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), 100 * 1024 * 1024);
  } finally { await files.close(); }
});

test("expired files are removed at fifteen minutes without touching fresh files", async () => {
  const files = new AttachmentFiles();
  const expired = await files.save(Buffer.from("old"), "old.txt");
  const fresh = await files.save(Buffer.from("fresh"), "fresh.txt");
  try {
    const then = new Date(Date.now() - 15 * 60 * 1000 - 1);
    await utimes(expired, then, then);
    // Explicit sweep also supports deterministic expiry tests without a 15-minute wait.
    await files.cleanupExpired();
    await assert.rejects(lstat(expired));
    assert.equal(await readFile(fresh, "utf8"), "fresh");
  } finally { await files.close(); }
});

test("overlapping expiry and saves release each quota reservation only once", async () => {
  const files = new AttachmentFiles();
  const block = Buffer.alloc(10 * 1024 * 1024);
  try {
    const old = await Promise.all(Array.from({ length: 10 }, () => files.save(block, "old.bin")));
    const then = new Date(Date.now() - 16 * 60 * 1000);
    await Promise.all(old.map(path => utimes(path, then, then)));
    const results = await Promise.allSettled([
      files.cleanupExpired(), files.cleanupExpired(),
      ...Array.from({ length: 11 }, () => files.save(block, "fresh.bin")),
    ]);
    const saved = results.slice(2).filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled");
    assert.equal(saved.length, 10);
    assert.equal((await readdir(dirname(saved[0].value))).length, 10);
  } finally { await files.close(); }
});

test("temp storage rejects symlinked TMPDIR and insecure non-sticky parents", async () => {
  const root = await mkdtemp(join(tmpdir(), "oa-files-test-"));
  const original = process.env.TMPDIR;
  try {
    const link = `${root}-link`;
    await symlink(root, link);
    process.env.TMPDIR = link;
    await assert.rejects(new AttachmentFiles().save(Buffer.from("x"), "file.txt"));
    await rm(link);
    await chmod(root, 0o777);
    process.env.TMPDIR = root;
    await assert.rejects(new AttachmentFiles().save(Buffer.from("x"), "file.txt"));
  } finally {
    if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original;
    await rm(`${root}-link`, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
