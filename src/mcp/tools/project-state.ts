// iranti_project_state — Layer 0e
//
// "Where did we leave off?" for the current project: the latest checkpoint
// (with stage/status), recent decisions, open items, and a deterministic
// gap-since-last-activity flag. Read-only, no side effects.
//
// The project is ALWAYS the server's resolved current project (ctx.project.id)
// — never caller-suppliable — matching iranti_project_status's pattern
// (src/mcp/tools/project.ts). Accepting a project id as input would let one
// caller probe another project's rollup by guessing/brute-forcing ids; the
// only trusted source of "which project" is the server's own cwd-derived
// handshake.
//
// Uses the same effective-project-set helper (getEffectiveProjectIds) that
// iranti_attend uses for its read side — reads span the current project plus
// anything actively combined with it, exactly like every other retrieval
// path in the codebase. No new isolation mechanism.

import { z } from "zod";
import { getProjectState, type ProjectStateSummary } from "../../library/project-state.js";
import { getEffectiveProjectIds } from "../../library/projects.js";
import { ensureContext } from "../context.js";

export const projectStateInputSchema = {
  agentName: z.string().optional(),
};

export const projectStateInput = z.object(projectStateInputSchema);
export type ProjectStateInput = z.infer<typeof projectStateInput>;

export type ProjectStateResult = ProjectStateSummary;

export async function projectStateTool(
  input: ProjectStateInput,
): Promise<ProjectStateResult> {
  const ctx = await ensureContext(input.agentName);
  const effectiveProjectIds = await getEffectiveProjectIds(ctx.project.id);
  return getProjectState(effectiveProjectIds);
}
