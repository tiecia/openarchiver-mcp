import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTimestamp } from "./timestamps.js";

test("strict timestamp helper rejects malformed, ambiguous and impossible instants", () => {
  for (const value of [
    null, undefined, 0, {}, "", "2026-01-01", "2026-01-01T12:00:00", "2026-02-30T12:00:00Z",
    "1900-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00+24:00", "2026-01-01T00:00:00+00:60", "2026-01-01T00:00:00-00:00",
    "2026-01-01T00:00:00Z\n", "2026-01-01T00:00:00.1234567890Z", "x".repeat(1000),
  ]) assert.equal(normalizeTimestamp(value), undefined, JSON.stringify(value));
});

test("strict timestamp helper normalizes real instants after validating local calendar and offset", () => {
  for (const [value, expected] of [
    ["2000-02-29T00:00:00Z", "2000-02-29T00:00:00.000Z"],
    ["0000-02-29T00:00:00Z", "0000-02-29T00:00:00.000Z"],
    ["2024-02-29T23:59:59.999+05:30", "2024-02-29T18:29:59.999Z"],
    ["2026-01-01T00:00:00-04:00", "2026-01-01T04:00:00.000Z"],
    ["2026-01-01t00:00:00z", "2026-01-01T00:00:00.000Z"],
  ]) assert.equal(normalizeTimestamp(value), expected, value);
});
