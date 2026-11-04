import assert from "node:assert/strict";
import { mock, test } from "node:test";
import crypto, { createCipheriv } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OpenArchiverClient } from "./client.js";
import { registerEmailTools } from "./email-tools.js";
import { AttachmentFiles, OperationGate } from "./runtime.js";
import { archiveResult } from "./results.js";
import type { ToolContext } from "./tool-context.js";

const SEED = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
const DENIED = "44444444-4444-4444-8444-444444444444";
type Result = Awaited<ReturnType<Client["callTool"]>>;
type Handler = (id: string) => unknown | Promise<unknown>;

const email = (id: string, extra: Record<string, unknown> = {}) => ({
  id, subject: `Authorized ${id}`, senderEmail: "reader@example.invalid",
  sentAt: "2026-01-01T12:00:00.000Z", ...extra,
});

async function withTools(handler: Handler, run: (client: Client, calls: string[]) => Promise<void>): Promise<void> {
  const server = new McpServer({ name: "thread-privacy-fixtures", version: "0" });
  const gate = new OperationGate();
  const files = new AttachmentFiles();
  const calls: string[] = [];
  const archive = new OpenArchiverClient("https://fixture.invalid/api/v1", "fixture-key", async (input) => {
    const url = new URL(String(input));
    assert.match(url.pathname, /^\/api\/v1\/archived-emails\/[0-9a-f-]+$/i);
    const id = url.pathname.split("/").at(-1)!;
    calls.push(id);
    const data = await handler(id);
    return data instanceof Response ? data : new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  });
  registerEmailTools({ server, files, mimeOptions: {}, getClient: () => archive,
    parse: async () => { assert.fail("thread summaries must not parse MIME"); },
    guarded: (operation) => gate.run(operation).catch(() => ({ isError: true, content: [{ type: "text", text: "Error: request failed." }] })),
    result: archiveResult,
  } satisfies ToolContext);
  const client = new Client({ name: "thread-privacy-test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try { await server.connect(b); await client.connect(a); await run(client, calls); }
  finally { await client.close(); await gate.close(); await files.close(); await server.close(); }
}

function dataOf(result: Result): Record<string, any> {
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, any>;
}

function semanticPage(result: Result): unknown {
  // Random ciphertext and timing are not compared; every returned data field is.
  return JSON.parse(JSON.stringify(result, (key, value) => key === "nextCursor" ? "<opaque continuation>" : value));
}

async function transcript(thread: unknown[], deniedStatus: number): Promise<unknown[]> {
  const pages: unknown[] = [];
  await withTools((id) => {
    if (id === SEED) return email(SEED, { thread });
    if (id === DENIED) return new Response("DENIAL_SECRET", { status: deniedStatus });
    return email(id, { sentAt: id === A ? "2026-01-01T12:00:00Z" : "2026-01-02T12:00:00Z" });
  }, async (client) => {
    let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const result = await client.callTool({ name: "get_email_thread", arguments: { emailId: SEED, limit: 1, ...(cursor ? { cursor } : {}) } });
      const data = dataOf(result);
      pages.push(semanticPage(result));
      assert.doesNotMatch(JSON.stringify(result), new RegExp(`${DENIED}|DENIAL_SECRET|CANDIDATE_SECRET|candidateCount|deniedCount|scannedItems|totalPages`));
      cursor = data.pagination.nextCursor;
      if (!cursor) break;
    }
  });
  return pages;
}

test("thread pagination transcript is unchanged by an inaccessible candidate slot", async () => {
  for (const status of [403, 404]) {
    const visible = await transcript([{ id: A }, { id: B }], status);
    const hidden = await transcript([
      { id: A, subject: "CANDIDATE_SECRET", sentAt: "2099-01-01T00:00:00Z" },
      { id: DENIED, subject: "CANDIDATE_SECRET", senderEmail: "CANDIDATE_SECRET" },
      { id: B, subject: "CANDIDATE_SECRET", sentAt: "1900-01-01T00:00:00Z" },
    ], status);
    assert.deepEqual(hidden, visible, `HTTP ${status}: hidden slots must not change any page, continuation presence, or visible metadata`);
    assert.equal(visible.length, 2, "no dummy empty pages after the authorized list ends");
    assert.deepEqual(visible.map((page: any) => page.structuredContent.messages.map((item: any) => item.id)), [[A], [B]]);
  }
});

test("empty candidate lists and hidden-only lists have identical visible transcripts", async () => {
  for (const status of [403, 404]) {
    const empty = await transcript([], status);
    const hidden = await transcript([{ id: DENIED, subject: "CANDIDATE_SECRET" }], status);
    assert.deepEqual(hidden, empty);
  }
});

test("thread candidate sets above twenty unique IDs fail closed before member reads", async () => {
  const ids = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  await withTools((id) => id === SEED ? email(SEED, { thread: ids.map((id) => ({ id, subject: "CANDIDATE_SECRET" })) }) : email(id), async (client, calls) => {
    const result = await client.callTool({ name: "get_email_thread", arguments: { emailId: SEED, limit: 1 } });
    assert.equal(result.isError, true, "large threads must not expose partial pages or scan positions");
    assert.deepEqual(calls, [SEED]);
    assert.equal(result.structuredContent, undefined);
    assert.equal((result.content as { text: string }[])[0].text, "Error: request failed.");
    assert.doesNotMatch(JSON.stringify(result), /CANDIDATE_SECRET|00000000|candidate|21/);
  });
});

test("twenty unique candidates are completely authorized per page within twenty-one reads", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  // Duplicate candidate rows count only once, not against the unique-ID budget.
  await withTools((id) => id === SEED ? email(SEED, { thread: Array.from({ length: 1000 }, (_, i) => ({ id: ids[i % ids.length] })) }) : email(id), async (client, calls) => {
    const first = dataOf(await client.callTool({ name: "get_email_thread", arguments: { emailId: SEED, limit: 1 } }));
    assert.deepEqual(calls, [SEED, ...ids]);
    assert.equal(first.messages.length, 1);
    assert.equal(first.pagination.more, true);
    assert.match(first.pagination.nextCursor, /^[A-Za-z0-9_-]{54}$/);
    const second = dataOf(await client.callTool({ name: "get_email_thread", arguments: { emailId: SEED, limit: 20, cursor: first.pagination.nextCursor } }));
    assert.deepEqual(calls, [SEED, ...ids, SEED, ...ids]);
    assert.equal(second.messages.length, 19);
    assert.equal(second.pagination.more, false);
    assert.equal(second.pagination.nextCursor, undefined);
    assert.deepEqual([first.messages[0].id, ...second.messages.map((item: any) => item.id)], ids);
  });
});

