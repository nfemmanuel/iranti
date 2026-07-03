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
import { normalizeKey, withRawKey } from "./keys.js";
import { normalizeProjectId } from "./projects.js";
import { trackBackground } from "./background.js";

// ---------------------------------------------------------------------------
// Project scoping (Layer 0, D6/D7)
// ---------------------------------------------------------------------------

// Build the WHERE fragment for "in the effective project set". A single-
// element set (the common case: no combine active) degenerates to a plain
// equality, which reads identically to the pre-Layer-0 query plan. Callers
// that never pass a project default to the literal string "default" — the
// same fallback tenantId already uses — so every pre-existing call site
// (library callers, tests) keeps working unchanged.
//
// Every id is run through normalizeProjectId — mirroring normalizeKey's role
// at the fact-key write boundary — so a caller that passes a differently
// cased/slashed but equivalent path always lands on the same scope as the
// resolver's own (already-normalized) output.
function projectFilter(project: string | string[]) {
  const ids = Array.isArray(project) ? project : [project];
  const normalized = ids.map(normalizeProjectId);
  return normalized.length === 1
    ? eq(facts.project, normalized[0]!)
    : inArray(facts.project, normalized);
}

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
  project: string,
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
        project,
      )
      .catch((err: unknown) => console.error("[iranti] about edge error:", err)),
  );

  // co_write edge: fact → previous fact in this session
  // Layer 0 (D7): scoped to the writing project — a session is per-agent-
  // process, but the project it's operating in can only be one at a time
  // for write purposes, so this stays a plain equality (not the effective/
  // combined set) exactly like every other write-path lookup here.
  if (sessionId) {
    ops.push(
      (async () => {
        const prev = await db.query.facts.findFirst({
          where: and(
            eq(facts.tenantId, tenantId),
            eq(facts.project, project),
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
          project,
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
    | "project"
    | "sessionId"
    | "agentId"
    | "metadata"
  > & { confidence?: number },
): Promise<Fact> {
  // Validate surface before touching the database.
  assertValidSurface(input.surface);

  const tenantId = input.tenantId ?? "default";
  // Layer 0 (D7): writes always target the single current project — never
  // the effective (combined) set. Combine affects reads, not write
  // attribution (§11.6 of the PRD). Normalized at the write boundary (same
  // rationale as projectFilter above) so a raw caller-supplied path always
  // lands in the same scope a normalized read will later look for.
  const project = normalizeProjectId(input.project ?? "default");

  // Normalize the key at the write boundary (AX-1). All lookups, the advisory
  // lock, and the stored row use normalizedKey; the original spelling is
  // preserved in metadata.rawKey for provenance if it differs.
  const normalizedKey = normalizeKey(input.key);
  // A key made only of punctuation/separators normalizes to "". Storing it would
  // collapse every such key onto one shared empty slot, silently overwriting
  // unrelated facts — reject instead. Reads with an empty key simply miss.
  if (!normalizedKey) {
    throw new Error(
      `Fact key "${input.key}" normalizes to an empty string and cannot be stored. ` +
        `Provide a key with at least one alphanumeric character.`,
    );
  }
  const metadata =
    normalizedKey !== input.key
      ? withRawKey(input.metadata, input.key)
      : input.metadata;

  // Step 5/6 below (deep conflict check, write-time edges) are fire-and-forget
  // side effects that must never block the write. They used to be fired from
  // *inside* this transaction's callback (before `return fact!`), which is
  // safe on postgres-js (a connection pool — the detached query runs on a
  // different physical connection than the one mid-transaction) but is NOT
  // safe on embedded PGlite (Layer 0): PGlite is single-connection, and
  // firing a query on the module-level `db` while `tx`'s own COMMIT is still
  // being dispatched on that same connection races the transaction's commit
  // sequencing and can wedge the process (confirmed via reproduction while
  // building the PGlite engine switch — see connection.ts). So these two are
  // collected here and fired only after `db.transaction(...)` has fully
  // resolved (i.e., after commit), which is safe and equivalent in intent on
  // both engines — they were never meant to run before commit anyway.
  let postCommitFactId: string | undefined;
  let postCommitSupersession: { newSource: string; existingSource: string } | undefined;
  const result = await db.transaction(async (tx) => {
    // Advisory lock: serialize concurrent writes to the same
    // (tenant, project, entity, key) for the duration of this transaction.
    // Without this, two writers can both pass the protection check and both
    // snapshot the old value to fact_archive, producing duplicate history.
    // pg_advisory_xact_lock releases automatically when the transaction
    // commits or rolls back. The ::bigint cast avoids ambiguity between the
    // single-bigint and two-int overloads of the function.
    const lockKey = `${tenantId}/${project}/${input.entityType}/${input.entityId}/${normalizedKey}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`);

    // Step 1: Check whether a fact already exists for this key within this
    // tenant + project.
    const existing = await tx.query.facts.findFirst({
      where: and(
        eq(facts.tenantId, tenantId),
        eq(facts.project, project),
        eq(facts.entityType, input.entityType),
        eq(facts.entityId, input.entityId),
        eq(facts.key, normalizedKey),
        // Only consider non-archived facts. An archived fact no longer
        // holds the "current value" slot — writing a new fact with the
        // same key after archiving creates a fresh fact.
        eq(facts.isArchived, false),
      ),
    });

    // Step 2: Refuse if protected.
    if (existing?.isProtected) {
      throw new Error(
        `Fact "${input.entityType}/${input.entityId}/${normalizedKey}" is protected ` +
          `and cannot be overwritten. Use an admin operation to change it.`,
      );
    }

    // Step 2.5 (Phase 2b): Conflict detection. When a value is changing,
    // compare source reliability scores. If the existing source is
    // significantly more trusted, escalate instead of superseding.
    if (existing && existing.value !== input.value) {
      const outcome = await checkConflict(existing, input.value, input.source, tenantId, tx);
      if (outcome === "escalate") {
        // Block the write. Write an escalation record + markdown file.
        // The transaction is still committed — we're just returning early
        // without updating the fact or creating an archive entry.
        await createEscalation(
          {
            tenantId,
            entityType: input.entityType,
            entityId: input.entityId,
            key: normalizedKey,
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
      // recordSupersession is fired after this transaction resolves (see the
      // comment above db.transaction(...) — same single-connection-on-PGlite
      // reasoning), best-effort and non-blocking either way.
      postCommitSupersession = { newSource: input.source, existingSource: existing.source };
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
    const sourceScore = await getScore(input.source, tenantId, tx);
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
        key: normalizedKey,
        metadata,
        tenantId,
        project,
        confidence: storedConfidence,
        stabilityScore: existing?.stabilityScore ?? 1.0,
        accessCount: existing?.accessCount ?? 0,
        isProtected: false,
        isArchived: false,
      })
      .onConflictDoUpdate({
        // Conflict target: same tenant + project + entity + key.
        target: [facts.tenantId, facts.project, facts.entityType, facts.entityId, facts.key],
        set: {
          value: input.value,
          confidence: storedConfidence,
          source: input.source,
          surface: input.surface,
          sessionId: input.sessionId,
          agentId: input.agentId,
          metadata,
          updatedAt: new Date(),
          lastAccessedAt: new Date(),
          // stabilityScore and accessCount are intentionally not reset.
        },
      })
      .returning();

    // Steps 5/6 (deep conflict check, write-time edges) are fired after this
    // transaction resolves — see the comment above db.transaction(...) for
    // why. Stash the new fact's id so the caller can fire them post-commit.
    postCommitFactId = fact!.id;
    return fact!;
  });

  // trackBackground (not bare `void`) on all three post-commit side effects
  // so closeDb can settle them before teardown — RULE-2; see background.ts.
  if (postCommitSupersession) {
    trackBackground(
      recordSupersession(
        postCommitSupersession.newSource,
        postCommitSupersession.existingSource,
        tenantId,
      ).catch((err: unknown) => console.error("[iranti] reliability update error:", err)),
    );
  }

  // Step 5 (Phase 2b): Deep conflict check — fire-and-forget, never blocks.
  // Checks whether the new value negates a term present in another fact
  // for this entity. Increments comprehensionMetrics.deepConflictsDetected
  // for each candidate found, but does not auto-resolve. Skipped on the
  // escalate-and-return-early path (postCommitFactId stays unset there,
  // since no new fact was written — see the escalate branch above).
  if (postCommitFactId) {
    trackBackground(
      runDeepConflictCheck(
        input.entityType,
        input.entityId,
        normalizedKey,
        input.value,
        tenantId,
        project,
      ).catch((err: unknown) =>
        console.error("[iranti] deep conflict check error:", err),
      ),
    );

    // Step 6 (Phase 2.5, CORE-29): Write-time edges — fire-and-forget.
    // about: fact→entity hub. co_write: fact→prev fact in same session.
    trackBackground(
      recordWriteEdges(
        postCommitFactId,
        input.entityType,
        input.entityId,
        input.sessionId,
        tenantId,
        project,
      ).catch((err: unknown) =>
        console.error("[iranti] write edge error:", err),
      ),
    );
  }

  return result;
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
  project: string | string[] = "default",
): Promise<Fact | undefined> {
  const fact = await db.query.facts.findFirst({
    where: and(
      eq(facts.tenantId, tenantId),
      projectFilter(project),
      eq(facts.entityType, entityType),
      eq(facts.entityId, entityId),
      eq(facts.key, normalizeKey(key)),
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
  project: string | string[] = "default",
): Promise<Fact | undefined> {
  return db.query.facts.findFirst({
    where: and(
      eq(facts.tenantId, tenantId),
      projectFilter(project),
      eq(facts.entityType, entityType),
      eq(facts.entityId, entityId),
      eq(facts.key, normalizeKey(key)),
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
  project: string | string[] = "default",
): Promise<Fact[]> {
  const found = await db.query.facts.findMany({
    where: and(
      eq(facts.tenantId, tenantId),
      projectFilter(project),
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
  project: string | string[] = "default",
): Promise<Fact[]> {
  const found = await db.query.facts.findMany({
    where: and(
      eq(facts.tenantId, tenantId),
      projectFilter(project),
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
// Exported (Layer 0d): rules.ts's situational relevance filter reuses this
// exact tokenizer so "relevance" means the same thing for facts and rules
// codebase-wide — one tokenizer, not two independently-drifting copies.
export function tokenizeMessage(text: string): string[] {
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
        // Length floor of 3, EXCEPT digit-bearing 2-char tokens (s3, r2,
        // a1): function words never contain digits, so this admits the
        // short-identifier class (backlog RULE-1: a rule about "S3" could
        // never match on its defining token) with zero stop-word noise
        // risk. Pure-alpha 2-char acronyms (PR, UI, CI) remain excluded —
        // admitting them would admit every un-stopworded preposition too;
        // that residual is documented in RULE-1.
        .filter(
          (t) =>
            (t.length >= 3 || (t.length === 2 && /\d/.test(t))) &&
            !stop.has(t),
        ),
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

// Fetch facts relevant to a message for a given entity, and SAY which ones
// actually matched (Layer 0f). Returns the facts plus the set of fact ids
// whose relevance score was > 0 — i.e. facts that share vocabulary with the
// message. Facts returned via the no-message/no-token/no-overlap recency
// fallbacks are AMBIENT context: still returned (their value is real), but
// never in matchedIds, so a caller can tell "this relates to what was
// asked" from "this is just recent background." `matched` is a LEXICAL
// claim (keyword overlap), not a truth claim — documented in the PRD.
//
// When no message is provided, delegates to readRecentFactsByEntity.
// With a message, fetches a wider candidate pool (up to 3× limit, max 50),
// scores by keyword overlap in key + value, and returns the top `limit`
// by score then recency. Access tracking fires only on returned rows.
export async function readRelevantFactsWithMatch(
  entityType: string,
  entityId: string,
  limit: number,
  message?: string,
  tenantId: string = "default",
  project: string | string[] = "default",
): Promise<{ facts: Fact[]; matchedIds: Set<string> }> {
  if (!message) {
    return {
      facts: await readRecentFactsByEntity(entityType, entityId, limit, tenantId, project),
      matchedIds: new Set(),
    };
  }

  const tokens = tokenizeMessage(message);
  if (tokens.length === 0) {
    return {
      facts: await readRecentFactsByEntity(entityType, entityId, limit, tenantId, project),
      matchedIds: new Set(),
    };
  }

  const candidateLimit = Math.min(limit * 3, 50);
  const candidates = await db.query.facts.findMany({
    where: and(
      eq(facts.tenantId, tenantId),
      projectFilter(project),
      eq(facts.entityType, entityType),
      eq(facts.entityId, entityId),
      eq(facts.isArchived, false),
    ),
    orderBy: desc(facts.updatedAt),
    limit: candidateLimit,
  });

  if (candidates.length === 0) return { facts: [], matchedIds: new Set() };

  const scored = candidates.map((f) => ({
    fact: f,
    score: scoreRelevance(f, tokens),
  }));
  const anyMatch = scored.some((s) => s.score > 0);

  // No keyword match at all — fall back to pure recency (all ambient).
  if (!anyMatch) {
    const top = candidates.slice(0, limit);
    const ids = top.map((f) => f.id);
    await db
      .update(facts)
      .set({ lastAccessedAt: new Date(), accessCount: sql`${facts.accessCount} + 1` })
      .where(inArray(facts.id, ids));
    return { facts: top, matchedIds: new Set() };
  }

  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : b.fact.updatedAt.getTime() - a.fact.updatedAt.getTime(),
  );

  const topScored = scored.slice(0, limit);
  const top = topScored.map((s) => s.fact);
  const ids = top.map((f) => f.id);
  await db
    .update(facts)
    .set({ lastAccessedAt: new Date(), accessCount: sql`${facts.accessCount} + 1` })
    .where(inArray(facts.id, ids));

  // MATCHED requires a KEY-token hit, not merely a substring buried in the
  // value prose. Measured rationale (PRD 0f, revised after the first bench
  // run): with the loose any-overlap rule, 7 of 8 no-answer probes still
  // produced a matched fact — plausible questions naturally reuse domain
  // nouns ("ledger", "payment") that appear somewhere in some value, so the
  // flag over-claimed. A fact's key is its NAME; sharing vocabulary with
  // the name is a much stronger lexical claim than brushing its prose.
  // Ranking is unchanged (still full score); only the label is stricter.
  return {
    facts: top,
    matchedIds: new Set(
      topScored
        .filter((s) => hasKeyTokenMatch(s.fact, tokens))
        .map((s) => s.fact.id),
    ),
  };
}

// Does the message share at least one token with the fact's KEY?
// (Same tokenization rules on both sides; keys are normalizeKey'd at write
// time, so splitting on non-alphanumerics recovers their word tokens.)
function hasKeyTokenMatch(fact: Fact, tokens: string[]): boolean {
  const keyTokens = new Set(fact.key.toLowerCase().split(/[^a-z0-9]+/));
  return tokens.some((t) => keyTokens.has(t));
}

// Back-compat wrapper: same behavior as always, match info discarded.
// Existing callers/tests keep working unchanged; attend() uses the
// WithMatch variant to label its response (Layer 0f).
export async function readRelevantFactsByEntity(
  entityType: string,
  entityId: string,
  limit: number,
  message?: string,
  tenantId: string = "default",
  project: string | string[] = "default",
): Promise<Fact[]> {
  const { facts: result } = await readRelevantFactsWithMatch(
    entityType,
    entityId,
    limit,
    message,
    tenantId,
    project,
  );
  return result;
}

// Look up multiple facts by their IDs. No side effects — does not update
// lastAccessedAt or accessCount. Used by the secondary (graph-hop) retrieval
// pass so peripheral suggestions don't inflate access counters.
export async function readFactsByIds(
  ids: string[],
  tenantId: string = "default",
  project: string | string[] = "default",
): Promise<Fact[]> {
  if (ids.length === 0) return [];
  return db.query.facts.findMany({
    where: and(
      eq(facts.tenantId, tenantId),
      projectFilter(project),
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
    project?: string | string[];
  } = {},
): Promise<Fact[]> {
  const {
    entityType,
    entityId,
    limit = 10,
    tenantId = "default",
    project = "default",
  } = opts;
  // Key column stores normalized keys — match against the normalized query.
  // Value column is free-form text — keep the original query for that branch.
  const keyPattern = `%${normalizeKey(query)}%`;
  const valPattern = `%${query}%`;

  // Layer 0 (D7): search has NO entity scoping by default (it's the
  // "across all entities" tool) — project scoping is the only thing standing
  // between a search from project B and project A's content when both use
  // similar terms. This is exactly the adversarial-isolation case the PRD
  // calls out (shared keys, identical entity names, matching search terms).
  const found = await db.query.facts.findMany({
    where: and(
      eq(facts.tenantId, tenantId),
      projectFilter(project),
      eq(facts.isArchived, false),
      or(ilike(facts.key, keyPattern), ilike(facts.value, valPattern)),
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
// Returns true only when a live fact was actually archived by this call.
//
// `project` is the caller's effective project scope (Layer 0 isolation). When
// provided, a fact belonging to a project OUTSIDE that scope is treated
// exactly like a nonexistent fact (returns false) — deliberately
// indistinguishable, so a caller can't probe another project's fact ids for
// existence. MCP tool paths MUST pass the caller's effective project ids;
// omitting the param is for trusted in-process/internal use only (e.g.
// checkpoint rotation, tests), matching getFactById/getFactHistory below.
export async function archiveFact(
  factId: string,
  project?: string | string[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Get the current live fact.
    const fact = await tx.query.facts.findFirst({
      where: eq(facts.id, factId),
    });

    // Nothing to do if the fact doesn't exist or is already archived.
    if (!fact || fact.isArchived) return false;

    // Cross-project boundary check (see doc comment above). Normalize the
    // caller's ids before comparing — the stored fact.project is always the
    // normalized form (same rule as projectFilter; comparing raw paths here
    // would wrongly refuse the owner's own archive).
    if (project !== undefined) {
      const allowed = (Array.isArray(project) ? project : [project]).map(
        normalizeProjectId,
      );
      if (!allowed.includes(fact.project)) return false;
    }

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
    return true;
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
// `project`: the caller's effective project scope. When provided, history
// rows whose live fact belongs to another project are filtered out (join
// through facts.project — same pattern and rationale as getFactHistoryByKey
// below; fact_archive itself has no project column). A factId from another
// project returns [] — indistinguishable from an unknown id, so ids can't be
// probed across the boundary. MCP tool paths MUST pass this; omitting is for
// trusted in-process/test use only.
export async function getFactHistory(
  factId: string,
  project?: string | string[],
): Promise<FactArchive[]> {
  if (project === undefined) {
    return db.query.factArchive.findMany({
      where: eq(factArchive.factId, factId),
      orderBy: desc(factArchive.archivedAt),
    });
  }
  const rows = await db
    .select({ archive: factArchive })
    .from(factArchive)
    .innerJoin(facts, eq(factArchive.factId, facts.id))
    .where(and(eq(factArchive.factId, factId), projectFilter(project)))
    .orderBy(desc(factArchive.archivedAt));
  return rows.map((r) => r.archive);
}

// Get the history of a fact by entity + key, without needing the factId.
// Useful before you've read the current fact.
//
// Layer 0 (D7): fact_archive has NO project column (§11.1 — it's an audit
// table, not a retrieval surface with its own reader today), so it cannot be
// filtered by project directly. But it doesn't need to be: every archive row
// is denormalized from a specific live `facts` row via fact_id, and THAT row
// carries the project the archived value belonged to. So this joins against
// `facts` on fact_id and filters by project there — closing what would
// otherwise be a real leak vector (entityType/entityId/key is exactly what
// an attacker with a guessed or colliding entity name would supply from a
// different project's scope, e.g. the same "project/my-app" entity name
// reused by two unrelated folders).
export async function getFactHistoryByKey(
  entityType: string,
  entityId: string,
  key: string,
  tenantId: string = "default",
  project: string | string[] = "default",
): Promise<FactArchive[]> {
  const rows = await db
    .select({ archive: factArchive })
    .from(factArchive)
    .innerJoin(facts, eq(factArchive.factId, facts.id))
    .where(
      and(
        eq(factArchive.tenantId, tenantId),
        eq(factArchive.entityType, entityType),
        eq(factArchive.entityId, entityId),
        eq(factArchive.key, normalizeKey(key)),
        projectFilter(project),
      ),
    )
    .orderBy(desc(factArchive.archivedAt));
  return rows.map((r) => r.archive);
}

// ---------------------------------------------------------------------------
// Inspect (no side effects — for debugging and tests)
// ---------------------------------------------------------------------------

// Get a fact by ID without updating any counters.
// Used in tests and internal tooling where you want the raw record.
//
// `project`: the caller's effective project scope. When provided, a fact
// belonging to another project resolves to undefined — indistinguishable
// from a nonexistent id (no cross-project existence probing). MCP tool
// paths MUST pass this; omitting is for trusted in-process/test use only.
export async function getFactById(
  factId: string,
  project?: string | string[],
): Promise<Fact | undefined> {
  return db.query.facts.findFirst({
    where:
      project === undefined
        ? eq(facts.id, factId)
        : and(eq(facts.id, factId), projectFilter(project)),
  });
}
