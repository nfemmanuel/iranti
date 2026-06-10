// OpenAI deep-research connector aliases — Phase 2.5 (CORE-13)
//
// The ChatGPT deep-research connector requires exactly two tool names:
// `search` and `fetch`. Every other host already has `iranti_search` and
// `iranti_query`, so these aliases are registered only when
// IRANTI_EXPOSE_OPENAI_ALIASES=true to avoid polluting the default tool list.
//
// search → iranti_search (full-text fact search)
// fetch  → iranti_query  (exact entity+key lookup)

import { z } from "zod";
import { search } from "./search.js";
import { query } from "./query.js";

// ---------------------------------------------------------------------------
// search alias
// ---------------------------------------------------------------------------

export const searchAliasInputSchema = {
  query: z.string().min(1).describe("Search terms to find relevant facts."),
  entityType: z
    .string()
    .optional()
    .describe("Optionally scope to a specific entity type (e.g. 'project')."),
  entityId: z
    .string()
    .optional()
    .describe("Optionally scope to a specific entity ID."),
};

export async function searchAlias(input: {
  query: string;
  entityType?: string;
  entityId?: string;
}) {
  return search({ query: input.query, entityType: input.entityType, entityId: input.entityId });
}

// ---------------------------------------------------------------------------
// fetch alias
// ---------------------------------------------------------------------------

export const fetchAliasInputSchema = {
  id: z
    .string()
    .min(1)
    .describe(
      "Fact identifier in 'entityType/entityId/key' format, e.g. " +
        "'project/my-app/preferred_language'.",
    ),
};

export async function fetchAlias(input: { id: string }) {
  // Parse entityType/entityId/key from the id string.
  // Split on the first two slashes only so keys with slashes survive.
  const parts = input.id.split("/");
  if (parts.length < 3) {
    throw new Error(
      `fetch id must be in 'entityType/entityId/key' format, got: ${input.id}`,
    );
  }
  const entityType = parts[0]!;
  const entityId = parts[1]!;
  const key = parts.slice(2).join("/");
  return query({ entityType, entityId, key });
}
