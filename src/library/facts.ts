// Fact storage — Phase 0
//
// The core of iranti's library layer. A fact is a piece of information about
// an entity: { entity: "user/alice", key: "timezone", value: "UTC+1" }.
//
// Key behaviours:
//   - Writing a fact with the same (entityType, entityId, key) snapshots
//     the old value to fact_archive (reason: "superseded"), then replaces it.
//     One current value per key, per entity — but full history is preserved.
//   - Writing a protected fact throws an error. Protected facts can only be
//     changed by an explicit admin operation (added in Phase 2).
//   - Reading a fact updates its lastAccessedAt and increments accessCount.
//     This data feeds memory decay and Hebbian reinforcement in Phase 4.
//   - Archiving a fact snapshots the current value to fact_archive
//     (reason: "archived_by_user"), then sets isArchived = true.
//     This is irreversible in Phase 0.
//   - Facts are never hard-deleted.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  factArchive,
  facts,
  type Fact,
  type FactArchive,
  type NewFact,
} from "../db/schema.js";

// ---------------------------------------------------------------------------
// Surface validation
// ---------------------------------------------------------------------------

// Allowed AI host surfaces. Every fact can carry the name of the platform
// that wrote it. This is enforced at write time so the column stays clean.
// Matches the Surface enum from iranti v0.
export const VALID_SURFACES = [
  "claude",
  "chatgpt",
  "gemini",
  "deepseek",
  "dev_cli",
  "web_ui",
  "manual",
] as const;

export type FactSurface = (typeof VALID_SURFACES)[number];

