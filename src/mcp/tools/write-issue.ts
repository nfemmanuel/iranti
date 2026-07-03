// iranti_write_issue — Phase 1.1
//
// Store a structured issue or to-do item. Writing the same title twice
// upserts the existing issue — same key, new status or description.
//
// Issues are stored as JSON facts with a key of "issue:<slug>", where the
// slug is derived from the title. The entity scopes the issue:
// project/my-app holds project issues, user/alice holds personal to-dos.

import { z } from "zod";
import { upsertEntity } from "../../library/entities.js";
import { VALID_SURFACES, writeFact } from "../../library/facts.js";
import { ensureContext } from "../context.js";

const ISSUE_STATUSES = ["open", "in_progress", "resolved", "wont_fix"] as const;
const ISSUE_PRIORITIES = ["low", "medium", "high", "critical"] as const;

function issueKey(title: string): string {
  return (
    "issue:" +
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
  );
}

export const writeIssueInputSchema = {
  entityType: z
    .string()
    .min(1)
    .describe("The entity this issue belongs to."),
  entityId: z.string().min(1).describe("Identifier within the type."),
  title: z
    .string()
    .min(1)
    .describe("Issue title. Determines the fact key — same title upserts."),
  description: z
    .string()
    .optional()
    .describe("Full description or reproduction steps."),
  status: z
    .enum(ISSUE_STATUSES)
    .default("open")
    .describe("open | in_progress | resolved | wont_fix"),
  priority: z
    .enum(ISSUE_PRIORITIES)
    .default("medium")
    .describe("low | medium | high | critical"),
  surface: z.enum(VALID_SURFACES).optional(),
  agentName: z.string().optional(),
};

export const writeIssueInput = z.object(writeIssueInputSchema);
export type WriteIssueInput = z.infer<typeof writeIssueInput>;

export interface WriteIssueResult {
  factId: string;
  entity: string;
  key: string;
  title: string;
  status: string;
}

export async function writeIssueTool(
  input: WriteIssueInput,
): Promise<WriteIssueResult> {
  const ctx = await ensureContext(input.agentName);

  await upsertEntity(input.entityType, input.entityId);

  const key = issueKey(input.title);
  const value = JSON.stringify({
    title: input.title,
    description: input.description ?? null,
    status: input.status,
    priority: input.priority,
  });

  const fact = await writeFact({
    entityType: input.entityType,
    entityId: input.entityId,
    key,
    value,
    source: `mcp:${ctx.agent.name}`,
    surface: input.surface,
    sessionId: ctx.session.id,
    agentId: ctx.agent.id,
    project: ctx.project.id,
  });

  return {
    factId: fact.id,
    entity: `${fact.entityType}/${fact.entityId}`,
    key: fact.key,
    title: input.title,
    status: input.status,
  };
}
