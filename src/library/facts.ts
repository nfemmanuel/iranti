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

import { and, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  factArchive,
  facts,
  type Fact,
  type FactArchive,
  type NewFact,
} from "../db/schema.js";
import {
  checkConflict,
  createEscalation,
  recordSupersession,
  runDeepConflictCheck,
} from "./conflicts.js";
import { getScore } from "./source-reliability.js";
import { graph } from "../graph/index.js";

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

// ---------------------------------------------------------------------------
// Write-time edge recording — Phase 2.5 (CORE-29)
// ---------------------------------------------------------------------------

// Record co_write + about edges after a writeFact upsert. Fire-and-forget.
//   about:    fact → entity hub (directed). Lets Phase 3 traversal bridge
//             facts across entities via the entity node.
//   co_write: fact → previous fact written in the same session (undirected,
//             weight 0.5 — weaker evidence than co_access). Only fires when
//             sessionId is present.
async function recordWriteEdges(
  factId: string,
  entityType: string,
  entityId: string,
  sessionId: string | null | undefined,
  tenantId: string,
): Promise<void> {
  const ops: Promise<void>[] = [];

  // about edge: fact → entity
  ops.push(
    graph
      .reinforceEdge(
        { type: "fact", id: factId },
        { type: "entity", id: `${entityType}/${entityId}` },
        "about",
        1,
        tenantId,
      )
      .catch((err: unknown) => console.error("[iranti] about edge error:", err)),
  );

  // co_write edge: fact → previous fact in this session
  if (sessionId) {
    ops.push(
      (async () => {
        const prev = await db.query.facts.findFirst({
          where: and(
            eq(facts.tenantId, tenantId),
            eq(facts.sessionId, sessionId),
            eq(facts.isArchived, false),
            ne(facts.id, factId),
          ),
          orderBy: desc(facts.createdAt),
        });
        if (!prev) return;
        await graph.reinforceEdge(
          { type: "fact", id: factId },
          { type: "fact", id: prev.id },
          "co_write",
          0.5,
          tenantId,
        );
      })().catch((err: unknown) => console.error("[iranti] co_write edge error:", err)),
    );
  }

  await Promise.all(ops);
}

// ---------------------------------------------------------------------------
// D7 confidence formula (CORE-27)
// ---------------------------------------------------------------------------

// stored_confidence = clamp(base × (0.5 + sourceScore), 0, 1)
// A neutral source (0.5) is identity: 1.0 × 1.0 = 1.0. A fully trusted
// source (1.0) boosts ×1.5 (clamped to 1.0). A fully distrusted source
// (0.0) halves the confidence. Deterministic and auditable from the
// source_reliability table alone.
function applyConfidenceFormula(base: number, sourceScore: number): number {
  return Math.min(1.0, Math.max(0.0, base * (0.5 + sourceScore)));
}

// ---------------------------------------------------------------------------