function assertValidSurface(surface: string | null | undefined): void {
  if (surface == null) return;
  if (!(VALID_SURFACES as readonly string[]).includes(surface)) {
    throw new Error(
      `Invalid surface "${surface}". Allowed values: ${VALID_SURFACES.join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

// Write a fact. If a fact with this (entityType, entityId, key) already
// exists, snapshot the old value to fact_archive, then replace it.
// Returns the written fact.
//
// Throws if the existing fact is protected (isProtected = true).
//
// Note on race conditions: this runs in a transaction, but does not use
// SELECT FOR UPDATE. Under concurrent load, two simultaneous writes to the
// same (entityType, entityId, key) could both pass the protection check and
// both attempt to snapshot. The onConflictDoUpdate ensures only one value
// survives, but the archive snapshot may be duplicated. Phase 2 will add
// advisory locks or row-level locking to close this gap.
export async function writeFact(
  input: Pick<
    NewFact,
    | "entityType"
    | "entityId"
    | "key"
    | "value"
    | "source"
    | "surface"
    | "tenantId"
    | "sessionId"
    | "agentId"
    | "metadata"
  >,
): Promise<Fact> {
  // Validate surface before touching the database.
  assertValidSurface(input.surface);

  const tenantId = input.tenantId ?? "default";

  return db.transaction(async (tx) => {
    // Step 1: Check whether a fact already exists for this key within this tenant.
    const existing = await tx.query.facts.findFirst({
      where: and(
        eq(facts.tenantId, tenantId),
        eq(facts.entityType, input.entityType),
        eq(facts.entityId, input.entityId),
        eq(facts.key, input.key),
        // Only consider non-archived facts. An archived fact no longer
        // holds the "current value" slot — writing a new fact with the
        // same key after archiving creates a fresh fact.
        eq(facts.isArchived, false),
      ),
    });

    // Step 2: Refuse if protected.
    if (existing?.isProtected) {
      throw new Error(
        `Fact "${input.entityType}/${input.entityId}/${input.key}" is protected ` +
          `and cannot be overwritten. Use an admin operation to change it.`,
      );
    }

    // Step 3: If the value is changing, snapshot the old row to fact_archive.
    // We only snapshot when the value actually differs — re-writing the same
    // value with the same key produces no archive row.
    if (existing && existing.value !== input.value) {
      await tx.insert(factArchive).values({
        factId: existing.id,
        tenantId: existing.tenantId,
        entityType: existing.entityType,
        entityId: existing.entityId,
        key: existing.key,
        value: existing.value,
        confidence: existing.confidence,
        source: existing.source,
        surface: existing.surface,
        sessionId: existing.sessionId,
        agentId: existing.agentId,
        stabilityScore: existing.stabilityScore,
        accessCount: existing.accessCount,
        metadata: existing.metadata,
        archivedReason: "superseded",
      });
    }

    // Step 4: Upsert the fact.
    // On a brand-new fact: inserts a fresh row with all defaults.
    // On an existing fact: updates value, source, surface, session, updatedAt,
    // and lastAccessedAt. Does NOT reset stabilityScore or accessCount — those
    // are cumulative signals that survive fact updates.
    const [fact] = await tx
      .insert(facts)
      .values({
        ...input,
        tenantId,
        confidence: 1.0,
        stabilityScore: existing?.stabilityScore ?? 1.0,
        accessCount: existing?.accessCount ?? 0,
        isProtected: false,
        isArchived: false,
      })
      .onConflictDoUpdate({
        // Conflict target: same tenant + entity + key.
        target: [facts.tenantId, facts.entityType, facts.entityId, facts.key],
        set: {
          value: input.value,
          confidence: 1.0,
          source: input.source,
          surface: input.surface,
          sessionId: input.sessionId,
          agentId: input.agentId,
          metadata: input.metadata,
          updatedAt: new Date(),
          lastAccessedAt: new Date(),
          // stabilityScore and accessCount are intentionally not reset.
        },
      })
      .returning();

    return fact!;
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Read a single fact by entity and key. Returns undefined if not found.
// Updates lastAccessedAt and increments accessCount as a side effect.
export async function readFact(
  entityType: string,
  entityId: string,
  key: string,
  tenantId: string = "default",
): Promise<Fact | undefined> {
  const fact = await db.query.facts.findFirst({
    where: and(
      eq(facts.tenantId, tenantId),
      eq(facts.entityType, entityType),
      eq(facts.entityId, entityId),
      eq(facts.key, key),
      eq(facts.isArchived, false),
    ),
  });

  if (!fact) return undefined;

  // Record that this fact was accessed. Used by decay and reinforcement.
  await db
    .update(facts)
    .set({
      lastAccessedAt: new Date(),
      accessCount: sql`${facts.accessCount} + 1`,
    })
    .where(eq(facts.id, fact.id));

  return fact;
}

// Read all facts for an entity. Returns them sorted by key.
// Updates lastAccessedAt and accessCount on every returned fact.
export async function readFactsByEntity(
  entityType: string,
  entityId: string,
  tenantId: string = "default",
): Promise<Fact[]> {
  const found = await db.query.facts.findMany({
    where: and(
      eq(facts.tenantId, tenantId),
      eq(facts.entityType, entityType),
      eq(facts.entityId, entityId),
      eq(facts.isArchived, false),
    ),
    orderBy: facts.key,
  });

  if (found.length === 0) return [];

  // Batch-update all retrieved facts in one query.
  const ids = found.map((f) => f.id);
  await db
    .update(facts)
    .set({
      lastAccessedAt: new Date(),
      accessCount: sql`${facts.accessCount} + 1`,
    })
    .where(
      // inArray generates a proper "WHERE id IN (...)" clause.
      inArray(facts.id, ids),
    );

  return found;
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

// Archive a fact. Snapshots the current value to fact_archive, then sets
// isArchived = true. The fact will no longer appear in normal reads.
//
// This is the permanent operation in Phase 0. Once archived, a fact cannot
// be unarchived. Its full value history survives in fact_archive.
export async function archiveFact(factId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Get the current live fact.
    const fact = await tx.query.facts.findFirst({
      where: eq(facts.id, factId),
    });

    // Nothing to do if the fact doesn't exist or is already archived.
    if (!fact || fact.isArchived) return;

    // Snapshot the current value to fact_archive before marking it inactive.
    await tx.insert(factArchive).values({
      factId: fact.id,
      tenantId: fact.tenantId,
      entityType: fact.entityType,
      entityId: fact.entityId,
      key: fact.key,
      value: fact.value,
      confidence: fact.confidence,
      source: fact.source,
      surface: fact.surface,
      sessionId: fact.sessionId,
      agentId: fact.agentId,
      stabilityScore: fact.stabilityScore,
      accessCount: fact.accessCount,
      metadata: fact.metadata,
      archivedReason: "archived_by_user",
    });

    // Mark the fact as archived.
    await tx.update(facts).set({ isArchived: true }).where(eq(facts.id, factId));
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

// Get the full history of a fact — every value it has ever held,
// from most recent change to oldest. Excludes the current live value
// (which lives in the facts table).
//
// Example: a fact whose timezone was changed UTC → UTC+1 → UTC+2 will
// return two rows: [{value: "UTC+1", archivedReason: "superseded"}, {value: "UTC", ...}]
export async function getFactHistory(factId: string): Promise<FactArchive[]> {
  return db.query.factArchive.findMany({
    where: eq(factArchive.factId, factId),
    orderBy: desc(factArchive.archivedAt),
  });
}

// Get the history of a fact by entity + key, without needing the factId.
// Useful before you've read the current fact.
export async function getFactHistoryByKey(
  entityType: string,
  entityId: string,
  key: string,
  tenantId: string = "default",
): Promise<FactArchive[]> {
  return db.query.factArchive.findMany({
    where: and(
      eq(factArchive.tenantId, tenantId),
      eq(factArchive.entityType, entityType),
      eq(factArchive.entityId, entityId),
      eq(factArchive.key, key),
    ),
    orderBy: desc(factArchive.archivedAt),
  });
}

// ---------------------------------------------------------------------------
// Inspect (no side effects — for debugging and tests)
// ---------------------------------------------------------------------------

// Get a fact by ID without updating any counters.
// Used in tests and internal tooling where you want the raw record.
export async function getFactById(factId: string): Promise<Fact | undefined> {
  return db.query.facts.findFirst({
    where: eq(facts.id, factId),
  });
}
