import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ID = "00000000-0000-4000-8000-000000000001";
const SOURCE = "00000000-0000-4000-8000-000000000002";
const HIDDEN = "00000000-0000-4000-8000-000000000003";

test("real stdio and hardened HTTP client connect all new read paths without exports or permission leaks", async () => {
  const urls: string[] = [];
  const raw = Buffer.from("Received: first hop\r\nReceived: second hop\r\nTo: reader@example.com\r\nSubject: fixture\r\n\r\nfixture body");
  const http = createHttpServer((request, response) => {
    assert.equal(request.headers["x-api-key"], "fixture-key");
    const url = new URL(request.url!, "http://localhost"); urls.push(url.pathname + url.search);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/search/facets") return void response.end(JSON.stringify({ values: ["reader@example.com"] }));
    if (url.pathname === "/api/v1/search") {
      assert.equal(url.searchParams.get("dateFrom"), "2026-11-04");
      assert.equal(url.searchParams.get("hasAttachments"), "false");
      assert.equal(url.searchParams.get("mailboxes"), "reader@example.com");
      return void response.end(JSON.stringify({ hits: [{ id: ID, subject: "fixture", userEmail: "reader@example.com", ingestionSourceId: SOURCE, to: ["reader@example.com"], timestamp: 1793808000000 }], total: 1, page: 1, limit: 10, totalPages: 1, processingTimeMs: 0 }));
    }
    if (url.pathname === `/api/v1/archived-emails/ingestion-source/${SOURCE}`) return void response.end(JSON.stringify({ items: [{ id: ID, subject: "fixture", isIndexed: false, ingestionSourceId: SOURCE }], total: 1, page: 1, limit: 10 }));
    if (url.pathname === `/api/v1/archived-emails/${HIDDEN}`) { response.statusCode = 404; return void response.end('{"message":"hidden-secret-subject"}'); }
    if (url.pathname === `/api/v1/archived-emails/${ID}`) return void response.end(JSON.stringify({ id: ID, subject: "fixture", userEmail: "reader@example.com", ingestionSourceId: SOURCE, ingestionSource: { id: SOURCE, name: "fixture source", credentials: "must not leak" }, sentAt: "2026-11-04T12:00:00Z", raw, thread: [{ id: ID }, { id: HIDDEN, subject: "hidden-secret-subject" }] }));
    if (url.pathname === `/api/v1/integrity/${ID}`) return void response.end(JSON.stringify([{ id: ID, type: "email", isValid: true, storedHash: "a".repeat(64), computedHash: "a".repeat(64) }]));
    response.statusCode = 500; response.end("unexpected fixture route");
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); assert.ok(address && typeof address !== "string");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENARCHIVER_"))) as Record<string, string>;
  Object.assign(env, { OPENARCHIVER_BASE_URL: `http://127.0.0.1:${address.port}`, OPENARCHIVER_API_KEY: "fixture-key", OPENARCHIVER_ALLOW_HTTP_LOOPBACK: "true", OPENARCHIVER_ENABLE_ATTACHMENTS: "false", OPENARCHIVER_ENABLE_RAW_EXPORT: "false" });
  const client = new Client({ name: "all-read-paths", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("./index.js", import.meta.url).pathname], env }));
    const search = await client.callTool({ name: "search_archive", arguments: { filters: { dateFrom: "2026-11-04", mailboxes: ["reader@example.com"], hasAttachments: false } } });
    assert.ok(!search.isError); assert.equal((search.structuredContent as Record<string, unknown>)?.totalKind, "estimated");
    const list = await client.callTool({ name: "list_archive", arguments: { ingestionSourceId: SOURCE } });
    assert.ok(!list.isError); assert.equal((list.structuredContent as Record<string, unknown>)?.totalRows, 1); assert.equal((list.structuredContent as Record<string, unknown>)?.indexBacked, false);
    const suggestions = await client.callTool({ name: "suggest_archive_values", arguments: { field: "mailboxes" } });
    assert.ok(!suggestions.isError); assert.equal((suggestions.structuredContent as Record<string, unknown>)?.suggestionOnly, true);
    for (const view of ["metadata", "body"]) {
      const email = await client.callTool({ name: "get_email", arguments: { id: ID, view } });
      assert.ok(!email.isError); assert.doesNotMatch(JSON.stringify(email), /must not leak|hidden-secret-subject/);
      assert.equal(((email.structuredContent as Record<string, unknown>)?.email as Record<string, unknown>).ingestionSourceId, SOURCE);
    }
    const thread = await client.callTool({ name: "get_email_thread", arguments: { emailId: ID } });
    assert.ok(!thread.isError); assert.doesNotMatch(JSON.stringify(thread), new RegExp(`${HIDDEN}|hidden-secret-subject`));
    assert.ok(urls.some(url => url.includes(HIDDEN)), "thread must reauthorize hidden candidate before excluding it");
    const headers = await client.callTool({ name: "get_email_source", arguments: { id: ID } });
    assert.ok(!headers.isError); const values = (headers.structuredContent as Record<string, unknown>)?.headers as {name:string;value:string}[];
    assert.equal(values.filter(h => h.name === "Received").length, 2); assert.doesNotMatch(JSON.stringify(headers), /fixture body/);
    const integrity = await client.callTool({ name: "check_integrity", arguments: { id: ID, includeHashes: true } });
    assert.ok(!integrity.isError); assert.match(JSON.stringify(integrity), new RegExp("a".repeat(64)));
    const before = urls.length;
    const rawExport = await client.callTool({ name: "get_email_source", arguments: { id: ID, view: "raw_file" } });
    const attachment = await client.callTool({ name: "get_attachment", arguments: { path: "do-not-fetch" } });
    assert.equal(rawExport.isError, true); assert.equal(attachment.isError, true); assert.equal(urls.length, before);
  } finally {
    await client.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
