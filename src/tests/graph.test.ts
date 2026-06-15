// Integration tests — Phase 2a graph substrate
//
// Tests for:
//   1. GraphBackend (addEdge, reinforceEdge, getEdge, getNeighbors)
//   2. Co-access edge recording wired into attend
//   3. Governs edge recording wired into attend
//   4. Concurrency regression: advisory lock prevents duplicate archive snapshots

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import { writeFact, getFactHistoryByKey, findFact } from "../library/facts.js";
import { writeRule } from "../library/rules.js";
import { graph } from "../graph/index.js";
import { attend } from "../mcp/tools/attend.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// GraphBackend unit tests
// ---------------------------------------------------------------------------

describe("GraphBackend — addEdge", () => {
  it("creates an edge with the right fields", async () => {
    const srcId = randomUUID();
    const tgtId = randomUUID();

    const edge = await graph.addEdge({
      sourceType: "fact",
      sourceId: srcId,
      targetType: "fact",
      targetId: tgtId,
      relation: "co_access",
      weight: 1,
    });

    // Canonical ordering may swap the IDs — check both are present.
    expect([edge.sourceId, edge.targetId]).toContain(srcId);
    expect([edge.sourceId, edge.targetId]).toContain(tgtId);
    expect(edge.relation).toBe("co_access");
    expect(edge.weight).toBeCloseTo(1);
    expect(edge.coAccessCount).toBe(1);
    expect(edge.id).toBeDefined();
  });

  it("upserts on conflict — increments weight and coAccessCount", async () => {
    const srcId = randomUUID();
    const tgtId = randomUUID();

    await graph.addEdge({ sourceType: "fact", sourceId: srcId, targetType: "fact", targetId: tgtId, relation: "co_access" });
    await graph.addEdge({ sourceType: "fact", sourceId: srcId, targetType: "fact", targetId: tgtId, relation: "co_access" });

    const edge = await graph.getEdge(
      { type: "fact", id: srcId },
      { type: "fact", id: tgtId },
      "co_access",
    );

    expect(edge).toBeDefined();
    expect(edge!.coAccessCount).toBe(2);
    expect(edge!.weight).toBeCloseTo(2);
  });
});

describe("GraphBackend — reinforceEdge", () => {
  it("creates an edge when it does not exist", async () => {
    const aId = randomUUID();
    const bId = randomUUID();

    await graph.reinforceEdge({ type: "fact", id: aId }, { type: "fact", id: bId }, "co_access");

    const edge = await graph.getEdge({ type: "fact", id: aId }, { type: "fact", id: bId }, "co_access");
    expect(edge).toBeDefined();
    expect(edge!.coAccessCount).toBe(1);
  });

  it("increments weight on second call — does not duplicate", async () => {
    const aId = randomUUID();
    const bId = randomUUID();

    await graph.reinforceEdge({ type: "fact", id: aId }, { type: "fact", id: bId }, "co_access");
    await graph.reinforceEdge({ type: "fact", id: aId }, { type: "fact", id: bId }, "co_access");

    const edge = await graph.getEdge({ type: "fact", id: aId }, { type: "fact", id: bId }, "co_access");
    expect(edge!.coAccessCount).toBe(2);
    expect(edge!.weight).toBeCloseTo(2);
  });

  it("canonical ordering: (A,B) and (B,A) are the same row", async () => {
    const aId = randomUUID();
    const bId = randomUUID();

    // Reinforce in one order, look up in the other.
    await graph.reinforceEdge({ type: "fact", id: aId }, { type: "fact", id: bId }, "co_access");
    await graph.reinforceEdge({ type: "fact", id: bId }, { type: "fact", id: aId }, "co_access");

    // Both calls targeted the same canonical row.
    const edge = await graph.getEdge({ type: "fact", id: aId }, { type: "fact", id: bId }, "co_access");
    expect(edge!.coAccessCount).toBe(2);

    // Looking up in reverse order returns the same row.
    const edgeReversed = await graph.getEdge({ type: "fact", id: bId }, { type: "fact", id: aId }, "co_access");
    expect(edgeReversed!.id).toBe(edge!.id);
  });

  it("governs edges are directional — (rule,fact) ≠ (fact,rule)", async () => {
    const ruleId = randomUUID();
    const factId = randomUUID();

    // Write directed governs edge rule→fact.
    await graph.reinforceEdge({ type: "rule", id: ruleId }, { type: "fact", id: factId }, "governs");

    // Direct lookup works.
    const fwd = await graph.getEdge({ type: "rule", id: ruleId }, { type: "fact", id: factId }, "governs");
    expect(fwd).toBeDefined();

    // Reverse lookup returns undefined — governs is directed.
    const rev = await graph.getEdge({ type: "fact", id: factId }, { type: "rule", id: ruleId }, "governs");
    expect(rev).toBeUndefined();
  });

  it("co_access and governs are independent edge types for the same pair", async () => {
    const aId = randomUUID();
    const bId = randomUUID();

    await graph.reinforceEdge({ type: "fact", id: aId }, { type: "fact", id: bId }, "co_access");
    await graph.reinforceEdge({ type: "fact", id: aId }, { type: "fact", id: bId }, "co_access");

    // A different relation does not exist yet.
    const govEdge = await graph.getEdge({ type: "fact", id: aId }, { type: "fact", id: bId }, "governs");
    expect(govEdge).toBeUndefined();

    // co_access count unaffected.
    const coEdge = await graph.getEdge({ type: "fact", id: aId }, { type: "fact", id: bId }, "co_access");
    expect(coEdge!.coAccessCount).toBe(2);
  });
});

