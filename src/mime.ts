import { Worker } from "node:worker_threads";

export interface MimeBody { body: string }
export interface MimeHeaders { headers: { name: string; value: string }[]; truncated: boolean }

/** Trusted caller options; test overrides are never archive/environment/MCP configuration. */
export interface MimeParseOptions {
  /** Internal test fixture only. Production always uses the packaged relative worker. */
  workerUrl?: URL;
  /** Internal deadline-test override only; production uses a fixed three seconds. */
  timeoutMs?: number;
  /** Runtime shutdown signal. */
  signal?: AbortSignal;
}

/** Parse untrusted MIME away from the protocol/event-loop thread. */
export function parseMime(raw: Uint8Array, options: MimeParseOptions = {}): Promise<MimeBody> {
  return runWorker(raw, "body", options, (result) => {
    if (result && typeof result === "object" && Object.keys(result).length === 1 &&
        "body" in result && typeof result.body === "string" && result.body.length <= 64_000) {
      return { body: result.body };
    }
    return undefined;
  });
}

/** Ordered literal original headers, not interpreted recipient or delivery metadata. */
export function parseHeaders(raw: Uint8Array, options: MimeParseOptions = {}): Promise<MimeHeaders> {
  return runWorker(raw, "headers", options, (result) => {
    if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 2 ||
        !("headers" in result) || !Array.isArray(result.headers) || result.headers.length > 200 ||
        !("truncated" in result) || typeof result.truncated !== "boolean") return undefined;
    let bytes = 0;
    const headers: MimeHeaders["headers"] = [];
    for (const header of result.headers) {
      if (!header || typeof header !== "object" || Array.isArray(header) || Object.keys(header).length !== 2 ||
          !("name" in header) || typeof header.name !== "string" || header.name.length < 1 || header.name.length > 128 ||
          !("value" in header) || typeof header.value !== "string" || header.value.length > 4096 ||
          /[^\x21-\x39\x3b-\x7e]/u.test(header.name) || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(header.value)) return undefined;
      const valueBytes = Buffer.byteLength(header.value);
      if (valueBytes > 4096) return undefined;
      bytes += Buffer.byteLength(header.name) + valueBytes;
      if (bytes > 32 * 1024) return undefined;
      headers.push({ name: header.name, value: header.value });
    }
    return { headers, truncated: result.truncated };
  });
}

function runWorker<T>(raw: Uint8Array, mode: "body" | "headers", options: MimeParseOptions,
  validate: (result: unknown) => T | undefined): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(new Error("Email parsing failed."));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(options.workerUrl ?? new URL("./mime-worker.js", import.meta.url), {
        workerData: { raw, mode },
        // V8 heap/stack limits, NOT an RSS or native/ArrayBuffer allocation cap.
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
    } catch {
      reject(new Error("Email parsing failed."));
      return;
    }
    let settled = false;
    const finish = (result?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // Await termination, rather than leaving timed-out CPU work in the background.
      void worker.terminate().then(() => {
        if (result !== undefined) resolve(result);
        else reject(new Error("Email parsing failed."));
      }, () => reject(new Error("Email parsing failed.")));
    };
    const abort = (): void => finish();
    const timer = setTimeout(() => finish(), options.timeoutMs ?? 3000);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (result: unknown) => {
      try { finish(validate(result)); } catch { finish(); }
    });
    worker.once("error", () => finish());
    worker.once("exit", () => finish());
  });
}
