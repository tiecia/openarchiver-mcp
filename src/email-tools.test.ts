import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OpenArchiverClient } from "./client.js";
import { AttachmentFiles, OperationGate } from "./runtime.js";
import { archiveResult } from "./results.js";
import type { ToolContext, ToolResult } from "./tool-context.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DENIED = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);
type Handler = (path: string) => unknown | Promise<unknown>;

async function withTools(handler: Handler, run: (client: Client, calls: string[]) => Promise<void>, parse?: ToolContext["parse"], resultSerializer?: ToolContext["result"]): Promise<void> {
  const server = new McpServer({ name: "email-fixtures", version: "0" });
  const gate = new OperationGate();
  const files = new AttachmentFiles();
  const calls: string[] = [];
  const archive = new OpenArchiverClient("https://fixture.invalid/api/v1", "fixture-key", async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const data = await handler(path);
    return data instanceof Response ? data : new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  });
  const modulePath = "./email-tools.js";
  const module = await import(modulePath).catch(() => undefined);
  assert.equal(typeof module?.registerEmailTools, "function", "email tool registration is implemented");
  module.registerEmailTools({ server, files, mimeOptions: {}, parse, getClient: () => archive,
    guarded: (operation: () => Promise<ToolResult>) => gate.run(operation).catch(() => ({ isError: true, content: [{ type: "text", text: "Error: request failed." }] })),
    result: resultSerializer ?? ((summary: string, data: Record<string, unknown>) => ({ content: [{ type: "text", text: `UNTRUSTED ARCHIVE DATA\n${summary}` }], structuredContent: data })),
  } satisfies ToolContext);
  const client = new Client({ name: "email-test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try { await server.connect(b); await client.connect(a); await run(client, calls); }
  finally { await client.close(); await gate.close(); await files.close(); await server.close(); }
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("\n");
}
function dataOf(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  assert.ok(!result.isError, textOf(result));
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, any>;
}

const email = (id = ID, extra: Record<string, unknown> = {}) => ({ id, subject: "Fixture subject", senderEmail: "sender@example.invalid", recipients: [{ name: "Recipient", email: "recipient@example.invalid" }], sentAt: "2026-01-01T12:00:00.000Z", ...extra });

test("real shared serialization retains integrity item-truncation coverage through MCP", async () => {
  await withTools(() => Array.from({ length: 100 }, () => ({ type: "email", id: ID, isValid: true, storedHash: HASH, computedHash: HASH })), async (client) => {
    const result = await client.callTool({ name: "check_integrity", arguments: { id: ID, includeHashes: true } });
    const data = dataOf(result);
    assert.equal(data.coverage, "truncated_report_items");
    assert.equal(data.itemsTruncated, true);
    assert.equal(data.returnedItems, data.items.length);
    assert.match(textOf(result), /TRUNCATED/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64_000);
  }, undefined, archiveResult);
});

test("strict schemas reject unknown arguments and invalid values before HTTP", async () => {
  await withTools(() => assert.fail("invalid arguments must not fetch"), async (client, calls) => {
    for (const [name, args] of [
      ["get_email", { id: ID, view: "raw" }], ["get_email", { id: ID, outputPath: "/private" }],
      ["get_email_thread", { emailId: "../invalid" }], ["get_email_thread", { emailId: ID, limit: 21 }],
      ["get_email_thread", { emailId: ID, page: 2 }], ["get_email_thread", { emailId: ID, cursor: "invalid" }],
      ["check_integrity", { id: ID, includeHashes: "true" }], ["check_integrity", { id: ID, path: "/private" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(calls, []);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 3);
    for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
  });
});

test("permission and availability failures never trigger fallback or expose backend diagnostics", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    await withTools(() => new Response("SECRET /private/backend injected instruction", { status }), async (client, calls) => {
      for (const name of ["get_email", "get_email_thread", "check_integrity"]) {
        const result = await client.callTool({ name, arguments: name === "get_email_thread" ? { emailId: ID } : { id: ID } });
        assert.equal(result.isError, true);
        assert.doesNotMatch(JSON.stringify(result), /SECRET|private|injected/);
      }
      assert.equal(calls.length, 3);
    });
  }
  for (const status of [401, 429, 500]) {
    await withTools((path) => path.endsWith(ID) ? email(ID, { thread: [{ id: OTHER }] }) : new Response("SECRET", { status }), async (client) => {
      const result = await client.callTool({ name: "get_email_thread", arguments: { emailId: ID } });
      assert.equal(result.isError, true, `non-scoped member ${status} must fail sanitized, not silently skip`);
      assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    });
  }
});

test("thread cursors cannot be tampered with or reused for a different seed", async () => {
  await withTools((path) => path.endsWith(ID) ? email(ID, { thread: [{ id: ID }, { id: OTHER }] }) : email(OTHER), async (client, calls) => {
    const first = dataOf(await client.callTool({ name: "get_email_thread", arguments: { emailId: ID, limit: 1 } }));
    const cursor = first.pagination.nextCursor;
    for (const [emailId, token] of [[OTHER, cursor], [ID, (cursor[0] === "A" ? "B" : "A") + cursor.slice(1)]]) {
      const result = await client.callTool({ name: "get_email_thread", arguments: { emailId, cursor: token } });
      assert.equal(result.isError, true);
      assert.doesNotMatch(JSON.stringify(result), /decrypt|auth|cipher|private/);
    }
    assert.equal(calls.length, 2);
  });
});

test("malformed integrity items and excessive reports fail sanitized", async () => {
  for (const results of [[null], [{ id: ID, type: "email", isValid: "true" }], Array(1001).fill({ id: ID, type: "email", isValid: true })]) {
    await withTools(() => results, async (client) => {
      const result = await client.callTool({ name: "check_integrity", arguments: { id: ID, includeHashes: true } });
      assert.equal(result.isError, true);
    });
  }
});

test("body projection marks its own truncation while preserving readable legacy body text", async () => {
  await withTools(() => email(ID, { raw: Buffer.from("Content-Type: text/plain\r\n\r\nSTART " + "x".repeat(10_000) + " END") }), async (client) => {
    const result = await client.callTool({ name: "get_email", arguments: { id: ID } });
    const data = dataOf(result);
    assert.ok(data.email.body.length <= 4096);
    assert.ok(data.email.truncatedFields.includes("body"));
    assert.match(textOf(result), /--- Body ---\nSTART/);
    assert.match(textOf(result), / END/);
  });
});

test("thread summaries mark per-field truncation and stay within combined response budgets", async () => {
  await withTools((path) => path.endsWith(ID) ? email(ID, { thread: [{ id: OTHER }] }) : email(OTHER, { subject: "😀".repeat(5000), senderName: "x".repeat(5000), senderEmail: "x".repeat(5000) }), async (client) => {
    const result = await client.callTool({ name: "get_email_thread", arguments: { emailId: ID } });
    const item = dataOf(result).messages[0];
    assert.ok(item.subject.length <= 160);
    assert.ok(item.senderName.length <= 160);
    assert.ok(item.senderEmail.length <= 160);
    assert.deepEqual(item.truncatedFields.sort(), ["senderEmail", "senderName", "subject"]);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64_000);
  });
});

test("thread seed identity is checked before using its unauthenticated candidate list", async () => {
  await withTools(() => email(OTHER, { thread: [{ id: DENIED }] }), async (client, calls) => {
    const result = await client.callTool({ name: "get_email_thread", arguments: { emailId: ID } });
    assert.equal(result.isError, true);
    assert.deepEqual(calls, [`/api/v1/archived-emails/${ID}`]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${OTHER}|${DENIED}`));
  });
});

test("integrity validates hashes and bounds item projection without changing full-report verdict", async () => {
  await withTools(() => Array.from({ length: 100 }, (_, i) => ({
    type: "email", id: ID, isValid: i !== 99, filename: "x".repeat(2000), reason: "x".repeat(2000),
    storedHash: "INVALID_HASH_SECRET", computedHash: i === 0 ? HASH : "BAD_HASH_SECRET",
  })), async (client) => {
    const result = await client.callTool({ name: "check_integrity", arguments: { id: ID, includeHashes: true } });
    const data = dataOf(result);
    assert.equal(data.verdict, "failed");
    assert.equal(data.items.length, 20);
    assert.equal(data.returnedItems, 20);
    assert.equal(data.totalItems, 100);
    assert.equal(data.totalKind, "exact_report_items");
    assert.equal(data.truncated, true);
    assert.equal(data.items[0].storedHash, undefined);
    assert.equal(data.items[0].computedHash, HASH);
    assert.ok(data.items[0].filename.length <= 160);
    assert.ok(data.items[0].truncatedFields.includes("filename"));
    assert.doesNotMatch(JSON.stringify(result), /INVALID_HASH_SECRET|BAD_HASH_SECRET/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64_000);
  });
});

test("integrity defaults stay compact and optional hashes include passing items", async () => {
  await withTools(() => [
    { type: "email", id: ID, isValid: true, storedHash: HASH, computedHash: HASH, arbitrary: "BACKEND_SECRET" },
    { type: "attachment", id: OTHER, filename: "fixture.txt", isValid: false, reason: "hash mismatch", storedHash: HASH, computedHash: "b".repeat(64) },
  ], async (client, calls) => {
    const compact = await client.callTool({ name: "check_integrity", arguments: { id: ID } });
    const compactData = dataOf(compact);
    assert.equal(compactData.includeHashes, false);
    assert.equal(compactData.items[0].storedHash, undefined);
    assert.equal(compactData.items[0].computedHash, undefined);
    assert.equal(compactData.items[1].storedHash, HASH);
    assert.match(textOf(compact), /FAILED/);
    const result = await client.callTool({ name: "check_integrity", arguments: { id: ID, includeHashes: true } });
    const data = dataOf(result);
    assert.equal(data.includeHashes, true);
    assert.equal(data.items[0].storedHash, HASH);
    assert.equal(data.items[0].computedHash, HASH);
    assert.equal(data.verdict, "failed");
    assert.equal(data.returnedItems, 2);
    assert.match(textOf(result), new RegExp(HASH));
    assert.doesNotMatch(JSON.stringify(result), /BACKEND_SECRET/);
    assert.deepEqual(calls, [`/api/v1/integrity/${ID}`, `/api/v1/integrity/${ID}`]);
  });
});

test("thread candidate byte budget fails closed before member reads", async () => {
  for (const thread of [[{ id: OTHER, subject: "x".repeat(200_000) }], Array.from({ length: 1001 }, () => ({ id: OTHER })), [{ id: "../SECRET" }], { id: OTHER }]) {
    await withTools(() => email(ID, { thread }), async (client, calls) => {
      const result = await client.callTool({ name: "get_email_thread", arguments: { emailId: ID } });
      assert.equal(result.isError, true);
      assert.deepEqual(calls, [`/api/v1/archived-emails/${ID}`]);
      assert.doesNotMatch(JSON.stringify(result), /SECRET|subject/);
    });
  }
});

test("thread continuation pages authorized members only with bounded complete reauthorization", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const visited: string[] = [];
  await withTools((path) => {
    const id = path.split("/").at(-1)!;
    if (id === ID) return email(ID, { thread: ids.map(id => ({ id })) });
    visited.push(id);
    if (ids.indexOf(id) % 2) return new Response("SECRET", { status: 404 });
    return email(id);
  }, async (client, calls) => {
    const first = dataOf(await client.callTool({ name: "get_email_thread", arguments: { emailId: ID, limit: 5 } }));
    assert.equal(visited.length, 20);
    assert.equal(calls.length, 21);
    assert.equal(first.messages.length, 5);
    const cursor = first.pagination.nextCursor;
    assert.match(cursor, /^[A-Za-z0-9_-]{54}$/);
    assert.equal(first.pagination.more, true);
    const second = dataOf(await client.callTool({ name: "get_email_thread", arguments: { emailId: ID, cursor, limit: 5 } }));
    assert.deepEqual(visited, [...ids, ...ids]);
    assert.equal(second.messages.length, 5);
    assert.equal(second.pagination.more, false);
    assert.equal(second.pagination.nextCursor, undefined);
    assert.doesNotMatch(JSON.stringify(second), /deniedCount|candidateCount|totalPages|scannedItems/);
  });
  await withTools(() => email(), async client => {
    const data = dataOf(await client.callTool({ name: "get_email_thread", arguments: { emailId: ID } }));
    assert.equal(data.pagination.nextCursor, undefined);
    assert.equal(data.pagination.more, false);
  });
});

test("thread reads authorize every visible member and silently omit scoped 403 and 404", async () => {
  const missing = "44444444-4444-4444-8444-444444444444";
  const seed = email(ID, { sentAt: "2026-01-02T12:00:00Z", thread: [
    { id: OTHER, subject: "ATTACKER_SUMMARY", sentAt: "2099-01-01" }, { id: DENIED, subject: "DENIED_SUBJECT" },
    { id: missing, senderEmail: "DENIED_SENDER" }, { id: ID },
  ] });
  await withTools((path) => {
    if (path.endsWith(ID)) return seed;
    if (path.endsWith(DENIED)) return new Response("DENIAL_SECRET", { status: 403 });
    if (path.endsWith(missing)) return new Response("MISSING_SECRET", { status: 404 });
    return email(OTHER, { subject: "Authorized detail", sentAt: "2026-01-01T12:00:00Z", raw: { type: "Buffer", data: [-1] } });
  }, async (client, calls) => {
    const result = await client.callTool({ name: "get_email_thread", arguments: { emailId: ID } });
    const data = dataOf(result);
    assert.deepEqual(data.messages.map((item: any) => item.id), [OTHER, ID]);
    assert.equal(data.messages[0].subject, "Authorized detail");
    assert.equal(data.totalKind, "unknown");
    assert.equal(data.coverage, "bounded_authorized_candidate_scan");
    assert.equal(data.pagination.returnedItems, 2);
    assert.equal(data.pagination.candidateCount, undefined);
    assert.equal(data.pagination.deniedCount, undefined);
    assert.equal(data.pagination.total, undefined);
    assert.match(data.warnings.join(" "), /before pagination/i);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${DENIED}|${missing}|DENIED_|DENIAL_|MISSING_|ATTACKER_|\"raw\"|\"body\"`));
    assert.deepEqual(calls, [ID, OTHER, DENIED, missing].map((id) => `/api/v1/archived-emails/${id}`));
  }, async () => { assert.fail("thread must not parse bodies"); });
});

