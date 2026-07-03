// Checkpoints — Phase 1
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

import type { Fact, NewFact } from "../db/schema.js";
import { archiveFact, findFact, writeFact } from "./facts.js";

// The reserved fact key that marks a checkpoint. No regular fact may use it.
export const CHECKPOINT_KEY = "checkpoint";

// Save a checkpoint for an entity. Overwrites the previous checkpoint
// (which is snapshotted to fact_archive like any superseded fact).
export async function writeCheckpoint(
  entityType: string,
  entityId: string,
  text: string,
  opts: Pick<
    NewFact,
    "source" | "surface" | "tenantId" | "project" | "sessionId" | "agentId" | "metadata"
  > = { source: "checkpoint" },
): Promise<Fact> {
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
    metadata: opts.metadata,
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
