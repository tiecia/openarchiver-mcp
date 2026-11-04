import { normalizeApiBase } from "./config.js";
import { searchQuery, listArchiveSchema, suggestSchema } from "./query.js";
import { z } from "zod";

export type FetchLike = typeof fetch;

export type MatchingStrategy = "last" | "all" | "frequency";

export interface SearchParams {
  keywords?: string;
  page?: number;
  limit?: number;
  matchingStrategy?: MatchingStrategy;
  filters?: {
    sources?: string[]; excludeSources?: string[];
    from?: string[]; notFrom?: string[]; to?: string[]; notTo?: string[]; mailboxes?: string[];
    dateFrom?: string; dateTo?: string; hasAttachments?: boolean;
  };
  searchIn?: ("subject" | "body" | "attachment_name" | "attachment_content" | "from" | "to")[];
  sort?: "relevance" | "date_desc" | "date_asc";
  detail?: "summary" | "indexed_text" | "matches";
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
  userEmail?: string;
  ingestionSourceId?: string;
  _formatted?: unknown;
  _matchesPosition?: unknown;
  invalidFields?: string[];
}

export interface SearchResponse {
  hits: SearchHit[];
  total?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
  processingTimeMs?: number;
}

const optionalText = z.string().optional().catch(undefined);
const optionalTexts = z.array(z.string()).optional().catch(undefined);
const hitSchema = z.object({
  id: z.string().min(1), from: optionalText, to: optionalTexts, cc: optionalTexts, bcc: optionalTexts,
  subject: optionalText, body: optionalText, userEmail: optionalText, ingestionSourceId: optionalText,
  timestamp: z.number().finite().optional().catch(undefined),
  attachments: z.array(z.object({ filename: optionalText, content: optionalText })).optional().catch(undefined),
  _formatted: z.unknown().optional(), _matchesPosition: z.unknown().optional(),
});
const countSchema = z.number().int().nonnegative();
const validatedHitSchema = z.unknown().transform((value, ctx) => {
  const parsed = hitSchema.safeParse(value);
  if (!parsed.success) { ctx.addIssue({ code: "custom", message: "Invalid search hit." }); return z.NEVER; }
  const raw = value as Record<string, unknown>;
  const invalidFields = Object.keys(hitSchema.shape).filter(key => raw[key] !== undefined && parsed.data[key as keyof typeof parsed.data] === undefined);
  for (const [index, attachment] of (parsed.data.attachments ?? []).entries()) {
    if (invalidFields.length >= 100) break;
    const original = (raw.attachments as Record<string, unknown>[])[index];
    for (const key of ["filename", "content"] as const) if (invalidFields.length < 100 && original[key] !== undefined && attachment[key] === undefined) invalidFields.push(`attachments[${index}].${key}`);
  }
  return { ...parsed.data, invalidFields };
});
const searchResponseSchema = z.object({
  hits: z.array(validatedHitSchema), total: countSchema.optional().catch(undefined),
  page: z.number().int().positive().optional().catch(undefined), limit: z.number().int().min(1).max(100).optional().catch(undefined),
  totalPages: countSchema.optional().catch(undefined), processingTimeMs: z.number().nonnegative().finite().optional().catch(undefined),
});

export interface EmailAttachment {
  id?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  storagePath?: string;
}

