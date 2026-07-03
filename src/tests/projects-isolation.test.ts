// Layer 0 — adversarial cross-project isolation + combine/uncombine +
// exclude, against embedded PGlite (zero-infra, matches it-runs.test.ts's
// pattern so this suite never depends on a live Postgres server).
//
// Module-load-order care: src/db/connection.ts reads IRANTI_DB_ENGINE /
// IRANTI_DATA_DIR / DATABASE_URL at IMPORT TIME. So env vars are set BEFORE
// any dynamic import of iranti internals, and every such import happens
// inside the test body via dynamic import() — never a static top-level
// import — exactly like it-runs.test.ts and persistence.test.ts.
//
// LOAD-BEARING TEST-RUNNER ASSUMPTION: this file mutates process.env. Only
// safe because vitest runs with pool:"forks" (one process per test FILE —
// see it-runs.test.ts's header comment for the full explanation).
//
// This suite deliberately calls the LIBRARY functions (writeFact, readFact,
// readRelevantFactsByEntity, searchFacts, graph.*, projects.*) with EXPLICIT
// project ids rather than going through ensureContext()/attend()'s
// process-wide memoized project resolution — McpContext resolves the
// project ONCE per process from process.cwd() and caches it, so simulating
// two different projects "logged in" side by side within one test process
// requires bypassing that cache and driving the actual isolation mechanism
// (the `project` column + filter) directly. This is a stronger test of the
// isolation guarantee itself, not a weaker one: it proves the DATA layer
// enforces isolation regardless of which project the calling process
// happens to be attending from.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "iranti-proj-isolation-"));

beforeAll(() => {
  process.env["IRANTI_DB_ENGINE"] = "pglite";
  process.env["IRANTI_DATA_DIR"] = dataDir;
  delete process.env["DATABASE_URL"];
});

