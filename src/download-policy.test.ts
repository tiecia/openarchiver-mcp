import assert from "node:assert/strict";
import { once } from "node:events";
import { lstat, readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OpenArchiverClient, type EmailDetail } from "./client.js";
import { createServer } from "./index.js";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ORIGINAL = "archive/original.png";
const ATTACHMENT = "archive/attachments/forwarded.eml";
const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { type: string; text?: string }[]).map(item => item.text ?? "").join("\n");

async function policy(attachments: string | undefined, raw: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = [process.env.OPENARCHIVER_ENABLE_ATTACHMENTS, process.env.OPENARCHIVER_ENABLE_RAW_EXPORT];
  for (const [key, value] of [["OPENARCHIVER_ENABLE_ATTACHMENTS", attachments], ["OPENARCHIVER_ENABLE_RAW_EXPORT", raw]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  try { await run(); }
  finally {
    for (const [index, key] of ["OPENARCHIVER_ENABLE_ATTACHMENTS", "OPENARCHIVER_ENABLE_RAW_EXPORT"].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
}

async function fixture() {
  let detail: EmailDetail = { id: ID, storagePath: ORIGINAL, attachments: [{ storagePath: ATTACHMENT, filename: "forwarded.eml" }] };
  let detailStatus = 200;
  const requests: string[] = [];
  const http = createHttpServer((request, response) => {
    requests.push(request.url!);
    if (request.url!.startsWith("/api/v1/archived-emails/")) {
      response.writeHead(detailStatus, { "content-type": "application/json" });
      response.end(JSON.stringify(detailStatus === 200 ? detail : { message: "private-auth-error" }));
    } else {
      response.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="forged.png"' });
      response.end("downloaded fixture bytes");
    }
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const archive = new OpenArchiverClient(`http://127.0.0.1:${address.port}/api/v1`, "fixture-key", fetch, 2000, { allowHttpLoopback: true });
  const runtime = createServer({ getClient: () => archive });
  const client = new Client({ name: "download-policy-test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await runtime.server.connect(b);
  await client.connect(a);
  return {
    client, requests,
    setDetail: (value: EmailDetail) => { detail = value; },
    setStatus: (value: number) => { detailStatus = value; },
    call: (args: Record<string, unknown>) => client.callTool({ name: "get_attachment", arguments: args }),
    close: async () => {
      await client.close(); await runtime.close(); http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    },
  };
}

test("emailId verifies an exact attachment association on every call and allows attached .eml files without raw export", async () => {
  await policy("true", undefined, async () => {
    const f = await fixture();
    try {
      const result = await f.call({ emailId: ID, path: ATTACHMENT });
      assert.ok(!result.isError, textOf(result));
      assert.match(textOf(result), /downloaded fixture bytes/);
      assert.deepEqual(f.requests, [
        `/api/v1/archived-emails/${ID}`,
        `/api/v1/storage/download?path=${encodeURIComponent(ATTACHMENT)}`,
      ]);
      f.setDetail({ id: ID, storagePath: ORIGINAL, attachments: [] });
      const revoked = await f.call({ emailId: ID, path: ATTACHMENT });
      assert.equal(revoked.isError, true);
      assert.match(textOf(revoked), /not a verified attachment/);
      assert.equal(f.requests.length, 3, "revoked attachment must not download or use a stale association");
    } finally { await f.close(); }
  });
});

test("emailId rejects original paths even with forged .png names or conflicting attachment metadata under either raw policy", async () => {
  for (const raw of [undefined, "true"]) {
    await policy("true", raw, async () => {
      const f = await fixture();
      try {
        const metadata = await f.client.callTool({ name: "get_email", arguments: { id: ID, view: "metadata" } });
        assert.ok(!metadata.isError, textOf(metadata));
        const original = (metadata.structuredContent as { email: { storagePath: string } }).email.storagePath;
        assert.equal(original, ORIGINAL);
        for (const mode of ["inline", "file"]) {
          const result = await f.call({ emailId: ID, path: original, mode });
          assert.equal(result.isError, true);
          assert.match(textOf(result), /not a verified attachment/);
        }
        f.setDetail({ id: ID, storagePath: ORIGINAL, attachments: [{ filename: "photo.png", storagePath: ORIGINAL }] });
        const conflicting = await f.call({ emailId: ID, path: ORIGINAL });
        assert.equal(conflicting.isError, true);
        assert.ok(f.requests.every(url => url.startsWith("/api/v1/archived-emails/")), "original bytes must never be downloaded");
      } finally { await f.close(); }
    });
  }
});

test("emailId rejects attachment registries returned for a different message", async () => {
  await policy("true", undefined, async () => {
    const f = await fixture();
    try {
      f.setDetail({ id: OTHER, attachments: [{ storagePath: ATTACHMENT }] });
      const result = await f.call({ emailId: ID, path: ATTACHMENT });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /not a verified attachment/);
      assert.deepEqual(f.requests, [`/api/v1/archived-emails/${ID}`]);
    } finally { await f.close(); }
  });
});

test("legacy path-only downloads remain available only with explicit generic stored-file export opt-in", async () => {
  await policy("true", "true", async () => {
    const f = await fixture();
    try {
      const result = await f.call({ path: ORIGINAL });
      assert.ok(!result.isError, textOf(result));
      assert.deepEqual(f.requests, [`/api/v1/storage/download?path=${encodeURIComponent(ORIGINAL)}`]);
      const unlisted = await f.call({ emailId: ID, path: "archive/attachments/other.png" });
      assert.equal(unlisted.isError, true, "emailId must always narrow authorization even with raw export enabled");
      assert.equal(f.requests.length, 2);
    } finally { await f.close(); }
  });
});

test("disabled attachment policy denies both path-only and associated calls before backend access", async () => {
  for (const setting of [undefined, "false", "TRUE", "1", " true "]) {
    await policy(setting, "true", async () => {
      const f = await fixture();
      try {
        for (const args of [{ path: ORIGINAL }, { emailId: ID, path: ATTACHMENT }]) {
          const result = await f.call(args);
          assert.equal(result.isError, true);
          assert.match(textOf(result), /Attachments are disabled/);
        }
        assert.equal(f.requests.length, 0);
      } finally { await f.close(); }
    });
  }
});

test("associated downloads require successful record authorization and do not expose backend errors", async () => {
  await policy("true", undefined, async () => {
    const f = await fixture();
    try {
      for (const status of [401, 403, 404, 500]) {
        f.setStatus(status);
        const result = await f.call({ emailId: ID, path: ATTACHMENT });
        assert.equal(result.isError, true);
        assert.doesNotMatch(textOf(result), /private-auth-error|fixture-key/);
      }
      assert.equal(f.requests.length, 4);
      assert.ok(f.requests.every(url => url === `/api/v1/archived-emails/${ID}`));
    } finally { await f.close(); }
  });
});

test("attachment association uses the exact stored path, not filename, prefixes, case folding or URL decoding", async () => {
  await policy("true", undefined, async () => {
    const f = await fixture();
    try {
      for (const path of ["forwarded.eml", `${ATTACHMENT}/extra`, ATTACHMENT.toUpperCase(), "archive/attachments/%66orwarded.eml"]) {
        const result = await f.call({ emailId: ID, path });
        assert.equal(result.isError, true, path);
        assert.match(textOf(result), /not a verified attachment/);
      }
      for (const attachments of [undefined, [], [{ filename: "forwarded.eml" }]]) {
        f.setDetail({ id: ID, attachments });
        assert.equal((await f.call({ emailId: ID, path: ATTACHMENT })).isError, true);
      }
      assert.equal(f.requests.length, 7);
      assert.ok(f.requests.every(url => url === `/api/v1/archived-emails/${ID}`));
    } finally { await f.close(); }
  });
});

test("verified associations still use client path validation and never permit URL or traversal downloads", async () => {
  await policy("true", undefined, async () => {
    const f = await fixture();
    try {
      for (const path of ["archive/../original.png", "/absolute/path", "archive/%2e%2e/original", "archive/file?query", "archive/\\\\original"]) {
        f.setDetail({ id: ID, attachments: [{ storagePath: path }] });
        assert.equal((await f.call({ emailId: ID, path })).isError, true);
      }
      assert.equal(f.requests.length, 5);
      assert.ok(f.requests.every(url => url === `/api/v1/archived-emails/${ID}`));
    } finally { await f.close(); }
  });
});

test("malformed emailId is rejected before authorization or download without normalizing identifiers", async () => {
  await policy("true", "true", async () => {
    const f = await fixture();
    try {
      for (const emailId of ["", " spaced ", "a/b", "..", `${ID}\n`, "x".repeat(129), "\ud800", 123]) {
        assert.equal((await f.call({ emailId, path: ATTACHMENT })).isError, true, JSON.stringify(emailId));
      }
      assert.equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
});

test("associated downloads reject caller-selected output paths before any backend request", async () => {
  await policy("true", undefined, async () => {
    const f = await fixture();
    try {
      const result = await f.call({ emailId: ID, path: ATTACHMENT, mode: "file", outputPath: "/caller-selected-output" });
      assert.equal(result.isError, true);
      assert.equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
});

test("verified attachment file mode returns exact bytes in a private server-selected file removed on close", async () => {
  await policy("true", undefined, async () => {
    const f = await fixture();
    let target = "";
    try {
      const result = await f.call({ emailId: ID, path: ATTACHMENT, mode: "file" });
      assert.ok(!result.isError, textOf(result));
      target = textOf(result).split("\n").at(-1)!;
      assert.equal(await readFile(target, "utf8"), "downloaded fixture bytes");
      assert.equal((await lstat(target)).mode & 0o777, 0o600);
      assert.equal(f.requests.length, 2);
    } finally { await f.close(); }
    await assert.rejects(lstat(target), { code: "ENOENT" });
  });
});

test("attachment-only opt-in rejects path-only original exports before backend access regardless of filename", async () => {
  for (const raw of [undefined, "false", "TRUE", "1", " true ", "true\n"]) {
    await policy("true", raw, async () => {
      const f = await fixture();
      try {
        for (const mode of ["inline", "file"]) {
          const result = await f.call({ path: ORIGINAL, mode });
          assert.equal(result.isError, true);
          assert.match(textOf(result), /emailId/);
          assert.equal(f.requests.length, 0);
        }
      } finally { await f.close(); }
    });
  }
});
