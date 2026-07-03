// Scripted multi-turn host simulation — Layer 0e (checkpoints & project-state
// rollup). Drives the REAL attend() / iranti_checkpoint / iranti_write_issue /
// getProjectState path end-to-end: real work happens, a checkpoint is
// written with stage+status, the session "ends" (module-reset restart —
// same pattern as persistence.test.ts / host-simulation.test.ts), and a NEW
// session asks "where did we leave off?" via getProjectState. Assertions are
// exact/deterministic content, not just "is defined" — this is the efficacy
// instrument for Layer 0e per the PRD (no new harness corpus dimension;
// checkpoints don't fit the transcript-probe model).
//
// Gap detection is exercised via getProjectState's injectable `now` param
// (PRD §5 Decision 4) — never a real sleep. Two separate scenarios use two
// separate data dirs (mirrors host-simulation.test.ts's single shared dir
// for scenarios that don't need isolation, but projects-isolation-style
// separate calls for the cross-project test) so PGlite's single-writer
// constraint is respected within one file (all use the SAME dir sequentially
// within one vitest file, never two dirs open concurrently).
//
// Module-load-order care: src/db/connection.ts reads IRANTI_DB_ENGINE /
// IRANTI_DATA_DIR / DATABASE_URL at IMPORT TIME — env vars are set before any
// dynamic import() of iranti internals, matching host-simulation.test.ts's
// own header comment.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "iranti-project-state-"));

beforeAll(() => {
  process.env["IRANTI_DB_ENGINE"] = "pglite";
  process.env["IRANTI_DATA_DIR"] = dataDir;
  delete process.env["DATABASE_URL"];
});

