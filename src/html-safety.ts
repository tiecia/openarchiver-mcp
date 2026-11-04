import { convert as htmlToText } from "html-to-text";

export const MAX_HTML_DEPTH = 100;
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MAX_HTML_NODES = 10_000;

const VOID_TAGS = new Set([
  "area", "base", "basefont", "br", "col", "command", "embed", "frame", "hr",
  "img", "input", "isindex", "keygen", "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Conservative O(n) resource preflight, NOT an HTML grammar or sanitizer.
 * All searches consume disjoint spans or advance the cursor; no suffix rescans,
 * tree construction, or attacker-sized stack searches. Reject uncertain syntax.
 * Optional/mismatched end tags may be rejected even when a browser repairs them.
 */
function preflightHtml(html: string): void {
  // UTF-8 bytes are at least the UTF-16 length; don't scan an unbounded string.
  if (html.length > MAX_HTML_BYTES || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    throw new Error("HTML resource limit: input bytes");
  }
  const stack: string[] = [];
  let cursor = 0;
  let nodes = 0;
  let rawTag: string | undefined;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    // Reserve a text node for each nonempty span, including trailing/raw text.
    if ((start < 0 || start > cursor) && ++nodes > MAX_HTML_NODES) {
      throw new Error("HTML resource limit: node/tag count");
    }
    if (start < 0) break;
    if (rawTag) {
      const prefix = `</${rawTag}`;
      if (html.slice(start, start + prefix.length).toLowerCase() !== prefix
        || !/[\t\n\f\r >]/.test(html[start + prefix.length] ?? "")) {
        cursor = start + 1;
        continue;
      }
      rawTag = undefined;
    }
    // Count every markup candidate (including closing tags) conservatively.
    if (++nodes > MAX_HTML_NODES) throw new Error("HTML resource limit: node/tag count");
    if (html.startsWith("<!--", start)) {
      if (html[start + 4] === ">" || html.startsWith("->", start + 4)) {
        throw new Error("HTML structure rejected: short comment");
      }
      const end = html.indexOf("-->", start + 4);
      if (end < 0) throw new Error("HTML structure rejected: unterminated comment");
      cursor = end + 3;
      continue;
    }
    if (/^<!doctype[\t\n\f\r ]/i.test(html.slice(start, start + 10))) {
      // Declarations end at the first '>' in htmlparser2, not at a quoted '>'.
      const end = html.indexOf(">", start + 2);
      if (end < 0 || html.slice(start + 2, end).includes("<")) {
        throw new Error("HTML structure rejected: malformed doctype");
      }
      cursor = end + 1;
      continue;
    }
    let end = start + 1;
    let quote = "";
    let state: "name" | "beforeAttribute" | "attribute" | "afterAttribute" | "beforeValue" | "value" | "afterValue" | "slash" = "name";
    const closing = html[start + 1] === "/";
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) {
          quote = "";
          state = "afterValue";
        }
        continue;
      }
      if (char === ">") break;
      if (char === "<") throw new Error("HTML structure rejected: nested tag delimiter");
      // Closing-tag attributes end at the FIRST '>', even inside quotes.
      if (closing) continue;
      const space = /[\t\n\f\r ]/.test(char);
      if (state === "name") {
        if (space) state = "beforeAttribute";
        else if (char === "/") state = "slash";
      } else if (state === "slash") {
        if (!space) throw new Error("HTML structure rejected: malformed self-closing tag");
      } else if (state === "beforeValue") {
        if (space) continue;
        if (char === '"' || char === "'") quote = char;
        else {
          if (char === "=" || char === "`") throw new Error("HTML structure rejected: malformed attribute value");
          state = "value";
        }
      } else if (state === "value") {
        if (space) state = "beforeAttribute";
        else if (char === '"' || char === "'" || char === "=" || char === "`") {
          throw new Error("HTML structure rejected: ambiguous attribute quote");
        }
      } else if (state === "afterValue") {
        if (space) state = "beforeAttribute";
        else if (char === "/") state = "slash";
        else throw new Error("HTML structure rejected: missing attribute separator");
      } else if (space) {
        if (state === "attribute") state = "afterAttribute";
      } else if (char === "/") {
        state = "slash";
      } else if (char === "=" && (state === "attribute" || state === "afterAttribute")) {
        state = "beforeValue";
      } else {
        const valid = state === "attribute" ? /[A-Za-z0-9_:.-]/ : /[A-Za-z_:]/;
        if (!valid.test(char)) throw new Error("HTML structure rejected: malformed attribute name");
        state = "attribute";
      }
    }
    if (end === html.length) throw new Error("HTML structure rejected: unterminated tag");
    const token = html.slice(start + 1, end);
    const match = /^(\/?)([A-Za-z][A-Za-z0-9:-]*)(?=[\t\n\f\r /]|$)/.exec(token);
    if (!match) throw new Error("HTML structure rejected: ambiguous tag token");
    if (closing && token[match[0].length] === "/") {
      throw new Error("HTML structure rejected: ambiguous closing tag");
    }
    const name = match[2].toLowerCase();
    if (!VOID_TAGS.has(name)) {
      if (match[1]) {
        if (stack.pop() !== name) throw new Error("HTML structure rejected: mismatched closing tag");
      } else {
        // Deliberately do NOT apply implied closes or '/>' for non-void tags:
        // those only reduce parser depth. Lexical depth stays an upper bound,
        // even when htmlparser2 repairs optional end tags differently.
        stack.push(name);
        if (stack.length > MAX_HTML_DEPTH) throw new Error("HTML resource limit: nesting depth");
        if (["script", "style", "title", "textarea", "xmp"].includes(name)) {
          // htmlparser2 exits raw-text mode on '/>' even though HTML's stack
          // ignores self-closing non-void tags. Reject rather than undercount.
          if (/\/[\t\n\f\r ]*$/.test(token)) {
            throw new Error("HTML structure rejected: self-closing raw-text tag");
          }
          rawTag = name;
        }
      }
    }
    cursor = end + 1;
  }
  if (stack.length !== 0) throw new Error("HTML structure rejected: unclosed tag");
}

/** Safe conversion entry point shared by formatters and isolated MIME workers. */
export function safeHtmlToText(html: string): string {
  preflightHtml(html);
  return htmlToText(html, {
    wordwrap: false,
    // Defense in depth for DOM traversal. These options do NOT bound parsing;
    // the conservative preflight above must run before html-to-text sees input.
    limits: {
      maxInputLength: MAX_HTML_BYTES,
      maxDepth: MAX_HTML_DEPTH,
      maxChildNodes: MAX_HTML_NODES,
      maxBaseElements: MAX_HTML_NODES,
    },
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
    ],
  }).replace(/ /g, " ").trim();
}
