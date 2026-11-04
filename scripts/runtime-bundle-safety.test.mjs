import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { validateRuntimeTree, runtimeDocuments } from "./build-runtime-bundle.mjs";

test("bundle documents match the maintained source tree without deleted documents", () => {
  assert.deepEqual(runtimeDocuments, ["LICENSE", "README.md"]);
});

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "bundle-safety-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "root"); mkdirSync(root);
  return { temp, root };
}

test("portability validator rejects native addons", (t) => {
  const { root } = fixture(t); writeFileSync(join(root, "native.node"), "addon");
  assert.throws(() => validateRuntimeTree(root), /Native binary/);
});
test("portability validator rejects native executables without addon suffix", (t) => {
  const { root } = fixture(t); writeFileSync(join(root, "helper"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  assert.throws(() => validateRuntimeTree(root), /Native binary/);
});
test("portability validator rejects escaping directory symlinks", (t) => {
  const { root, temp } = fixture(t); symlinkSync(temp, join(root, "outside"));
  assert.throws(() => validateRuntimeTree(root), /symlink/i);
});
test("portability validator rejects even internal npm bin symlinks", (t) => {
  const { root } = fixture(t); writeFileSync(join(root, "bin.js"), "#!/usr/bin/env node\n");
  symlinkSync("bin.js", join(root, "bin"));
  assert.throws(() => validateRuntimeTree(root), /symlink/i);
});
for (const [label, tag, sha, message] of [
  ["tag injection", "bundle-v1.0.0;bad", "1394a58f34f53003780b3bd2703c1b7e1c000bc3", /Expected release tag/],
  ["abbreviated source revision", "bundle-v1.0.0", "1394a58", /full 40-character/],
  ["wrong source revision", "bundle-v1.0.0", "0000000000000000000000000000000000000000", /checked-out HEAD/],
]) {
  test(`builder rejects ${label} before building`, () => {
    const result = spawnSync(process.execPath, ["scripts/build-runtime-bundle.mjs", "--output-dir", ".",
      "--release-tag", tag, "--source-sha", sha], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  });
}

test("builder rejects source symlinks rather than silently hashing outside source", async (t) => {
  const { root, temp } = fixture(t);
  writeFileSync(join(temp, "outside.js"), "outside");
  symlinkSync("../outside.js", join(root, "source.js"));
  const { validateSourceTree } = await import("./build-runtime-bundle.mjs");
  assert.equal(typeof validateSourceTree, "function");
  assert.throws(() => validateSourceTree(root), /Source symlink/);
});
