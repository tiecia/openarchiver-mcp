import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repo = resolve(import.meta.dirname, "..");
const sha = "1394a58f34f53003780b3bd2703c1b7e1c000bc3";
function fixture(t, mode) {
  const root = mkdtempSync(join(tmpdir(), "release-publisher-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const artifacts = join(root, "assets");
  mkdirSync(bin); mkdirSync(artifacts);
  // Local subprocess fixture: never contacts GitHub or creates a release.
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\nimport{appendFileSync,readFileSync}from'node:fs';
const a=process.argv.slice(2);appendFileSync(process.env.CALL_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='api'){
 if(a[1].includes('/releases/tags/')){if(process.env.MODE==='exists'){console.log(JSON.stringify({id:1,draft:false}));}else if(process.env.MODE==='auth'){console.error('HTTP 401');process.exit(1);}else{console.error('HTTP 404');process.exit(1);}}
 else if(a[1].includes('/git/ref/tags/')){console.error('HTTP 404');process.exit(1);}
 else if(a[1].endsWith('/releases/99')){console.log(JSON.stringify({id:99,draft:process.env.MODE==='cleanup',tag_name:'bundle-v1.0.0',assets:[{name:'openarchiver-mcp-linux-x64.tar.gz'},{name:'SHA256SUMS'}]}));}
 else if(a.includes('POST'))console.log(JSON.stringify({id:99,upload_url:'https://uploads.github.com/repos/tiecia/openarchiver-mcp/releases/99/assets{?name,label}'}));
}else if(a[0]==='release'&&a[1]==='upload'&&process.env.MODE==='cleanup'){console.error('upload failed');process.exit(1);}
`);
  chmodSync(join(bin, "gh"), 0o755);
  const stage = join(root, "openarchiver-mcp"); mkdirSync(stage);
  writeFileSync(join(stage, "BUILD-INFO.json"), JSON.stringify({ releaseTag: "bundle-v1.0.0", sourceSha: sha, workingTreeDirty: mode === "bootstrap" }));
  const asset = join(artifacts, "openarchiver-mcp-linux-x64.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", asset, "-C", root, "openarchiver-mcp"]).status, 0);
  writeFileSync(join(artifacts, "SHA256SUMS"), `${createHash("sha256").update(readFileSync(asset)).digest("hex")}  openarchiver-mcp-linux-x64.tar.gz\n`);
  const log = join(root, "calls.jsonl"); writeFileSync(log, "");
  const run = (extra = []) => spawnSync(process.execPath, ["scripts/publish-runtime-release.mjs", "--artifact-dir", artifacts,
    "--release-tag", "bundle-v1.0.0", "--source-sha", sha, ...extra], { cwd: repo, encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "", PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log, MODE: mode, GITHUB_REPOSITORY: "tiecia/openarchiver-mcp" } });
  return { run, calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse), artifacts };
}

test("publisher refuses an existing release without any writes", (t) => {
  const f = fixture(t, "exists"); const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite/i);
  assert.ok(!f.calls().some((a) => a.includes("POST") || a[0] === "release"));
});

test("publisher creates a draft, uploads both assets, publishes and reads back", (t) => {
  const f = fixture(t, "success"); const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.calls().some((a) => a.includes("POST") && a.includes("draft=true")));
  assert.ok(f.calls().some((a) => a[0] === "release" && a[1] === "upload" && !a.includes("--clobber")));
  assert.ok(f.calls().some((a) => a.includes("PATCH") && a.includes("draft=false")));
  assert.ok(f.calls().filter((a) => a.includes("repos/tiecia/openarchiver-mcp/releases/99")).length >= 2);
});

test("publisher deletes only its newly created draft on upload failure", (t) => {
  const f = fixture(t, "cleanup"); const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /upload failed/);
  assert.ok(f.calls().some((a) => a.includes("DELETE") && a.includes("repos/tiecia/openarchiver-mcp/releases/99")));
  assert.ok(!f.calls().some((a) => a.includes("PATCH") || a[1] === "delete"));
});

test("publisher does not treat authentication failure as missing release", (t) => {
  const f = fixture(t, "auth"); const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 401/);
  assert.ok(!f.calls().some((a) => a.includes("POST")));
});

test("publisher refuses dirty working-tree metadata", (t) => {
  const f = fixture(t, "bootstrap");
  const refused = f.run(); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /dirty working-tree/);
  assert.ok(!f.calls().some((a) => a.includes("POST")));
});

test("publisher rejects altered checksum before any writes", (t) => {
  const f = fixture(t, "success"); writeFileSync(join(f.artifacts, "SHA256SUMS"), "altered\n");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/i);
  assert.ok(!f.calls().some((a) => a.includes("POST")));
});