export interface ListArchiveParams { ingestionSourceId: string; page?: number; limit?: number; detail?: "summary" }
export interface SuggestParams { field: "mailboxes" | "from"; query?: string }
export interface SuggestResponse { values: string[] }
export interface ListArchiveResponse { items: EmailDetail[]; total?: number; page: number; limit: number }
const archiveRowSchema = z.object({
  id: z.string().min(1), subject: optionalText, senderName: optionalText, senderEmail: optionalText,
  recipients: z.array(z.object({ name: optionalText, email: optionalText })).optional().catch(undefined),
  sentAt: optionalText, ingestionSourceId: optionalText, userEmail: optionalText,
  ingestionSource: z.object({ id: optionalText, name: optionalText }).optional().catch(undefined),
  hasAttachments: z.boolean().optional().catch(undefined), sizeBytes: countSchema.optional().catch(undefined),
});
const listResponseSchema = z.object({
  items: z.array(z.unknown().transform((value, ctx) => {
    const parsed = archiveRowSchema.safeParse(value);
    if (!parsed.success) { ctx.addIssue({ code: "custom", message: "Invalid archive row." }); return z.NEVER; }
    const raw = value as Record<string, unknown>;
    const invalidFields = Object.keys(archiveRowSchema.shape).filter(key => raw[key] !== undefined && parsed.data[key as keyof typeof parsed.data] === undefined);
    if (parsed.data.ingestionSource) {
      const original = raw.ingestionSource as Record<string, unknown>;
      for (const key of ["id", "name"] as const) if (original[key] !== undefined && parsed.data.ingestionSource[key] === undefined) invalidFields.push(`ingestionSource.${key}`);
    }
    for (const [index, recipient] of (parsed.data.recipients ?? []).entries()) {
      if (invalidFields.length >= 100) break;
      const original = (raw.recipients as Record<string, unknown>[])[index];
      for (const key of ["name", "email"] as const) if (invalidFields.length < 100 && original[key] !== undefined && recipient[key] === undefined) invalidFields.push(`recipients[${index}].${key}`);
    }
    return { ...parsed.data, invalidFields };
  })), total: countSchema.optional().catch(undefined),
  page: z.number().int().positive().catch(1), limit: z.number().int().min(1).max(100).catch(10),
});

export interface EmailDetail {
  id: string;
  invalidFields?: string[];
  ingestionSourceId?: string;
  ingestionSource?: { id?: string; name?: string } | null;
  userEmail?: string;
  archivedAt?: string;
  providerMessageId?: string;
  threadId?: string;
  isIndexed?: boolean;
  indexAttempts?: number;
  isOnLegalHold?: boolean;
  isJournaled?: boolean;
  storageHashSha256?: string;
  /** Untrusted candidates, not a per-record authorization result. */
  thread?: unknown;
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
  /** Untrusted serialized RFC822 Buffer; validate with validateRawEmail before use. */
  raw?: unknown;
}

const optionalBoolean = z.boolean().optional().catch(undefined);
const detailFieldsSchema = archiveRowSchema.extend({
  // Malformed collections must not become apparently empty collections.
  recipients: z.array(z.object({ name: z.string().optional(), email: z.string().optional() })).optional(),
  archivedAt: optionalText, providerMessageId: optionalText, threadId: optionalText,
  isIndexed: optionalBoolean, indexAttempts: countSchema.optional().catch(undefined),
  isOnLegalHold: optionalBoolean, isJournaled: optionalBoolean, storageHashSha256: optionalText,
  messageIdHeader: optionalText, path: optionalText, storagePath: optionalText,
  tags: z.array(z.string()).nullable().optional().catch(undefined),
  attachments: z.array(z.object({ id: z.string().optional(), filename: z.string().optional(), mimeType: z.string().optional(),
    sizeBytes: countSchema.optional(), storagePath: z.string().optional() })).optional(),
  // Preserve malformed thread/raw values for the dedicated fail-closed validators;
  // dropping them here could turn invalid input into an apparent empty thread/body.
  thread: z.unknown().optional(), raw: z.unknown().optional(),
});
const detailResponseSchema = z.unknown().transform((value, ctx) => {
  const parsed = detailFieldsSchema.safeParse(value);
  if (!parsed.success) { ctx.addIssue({ code: "custom", message: "Invalid email detail." }); return z.NEVER; }
  const raw = value as Record<string, unknown>;
  // Fixed allowlisted paths only: never copy backend-supplied diagnostics or values.
  const invalidFields = Object.keys(detailFieldsSchema.shape).filter(key => raw[key] !== undefined && parsed.data[key as keyof typeof parsed.data] === undefined);
  if (parsed.data.ingestionSource) {
    const original = raw.ingestionSource as Record<string, unknown>;
    for (const key of ["id", "name"] as const) if (original[key] !== undefined && parsed.data.ingestionSource[key] === undefined) invalidFields.push(`ingestionSource.${key}`);
  }
  return { ...parsed.data, invalidFields: invalidFields.slice(0, 32) };
});

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

