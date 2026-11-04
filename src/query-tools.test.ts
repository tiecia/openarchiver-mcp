import assert from "node:assert/strict";
import { it } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OpenArchiverClient } from "./client.js";
import { archiveResult } from "./results.js";
import { AttachmentFiles, OperationGate } from "./runtime.js";

const id = "12345678-1234-1234-1234-123456789abc";
async function withTools(body: unknown, run: (client: Client, requests: URL[]) => Promise<void>, status = 200): Promise<void> {
  const requests: URL[] = [];
  const api = createServer((req, res) => {
    requests.push(new URL(req.url!, "http://fixture"));
    assert.equal(req.headers["x-api-key"], "fixture");
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  const port = (api.address() as { port: number }).port;
  const backend = new OpenArchiverClient(`http://127.0.0.1:${port}`, "fixture", fetch, 1000, { allowHttpLoopback: true });
  const server = new McpServer({ name: "query-fixture", version: "1" });
  const files = new AttachmentFiles(); const gate = new OperationGate();
  const client = new Client({ name: "fixture", version: "1" });
  try {
    const { registerQueryTools } = await import("./query-tools.js");
    registerQueryTools({ server, getClient: () => backend, result: archiveResult, files, mimeOptions: {}, guarded: operation => gate.run(operation).catch(() => ({ isError: true, content: [{ type: "text", text: "Sanitized failure" }] })) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    await run(client, requests);
  } finally {
    await gate.close(); await files.close(); await client.close(); await server.close();
    await new Promise<void>(resolve => api.close(() => resolve()));
  }
}
function text(result: Record<string, unknown>): string {
  return (result.content as { text?: string }[]).map(item => item.text ?? "").join("\n");
}

it("preserves bounded nonnegative match indices for recipient and attachment attribution", async () => {
  await withTools({ hits: [{ id, _matchesPosition: {
    to: [{ start: 0, length: 3, indices: [2, 0] }],
    "attachments.content": [{ start: 2, length: 4, indices: [1] }],
  } }] }, async client => {
    const result = await client.callTool({ name: "search_archive", arguments: { keywords: "fixture", detail: "matches" } });
    assert.ok(!result.isError, text(result));
    const hit = ((result.structuredContent as Record<string, unknown>).hits as Record<string, unknown>[])[0];
    assert.deepEqual((hit.matchLocations as Record<string, unknown>).to, [{ start: 0, length: 3, indices: [2, 0] }]);
    assert.deepEqual((hit.matchLocations as Record<string, unknown>)["attachments.content"], [{ start: 2, length: 4, indices: [1] }]);
    assert.equal(hit.matchProjectionIncomplete, false);
  });
});

it("discloses malformed and truncated match attribution without echoing invalid indices", async () => {
  await withTools({ hits: [{ id, _matchesPosition: { to: [
    { start: 0, length: 1, indices: Array.from({ length: 21 }, (_, index) => index) },
    ...[[-1], [0.5], [Number.MAX_SAFE_INTEGER + 1], ["DO-NOT-LEAK"], null, "DO-NOT-LEAK", [0, -1]].map(indices => ({ start: 0, length: 1, indices })),
  ] } }] }, async client => {
    const result = await client.callTool({ name: "search_archive", arguments: { keywords: "fixture", detail: "matches" } });
    assert.ok(!result.isError, text(result));
    const hit = ((result.structuredContent as Record<string, unknown>).hits as Record<string, unknown>[])[0];
    const positions = (hit.matchLocations as Record<string, unknown>).to as Record<string, unknown>[];
    assert.deepEqual(positions[0].indices, Array.from({ length: 20 }, (_, index) => index));
    for (const entry of positions.slice(1)) assert.equal(entry.indices, undefined);
    assert.equal(hit.matchProjectionIncomplete, true);
    assert.ok((hit.truncatedFields as string[]).includes("matchLocations.to[0].indices"));
    assert.doesNotMatch(JSON.stringify(result), /DO-NOT-LEAK/);
  });
});

it("bounds invalid-field diagnostics before shared result serialization", async () => {
  await withTools({ hits: [{ id, attachments: Array(50).fill({ filename: 1, content: 2 }) }], total: 1 }, async client => {
    const result = await client.callTool({ name: "search_archive", arguments: { keywords: "x" } });
    const hit = ((result.structuredContent as Record<string, unknown>).hits as Record<string, unknown>[])[0];
    assert.ok((hit.invalidFields as unknown[]).length <= 20);
    assert.equal(hit.invalidFieldsTruncated, true);
  });
});

it("rejects calendar-normalized or timezone-free source dates with sentAt diagnostics", async () => {
  const invalid = ["2023-02-29T00:00:00Z", "2024-02-30T00:00:00Z", "2024-01-01T24:00:00Z", "2024-01-01T00:00:00", "2024-01-01T00:00:00-00:00", "2024-01-01T00:00:00+24:00", "March 1, 2024 00:00:00Z"];
  await withTools({ items: invalid.map(sentAt => ({ id, sentAt })) }, async client => {
    const result = await client.callTool({ name: "list_archive", arguments: { ingestionSourceId: id } });
    assert.ok(!result.isError, text(result));
    for (const item of (result.structuredContent as Record<string, unknown>).items as Record<string, unknown>[]) {
      assert.equal(item.sentAt, null); assert.deepEqual(item.invalidFields, ["sentAt"]);
    }
  });
});

it("marks finite out-of-Date-range search epochs as invalid timestamp fields", async () => {
  await withTools({ hits: [8_640_000_000_000_001, -8_640_000_000_000_001].map(timestamp => ({ id, timestamp })) }, async client => {
    const result = await client.callTool({ name: "search_archive", arguments: { keywords: "fixture" } });
    assert.ok(!result.isError, text(result));
    for (const hit of (result.structuredContent as Record<string, unknown>).hits as Record<string, unknown>[]) {
      assert.equal(hit.sentAt, null); assert.deepEqual(hit.invalidFields, ["timestamp"]);
    }
  });
});

it("source listings label discarded malformed summary metadata rather than implying complete fields", async () => {
  await withTools({ items: [{ id, subject: 12, recipients: "invalid", sentAt: "not-a-date", ingestionSource: { id: 23 } }], total: "bad" }, async client => {
    const result = await client.callTool({ name: "list_archive", arguments: { ingestionSourceId: id } });
    assert.ok(!result.isError, text(result));
    const data = result.structuredContent as Record<string, unknown>;
    assert.equal(data.totalKind, "unknown"); assert.equal(data.totalRows, null);
    const item = (data.items as Record<string, unknown>[])[0];
    assert.deepEqual(item.invalidFields, ["subject", "recipients", "ingestionSource.id", "sentAt"]);
    assert.equal(item.sentAt, null);
  });
});

it("marks discarded malformed indexed fields and unsupported matches as incomplete projections", async () => {
  await withTools({ hits: [{ id, to: "malformed", attachments: "malformed", body: 42, _formatted: { subject: { malformed: true }, unknown: "DO-NOT-LEAK" }, _matchesPosition: { subject: [{ start: -1, length: 1 }], unknown: [] } }], total: 1 }, async client => {
    const result = await client.callTool({ name: "search_archive", arguments: { keywords: "x", detail: "matches" } });
    assert.ok(!result.isError, text(result));
    const hit = ((result.structuredContent as Record<string, unknown>).hits as Record<string, unknown>[])[0];
    assert.deepEqual(hit.invalidFields, ["to", "body", "attachments"]);
    assert.equal(hit.matchProjectionIncomplete, true);
    assert.doesNotMatch(JSON.stringify(result), /DO-NOT-LEAK|malformed/);
  });
});

it("preserves default attachment names and exposes bounded attachment match text without raw passthrough", async () => {
  await withTools({ hits: [{ id, subject: "invoice", attachments: [{ filename: "invoice.pdf", content: "extracted secret body" }], _formatted: { attachments: [{ filename: "<em>invoice</em>.pdf", content: "match".repeat(1000), credentials: "DO-NOT-LEAK" }] }, _matchesPosition: { "attachments.filename": [{ start: 0, length: 7 }], "attachments.0.content": [{ start: 1, length: 3 }], "attachments.credentials": [{ start: 0, length: 1 }] } }], total: 1 }, async client => {
    const compact = await client.callTool({ name: "search_archive", arguments: { keywords: "invoice" } });
    assert.match(text(compact), /invoice.pdf/);
    const compactHit = ((compact.structuredContent as Record<string, unknown>).hits as Record<string, unknown>[])[0];
    assert.deepEqual(compactHit.attachments, [{ filename: "invoice.pdf" }]);
    assert.doesNotMatch(JSON.stringify(compact), /extracted secret body/);
    const rich = await client.callTool({ name: "search_archive", arguments: { keywords: "invoice", detail: "matches" } });
    const hit = ((rich.structuredContent as Record<string, unknown>).hits as Record<string, unknown>[])[0];
    const highlighted = (hit.highlights as Record<string, unknown>).attachments as Record<string, unknown>[];
    assert.equal(highlighted[0].filename, "<em>invoice</em>.pdf");
    assert.ok(String(highlighted[0].content).length <= 2048);
    assert.deepEqual((hit.matchLocations as Record<string, unknown>)["attachments.filename"], [{ start: 0, length: 7 }]);
    assert.deepEqual((hit.matchLocations as Record<string, unknown>)["attachments.0.content"], [{ start: 1, length: 3 }]);
    assert.ok((hit.truncatedFields as string[]).includes("highlights.attachments[0].content"));
    assert.doesNotMatch(JSON.stringify(rich), /credentials|DO-NOT-LEAK/);
  });
});

it("rejects invalid discovery/list arguments over MCP without making upstream requests", async () => {
  await withTools({}, async (client, requests) => {
    for (const args of [{ ingestionSourceId: "invalid" }, { ingestionSourceId: id, dateFrom: "2024-02-29" }, { ingestionSourceId: id, sort: "date_desc" }, { ingestionSourceId: id, limit: 101 }, { ingestionSourceId: id, detail: "raw" }]) {
      assert.equal((await client.callTool({ name: "list_archive", arguments: args })).isError, true, JSON.stringify(args));
    }
    for (const args of [{ field: "sources" }, { field: "from", query: "a".repeat(2001) }, { field: "from", admin: true }, { field: "mailboxes", query: "x\n" }]) {
      assert.equal((await client.callTool({ name: "suggest_archive_values", arguments: args })).isError, true, JSON.stringify(args));
    }
    assert.equal(requests.length, 0);
    const tools = (await client.listTools()).tools;
    for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  });
});

it("permission failures make only the requested endpoint call without fallback or reflection", async () => {
  for (const name of ["list_archive", "suggest_archive_values", "search_archive"]) {
    await withTools({ message: "DO-NOT-LEAK credentials api-key attacker instructions" }, async (client, requests) => {
      const args = name === "list_archive" ? { ingestionSourceId: id } : name === "suggest_archive_values" ? { field: "from" } : { keywords: "fixture" };
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true); assert.equal(requests.length, 1);
      assert.doesNotMatch(JSON.stringify(result), /DO-NOT-LEAK|credentials|attacker/);
    }, 403);
  }
});

it("legacy summary and indexed_text modes return only their allowlisted detail", async () => {
  await withTools({ hits: [{ id, subject: "invoice", body: "Indexed body", attachments: [{ filename: "one.pdf", content: "Extracted text" }], _formatted: { subject: "<em>invoice</em>" } }], total: 1, page: 1, limit: 10 }, async (client, requests) => {
    for (const detail of [undefined, "indexed_text"]) {
      const result = await client.callTool({ name: "search_archive", arguments: { keywords: "invoice", ...(detail ? { detail } : {}) } });
      assert.ok(!result.isError, text(result));
      const hit = ((result.structuredContent as Record<string, unknown>).hits as Record<string, unknown>[])[0];
      assert.equal(hit.body, detail ? "Indexed body" : undefined);
      assert.equal(hit.highlights, undefined);
      assert.match(text(result), /invoice/); assert.match(text(result), new RegExp(id));
    }
    assert.equal(requests.length, 2);
  });
});

it("source summaries normalize valid UTC timestamps and disclose field and recipient caps", async () => {
  await withTools({ items: [{ id, subject: "s".repeat(900), recipients: Array(30).fill({ email: "a".repeat(500) }), sentAt: "2024-02-29T03:00:00Z", ingestionSource: { id, name: "n".repeat(900) } }], total: 1 }, async client => {
    const result = await client.callTool({ name: "list_archive", arguments: { ingestionSourceId: id } });
    assert.ok(!result.isError, text(result));
    const item = ((result.structuredContent as Record<string, unknown>).items as Record<string, unknown>[])[0];
    assert.equal(item.sentAt, "2024-02-29T03:00:00.000Z");
    const paths = item.truncatedFields as string[];
    for (const path of ["subject", "recipients", "recipients[0].email", "source.name"]) assert.ok(paths.includes(path), path);
  });
});

it("reports every field/item truncation while keeping legacy search summary compact", async () => {
  await withTools({ hits: [{ id, subject: "s".repeat(800), to: Array(30).fill("a@example.com"), body: "b".repeat(5000), _formatted: { subject: "h".repeat(3000) }, _matchesPosition: { subject: Array(30).fill({ start: 0, length: 1 }) } }], total: -1, limit: 10, page: 1 }, async client => {
    const result = await client.callTool({ name: "search_archive", arguments: { keywords: "legacy", detail: "matches" } });
    const data = result.structuredContent as Record<string, unknown>;
    const hit = (data.hits as Record<string, unknown>[])[0];
    assert.equal(data.totalKind, "unknown"); assert.equal(data.estimatedTotal, null);
    const paths = hit.truncatedFields as string[];
    for (const path of ["subject", "to", "body", "highlights.subject", "matchLocations.subject"]) assert.ok(paths.includes(path), path);
    assert.ok(text(result).length < 2000);
    assert.match(text(result), /TRUNCATED/);
  });
});

it("discovers permission-scoped facet suggestions without directory or count claims", async () => {
  await withTools({ values: Array.from({ length: 100 }, (_, index) => `${index}@example.com${"x".repeat(321)}`), credentials: "DO-NOT-LEAK" }, async (client, requests) => {
    const result = await client.callTool({ name: "suggest_archive_values", arguments: { field: "mailboxes", query: "example & field=from" } });
    assert.ok(!result.isError, text(result));
    const data = result.structuredContent as Record<string, unknown>;
    assert.equal(data.field, "mailboxes"); assert.equal(data.suggestionOnly, true); assert.equal(data.exhaustive, false);
    assert.equal(data.totalKind, "unknown"); assert.equal(data.total, undefined);
    assert.ok((data.values as unknown[]).length <= 100);
    assert.equal(data.valuesTruncated, true);
    assert.match(String(data.trust), /UNTRUSTED/);
    assert.doesNotMatch(JSON.stringify(result), /DO-NOT-LEAK|credentials/);
    assert.equal(requests.length, 1); assert.equal(requests[0].pathname, "/api/v1/search/facets");
    assert.equal(requests[0].searchParams.get("field"), "mailboxes"); assert.equal(requests[0].searchParams.get("query"), "example & field=from");
  });
});

it("lists one database source page independently of the index with merged-group row counts", async () => {
  await withTools({ items: [{ id, subject: "Not indexed yet", senderEmail: "sender@example.com", recipients: [{ name: "Person", email: "one@example.com" }], sentAt: "2024-02-29T03:00:00Z", ingestionSourceId: id, ingestionSource: { id, name: "Mailbox", credentials: "DO-NOT-LEAK" }, raw: "DO-NOT-LEAK" }], total: 42, page: 2, limit: 10 }, async (client, requests) => {
    const result = await client.callTool({ name: "list_archive", arguments: { ingestionSourceId: id, page: 2 } });
    assert.ok(!result.isError, text(result));
    const data = result.structuredContent as Record<string, unknown>;
    assert.equal(data.totalRows, 42); assert.equal(data.totalKind, "exact_source_rows"); assert.equal(data.indexBacked, false);
    assert.match(String(data.coverage), /merged/i); assert.match(String(data.coverage), /snapshot/i);
    const items = data.items as Record<string, unknown>[];
    assert.equal(items[0].subject, "Not indexed yet");
    assert.equal(items[0].to, undefined); assert.equal(items[0].recipientRoleBasis, "unknown");
    assert.doesNotMatch(JSON.stringify(result), /DO-NOT-LEAK|credentials|"raw"/);
    assert.equal(requests.length, 1); assert.equal(requests[0].pathname, `/api/v1/archived-emails/ingestion-source/${id}`);
    assert.equal(requests[0].searchParams.get("page"), "2"); assert.equal(requests[0].searchParams.get("limit"), "10");
  });
});

it("strict transport validation rejects unknown fields and ineffective searches before HTTP", async () => {
  await withTools({ hits: [] }, async (client, requests) => {
    const invalid = [{ keywords: "x", arbitrary: true }, { keywords: "x", filters: { arbitrary: true } }, {}, { sort: "date_asc" }, { searchIn: ["body"] }, { filters: { dateFrom: "2023-02-29" } }, { filters: { from: ["a,b@example.com"] } }];
    for (const args of invalid) {
      const result = await client.callTool({ name: "search_archive", arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(requests.length, 0);
    const listed = (await client.listTools()).tools.find(tool => tool.name === "search_archive")!;
    assert.equal(listed.inputSchema.additionalProperties, false);
  });
});

it("search projects bounded untrusted indexed results with estimated UTC sent-date provenance", async () => {
  await withTools({ hits: [{ id, subject: "Fixture invoice", from: "sender@example.com", to: ["to@example.com"], cc: ["cc@example.com"], bcc: ["bcc@example.com"], body: "x".repeat(10000), attachments: [{ filename: "invoice.pdf", content: "a".repeat(10000) }], timestamp: 1709164800000, userEmail: "mailbox@example.com", ingestionSourceId: id, _formatted: { subject: '<em>invoice</em><script>untrusted</script>', password: "DO-NOT-LEAK" }, _matchesPosition: { subject: [{ start: 0, length: 7 }], password: [{ start: 0, length: 8 }] }, raw: "DO-NOT-LEAK", credentials: "DO-NOT-LEAK" }], total: 121, totalPages: 13, page: 1, limit: 10, processingTimeMs: 2 }, async (client, requests) => {
    const result = await client.callTool({ name: "search_archive", arguments: { filters: { dateFrom: "2024-02-29", hasAttachments: false }, detail: "matches" } });
    assert.ok(!result.isError, text(result));
    const data = result.structuredContent as Record<string, unknown>;
    assert.equal(data.estimatedTotal, 121); assert.equal(data.totalKind, "estimated"); assert.equal(data.indexBacked, true);
    assert.equal(data.timestampBasis, "sentAt"); assert.equal(data.dateBoundary, "UTC");
    assert.match(String(data.trust), /UNTRUSTED/);
    const hits = data.hits as Record<string, unknown>[];
    assert.equal(hits[0].sentAt, "2024-02-29T00:00:00.000Z");
    assert.deepEqual(hits[0].cc, ["cc@example.com"]); assert.deepEqual(hits[0].bcc, ["bcc@example.com"]);
    assert.ok(String(hits[0].body).length < 5000);
    assert.match(JSON.stringify(hits[0]), /<em>invoice<\/em>/);
    assert.doesNotMatch(JSON.stringify(result), /DO-NOT-LEAK|password|credentials|"raw"/);
    assert.match(text(result), /Fixture invoice/); assert.match(text(result), new RegExp(id));
    assert.equal(requests[0].searchParams.get("dateFrom"), "2024-02-29");
    assert.equal(requests[0].searchParams.get("hasAttachments"), "false");
    assert.equal(requests[0].searchParams.has("detail"), false);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64000);
  });
});