test("UUID case variants are one candidate and preserve authorized response identifiers", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `abcdef00-0000-4000-8000-${String(i).padStart(12, "0")}`);
  await withTools((id) => id === SEED ? email(SEED, { thread: [...ids.map((id) => ({ id })), { id: ids[0].toUpperCase() }] }) : email(id.toUpperCase()), async (client, calls) => {
    const data = dataOf(await client.callTool({ name: "get_email_thread", arguments: { emailId: SEED } }));
    assert.deepEqual(calls, [SEED, ...ids]);
    assert.deepEqual(data.messages.map((item: any) => item.id), ids.map((id) => id.toUpperCase()));
    assert.equal(data.pagination.more, false);
  });
});

test("authenticated cursors reject authorized-list offsets above twenty before fetching", async () => {
  // A known process key lets this regression exercise the authenticated decoder,
  // rather than merely failing its GCM tag with a random malformed token.
  const random = mock.method(crypto, "randomBytes", ((size: number) => Buffer.alloc(size, 7)) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  try {
    await withTools(() => email(SEED), async (client, calls) => {
      const iv = Buffer.alloc(12, 8);
      const payload = Buffer.alloc(12);
      payload.writeUInt32BE(21);
      payload.writeDoubleBE(Date.now() + 60_000, 4);
      const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 7), iv);
      cipher.setAAD(Buffer.from(SEED));
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
      const cursor = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
      const result = await client.callTool({ name: "get_email_thread", arguments: { emailId: SEED, cursor } });
      assert.equal(result.isError, true, "authenticated offsets outside the bounded list are invalid");
      assert.deepEqual(calls, []);
    });
  } finally { random.mock.restore(); syncBuiltinESMExports(); }
});

