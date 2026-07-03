// iranti_project_combine / iranti_project_exclude / iranti_project_include /
// iranti_project_status — Layer 0 (D7/D8).
//
// The explicit, stored, reversible controls over the folder-scoped project
// model (docs/prds/phases/layer-0-foundation.md §11.5/§11.6). Isolation is
// the default; these tools are how a user opts INTO cross-project sharing
// (combine) or OUT of tracking a folder (exclude) — both are reversible,
// never a hard delete (G1).
//
// Every input here accepts a project id as a raw path string (NOT
// necessarily normalized by the caller) — src/library/projects.ts's
// normalizeProjectId is applied internally by combineProjects/
// uncombineProjects/excludeProject/includeProject, so "C:\Users\nf\dev\a"
// and "c:/users/nf/dev/a" resolve to the same project.

import { z } from "zod";
import { ensureContext } from "../context.js";
import {
  combineProjects,
  excludeProject,
  getCombinedProjects,
  getProjectById,
  includeProject,
  uncombineProjects,
} from "../../library/projects.js";

// ---------------------------------------------------------------------------
// iranti_project_status — read-only, no side effects.
// ---------------------------------------------------------------------------

export const projectStatusInputSchema = {
  agentName: z.string().optional(),
};
export const projectStatusInput = z.object(projectStatusInputSchema);
export type ProjectStatusInput = z.infer<typeof projectStatusInput>;

export interface ProjectStatusResult {
  project: string;
  source: string;
  isExcluded: boolean;
  combinedWith: string[];
}

export async function projectStatus(
  input: ProjectStatusInput,
): Promise<ProjectStatusResult> {
  const ctx = await ensureContext(input.agentName);
  const combinedWith = await getCombinedProjects(ctx.project.id);
  return {
    project: ctx.project.id,
    source: ctx.project.source,
    isExcluded: ctx.project.isExcluded,
    combinedWith,
  };
}

// ---------------------------------------------------------------------------
// iranti_project_combine — explicit, stored, reversible (D7).
// ---------------------------------------------------------------------------

export const projectCombineInputSchema = {
  withProject: z
    .string()
    .min(1)
    .describe(
      "The other project's folder path to combine memory with. The current " +
        "project (this server's cwd) is always one side of the combine.",
    ),
  agentName: z.string().optional(),
};
export const projectCombineInput = z.object(projectCombineInputSchema);
export type ProjectCombineInput = z.infer<typeof projectCombineInput>;

export interface ProjectCombineResult {
  combined: [string, string];
  isActive: boolean;
  reason: string;
}

export async function projectCombine(
  input: ProjectCombineInput,
): Promise<ProjectCombineResult> {
  const ctx = await ensureContext(input.agentName);
  const link = await combineProjects(ctx.project.id, input.withProject);
  return {
    combined: [link.projectA, link.projectB],
    isActive: link.isActive,
    reason:
      "Reads in either project now span both. Reversible via " +
      "iranti_project_uncombine. Writes still land only in the project " +
      "you're actually in.",
  };
}

// ---------------------------------------------------------------------------
// iranti_project_uncombine — reverses a combine (D7: never a hard delete).
// ---------------------------------------------------------------------------

export const projectUncombineInputSchema = {
  withProject: z
    .string()
    .min(1)
    .describe("The project to stop sharing memory with."),
  agentName: z.string().optional(),
};
export const projectUncombineInput = z.object(projectUncombineInputSchema);
export type ProjectUncombineInput = z.infer<typeof projectUncombineInput>;

export interface ProjectUncombineResult {
  uncombined: boolean;
  reason: string;
}

export async function projectUncombine(
  input: ProjectUncombineInput,
): Promise<ProjectUncombineResult> {
  const ctx = await ensureContext(input.agentName);
  const link = await uncombineProjects(ctx.project.id, input.withProject);
  if (!link) {
    return {
      uncombined: false,
      reason: "These two projects were never combined.",
    };
  }
  return {
    uncombined: true,
    reason:
      "Isolation restored between these two projects. The combine record " +
      "is kept (not deleted) — re-combining reactivates it.",
  };
}

// ---------------------------------------------------------------------------
// iranti_project_exclude / iranti_project_include — reversible (D7/G1).
// ---------------------------------------------------------------------------

export const projectExcludeInputSchema = {
  project: z
    .string()
    .optional()
    .describe(
      "The project folder to exclude. Defaults to the current project " +
        "(this server's cwd) if omitted.",
    ),
  agentName: z.string().optional(),
};
export const projectExcludeInput = z.object(projectExcludeInputSchema);
export type ProjectExcludeInput = z.infer<typeof projectExcludeInput>;

export interface ProjectExcludeResult {
  project: string;
  isExcluded: boolean;
}

export async function projectExclude(
  input: ProjectExcludeInput,
): Promise<ProjectExcludeResult> {
  const ctx = await ensureContext(input.agentName);
  const target = input.project ?? ctx.project.id;
  const row = await excludeProject(target);
  return { project: row.id, isExcluded: row.isExcluded };
}

export const projectIncludeInputSchema = {
  project: z
    .string()
    .optional()
    .describe(
      "The project folder to re-include. Defaults to the current project " +
        "(this server's cwd) if omitted.",
    ),
  agentName: z.string().optional(),
};
export const projectIncludeInput = z.object(projectIncludeInputSchema);
export type ProjectIncludeInput = z.infer<typeof projectIncludeInput>;

export interface ProjectIncludeResult {
  project: string;
  isExcluded: boolean;
}

export async function projectInclude(
  input: ProjectIncludeInput,
): Promise<ProjectIncludeResult> {
  const ctx = await ensureContext(input.agentName);
  const target = input.project ?? ctx.project.id;
  const row = await includeProject(target);
  return { project: row.id, isExcluded: row.isExcluded };
}

// Re-exported for tests/tooling that want the raw registry row without
// going through the MCP handshake (e.g. inspecting a project that isn't
// the current one).
export { getProjectById };