describe("GraphBackend — getNeighbors", () => {
  it("returns edges where the node is source or target", async () => {
    const hub = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();

    await graph.reinforceEdge({ type: "fact", id: hub }, { type: "fact", id: a }, "co_access");
    await graph.reinforceEdge({ type: "fact", id: b }, { type: "fact", id: hub }, "co_access");
    await graph.reinforceEdge({ type: "fact", id: c }, { type: "fact", id: c }, "co_access"); // unrelated

    const neighbors = await graph.getNeighbors({ type: "fact", id: hub }, { depth: 1 });

    const ids = neighbors.flatMap((e) => [e.sourceId, e.targetId]);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    // The unrelated self-edge should not appear.
    const relatedToC = neighbors.filter((e) => e.sourceId === c || e.targetId === c);
    expect(relatedToC).toHaveLength(0);
  });

  it("minWeight filter excludes low-weight edges", async () => {
    const hub = randomUUID();
    const weak = randomUUID();
    const strong = randomUUID();

    // Reinforce strong twice so weight = 2.
    await graph.reinforceEdge({ type: "fact", id: hub }, { type: "fact", id: strong }, "co_access");
    await graph.reinforceEdge({ type: "fact", id: hub }, { type: "fact", id: strong }, "co_access");
    // weak has weight 1.
    await graph.reinforceEdge({ type: "fact", id: hub }, { type: "fact", id: weak }, "co_access");

    const neighbors = await graph.getNeighbors({ type: "fact", id: hub }, { minWeight: 2 });

    const ids = neighbors.flatMap((e) => [e.sourceId, e.targetId]);
    expect(ids).toContain(strong);
    // weak edge was filtered out.
    const weakInResult = neighbors.filter((e) => e.sourceId === weak || e.targetId === weak);
    expect(weakInResult).toHaveLength(0);
  });
});

