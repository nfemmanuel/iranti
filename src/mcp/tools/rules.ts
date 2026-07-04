// iranti_rules_list / iranti_rule_deactivate — Layer 0h
//
// The rule correctability surface. Rules are additive and never decay
// (writing twice creates two rules), so without these tools a mistaken or
// stale rule fires on every relevant turn forever with no recourse — the
// dogfood eval's check 6 could not run its deactivate leg at all. The list
// tool answers "what is governing me right now?" and carries the ids the
// attend response deliberately omits; deactivation is project-boundary-
// checked with archive.ts's exact honest-refusal posture (unknown id and
// out-of-scope id are indistinguishable).

import { z } from "zod";
import { deactivateRule, listRulesForProject } from "../../library/rules.js";
import { ensureContext } from "../context.js";
import { getEffectiveProjectIds } from "../../library/projects.js";

export const rulesListInputSchema = {
  includeInactive: z
    .boolean()
    .optional()
    .describe("Also return deactivated rules, for audit. Default false."),
  agentName: z.string().optional(),
};

export const rulesListInput = z.object(rulesListInputSchema);
export type RulesListInput = z.infer<typeof rulesListInput>;

export interface RulesListResult {
  rules: Array<{
    id: string;
    entity: string;
    text: string;
    priority: number;
    isActive: boolean;
    // The rules table carries no updatedAt — createdAt plus the isActive
    // flag is the full lifecycle story (see PRD 0h §9: no rules history).
    createdAt: string;
  }>;
}

export async function rulesList(input: RulesListInput): Promise<RulesListResult> {
  const ctx = await ensureContext(input.agentName);
  const projectIds = await getEffectiveProjectIds(ctx.project.id);

  const rules = await listRulesForProject("default", projectIds, input.includeInactive === true);
  return {
    rules: rules.map((r) => ({
      id: r.id,
      entity: `${r.entityType}/${r.entityId}`,
      text: r.text,
      priority: r.priority,
      isActive: r.isActive,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export const ruleDeactivateInputSchema = {
  ruleId: z.string().uuid().describe("The rule's id, from iranti_rules_list."),
  agentName: z.string().optional(),
};

export const ruleDeactivateInput = z.object(ruleDeactivateInputSchema);
export type RuleDeactivateInput = z.infer<typeof ruleDeactivateInput>;

export interface RuleDeactivateResult {
  deactivated: boolean;
  ruleId: string;
  reason: string;
}

export async function ruleDeactivate(
  input: RuleDeactivateInput,
): Promise<RuleDeactivateResult> {
  const ctx = await ensureContext(input.agentName);
  const projectIds = await getEffectiveProjectIds(ctx.project.id);

  // Effective project ids passed so a ruleId from another project (or an
  // unknown/already-inactive id) reports deactivated:false instead of
  // blindly claiming success — the write-side twin of the Layer 0 history
  // factId leak, applied to rules. Not-found and out-of-scope are
  // deliberately indistinguishable.
  const didDeactivate = await deactivateRule(input.ruleId, "default", projectIds);
  return didDeactivate
    ? { deactivated: true, ruleId: input.ruleId, reason: "Deactivated. The rule row is kept (never hard-deleted) and can be reactivated at the database level." }
    : {
        deactivated: false,
        ruleId: input.ruleId,
        reason:
          "No active rule with that id in your project scope (unknown id, already inactive, or outside this project).",
      };
}
