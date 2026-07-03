// iranti_search — Phase 1.1
//
// Full-text search over stored facts. Use this when the agent needs to find
// a fact whose exact key is unknown. Unlike iranti_attend (which injects
// context automatically), iranti_search is explicit: the agent asks for
// specific information and gets back matching facts.
//
// Searches key and value fields case-insensitively. Can be scoped to a
// specific entity or left open to search across all entities.

import { z } from "zod";
import { searchFacts } from "../../library/facts.js";
import { ensureContext } from "../context.js";
import { getEffectiveProjectIds } from "../../library/projects.js";

export const searchInputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      "Search terms. Matched case-insensitively against fact keys and values.",
    ),
  entityType: z
    .string()
    .min(1)
    .optional()
    .describe("Scope the search to one entity type."),
  entityId: z
    .string()
    .min(1)
    .optional()
    .describe("Scope to one entity (requires entityType)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum results. Default 10, max 50."),
  agentName: z.string().optional(),
};

export const searchInput = z.object(searchInputSchema);
// z.input preserves optional/default fields as optional so callers can omit
// limit and get the default — the MCP layer applies defaults before the
// function is called in production; tests call the function directly.
export type SearchInput = z.input<typeof searchInput>;

export interface SearchResult {
  count: number;
  results: Array<{
    entity: string;
    key: string;
    value: string;
    source: string;
    accessCount: number;
    updatedAt: string;
  }>;
}

export async function search(input: SearchInput): Promise<SearchResult> {
  const ctx = await ensureContext(input.agentName);
  const projectIds = await getEffectiveProjectIds(ctx.project.id);

  const found = await searchFacts(input.query, {
    entityType: input.entityType,
    entityId: input.entityId,
    limit: input.limit ?? 10,
    project: projectIds,
  });

  return {
    count: found.length,
    results: found.map((f) => ({
      entity: `${f.entityType}/${f.entityId}`,
      key: f.key,
      value: f.value,
      source: f.source,
      accessCount: f.accessCount,
      updatedAt: f.updatedAt.toISOString(),
    })),
  };
}
