// Scripted multi-turn host simulation — Layer 0d (rules & preferences
// enforcement). Drives the REAL attend() / iranti_write_rule path end-to-end,
// simulating what an actual MCP host does across a session: write a rule,
// then attend() on a sequence of turns and observe whether the rule is
// injected (rules[]) exactly when situationally relevant.
//
// This is deliberately NOT a set of isolated unit assertions on
// getRulesForAttend — it is a scripted conversation, turn by turn, through
// the same attend()/writeRuleTool functions the MCP server itself calls, so
// "proof by measurement and scripted simulation" (the overnight mandate's
// bar) is met at the same altitude a real host operates at.
//
// Module-load-order care: src/db/connection.ts reads IRANTI_DB_ENGINE /
// IRANTI_DATA_DIR / DATABASE_URL at IMPORT TIME (see it-runs.test.ts's header
// comment for the full explanation) — env vars are set before any dynamic
// import() of iranti internals, and the restart scenario (v) uses
// vi.resetModules() exactly like persistence.test.ts.
//
// Scenario (iv), cross-project isolation, calls the library functions
// (writeRule / getRulesForAttend) with EXPLICIT project ids rather than
// through attend()'s memoized per-process project — same rationale as
// projects-isolation.test.ts's own header comment: ensureContext() resolves
// the project ONCE per process from process.cwd(), so simulating two
// different "projects" side by side within one test process requires
// bypassing that cache and driving the isolation mechanism directly.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "iranti-host-sim-"));

beforeAll(() => {
  process.env["IRANTI_DB_ENGINE"] = "pglite";
  process.env["IRANTI_DATA_DIR"] = dataDir;
  delete process.env["DATABASE_URL"];
});

