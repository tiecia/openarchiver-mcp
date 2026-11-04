import { normalizeApiBase } from "./config.js";

export type FetchLike = typeof fetch;

export type MatchingStrategy = "last" | "all" | "frequency";

export interface SearchParams {
  keywords: string;
  page?: number;
  limit?: number;
  matchingStrategy?: MatchingStrategy;
}

export interface SearchAttachment {
  filename?: string;
  content?: string;
}

export interface SearchHit {
  id: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  attachments?: SearchAttachment[];
  timestamp?: number;
}

export interface SearchResponse {
  hits: SearchHit[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  processingTimeMs: number;
}

export interface EmailAttachment {
  id?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  storagePath?: string;
}

export interface EmailDetail {
  id: string;
  subject?: string;
  senderName?: string;
  senderEmail?: string;
  recipients?: { name?: string; email?: string }[];
  sentAt?: string;
  messageIdHeader?: string;
  path?: string;
  tags?: string[] | null;
  sizeBytes?: number;
  hasAttachments?: boolean;
  storagePath?: string;
  attachments?: EmailAttachment[];
  /** Raw RFC822 message, serialized as a Node Buffer (`{ type: "Buffer", data: number[] }`). */
  raw?: { type: "Buffer"; data: number[] } | null;
}

/** One line of a `/integrity/{id}` verification report: the email itself or one attachment. */
export interface IntegrityCheckResult {
  type: "email" | "attachment";
  id: string;
  filename?: string;
  isValid: boolean;
  /** Why the item failed; absent when `isValid` is true. */
  reason?: string;
  /** SHA-256 recorded at archival time. */
  storedHash: string;
  /** SHA-256 computed during this verification (empty when the file could not be read). */
  computedHash: string;
}

export interface DownloadResult {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

export class OpenArchiverError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OpenArchiverError";
  }
}

/** Extract `filename` from a Content-Disposition header value. */
export function parseContentDispositionFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const star = value.match(/filename\*=(?:UTF-8'')?"?([^";]+)"?/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = value.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : undefined;
}

const DEFAULT_NOT_FOUND = "Not found (404). The email id or storage path does not exist.";

function mapStatusToMessage(status: number, notFound = DEFAULT_NOT_FOUND): string {
  if (status === 401 || status === 403) {
    return `Authentication failed (${status}). Check OPENARCHIVER_API_KEY and that it has the required permissions (search:archive, read:archive).`;
  }
  if (status === 404) {
    return notFound;
  }
  return `OpenArchiver request failed (${status}).`;
}

const JSON_MAX_BYTES = 32 * 1024 * 1024;
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

async function readBounded(res: Response, maxBytes: number): Promise<Buffer> {
  const length = res.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) {
    await res.body?.cancel().catch(() => {});
    throw new OpenArchiverError("Invalid or excessive Content-Length from OpenArchiver.");
  }
  const reader = res.body?.getReader();
  if (!reader) {
    if (length !== null && Number(length) !== 0) {
      throw new OpenArchiverError("Content-Length does not match the OpenArchiver response body.");
    }
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // Fetch decodes compressed bodies; wire Content-Length is not the decoded size.
  const encoding = res.headers.get("content-encoding");
  const expectedLength = length !== null && (!encoding || encoding.toLowerCase() === "identity") ? Number(length) : undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(() => {
        throw new OpenArchiverError("Failed to read OpenArchiver response body.");
      });
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new OpenArchiverError(`Response exceeds the ${maxBytes} byte limit.`);
      if (expectedLength !== undefined && size > expectedLength) {
        throw new OpenArchiverError("Content-Length does not match the OpenArchiver response body.");
      }
      chunks.push(Buffer.from(value));
    }
    if (expectedLength !== undefined && size !== expectedLength) {
      throw new OpenArchiverError("Content-Length does not match the OpenArchiver response body.");
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readJson(res: Response): Promise<unknown> {
  const bytes = await readBounded(res, JSON_MAX_BYTES);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new OpenArchiverError("Invalid JSON response from OpenArchiver.");
  }
}

function encodeEmailId(id: string): string {
  if (!id || /[%\\\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(id) || id.split("/").some(part => part === "." || part === "..")) {
    throw new OpenArchiverError("Invalid email id.");
  }
  return encodeURIComponent(id);
}

/** Thin client over the OpenArchiver REST API. `fetch` is injectable for testing. */
export class OpenArchiverClient {
  constructor(
    private readonly apiBase: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
    options: { allowHttpLoopback?: boolean } = {},
  ) {
    this.apiBase = normalizeApiBase(apiBase, options.allowHttpLoopback === true);
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const query = new URLSearchParams();
    query.set("keywords", params.keywords);
    if (params.page != null) query.set("page", String(params.page));
    if (params.limit != null) query.set("limit", String(params.limit));
    if (params.matchingStrategy) query.set("matchingStrategy", params.matchingStrategy);
    const res = await this.request(`/search?${query.toString()}`);
    return (await readJson(res)) as SearchResponse;
  }

  async getEmail(id: string): Promise<EmailDetail> {
    const res = await this.request(
      `/archived-emails/${encodeEmailId(id)}`,
      "Not found (404). No archived email with this id.",
    );
    return (await readJson(res)) as EmailDetail;
  }

  async checkIntegrity(id: string): Promise<IntegrityCheckResult[]> {
    const res = await this.request(
      `/integrity/${encodeEmailId(id)}`,
      "Not found (404). No archived email with this id.",
    );
    const data = await readJson(res);
    // The endpoint returns a bare array; anything else means the API changed under us,
    // and a clear error beats a downstream "results.filter is not a function".
    if (!Array.isArray(data)) {
      throw new OpenArchiverError(
        "Unexpected response from the OpenArchiver integrity endpoint (expected a list of results).",
      );
    }
    return data as IntegrityCheckResult[];
  }

  async download(path: string, maxBytes = ATTACHMENT_MAX_BYTES): Promise<DownloadResult> {
    if (!path || /[%\\?#\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
      throw new OpenArchiverError("Invalid storage path.");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > ATTACHMENT_MAX_BYTES) {
      throw new OpenArchiverError(`maxBytes must be a safe positive integer no greater than ${ATTACHMENT_MAX_BYTES}.`);
    }
    // Since OpenArchiver 0.6.0 the download endpoint ties the path back to an archived email
    // the key's role actually covers, and answers 404 (not 403) when it does not -- deliberately,
    // so a path cannot be probed. Without this hint a scoped key looks like a wrong path.
    const res = await this.request(
      `/storage/download?path=${encodeURIComponent(path)}`,
      "Not found (404). The storage path does not exist, or this API key's role does not cover the " +
        "email it belongs to (OpenArchiver 0.6.0+ checks the individual record and answers 404 " +
        "rather than 403). Re-check the storagePath from get_email, and the key's permissions.",
    );
    const bytes = await readBounded(res, maxBytes);
    const filename =
      parseContentDispositionFilename(res.headers.get("content-disposition")) ??
      path.split("/").pop() ??
      "download";
    return {
      bytes,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      filename,
    };
  }

  private async request(pathAndQuery: string, notFound?: string): Promise<Response> {
    const url = `${this.apiBase}${pathAndQuery}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        redirect: "error",
        headers: { "X-API-KEY": this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new OpenArchiverError("Request to OpenArchiver failed. Check connectivity and request timeout.");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new OpenArchiverError(
        mapStatusToMessage(res.status, notFound),
        res.status,
      );
    }
    return res;
  }
}
