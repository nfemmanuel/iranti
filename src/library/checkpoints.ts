// Checkpoints — Phase 1 (+ Layer 0e: stage/status metadata)
//
// A checkpoint is "where you left off": a short description of in-progress
// work that lets a brand-new session resume without re-explaining. It is one
// of iranti's three core memory categories (facts, rules, checkpoints).
//
// Phase 1 implementation: a checkpoint is a fact with the reserved key
// "checkpoint". This costs zero schema changes and inherits all fact
// behavior for free — history in fact_archive, tenant scoping, provenance.
// One checkpoint per entity (the upsert semantics enforce this), and the
// previous checkpoint is archived automatically on every update.
//
// A dedicated checkpoints table (with richer structure: next steps, blockers,
// progress) is planned when checkpoint usage patterns are clearer — likely
// Phase 2. The reserved key is the seam: migrating means copying facts with
// key='checkpoint' into the new table.
//
// Convention: checkpoint facts are exempt from Phase 4 decay. The archivist
// must skip key='checkpoint' rows. (Documented here so Phase 4 implements it.)
//
// Layer 0e — stage/status metadata (see docs/prds/phases/layer-0e-checkpoints.md
// Decision 0/2): status lives as checkpoint fact METADATA, not a new table or
// state machine — the same "zero schema change" posture the reserved key
// already established above, extended to stage/status. Stored in the existing
// facts.metadata jsonb column as { stage, status, stageSetAt }. stageSetAt is
// stamped server-side (never caller-supplied) so it can be trusted for
// gap/staleness computation.

import type { Fact, NewFact } from "../db/schema.js";
import { archiveFact, findFact, writeFact } from "./facts.js";

// The reserved fact key that marks a checkpoint. No regular fact may use it.
export const CHECKPOINT_KEY = "checkpoint";

// Closed, deterministic stage vocabulary (Layer 0e). Deliberately small —
// this is the machine-checkable part of checkpoint state. Free-text nuance
// belongs in `status`, not here (see PRD Decision 2).
export const CHECKPOINT_STAGES = [
  "planning",
  "in_progress",
  "blocked",
  "done",
] as const;
export type CheckpointStage = (typeof CHECKPOINT_STAGES)[number];

// Default stage for a checkpoint written without one — matches the common
// case ("I'm mid-task, here's where I am").
export const DEFAULT_CHECKPOINT_STAGE: CheckpointStage = "in_progress";

// Read-side default for checkpoints written BEFORE Layer 0e shipped (no
// metadata at all) — deliberately distinct from DEFAULT_CHECKPOINT_STAGE so
// "we don't know" is never confused with "explicitly in progress" (PRD §9 risk).
export const UNKNOWN_CHECKPOINT_STAGE = "unknown";

export interface CheckpointStageMeta {
  stage: CheckpointStage;
  status: string | null;
  stageSetAt: string;
}

// Extract the checkpoint's stage/status metadata, applying the read-side
// "unknown" fallback for pre-Layer-0e checkpoints that carry no metadata.
export function readCheckpointStage(fact: Pick<Fact, "metadata">): {
  stage: string;
  status: string | null;
  stageSetAt: string | null;
} {
  const meta = fact.metadata as Partial<CheckpointStageMeta> | null | undefined;
  if (!meta || typeof meta !== "object" || !meta.stage) {
    return { stage: UNKNOWN_CHECKPOINT_STAGE, status: null, stageSetAt: null };
  }
  return {
    stage: meta.stage,
    status: typeof meta.status === "string" ? meta.status : null,
    stageSetAt: typeof meta.stageSetAt === "string" ? meta.stageSetAt : null,
  };
}

// Save a checkpoint for an entity. Overwrites the previous checkpoint
// (which is snapshotted to fact_archive like any superseded fact).
export async function writeCheckpoint(
  entityType: string,
  entityId: string,
  text: string,
  opts: Pick<
    NewFact,
    "source" | "surface" | "tenantId" | "project" | "sessionId" | "agentId"
  > & {
    stage?: CheckpointStage;
    status?: string;
  } = { source: "checkpoint" },
): Promise<Fact> {
  const stageMeta: CheckpointStageMeta = {
    stage: opts.stage ?? DEFAULT_CHECKPOINT_STAGE,
    status: opts.status ?? null,
    // Server-stamped, never caller-supplied (PRD Decision 2) — trustworthy
    // for gap/staleness computation regardless of client clock skew.
    stageSetAt: new Date().toISOString(),
  };

  return writeFact({
    entityType,
    entityId,
    key: CHECKPOINT_KEY,
    value: text,
    source: opts.source ?? "checkpoint",
    surface: opts.surface,
    tenantId: opts.tenantId,
    project: opts.project,
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    metadata: stageMeta,
  });
}

// Get the checkpoint for a single entity, if one exists.
// No side effects — checking for a checkpoint is not a memory retrieval.
export async function getCheckpoint(
  entityType: string,
  entityId: string,
  tenantId: string = "default",
  project: string | string[] = "default",
): Promise<Fact | undefined> {
  return findFact(entityType, entityId, CHECKPOINT_KEY, tenantId, project);
}

// Get the most recent checkpoint across a set of entity hints.
// iranti_attend calls this with the entities in scope for the current turn
// and injects whichever checkpoint was written last.
export async function getActiveCheckpoint(
  entityHints: Array<{ entityType: string; entityId: string }>,
  tenantId: string = "default",
  project: string | string[] = "default",
): Promise<Fact | undefined> {
  const checkpoints = await Promise.all(
    entityHints.map((h) =>
      getCheckpoint(h.entityType, h.entityId, tenantId, project),
    ),
  );

  return checkpoints
    .filter((c): c is Fact => c !== undefined)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
}

// Clear an entity's checkpoint. The work is done — archive it.
// The checkpoint's full history survives in fact_archive.
export async function clearCheckpoint(
  entityType: string,
  entityId: string,
  tenantId: string = "default",
  project: string | string[] = "default",
): Promise<boolean> {
  const checkpoint = await getCheckpoint(entityType, entityId, tenantId, project);
  if (!checkpoint) return false;

  await archiveFact(checkpoint.id);
  return true;
}
