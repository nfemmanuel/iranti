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
import { startHttpServer } from "./http.js";
import { attend, attendInputSchema } from "./tools/attend.js";
import { archive, archiveInputSchema } from "./tools/archive.js";
import { checkpointTool, checkpointInputSchema } from "./tools/checkpoint.js";
import { history, historyInputSchema } from "./tools/history.js";
import { query, queryInputSchema } from "./tools/query.js";
import { search, searchInputSchema } from "./tools/search.js";
import { write, writeInputSchema } from "./tools/write.js";
import { writeIssueTool, writeIssueInputSchema } from "./tools/write-issue.js";
import { writeRuleTool, writeRuleInputSchema } from "./tools/write-rule.js";
import {
  searchAlias,
  searchAliasInputSchema,
  fetchAlias,
  fetchAliasInputSchema,
} from "./tools/aliases.js";

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

server.registerTool(
  "iranti_search",
  {
    title: "Search facts",
    description:
      "Full-text search over stored facts. Use when you need to find a fact " +
      "whose exact key is unknown. Searches key and value case-insensitively. " +
      "Optionally scoped to a specific entity.",
    inputSchema: searchInputSchema,
  },
  async (input) => {
    try {
      return asResult(await search(input));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "iranti_checkpoint",
  {
    title: "Save checkpoint",
    description:
      "Save where you left off for session resumption. Summarize what you " +
      "were working on, what is done, what is next, and any blockers. " +
      "Call at every natural pause point. iranti_attend returns the active " +
      "checkpoint automatically — a new session picks up where you left off.",
    inputSchema: checkpointInputSchema,
  },
  async (input) => {
    try {
      return asResult(await checkpointTool(input));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "iranti_history",
  {
    title: "Fact history",
    description:
      "Return the full change history for a fact: every value it has held, " +
      "newest first. Accepts factId or entityType + entityId + key.",
    inputSchema: historyInputSchema,
  },
  async (input) => {
    try {
      return asResult(await history(input));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "iranti_query",
  {
    title: "Query a fact",
    description:
      "Exact lookup of one fact by entity + key. Use when you know exactly " +
      "what you are looking for. Updates access tracking — counts as a retrieval.",
    inputSchema: queryInputSchema,
  },
  async (input) => {
    try {
      return asResult(await query(input));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "iranti_write_issue",
  {
    title: "Write issue",
    description:
      "Store a structured issue or to-do item. Writing the same title again " +
      "upserts the issue — updating its status or description. " +
      "Issues are scoped to an entity: project/my-app for project issues, " +
      "user/alice for personal to-dos.",
    inputSchema: writeIssueInputSchema,
  },
  async (input) => {
    try {
      return asResult(await writeIssueTool(input));
    } catch (err) {
      return asError(err);
    }
  },
);

// Phase 2.5 (CORE-13): OpenAI deep-research connector aliases.
// Only registered when IRANTI_EXPOSE_OPENAI_ALIASES=true — these tool names
// collide with iranti_search / iranti_query on other hosts.
if (process.env.IRANTI_EXPOSE_OPENAI_ALIASES === "true") {
  server.registerTool(
    "search",
    {
      title: "Search facts",
      description:
        "Search iranti memory for facts matching the query. " +
        "Returns matching facts from the knowledge base.",
      inputSchema: searchAliasInputSchema,
    },
    async (input) => {
      try {
        return asResult(await searchAlias(input));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch a fact",
      description:
        "Fetch a specific fact by its identifier in " +
        "'entityType/entityId/key' format.",
      inputSchema: fetchAliasInputSchema,
    },
    async (input) => {
      try {
        return asResult(await fetchAlias(input));
      } catch (err) {
        return asError(err);
      }
    },
  );
}

// Phase 2.5 (CORE-12): Optional Streamable HTTP transport.
// Starts when both IRANTI_HTTP_TOKEN and IRANTI_HTTP_PORT are set.
// stdio transport always starts regardless.
const httpToken = process.env.IRANTI_HTTP_TOKEN;
const httpPortStr = process.env.IRANTI_HTTP_PORT;
let httpServer: import("node:http").Server | undefined;
if (httpToken && httpPortStr) {
  const httpPort = parseInt(httpPortStr, 10);
  if (!isNaN(httpPort)) {
    httpServer = await startHttpServer(server, httpPort, httpToken);
  }
}

// Best-effort cleanup. Hosts usually kill the process outright — leaked
// sessions are expected and detectable via getOpenSessions().
async function shutdown(signal: string): Promise<void> {
  console.error(`iranti: ${signal} received, closing session`);
  try {
    // Close the HTTP listener first so its socket is released before exit —
    // otherwise the port can linger and reject the next process on restart.
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
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
