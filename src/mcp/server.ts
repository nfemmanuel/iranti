// iranti MCP server — Phase 1
//
// Exposes the Phase 0 library over the Model Context Protocol via stdio.
// The host process (Claude Desktop, Claude Code, Cursor, ...) spawns this
// server and pipes JSON-RPC over stdin/stdout.
//
// IMPORTANT: stdout belongs to the protocol. Never console.log here —
// diagnostics go to stderr (console.error), which hosts surface in logs.
//
// Single-instance constraint (Phase 1): one server process per host, no
// concurrent-write safety across processes. See implementation.md.
//
// Usage (host config):
//   { "command": "node", "args": ["<repo>/dist/mcp/server.js"],
//     "env": { "DATABASE_URL": "...", "IRANTI_AGENT_NAME": "claude-desktop" } }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pool } from "../db/connection.js";
import { shutdownContext } from "./context.js";
import { attend, attendInputSchema } from "./tools/attend.js";
import { archive, archiveInputSchema } from "./tools/archive.js";
import { write, writeInputSchema } from "./tools/write.js";
import { writeRuleTool, writeRuleInputSchema } from "./tools/write-rule.js";

const server = new McpServer({
  name: "iranti",
  version: "0.1.0",
});

// Tool results are JSON in a text block — every MCP host renders that;
// structured-output support is still uneven across hosts.
function asResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function asError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

server.registerTool(
  "iranti_attend",
  {
    title: "Attend to memory",
    description:
      "Call before responding to the user. Bidirectional: stores URLs and " +
      "file paths found in the message automatically, and returns the " +
      "rules, recent facts, and active checkpoint for the entities in " +
      "scope. Inject the returned rules and facts into your working context.",
    inputSchema: attendInputSchema,
  },
  async (input) => {
    try {
      return asResult(await attend(input));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "iranti_write",
  {
    title: "Write a fact",
    description:
      "Store one durable fact about an entity. Call when you learn " +
      "something that future sessions should know: a decision, a " +
      "preference, project state. Use key 'checkpoint' to save " +
      "where-you-left-off state for session resumption.",
    inputSchema: writeInputSchema,
  },
  async (input) => {
    try {
      return asResult(await write(input));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "iranti_write_rule",
  {
    title: "Write a rule",
    description:
      "Store a behavioral rule. Rules are injected on every iranti_attend " +
      "call for the entities in scope, never decay, and are additive — " +
      "writing twice creates two rules.",
    inputSchema: writeRuleInputSchema,
  },
  async (input) => {
    try {
      return asResult(await writeRuleTool(input));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "iranti_archive",
  {
    title: "Archive a fact",
    description:
      "Mark a fact as no longer current, by factId or by " +
      "entityType + entityId + key. The fact's history is preserved.",
    inputSchema: archiveInputSchema,
  },
  async (input) => {
    try {
      return asResult(await archive(input));
    } catch (err) {
      return asError(err);
    }
  },
);

// Best-effort cleanup. Hosts usually kill the process outright — leaked
// sessions are expected and detectable via getOpenSessions().
async function shutdown(signal: string): Promise<void> {
  console.error(`iranti: ${signal} received, closing session`);
  try {
    await shutdownContext();
    await pool.end({ timeout: 5 });
  } catch (err) {
    console.error("iranti: shutdown error", err);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("iranti MCP server running (stdio)");
