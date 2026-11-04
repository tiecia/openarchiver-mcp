import assert from "node:assert/strict";
import { it } from "node:test";
import { spawnSync } from "node:child_process";
import { OpenArchiverClient, OpenArchiverError } from "./client.js";

const id = "12345678-1234-1234-1234-123456789abc";
function clientFor(body: unknown): OpenArchiverClient {
  return new OpenArchiverClient("https://fixture.invalid", "synthetic", async () => new Response(JSON.stringify(body)));
}

it("rejects an excessive search page even when the requested limit is one", async () => {
  await assert.rejects(clientFor({ hits: Array(101).fill({ id }) }).search({ keywords: "fixture", limit: 1 }), OpenArchiverError);
});

it("rejects oversized nested collections and a shared response work budget before schema parsing", async () => {
  for (const body of [
    { hits: [{ id, to: Array(1001).fill(null) }] },
    { hits: [{ id, attachments: Array(1001).fill(null) }] },
    { hits: [{ id, _formatted: { to: Array(1001).fill(null) } }] },
    { hits: [{ id, _matchesPosition: { subject: Array(1001).fill(null) } }] },
    { hits: Array(100).fill({ id, to: Array(101).fill("recipient@example.com") }) },
  ]) await assert.rejects(clientFor(body).search({ keywords: "fixture" }), OpenArchiverError);
  await assert.rejects(clientFor({ items: Array(101).fill({ id }) }).listArchive({ ingestionSourceId: id }), OpenArchiverError);
  await assert.rejects(clientFor({ items: [{ id, recipients: Array(1001).fill(null) }] }).listArchive({ ingestionSourceId: id }), OpenArchiverError);
  for (const field of ["recipients", "attachments", "tags"]) {
    await assert.rejects(clientFor({ id, [field]: Array(1001).fill(null) }).getEmail(id), OpenArchiverError, field);
  }
  await assert.rejects(clientFor({ values: Array(101).fill("fixture") }).suggestValues({ field: "from" }), OpenArchiverError);
  await assert.rejects(clientFor(Array(1001).fill(null)).checkIntegrity(id), OpenArchiverError);
});

it("caps client invalid-field diagnostic loops at one hundred paths", async () => {
  const search = await clientFor({ hits: [{ id, attachments: Array(1000).fill({ filename: 1, content: 2 }) }] }).search({ keywords: "fixture" });
  assert.equal(search.hits[0].invalidFields?.length, 100);
  const listing = await clientFor({ items: [{ id, recipients: Array(1000).fill({ name: 1, email: 2 }) }] }).listArchive({ ingestionSourceId: id });
  assert.equal(listing.items[0].invalidFields?.length, 100);
});

it("rejects a million malformed hits without exhausting a 128 MiB child heap", { timeout: 30_000 }, () => {
  const moduleUrl = new URL("./client.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { OpenArchiverClient, OpenArchiverError } from ${JSON.stringify(moduleUrl)};
    const json = '{"hits":[' + 'null,'.repeat(999999) + 'null]}';
    const client = new OpenArchiverClient('https://fixture.invalid', 'synthetic', async () => new Response(json));
    await assert.rejects(client.search({ keywords: 'fixture', limit: 1 }), OpenArchiverError);
    console.log('controlled rejection');
  `], { encoding: "utf8", timeout: 25_000, maxBuffer: 64 * 1024 });
  assert.equal(child.status, 0, `signal=${child.signal}; ${child.stderr.slice(-4000)}`);
  assert.equal(child.stdout.trim(), "controlled rejection");
});
