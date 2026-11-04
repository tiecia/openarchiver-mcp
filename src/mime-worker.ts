import { parentPort, workerData } from "node:worker_threads";
import { simpleParser } from "mailparser";
import { stripHtml } from "./format.js";

const parsed = await simpleParser(Buffer.from(workerData.raw), {
  skipHtmlToText: true,
  skipTextToHtml: true,
  skipImageLinks: true,
});
const body = parsed.text || (parsed.html ? stripHtml(parsed.html) : "");
const marker = "\n[TRUNCATED: email body exceeded the 64000-character output budget.]";
// The worker boundary carries only bounded body text, never headers or attachments.
parentPort!.postMessage({ body: body.length > 64_000 ? body.slice(0, 64_000 - marker.length) + marker : body });
