import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const repo = resolve(import.meta.dirname, "..");
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: repo, encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};

test("builds a reproducible production archive and verifies the extracted runtime", { timeout: 1_200_000 }, () => {
  const temp = mkdtempSync(join(tmpdir(), "runtime-bundle-test-"));
  try {
    const sha = run("git", ["rev-parse", "HEAD"]).trim();
    const digests = [];
    for (const name of ["first", "second"]) {
      const output = join(temp, name);
      const stdout = run(process.execPath, ["scripts/build-runtime-bundle.mjs", "--output-dir", output,
        "--release-tag", "bundle-v1.0.0", "--source-sha", sha]);
      assert.match(stdout, /MCP smoke ok/);
      assert.match(stdout, /relative MIME worker ok/);
      const archive = join(output, "openarchiver-mcp-linux-x64.tar.gz");
      const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
      assert.equal(readFileSync(join(output, "SHA256SUMS"), "utf8"), `${hash}  openarchiver-mcp-linux-x64.tar.gz\n`);
      const entries = run("tar", ["-tzf", archive]).trim().split("\n");
      for (const file of ["dist/index.js", "dist/mime-worker.js", "package.json", "package-lock.json",
        "LICENSE", "README.md", "BUILD-INFO.json", "scripts/verify-runtime-bundle.mjs", "node_modules/mailparser/package.json"]) {
        assert.ok(entries.includes(`openarchiver-mcp/${file}`), file);
      }
      assert.ok(!entries.some((entry) => /dist\/.*\.test\.|node_modules\/(typescript|@typescript)\//.test(entry)));
      assert.deepEqual(readdirSync(output).sort(), ["SHA256SUMS", "openarchiver-mcp-linux-x64.tar.gz"]);
      const info = JSON.parse(run("tar", ["-xOzf", archive, "openarchiver-mcp/BUILD-INFO.json"]));
      assert.equal(info.sourceSha, sha);
      assert.equal(info.releaseTag, "bundle-v1.0.0");
      assert.equal(info.nodeVersion, process.version);
      assert.equal(info.runtime.node, ">=26");
      assert.equal(info.sourceInputsSha256["package-lock.json"], createHash("sha256").update(readFileSync(join(repo, "package-lock.json"))).digest("hex"));
      digests.push(hash);
    }
    assert.equal(digests[0], digests[1], "same inputs/toolchain must yield identical archive bytes");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