afterAll(async () => {
  // Grace period for fire-and-forget post-attend chains to settle before the
  // pool closes (same reasoning as it-runs.test.ts / harness/ingest.ts).
  await new Promise((resolve) => setTimeout(resolve, 250));
  const { pool } = await import("../db/connection.js");
  await pool.end({ timeout: 5 }).catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Layer 0d — scripted multi-turn host session", () => {
  it(
    "(i) write -> relevant situation surfaces the rule, ranked within budget; " +
      "(ii) unrelated situation -> not injected; " +
      "(iii) deactivated -> no longer injected",
    async () => {
      const { writeRuleTool } = await import("../mcp/tools/write-rule.js");
      const { attend } = await import("../mcp/tools/attend.js");
      const { deactivateRule } = await import("../library/rules.js");

      const entityId = `host-sim-project-${randomUUID()}`;

      // Turn 1 (host side): the user states a standing preference; the host
      // calls iranti_write_rule exactly as the MCP tool surface does.
      const written = await writeRuleTool({
        entityType: "project",
        entityId,
        text: "Never use SELECT * in the reporting queries, the table has 40 columns and it's slow.",
        priority: 10,
      });
      expect(written.ruleId).toBeDefined();

      // Turn 2: a LATER, unrelated turn in the same session. The rule must
      // NOT be injected — this is the "not dumped every turn" bar.
      const unrelatedTurn = await attend({
        entityHints: [{ entityType: "project", entityId }],
        message: "What's our Redis eviction policy for the session cache?",
      });
      expect(unrelatedTurn.rules.some((r) => r.text.includes("SELECT *"))).toBe(false);

      // Turn 3: a situation where the rule DOES apply. Must surface, and
      // (trivially, since only one rule exists here) within budget.
      const relevantTurn = await attend({
        entityHints: [{ entityType: "project", entityId }],
        message: "I need to write a reporting query — can I just SELECT * for speed?",
      });
      const injected = relevantTurn.rules.find((r) => r.text.includes("SELECT *"));
      expect(injected).toBeDefined();
      expect(relevantTurn.rules.length).toBeLessThanOrEqual(5); // MAX_RULES_PER_ATTEND

      // Turn 4: deactivate the rule (the only correction path — see PRD D9).
      await deactivateRule(written.ruleId);

      // Turn 5: the SAME relevant situation as turn 3. The deactivated rule
      // must no longer be injected, even though the message still matches it
      // on pure keyword overlap — isActive is checked before relevance.
      const afterDeactivate = await attend({
        entityHints: [{ entityType: "project", entityId }],
        message: "I need to write a reporting query — can I just SELECT * for speed?",
      });
      expect(afterDeactivate.rules.some((r) => r.text.includes("SELECT *"))).toBe(false);
    },
  );

  it("(iv) cross-project: a rule written in project A never fires when attending in project B", async () => {
    const { writeRule } = await import("../library/rules.js");
    const { getRulesForAttend } = await import("../library/rules.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;
    const entityId = "shared-entity-name"; // deliberately colliding entity id

    await writeRule({
      entityType: "project",
      entityId,
      text: "PROJECT-A-SECRET: never use SELECT * in the reporting queries.",
      source: "test",
      priority: 10,
      project: projectA,
    });

    // Same message, same entity id, only the project differs. If isolation
    // were broken, project B would see the rule (situationally relevant
    // message, matching entity) — this must come back empty regardless.
    const rulesInB = await getRulesForAttend(
      [{ entityType: "project", entityId }],
      "default",
      projectB,
      "Can I just SELECT * from the reporting table?",
    );
    expect(rulesInB.some((r) => r.text.includes("PROJECT-A-SECRET"))).toBe(false);

    // Sanity: the same lookup scoped to project A DOES find it — proves the
    // negative result above is isolation, not a broken relevance filter.
    const rulesInA = await getRulesForAttend(
      [{ entityType: "project", entityId }],
      "default",
      projectA,
      "Can I just SELECT * from the reporting table?",
    );
    expect(rulesInA.some((r) => r.text.includes("PROJECT-A-SECRET"))).toBe(true);
  });

  it("(v) restart persistence: a rule written before 'restart' is still enforced (situationally) after a fresh boot", async () => {
    const entityId = `host-sim-restart-${randomUUID()}`;

    // ---- boot 1: write the rule, confirm it fires pre-restart ----
    const { writeRuleTool: writeRuleTool1 } = await import("../mcp/tools/write-rule.js");
    const { attend: attend1 } = await import("../mcp/tools/attend.js");

    await writeRuleTool1({
      entityType: "project",
      entityId,
      text: "Always add an aria-label to icon-only buttons.",
      priority: 10,
    });

    const beforeRestart = await attend1({
      entityHints: [{ entityType: "project", entityId }],
      message: "Do icon-only buttons need any accessibility markup?",
    });
    expect(beforeRestart.rules.some((r) => r.text.includes("aria-label"))).toBe(true);

    // Grace period for attend()'s fire-and-forget post-response chain (edge
    // recording, extraction, attend-log write — see mcp/tools/attend.ts) to
    // settle before closing the connection. Without this, closeDb() races
    // that in-flight work: PGlite is single-connection, so a query still
    // queued when close() tears down the connection can leave that query's
    // promise pending forever rather than rejecting cleanly — hanging the
    // process instead of erroring (same reasoning as harness/ingest.ts's and
    // projects-isolation.test.ts's identical grace period before their own
    // pool.end() calls).
    await new Promise((resolve) => setTimeout(resolve, 300));

    const conn1 = await import("../db/connection.js");
    await conn1.closeDb();

    // ---- "restart": reset the module graph so connection + context re-init ----
    vi.resetModules();

    // ---- boot 2: same data dir -> rule survives -> still enforced situationally ----
    const { attend: attend2 } = await import("../mcp/tools/attend.js");

    const afterRestartRelevant = await attend2({
      entityHints: [{ entityType: "project", entityId }],
      message: "Building an icon-only button, does it need anything special?",
    });
    expect(afterRestartRelevant.rules.some((r) => r.text.includes("aria-label"))).toBe(true);

    // And the situational gate still holds post-restart — an unrelated turn
    // still does not get the rule dumped on it.
    const afterRestartUnrelated = await attend2({
      entityHints: [{ entityType: "project", entityId }],
      message: "What's the tablet breakpoint again?",
    });
    expect(afterRestartUnrelated.rules.some((r) => r.text.includes("aria-label"))).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const conn2 = await import("../db/connection.js");
    await conn2.closeDb();
  }, 30_000);
});
