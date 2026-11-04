import assert from "node:assert/strict";
import { it } from "node:test";
import { searchQuery, searchSchema } from "./query.js";

const source = "12345678-1234-1234-1234-123456789abc";
it("rejects empty, malformed, unknown and over-budget search criteria", () => {
  const invalid: unknown[] = [
    {}, { keywords: "   " }, { sort: "date_desc" }, { searchIn: ["body"] }, { filters: {} }, { filters: { from: [] } },
    { keywords: "x", surprise: true }, { keywords: "x", filters: { surprise: true } },
    { keywords: "x".repeat(2001) }, { keywords: "x\u0000y" }, { keywords: "\ud800" },
    { keywords: "x", limit: 101 }, { keywords: "x", page: Number.MAX_SAFE_INTEGER + 1 },
    { filters: { sources: ["not-a-uuid"] } }, { filters: { sources: [` ${source}`] } },
    { filters: { from: Array(21).fill("a@example.com") } },
    ...["a@example.com,b@example.com", "a\n@example.com", "a*b@example.com", "*@*", "@example.com", "abc", "a@@example.com", "x".repeat(321)].map(value => ({ filters: { from: [value] } })),
    ...["2023-02-29", "2024-02-30", "2024-13-01", "2024-04-31", "2024-1-01"].map(value => ({ filters: { dateFrom: value } })),
    { filters: { dateFrom: "2024-03-01", dateTo: "2024-02-29" } },
    { filters: { hasAttachments: "false" } }, { keywords: "x", searchIn: ["raw"] }, { keywords: "x", detail: "raw" },
  ];
  for (const input of invalid) assert.equal(searchSchema.safeParse(input).success, false, JSON.stringify(input));
  assert.equal(searchSchema.safeParse({ filters: { hasAttachments: false } }).success, true);
  assert.equal(searchSchema.safeParse({ filters: { dateFrom: "2024-02-29", dateTo: "2024-02-29" } }).success, true);
});
it("serializes all advanced filters and search controls without query injection", () => {
  const query = new URLSearchParams(searchQuery({
    keywords: 'invoice &sort=date_asc "special"', page: 3, limit: 100, matchingStrategy: "frequency",
    filters: { sources: [source], excludeSources: [source], from: [" Alice@EXAMPLE.com "], notFrom: ["*@blocked.example"], to: ["team@*"], notTo: ["no@example.com"], mailboxes: ["one@example.com", "TWO@example.com"], dateFrom: "2024-02-29", dateTo: "2024-03-01", hasAttachments: false },
    searchIn: ["subject", "body", "attachment_name", "attachment_content", "from", "to"], sort: "date_desc", detail: "matches",
  }));
  assert.deepEqual(Object.fromEntries(query), {
    keywords: 'invoice &sort=date_asc "special"', page: "3", limit: "100", matchingStrategy: "frequency",
    sources: source, excludeSources: source, from: "alice@example.com", notFrom: "*@blocked.example", to: "team@*", notTo: "no@example.com", mailboxes: "one@example.com,two@example.com", dateFrom: "2024-02-29", dateTo: "2024-03-01", hasAttachments: "false",
    searchIn: "subject,body,attachment_name,attachment_content,from,to", sort: "date_desc",
  });
});