describe("GraphBackend — getNeighbors depth>1 (CORE-34 regression)", () => {
  it("depth-2 traversal reaches nodes two hops away, not back to origin", async () => {
    // Chain: A — B — C
    // getNeighbors(A, depth=2) must include C (two hops forward).
    // Pre-fix bug: the recursive JOIN used t.source_type/id — the ORIGIN side —
    // which walked backward instead of forward from the frontier. C was
    // invisible; edges pointing back to A-adjacent nodes could appear instead.
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    const d = randomUUID(); // unrelated — must not appear

    await graph.reinforceEdge({ type: "fact", id: a }, { type: "fact", id: b }, "co_access");
    await graph.reinforceEdge({ type: "fact", id: b }, { type: "fact", id: c }, "co_access");
    await graph.reinforceEdge({ type: "fact", id: d }, { type: "fact", id: d }, "co_access");

    const neighbors = await graph.getNeighbors({ type: "fact", id: a }, { depth: 2 });
    const allIds = neighbors.flatMap((e) => [e.sourceId, e.targetId]);

    expect(allIds).toContain(c);
    expect(allIds).not.toContain(d);
  });

  it("weight ordering applies before LIMIT — highest-weight edge wins", async () => {
    // Setup: A-B (w=1), B-C1 (w=1), B-C2 (w=5).
    // With limit=1 and ORDER BY weight DESC, B-C2 must win over A-B.
    // Pre-fix bug: ORDER BY id LIMIT made the winner UUID-order (arbitrary).
    const a = randomUUID();
    const b = randomUUID();
    const c1 = randomUUID();
    const c2 = randomUUID();

    await graph.reinforceEdge({ type: "fact", id: a }, { type: "fact", id: b }, "co_access");
    await graph.reinforceEdge({ type: "fact", id: b }, { type: "fact", id: c1 }, "co_access");
    for (let i = 0; i < 5; i++) {
      await graph.reinforceEdge({ type: "fact", id: b }, { type: "fact", id: c2 }, "co_access");
    }

    const top = await graph.getNeighbors({ type: "fact", id: a }, { depth: 2, limit: 1 });

    expect(top).toHaveLength(1);
    const topIds = [top[0]!.sourceId, top[0]!.targetId];
    expect(topIds).toContain(c2);
    expect(top[0]!.weight).toBeCloseTo(5);
  });
});

