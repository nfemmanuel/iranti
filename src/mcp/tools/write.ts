// iranti_write — Phase 1
//
// Explicit fact storage. The host calls this when it learns something
// semantic that the attend extractor can't capture deterministically:
// decisions, preferences, project state. One call = one fact.
//
// Checkpoints go through this tool too, using the reserved key
// "checkpoint" — writing it replaces the entity's checkpoint, and
// iranti_attend returns it separately from regular facts.

import { z } from "zod";
import { upsertEntity } from "../../library/entities.js";
import { VALID_SURFACES, writeFact } from "../../library/facts.js";
import { ensureContext } from "../context.js";

export const writeInputSchema = {
  entityType: z
    .string()
    .min(1)
    .describe("Broad category: 'user', 'project', 'system', ..."),
  entityId: z.string().min(1).describe("Identifier within the type."),
  key: z
    .string()
    .min(1)
    .describe(
      "What this fact is about: 'timezone', 'tech_stack'. The reserved key " +
        "'checkpoint' saves where-you-left-off state for session resumption.",
    ),
  value: z.string().min(1).describe("The fact's value. Plain text."),
  surface: z
    .enum(VALID_SURFACES)
    .optional()
    .describe("Which AI host platform this call comes from."),
  source: z
    .string()
    .optional()
    .describe("Free-text provenance label. Defaults to the agent name."),
  agentName: z.string().optional(),
};

export const writeInput = z.object(writeInputSchema);
export type WriteInput = z.infer<typeof writeInput>;

export interface WriteResult {
  factId: string;
  entity: string;
  key: string;
  isCheckpoint: boolean;
}

export async function write(input: WriteInput): Promise<WriteResult> {
  const ctx = await ensureContext(input.agentName);

  await upsertEntity(input.entityType, input.entityId);

  const fact = await writeFact({
    entityType: input.entityType,
    entityId: input.entityId,
    key: input.key,
    value: input.value,
    source: input.source ?? `mcp:${ctx.agent.name}`,
    surface: input.surface,
    sessionId: ctx.session.id,
    agentId: ctx.agent.id,
    project: ctx.project.id,
  });

  return {
    factId: fact.id,
    entity: `${fact.entityType}/${fact.entityId}`,
    key: fact.key,
    isCheckpoint: fact.key === "checkpoint",
  };
}
