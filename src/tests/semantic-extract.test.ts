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

// ---------------------------------------------------------------------------
// Phase 3 (CORE-32): expanded corpus + attendant_autowrite
// ---------------------------------------------------------------------------

describe("HeuristicExtractor — CORE-32 expanded corpus", () => {
  const ex = new HeuristicExtractor();

  it("extracts a constraint pattern", async () => {
    const facts = await ex.extract("we cannot use third-party APIs in this module");
    expect(facts.some((f) => f.key.startsWith("constraint:"))).toBe(true);
  });

  it("extracts a requirement constraint", async () => {
    const facts = await ex.extract("requirement: all outputs must be deterministic");
    expect(facts.some((f) => f.key.startsWith("constraint:"))).toBe(true);
  });

  it("extracts a failed approach", async () => {
    const facts = await ex.extract("we tried the polling approach but it didn't work");
    expect(facts.some((f) => f.key.startsWith("failed-approach:"))).toBe(true);
  });

  it("extracts a correction", async () => {
    const facts = await ex.extract("actually the timeout value should be 5000");
    expect(facts.some((f) => f.key.startsWith("correction:"))).toBe(true);
  });

  it("new decision patterns: let's use X", async () => {
    const facts = await ex.extract("let's use pnpm for package management");
    expect(facts.some((f) => f.key.startsWith("decision:"))).toBe(true);
  });
});

describe("attend — CORE-32 attendant_autowrite via currentContext", () => {
  it("post-response attend extracts attendant_autowrite facts from currentContext", async () => {
    const entityId = randomUUID();
    const entityType = "project";

    // Simulate a post-response attend with a currentContext that contains
    // extractable signal (a decision statement in the assistant's response).
    await attend({
      entityHints: [{ entityType, entityId }],
      phase: "post-response",
      currentContext: "we decided to use Redis for the session store in this service",
    });

    await new Promise((r) => setTimeout(r, 300));

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
    const autowrites = rows.filter((r) => r.source === "attendant_autowrite");
    expect(autowrites.length).toBeGreaterThan(0);
    // Auto-writes land at reduced confidence (≤ 0.75 after D7 formula on neutral source).
    expect(autowrites[0]!.confidence).toBeLessThanOrEqual(0.8);
  });
});

// ---------------------------------------------------------------------------
// AX-9 — extraction honesty hardening (dogfood remediation)
// ---------------------------------------------------------------------------

describe("HeuristicExtractor — AX-9 fabrication guard", () => {
  const ex = new HeuristicExtractor();

  it("extracts NOTHING from the live incident sentence (negated 'decision' noun)", async () => {
    const facts = await ex.extract(
      "Told the user no rate limiting decision is on record for the HTTP transport.",
    );
    expect(facts).toHaveLength(0);
  });

  it("extracts NOTHING from the colon-less bare-noun form ('decision is')", async () => {
    // The old pattern's [:\s]+ fired on 'decision is' too, not just
    // 'decision:' — both sub-vectors must be dead, not only the colon form.
    const facts = await ex.extract(
      "the decision is final and nobody wants to relitigate it",
    );
    expect(facts).toHaveLength(0);
  });

  it("extracts NOTHING from a negated 'requirement' noun with a space after it", async () => {
    const facts = await ex.extract(
      "There was never a requirement to keep raw logs beyond thirty days.",
    );
    expect(facts).toHaveLength(0);
  });

  it("extracts NOTHING from an explicitly-undecided 'decision' sentence", async () => {
    const facts = await ex.extract(
      "We haven't made a decision about the icon set yet, still comparing options.",
    );
    expect(facts).toHaveLength(0);
  });

  it("extracts NOTHING from a mid-sentence 'constraint' noun misuse", async () => {
    const facts = await ex.extract(
      "we dropped the constraint list idea entirely, too much ceremony",
    );
    expect(facts).toHaveLength(0);
  });

  it("still extracts the sentence-initial 'Decision:' label form", async () => {
    const facts = await ex.extract(
      "Decision: all new components live under src/components/ui, no more scattering.",
    );
    expect(facts.some((f) => f.key.startsWith("decision:"))).toBe(true);
  });

  it("still extracts a label opening a LATER sentence in the message", async () => {
    const facts = await ex.extract("Sounds good. Decision: ship it on Friday.");
    expect(facts.some((f) => f.key.startsWith("decision:"))).toBe(true);
  });

  it("does NOT extract a label buried mid-sentence after an em-dash", async () => {
    const facts = await ex.extract(
      "oh also — decision: we're calling it 'the widget' from now on",
    );
    expect(facts.filter((f) => f.key.startsWith("decision:"))).toHaveLength(0);
  });
});