test("trusted parser injection preserves skip options and HTML fallback isolation", async () => {
  for (const html of [false, "<p>Injected HTML body</p><img src='https://tracker.invalid/pixel'>"]) {
    let parsed = 0;
    await withTools(() => email(ID, { raw: { type: "Buffer", data: [65] } }), async (client) => {
      const result = await client.callTool({ name: "get_email", arguments: { id: ID } });
      const data = dataOf(result);
      assert.equal(parsed, 1);
      assert.match(data.email.body, html ? /Injected HTML body/ : /Injected text body/);
      assert.doesNotMatch(data.email.body, /tracker.invalid|<p>/);
    }, async (_raw, options) => {
      parsed++;
      assert.deepEqual(options, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
      return { text: html ? undefined : "Injected text body", html } as Awaited<ReturnType<NonNullable<ToolContext["parse"]>>>;
    });
  }
});

test("malformed detail recipient collections fail sanitized instead of becoming empty recipients", async () => {
  for (const recipients of ["RECIPIENT_SECRET", null, [null], [{ email: 123 }], [{ name: { secret: "RECIPIENT_SECRET" } }]]) {
    await withTools(() => email(ID, { recipients }), async (client) => {
      for (const view of ["metadata", "body"]) {
        const result = await client.callTool({ name: "get_email", arguments: { id: ID, view } });
        assert.equal(result.isError, true, `malformed recipients: ${JSON.stringify(recipients)}`);
        assert.equal(result.structuredContent, undefined);
        assert.equal(textOf(result), "Error: request failed.");
        assert.doesNotMatch(JSON.stringify(result), /RECIPIENT_SECRET|Recipients:|Attachments: none/);
      }
    });
  }
});

test("malformed detail attachments fail sanitized instead of claiming no attachments", async () => {
  for (const attachments of ["ATTACHMENT_SECRET", null, [null], [{ filename: { secret: "ATTACHMENT_SECRET" } }], [{ id: 123 }], [{ mimeType: 123 }], [{ sizeBytes: -1 }], [{ storagePath: [] }]]) {
    await withTools(() => email(ID, { attachments }), async (client) => {
      for (const view of ["metadata", "body"]) {
        const result = await client.callTool({ name: "get_email", arguments: { id: ID, view } });
        assert.equal(result.isError, true, `malformed attachments: ${JSON.stringify(attachments)}`);
        assert.equal(result.structuredContent, undefined);
        assert.equal(textOf(result), "Error: request failed.");
        assert.doesNotMatch(JSON.stringify(result), /ATTACHMENT_SECRET|Attachments: none/);
      }
    });
  }
});

test("detail metadata reports bounded invalid fields without reflecting malformed scalar values", async () => {
  await withTools(() => email(ID, {
    subject: { secret: "SCALAR_SECRET" }, senderName: false, hasAttachments: "SCALAR_SECRET", sizeBytes: -1,
    archivedAt: 42, ingestionSource: { id: 42, name: ["SCALAR_SECRET"] }, tags: Array(1000).fill(42),
    invalidFields: Array(1000).fill("UNTRUSTED_DIAGNOSTIC"),
  }), async (client) => {
    const result = await client.callTool({ name: "get_email", arguments: { id: ID, view: "metadata" } });
    const data = dataOf(result);
    assert.deepEqual(data.email.invalidFields.sort(), ["archivedAt", "hasAttachments", "ingestionSource.id", "ingestionSource.name", "senderName", "sizeBytes", "subject", "tags"]);
    assert.ok(data.email.invalidFields.length <= 32);
    assert.doesNotMatch(JSON.stringify(result), /SCALAR_SECRET|UNTRUSTED_DIAGNOSTIC/);
  });
});

test("missing detail collections remain unknown while explicit empty collections remain empty", async () => {
  for (const supplied of [false, true]) {
    await withTools(() => supplied ? email(ID, { recipients: [], attachments: [] }) : { id: ID }, async (client) => {
      const result = await client.callTool({ name: "get_email", arguments: { id: ID, view: "metadata" } });
      const data = dataOf(result);
      assert.deepEqual(data.email.recipients, supplied ? [] : undefined);
      assert.deepEqual(data.email.attachments, supplied ? [] : undefined);
      assert.match(textOf(result), supplied ? /Attachments: none/ : /Attachments: unknown/);
    });
  }
});

test("detail timestamps reject ambiguous or impossible values without inventing normalized dates", async () => {
  for (const timestamp of [
    "2026-02-30T12:00:00Z", "2025-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z",
    "2026-01-00T00:00:00Z", "2026-01-01", "2026-01-01T12:00:00", "01/02/2026", "2026-01-01 12:00:00Z",
    "2026-01-01T24:00:00Z", "2026-01-01T12:60:00Z", "2026-01-01T12:00:60Z", "2026-01-01T12:00:00+24:00",
    "2026-01-01T12:00:00+01:60", "2026-01-01T12:00:00-00:00", " 2026-01-01T12:00:00Z", "2026-01-01T12:00:00Z ",
  ]) {
    await withTools(() => email(ID, { sentAt: timestamp, archivedAt: timestamp }), async (client) => {
      const result = await client.callTool({ name: "get_email", arguments: { id: ID, view: "metadata" } });
      const metadata = dataOf(result).email;
      assert.equal(metadata.sentAt, undefined, timestamp);
      assert.equal(metadata.archivedAt, undefined, timestamp);
      assert.deepEqual(metadata.invalidFields.sort(), ["archivedAt", "sentAt"]);
      assert.match(textOf(result), /Date: unknown/);
      assert.doesNotMatch(textOf(result), /Date: 2026-03-02/);
    });
  }
});

test("detail timestamps accept real leap days and normalize explicit offsets to UTC", async () => {
  for (const [timestamp, expected] of [
    ["2024-02-29T23:59:59Z", "2024-02-29T23:59:59.000Z"],
    ["2000-02-29T12:34:56.123456789+05:30", "2000-02-29T07:04:56.123Z"],
    ["2026-01-01T00:15:00-01:00", "2026-01-01T01:15:00.000Z"],
    ["2026-01-01t12:00:00z", "2026-01-01T12:00:00.000Z"],
    ["2026-01-01T12:00:00+00:00", "2026-01-01T12:00:00.000Z"],
  ]) {
    await withTools(() => email(ID, { sentAt: timestamp, archivedAt: timestamp }), async (client) => {
      const result = await client.callTool({ name: "get_email", arguments: { id: ID, view: "metadata" } });
      const metadata = dataOf(result).email;
      assert.equal(metadata.sentAt, expected);
      assert.equal(metadata.archivedAt, expected);
      assert.equal(metadata.invalidFields, undefined);
      assert.match(textOf(result), new RegExp(`Date: ${expected.replaceAll(".", "\\.")}`));
    });
  }
});

test("UUID identity comparison validates tokens before case folding and never changes source IDs", async () => {
  const module = await import("./email-tools.js") as unknown as { sameUuid: (a: unknown, b: unknown) => boolean };
  assert.equal(typeof module.sameUuid, "function", "validated UUID comparison is available to thread authorization");
  const lower = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  assert.equal(module.sameUuid(lower, lower.toUpperCase()), true);
  assert.equal(module.sameUuid(lower, OTHER), false);
  for (const invalid of [null, undefined, 42, lower + " ", " " + lower, lower + "\n", lower.replaceAll("-", ""), "NOT-A-UUID"]) {
    assert.equal(module.sameUuid(invalid, invalid), false, `invalid UUID ${JSON.stringify(invalid)}`);
    assert.equal(module.sameUuid(lower, invalid), false);
  }
});

test("metadata projection bounds hostile fields and collections with explicit truncation", async () => {
  await withTools(() => email(ID, {
    subject: "x".repeat(100_000), storageHashSha256: "not-a-hash", indexAttempts: -1,
    recipients: Array.from({ length: 1000 }, () => ({ email: "x".repeat(10_000) })),
    attachments: Array.from({ length: 1000 }, () => ({ id: OTHER, filename: "x".repeat(10_000) })),
    tags: Array(1000).fill("x".repeat(10_000)),
  }), async (client) => {
    const result = await client.callTool({ name: "get_email", arguments: { id: ID, view: "metadata" } });
    const data = dataOf(result);
    assert.ok(data.email.subject.length <= 512);
    assert.ok(data.email.recipients.length <= 20);
    assert.ok(data.email.attachments.length <= 20);
    assert.ok(data.email.tags.length <= 20);
    assert.ok(data.email.truncatedFields.includes("subject"));
    assert.ok(data.email.truncatedFields.includes("recipients"));
    assert.ok(data.email.truncatedFields.includes("attachments"));
    assert.ok(data.email.truncatedFields.includes("tags"));
    assert.equal(data.email.storageHashSha256, undefined);
    assert.equal(data.email.indexAttempts, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64_000);
  });
});

test("metadata view skips MIME parsing and allowlists richer backend metadata", async () => {
  await withTools(() => email(ID, {
    raw: { type: "Buffer", data: [-1] }, userEmail: "mailbox@example.invalid", archivedAt: "2026-01-02T12:00:00.000Z",
    ingestionSourceId: OTHER, ingestionSource: { id: OTHER, name: "Fixture source", credentials: "SOURCE_SECRET" },
    providerMessageId: "provider-id", threadId: "thread-id", isIndexed: false, indexAttempts: 3,
    isOnLegalHold: true, isJournaled: false, storagePath: "archive/original.eml", storageHashSha256: HASH,
    attachments: [{ id: OTHER, filename: "fixture.txt", storagePath: "archive/attachment.txt", credentials: "ATTACHMENT_SECRET" }],
    thread: [{ id: DENIED, subject: "DENIED_SUBJECT" }], arbitrary: "BACKEND_SECRET",
  }), async (client) => {
    const result = await client.callTool({ name: "get_email", arguments: { id: ID, view: "metadata" } });
    const data = dataOf(result);
    assert.equal(data.view, "metadata");
    assert.equal(data.email.body, undefined);
    assert.equal(data.email.mailbox, "mailbox@example.invalid");
    assert.equal(data.email.archivedAt, "2026-01-02T12:00:00.000Z");
    assert.deepEqual(data.email.ingestionSource, { id: OTHER, name: "Fixture source" });
    assert.equal(data.email.ingestionSourceId, OTHER);
    assert.equal(data.email.providerMessageId, "provider-id");
    assert.equal(data.email.threadId, "thread-id");
    assert.equal(data.email.isIndexed, false);
    assert.equal(data.email.indexAttempts, 3);
    assert.equal(data.email.isOnLegalHold, true);
    assert.equal(data.email.isJournaled, false);
    assert.equal(data.email.storagePath, "archive/original.eml");
    assert.equal(data.email.storageHashSha256, HASH);
    assert.equal(data.email.attachments[0].id, OTHER);
    assert.equal(data.recipientRoles, "unknown");
    assert.equal(data.timestampBasis, "sentAt");
    assert.doesNotMatch(JSON.stringify(result), /SOURCE_SECRET|ATTACHMENT_SECRET|BACKEND_SECRET|DENIED_SUBJECT|\"raw\"/);
    assert.doesNotMatch(textOf(result), /--- Body ---|no text body/);
  }, async () => { assert.fail("metadata must not parse MIME"); });
});

test("legacy get_email defaults to worker-parsed body with structured display metadata", async () => {
  await withTools(() => email(ID, { raw: Buffer.from("Content-Type: text/plain\r\n\r\nFixture body") }), async (client, calls) => {
    const result = await client.callTool({ name: "get_email", arguments: { id: ID } });
    const data = dataOf(result);
    assert.equal(data.view, "body");
    assert.equal(data.email.body, "Fixture body");
    assert.equal(data.email.subject, "Fixture subject");
    assert.match(textOf(result), /Fixture body/);
    assert.match(textOf(result), /Recipients:/);
    assert.doesNotMatch(textOf(result), /\nTo:/);
    assert.deepEqual(calls, [`/api/v1/archived-emails/${ID}`]);
  });
});
