// Project detection — Layer 0 (D5), deterministic unit tests.
//
// Pure filesystem-only tests: resolveProjectForCwd/findGitRoot/
// normalizeProjectId never touch the database, so this suite needs no
// PGlite/Postgres setup at all — just real temp directories on disk.
//
// Covers the mandatory gauntlet cases (PRD §11.2):
//   1. git-root case
//   2. Projects-root-child case
//   3. nested-subfolder-of-git-repo case (collapses to the repo root)
//   4. fallback case
//   5. same input -> same project id, always (determinism)

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findGitRoot,
  normalizeProjectId,
  resolveProjectForCwd,
} from "../library/projects.js";
// projects.ts imports db/connection.js transitively (for the DB-backed
// registry functions this file doesn't exercise) — close the pool so this
// otherwise DB-free suite still shuts down its connection cleanly, matching
// every other suite's convention (see entities.test.ts).
import { pool } from "../db/connection.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "iranti-detect-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  delete process.env["IRANTI_PROJECTS_ROOT"];
});

// ---------------------------------------------------------------------------
// 1. git-root case
// ---------------------------------------------------------------------------

describe("resolveProjectForCwd — git-root case", () => {
  it("resolves to the folder containing .git when cwd IS the repo root", async () => {
    const repo = path.join(scratch, "my-repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(path.join(repo, ".git")); // directory form

    const resolved = await resolveProjectForCwd(repo);

    expect(resolved.source).toBe("git-root");
    expect(resolved.id).toBe(normalizeProjectId(repo));
  });

  it("recognizes a .git FILE (worktree/submodule pointer), not just a directory", async () => {
    const repo = path.join(scratch, "worktree-repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, ".git"), "gitdir: /somewhere/else/.git/worktrees/x\n");

    const resolved = await resolveProjectForCwd(repo);

    expect(resolved.source).toBe("git-root");
    expect(resolved.id).toBe(normalizeProjectId(repo));
  });

  it("takes precedence over a configured Projects root", async () => {
    const projectsRoot = path.join(scratch, "Projects");
    const repo = path.join(projectsRoot, "some-app");
    mkdirSync(repo, { recursive: true });
    mkdirSync(path.join(repo, ".git"));
    process.env["IRANTI_PROJECTS_ROOT"] = projectsRoot;

    const resolved = await resolveProjectForCwd(repo);

    // Would be "projects-root-child" (id = repo, same value coincidentally)
    // if git-root did not win — assert the SOURCE to prove precedence, not
    // just the id (both cases happen to yield the same id here since the
    // repo is the immediate child).
    expect(resolved.source).toBe("git-root");
  });
});

// ---------------------------------------------------------------------------
// 2. Projects-root-child case
// ---------------------------------------------------------------------------

describe("resolveProjectForCwd — projects-root-child case", () => {
  it("resolves to the immediate child of the configured Projects root", async () => {
    const projectsRoot = path.join(scratch, "dev");
    const child = path.join(projectsRoot, "acme");
    const deep = path.join(child, "src", "api");
    mkdirSync(deep, { recursive: true });
    process.env["IRANTI_PROJECTS_ROOT"] = projectsRoot;

    const resolved = await resolveProjectForCwd(deep);

    expect(resolved.source).toBe("projects-root-child");
    expect(resolved.id).toBe(normalizeProjectId(child));
  });

  it("falls through to fallback when cwd IS the Projects root itself", async () => {
    const projectsRoot = path.join(scratch, "dev-root");
    mkdirSync(projectsRoot, { recursive: true });
    process.env["IRANTI_PROJECTS_ROOT"] = projectsRoot;

    const resolved = await resolveProjectForCwd(projectsRoot);

    expect(resolved.source).toBe("fallback");
    expect(resolved.id).toBe(normalizeProjectId(projectsRoot));
  });

  it("falls through to fallback when cwd is outside the configured root", async () => {
    const projectsRoot = path.join(scratch, "dev2");
    const outside = path.join(scratch, "elsewhere");
    mkdirSync(projectsRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    process.env["IRANTI_PROJECTS_ROOT"] = projectsRoot;

    const resolved = await resolveProjectForCwd(outside);

    expect(resolved.source).toBe("fallback");
    expect(resolved.id).toBe(normalizeProjectId(outside));
  });
});

// ---------------------------------------------------------------------------
// 3. nested-subfolder-of-git-repo case
// ---------------------------------------------------------------------------

describe("resolveProjectForCwd — nested subfolder of a git repo", () => {
  it("a subfolder deep inside a repo resolves to the SAME id as the repo root", async () => {
    const repo = path.join(scratch, "big-repo");
    const nested = path.join(repo, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });
    mkdirSync(path.join(repo, ".git"));

    const atRoot = await resolveProjectForCwd(repo);
    const atNested = await resolveProjectForCwd(nested);

    expect(atNested.source).toBe("git-root");
    expect(atNested.id).toBe(atRoot.id);
  });

  it("a nested submodule (its own .git) is its own project, not the parent's", async () => {
    const parent = path.join(scratch, "parent-repo");
    const submodule = path.join(parent, "vendor", "lib");
    mkdirSync(submodule, { recursive: true });
    mkdirSync(path.join(parent, ".git"));
    // Submodule's own .git is typically a FILE pointer.
    writeFileSync(path.join(submodule, ".git"), "gitdir: ../../.git/modules/lib\n");

    const parentResolved = await resolveProjectForCwd(parent);
    const submoduleResolved = await resolveProjectForCwd(submodule);

    expect(submoduleResolved.id).not.toBe(parentResolved.id);
    expect(submoduleResolved.id).toBe(normalizeProjectId(submodule));
  });
});

// ---------------------------------------------------------------------------
// 4. fallback case
// ---------------------------------------------------------------------------

describe("resolveProjectForCwd — fallback case", () => {
  it("resolves to the normalized cwd itself when no git root and no Projects root", async () => {
    const folder = path.join(scratch, "standalone");
    mkdirSync(folder, { recursive: true });

    const resolved = await resolveProjectForCwd(folder);

    expect(resolved.source).toBe("fallback");
    expect(resolved.id).toBe(normalizeProjectId(folder));
  });

  it("every distinct fallback folder is its own project", async () => {
    const a = path.join(scratch, "folder-a");
    const b = path.join(scratch, "folder-b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    const resolvedA = await resolveProjectForCwd(a);
    const resolvedB = await resolveProjectForCwd(b);

    expect(resolvedA.id).not.toBe(resolvedB.id);
  });
});

// ---------------------------------------------------------------------------
// 5. Determinism: same input -> same project id, always.
// ---------------------------------------------------------------------------

describe("resolveProjectForCwd — determinism", () => {
  it("resolving the same cwd multiple times always yields the same id (git-root)", async () => {
    const repo = path.join(scratch, "det-repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(path.join(repo, ".git"));

    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveProjectForCwd(repo)),
    );

    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
  });

  it("resolving the same cwd multiple times always yields the same id (fallback)", async () => {
    const folder = path.join(scratch, "det-fallback");
    mkdirSync(folder, { recursive: true });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveProjectForCwd(folder)),
    );

    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
  });

  it("normalizeProjectId is idempotent", () => {
    const folder = path.join(scratch, "idempotent");
    mkdirSync(folder, { recursive: true });

    const once = normalizeProjectId(folder);
    const twice = normalizeProjectId(once);

    expect(twice).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// findGitRoot — direct unit coverage
// ---------------------------------------------------------------------------

describe("findGitRoot", () => {
  it("returns undefined when no .git exists anywhere up the tree", () => {
    const folder = path.join(scratch, "no-git-here");
    mkdirSync(folder, { recursive: true });

    // scratch itself has no .git, and neither does anything above it up to
    // the OS temp root in a clean CI/dev environment — but to make this
    // robust regardless of the host machine's real filesystem layout, only
    // assert that the found root (if any) is NOT inside our scratch dir,
    // i.e. detection didn't invent a false positive within our sandbox.
    const found = findGitRoot(folder);
    if (found) {
      expect(found.startsWith(normalizeProjectId(scratch))).toBe(false);
    }
  });

  it("finds a .git several levels up", () => {
    const repo = path.join(scratch, "deep-repo");
    const deep = path.join(repo, "a", "b", "c", "d");
    mkdirSync(deep, { recursive: true });
    mkdirSync(path.join(repo, ".git"));

    const found = findGitRoot(deep);

    expect(found).toBeDefined();
    expect(normalizeProjectId(found!)).toBe(normalizeProjectId(repo));
  });
});
