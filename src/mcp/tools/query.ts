// iranti_query — Phase 1.1
//
// Exact lookup of a specific fact by entity + key. Unlike iranti_attend
// (broad context injection) and iranti_search (full-text sweep), iranti_query
// is precise: you know the entity and the key, you want the current value.
//
// Updates access tracking — this is a real retrieval that feeds reinforcement.

import { z } from "zod";
import { readFact } from "../../library/facts.js";
import { ensureContext } from "../context.js";
import { getEffectiveProjectIds } from "../../library/projects.js";

export const queryInputSchema = {
  entityType: z.string().min(1).describe("The entity type."),
  entityId: z.string().min(1).describe("The entity identifier."),
  key: z.string().min(1).describe("The fact key to retrieve."),
  agentName: z.string().optional(),
};

export const queryInput = z.object(queryInputSchema);
export type QueryInput = z.infer<typeof queryInput>;

export interface QueryResult {
  found: boolean;
  fact: {
    entity: string;
    key: string;
    value: string;
    source: string;
    accessCount: number;
    updatedAt: string;
  } | null;
}

export async function query(input: QueryInput): Promise<QueryResult> {
  const ctx = await ensureContext(input.agentName);
  const projectIds = await getEffectiveProjectIds(ctx.project.id);

  const fact = await readFact(
    input.entityType,
    input.entityId,
    input.key,
    "default",
    projectIds,
  );

  if (!fact) {
    return { found: false, fact: null };
  }

  return {
    found: true,
    fact: {
      entity: `${fact.entityType}/${fact.entityId}`,
      key: fact.key,
      value: fact.value,
      source: fact.source,
      accessCount: fact.accessCount,
      updatedAt: fact.updatedAt.toISOString(),
    },
  };
}
