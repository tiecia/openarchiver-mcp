#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const repository = "tiecia/openarchiver-mcp";
function gh(args, options = {}) {
  const result = spawnSync("gh", args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`gh ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}
function absent(endpoint) {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8" });
  if (result.status === 0) throw new Error(`Refusing to overwrite existing release or tag: ${endpoint}`);
  if (!/\bHTTP 404\b/.test(result.stderr)) throw new Error(`Cannot check existing release/tag: ${result.stderr}`);
}

const { values } = parseArgs({ options: { "artifact-dir": { type: "string" }, "release-tag": { type: "string" }, "source-sha": { type: "string" } } });
const tag = values["release-tag"];
const sha = values["source-sha"];
if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== repository) throw new Error("Unexpected repository; publishing is restricted to tiecia/openarchiver-mcp");
if (!/^bundle-v1\.0\.(0|[1-9][0-9]*)$/.test(tag ?? "")) throw new Error("Expected release tag bundle-v1.0.N");
if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("Expected full source commit SHA");
absent(`repos/${repository}/releases/tags/${tag}`);
absent(`repos/${repository}/git/ref/tags/${tag}`);
const artifactDir = resolve(values["artifact-dir"] ?? "");
const asset = "openarchiver-mcp-linux-x64.tar.gz";
const archive = join(artifactDir, asset);
const checksum = `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${asset}\n`;
assert.equal(readFileSync(join(artifactDir, "SHA256SUMS"), "utf8"), checksum, "Asset checksum mismatch");
const infoResult = spawnSync("tar", ["-xOzf", archive, "openarchiver-mcp/BUILD-INFO.json"], { encoding: "utf8" });
assert.equal(infoResult.status, 0, infoResult.stderr);
const info = JSON.parse(infoResult.stdout);
assert.equal(info.sourceSha, sha, "Bundle source SHA mismatch");
assert.equal(info.releaseTag, tag, "Bundle release tag mismatch");
assert.equal(info.workingTreeDirty, false, "Refusing to publish a dirty working-tree bundle; rebuild from committed source");
const notes = `Linux x64 runtime bundle for the existing Hermes image (Node >=26 required, Node not included).\n\nSource: ${sha}\nWorking-tree packaging additions: ${info.workingTreeDirty}\nFull input and payload hashes: BUILD-INFO.json inside the archive.\n\n${checksum}`;
const created = JSON.parse(gh(["api", `repos/${repository}/releases`, "--method", "POST",
  "-f", `tag_name=${tag}`, "-f", `target_commitish=${sha}`, "-f", `name=${tag}`,
  "-f", `body=${notes}`, "-F", "draft=true", "-F", "prerelease=false"]));
assert.ok(Number.isSafeInteger(created.id), "Missing release id");
const endpoint = `repos/${repository}/releases/${created.id}`;
try {
  gh(["release", "upload", tag, archive, join(artifactDir, "SHA256SUMS"), "--repo", repository]);
  const uploaded = JSON.parse(gh(["api", endpoint]));
  assert.deepEqual(uploaded.assets.map(({ name }) => name).sort(), ["SHA256SUMS", asset]);
  gh(["api", endpoint, "--method", "PATCH", "-F", "draft=false", "-F", "prerelease=false", "-f", "make_latest=true"]);
  const published = JSON.parse(gh(["api", endpoint]));
  assert.equal(published.draft, false, "Release was not published");
  assert.equal(published.tag_name, tag);
  console.log(`Published ${repository} ${tag} from ${sha}`);
} catch (error) {
  // A network failure after publishing must never delete a completed release.
  // Only clean up the draft ID created by this invocation, not a pre-existing tag.
  try {
    const current = JSON.parse(gh(["api", endpoint]));
    if (current.draft === true) gh(["api", endpoint, "--method", "DELETE"]);
  } catch (cleanupError) {
    console.error(`Draft cleanup requires manual inspection: ${cleanupError.message}`);
  }
  throw error;
}

