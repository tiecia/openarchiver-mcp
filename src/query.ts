import { z } from "zod";

const unsafeText = /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u;
const queryText = z.string().max(2000).refine(value => !unsafeText.test(value), "Invalid query text.");
export const sourceIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const addresses = z.array(z.string().max(320).refine(value => !unsafeText.test(value) && !value.includes(","), "Invalid address pattern.")
  .transform(value => value.trim().toLowerCase()).refine(value => {
    const parts = value.split("@");
    if (parts.length !== 2) return false;
    const [local, domain] = parts;
    const localOk = /^[a-z0-9.!#$%&'+/=?^_`{|}~-]+$/i.test(local);
    const domainOk = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(domain);
    return (localOk && domainOk) || (local === "*" && domainOk) || (localOk && domain === "*");
  }, "Unsupported address pattern.")).min(1).max(20);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, "Expected a real UTC calendar day.");

export const searchSchema = z.object({
  keywords: queryText.optional(),
  page: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  matchingStrategy: z.enum(["last", "all", "frequency"]).optional(),
  filters: z.object({
    sources: z.array(sourceIdSchema).min(1).max(20).optional(),
    excludeSources: z.array(sourceIdSchema).min(1).max(20).optional(),
    from: addresses.optional(), notFrom: addresses.optional(),
    to: addresses.optional(), notTo: addresses.optional(), mailboxes: addresses.optional(),
    dateFrom: day.optional(), dateTo: day.optional(), hasAttachments: z.boolean().optional(),
  }).strict().optional(),
  searchIn: z.array(z.enum(["subject", "body", "attachment_name", "attachment_content", "from", "to"])).min(1).max(20).optional(),
  sort: z.enum(["relevance", "date_desc", "date_asc"]).optional(),
  detail: z.enum(["summary", "indexed_text", "matches"]).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.keywords?.trim() && !Object.values(value.filters ?? {}).some(item => item !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Supply keywords or an actual filter." });
  }
  if (value.filters?.dateFrom && value.filters.dateTo && value.filters.dateFrom > value.filters.dateTo) {
    ctx.addIssue({ code: "custom", message: "dateFrom must not be after dateTo.", path: ["filters", "dateTo"] });
  }
});

export const listArchiveSchema = z.object({
  ingestionSourceId: sourceIdSchema, page: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).optional(), detail: z.literal("summary").optional(),
}).strict();

export const suggestSchema = z.object({
  field: z.enum(["mailboxes", "from"]), query: queryText.optional(),
}).strict();

export function searchQuery(input: unknown): string {
  const params = searchSchema.parse(input);
  const query = new URLSearchParams({ keywords: params.keywords ?? "" });
  for (const [name, value] of Object.entries(params)) {
    if (name !== "keywords" && name !== "filters" && name !== "detail" && value !== undefined) query.set(name, Array.isArray(value) ? value.join(",") : String(value));
  }
  for (const [name, value] of Object.entries(params.filters ?? {})) {
    if (value !== undefined) query.set(name, Array.isArray(value) ? value.join(",") : String(value));
  }
  return query.toString();
}
