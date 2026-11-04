#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyRuntime } from "./verify-runtime-bundle.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asset = "openarchiver-mcp-linux-x64.tar.gz";
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const run = (command, args, cwd = repo) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
function files(root) {
  return readdirSync(root).sort().flatMap((name) => {
    const path = join(root, name);
    return lstatSync(path).isDirectory() ? files(path).map((child) => join(name, child)) : [name];
  });
}

export function validateSourceTree(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Source symlink is not supported: ${path}`);
    if (stat.isDirectory()) validateSourceTree(path);
  }
}

export async function buildBundle({ outputDir, releaseTag, sourceSha }) {
  if (Number(process.versions.node.split(".")[0]) < 26) throw new Error("Node >=26 required");
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Build requires Linux x64");
  if (!/^bundle-v1\.0\.(0|[1-9][0-9]*)$/.test(releaseTag ?? "")) throw new Error("Expected release tag bundle-v1.0.N");
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? "")) throw new Error("source-sha must be a full 40-character lowercase commit SHA");
  if (run("git", ["rev-parse", "HEAD"]).trim() !== sourceSha) throw new Error("source-sha must equal checked-out HEAD");
  if (!outputDir) throw new Error("output-dir is required");
  const output = resolve(outputDir);
  if (existsSync(output) && readdirSync(output).length) throw new Error("output-dir must be empty; refusing to overwrite artifacts");
  const epoch = Number(run("git", ["show", "-s", "--format=%ct", sourceSha]).trim());
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim() !== "";
  validateSourceTree(join(repo, "src"));
  const inputs = ["package.json", "package-lock.json", "tsconfig.json", "LICENSE", "SECURITY-HARDENING.md",
    ...files(join(repo, "src")).map((path) => `src/${path}`),
    "scripts/build-runtime-bundle.mjs", "scripts/verify-runtime-bundle.mjs"];
  const sourceInputsSha256 = Object.fromEntries(inputs.sort().map((name) => [name, sha256(join(repo, name))]));
  const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (pkg.resolved && (!pkg.resolved.startsWith("https://registry.npmjs.org/") || !pkg.integrity)) {
      throw new Error(`Unreviewed registry or missing integrity: ${name}`);
    }
  }
  const temp = mkdtempSync(join(tmpdir(), "openarchiver-bundle-"));
  try {
    // Never package a stale build, and never install dependencies into the running image.
    rmSync(join(repo, "dist"), { recursive: true, force: true });
    process.stdout.write(run("npm", ["run", "build"]));
    const stage = join(temp, "stage");
    const root = join(stage, "openarchiver-mcp");
    mkdirSync(root, { recursive: true });
    for (const name of ["package.json", "package-lock.json", "LICENSE", "SECURITY-HARDENING.md"]) {
      copyFileSync(join(repo, name), join(root, name));
    }
    cpSync(join(repo, "dist"), join(root, "dist"), { recursive: true, filter: (path) => !/\.test\.js(?:\.map)?$/.test(path) });
    mkdirSync(join(root, "scripts"));
    copyFileSync(join(repo, "scripts/verify-runtime-bundle.mjs"), join(root, "scripts/verify-runtime-bundle.mjs"));
    process.stdout.write(run("npm", ["ci", "--omit=dev", "--include=optional", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], root));
    for (const name of files(root).filter((name) => name.split(sep).includes(".bin"))) rmSync(join(root, name));
    const payloadSha256 = Object.fromEntries(files(root).filter((name) => lstatSync(join(root, name)).isFile())
      .map((name) => [name, sha256(join(root, name))]));
    writeFileSync(join(root, "BUILD-INFO.json"), JSON.stringify({
      schemaVersion: 1, releaseTag, sourceSha, sourceCommitTimestamp: epoch, workingTreeDirty: dirty,
      packageVersion: lock.version, nodeVersion: process.version, npmVersion: run("npm", ["--version"]).trim(),
      runtime: { node: ">=26", platform: "linux", arch: "x64", bundledNode: false, nativeDependencies: false },
      sourceInputsSha256, payloadSha256,
    }, null, 2) + "\n");
    validateRuntimeTree(root);
    const tar = join(temp, "bundle.tar");
    run("tar", ["--sort=name", `--mtime=@${epoch}`, "--owner=0", "--group=0", "--numeric-owner", "--format=gnu",
      "--mode=u+rwX,go+rX,go-w", "-cf", tar, "-C", stage, "openarchiver-mcp"]);
    const archive = join(temp, asset);
    const fd = openSync(archive, "wx");
    try { execFileSync("gzip", ["-n", "-c", tar], { stdio: ["ignore", fd, "inherit"] }); }
    finally { closeSync(fd); }
    const extracted = join(temp, "extracted");
    mkdirSync(extracted);
    run("tar", ["-xzf", archive, "--no-same-owner", "-C", extracted]);
    validateRuntimeTree(join(extracted, "openarchiver-mcp"));
    await verifyRuntime(join(extracted, "openarchiver-mcp"));
    // Reject source changes during the build rather than mislabeling compiled bytes.
    for (const [name, expected] of Object.entries(sourceInputsSha256)) {
      if (sha256(join(repo, name)) !== expected) throw new Error(`Source changed during build: ${name}`);
    }
    mkdirSync(output, { recursive: true });
    copyFileSync(archive, join(output, asset), 1 /* COPYFILE_EXCL */);
    const checksum = `${sha256(archive)}  ${asset}\n`;
    writeFileSync(join(output, "SHA256SUMS"), checksum, { flag: "wx" });
    console.log(`${checksum.trim()}\nVerified runtime bundle: ${join(output, asset)}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function validateRuntimeTree(root) {
  root = realpathSync(root);
  for (const name of files(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Unsupported symlink: ${name}`);
    if (stat.isFile() && stat.nlink !== 1) throw new Error(`Unsupported hardlink: ${name}`);
    if (!stat.isFile()) {
      throw new Error(`Unsupported file type: ${name}`);
    }
    const bytes = readFileSync(path);
    if (/\.node$/i.test(name) || bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        bytes.subarray(0, 2).toString() === "MZ" || ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(bytes.subarray(0, 4).toString("hex"))) {
      throw new Error(`Native binary is not portable: ${name}`);
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { "output-dir": { type: "string" }, "release-tag": { type: "string" }, "source-sha": { type: "string" } } });
  await buildBundle({ outputDir: values["output-dir"], releaseTag: values["release-tag"], sourceSha: values["source-sha"] });
}