afterAll(async () => {
  // Grace period for fire-and-forget post-attend chains to settle before the
  // pool closes (RULE-2 workaround — same reasoning as host-simulation.test.ts).
  await new Promise((resolve) => setTimeout(resolve, 300));
  const { pool } = await import("../db/connection.js");
  await pool.end({ timeout: 5 }).catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Layer 0e — scripted checkpoint + project-state rollup session", () => {
  it(
    "(i)-(iv) real work -> checkpoint w/ stage+status -> restart -> rollup names " +
      "the exact checkpoint, stage, status, and recent decisions after a long gap",
    async () => {
      const { writeFact } = await import("../library/facts.js");
      const { writeCheckpoint } = await import("../library/checkpoints.js");
      const { writeIssueTool } = await import("../mcp/tools/write-issue.js");
      const { normalizeProjectId } = await import("../library/projects.js");

      const projectPath = `/fake/projects/proj-a-${randomUUID()}`;
      const project = normalizeProjectId(projectPath);
      const entityId = `proj-state-${randomUUID()}`;

      // ---- (i) real work: decisions + an open issue -----------------------
      await writeFact({
        entityType: "project",
        entityId,
        key: "decision:use-postgres",
        value: "We decided to use Postgres for the primary store.",
        source: "test",
        project,
      });
      // A second decision, written later, so recency ordering is verifiable.
      await new Promise((r) => setTimeout(r, 5));
      await writeFact({
        entityType: "project",
        entityId,
        key: "decision:defer-caching",
        value: "We decided to defer the caching layer to a later phase.",
        source: "test",
        project,
      });

      // Issue tools go through ensureContext(), which resolves the project
      // from process.cwd() — NOT the explicit `project` used above for
      // writeFact. To keep this scenario single-project and deterministic,
      // write the issue fact directly via writeFact with the same explicit
      // project, using the exact key/value shape iranti_write_issue produces
      // (see write-issue.ts's issueKey()/value shape) so getProjectState's
      // issue-parsing path is exercised identically to the real tool.
      await writeFact({
        entityType: "project",
        entityId,
        key: "issue:ship-the-rollup",
        value: JSON.stringify({
          title: "Ship the rollup",
          description: "Land the project-state rollup.",
          status: "in_progress",
          priority: "high",
        }),
        source: "test",
        project,
      });

      // ---- (ii) checkpoint with stage + status -----------------------------
      await writeCheckpoint(
        "project",
        entityId,
        "Implemented getProjectState; writing the efficacy suite next.",
        { source: "test", project, stage: "in_progress", status: "writing tests" },
      );

      // Sanity: writeIssueTool itself still upserts correctly through the
      // normal MCP path (exercised for realism, on the ensureContext-resolved
      // project — not asserted against the project-scoped rollup below).
      const issueToolResult = await writeIssueTool({
        entityType: "project",
        entityId: `${entityId}-mcp-path`,
        title: "MCP path sanity",
        status: "open",
        priority: "low",
      });
      expect(issueToolResult.key).toBe("issue:mcp-path-sanity");

      // ---- (iii) 'end the session' — module reset = restart ----------------
      await new Promise((resolve) => setTimeout(resolve, 300));
      const conn1 = await import("../db/connection.js");
      await conn1.closeDb();
      vi.resetModules();

      // ---- (iv) NEW session asks "where did we leave off?" -----------------
      const { getProjectState: getProjectState2 } = await import(
        "../library/project-state.js"
      );
      const { normalizeProjectId: normalizeProjectId2 } = await import(
        "../library/projects.js"
      );
      const project2 = normalizeProjectId2(projectPath);

      // A long gap: "now" is injected far in the future rather than sleeping —
      // deterministic, no wall-clock dependency (PRD Decision 4).
      const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // +30 days
      const rollup = await getProjectState2(project2, { now: farFuture });

      expect(rollup.hasActivity).toBe(true);
      expect(rollup.latestCheckpoint).not.toBeNull();
      expect(rollup.latestCheckpoint?.text).toBe(
        "Implemented getProjectState; writing the efficacy suite next.",
      );
      expect(rollup.latestCheckpoint?.stage).toBe("in_progress");
      expect(rollup.latestCheckpoint?.status).toBe("writing tests");

      // Recent decisions: newest first, exact values.
      expect(rollup.recentDecisions.map((d) => d.value)).toEqual([
        "We decided to defer the caching layer to a later phase.",
        "We decided to use Postgres for the primary store.",
      ]);

      // Open items: the in_progress issue is present.
      expect(rollup.openItems.some((i) => i.title === "Ship the rollup")).toBe(
        true,
      );

      // Long gap is correctly flagged (30 days >> the 4h default threshold).
      expect(rollup.isLongGap).toBe(true);
      expect(rollup.gapMs).not.toBeNull();
      expect(rollup.gapMs!).toBeGreaterThan(1000 * 60 * 60 * 4);

      // A query with "now" close to last activity must NOT flag a long gap —
      // proves isLongGap is a real computed threshold, not always-true.
      const noGapRollup = await getProjectState2(project2, {
        now: new Date(Date.now() + 1000), // 1 second after "now" at write time
      });
      expect(noGapRollup.isLongGap).toBe(false);

      const conn2 = await import("../db/connection.js");
      await conn2.closeDb();
    },
    30_000,
  );

  it("(v) cross-project: project B's rollup never contains project A's checkpoints, decisions, or issues", async () => {
    // The previous test closed its connection after its own module-reset
    // "restart" — force a fresh module graph (and thus a fresh, open
    // connection) rather than reusing the now-closed one.
    vi.resetModules();
    const { writeFact } = await import("../library/facts.js");
    const { writeCheckpoint } = await import("../library/checkpoints.js");
    const { getProjectState } = await import("../library/project-state.js");

    const projectA = `/fake/projects/iso-a-${randomUUID()}`;
    const projectB = `/fake/projects/iso-b-${randomUUID()}`;
    const entityId = "shared-entity-name"; // deliberately colliding entity id

    await writeCheckpoint("project", entityId, "PROJECT-A-SECRET checkpoint text", {
      source: "test",
      project: projectA,
      stage: "blocked",
      status: "waiting on legal review",
    });
    await writeFact({
      entityType: "project",
      entityId,
      key: "decision:project-a-secret-decision",
      value: "PROJECT-A-SECRET decision value.",
      source: "test",
      project: projectA,
    });
    await writeFact({
      entityType: "project",
      entityId,
      key: "issue:project-a-secret-issue",
      value: JSON.stringify({
        title: "PROJECT-A-SECRET issue",
        description: null,
        status: "open",
        priority: "high",
      }),
      source: "test",
      project: projectA,
    });

    // Project B has never seen any of this — same colliding entity id.
    const rollupB = await getProjectState(projectB);
    expect(rollupB.hasActivity).toBe(false);
    expect(rollupB.latestCheckpoint).toBeNull();
    expect(rollupB.recentDecisions).toEqual([]);
    expect(rollupB.openItems).toEqual([]);
    expect(JSON.stringify(rollupB)).not.toContain("PROJECT-A-SECRET");

    // Sanity: project A DOES see its own state — proves the empty result
    // above is isolation, not a broken rollup.
    const rollupA = await getProjectState(projectA);
    expect(rollupA.hasActivity).toBe(true);
    expect(rollupA.latestCheckpoint?.text).toBe("PROJECT-A-SECRET checkpoint text");
    expect(rollupA.latestCheckpoint?.stage).toBe("blocked");
    expect(
      rollupA.recentDecisions.some((d) => d.value.includes("PROJECT-A-SECRET")),
    ).toBe(true);
    expect(rollupA.openItems.some((i) => i.title.includes("PROJECT-A-SECRET"))).toBe(
      true,
    );
  });

  it("(vi) empty project -> clean 'no state yet' answer, not an error", async () => {
    // Same reasoning as (v) above: ensure a fresh, open connection.
    vi.resetModules();
    const { getProjectState } = await import("../library/project-state.js");

    const emptyProject = `/fake/projects/never-touched-${randomUUID()}`;
    const rollup = await getProjectState(emptyProject);

    expect(rollup).toEqual({
      hasActivity: false,
      latestCheckpoint: null,
      recentDecisions: [],
      openItems: [],
      lastActivityAt: null,
      gapMs: null,
      isLongGap: false,
    });
  });

  it("attend() surfaces projectState only on the first attend of a process, and only past the gap threshold", async () => {
    process.env["IRANTI_PROJECT_STATE_GAP_MS"] = "1"; // 1ms — any elapsed time is "long"
    vi.resetModules();

    const { attend } = await import("../mcp/tools/attend.js");
    const { writeCheckpoint } = await import("../library/checkpoints.js");
    const { resolveCurrentProject } = await import("../library/projects.js");

    // attend() resolves its project from process.cwd() via ensureContext() —
    // write the checkpoint into that SAME real project (not the "default"
    // fallback writeCheckpoint would otherwise use) so attend()'s rollup
    // query actually finds it.
    const currentProject = await resolveCurrentProject();

    // Give the checkpoint a moment of age so its updatedAt is safely in the
    // past relative to "now" inside attend() — avoids a flaky 0ms gap race
    // against a 1ms threshold.
    const entityId = `attend-surface-${randomUUID()}`;
    await writeCheckpoint("project", entityId, "Surfacing check.", {
      source: "test",
      project: currentProject.id,
      stage: "planning",
    });
    await new Promise((r) => setTimeout(r, 20));

    const first = await attend({
      entityHints: [{ entityType: "project", entityId }],
      message: "Reorienting after a long gap.",
    });
    expect(first.projectState).not.toBeNull();
    expect(first.projectState?.latestCheckpoint?.text).toBe("Surfacing check.");

    // A second attend in the SAME process must NOT re-surface it — the
    // "first attend only" latch must hold even though the gap is still long.
    const second = await attend({
      entityHints: [{ entityType: "project", entityId }],
      message: "A completely unrelated later turn.",
    });
    expect(second.projectState).toBeNull();

    delete process.env["IRANTI_PROJECT_STATE_GAP_MS"];

    await new Promise((resolve) => setTimeout(resolve, 300));
    const conn = await import("../db/connection.js");
    await conn.closeDb();
    vi.resetModules();
  }, 20_000);
});
