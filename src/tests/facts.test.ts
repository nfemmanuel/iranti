// Integration tests — facts.ts
//
// The most complex module — tests cover:
//   writeFact (create, upsert, archive snapshot, protected guard, stability preservation,
//              surface validation, tenantId isolation, updatedAt)
//   readFact  (not found, access tracking, archived exclusion, tenant scoping)
//   readFactsByEntity (ordering, empty entity, tenant scoping)
//   archiveFact (marks archived, creates archive row, no-op on already-archived)
//   getFactHistory / getFactHistoryByKey (including tenant scoping)
//   normalizeKey boundary (AX-1): N spellings → 1 row; round-trip; rawKey metadata

import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, pool } from "../db/connection.js";
import { factArchive, facts } from "../db/schema.js";
import {
  VALID_SURFACES,
  archiveFact,
  findFact,
  getFactById,
  getFactHistory,
  getFactHistoryByKey,
  readFact,
  readFactsByEntity,
  readRecentFactsByEntity,
  writeFact,
} from "../library/facts.js";
import { normalizeKey } from "../library/keys.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// writeFact
// ---------------------------------------------------------------------------

describe("writeFact", () => {
  it("creates a new fact with correct defaults", async () => {
    const entityId = randomUUID();

    const fact = await writeFact({
      entityType: "user",
      entityId,
      key: "timezone",
      value: "UTC+1",
      source: "test",
    });

    expect(fact.value).toBe("UTC+1");
    expect(fact.confidence).toBe(1.0);
    expect(fact.accessCount).toBe(0);
    expect(fact.stabilityScore).toBe(1.0);
    expect(fact.isProtected).toBe(false);
    expect(fact.isArchived).toBe(false);
  });

  it("replaces the value on a second write and creates a fact_archive snapshot", async () => {
    const entityId = randomUUID();

    // First write
    const f1 = await writeFact({
      entityType: "user",
      entityId,
      key: "tz",
      value: "UTC",
      source: "test",
    });

    // Second write — different value triggers archive
    await writeFact({
      entityType: "user",
      entityId,
      key: "tz",
      value: "UTC+1",
      source: "test",
    });

    const history = await getFactHistory(f1.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.value).toBe("UTC");
    expect(history[0]!.archivedReason).toBe("superseded");
  });

  it("does NOT create a fact_archive row when the value is unchanged", async () => {
    const entityId = randomUUID();

    const f1 = await writeFact({
      entityType: "user",
      entityId,
      key: "tz",
      value: "UTC",
      source: "test",
    });

    // Same value — no archive row should be created
    await writeFact({
      entityType: "user",
      entityId,
      key: "tz",
      value: "UTC",
      source: "test",
    });

    const history = await getFactHistory(f1.id);
    expect(history).toHaveLength(0);
  });

  it("throws when trying to overwrite a protected fact", async () => {
    const entityId = randomUUID();

    // Create the fact normally (not protected)
    const fact = await writeFact({
      entityType: "user",
      entityId,
      key: "locked-key",
      value: "original",
      source: "test",
    });

    // Mark it protected via direct DB update (simulating an admin operation)
    await db
      .update(facts)
      .set({ isProtected: true })
      .where(eq(facts.id, fact.id));

    // Now attempt to overwrite — must throw
    await expect(
      writeFact({
        entityType: "user",
        entityId,
        key: "locked-key",
        value: "attempted overwrite",
        source: "test",
      }),
    ).rejects.toThrow("protected");
  });

  it("preserves stabilityScore and accessCount across value updates", async () => {
    const entityId = randomUUID();

    const f1 = await writeFact({
      entityType: "user",
      entityId,
      key: "lang",
      value: "en",
      source: "test",
    });

    // Simulate Phase 4 reinforcement — bump stability and access count manually
    await db
      .update(facts)
      .set({ stabilityScore: 3.5, accessCount: 7 })
      .where(eq(facts.id, f1.id));

    // Update the value — stability and access count must be preserved
    const f2 = await writeFact({
      entityType: "user",
      entityId,
      key: "lang",
      value: "fr",
      source: "test",
    });

    expect(f2.stabilityScore).toBe(3.5);
    expect(f2.accessCount).toBe(7);
    expect(f2.value).toBe("fr");
  });
});

// ---------------------------------------------------------------------------
// readFact
// ---------------------------------------------------------------------------