// Write a fact. If a fact with this (entityType, entityId, key) already
// exists, snapshot the old value to fact_archive, then replace it.
// Returns the written fact.
//
// Throws if the existing fact is protected (isProtected = true).
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
  > & { confidence?: number },
): Promise<Fact> {
  // Validate surface before touching the database.
  assertValidSurface(input.surface);

  const tenantId = input.tenantId ?? "default";

  return db.transaction(async (tx) => {
    // Advisory lock: serialize concurrent writes to the same (tenant, entity, key)
    // for the duration of this transaction. Without this, two writers can both
    // pass the protection check and both snapshot the old value to fact_archive,
    // producing duplicate history. pg_advisory_xact_lock releases automatically
    // when the transaction commits or rolls back. The ::bigint cast avoids
    // ambiguity between the single-bigint and two-int overloads of the function.
    const lockKey = `${tenantId}/${input.entityType}/${input.entityId}/${input.key}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`);

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

    // Step 2.5 (Phase 2b): Conflict detection. When a value is changing,
    // compare source reliability scores. If the existing source is
    // significantly more trusted, escalate instead of superseding.
    if (existing && existing.value !== input.value) {
      const outcome = await checkConflict(existing, input.value, input.source, tenantId);
      if (outcome === "escalate") {
        // Block the write. Write an escalation record + markdown file.
        // The transaction is still committed — we're just returning early
        // without updating the fact or creating an archive entry.
        await createEscalation(
          {
            tenantId,
            entityType: input.entityType,
            entityId: input.entityId,
            key: input.key,
            existingFact: existing,
            newValue: input.value,
            newSource: input.source,
            reason: "Existing source reliability significantly exceeds new source reliability",
          },
          tx,
        );
        return existing;
      }
      // outcome === "supersede": record the win/loss and continue.
      // recordSupersession runs outside the transaction (best-effort, non-blocking).
      void recordSupersession(input.source, existing.source, tenantId).catch(
        (err: unknown) => console.error("[iranti] reliability update error:", err),
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

    // Step 3.5 (Phase 2.5, CORE-27): Confidence plumbing.
    // Apply D7 formula: stored = clamp(base × (0.5 + sourceScore)).
    // A neutral source (score 0.5) is identity-preserving (× 1.0), so
    // unchallenged explicit writes behave exactly as before.
    const sourceScore = await getScore(input.source, tenantId);
    const storedConfidence = applyConfidenceFormula(input.confidence ?? 1.0, sourceScore);

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
        confidence: storedConfidence,
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
          confidence: storedConfidence,
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

    // Step 5 (Phase 2b): Deep conflict check — fire-and-forget, never blocks.
    // Checks whether the new value negates a term present in another fact
    // for this entity. Increments comprehensionMetrics.deepConflictsDetected
    // for each candidate found, but does not auto-resolve.
    void runDeepConflictCheck(
      input.entityType,
      input.entityId,
      input.key,
      input.value,
      tenantId,
    ).catch((err: unknown) =>
      console.error("[iranti] deep conflict check error:", err),
    );

    // Step 6 (Phase 2.5, CORE-29): Write-time edges — fire-and-forget.
    // about: fact→entity hub. co_write: fact→prev fact in same session.
    void recordWriteEdges(
      fact!.id,
      input.entityType,
      input.entityId,
      input.sessionId,
      tenantId,
    ).catch((err: unknown) =>
      console.error("[iranti] write edge error:", err),
    );

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

// Find a fact by entity and key WITHOUT side effects. Unlike readFact, this
// does not touch lastAccessedAt or accessCount. Use it for existence checks
// and resolution (e.g. "which fact does this entity+key refer to?") where
// the access should not count as a memory retrieval.
export async function findFact(
  entityType: string,
  entityId: string,
  key: string,
  tenantId: string = "default",
): Promise<Fact | undefined> {
  return db.query.facts.findFirst({
    where: and(
      eq(facts.tenantId, tenantId),
      eq(facts.entityType, entityType),
      eq(facts.entityId, entityId),
      eq(facts.key, key),
      eq(facts.isArchived, false),
    ),
  });
}

// Read the most recently written facts for an entity, capped at `limit`.
// Ordered by updatedAt DESC — facts whose values changed most recently come
// first. This is the retrieval shape iranti_attend uses: bounded and
// recency-ordered, so the injection block cannot grow without limit as an
// entity accumulates facts.
//
// Updates lastAccessedAt and accessCount only on the facts actually returned
// — facts cut off by the cap are not counted as accessed, so the cap does
// not distort Phase 4 reinforcement data.
export async function readRecentFactsByEntity(
  entityType: string,
  entityId: string,
  limit: number,
  tenantId: string = "default",
): Promise<Fact[]> {
  const found = await db.query.facts.findMany({
    where: and(
      eq(facts.tenantId, tenantId),
      eq(facts.entityType, entityType),
      eq(facts.entityId, entityId),
      eq(facts.isArchived, false),
    ),
    orderBy: desc(facts.updatedAt),
    limit,
  });

  if (found.length === 0) return [];

  const ids = found.map((f) => f.id);
  await db
    .update(facts)
    .set({
      lastAccessedAt: new Date(),
      accessCount: sql`${facts.accessCount} + 1`,
    })
    .where(inArray(facts.id, ids));

  return found;
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
// Relevance-scored retrieval (for iranti_attend)
// ---------------------------------------------------------------------------

// Tokenize text for keyword overlap scoring.
// Lowercases, splits on non-alphanumeric boundaries, dedupes, filters tokens
// that are too short or are common stop words.
function tokenizeMessage(text: string): string[] {
  const stop = new Set([
    "the", "and", "for", "are", "was", "with", "that", "this",
    "have", "from", "not", "you", "all", "can", "had", "get",
    "has", "how", "but", "did", "she", "use", "its", "our",
  ]);
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !stop.has(t)),
    ),
  ];
}

// Score a fact's relevance to a set of query tokens.
// Key token matches weight 2×; value substring matches weight 1×.
function scoreRelevance(fact: Fact, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const keyTokens = new Set(fact.key.toLowerCase().split(/[^a-z0-9]+/));
  const valueText = fact.value.slice(0, 300).toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (keyTokens.has(t)) score += 2;
    if (valueText.includes(t)) score += 1;
  }
  return score;
}

// Fetch facts relevant to a message for a given entity.
// When no message is provided, delegates to readRecentFactsByEntity.
// With a message, fetches a wider candidate pool (up to 3× limit, max 50),
// scores by keyword overlap in key + value, and returns the top `limit`
// by score then recency. Access tracking fires only on returned rows.
export async function readRelevantFactsByEntity(
  entityType: string,
  entityId: string,
  limit: number,
  message?: string,
  tenantId: string = "default",
): Promise<Fact[]> {
  if (!message) {
    return readRecentFactsByEntity(entityType, entityId, limit, tenantId);
  }

  const tokens = tokenizeMessage(message);
  if (tokens.length === 0) {
    return readRecentFactsByEntity(entityType, entityId, limit, tenantId);
  }

  const candidateLimit = Math.min(limit * 3, 50);
  const candidates = await db.query.facts.findMany({
    where: and(
      eq(facts.tenantId, tenantId),
      eq(facts.entityType, entityType),
      eq(facts.entityId, entityId),
      eq(facts.isArchived, false),
    ),
    orderBy: desc(facts.updatedAt),
    limit: candidateLimit,
  });

  if (candidates.length === 0) return [];

  const scored = candidates.map((f) => ({
    fact: f,
    score: scoreRelevance(f, tokens),
  }));
  const anyMatch = scored.some((s) => s.score > 0);

  // No keyword match at all — fall back to pure recency.
  if (!anyMatch) {
    const top = candidates.slice(0, limit);
    const ids = top.map((f) => f.id);
    await db
      .update(facts)
      .set({ lastAccessedAt: new Date(), accessCount: sql`${facts.accessCount} + 1` })
      .where(inArray(facts.id, ids));
    return top;
  }

  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : b.fact.updatedAt.getTime() - a.fact.updatedAt.getTime(),
  );

  const top = scored.slice(0, limit).map((s) => s.fact);
  const ids = top.map((f) => f.id);
  await db
    .update(facts)
    .set({ lastAccessedAt: new Date(), accessCount: sql`${facts.accessCount} + 1` })
    .where(inArray(facts.id, ids));

  return top;
}