describe("HeuristicExtractor — AX-9 dash clause terminators", () => {
  const ex = new HeuristicExtractor();

  it("em-dash terminates the capture (the dogfood eval's live miss sentence shape)", async () => {
    const facts = await ex.extract(
      "we decided to keep PGlite as the default database engine — Postgres is opt-in through the IRANTI_DB_ENGINE env var.",
    );
    const decision = facts.find((f) => f.key.startsWith("decision:"));
    expect(decision).toBeDefined();
    expect(decision!.value.toLowerCase()).toContain("pglite");
    // Compound-sentence disclosure (PRD ax-9 §7): only the pattern-matching
    // clause extracts; the trailing clause is an accepted non-extraction.
    expect(decision!.value.toLowerCase()).not.toContain("postgres");
  });

  it("em-dash terminates a sentence-initial constraint label capture", async () => {
    const facts = await ex.extract(
      "constraint: the friday export csv is sacred — nobody edits the columns without telling finance.",
    );
    const constraint = facts.find((f) => f.key.startsWith("constraint:"));
    expect(constraint).toBeDefined();
    expect(constraint!.value.toLowerCase()).toBe("the friday export csv is sacred");
  });

  it("spaced hyphen terminates the capture", async () => {
    const facts = await ex.extract("I prefer tabs over spaces - way easier to diff.");
    const pref = facts.find((f) => f.key.startsWith("preference:"));
    expect(pref).toBeDefined();
    expect(pref!.value.toLowerCase()).toBe("tabs over spaces");
  });

  it("UNSPACED hyphens survive inside captured identifiers", async () => {
    const facts = await ex.extract(
      "we're using dogfood/report-1 as the eval branch name.",
    );
    const decision = facts.find((f) => f.key.startsWith("decision:"));
    expect(decision).toBeDefined();
    expect(decision!.value).toContain("dogfood/report-1");
  });
});

describe("attend — AX-9 host-summary demotion (two-sided phase branch)", () => {
  it("post-response message extraction is provenance-labeled and confidence-demoted", async () => {
    const entityId = randomUUID();
    await attend({
      entityHints: [{ entityType: "project", entityId }],
      message: "we chose Fastify as the http server",
      phase: "post-response",
    });
    await new Promise((r) => setTimeout(r, 300));

    // attend() writes under the cwd-resolved project, not "default" —
    // same reason the integration test above queries with a fallback.
    const { resolveCurrentProject } = await import("../library/projects.js");
    const project = (await resolveCurrentProject()).id;
    const stored = await findFact("project", entityId, "decision:fastify", "default", project);
    expect(stored).toBeDefined();
    expect(stored!.source).toBe("host_summary_extract");
    expect(stored!.confidence).toBeCloseTo(0.7, 5);
  });

  it("pre-response (user-authored) message extraction keeps full trust", async () => {
    const entityId = randomUUID();
    await attend({
      entityHints: [{ entityType: "project", entityId }],
      message: "we chose Fastify as the http server",
      phase: "pre-response",
    });
    await new Promise((r) => setTimeout(r, 300));

    const { resolveCurrentProject } = await import("../library/projects.js");
    const project = (await resolveCurrentProject()).id;
    const stored = await findFact("project", entityId, "decision:fastify", "default", project);
    expect(stored).toBeDefined();
    expect(stored!.source).toBe("extractor_heuristic");
    expect(stored!.confidence).toBeCloseTo(0.85, 5);
  });
});