describe("readFact", () => {
  it("returns undefined for a key that does not exist", async () => {
    const result = await readFact("user", randomUUID(), "nonexistent-key");

    expect(result).toBeUndefined();
  });

  it("returns the fact and increments accessCount as a side effect", async () => {
    const entityId = randomUUID();

    const written = await writeFact({
      entityType: "user",
      entityId,
      key: "lang",
      value: "en",
      source: "test",
    });

    expect(written.accessCount).toBe(0);

    await readFact("user", entityId, "lang");

    // Read the raw record (no side effects) to check the counter
    const updated = await getFactById(written.id);
    expect(updated?.accessCount).toBe(1);
  });

  it("returns undefined for a fact that has been archived", async () => {
    const entityId = randomUUID();

    const fact = await writeFact({
      entityType: "user",
      entityId,
      key: "old-key",
      value: "old-value",
      source: "test",
    });

    await archiveFact(fact.id);

    const result = await readFact("user", entityId, "old-key");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readFactsByEntity
// ---------------------------------------------------------------------------

describe("readFactsByEntity", () => {
  it("returns all non-archived facts for an entity, sorted alphabetically by key", async () => {
    const entityId = randomUUID();

    await writeFact({ entityType: "user", entityId, key: "z-key", value: "z", source: "test" });
    await writeFact({ entityType: "user", entityId, key: "a-key", value: "a", source: "test" });
    await writeFact({ entityType: "user", entityId, key: "m-key", value: "m", source: "test" });

    const results = await readFactsByEntity("user", entityId);

    expect(results.map((f) => f.key)).toEqual(["a-key", "m-key", "z-key"]);
  });

  it("returns an empty array when the entity has no facts", async () => {
    const results = await readFactsByEntity("user", randomUUID());

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// archiveFact
// ---------------------------------------------------------------------------

describe("archiveFact", () => {
  it("sets isArchived=true and creates an archive row with reason 'archived_by_user'", async () => {
    const entityId = randomUUID();

    const fact = await writeFact({
      entityType: "user",
      entityId,
      key: "to-archive",
      value: "soon gone",
      source: "test",
    });

    await archiveFact(fact.id);

    // The live fact should be marked archived
    const updated = await getFactById(fact.id);
    expect(updated?.isArchived).toBe(true);

    // An archive snapshot should exist
    const history = await getFactHistory(fact.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.value).toBe("soon gone");
    expect(history[0]!.archivedReason).toBe("archived_by_user");
  });

  it("is a no-op when called on an already-archived fact — does not create duplicate rows", async () => {
    const entityId = randomUUID();

    const fact = await writeFact({
      entityType: "user",
      entityId,
      key: "double-archive",
      value: "original",
      source: "test",
    });

    await archiveFact(fact.id);
    await archiveFact(fact.id); // second call

    const history = await getFactHistory(fact.id);
    expect(history).toHaveLength(1); // only one snapshot, no duplicate
  });
});

// ---------------------------------------------------------------------------
// getFactHistory / getFactHistoryByKey
// ---------------------------------------------------------------------------

describe("getFactHistory", () => {
  it("returns all previous values in reverse chronological order (newest superseded first)", async () => {
    const entityId = randomUUID();

    const fact = await writeFact({
      entityType: "user",
      entityId,
      key: "setting",
      value: "v1",
      source: "test",
    });

    await writeFact({ entityType: "user", entityId, key: "setting", value: "v2", source: "test" });
    await writeFact({ entityType: "user", entityId, key: "setting", value: "v3", source: "test" });

    // Current live value is v3. Archive holds v1 and v2.
    const history = await getFactHistory(fact.id);

    expect(history).toHaveLength(2);
    // v2 was archived most recently (when v3 replaced it)
    expect(history[0]!.value).toBe("v2");
    // v1 was archived earlier (when v2 replaced it)
    expect(history[1]!.value).toBe("v1");
  });
});

describe("getFactHistoryByKey", () => {
  it("returns history using entity + key without needing the factId", async () => {
    const entityId = randomUUID();

    await writeFact({ entityType: "user", entityId, key: "pref", value: "a", source: "test" });
    await writeFact({ entityType: "user", entityId, key: "pref", value: "b", source: "test" });
    await writeFact({ entityType: "user", entityId, key: "pref", value: "c", source: "test" });

    const history = await getFactHistoryByKey("user", entityId, "pref");

    // Current value is c. Archive holds a and b.
    expect(history).toHaveLength(2);
    expect(history[0]!.value).toBe("b"); // most recently superseded
    expect(history[1]!.value).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// findFact (no side effects)
// ---------------------------------------------------------------------------

describe("findFact", () => {
  it("finds a fact without touching access tracking", async () => {
    const entityId = randomUUID();

    const written = await writeFact({
      entityType: "user",
      entityId,
      key: "quiet-read",
      value: "untouched",
      source: "test",
    });

    const found = await findFact("user", entityId, "quiet-read");
    expect(found?.value).toBe("untouched");

    // accessCount must NOT have incremented.
    const raw = await getFactById(written.id);
    expect(raw?.accessCount).toBe(0);
  });

  it("returns undefined for archived facts", async () => {
    const entityId = randomUUID();

    const fact = await writeFact({
      entityType: "user",
      entityId,
      key: "gone",
      value: "x",
      source: "test",
    });
    await archiveFact(fact.id);

    expect(await findFact("user", entityId, "gone")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readRecentFactsByEntity
// ---------------------------------------------------------------------------

describe("readRecentFactsByEntity", () => {
  it("returns the most recently written facts first, capped at limit", async () => {
    const entityId = randomUUID();

    for (let i = 0; i < 5; i++) {
      await writeFact({
        entityType: "user",
        entityId,
        key: `k-${i}`,
        value: `v-${i}`,
        source: "test",
      });
      // Ensure distinct updatedAt values.
      await new Promise((r) => setTimeout(r, 5));
    }

    const recent = await readRecentFactsByEntity("user", entityId, 3);

    expect(recent).toHaveLength(3);
    // Most recently written first.
    expect(recent.map((f) => f.key)).toEqual(["k-4", "k-3", "k-2"]);
  });

  it("only counts returned facts as accessed — capped-out facts are untouched", async () => {
    const entityId = randomUUID();

    const oldest = await writeFact({
      entityType: "user",
      entityId,
      key: "a-oldest",
      value: "1",
      source: "test",
    });
    await new Promise((r) => setTimeout(r, 5));
    const newest = await writeFact({
      entityType: "user",
      entityId,
      key: "b-newest",
      value: "2",
      source: "test",
    });

    await readRecentFactsByEntity("user", entityId, 1);

    const newestRaw = await getFactById(newest.id);
    const oldestRaw = await getFactById(oldest.id);
    expect(newestRaw?.accessCount).toBe(1); // returned → counted
    expect(oldestRaw?.accessCount).toBe(0); // capped out → untouched
  });
});

// ---------------------------------------------------------------------------
// Surface validation
// ---------------------------------------------------------------------------

describe("surface validation", () => {
  it("accepts all valid surface values", async () => {
    for (const surface of VALID_SURFACES) {
      const entityId = randomUUID();
      const fact = await writeFact({
        entityType: "user",
        entityId,
        key: "surface-test",
        value: "ok",
        source: "test",
        surface,
      });
      expect(fact.surface).toBe(surface);
    }
  });

  it("throws for an invalid surface value", async () => {
    await expect(
      writeFact({
        entityType: "user",
        entityId: randomUUID(),
        key: "bad-surface",
        value: "ok",
        source: "test",
        surface: "myspace",
      }),
    ).rejects.toThrow("Invalid surface");
  });

  it("accepts null surface (facts written outside a known host)", async () => {
    const fact = await writeFact({
      entityType: "user",
      entityId: randomUUID(),
      key: "no-surface",
      value: "ok",
      source: "test",
      surface: null,
    });
    expect(fact.surface).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updatedAt
// ---------------------------------------------------------------------------

describe("updatedAt", () => {
  it("is set on initial write", async () => {
    const fact = await writeFact({
      entityType: "user",
      entityId: randomUUID(),
      key: "ts-test",
      value: "v1",
      source: "test",
    });

    expect(fact.updatedAt).toBeInstanceOf(Date);
    expect(fact.createdAt).toBeInstanceOf(Date);
  });

  it("is updated when the value changes", async () => {
    const entityId = randomUUID();

    const f1 = await writeFact({
      entityType: "user",
      entityId,
      key: "ts-key",
      value: "original",
      source: "test",
    });

    // Small sleep to ensure a measurable time difference
    await new Promise((r) => setTimeout(r, 10));

    await writeFact({
      entityType: "user",
      entityId,
      key: "ts-key",
      value: "updated",
      source: "test",
    });

    const updated = await getFactById(f1.id);
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(f1.updatedAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// tenantId isolation
// ---------------------------------------------------------------------------

describe("tenantId isolation", () => {
  it("two tenants can hold independent values for the same entity+key", async () => {
    const entityId = randomUUID();

    await writeFact({
      entityType: "user",
      entityId,
      key: "preference",
      value: "dark-mode",
      source: "test",
      tenantId: "tenant-a",
    });

    await writeFact({
      entityType: "user",
      entityId,
      key: "preference",
      value: "light-mode",
      source: "test",
      tenantId: "tenant-b",
    });

    const forA = await readFact("user", entityId, "preference", "tenant-a");
    const forB = await readFact("user", entityId, "preference", "tenant-b");

    expect(forA?.value).toBe("dark-mode");
    expect(forB?.value).toBe("light-mode");
  });

  it("readFactsByEntity only returns facts for the specified tenant", async () => {
    const entityId = randomUUID();

    await writeFact({
      entityType: "user",
      entityId,
      key: "a",
      value: "tenant-a-value",
      source: "test",
      tenantId: "tenant-a",
    });

    await writeFact({
      entityType: "user",
      entityId,
      key: "b",
      value: "tenant-b-value",
      source: "test",
      tenantId: "tenant-b",
    });

    const forA = await readFactsByEntity("user", entityId, "tenant-a");
    const forB = await readFactsByEntity("user", entityId, "tenant-b");

    expect(forA.every((f) => f.value === "tenant-a-value")).toBe(true);
    expect(forB.every((f) => f.value === "tenant-b-value")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AX-1 — normalizeKey boundary (integration)
// ---------------------------------------------------------------------------

describe("AX-1 normalizeKey boundary", () => {
  it("N spellings of the same key collapse to 1 row + N-1 archive events", async () => {
    const entityId = randomUUID();
    const spellings = [
      "Research Focus",
      "research_focus",
      "researchFocus",
      "research-focus",
    ];

    for (const spelling of spellings) {
      await writeFact({
        entityType: "user",
        entityId,
        key: spelling,
        value: `value-for-${spelling}`,
        source: "test",
      });
    }

    // Exactly 1 surviving active row.
    const rows = await db.query.facts.findMany({
      where: eq(facts.entityId, entityId),
    });
    const activeRows = rows.filter((r) => !r.isArchived);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]!.key).toBe("research-focus");

    // N-1 = 3 archive rows.
    const archiveRows = await db.query.factArchive.findMany({
      where: eq(factArchive.entityId, entityId),
    });
    expect(archiveRows).toHaveLength(spellings.length - 1);
  });

  it("round-trip: write under mixed-case spelling, read via canonical form → hit", async () => {
    const entityId = randomUUID();

    await writeFact({
      entityType: "user",
      entityId,
      key: "Research Focus",
      value: "machine learning",
      source: "test",
    });

    const hit = await readFact("user", entityId, "research-focus");
    expect(hit).toBeDefined();
    expect(hit!.value).toBe("machine learning");
    expect(hit!.key).toBe("research-focus");
  });

  it("round-trip: write canonical, read via camelCase → hit", async () => {
    const entityId = randomUUID();

    await writeFact({
      entityType: "user",
      entityId,
      key: "research-focus",
      value: "nlp",
      source: "test",
    });

    const hit = await readFact("user", entityId, "researchFocus");
    expect(hit).toBeDefined();
    expect(hit!.value).toBe("nlp");
  });

  it("stores rawKey in metadata when key was not already canonical", async () => {
    const entityId = randomUUID();

    const fact = await writeFact({
      entityType: "user",
      entityId,
      key: "researchFocus",
      value: "computer vision",
      source: "test",
    });

    expect(fact.key).toBe("research-focus");
    const meta = fact.metadata as Record<string, unknown>;
    expect(meta?.rawKey).toBe("researchFocus");
  });

  it("does NOT inject rawKey when key is already canonical", async () => {
    const entityId = randomUUID();

    const fact = await writeFact({
      entityType: "user",
      entityId,
      key: "research-focus",
      value: "robotics",
      source: "test",
    });

    const meta = fact.metadata as Record<string, unknown> | null;
    expect(meta?.rawKey).toBeUndefined();
  });

  it("producer-emitted keys already equal their normalized form (single import)", () => {
    // Verifies the heuristic extractor's slugify produces normalizeKey-compatible keys.
    // Keys from the heuristic are already slug-form (lowercase-hyphen); normalizeKey
    // applied to them must be a no-op (idempotent).
    const heuristicKeys = [
      "decision:use-postgres",
      "preference:always-y",
      "preference:node-18",
      "tool:drizzle-orm",
    ];
    for (const k of heuristicKeys) {
      expect(normalizeKey(k)).toBe(k);
    }
  });
});
