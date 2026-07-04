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
import {
  rulesList,
  rulesListInputSchema,
  ruleDeactivate,
  ruleDeactivateInputSchema,
} from "./tools/rules.js";
import {
  aliasesList,
  aliasesListInputSchema,
  aliasArchive,
  aliasArchiveInputSchema,
} from "./tools/entity-aliases.js";
import { ingestMediaTool, ingestMediaInputSchema } from "./tools/ingest-media.js";
import { projectStateTool, projectStateInputSchema } from "./tools/project-state.js";
import {
  projectStatus,
  projectStatusInputSchema,
  projectCombine,
  projectCombineInputSchema,
  projectUncombine,
  projectUncombineInputSchema,
  projectExclude,
  projectExcludeInputSchema,
  projectInclude,
  projectIncludeInputSchema,
} from "./tools/project.js";

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
    "iranti_rules_list",
    {
      title: "List rules",
      description:
        "List the behavioral rules active in the current project scope, with " +
        "their ids. The audit surface for 'what is governing me right now?' — " +
        "pass a returned id to iranti_rule_deactivate to retire a rule.",
      inputSchema: rulesListInputSchema,
    },
    async (input) => {
      try {
        return asResult(await rulesList(input));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "iranti_rule_deactivate",
    {
      title: "Deactivate a rule",
      description:
        "Stop a rule from being injected, by id (from iranti_rules_list). " +
        "The rule row is kept — never hard-deleted. To change a rule's text, " +
        "deactivate the old one and write a new one.",
      inputSchema: ruleDeactivateInputSchema,
    },
    async (input) => {
      try {
        return asResult(await ruleDeactivate(input));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "iranti_aliases_list",
    {
      title: "List learned aliases",
      description:
        "List the nickname→fact aliases learned in the current project scope " +
        "(optionally scoped to one entity), with their ids. Pass an id to " +
        "iranti_alias_archive to retire a wrongly-learned nickname.",
      inputSchema: aliasesListInputSchema,
    },
    async (input) => {
      try {
        return asResult(await aliasesList(input));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "iranti_alias_archive",
    {
      title: "Archive an alias",
      description:
        "Stop a learned nickname from resolving, by id (from " +
        "iranti_aliases_list). The record is kept — never hard-deleted.",
      inputSchema: aliasArchiveInputSchema,
    },
    async (input) => {
      try {
        return asResult(await aliasArchive(input));
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

  // Layer 0e: deterministic "where did we leave off?" rollup.
  server.registerTool(
    "iranti_project_state",
    {
      title: "Project state rollup",
      description:
        "Answer 'where did we leave off?' for the current project: the " +
        "latest checkpoint (with stage/status), recent decisions, open " +
        "issues, and how long it's been since any activity. Read-only. " +
        "Call this at the start of a session after a gap to reorient " +
        "without re-running individual fact lookups.",
      inputSchema: projectStateInputSchema,
    },
    async (input) => {
      try {
        return asResult(await projectStateTool(input));
      } catch (err) {
        return asError(err);
      }
    },
  );

  // Layer 0 (D7/D8): project scoping controls.
  server.registerTool(
    "iranti_project_status",
    {
      title: "Project status",
      description:
        "Show the current project (detected from this server's working " +
        "directory), how it was detected, whether it's excluded, and which " +
        "other projects it's actively combined with.",
      inputSchema: projectStatusInputSchema,
    },
    async (input) => {
      try {
        return asResult(await projectStatus(input));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "iranti_project_combine",
    {
      title: "Combine projects",
      description:
        "Explicitly share memory between the current project and another " +
        "one. Reads in either project will then span both. Reversible via " +
        "iranti_project_uncombine. Isolation is the default — this is an " +
        "opt-in, stored, reversible action, never a one-way migration.",
      inputSchema: projectCombineInputSchema,
    },
    async (input) => {
      try {
        return asResult(await projectCombine(input));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "iranti_project_uncombine",
    {
      title: "Uncombine projects",
      description:
        "Reverse a previous iranti_project_combine. Restores isolation " +
        "between the two projects. The combine record is kept (not " +
        "deleted) — combining again reactivates it.",
      inputSchema: projectUncombineInputSchema,
    },
    async (input) => {
      try {
        return asResult(await projectUncombine(input));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "iranti_project_exclude",
    {
      title: "Exclude a project",
      description:
        "Mark a project folder as excluded: it still works (writes still " +
        "succeed), but no combine links are honored for it and its writes " +
        "are tagged for audit. Reversible via iranti_project_include. " +
        "Defaults to the current project if none is given.",
      inputSchema: projectExcludeInputSchema,
    },
    async (input) => {
      try {
        return asResult(await projectExclude(input));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "iranti_project_include",
    {
      title: "Re-include a project",
      description:
        "Reverse iranti_project_exclude. Any previously active combine " +
        "links for this project are automatically honored again.",
      inputSchema: projectIncludeInputSchema,
    },
    async (input) => {
      try {
        return asResult(await projectInclude(input));
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
