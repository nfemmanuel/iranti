// Integration tests — facts.ts
//
// The most complex module — tests cover:
//   writeFact (create, upsert, archive snapshot, protected guard, stability preservation)
//   readFact  (not found, access tracking, archived exclusion)
//   readFactsByEntity (ordering, empty entity)
//   archiveFact (marks archived, creates archive row, no-op on already-archived)
//   getFactHistory / getFactHistoryByKey

import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, pool } from "../db/connection.js";
import { facts } from "../db/schema.js";
import {
  archiveFact,
  getFactById,
  getFactHistory,
  getFactHistoryByKey,
  readFact,
  readFactsByEntity,
  writeFact,
} from "../library/facts.js";

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
