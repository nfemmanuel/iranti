// iranti_aliases_list / iranti_alias_archive — Layer 0h
//
// The entity-alias correctability surface (Layer 0c's aliases: nickname →
// fact links). NOTE the deliberate filename: src/mcp/tools/aliases.ts is an
// UNRELATED module — the OpenAI deep-research `search`/`fetch` tool-NAME
// aliases, gated behind IRANTI_EXPOSE_OPENAI_ALIASES (PRD layer-0h D5's
// review finding). Entity-alias tools live here so they can never inherit
// that env gate by accident.

import { z } from "zod";
import {
  archiveAlias,
  listAliasesForEntity,
  listAliasesForProject,
} from "../../library/aliases.js";
import { ensureContext } from "../context.js";
import { getEffectiveProjectIds } from "../../library/projects.js";

export const aliasesListInputSchema = {
  entityType: z.string().min(1).optional().describe("Scope to one entity (with entityId)."),
  entityId: z.string().min(1).optional(),
  includeInactive: z
    .boolean()
    .optional()
    .describe("Also return archived aliases, for audit. Default false."),
  agentName: z.string().optional(),
};

export const aliasesListInput = z.object(aliasesListInputSchema);
export type AliasesListInput = z.infer<typeof aliasesListInput>;

export interface AliasesListResult {
  aliases: Array<{
    id: string;
    entity: string;
    alias: string;
    rawAlias: string;
    factKey: string;
    isActive: boolean;
    createdAt: string;
  }>;
}

export async function aliasesList(input: AliasesListInput): Promise<AliasesListResult> {
  const ctx = await ensureContext(input.agentName);
  const projectIds = await getEffectiveProjectIds(ctx.project.id);

  const rows =
    input.entityType && input.entityId
      ? await listAliasesForEntity(input.entityType, input.entityId, "default", projectIds)
      : await listAliasesForProject("default", projectIds, input.includeInactive === true);

  // listAliasesForEntity returns active AND archived (its pre-0h audit
  // contract); apply the same includeInactive default here so both branches
  // present one consistent surface.
  const filtered =
    input.includeInactive === true ? rows : rows.filter((a) => a.isActive);

  return {
    aliases: filtered.map((a) => ({
      id: a.id,
      entity: `${a.entityType}/${a.entityId}`,
      alias: a.alias,
      rawAlias: a.rawAlias,
      factKey: a.factKey,
      isActive: a.isActive,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

export const aliasArchiveInputSchema = {
  aliasId: z.string().uuid().describe("The alias's id, from iranti_aliases_list."),
  agentName: z.string().optional(),
};

export const aliasArchiveInput = z.object(aliasArchiveInputSchema);
export type AliasArchiveInput = z.infer<typeof aliasArchiveInput>;

export interface AliasArchiveResult {
  archived: boolean;
  aliasId: string;
  reason: string;
}

export async function aliasArchive(input: AliasArchiveInput): Promise<AliasArchiveResult> {
  const ctx = await ensureContext(input.agentName);
  const projectIds = await getEffectiveProjectIds(ctx.project.id);

  // Same honest-refusal contract as iranti_archive / iranti_rule_deactivate:
  // unknown, already-archived, and out-of-scope are indistinguishable.
  const didArchive = await archiveAlias(input.aliasId, projectIds);
  return didArchive
    ? { archived: true, aliasId: input.aliasId, reason: "Archived. The nickname no longer resolves; the record is kept (never hard-deleted)." }
    : {
        archived: false,
        aliasId: input.aliasId,
        reason:
          "No active alias with that id in your project scope (unknown id, already archived, or outside this project).",
      };
}
