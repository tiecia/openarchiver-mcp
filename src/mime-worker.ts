import { parentPort, workerData } from "node:worker_threads";
import { simpleParser } from "mailparser";
import { stripHtml } from "./format.js";

if (workerData.mode === "headers") {
  const raw = Buffer.from(workerData.raw);
  const headers: { name: string; value: string }[] = [];
  // Reject invalid bytes rather than invent U+FFFD in an original/literal header.
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const limit = Math.min(raw.length, 32 * 1024);
  let position = 0;
  let outputBytes = 0;
  let truncated = false;
  let current: { name: string; parts: string[]; bytes: number } | undefined;
  // Trim RFC horizontal whitespace only, without interpreting or decoding values.
  const trimWhitespace = (value: string): string => {
    let start = 0;
    let end = value.length;
    while (start < end && (value[start] === " " || value[start] === "\t")) start++;
    while (end > start && (value[end - 1] === " " || value[end - 1] === "\t")) end--;
    return value.slice(start, end);
  };
  const commit = (): void => {
    if (current) headers.push({ name: current.name, value: current.parts.join(" ") });
    current = undefined;
  };
  while (position < raw.length) {
    const start = position;
    while (position < limit && raw[position] !== 10) {
      if (position - start >= 8192) throw new Error("Invalid header");
      position++;
    }
    if (position === limit && position < raw.length) { truncated = true; break; }
    let end = position;
    if (end > start && raw[end - 1] === 13) end--;
    if (position < raw.length) position++;
    if (end === start) break;
    const line = utf8.decode(raw.subarray(start, end));
    // Only printable header data and horizontal whitespace. CR/LF are framing, not values.
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/u.test(line)) throw new Error("Invalid header");
    if (line[0] === " " || line[0] === "\t") {
      if (!current) throw new Error("Invalid header");
      const part = trimWhitespace(line);
      const bytes = Buffer.byteLength(part) + 1;
      if (current.bytes + bytes > 4096) throw new Error("Invalid header");
      if (outputBytes + bytes > 32 * 1024) { truncated = true; break; }
      current.parts.push(part);
      current.bytes += bytes;
      outputBytes += bytes;
    } else {
      commit();
      if (headers.length === 200) { truncated = true; break; }
      const colon = line.indexOf(":");
      if (colon <= 0 || colon > 128) throw new Error("Invalid header");
      const name = line.slice(0, colon);
      for (let i = 0; i < name.length; i++) {
        const code = name.charCodeAt(i);
        if (code < 33 || code > 126) throw new Error("Invalid header");
      }
      const value = trimWhitespace(line.slice(colon + 1));
      const bytes = Buffer.byteLength(value);
      if (bytes > 4096) throw new Error("Invalid header");
      if (outputBytes + name.length + bytes > 32 * 1024) { truncated = true; break; }
      current = { name, parts: [value], bytes };
      outputBytes += name.length + bytes;
    }
  }
  commit();
  parentPort!.postMessage({ headers, truncated });
} else {
  const parsed = await simpleParser(Buffer.from(workerData.raw), {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
  const body = parsed.text || (parsed.html ? stripHtml(parsed.html) : "");
  const marker = "\n[TRUNCATED: email body exceeded the 64000-character output budget.]";
  // The body worker boundary carries only bounded text, never headers or attachments.
  parentPort!.postMessage({ body: body.length > 64_000 ? body.slice(0, 64_000 - marker.length) + marker : body });
}
