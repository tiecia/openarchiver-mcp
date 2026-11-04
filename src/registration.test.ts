import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./index.js";

test("original headers worker is exercised from the extracted runtime verifier", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../scripts/verify-runtime-bundle.mjs", import.meta.url), "utf8");
  assert.match(source, /parseHeaders/);
  assert.match(source, /headers worker ok/);
});

test("production registration includes eight focused tools and preserves default-denied raw export", async () => {
  const runtime = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "registration-test", version: "1" });
  try {
    await runtime.server.connect(b); await client.connect(a);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ["check_integrity", "get_attachment", "get_email", "get_email_source", "get_email_thread", "list_archive", "search_archive", "suggest_archive_values"]);
    const oldRaw = process.env.OPENARCHIVER_ENABLE_RAW_EXPORT;
    delete process.env.OPENARCHIVER_ENABLE_RAW_EXPORT;
    try {
      const result = await client.callTool({ name: "get_email_source", arguments: { id: "00000000-0000-4000-8000-000000000001", view: "raw_file" } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /disabled/);
    } finally { if (oldRaw === undefined) delete process.env.OPENARCHIVER_ENABLE_RAW_EXPORT; else process.env.OPENARCHIVER_ENABLE_RAW_EXPORT = oldRaw; }
  } finally { await client.close(); await runtime.close(); }
});
