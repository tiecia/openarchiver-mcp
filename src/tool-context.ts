import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenArchiverClient } from "./client.js";
import type { AttachmentFiles } from "./runtime.js";
import type { MimeParseOptions } from "./mime.js";

export type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
export type ArchiveClient = Pick<OpenArchiverClient, "search" | "getEmail" | "checkIntegrity" | "download"> &
  Partial<Pick<OpenArchiverClient, "listArchive" | "suggestValues">>;
export interface ToolContext {
  server: McpServer;
  getClient: () => ArchiveClient;
  guarded: (operation: () => Promise<ToolResult>) => Promise<ToolResult>;
  result: (summary: string, data: Record<string, unknown>) => ToolResult;
  files: AttachmentFiles;
  mimeOptions: MimeParseOptions;
  parse?: (raw: Buffer, options: import("mailparser").SimpleParserOptions) => Promise<import("mailparser").ParsedMail>;
}
