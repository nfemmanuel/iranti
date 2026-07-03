// iranti_checkpoint — Phase 1.1 (+ Layer 0e: stage/status)
//
// Dedicated checkpoint tool. A checkpoint captures where you left off:
// what you were doing, what's done, what's next, any blockers. Call this
// at every natural pause point so a fresh session can resume without
// re-explaining the situation.
//
// Internally stored as a fact with the reserved key 'checkpoint'. Only one
// checkpoint per entity; writing a new one archives the previous.
// iranti_attend always returns the active checkpoint separately from facts.
//
// Layer 0e: optional stage/status fields, stored as checkpoint metadata (see
// docs/prds/phases/layer-0e-checkpoints.md). Both optional — existing callers
// are unaffected; omitting stage defaults to "in_progress" server-side.

import { z } from "zod";
import {
  CHECKPOINT_STAGES,
  DEFAULT_CHECKPOINT_STAGE,
  writeCheckpoint,
} from "../../library/checkpoints.js";
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
  stage: z
    .enum(CHECKPOINT_STAGES)
    .optional()
    .describe(
      "Deterministic stage: planning | in_progress | blocked | done. " +
        "Defaults to 'in_progress' when omitted.",
    ),
  status: z
    .string()
    .optional()
    .describe(
      "Short free-text substatus, e.g. 'waiting on API key'. Optional detail " +
        "alongside the closed 'stage' vocabulary.",
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
  stage: string;
  status: string | null;
}

export async function checkpointTool(
  input: CheckpointInput,
): Promise<CheckpointResult> {
  const ctx = await ensureContext(input.agentName);

  await upsertEntity(input.entityType, input.entityId);

  const stage = input.stage ?? DEFAULT_CHECKPOINT_STAGE;
  const status = input.status ?? null;

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
      stage,
      status: status ?? undefined,
    },
  );

  return {
    factId: fact.id,
    entity: `${fact.entityType}/${fact.entityId}`,
    updatedAt: fact.updatedAt.toISOString(),
    stage,
    status,
  };
}
