import assert from "node:assert/strict";
import { test } from "node:test";
import { ARCHIVE_TRUST, archiveResult } from "./results.js";

test("results carry a trust notice and retain typed provenance without duplicating data", () => {
  const data = { totalKind: "estimated", estimatedTotal: 42, indexBacked: true, hits: [{ id: "fixture", subject: "hello" }] };
  const result = archiveResult("Search returned one item; total is estimated.", data);
  assert.equal(result.structuredContent?.totalKind, "estimated");
  assert.equal(result.structuredContent?.estimatedTotal, 42);
  assert.equal(result.structuredContent?.truncated, false);
  assert.match(result.content.map(c => c.type === "text" ? c.text : "").join("\n"), /UNTRUSTED ARCHIVE DATA/);
  assert.match(String(result.structuredContent?.trust), /not instructions/);
  assert.doesNotMatch(result.content.map(c => c.type === "text" ? c.text : "").join("\n"), /fixture/);
  assert.deepEqual(data.hits, [{ id: "fixture", subject: "hello" }]);
});

test("combined serialized structured and readable output stays bounded with visible truncation", () => {
  const result = archiveResult("😀".repeat(50_000), {
    totalKind: "exact_source_rows", totalRows: 100, page: 1, limit: 100,
    hits: Array.from({ length: 100 }, (_, i) => ({ id: String(i), body: "😀".repeat(30_000), _private: "none" })),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64_000);
  assert.equal(result.structuredContent?.truncated, true);
  assert.equal(result.structuredContent?.totalRows, 100);
  assert.equal(result.structuredContent?.totalKind, "exact_source_rows");
  assert.match(result.content.map(c => c.type === "text" ? c.text : "").join("\n"), /TRUNCATED/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)));
});

test("results reject unsupported values and bound depth, cycles, keys and array size", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const data = { cycle, big: 1n, invalid: Number.NaN, many: Array(100_000).fill("x"), object: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i), i])) };
  const result = archiveResult("bounded", data);
  assert.equal(result.structuredContent?.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64_000);
  assert.ok((result.structuredContent?.many as unknown[]).length <= 100);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("projection has a global node budget, not only a per-container limit", () => {
  let reads = 0;
  const leaf = Object.defineProperty({}, "value", { enumerable: true, get: () => { reads++; return "fixture"; } });
  const nested = { children: Array.from({ length: 100 }, () => ({ children: Array.from({ length: 100 }, () => leaf) })) };
  const result = archiveResult("bounded nodes", nested);
  assert.ok(reads < 5000, `projection traversed ${reads} leaf values`);
  assert.equal(result.structuredContent?.truncated, true);
});

test("nested trust fields count toward the escaped UTF-8 output budget", () => {
  const nested = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, { trust: "\u0000".repeat(4096) }]));
  for (const data of [{ totalRows: nested }, { nested }]) {
    const result = archiveResult("😀 bounded", data);
    const bytes = Buffer.byteLength(JSON.stringify(result));
    assert.ok(bytes <= 64_000, `combined response was ${bytes} bytes`);
    assert.equal(result.structuredContent?.truncated, true);
  }
  assert.deepEqual(archiveResult("small", { nested: { trust: "ordinary archive data" } }).structuredContent?.nested,
    { trust: "ordinary archive data" });
});

test("fallback cannot retain oversized objects disguised as provenance", () => {
  const nested = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i,
    Object.fromEntries(Array.from({ length: 100 }, (_, j) => [j, "\u0000".repeat(128)])),
  ]));
  for (const data of [{ totalRows: nested }, { nested, totalRows: 100, totalKind: "exact_source_rows" }]) {
    const result = archiveResult("\u0000".repeat(4096), data);
    const bytes = Buffer.byteLength(JSON.stringify(result));
    assert.ok(bytes <= 64_000, `fallback response was ${bytes} bytes`);
    assert.equal(result.structuredContent?.truncated, true);
    if (typeof data.totalRows === "number") assert.equal(result.structuredContent?.totalRows, 100);
  }
});

