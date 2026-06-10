// Conflict detection tests — Phase 2b

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import { db } from "../db/connection.js";
import { escalations } from "../db/schema.js";
import { writeFact, findFact } from "../library/facts.js";
import { checkConflict } from "../library/conflicts.js";
import { comprehensionMetrics, runDeepConflictCheck } from "../library/conflicts.js";
import { recordOutcome } from "../library/source-reliability.js";
import { and, eq, desc } from "drizzle-orm";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// Minimal conflict detection (same-key)
// ---------------------------------------------------------------------------

describe("writeFact — minimal conflict detection", () => {
  it("same value on re-write: no conflict — fact updated normally", async () => {
    const entityId = randomUUID();

    const f1 = await writeFact({ entityType: "project", entityId, key: "lang", value: "TypeScript", source: "user" });
    const f2 = await writeFact({ entityType: "project", entityId, key: "lang", value: "TypeScript", source: "user" });

    expect(f2.value).toBe("TypeScript");
    expect(f2.id).toBe(f1.id);
  });

  it("supersede: equal reliability — new value wins", async () => {
    const entityId = randomUUID();

    await writeFact({ entityType: "project", entityId, key: "db", value: "sqlite", source: "agent" });
    const result = await writeFact({ entityType: "project", entityId, key: "db", value: "postgres", source: "agent" });

    // Both sources start at 0.5 → gap = 0, supersede.
    expect(result.value).toBe("postgres");
  });

  it("escalate: existing source is significantly more trusted", async () => {
    const entityId = randomUUID();
    const existingSource = `trusted-src-${randomUUID()}`;
    const newSource = `untrusted-src-${randomUUID()}`;

    // Boost existingSource to ~0.9 by recording 4 wins.
    await recordOutcome(existingSource, "dummy-opponent");
    await recordOutcome(existingSource, "dummy-opponent");
    await recordOutcome(existingSource, "dummy-opponent");
    await recordOutcome(existingSource, "dummy-opponent");

    // Write initial fact with the trusted source.
    await writeFact({ entityType: "project", entityId, key: "runtime", value: "node", source: existingSource });

    // Attempt to overwrite with the untrusted source.
    const result = await writeFact({ entityType: "project", entityId, key: "runtime", value: "bun", source: newSource });

    // The existing value should be preserved (escalation blocked the write).
    expect(result.value).toBe("node");

    // An escalation record should exist.
    const found = await db.query.escalations.findFirst({
      where: and(
        eq(escalations.entityType, "project"),
        eq(escalations.entityId, entityId),
        eq(escalations.key, "runtime"),
      ),
    });
    expect(found).toBeDefined();
    expect(found!.newValue).toBe("bun");
    expect(found!.existingValue).toBe("node");
    expect(found!.status).toBe("pending");
  });

  it("supersede: new source more trusted — does overwrite", async () => {
    const entityId = randomUUID();
    const weakSource = `weak-src-${randomUUID()}`;
    const strongSource = `strong-src-${randomUUID()}`;

    // Boost strongSource reliability.
    await recordOutcome(strongSource, "dummy-b");
    await recordOutcome(strongSource, "dummy-b");
    await recordOutcome(strongSource, "dummy-b");

    await writeFact({ entityType: "project", entityId, key: "framework", value: "express", source: weakSource });
    const result = await writeFact({ entityType: "project", entityId, key: "framework", value: "fastify", source: strongSource });

    expect(result.value).toBe("fastify");
  });

  it("source_reliability is updated after a supersession", async () => {
    const entityId = randomUUID();
    const srcA = `rela-a-${randomUUID()}`;
    const srcB = `rela-b-${randomUUID()}`;

    await writeFact({ entityType: "project", entityId, key: "version", value: "v1", source: srcA });
    await writeFact({ entityType: "project", entityId, key: "version", value: "v2", source: srcB });

    // srcB won (superseded srcA). Wait briefly for the async update.
    await new Promise((r) => setTimeout(r, 80));

    const { getReliabilityRow } = await import("../library/source-reliability.js");
    const winner = await getReliabilityRow(srcB);
    const loser = await getReliabilityRow(srcA);

    expect(winner).toBeDefined();
    expect(winner!.wins).toBe(1);
    expect(loser).toBeDefined();
    expect(loser!.losses).toBe(1);
  });

  it("escalation creates a markdown file in the escalations dir", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const dir = path.join(process.cwd(), "iranti-escalations");

    const entityId = randomUUID();
    const existingSource = `md-trusted-${randomUUID()}`;
    const newSource = `md-untrusted-${randomUUID()}`;

    await recordOutcome(existingSource, "x");
    await recordOutcome(existingSource, "x");
    await recordOutcome(existingSource, "x");
    await recordOutcome(existingSource, "x");

    await writeFact({ entityType: "project", entityId, key: "ci", value: "github-actions", source: existingSource });
    await writeFact({ entityType: "project", entityId, key: "ci", value: "circle-ci", source: newSource });

    // The escalations directory should now contain at least one .md file.
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      // dir might not exist if no escalation ran yet in this test run
    }
    expect(files.some((f) => f.endsWith(".md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deep conflict detection (cross-key)
// ---------------------------------------------------------------------------

describe("writeFact — deep conflict detection (comprehension metric)", () => {
  it("planting a cross-key contradiction increments deepConflictsDetected", async () => {
    const entityId = randomUUID();
    const before = comprehensionMetrics.deepConflictsDetected;

    // Plant an affirmation fact.
    await writeFact({
      entityType: "project",
      entityId,
      key: "stack",
      value: "we use PostgreSQL for the database",
      source: "user",
    });

    // Plant a negation fact that mentions PostgreSQL.
    await writeFact({
      entityType: "project",
      entityId,
      key: "stack_change",
      value: "not using PostgreSQL anymore, switched to SQLite",
      source: "user",
    });

    // Wait for the async deep conflict check to run.
    await new Promise((r) => setTimeout(r, 150));

    expect(comprehensionMetrics.deepConflictsDetected).toBeGreaterThan(before);
  });

  it("deep detection does NOT auto-resolve — both facts persist", async () => {
    const entityId = randomUUID();

    await writeFact({
      entityType: "project",
      entityId,
      key: "cache",
      value: "we use Redis for caching",
      source: "user",
    });

    await writeFact({
      entityType: "project",
      entityId,
      key: "cache_note",
      value: "not using Redis anymore",
      source: "user",
    });

    await new Promise((r) => setTimeout(r, 150));

    const f1 = await findFact("project", entityId, "cache");
    const f2 = await findFact("project", entityId, "cache_note");

    // Both facts survive — deep detection never auto-resolves.
    expect(f1?.value).toContain("Redis");
    expect(f2?.value).toContain("Redis");
  });

  it("no false positive for unrelated facts", async () => {
    const entityId = randomUUID();
    const before = comprehensionMetrics.deepConflictsDetected;

    await writeFact({ entityType: "project", entityId, key: "name", value: "my project", source: "user" });
    await writeFact({ entityType: "project", entityId, key: "status", value: "in progress", source: "user" });

    await new Promise((r) => setTimeout(r, 150));

    // No negation pattern → counter should not increase.
    expect(comprehensionMetrics.deepConflictsDetected).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// checkConflict unit tests (direct call — no DB writes)
// ---------------------------------------------------------------------------

describe("checkConflict — unit", () => {
  it("returns no_conflict when values are identical", async () => {
    const fake = { value: "same", source: "user" } as Parameters<typeof checkConflict>[0];
    const result = await checkConflict(fake, "same", "user");
    expect(result).toBe("no_conflict");
  });

  it("returns supersede when both sources are new (equal default scores)", async () => {
    const fake = { value: "old", source: `fresh-src-${randomUUID()}` } as Parameters<typeof checkConflict>[0];
    const result = await checkConflict(fake, "new", `fresh-src-${randomUUID()}`);
    expect(result).toBe("supersede");
  });
});
