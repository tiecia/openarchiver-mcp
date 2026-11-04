import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, normalizeApiBase } from "./config.js";

describe("normalizeApiBase", () => {
  it("rejects unsafe configured URLs without echoing them", () => {
    for (const base of [
      "http://remote.example", "ftp://host", "not a url", "https://host:99999",
      "https://host:abc", "https://user:secret@host", "https://@host",
      "https://host?secret=private", "https://host#private", "https://host?", "https://host#",
      "https://host/a/../api/v1", "https://host/%2e%2e/api/v1",
      "https://host/a%2fb", "https://host/a\\\\b", "https://host/a//b",
      "https://host/%252e%252e", "https://host/secret\npath",
    ]) {
      assert.throws(() => normalizeApiBase(base), (error: Error) => {
        assert.match(error.message, /OPENARCHIVER_BASE_URL/);
        assert.doesNotMatch(error.message, /secret|private/);
        return true;
      }, base);
    }
  });
  it("appends /api/v1 to a bare host", () => {
    assert.equal(normalizeApiBase("https://host.example.com"), "https://host.example.com/api/v1");
  });

  it("strips trailing slashes before appending", () => {
    assert.equal(normalizeApiBase("https://host.example.com///"), "https://host.example.com/api/v1");
  });

  it("leaves an existing /api/v1 suffix untouched", () => {
    assert.equal(normalizeApiBase("https://host.example.com/api/v1"), "https://host.example.com/api/v1");
  });

  it("accepts other api versions", () => {
    assert.equal(normalizeApiBase("https://host.example.com/api/v2/"), "https://host.example.com/api/v2");
  });

  it("throws on an empty value", () => {
    assert.throws(() => normalizeApiBase("   "), /empty/);
  });
});

describe("loadConfig", () => {
  it("permits only explicitly opted-in canonical loopback HTTP", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const base = `http://${host}:8123`;
      assert.throws(() => loadConfig({ OPENARCHIVER_BASE_URL: base, OPENARCHIVER_API_KEY: "key" }), /HTTPS/);
      assert.throws(() => loadConfig({ OPENARCHIVER_BASE_URL: base, OPENARCHIVER_API_KEY: "key", OPENARCHIVER_ALLOW_HTTP_LOOPBACK: "TRUE" }), /HTTPS/);
      const config = loadConfig({ OPENARCHIVER_BASE_URL: base, OPENARCHIVER_API_KEY: "key", OPENARCHIVER_ALLOW_HTTP_LOOPBACK: "true" });
      assert.equal(config.apiBase, `${base}/api/v1`);
      assert.equal((config as unknown as { allowHttpLoopback: boolean }).allowHttpLoopback, true);
    }
    for (const host of ["remote.example", "127.0.0.1.evil.test", "2130706433", "0x7f000001", "127.1", "0.0.0.0"]) {
      assert.throws(() => loadConfig({ OPENARCHIVER_BASE_URL: `http://${host}`, OPENARCHIVER_API_KEY: "key", OPENARCHIVER_ALLOW_HTTP_LOOPBACK: "true" }), /HTTPS/);
    }
  });
  it("returns a config when both env vars are present", () => {
    const config = loadConfig({
      OPENARCHIVER_BASE_URL: "https://host.example.com/",
      OPENARCHIVER_API_KEY: "secret",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(config, {
      apiBase: "https://host.example.com/api/v1",
      apiKey: "secret",
      timeoutMs: 30_000,
    });
  });

  it("honours a custom timeout", () => {
    const config = loadConfig({
      OPENARCHIVER_BASE_URL: "https://host.example.com",
      OPENARCHIVER_API_KEY: "secret",
      OPENARCHIVER_TIMEOUT_MS: "5000",
    } as NodeJS.ProcessEnv);
    assert.equal(config.timeoutMs, 5000);
  });

  it("throws when the base URL is missing", () => {
    assert.throws(
      () => loadConfig({ OPENARCHIVER_API_KEY: "secret" } as NodeJS.ProcessEnv),
      /OPENARCHIVER_BASE_URL/,
    );
  });

  it("throws when the API key is missing", () => {
    assert.throws(
      () => loadConfig({ OPENARCHIVER_BASE_URL: "https://host" } as NodeJS.ProcessEnv),
      /OPENARCHIVER_API_KEY/,
    );
  });
});