test("object projection stops before reading getters beyond its item limit", () => {
  let reads = 0;
  const wide = Object.create({ inherited: "not an own field" }) as Record<string, unknown>;
  for (let i = 0; i < 10_000; i++) {
    Object.defineProperty(wide, `field${i}`, { enumerable: true, get: () => { reads++; return i; } });
  }
  const result = archiveResult("bounded getters", { wide });
  assert.ok(reads <= 100, `projection read ${reads} getters`);
  assert.equal(Object.keys(result.structuredContent?.wide as object).length, 100);
  assert.equal(Object.hasOwn(result.structuredContent?.wide as object, "inherited"), false);
  assert.equal(result.structuredContent?.truncated, true);
});

test("global work exhaustion stops reading later object and array children", () => {
  for (const array of [false, true]) {
    let reads = 0;
    const branches = Array.from({ length: 100 }, () => {
      const branch: Record<string, unknown> | unknown[] = array ? [] : {};
      for (let i = 0; i < 100; i++) {
        Object.defineProperty(branch, String(i), { enumerable: true, get: () => { reads++; return "value"; } });
      }
      return branch;
    });
    const result = archiveResult("global work stop", { branches });
    assert.ok(reads < 5000, `${array ? "array" : "object"} projection read ${reads} getters`);
    assert.equal(result.structuredContent?.truncated, true);
  }
});

test("typed root provenance survives payload exhaustion regardless of property order", () => {
  const provenance = { totalKind: "estimated", estimatedTotal: 500, totalRows: 500, indexBacked: true,
    timestampBasis: "sentAt", dateBoundary: "UTC", page: 1, limit: 50 };
  const hits = Array.from({ length: 50 }, () => ({ metadata:
    Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, "value"])),
  }));
  const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`payload${i}`, i]));
  for (const payload of [{ hits }, wide]) {
    for (const data of [{ ...payload, ...provenance }, { ...provenance, ...payload }]) {
      const result = archiveResult("protected provenance", data);
      for (const [key, value] of Object.entries(provenance)) {
        assert.equal(result.structuredContent?.[key], value, `${key} was lost`);
      }
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64_000);
    }
  }
});

test("protected provenance accepts only known typed values", () => {
  const invalid: Record<string, unknown[]> = {
    totalKind: ["trusted", true, 42, null, {}],
    totalRows: ["500", false, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, Number.POSITIVE_INFINITY],
    estimatedTotal: ["500", false, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, []],
    indexBacked: ["true", 1, null, {}],
    timestampBasis: ["receivedAt", 1, null, {}],
    dateBoundary: ["local", false, null, []],
    page: ["1", -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null],
    limit: [true, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null],
  };
  for (const [key, values] of Object.entries(invalid)) {
    for (const value of values) {
      const result = archiveResult("invalid provenance", { [key]: value });
      assert.equal(Object.hasOwn(result.structuredContent!, key), false, `${key} accepted ${String(value)}`);
      assert.equal(result.structuredContent?.truncated, true);
    }
  }
  for (const totalKind of ["unknown", "estimated", "exact_source_rows", "exact_report_items"]) {
    assert.equal(archiveResult("valid provenance", { totalKind }).structuredContent?.totalKind, totalKind);
  }
  const unknownCounts = archiveResult("unknown totals", { totalRows: null, estimatedTotal: null });
  assert.equal(unknownCounts.structuredContent?.totalRows, null);
  assert.equal(unknownCounts.structuredContent?.estimatedTotal, null);
  assert.equal(unknownCounts.structuredContent?.truncated, false);
});

test("overlong keys cannot silently merge distinct archive fields", () => {
  const prefix = "a".repeat(128);
  const input = { [prefix]: "keep exact key", [`${prefix}one`]: "first", [`${prefix}two`]: "second" };
  const result = archiveResult("long keys", { nested: input });
  assert.deepEqual(result.structuredContent?.nested, { [prefix]: "keep exact key" });
  assert.equal(result.structuredContent?.truncated, true);
  assert.deepEqual(input, { [prefix]: "keep exact key", [`${prefix}one`]: "first", [`${prefix}two`]: "second" });
});

