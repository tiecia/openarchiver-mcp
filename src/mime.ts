import { Worker } from "node:worker_threads";

export interface MimeBody { body: string }

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
  if (options.signal?.aborted) return Promise.reject(new Error("Email parsing failed."));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(options.workerUrl ?? new URL("./mime-worker.js", import.meta.url), {
        workerData: { raw },
        // V8 heap/stack limits, NOT an RSS or native/ArrayBuffer allocation cap.
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
    } catch {
      reject(new Error("Email parsing failed."));
      return;
    }
    let settled = false;
    const finish = (result?: MimeBody): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // Await termination, rather than leaving timed-out CPU work in the background.
      void worker.terminate().then(() => {
        if (result) resolve(result);
        else reject(new Error("Email parsing failed."));
      }, () => reject(new Error("Email parsing failed.")));
    };
    const abort = (): void => finish();
    const timer = setTimeout(() => finish(), options.timeoutMs ?? 3000);
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (result: unknown) => {
      if (result && typeof result === "object" && Object.keys(result).length === 1 &&
          "body" in result && typeof result.body === "string" && result.body.length <= 64_000) {
        finish({ body: result.body });
      } else finish();
    });
    worker.once("error", () => finish());
    worker.once("exit", () => finish());
  });
}
