// iranti_write_rule — Phase 1
//
// Store a behavioral rule. Rules are additive (no upsert) and never decay.
// iranti_attend injects them on every call for the entities in scope, which
// is what converges all AI hosts toward the same behavior.

import { z } from "zod";
import { upsertEntity } from "../../library/entities.js";
import { writeRule } from "../../library/rules.js";
import { ensureContext } from "../context.js";

export const writeRuleInputSchema = {
  entityType: z
    .string()
    .min(1)
    .describe(
      "Scoping tier: 'system' (always injected), 'user', or 'project'.",
    ),
  entityId: z
    .string()
    .min(1)
    .describe("'global' for system rules, otherwise the user/project id."),
  text: z
    .string()
    .min(1)
    .describe("The rule as a full plain-language sentence the agent reads."),
  priority: z
    .number()
    .int()
    .default(0)
    .describe(
      "Injection order, higher first. 100+ critical, 50-99 strong, " +
        "1-49 soft, 0 default.",
    ),
  agentName: z.string().optional(),
};

export const writeRuleInput = z.object(writeRuleInputSchema);
export type WriteRuleInput = z.infer<typeof writeRuleInput>;

export interface WriteRuleResult {
  ruleId: string;
  entity: string;
  priority: number;
}

export async function writeRuleTool(
  input: WriteRuleInput,
): Promise<WriteRuleResult> {
  const ctx = await ensureContext(input.agentName);

  await upsertEntity(input.entityType, input.entityId);

  const rule = await writeRule({
    entityType: input.entityType,
    entityId: input.entityId,
    text: input.text,
    priority: input.priority,
    source: `mcp:${ctx.agent.name}`,
    sessionId: ctx.session.id,
    agentId: ctx.agent.id,
    project: ctx.project.id,
  });

  return {
    ruleId: rule.id,
    entity: `${rule.entityType}/${rule.entityId}`,
    priority: rule.priority,
  };
}
