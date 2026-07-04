// Layer 0i — correction supersession.
//
// The dogfood incident (checks 8/10): a conversational correction stored
// under correction:<subject> left the stale decision fact live — both came
// back matched:true, and the project-state rollup surfaced only the stale
// one. These tests replay that incident through the REAL attend() path and
// pin the matcher's precision guarantees (ambiguity → no-op, no-candidate
// → no-op, never crosses entity/project, never touches artifacts).

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import { attend } from "../mcp/tools/attend.js";
import {
  applyCorrectionSupersession,
  findFact,
  getFactHistoryByKey,
  writeFact,
} from "../library/facts.js";
import { getProjectState } from "../library/project-state.js";
import { resolveCurrentProject } from "../library/projects.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

const SETTLE_MS = 400;

describe("correction supersession — the dogfood incident, replayed through attend()", () => {
  it("the correction archives the stale decision; history preserves it; one answer remains", async () => {
    const entityId = randomUUID();
    const project = (await resolveCurrentProject()).id;

    await attend({
      entityHints: [{ entityType: "project", entityId }],
      message: "we're using dogfood/report as the eval branch name.",
      phase: "pre-response",
    });
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const stale = await findFact(
      "project", entityId, "decision:dogfood-report-as-the-eval-branch-name",
      "default", project,
    );
    expect(stale).toBeDefined();

    await attend({
      entityHints: [{ entityType: "project", entityId }],
      message: "Actually, the eval branch name should be dogfood/report-1, not dogfood/report.",
      phase: "pre-response",
    });
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    // The stale decision is archived — no longer a live fact…
    const staleAfter = await findFact(
      "project", entityId, "decision:dogfood-report-as-the-eval-branch-name",
      "default", project,
    );
    expect(staleAfter).toBeUndefined();

    // …its past is preserved with the dedicated reason (never-hard-delete)…
    const history = await getFactHistoryByKey(
      "project", entityId, "decision:dogfood-report-as-the-eval-branch-name",
      "default", project,
    );
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]!.archivedReason).toBe("superseded_by_correction");
    expect(history[0]!.value).toContain("dogfood/report");

    // …and the correction is the one live answer.
    const correction = await findFact(
      "project", entityId, "correction:the-eval-branch-name", "default", project,
    );
    expect(correction).toBeDefined();
    expect(correction!.value).toContain("dogfood/report-1");
  });
});

describe("applyCorrectionSupersession — precision guarantees", () => {
  it("ambiguity: two containment candidates → neither archived", async () => {
    const entityId = randomUUID();
    const project = `proj-${randomUUID()}`;
    await writeFact({
      entityType: "project", entityId, key: "decision:the-retry-limit-for-api-calls",
      value: "retry limit is 3 for api calls", source: "test", project,
    });
    await writeFact({
      entityType: "project", entityId, key: "constraint:the-retry-limit-must-stay-low",
      value: "retry limit must stay low", source: "test", project,
    });

    const result = await applyCorrectionSupersession(
      "project", entityId, "correction:the-retry-limit", "default", project,
    );
    expect(result.supersededFactId).toBeNull();
    expect(result.candidateCount).toBe(2);

    expect(await findFact("project", entityId, "decision:the-retry-limit-for-api-calls", "default", project)).toBeDefined();
    expect(await findFact("project", entityId, "constraint:the-retry-limit-must-stay-low", "default", project)).toBeDefined();
  });

  it("no candidate → no-op (the correction stands alone)", async () => {
    const entityId = randomUUID();
    const project = `proj-${randomUUID()}`;
    const result = await applyCorrectionSupersession(
      "project", entityId, "correction:the-cache-eviction-window", "default", project,
    );
    expect(result.supersededFactId).toBeNull();
    expect(result.candidateCount).toBe(0);
  });

  it("never matches artifacts, checkpoints, or other corrections", async () => {
    const entityId = randomUUID();
    const project = `proj-${randomUUID()}`;
    // An artifact fact whose key would token-contain the subject.
    await writeFact({
      entityType: "project", entityId, key: "shared-url:deadbeef1234",
      value: "https://example.com/the-deploy-window", source: "test", project,
    });
    await writeFact({
      entityType: "project", entityId, key: "correction:the-deploy-window-earlier",
      value: "the deploy window earlier statement", source: "test", project,
    });

    const result = await applyCorrectionSupersession(
      "project", entityId, "correction:the-deploy-window", "default", project,
    );
    // Neither the artifact nor the sibling correction is a candidate.
    expect(result.candidateCount).toBe(0);
  });

  it("never crosses entity or project boundaries", async () => {
    const project = `proj-${randomUUID()}`;
    const otherProject = `proj-${randomUUID()}`;
    const entityA = randomUUID();
    const entityB = randomUUID();
    await writeFact({
      entityType: "project", entityId: entityA, key: "decision:the-batch-window-is-nightly",
      value: "the batch window is nightly", source: "test", project,
    });

    // Same project, different entity: not a candidate.
    const crossEntity = await applyCorrectionSupersession(
      "project", entityB, "correction:the-batch-window", "default", project,
    );
    expect(crossEntity.candidateCount).toBe(0);

    // Same entity, different project scope: not a candidate.
    const crossProject = await applyCorrectionSupersession(
      "project", entityA, "correction:the-batch-window", "default", otherProject,
    );
    expect(crossProject.candidateCount).toBe(0);

    expect(
      await findFact("project", entityA, "decision:the-batch-window-is-nightly", "default", project),
    ).toBeDefined();
  });
});

describe("project-state rollup — corrections reach recentDecisions (PRD 0i D4)", () => {
  it("after supersession the rollup shows the correction, not the archived stale decision", async () => {
    const entityId = randomUUID();
    const project = `proj-${randomUUID()}`;
    await writeFact({
      entityType: "project", entityId, key: "decision:dogfood-report-as-the-eval-branch-name",
      value: "dogfood/report as the eval branch name", source: "test", project,
    });
    await writeFact({
      entityType: "project", entityId, key: "correction:the-eval-branch-name",
      value: "the eval branch name is dogfood/report-1", source: "test", project,
    });
    await applyCorrectionSupersession(
      "project", entityId, "correction:the-eval-branch-name", "default", project,
    );

    const state = await getProjectState([project]);
    const keys = state.recentDecisions.map((d) => d.key);
    expect(keys).toContain("correction:the-eval-branch-name");
    expect(keys).not.toContain("decision:dogfood-report-as-the-eval-branch-name");
  });

  it("a lone correction (no supersession target) still reaches the rollup", async () => {
    const entityId = randomUUID();
    const project = `proj-${randomUUID()}`;
    await writeFact({
      entityType: "project", entityId, key: "correction:the-webhook-timeout",
      value: "the webhook timeout is 30s", source: "test", project,
    });

    const state = await getProjectState([project]);
    expect(state.recentDecisions.map((d) => d.key)).toContain("correction:the-webhook-timeout");
  });
});