// Check collection lengths before Zod can allocate one issue per hostile element.
function boundedResultArray(value: unknown, field: string, max: number, endpoint: string): unknown[] {
  const collection = value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[field] : undefined;
  if (!Array.isArray(collection) || collection.length > max) {
    throw new OpenArchiverError(`Unexpected or excessive collection in the OpenArchiver ${endpoint} endpoint.`);
  }
  return collection;
}

function boundResponseWork(records: unknown[], endpoint: string): void {
  let remaining = 10_000;
  const reject = (): never => { throw new OpenArchiverError(`Unexpected or excessive collection in the OpenArchiver ${endpoint} endpoint.`); };
  const visit = (value: unknown, depth: number): void => {
    if (--remaining < 0 || depth > 32) reject();
    if (Array.isArray(value)) {
      if (value.length > 1000) reject();
      for (const item of value) visit(item, depth + 1);
    } else if (value !== null && typeof value === "object") {
      // Do not allocate Object.keys/entries for a hostile, arbitrarily wide object.
      for (const key in value) if (Object.hasOwn(value, key)) visit((value as Record<string, unknown>)[key], depth + 1);
    }
  };
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) reject();
    const row = record as Record<string, unknown>;
    // raw and thread have separate byte/candidate validators; never traverse raw bytes here.
    for (const key of ["to", "cc", "bcc", "attachments", "recipients", "tags", "_formatted", "_matchesPosition"]) {
      if (row[key] !== undefined) visit(row[key], 0);
    }
  }
}

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
    const res = await this.request(`/search?${searchQuery(params)}`);
    const data = await readJson(res);
    boundResponseWork(boundedResultArray(data, "hits", 100, "search"), "search");
    const parsed = searchResponseSchema.safeParse(data);
    if (!parsed.success) throw new OpenArchiverError("Unexpected response from the OpenArchiver search endpoint.");
    return parsed.data;
  }

  async getEmail(id: string): Promise<EmailDetail> {
    const res = await this.request(
      `/archived-emails/${encodeEmailId(id)}`,
      "Not found (404). No archived email with this id.",
    );
    const data = await readJson(res);
    boundResponseWork([data], "email detail");
    const parsed = detailResponseSchema.safeParse(data);
    if (!parsed.success) throw new OpenArchiverError("Unexpected response from the OpenArchiver email detail endpoint.");
    return parsed.data;
  }

  async listArchive(input: ListArchiveParams): Promise<ListArchiveResponse> {
    const params = listArchiveSchema.parse(input);
    const query = new URLSearchParams({ page: String(params.page ?? 1), limit: String(params.limit ?? 10) });
    const res = await this.request(`/archived-emails/ingestion-source/${params.ingestionSourceId}?${query}`);
    const data = await readJson(res);
    boundResponseWork(boundedResultArray(data, "items", 100, "source listing"), "source listing");
    const parsed = listResponseSchema.safeParse(data);
    if (!parsed.success) throw new OpenArchiverError("Unexpected response from the OpenArchiver source listing endpoint.");
    return parsed.data;
  }

  async suggestValues(input: SuggestParams): Promise<SuggestResponse> {
    const params = suggestSchema.parse(input);
    const query = new URLSearchParams({ field: params.field, query: params.query ?? "" });
    const res = await this.request(`/search/facets?${query}`);
    const data = await readJson(res);
    boundedResultArray(data, "values", 100, "facets");
    const parsed = z.object({ values: z.array(z.string()) }).safeParse(data);
    if (!parsed.success) throw new OpenArchiverError("Unexpected response from the OpenArchiver facets endpoint.");
    return parsed.data;
  }

  async checkIntegrity(id: string): Promise<IntegrityCheckResult[]> {
    const res = await this.request(
      `/integrity/${encodeEmailId(id)}`,
      "Not found (404). No archived email with this id.",
    );
    const data = await readJson(res);
    // The endpoint returns a bare array; anything else means the API changed under us,
    // and a clear error beats a downstream "results.filter is not a function".
    if (!Array.isArray(data) || data.length > 1000) {
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
    if (Buffer.byteLength(url, "utf8") > 8192) throw new OpenArchiverError("Request URL exceeds the fixed 8192 byte limit.");
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
