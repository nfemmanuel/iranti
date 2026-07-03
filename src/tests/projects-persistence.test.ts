// Layer 0 — project-scope config survives a restart (close + fresh boot on
// the same data dir). Mirrors src/tests/persistence.test.ts's module-reset
// technique exactly, applied to the projects registry / combine links /
// exclude flag instead of a fact.

import { describe, expect, it, vi, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

let dataDir: string;

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe("persistence across restarts — project registry, combine, exclude", () => {
  it("a registered project, an active combine link, and an exclude flag all survive a fresh boot on the same data dir", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "iranti-proj-persist-"));
    process.env["IRANTI_DB_ENGINE"] = "pglite";
    process.env["IRANTI_DATA_DIR"] = dataDir;
    delete process.env["DATABASE_URL"];

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;
    const projectC = `/fake/projects/${randomUUID()}`;

    // ---- boot 1: fresh dir -> auto-migrate -> register + combine + exclude ----
    const projects1 = await import("../library/projects.js");
    await projects1.getOrCreateProject({ id: projectA, source: "fallback" });
    await projects1.combineProjects(projectA, projectB);
    await projects1.excludeProject(projectC);

    const conn1 = await import("../db/connection.js");
    await conn1.closeDb();

    // ---- "restart": reset the module graph so connection re-initializes ----
    vi.resetModules();

    // ---- boot 2: same dir -> auto-migrate must NO-OP -> state survives ----
    const projects2 = await import("../library/projects.js");

    const registeredA = await projects2.getProjectById(projectA);
    expect(registeredA).toBeDefined();
    expect(registeredA?.id).toBe(projects2.normalizeProjectId(projectA));

    const effectiveForB = await projects2.getEffectiveProjectIds(projectB);
    expect(effectiveForB).toContain(projects2.normalizeProjectId(projectA));

    const excludedC = await projects2.getProjectById(projectC);
    expect(excludedC?.isExcluded).toBe(true);

    const conn2 = await import("../db/connection.js");
    await conn2.closeDb();
  }, 60_000);
});