test("chronological pages use freshly authorized details rather than embedded candidate metadata", async () => {
  let revoked = false;
  await withTools((id) => {
    if (id === SEED) return email(SEED, { thread: [
      { id: B, sentAt: "1900-01-01T00:00:00Z", subject: "INJECTED_CANDIDATE" },
      { id: DENIED, subject: "DENIED_CANDIDATE" },
      { id: A, sentAt: "2099-01-01T00:00:00Z", subject: "INJECTED_CANDIDATE" },
    ] });
    if (id === DENIED || (revoked && id === B)) return new Response("DENIAL_SECRET", { status: 403 });
    return email(id, { sentAt: id === A ? "2026-01-01T00:00:00Z" : "2026-01-02T00:00:00Z", raw: "RAW_SECRET", thread: [{ id: DENIED, subject: "NESTED_SECRET" }] });
  }, async (client, calls) => {
    const first = dataOf(await client.callTool({ name: "get_email_thread", arguments: { emailId: SEED, limit: 1 } }));
    assert.deepEqual(first.messages.map((item: any) => item.id), [A]);
    assert.deepEqual(calls, [SEED, B, DENIED, A], "even a limit-one page authorizes every candidate");
    revoked = true;
    const result = await client.callTool({ name: "get_email_thread", arguments: { emailId: SEED, limit: 1, cursor: first.pagination.nextCursor } });
    const second = dataOf(result);
    assert.deepEqual(calls, [SEED, B, DENIED, A, SEED, B, DENIED, A], "continuations must reauthorize, not use a stale permission snapshot");
    assert.deepEqual(second.messages, [], "revoked detail must not survive in a cached page");
    assert.equal(second.pagination.more, false);
    assert.equal(second.pagination.nextCursor, undefined);
    assert.doesNotMatch(JSON.stringify(result), /INJECTED_|DENIED_|DENIAL_|RAW_|NESTED_/);
  });
});

test("all unavailable candidates return an empty final authorized page without counts or continuations", async () => {
  await withTools((id) => id === SEED ? email(SEED, { thread: [{ id: A }, { id: B }] }) : new Response("DENIAL_SECRET", { status: id === A ? 403 : 404 }), async (client, calls) => {
    const result = await client.callTool({ name: "get_email_thread", arguments: { emailId: SEED, limit: 1 } });
    const data = dataOf(result);
    assert.deepEqual(data.messages, []);
    assert.deepEqual(data.pagination, { returnedItems: 0, limit: 1, more: false });
    assert.deepEqual(calls, [SEED, A, B]);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${A}|${B}|DENIAL_SECRET|candidateCount|deniedCount|scannedItems`));
  });
});

test("thread cursors remain seed-bound, tamper-resistant, and expire after fifteen minutes", async () => {
  await withTools((id) => id === SEED ? email(SEED, { thread: [{ id: A }, { id: B }] }) : email(id), async (client, calls) => {
    const before = Date.now();
    const first = dataOf(await client.callTool({ name: "get_email_thread", arguments: { emailId: SEED, limit: 1 } }));
    const cursor = first.pagination.nextCursor as string;
    assert.match(cursor, /^[A-Za-z0-9_-]{54}$/);
    assert.doesNotMatch(cursor, /offset|11111111|22222222|33333333/);
    for (const [emailId, token] of [[A, cursor], [SEED, (cursor[0] === "A" ? "B" : "A") + cursor.slice(1)]]) {
      const result = await client.callTool({ name: "get_email_thread", arguments: { emailId, cursor: token } });
      assert.equal(result.isError, true);
    }
    const clock = mock.method(Date, "now", () => before + 16 * 60_000);
    try {
      const result = await client.callTool({ name: "get_email_thread", arguments: { emailId: SEED, cursor } });
      assert.equal(result.isError, true);
    } finally { clock.mock.restore(); }
    assert.deepEqual(calls, [SEED, A, B], "bad cursors must fail before new record reads");
  });
});