afterAll(async () => {
  // Grace period for any fire-and-forget chains still settling (same
  // reasoning as it-runs.test.ts / harness/ingest.ts).
  await new Promise((resolve) => setTimeout(resolve, 250));
  const { pool } = await import("../db/connection.js");
  await pool.end({ timeout: 5 });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Layer 0 — adversarial cross-project isolation", () => {
  it("a fact written under project A is invisible to project B, even with an IDENTICAL entity name and key", async () => {
    const { writeFact, readFact, readRecentFactsByEntity } = await import("../library/facts.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;
    // Deliberately colliding entity — same entityType/entityId reused by
    // two unrelated "folders". If isolation is broken, B will see A's fact.
    const entityType = "project";
    const entityId = "shared-entity-name";
    const key = "shared-key-name";

    await writeFact({
      entityType,
      entityId,
      key,
      value: "SECRET-VALUE-FROM-PROJECT-A",
      source: "test",
      project: projectA,
    });

    // Project B must not see it via exact read...
    const bRead = await readFact(entityType, entityId, key, "default", projectB);
    expect(bRead).toBeUndefined();

    // ...nor via the recency-scoped listing.
    const bRecent = await readRecentFactsByEntity(entityType, entityId, 10, "default", projectB);
    expect(bRecent.some((f) => f.value === "SECRET-VALUE-FROM-PROJECT-A")).toBe(false);

    // But project A itself sees it fine.
    const aRead = await readFact(entityType, entityId, key, "default", projectA);
    expect(aRead?.value).toBe("SECRET-VALUE-FROM-PROJECT-A");
  });

  it("iranti_search (searchFacts) does not leak project A's content into a project B search, even with a matching search term", async () => {
    const { writeFact, searchFacts } = await import("../library/facts.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;
    const needle = `zzyzx-unique-token-${randomUUID()}`;

    await writeFact({
      entityType: "project",
      entityId: "search-leak-check",
      key: "decision",
      value: `we decided to use ${needle} as our stack`,
      source: "test",
      project: projectA,
    });

    // Searching from B for the exact token A wrote must come back empty.
    const bResults = await searchFacts(needle, { project: projectB });
    expect(bResults).toHaveLength(0);

    // The same search scoped to A finds it.
    const aResults = await searchFacts(needle, { project: projectA });
    expect(aResults.length).toBeGreaterThan(0);
  });

  it("readRelevantFactsByEntity (attend's primary retrieval) never surfaces project A facts for project B, even with matching message keywords", async () => {
    const { writeFact, readRelevantFactsByEntity } = await import("../library/facts.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;
    const entityType = "project";
    const entityId = "relevance-leak-check";

    await writeFact({
      entityType,
      entityId,
      key: "preference",
      value: "always use TypeScript strict mode",
      source: "test",
      project: projectA,
    });

    const bResults = await readRelevantFactsByEntity(
      entityType,
      entityId,
      10,
      "always use TypeScript strict mode", // exact keyword match
      "default",
      projectB,
    );
    expect(bResults).toHaveLength(0);
  });

  it("knowledge graph edges recorded in project A do not surface as peripheral suggestions in project B", async () => {
    const { graph } = await import("../graph/index.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;
    const factX = randomUUID();
    const factY = randomUUID();

    await graph.reinforceEdge(
      { type: "fact", id: factX },
      { type: "fact", id: factY },
      "co_access",
      5,
      "default",
      projectA,
    );

    const neighborsInA = await graph.getNeighbors(
      { type: "fact", id: factX },
      { depth: 1 },
      "default",
      projectA,
    );
    expect(neighborsInA.length).toBeGreaterThan(0);

    const neighborsInB = await graph.getNeighbors(
      { type: "fact", id: factX },
      { depth: 1 },
      "default",
      projectB,
    );
    expect(neighborsInB).toHaveLength(0);
  });

  it("rules (including system/global) written in project A do not fire in project B", async () => {
    const { writeRule, getRulesForAttend } = await import("../library/rules.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;

    await writeRule({
      entityType: "system",
      entityId: "global",
      text: "PROJECT-A-ONLY: never mention competitor X",
      source: "test",
      priority: 100,
      project: projectA,
    });

    const rulesForB = await getRulesForAttend([], "default", projectB);
    expect(rulesForB.some((r) => r.text.includes("PROJECT-A-ONLY"))).toBe(false);

    const rulesForA = await getRulesForAttend([], "default", projectA);
    expect(rulesForA.some((r) => r.text.includes("PROJECT-A-ONLY"))).toBe(true);
  });

  it("media objects (OD-4 attend tier) do not leak across projects with a colliding entity", async () => {
    const { writeMediaObject, searchMedia } = await import("../library/media.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;

    await writeMediaObject({
      entityType: "project",
      entityId: "media-leak-check",
      key: "screenshot:secret",
      objectUrl: "file:///secret.png",
      mimeType: "image/png",
      descriptionText: "a screenshot of the confidential roadmap",
      project: projectA,
    });

    const hitsB = await searchMedia("confidential roadmap", { project: projectB });
    expect(hitsB).toHaveLength(0);

    const hitsA = await searchMedia("confidential roadmap", { project: projectA });
    expect(hitsA.length).toBeGreaterThan(0);
  });

  it("fact history (getFactHistoryByKey) does not leak project A's archived values to project B via a colliding entity+key", async () => {
    const { writeFact, getFactHistoryByKey } = await import("../library/facts.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;
    const entityType = "project";
    const entityId = "history-leak-check";
    const key = "decision";

    await writeFact({
      entityType,
      entityId,
      key,
      value: "v1 (old)",
      source: "test",
      project: projectA,
    });
    await writeFact({
      entityType,
      entityId,
      key,
      value: "v2 (new)",
      source: "test",
      project: projectA,
    });

    const historyForB = await getFactHistoryByKey(entityType, entityId, key, "default", projectB);
    expect(historyForB).toHaveLength(0);

    const historyForA = await getFactHistoryByKey(entityType, entityId, key, "default", projectA);
    expect(historyForA.some((h) => h.value === "v1 (old)")).toBe(true);
  });
});

describe("Layer 0 — combine (explicit, reversible cross-project sharing)", () => {
  it("after combining A+B, B's reads see A's facts; after uncombining, isolation is restored", async () => {
    const { writeFact, readFact } = await import("../library/facts.js");
    const {
      combineProjects,
      uncombineProjects,
      getEffectiveProjectIds,
      normalizeProjectId,
    } = await import("../library/projects.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;
    const entityType = "project";
    const entityId = "combine-check";
    const key = "shared-decision";

    await writeFact({
      entityType,
      entityId,
      key,
      value: "decided-in-A",
      source: "test",
      project: projectA,
    });

    // Before combining: B cannot see it.
    const beforeCombine = await readFact(entityType, entityId, key, "default", projectB);
    expect(beforeCombine).toBeUndefined();

    // Combine A + B.
    await combineProjects(projectA, projectB);

    // Compare against normalizeProjectId(projectA), not the raw fixture
    // string: on Windows, a non-existent absolute POSIX-style path like
    // "/fake/projects/<uuid>" normalizes to "c:/fake/projects/<uuid>" (the
    // current drive is implied) — every function under test does this
    // normalization internally, so assertions must too.
    const effectiveForB = await getEffectiveProjectIds(projectB);
    expect(effectiveForB).toContain(normalizeProjectId(projectA));

    const afterCombine = await readFact(entityType, entityId, key, "default", effectiveForB);
    expect(afterCombine?.value).toBe("decided-in-A");

    // Reverse the combine.
    await uncombineProjects(projectA, projectB);

    const effectiveAfterUncombine = await getEffectiveProjectIds(projectB);
    expect(effectiveAfterUncombine).not.toContain(projectA);

    const afterUncombine = await readFact(
      entityType,
      entityId,
      key,
      "default",
      effectiveAfterUncombine,
    );
    expect(afterUncombine).toBeUndefined();
  });

  it("combine is symmetric: A also sees B's facts once combined", async () => {
    const { writeFact, readFact } = await import("../library/facts.js");
    const { combineProjects, getEffectiveProjectIds } = await import("../library/projects.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;
    const entityType = "project";
    const entityId = "combine-symmetric-check";
    const key = "shared-decision";

    await writeFact({
      entityType,
      entityId,
      key,
      value: "decided-in-B",
      source: "test",
      project: projectB,
    });

    await combineProjects(projectA, projectB);

    const effectiveForA = await getEffectiveProjectIds(projectA);
    const seen = await readFact(entityType, entityId, key, "default", effectiveForA);
    expect(seen?.value).toBe("decided-in-B");
  });

  it("re-combining an already-active pair is a no-op (no duplicate link)", async () => {
    const { combineProjects } = await import("../library/projects.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;

    const first = await combineProjects(projectA, projectB);
    const second = await combineProjects(projectA, projectB);

    expect(second.id).toBe(first.id);
  });

  it("re-combining after an uncombine reactivates the SAME row rather than creating a duplicate", async () => {
    const { combineProjects, uncombineProjects } = await import("../library/projects.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;

    const first = await combineProjects(projectA, projectB);
    await uncombineProjects(projectA, projectB);
    const recombined = await combineProjects(projectA, projectB);

    expect(recombined.id).toBe(first.id);
    expect(recombined.isActive).toBe(true);
  });

  it("combining a project with itself throws", async () => {
    const { combineProjects } = await import("../library/projects.js");
    const projectA = `/fake/projects/${randomUUID()}`;

    await expect(combineProjects(projectA, projectA)).rejects.toThrow();
  });
});

describe("Layer 0 — exclude / include", () => {
  it("an excluded project's combine links are not honored while excluded", async () => {
    const { writeFact, readFact } = await import("../library/facts.js");
    const {
      combineProjects,
      excludeProject,
      includeProject,
      getEffectiveProjectIds,
      normalizeProjectId,
    } = await import("../library/projects.js");

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;
    const entityType = "project";
    const entityId = "exclude-check";
    const key = "decision";

    await writeFact({
      entityType,
      entityId,
      key,
      value: "decided-in-A-exclude-test",
      source: "test",
      project: projectA,
    });

    await combineProjects(projectA, projectB);
    // Sanity: combine works before excluding.
    const beforeExclude = await getEffectiveProjectIds(projectB);
    expect(beforeExclude).toContain(normalizeProjectId(projectA));

    await excludeProject(projectB);
    const whileExcluded = await getEffectiveProjectIds(projectB);
    expect(whileExcluded).toEqual([normalizeProjectId(projectB)]);
    const readWhileExcluded = await readFact(entityType, entityId, key, "default", whileExcluded);
    expect(readWhileExcluded).toBeUndefined();

    // Re-including automatically restores the combine (no re-combine needed).
    await includeProject(projectB);
    const afterInclude = await getEffectiveProjectIds(projectB);
    expect(afterInclude).toContain(normalizeProjectId(projectA));
  });

  it("excludeProject/includeProject are idempotent and reversible (never delete the registry row)", async () => {
    const { excludeProject, includeProject, getProjectById } = await import(
      "../library/projects.js"
    );

    const projectC = `/fake/projects/${randomUUID()}`;

    await excludeProject(projectC);
    await excludeProject(projectC); // idempotent
    let row = await getProjectById(projectC);
    expect(row?.isExcluded).toBe(true);

    await includeProject(projectC);
    row = await getProjectById(projectC);
    expect(row?.isExcluded).toBe(false);
  });
});

// Regression for the review-gauntlet BLOCKER: the factId lookup path was the
// ONE retrieval surface the project boundary didn't cover — a caller in
// project B could read (getFactById/getFactHistory) or archive (archiveFact)
// project A's fact by raw UUID alone. These tests drive the library functions
// with explicit project scopes, same approach as the suite above.
describe("Layer 0 — factId paths respect the project boundary", () => {
  it("getFactById and getFactHistory return nothing for another project's factId", async () => {
    const { writeFact, archiveFact, getFactById, getFactHistory } = await import(
      "../library/facts.js"
    );

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;

    const written = await writeFact({
      entityType: "project",
      entityId: "factid-leak-check",
      key: "secret-by-id",
      value: "SECRET-VIA-UUID-FROM-A",
      source: "test",
      project: projectA,
    });
    // Give the fact some history so getFactHistory has rows to (not) leak.
    await writeFact({
      entityType: "project",
      entityId: "factid-leak-check",
      key: "secret-by-id",
      value: "SECRET-VIA-UUID-FROM-A-v2",
      source: "test",
      project: projectA,
    });

    // From project B's effective scope: indistinguishable from a bad id.
    expect(await getFactById(written.id, [projectB])).toBeUndefined();
    expect(await getFactHistory(written.id, [projectB])).toEqual([]);

    // From project A's own scope: fully visible.
    const own = await getFactById(written.id, [projectA]);
    expect(own?.value).toBe("SECRET-VIA-UUID-FROM-A-v2");
    const ownHistory = await getFactHistory(written.id, [projectA]);
    expect(ownHistory.length).toBeGreaterThan(0);

    // Cross-project archive must refuse (returns false, fact stays live)...
    expect(await archiveFact(written.id, [projectB])).toBe(false);
    expect((await getFactById(written.id, [projectA]))?.isArchived).toBe(false);

    // ...while the owning project can archive it (returns true).
    expect(await archiveFact(written.id, [projectA])).toBe(true);
    expect((await getFactById(written.id, [projectA]))?.isArchived).toBe(true);
    // Second archive of an already-archived fact reports false, not success.
    expect(await archiveFact(written.id, [projectA])).toBe(false);
  });

  it("a combined partner's scope CAN see the fact by id (effective set, not single project)", async () => {
    const { writeFact, getFactById } = await import("../library/facts.js");
    const { combineProjects, getEffectiveProjectIds, normalizeProjectId } = await import(
      "../library/projects.js"
    );

    const projectA = `/fake/projects/${randomUUID()}`;
    const projectB = `/fake/projects/${randomUUID()}`;

    const written = await writeFact({
      entityType: "project",
      entityId: "factid-combine-check",
      key: "shared-after-combine",
      value: "VISIBLE-TO-COMBINED-PARTNER",
      source: "test",
      project: projectA,
    });

    await combineProjects(projectA, projectB);
    const bEffective = await getEffectiveProjectIds(normalizeProjectId(projectB));
    const viaCombined = await getFactById(written.id, bEffective);
    expect(viaCombined?.value).toBe("VISIBLE-TO-COMBINED-PARTNER");
  });
});