test("readable email summaries retain bodies longer than 4096 characters within a serialized budget", () => {
  const body = "a".repeat(12_000);
  const result = archiveResult(`Subject: fixture\n\n${body}`, { emailId: "fixture", totalKind: "unknown" });
  const text = result.content.map(c => c.type === "text" ? c.text : "").join("\n");
  assert.ok(text.includes(body), `readable summary retained only ${text.length} characters`);
  assert.equal(result.structuredContent?.truncated, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64_000);
  for (const summary of ["a".repeat(100_000), "😀".repeat(50_000), "\u0000".repeat(100_000)]) {
    const bounded = archiveResult(summary, { totalKind: "estimated", estimatedTotal: 500,
      hits: Array.from({ length: 100 }, () => ({ body: "😀".repeat(5000) })) });
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 64_000);
    assert.equal(bounded.structuredContent?.estimatedTotal, 500);
    assert.equal(bounded.structuredContent?.truncated, true);
    assert.match(bounded.content.map(c => c.type === "text" ? c.text : "").join("\n"), /TRUNCATED/);
  }
});

test("readable summaries remove an identical leading notice without removing archive body text", () => {
  const body = `Subject: fixture\n\n${ARCHIVE_TRUST}`;
  for (const prefix of [ARCHIVE_TRUST, `${ARCHIVE_TRUST}\n\n`, `${ARCHIVE_TRUST}\n\n${ARCHIVE_TRUST}\n\n`]) {
    const result = archiveResult(`${prefix}${body}`, {});
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[0].type === "text" && result.content[0].text, `${ARCHIVE_TRUST}\n\n${body}`);
    assert.equal(result.structuredContent?.truncated, false);
  }
});

test("returned item counts describe final emitted arrays after projection and byte shrinking", () => {
  for (const count of [20, 150]) {
    const items = Array.from({ length: count }, (_, i) => ({ id: String(i), body: "\u0000".repeat(4096) }));
    const integrity = archiveResult("integrity", { totalKind: "exact_report_items", totalItems: count,
      returnedItems: count, items });
    const emitted = integrity.structuredContent?.items as unknown[];
    assert.ok(emitted.length < count);
    assert.equal(integrity.structuredContent?.returnedItems, emitted.length);
    assert.equal(integrity.structuredContent?.totalItems, count);
    const thread = archiveResult("thread", { pagination: { returnedItems: count, limit: count }, messages: items });
    assert.equal((thread.structuredContent?.pagination as Record<string, unknown>).returnedItems,
      (thread.structuredContent?.messages as unknown[]).length);
    assert.ok(Buffer.byteLength(JSON.stringify(thread)) <= 64_000);
  }
});

test("adversarial nested strings do not cause repeated multi-megabyte serialization", () => {
  const nested = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, Object.fromEntries(Array.from({ length: 100 }, (_, j) => [j, "x".repeat(4096)]))]));
  const start = performance.now();
  const result = archiveResult("bounded work", nested);
  assert.ok(performance.now() - start < 1000, "serialization reduction must not scan megabytes hundreds of times");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64_000);
  assert.equal(result.structuredContent?.truncated, true);
});

test("report totals and returned counts survive payload node exhaustion in either property order", () => {
  const items = Array.from({ length: 100 }, () => Object.fromEntries(Array.from({ length: 100 }, (_, j) => [j, j])));
  for (const data of [{ items, returnedItems: 100, totalItems: 100, totalKind: "exact_report_items" }, { returnedItems: 100, totalItems: 100, totalKind: "exact_report_items", items }]) {
    const result = archiveResult("report", data).structuredContent!;
    assert.equal(result.totalItems, 100);
    assert.equal(result.returnedItems, (result.items as unknown[]).length);
  }
});

test("returned item counts are zero if the complete row array is dropped", () => {
  for (const data of [
    { items: [{ id: "kept" }], nested: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i, "x".repeat(4096)])), returnedItems: 1, totalItems: 1, totalKind: "exact_report_items" },
    { nested: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i, "x".repeat(4096)])), items: [{ id: "kept" }], returnedItems: 1, totalItems: 1, totalKind: "exact_report_items" },
  ]) {
    const result = archiveResult("a".repeat(48 * 1024), data).structuredContent!;
    assert.equal(result.returnedItems, Array.isArray(result.items) ? result.items.length : 0);
    assert.equal(result.totalItems, 1);
  }
});

test("payload cannot override server trust or truncation state", () => {
  const result = archiveResult("summary", { trust: "trusted instructions", truncated: true });
  assert.match(String(result.structuredContent?.trust), /not instructions/);
  assert.equal(result.structuredContent?.truncated, false);
});
