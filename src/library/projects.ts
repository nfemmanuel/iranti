// Project detection + registry + combine/exclude — Layer 0 (D4–D8).
//
// iranti scopes memory per PROJECT (a dedicated scope, D6 — never overloading
// tenantId) so one install can serve many folders without cross-contamination.
// Isolation is the default (D7); combine/exclude are explicit, stored, and
// reversible operations, never a one-way migration or a hard delete (G1).
//
// See docs/prds/phases/layer-0-foundation.md §11 for the full design.
//
// ─── Detection precedence (D5) ──────────────────────────────────────────────
//
//   1. git-root       — walk up from cwd for a `.git` entry (dir OR file —
//                        file happens in worktrees/submodules). Highest
//                        precedence: a subfolder deep inside a repo resolves
//                        to the SAME id as the repo root (the project is the
//                        repo, not the subfolder). The walk stops at the
//                        FIRST `.git` found, so a submodule nested inside a
//                        parent repo is its own project (conservative,
//                        isolation-favoring reading).
//   2. projects-root-child — only when no git-root is found. If a Projects
//                        root is configured (IRANTI_PROJECTS_ROOT env, else
//                        the host config file), and cwd is under it, the
//                        project id is the immediate child of the root that
//                        contains cwd. The root folder itself (no child
//                        segment) falls through to case 3.
//   3. fallback        — the normalized absolute cwd itself. Every distinct
//                        folder is already its own project with zero
//                        configuration (D8).
//
// Same input path always produces the same id (determinism, D5).

import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { and, eq, or } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  projectLinks,
  projects,
  type NewProjectLink,
  type ProjectLink,
  type ProjectRow,
} from "../db/schema.js";

// ---------------------------------------------------------------------------
// Normalization (§11.2.1) — path-based, purpose-built (NOT normalizeKey,
// which is for fact keys over a different alphabet of valid characters).
// ---------------------------------------------------------------------------

