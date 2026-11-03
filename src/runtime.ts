import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { safeAttachmentFilename } from "./format.js";

/** Lazily allocated, server-owned paths; callers only supply a display filename. */
export class AttachmentFiles {
  private directory?: Promise<string>;
  private readonly paths = new Map<string, number>();
  private reservedBytes = 0;
  private reservedFiles = 0;
  private timer?: ReturnType<typeof setInterval>;
  private identity?: { dev: number; ino: number };

  private async verifyDirectory(): Promise<void> {
    if (!this.directory) return;
    const directory = await this.directory;
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 ||
        stat.dev !== this.identity?.dev || stat.ino !== this.identity?.ino) {
      throw new Error("Unsafe attachment directory");
    }
  }

  private async createDirectory(): Promise<string> {
    const parent = resolve(tmpdir());
    if (await realpath(parent) !== parent) throw new Error("Unsafe temporary parent");
    const stat = await lstat(parent);
    const uid = process.getuid?.();
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (uid !== undefined && stat.uid !== uid && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
      throw new Error("Unsafe temporary parent");
    }
    const directory = await mkdtemp(join(parent, "openarchiver-mcp-"));
    await chmod(directory, 0o700);
    const created = await lstat(directory);
    this.identity = { dev: created.dev, ino: created.ino };
    return directory;
  }

  async cleanupExpired(): Promise<void> {
    await this.verifyDirectory();
    for (const [target, size] of this.paths) {
      const stat = await lstat(target).catch(() => undefined);
      if (!stat || stat.mtimeMs <= Date.now() - 15 * 60 * 1000) {
        if (stat) await rm(target, { force: true });
        if (this.paths.delete(target)) {
          this.reservedBytes -= size;
          this.reservedFiles--;
        }
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    const directory = await this.directory?.catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  async save(bytes: Buffer, filename: string): Promise<string> {
    this.directory ??= this.createDirectory();
    const directory = await this.directory;
    await this.cleanupExpired();
    this.timer ??= setInterval(() => { void this.cleanupExpired().catch(() => {}); }, 60_000).unref();
    if (this.reservedFiles >= 100 || this.reservedBytes + bytes.length > 100 * 1024 * 1024) throw new RuntimeSafetyError("disk_full");
    this.reservedBytes += bytes.length;
    this.reservedFiles++;
    const target = join(directory, `${randomUUID()}-${safeAttachmentFilename(filename)}`);
    let created = false;
    try {
      const handle = await open(target, "wx", 0o600);
      created = true;
      try { await handle.writeFile(bytes); }
      finally { await handle.close(); }
      this.paths.set(target, bytes.length);
      return target;
    } catch (error) {
      if (created) await rm(target, { force: true });
      this.reservedBytes -= bytes.length;
      this.reservedFiles--;
      throw error;
    }
  }
}

export function validateRawEmail(raw: unknown): number[] | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "object" && "data" in raw && Array.isArray(raw.data) && raw.data.length > 5 * 1024 * 1024) {
    throw new RuntimeSafetyError("mime_too_large");
  }
  if (typeof raw !== "object" || !("type" in raw) || raw.type !== "Buffer" ||
      !("data" in raw) || !Array.isArray(raw.data)) {
    throw new RuntimeSafetyError("invalid_mime");
  }
  for (const byte of raw.data) {
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new RuntimeSafetyError("invalid_mime");
    }
  }
  return raw.data as number[];
}

export type SafetyCode = "busy" | "invalid_mime" | "mime_too_large" | "disk_full" | "closing";

/** Only fixed server-owned codes may select a model-visible error message. */
export class RuntimeSafetyError extends Error {
  constructor(public readonly code: SafetyCode) {
    super(code);
    this.name = "RuntimeSafetyError";
  }
}

/** One gate covers networking, parsing, formatting and local file writes. */
export class OperationGate {
  private active = 0;
  private closed = false;
  private readonly queue: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private readonly idleWaiters: (() => void)[] = [];

  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.queue.splice(0)) entry.reject(new RuntimeSafetyError("closing"));
    if (this.active > 0) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new RuntimeSafetyError("closing");
    if (this.active < 2) {
      this.active++;
    } else {
      if (this.queue.length >= 8) throw new RuntimeSafetyError("busy");
      await new Promise<void>((resolve, reject) => this.queue.push({ resolve, reject }));
    }
    try {
      if (this.closed) throw new RuntimeSafetyError("closing");
      return await operation();
    } finally {
      const next = this.queue.shift();
      // Transfer the active slot directly, without a scheduling window in which
      // a new request could overtake a queued request or exceed the bound.
      if (next) next.resolve();
      else this.active--;
      if (this.active === 0) for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}