// Look up multiple facts by their IDs. No side effects — does not update
// lastAccessedAt or accessCount. Used by the secondary (graph-hop) retrieval
// pass so peripheral suggestions don't inflate access counters.
export async function readFactsByIds(
  ids: string[],
  tenantId: string = "default",
): Promise<Fact[]> {
  if (ids.length === 0) return [];
  return db.query.facts.findMany({
    where: and(
      eq(facts.tenantId, tenantId),
      inArray(facts.id, ids),
      eq(facts.isArchived, false),
    ),
  });
}

// CORE-17: look up the most recent archived (superseded) value for each fact.
// Returns a Map<factId, oldValue>. Facts with no archive entry are absent from
// the map. Used by stale-context correction to detect when the host window holds
// a value that has since been overwritten.
export async function readArchivedValuesByFactIds(
  ids: string[],
  tenantId: string = "default",
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      factId: factArchive.factId,
      value: factArchive.value,
    })
    .from(factArchive)
    .where(and(eq(factArchive.tenantId, tenantId), inArray(factArchive.factId, ids)))
    // Newest snapshot first; id breaks ties when two rows share archivedAt so the
    // winner is deterministic (a fact superseded twice in the same instant must
    // still resolve to one stable "old value").
    .orderBy(desc(factArchive.archivedAt), desc(factArchive.id));

  // First row seen per factId is the newest, given the ordering above.
  const best = new Map<string, string>();
  for (const row of rows) {
    if (!best.has(row.factId)) best.set(row.factId, row.value);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Full-text search (for iranti_search)
// ---------------------------------------------------------------------------

// Search facts by keyword across all entities or scoped to a specific one.
// Matches are case-insensitive against key and value.
// Access-tracks returned results (this is a real retrieval).
export async function searchFacts(
  query: string,
  opts: {
    entityType?: string;
    entityId?: string;
    limit?: number;
    tenantId?: string;
  } = {},
): Promise<Fact[]> {
  const { entityType, entityId, limit = 10, tenantId = "default" } = opts;
  const pattern = `%${query}%`;

  const found = await db.query.facts.findMany({
    where: and(
      eq(facts.tenantId, tenantId),
      eq(facts.isArchived, false),
      or(ilike(facts.key, pattern), ilike(facts.value, pattern)),
      entityType ? eq(facts.entityType, entityType) : undefined,
      entityId ? eq(facts.entityId, entityId) : undefined,
    ),
    orderBy: desc(facts.updatedAt),
    limit: Math.min(limit, 50),
  });

  if (found.length > 0) {
    const ids = found.map((f) => f.id);
    await db
      .update(facts)
      .set({ lastAccessedAt: new Date(), accessCount: sql`${facts.accessCount} + 1` })
      .where(inArray(facts.id, ids));
  }

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