// Same physical folder always yields the same id: resolves symlinks/`..`/`.`
// via realpathSync (falling back to the un-resolved absolute path if the
// target doesn't exist yet — detection must never throw), lowercases a
// Windows drive letter (C:\ and c:\ are the same volume), converts `\` to
// `/`, and strips one trailing slash.
//
// "default" is a reserved SENTINEL, not a path — it's the schema column
// default and every function parameter's fallback value throughout the
// project-scoping surface (facts.ts, rules.ts, media.ts, graph/index.ts all
// default an omitted project to the literal string "default"). Passing it
// through the path-resolution logic below would resolve it against the
// CURRENT WORKING DIRECTORY (path.resolve("default") -> "<cwd>/default"),
// silently corrupting the one value every un-migrated / pre-Layer-0 row
// actually holds. So it is special-cased as already-canonical.
export function normalizeProjectId(absPath: string): string {
  if (absPath === "default") return absPath;
  let resolved: string;
  try {
    resolved = realpathSync(absPath);
  } catch {
    resolved = path.resolve(absPath);
  }
  let normalized = resolved.replace(/\\/g, "/");
  // Lowercase a leading Windows drive letter only (e.g. "C:/..." -> "c:/...").
  // Everything after the drive letter is left case-sensitive, since POSIX
  // filesystems (and the rest of a Windows path) are case-sensitive in
  // principle even if NTFS itself usually isn't.
  normalized = normalized.replace(/^([A-Za-z]):\//, (_m, drive: string) => `${drive.toLowerCase()}:/`);
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// git-root detection
// ---------------------------------------------------------------------------

// Walk up from `startDir` looking for a `.git` entry (directory or file —
// worktrees/submodules use a `.git` FILE containing a `gitdir:` pointer, not
// a directory). Returns the absolute path of the first directory found
// containing `.git`, or undefined if none exists up to the filesystem root.
export function findGitRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Projects-root configuration (§11.2 point 2)
// ---------------------------------------------------------------------------

export interface HostConfig {
  projectsRoot?: string;
  dataDir?: string;
}

function hostConfigPath(): string {
  return path.join(homedir(), ".iranti", "config.json");
}

// Read the host config file written by `iranti init` (src/library/setup.ts).
// Returns an empty object if the file doesn't exist or fails to parse — a
// missing/corrupt config must never crash project detection (D8: zero-config
// always works).
export async function readHostConfig(): Promise<HostConfig> {
  try {
    const raw = await readFile(hostConfigPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      return {
        projectsRoot: typeof obj["projectsRoot"] === "string" ? obj["projectsRoot"] : undefined,
        dataDir: typeof obj["dataDir"] === "string" ? obj["dataDir"] : undefined,
      };
    }
    return {};
  } catch {
    return {};
  }
}

// Resolve the configured Projects root: IRANTI_PROJECTS_ROOT env var wins
// (more explicit/ephemeral override) over the host config file's
// `projectsRoot`. Returns undefined if neither is set.
async function resolveProjectsRoot(): Promise<string | undefined> {
  const envRoot = process.env["IRANTI_PROJECTS_ROOT"];
  if (envRoot) return path.resolve(envRoot);
  const config = await readHostConfig();
  return config.projectsRoot ? path.resolve(config.projectsRoot) : undefined;
}

// If `target` is under `root` (strictly, not equal to it), return the
// immediate child of `root` that contains `target`. Otherwise undefined.
// Comparison is done on normalized ids so symlinks/case are already resolved.
function immediateChildOfRoot(root: string, target: string): string | undefined {
  const normRoot = normalizeProjectId(root);
  const normTarget = normalizeProjectId(target);
  if (normTarget === normRoot) return undefined; // the root itself, not a child
  const prefix = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;
  if (!normTarget.startsWith(prefix)) return undefined;
  const rest = normTarget.slice(prefix.length);
  const firstSegment = rest.split("/")[0];
  if (!firstSegment) return undefined;
  return normalizeProjectId(path.join(root, firstSegment));
}

// ---------------------------------------------------------------------------
// Top-level resolution (pure — no DB access, no caching)
// ---------------------------------------------------------------------------

export type ProjectSource = "git-root" | "projects-root-child" | "fallback";

export interface ResolvedProject {
  id: string;
  source: ProjectSource;
}

// Resolve the project identity for `cwd` (defaults to process.cwd()).
// Deterministic: the same cwd + the same Projects-root configuration always
// produces the same id. Pure with respect to the database — callers that
// need the registry row (get-or-create) should use ensureProjectRegistered.
export async function resolveProjectForCwd(cwd: string = process.cwd()): Promise<ResolvedProject> {
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    return { id: normalizeProjectId(gitRoot), source: "git-root" };
  }

  const projectsRoot = await resolveProjectsRoot();
  if (projectsRoot) {
    const child = immediateChildOfRoot(projectsRoot, cwd);
    if (child) return { id: child, source: "projects-root-child" };
  }

  return { id: normalizeProjectId(cwd), source: "fallback" };
}

// ---------------------------------------------------------------------------
// Registry (get-or-create) — mirrors registerAgent's shape.
// ---------------------------------------------------------------------------

export async function getOrCreateProject(resolved: ResolvedProject): Promise<ProjectRow> {
  const existing = await db.query.projects.findFirst({
    where: eq(projects.id, resolved.id),
  });
  if (existing) return existing;

  const [row] = await db
    .insert(projects)
    .values({ id: resolved.id, source: resolved.source })
    .onConflictDoNothing()
    .returning();

  // A concurrent insert could have won the race between the findFirst above
  // and this insert; onConflictDoNothing then returns no row. Re-read rather
  // than assume — this mirrors the advisory-lock-free get-or-create pattern
  // used elsewhere in the codebase for low-contention registries.
  if (row) return row;
  const raced = await db.query.projects.findFirst({ where: eq(projects.id, resolved.id) });
  // raced is guaranteed to exist: either this call's insert landed, or a
  // concurrent one did (onConflictDoNothing only no-ops on a real conflict).
  return raced!;
}

// Convenience: resolve + register in one call. This is what McpContext's
// handshake uses.
export async function resolveCurrentProject(cwd?: string): Promise<ProjectRow> {
  const resolved = await resolveProjectForCwd(cwd);
  return getOrCreateProject(resolved);
}

export async function getProjectById(id: string): Promise<ProjectRow | undefined> {
  return db.query.projects.findFirst({ where: eq(projects.id, normalizeProjectId(id)) });
}

// ---------------------------------------------------------------------------
// Exclude / include (§11.4) — reversible, never a row deletion.
// ---------------------------------------------------------------------------

// Mark a project excluded. Idempotent get-or-create: excluding a folder
// iranti has never seen before is valid (e.g. pre-configuring during
// `iranti init`), so this upserts a registry row if none exists yet, using
// "fallback" as the recorded source since the true detection source is
// unknown without visiting the folder.
export async function excludeProject(id: string): Promise<ProjectRow> {
  const normalized = normalizeProjectId(id);
  await getOrCreateProject({ id: normalized, source: "fallback" });
  const [row] = await db
    .update(projects)
    .set({ isExcluded: true })
    .where(eq(projects.id, normalized))
    .returning();
  return row!;
}

export async function includeProject(id: string): Promise<ProjectRow> {
  const normalized = normalizeProjectId(id);
  await getOrCreateProject({ id: normalized, source: "fallback" });
  const [row] = await db
    .update(projects)
    .set({ isExcluded: false })
    .where(eq(projects.id, normalized))
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// Combine / uncombine (§11.5) — explicit, stored, reversible (D7).
// ---------------------------------------------------------------------------

// Canonical pair ordering: projectA is always the lexicographically smaller
// id. Applied by every writer/reader of project_links so (A,B) and (B,A)
// never produce two different rows for the same pair.
function canonicalPair(a: string, b: string): [string, string] {
  const na = normalizeProjectId(a);
  const nb = normalizeProjectId(b);
  return na <= nb ? [na, nb] : [nb, na];
}

async function findLinkRow(a: string, b: string): Promise<ProjectLink | undefined> {
  const [x, y] = canonicalPair(a, b);
  return db.query.projectLinks.findFirst({
    where: and(eq(projectLinks.projectA, x), eq(projectLinks.projectB, y)),
  });
}

// Combine two projects: reads become shared between them (D7). Registers
// both projects if not already registered (combining a folder should not
// require having visited it first). Re-combining an already-active pair is
// a no-op; re-combining a previously-deactivated pair re-activates the
// SAME row (never a duplicate) — this is what makes reversal reversible
// without special-casing "was this ever combined before."
export async function combineProjects(a: string, b: string): Promise<ProjectLink> {
  const [x, y] = canonicalPair(a, b);
  if (x === y) {
    throw new Error(`Cannot combine a project ("${x}") with itself.`);
  }
  await getOrCreateProject({ id: x, source: "fallback" });
  await getOrCreateProject({ id: y, source: "fallback" });

  const existing = await findLinkRow(x, y);
  if (existing) {
    if (existing.isActive) return existing;
    const [reactivated] = await db
      .update(projectLinks)
      .set({ isActive: true, deactivatedAt: null })
      .where(eq(projectLinks.id, existing.id))
      .returning();
    return reactivated!;
  }

  const values: Pick<NewProjectLink, "projectA" | "projectB"> = { projectA: x, projectB: y };
  const [created] = await db.insert(projectLinks).values(values).returning();
  return created!;
}

// Reverse a combine: sets isActive = false and stamps deactivatedAt. The row
// is never deleted (G1) — history of past combines survives. A no-op
// (returns undefined) if the pair was never combined.
export async function uncombineProjects(a: string, b: string): Promise<ProjectLink | undefined> {
  const existing = await findLinkRow(a, b);
  if (!existing || !existing.isActive) return existing;
  const [updated] = await db
    .update(projectLinks)
    .set({ isActive: false, deactivatedAt: new Date() })
    .where(eq(projectLinks.id, existing.id))
    .returning();
  return updated!;
}

// List every project actively combined with `id` (both directions).
export async function getCombinedProjects(id: string): Promise<string[]> {
  const normalized = normalizeProjectId(id);
  const rows = await db.query.projectLinks.findMany({
    where: and(
      eq(projectLinks.isActive, true),
      or(eq(projectLinks.projectA, normalized), eq(projectLinks.projectB, normalized)),
    ),
  });
  return rows.map((r) => (r.projectA === normalized ? r.projectB : r.projectA));
}

// ---------------------------------------------------------------------------
// Effective project set for reads (§11.6)
// ---------------------------------------------------------------------------

// The set of project ids a read should span: the current project itself plus
// every project actively combined with it. Writes always use the single
// current project id — combine affects reads, not write attribution.
//
// An EXCLUDED project's combine links are not honored (exclude wins, §11.5):
// its effective set is itself alone, regardless of any active project_links
// row. Re-including it automatically restores the combine (no re-combine
// needed) since both flags are simply re-checked on every call.
export async function getEffectiveProjectIds(id: string): Promise<string[]> {
  const normalized = normalizeProjectId(id);
  const row = await getProjectById(normalized);
  if (row?.isExcluded) return [normalized];
  const combined = await getCombinedProjects(normalized);
  return [normalized, ...combined];
}
