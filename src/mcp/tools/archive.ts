// iranti_archive — Phase 1
//
// Mark a fact as no longer current. The fact stops appearing in attend
// results and reads; its full history survives in fact_archive.
//
// Accepts either a factId directly, or entityType+entityId+key — the host
// usually knows the entity and key (from a previous attend) rather than
// the UUID.

import { z } from "zod";
import { archiveFact, findFact } from "../../library/facts.js";
import { ensureContext } from "../context.js";
import { getEffectiveProjectIds } from "../../library/projects.js";

export const archiveInputSchema = {
  factId: z
    .string()
    .uuid()
    .optional()
    .describe("The fact's UUID, if known."),
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  key: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Together with entityType + entityId, identifies the fact to archive " +
        "when the UUID is not known.",
    ),
  agentName: z.string().optional(),
};

export const archiveInput = z.object(archiveInputSchema);
export type ArchiveInput = z.infer<typeof archiveInput>;

export interface ArchiveResult {
  archived: boolean;
  factId: string | null;
  reason: string;
}

export async function archive(input: ArchiveInput): Promise<ArchiveResult> {
  const ctx = await ensureContext(input.agentName);
  const projectIds = await getEffectiveProjectIds(ctx.project.id);

  let factId = input.factId ?? null;

  if (!factId) {
    if (!input.entityType || !input.entityId || !input.key) {
      return {
        archived: false,
        factId: null,
        reason:
          "Provide either factId, or all of entityType + entityId + key.",
      };
    }
    const fact = await findFact(
      input.entityType,
      input.entityId,
      input.key,
      "default",
      projectIds,
    );
    if (!fact) {
      return {
        archived: false,
        factId: null,
        reason: `No active fact found for ${input.entityType}/${input.entityId}/${input.key}.`,
      };
    }
    factId = fact.id;
  }

  // Effective project ids passed so a factId from another project (or an
  // unknown/already-archived id) reports archived:false instead of blindly
  // claiming success — cross-project archive was the write-side twin of the
  // history factId leak (review MAJOR, Layer 0 gauntlet). Not-found and
  // out-of-scope are deliberately indistinguishable.
  const didArchive = await archiveFact(factId, projectIds);
  return didArchive
    ? { archived: true, factId, reason: "Archived." }
    : {
        archived: false,
        factId,
        reason:
          "No active fact with that id in your project scope (unknown id, already archived, or outside this project).",
      };
}
