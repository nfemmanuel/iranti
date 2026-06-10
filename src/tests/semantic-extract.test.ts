// Semantic extraction tests — Phase 2b
//
// Tests for HeuristicExtractor and the extraction integration in attend.
// LocalLlmExtractor tests are skipped unless IRANTI_LLM_ENDPOINT is set and
// reachable — the heuristic baseline is always tested.

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import { HeuristicExtractor, LocalLlmExtractor } from "../extract/index.js";
import { attend } from "../mcp/tools/attend.js";
import { findFact } from "../library/facts.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// HeuristicExtractor unit tests
// ---------------------------------------------------------------------------

describe("HeuristicExtractor", () => {
  const ex = new HeuristicExtractor();

  it("extracts a 'decided to use' decision", async () => {
    const facts = await ex.extract("we decided to use TypeScript for this project");
    expect(facts.length).toBeGreaterThan(0);
    const f = facts[0]!;
    expect(f.key).toMatch(/^decision:/);
    expect(f.value.toLowerCase()).toContain("typescript");
    expect(f.source).toBe("extractor_heuristic");
    expect(f.confidence).toBeCloseTo(0.85);
  });

  it("extracts a 'decision:' label", async () => {
    const facts = await ex.extract("decision: use PostgreSQL as the primary database");
    expect(facts.some((f) => f.value.toLowerCase().includes("postgresql"))).toBe(true);
  });

  it("extracts a 'we chose' decision", async () => {
    const facts = await ex.extract("we chose Vitest as the test runner");
    expect(facts.some((f) => f.value.toLowerCase().includes("vitest"))).toBe(true);
  });

  it("extracts a preference: 'always use'", async () => {
    const facts = await ex.extract("always use strict mode in TypeScript");
    expect(facts.some((f) => f.key.startsWith("preference:"))).toBe(true);
  });

  it("extracts a preference: 'I prefer'", async () => {
    const facts = await ex.extract("I prefer functional components over class components");
    expect(facts.some((f) => f.key.startsWith("preference:") && f.value.toLowerCase().includes("functional"))).toBe(true);
  });

  it("extracts a preference: 'never use'", async () => {
    const facts = await ex.extract("never use var in JavaScript");
    expect(facts.some((f) => f.key.startsWith("preference:"))).toBe(true);
  });

  it("returns empty for a message with no markers", async () => {
    const facts = await ex.extract("the weather today is nice and sunny");
    expect(facts).toHaveLength(0);
  });

  it("returns empty for a very short message", async () => {
    const facts = await ex.extract("ok");
    expect(facts).toHaveLength(0);
  });

  it("key uses slugified value — no spaces or special chars", async () => {
    const facts = await ex.extract("we decided to use Node.js and TypeScript");
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(f.key).toMatch(/^[a-z][a-z0-9:_-]*$/);
    }
  });

  it("deduplicates when the same pattern fires twice", async () => {
    const facts = await ex.extract(
      "we decided to use React. we decided to use React for the UI.",
    );
    const keys = facts.map((f) => f.key);
    expect(keys.length).toBe(new Set(keys).size);
  });
});

// ---------------------------------------------------------------------------
// LocalLlmExtractor — degrade gracefully when no endpoint
// ---------------------------------------------------------------------------

describe("LocalLlmExtractor — graceful degradation", () => {
  it("returns only heuristic facts when LLM endpoint is unreachable", async () => {
    const ex = new LocalLlmExtractor("http://localhost:19999", "dummy-model");
    const facts = await ex.extract("we decided to use Bun as the runtime");
    // Should still get heuristic results even though LLM is unavailable.
    expect(facts.some((f) => f.source === "extractor_heuristic")).toBe(true);
    // Should not throw.
  });

  it("returns empty array gracefully when endpoint returns garbage", async () => {
    // No endpoint set → default localhost:11434 (likely not running in CI)
    const ex = new LocalLlmExtractor("http://localhost:19999", "dummy-model");
    const facts = await ex.extract("the weather today is nice");
    // Either empty (no heuristic match) or contains heuristic only.
    for (const f of facts) {
      expect(f.source).toBe("extractor_heuristic");
    }
  });
});

// ---------------------------------------------------------------------------
// Attend integration: extraction wires into attend
// ---------------------------------------------------------------------------

const EXTRACT_SETTLE_MS = 200;

describe("attend — semantic extraction integration", () => {
  it("a decision in the message surfaces as a fact on the next attend", async () => {
    const entityId = randomUUID();
    const entityType = "project";

    // First attend: message contains a decision marker.
    await attend({
      entityHints: [{ entityType, entityId }],
      message: "we decided to use Drizzle as the ORM for the backend",
    });

    // Wait for the async extraction to flush.
    await new Promise((r) => setTimeout(r, EXTRACT_SETTLE_MS));

    // The extracted fact should now exist.
    const stored = await findFact(entityType, entityId, "decision:drizzle-as-the-orm-for-the-backend");

    // Accept either the exact key or any key containing "drizzle"
    if (!stored) {
      // Search for any fact with "drizzle" in the key for this entity.
      const { db } = await import("../db/connection.js");
      const { facts } = await import("../db/schema.js");
      const { and, eq, ilike } = await import("drizzle-orm");
      const rows = await db.query.facts.findMany({
        where: and(
          eq(facts.entityType, entityType),
          eq(facts.entityId, entityId),
          ilike(facts.key, "%drizzle%"),
        ),
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.source).toMatch(/^extractor_/);
    } else {
      expect(stored.source).toMatch(/^extractor_/);
    }
  });

  it("a message with no markers produces no extracted facts", async () => {
    const entityId = randomUUID();
    const entityType = "project";

    await attend({
      entityHints: [{ entityType, entityId }],
      message: "the sky is blue and the sun is bright today",
    });

    await new Promise((r) => setTimeout(r, EXTRACT_SETTLE_MS));

    const { db } = await import("../db/connection.js");
    const { facts } = await import("../db/schema.js");
    const { and, eq } = await import("drizzle-orm");
    const rows = await db.query.facts.findMany({
      where: and(
        eq(facts.entityType, entityType),
        eq(facts.entityId, entityId),
        eq(facts.isArchived, false),
      ),
    });
    // No facts should have been created for this fresh entity.
    expect(rows.filter((r) => r.source.startsWith("extractor_"))).toHaveLength(0);
  });
});
