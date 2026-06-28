// Tool registration — shared between transports (Phase 2.5 fix)
//
// SDK 1.29.0 allows exactly ONE transport per McpServer instance —
// server.connect() throws "Already connected to a transport" on a second
// call. So stdio and HTTP each get their own McpServer, and this module is
// the single source of truth for the tool surface applied to both.
// Discovered via smoke test 2026-06-10: the dual-transport boot crashed;
// unit tests missed it because each test used a fresh single-transport server.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { ingestMediaTool, ingestMediaInputSchema } from "./tools/ingest-media.js";

// Phase 3 (CORE-31): default breadcrumb injected into every non-attend result.
// attend() returns its own nextDue (phase-specific); all other tools get this.
const DEFAULT_NEXT_DUE = "iranti_attend(phase='post-response') due after response";

// Tool results are JSON in a text block — every MCP host renders that;
// structured-output support is still uneven across hosts.
// Injects nextDue breadcrumb if the payload doesn't already carry one.
function asResult(payload: unknown) {
  const obj =
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const enriched =
    obj && !("nextDue" in obj)
      ? { ...obj, nextDue: DEFAULT_NEXT_DUE }
      : payload;
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(enriched, null, 2) },
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

// Register the full iranti tool surface on a server instance.
// Call once per McpServer (stdio and HTTP each have their own).
export function registerIrantiTools(server: McpServer): void {
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

  // OD-4: media ingest tool.
  server.registerTool(
    "iranti_ingest_media",
    {
      title: "Ingest media object",
      description:
        "Store a media object (image, PDF, etc.) as durable memory for an entity. " +
        "Accepts base64 bytes or a local file path plus a MIME type. " +
        "The object is stored immediately; vision tagging (description + tags) " +
        "runs asynchronously. Stored objects appear in iranti_attend when their " +
        "description matches the conversation.",
      inputSchema: ingestMediaInputSchema,
    },
    async (input) => {
      try {
        return asResult(await ingestMediaTool(input));
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
}