describe("GraphBackend — getEdge", () => {
  it("returns undefined when the edge does not exist", async () => {
    const edge = await graph.getEdge(
      { type: "fact", id: randomUUID() },
      { type: "fact", id: randomUUID() },
      "co_access",
    );
    expect(edge).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Attend integration: co_access edges
// ---------------------------------------------------------------------------

// The async edge recording in attend uses fire-and-forget. Give it time to
// flush before asserting. 150 ms is well above the expected DB round-trip.
// 400ms: Phase 2b adds conflicts.test.ts / semantic-extract.test.ts which
// saturate the connection pool when run concurrently. 150ms was enough in
// isolation but not under the full parallel test load.
const EDGE_SETTLE_MS = 400;

describe("attend — co_access edge recording", () => {
  it("records co_access edges among returned facts after attend", async () => {
    const entityId = randomUUID();
    const entityType = "project";

    // Write two facts so attend returns them together.
    const f1 = await writeFact({ entityType, entityId, key: "fact_a", value: "alpha", source: "test" });
    const f2 = await writeFact({ entityType, entityId, key: "fact_b", value: "beta", source: "test" });

    await attend({ entityHints: [{ entityType, entityId }] });

    // Wait for the async edge recording to flush.
    await new Promise((r) => setTimeout(r, EDGE_SETTLE_MS));

    const edge = await graph.getEdge(
      { type: "fact", id: f1.id },
      { type: "fact", id: f2.id },
      "co_access",
    );

    expect(edge).toBeDefined();
    expect(edge!.coAccessCount).toBeGreaterThanOrEqual(1);
  });

  it("second identical attend increments coAccessCount — does not duplicate", async () => {
    const entityId = randomUUID();
    const entityType = "project";

    const f1 = await writeFact({ entityType, entityId, key: "fact_x", value: "x1", source: "test" });
    const f2 = await writeFact({ entityType, entityId, key: "fact_y", value: "y1", source: "test" });

    await attend({ entityHints: [{ entityType, entityId }] });
    await attend({ entityHints: [{ entityType, entityId }] });

    await new Promise((r) => setTimeout(r, EDGE_SETTLE_MS));

    const edge = await graph.getEdge(
      { type: "fact", id: f1.id },
      { type: "fact", id: f2.id },
      "co_access",
    );

    expect(edge).toBeDefined();
    // Two attends → count = 2. Not 1 (missed) or 3+ (duplicated).
    expect(edge!.coAccessCount).toBe(2);
  });

  it("single-fact attend does not create any edge (need ≥2 facts)", async () => {
    const entityId = randomUUID();

    const f1 = await writeFact({
      entityType: "project",
      entityId,
      key: "solo",
      value: "only one fact",
      source: "test",
    });

    await attend({ entityHints: [{ entityType: "project", entityId }] });
    await new Promise((r) => setTimeout(r, EDGE_SETTLE_MS));

    const neighbors = await graph.getNeighbors({ type: "fact", id: f1.id });
    // f1 appears alone — no CO_ACCESS edges (those require ≥2 facts).
    // governs edges may exist if system/global rules fired alongside f1; that
    // is correct behaviour, not a guard failure.
    const coAccessEdges = neighbors.filter((e) => e.relation === "co_access");
    expect(coAccessEdges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Attend integration: governs edges
// ---------------------------------------------------------------------------

describe("attend — governs edge recording", () => {
  it("records governs edges rule→fact when a rule fires alongside facts", async () => {
    const entityId = randomUUID();
    const entityType = "project";

    // Write a rule scoped to this project.
    const rule = await writeRule({
      entityType,
      entityId,
      text: "governs edge test rule",
      source: "test",
      priority: 0,
    });

    // Write two facts.
    const f1 = await writeFact({ entityType, entityId, key: "g_fact_a", value: "ga", source: "test" });
    const f2 = await writeFact({ entityType, entityId, key: "g_fact_b", value: "gb", source: "test" });

    await attend({ entityHints: [{ entityType, entityId }] });
    await new Promise((r) => setTimeout(r, EDGE_SETTLE_MS));

    // The rule should have governs edges to each returned fact.
    const ruleToF1 = await graph.getEdge(
      { type: "rule", id: rule.id },
      { type: "fact", id: f1.id },
      "governs",
    );
    const ruleToF2 = await graph.getEdge(
      { type: "rule", id: rule.id },
      { type: "fact", id: f2.id },
      "governs",
    );

    expect(ruleToF1).toBeDefined();
    expect(ruleToF2).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Write safety: concurrency regression (headline test)
// ---------------------------------------------------------------------------

describe("writeFact — concurrency regression (advisory lock)", () => {
  it("two simultaneous writes produce no duplicate archive snapshots", async () => {
    const entityType = "project";
    const entityId = randomUUID();
    const key = "concurrent_key";

    // Establish an initial value to create the row.
    await writeFact({ entityType, entityId, key, value: "v0", source: "test" });

    // Write two different values concurrently.
    // Without the advisory lock, both writers could read v0, both snapshot it,
    // and produce two archive rows with value "v0".
    // With the lock, writers are serialized: the second writer sees the first
    // writer's value before snapshotting.
    await Promise.all([
      writeFact({ entityType, entityId, key, value: "v1", source: "test" }),
      writeFact({ entityType, entityId, key, value: "v2", source: "test" }),
    ]);

    const history = await getFactHistoryByKey(entityType, entityId, key);

    // Exactly 2 archive rows: v0 (superseded by the first concurrent writer)
    // and one of v1/v2 (superseded by the second). Never 3 (lock collision)
    // and never 2 rows with the same value (duplicate snapshot).
    expect(history).toHaveLength(2);

    const archiveValues = history.map((h) => h.value);
    const uniqueValues = new Set(archiveValues);
    expect(uniqueValues.size).toBe(2); // no duplicate snapshots

    // Live fact must be one of the two concurrent values.
    const live = await findFact(entityType, entityId, key);
    expect(live).toBeDefined();
    expect(["v1", "v2"]).toContain(live!.value);
  });

  it("write to different keys on the same entity proceeds without blocking", async () => {
    const entityType = "project";
    const entityId = randomUUID();

    // Different keys → different advisory lock slots → should not serialize.
    await Promise.all([
      writeFact({ entityType, entityId, key: "key_alpha", value: "a", source: "test" }),
      writeFact({ entityType, entityId, key: "key_beta", value: "b", source: "test" }),
      writeFact({ entityType, entityId, key: "key_gamma", value: "c", source: "test" }),
    ]);

    const a = await findFact(entityType, entityId, "key_alpha");
    const b = await findFact(entityType, entityId, "key_beta");
    const c = await findFact(entityType, entityId, "key_gamma");

    expect(a?.value).toBe("a");
    expect(b?.value).toBe("b");
    expect(c?.value).toBe("c");
  });
});
