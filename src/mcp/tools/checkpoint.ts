// iranti_checkpoint — Phase 1.1
//
// Dedicated checkpoint tool. A checkpoint captures where you left off:
// what you were doing, what's done, what's next, any blockers. Call this
// at every natural pause point so a fresh session can resume without
// re-explaining the situation.
//
// Internally stored as a fact with the reserved key 'checkpoint'. Only one
// checkpoint per entity; writing a new one archives the previous.
// iranti_attend always returns the active checkpoint separately from facts.

import { z } from "zod";
import { writeCheckpoint } from "../../library/checkpoints.js";
import { upsertEntity } from "../../library/entities.js";
import { VALID_SURFACES } from "../../library/facts.js";
import { ensureContext } from "../context.js";

export const checkpointInputSchema = {
  entityType: z
    .string()
    .min(1)
    .describe("The entity this checkpoint is for."),
  entityId: z.string().min(1).describe("Identifier within the type."),
  text: z
    .string()
    .min(1)
    .describe(
      "What you were working on, what is done, what is next, any blockers. " +
        "Write it so a brand-new session can resume without re-explaining.",
    ),
  surface: z.enum(VALID_SURFACES).optional(),
  agentName: z.string().optional(),
};

export const checkpointInput = z.object(checkpointInputSchema);
export type CheckpointInput = z.infer<typeof checkpointInput>;

export interface CheckpointResult {
  factId: string;
  entity: string;
  updatedAt: string;
}

export async function checkpointTool(
  input: CheckpointInput,
): Promise<CheckpointResult> {
  const ctx = await ensureContext(input.agentName);

  await upsertEntity(input.entityType, input.entityId);

  const fact = await writeCheckpoint(
    input.entityType,
    input.entityId,
    input.text,
    {
      source: `mcp:${ctx.agent.name}`,
      surface: input.surface,
      sessionId: ctx.session.id,
      agentId: ctx.agent.id,
      project: ctx.project.id,
    },
  );

  return {
    factId: fact.id,
    entity: `${fact.entityType}/${fact.entityId}`,
    updatedAt: fact.updatedAt.toISOString(),
  };
}
