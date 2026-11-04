#!/usr/bin/env node
// This verifier uses only dependencies inside the extracted runtime, not this checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyRuntime(root) {
  root = resolve(root);
  const require = createRequire(join(root, "package.json"));
  const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")));
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const info = JSON.parse(readFileSync(join(root, "BUILD-INFO.json"), "utf8"));
  for (const [name, expected] of Object.entries(info.payloadSha256)) {
    assert.equal(createHash("sha256").update(readFileSync(join(root, name))).digest("hex"), expected, name);
  }
  const elsewhere = mkdtempSync(join(tmpdir(), "runtime-smoke-"));
  const client = new Client({ name: "runtime-bundle-smoke", version: "1.0.0" });
  try {
    assert.equal(execFileSync(process.execPath, [join(root, "dist/index.js"), "--version"], { cwd: elsewhere, encoding: "utf8" }).trim(), pkg.version);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENARCHIVER_")));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(root, "dist/index.js")], cwd: elsewhere, env }));
    assert.equal(client.getServerVersion()?.version, pkg.version);
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(),
      ["check_integrity", "get_attachment", "get_email", "get_email_source", "get_email_thread", "list_archive", "search_archive", "suggest_archive_values"]);
    const disabled = await client.callTool({ name: "get_attachment", arguments: { path: "bundle-smoke" } });
    assert.ok(disabled.isError && disabled.content.some((part) => part.type === "text" && /Attachments are disabled/.test(part.text)));
    const rawDisabled = await client.callTool({ name: "get_email_source", arguments: { id: "00000000-0000-4000-8000-000000000001", view: "raw_file" } });
    assert.ok(rawDisabled.isError && rawDisabled.content.some(part => part.type === "text" && /disabled/.test(part.text)));
    console.log(`MCP smoke ok: extracted runtime v${pkg.version}; tools/list; attachments disabled; raw export disabled`);
    // Importing from the extracted path also resolves its production relative worker.
    const { parseMime, parseHeaders } = await import(pathToFileURL(join(root, "dist/mime.js")));
    const parsed = await parseMime(Buffer.from("Content-Type: text/html; charset=utf-8\r\n\r\n<p>bundle worker fixture</p>"));
    assert.equal(parsed.body.trim(), "bundle worker fixture");
    console.log("relative MIME worker ok: extracted mailparser + HTML conversion");
    const headers = await parseHeaders(Buffer.from("Received: first\r\nReceived: second\r\nSubject: headers fixture\r\n\r\nbody excluded"));
    assert.equal(headers.headers.filter(header => header.name.toLowerCase() === "received").length, 2);
    assert.ok(!JSON.stringify(headers).includes("body excluded"));
    console.log("relative headers worker ok: extracted ordered duplicate headers");
  } finally {
    await client.close();
    rmSync(elsewhere, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await verifyRuntime(process.argv[2] ?? resolve(import.meta.dirname, ".."));
}
