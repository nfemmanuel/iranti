// CORE-17 — chunk store + semantic recall (the retrieval-first "recall layer").
//
// The competitive benchmark showed iranti's recall ceiling was retrieval, not
// extraction: lexical recall scored 12–18% on ~48-session haystacks while
// semantic retrieval over RAW chunks scored ~79%. This module is that recall
// layer inside iranti — store each conversation episode verbatim + embedded,
// and at query time cosine-rank the whole project's chunks by MEANING (no
// keyword overlap required). It sits ALONGSIDE the fact store (the truth
// layer): semantic finds the region, facts resolve the current value.
//
// Reuses CORE-16's embedding machinery wholesale (EmbedderBackend, the one
// vector-column serialization accessor, the regime version-lock) — the only
// new axes are (1) the unit is a raw episode, not a `key: value` fact, and
// (2) retrieval is PROJECT-scoped, not entity-scoped, because an open question
// ranges across every session. See docs/prds/phases/core-17-retrieval-first-
// recall.md.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { chunks } from "../db/schema.js";
import { getEmbedder, isEmbedderActive } from "../embed/index.js";
import { cosineSimilarity } from "../embed/cosine.js";
import { buildEmbedRegime, regimeMatches } from "../embed/regime.js";
import { embeddingAssignmentSql, parseStoredVector } from "../embed/vector-column.js";

// Project scope filter for chunk reads — accepts one project or the effective
// (combined) set, so attend can span currentProject + its combined partners for
// chunk recall exactly as it does for fact recall (attend.ts effectiveProjectIds
// / getEffectiveProjectIds). A single id uses eq; the combined set uses inArray.
//
// Deliberately does NOT normalize the ids here (unlike facts.ts's projectFilter
// which pairs with a normalizing writeFact): the chunk WRITE side (writeChunk)
// stores the project verbatim, so the read must match verbatim — normalizing
// only one side would make writes unfindable. Production symmetry is already
// guaranteed because attend passes the already-normalized ctx.project.id /
// effectiveProjectIds (resolveCurrentProject/getEffectiveProjectIds normalize)
// on BOTH the write and the read. Keeping the filter a pure "match what you're
// given" also preserves the isolated recall contract in chunks.test.ts (raw
// fake-path scopes round-trip write->read unchanged).
function chunkProjectFilter(project: string | string[]) {
  const ids = Array.isArray(project) ? project : [project];
  return ids.length === 1
    ? eq(chunks.project, ids[0]!)
    : inArray(chunks.project, ids);
}

// Fixed cosine floor for chunk recall — its OWN constant, deliberately NOT
// shared with the fact tier's 0.60 (CORE-16 D2). Chunk texts are long and
// their cosine distribution differs from terse `key: value` facts, so coupling
// the two floors would be a category error. Start conservative; it only moves
// with a measured bench justification (the PRD D2 no-speculative-tuning rule).
const CHUNK_SIMILARITY_FLOOR = 0.6;

// Clamp the embed text to nomic-embed-text's ~2048-token window. Matches the
// concept-test adapter that scored 79% (bench/competitive/adapters/chunk-rag.ts
// sliced to 8000 chars) so iranti's own recall reproduces that result.
const CHUNK_EMBED_MAX_LEN = 8000;

// Same guardrail role as facts' SEMANTIC_CANDIDATE_CAP: JS cosine is O(n) over
// the pool. The cap's trigger is the named Postgres + pgvector/HNSW escalation
// (PRD §9), not an expected steady state at personal scale.
const SEMANTIC_CHUNK_CAP = 500;

export interface WriteChunkInput {
  content: string;
  sessionId?: string | null;
  agentId?: string | null;
  surface?: string | null;
  entityHint?: string | null;
}

export interface ChunkHit {
  id: string;
  content: string;
  score: number;
}

// Insert a raw episode. Does NOT embed — the caller pairs this with
// embedChunkOnWrite (fire-and-forget via trackBackground on the live write
// path; awaited directly in tests/bench for determinism), mirroring how
// writeFact defers embedFactOnWrite. Returns the new chunk id.
export async function writeChunk(
  input: WriteChunkInput,
  tenantId: string = "default",
  project: string = "default",
): Promise<{ id: string }> {
  // Generate the id client-side rather than via .returning() — `db` is a
  // union of the PGlite and postgres-js database types, and .returning()'s
  // fields overload doesn't survive that union at the type level (it runs
  // fine, but tsc rejects it). An explicit uuid dodges the union entirely;
  // the column keeps its defaultRandom() default for other writers.
  const id = randomUUID();
  await db.insert(chunks).values({
    id,
    tenantId,
    project,
    content: input.content,
    sessionId: input.sessionId ?? null,
    agentId: input.agentId ?? null,
    surface: input.surface ?? null,
    entityHint: input.entityHint ?? null,
  });
  return { id };
}

// Chunk-side vector accessors — reuse the ONE serialization discipline
// (embeddingAssignmentSql / parseStoredVector from vector-column.ts, which own
// the engine-conditional ::vector cast on write and ::text read) against the
// chunks table, so no caller here branches on engine either.
async function setChunkEmbedding(chunkId: string, vec: number[]): Promise<void> {
  await db
    .update(chunks)
    .set({ embedding: embeddingAssignmentSql(vec) })
    .where(eq(chunks.id, chunkId));
}

async function readChunkEmbeddingsBatch(ids: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: chunks.id, embedding: sql<string | null>`${chunks.embedding}::text` })
    .from(chunks)
    .where(inArray(chunks.id, ids));
  for (const row of rows) {
    const vec = parseStoredVector(row.embedding);
    if (vec) out.set(row.id, vec);
  }
  return out;
}

function clampEmbedText(content: string): string {
  return content.length > CHUNK_EMBED_MAX_LEN ? content.slice(0, CHUNK_EMBED_MAX_LEN) : content;
}

// Embed one chunk's raw content and persist the vector + regime signature.
// No-op when the embedder is off (default-off core stays zero-cost). Mirrors
// src/embed/write-hook.ts (embedFactOnWrite), but the embed text is the raw
// episode, not a `key: value` composition.
export async function embedChunkOnWrite(chunkId: string, content: string): Promise<void> {
  if (!isEmbedderActive()) return;
  const embedder = getEmbedder();
  const [vec] = await embedder.embed([clampEmbedText(content)]);
  if (!vec || vec.length === 0) return; // embedder degraded — leave un-embedded, lazy retry on next write
  await setChunkEmbedding(chunkId, vec);

  // Merge embedRegime into metadata without clobbering other keys (same
  // discipline as embedFactOnWrite) — a second UPDATE because the vector isn't
  // known until embed() returns.
  const current = await db.query.chunks.findFirst({
    where: eq(chunks.id, chunkId),
    columns: { metadata: true },
  });
  const base =
    current?.metadata != null && typeof current.metadata === "object"
      ? (current.metadata as Record<string, unknown>)
      : {};
  await db
    .update(chunks)
    .set({ metadata: { ...base, embedRegime: buildEmbedRegime(embedder.identity) } })
    .where(eq(chunks.id, chunkId));
}

// The project's chunk candidate pool — all chunks in scope, id-ordered
// (deterministic, not recency — "semantically right" has nothing to do with
// recency), 500-capped with a logged truncation note. Project-scoped, NOT
// entity-scoped: an open question ranges across every session.
async function fetchChunkCandidates(
  tenantId: string,
  project: string | string[],
): Promise<Array<{ id: string; content: string; metadata: unknown }>> {
  const rows = await db
    .select({ id: chunks.id, content: chunks.content, metadata: chunks.metadata })
    .from(chunks)
    .where(and(eq(chunks.tenantId, tenantId), chunkProjectFilter(project)))
    .orderBy(chunks.id)
    .limit(SEMANTIC_CHUNK_CAP + 1);
  if (rows.length > SEMANTIC_CHUNK_CAP) {
    const scope = Array.isArray(project) ? project.join(",") : project;
    console.error(
      `[iranti] chunk candidate fetch truncated at ${SEMANTIC_CHUNK_CAP} for ` +
        `${tenantId}/${scope} (${rows.length} eligible) — ANN-index escalation ` +
        `trigger (PRD core-17-retrieval-first-recall.md §9).`,
    );
    return rows.slice(0, SEMANTIC_CHUNK_CAP);
  }
  return rows;
}

// CORE-17 recall read path. Embed the query, cosine-rank the project's chunk
// pool, return the top-K strictly above the floor (highest first). Below-floor
// returns nothing — that empty result IS the abstention signal (the caller
// reads "no chunk relevant enough to answer from" and can decline rather than
// guess, G1/never-invent). Deterministic given a pinned model. Returns []
// instantly when the embedder is off (the whole cost on the default path).
export async function searchChunksSemantic(
  query: string,
  k: number,
  tenantId: string = "default",
  project: string | string[] = "default",
): Promise<ChunkHit[]> {
  if (!isEmbedderActive() || k <= 0) return [];
  const embedder = getEmbedder();
  const [queryVec] = await embedder.embed([clampEmbedText(query)]);
  if (!queryVec || queryVec.length === 0) return [];

  const candidates = await fetchChunkCandidates(tenantId, project);
  if (candidates.length === 0) return [];

  const vectors = await readChunkEmbeddingsBatch(candidates.map((c) => c.id));
  if (vectors.size === 0) return [];

  const activeRegime = buildEmbedRegime(embedder.identity);
  const scored: ChunkHit[] = [];
  for (const cand of candidates) {
    const vec = vectors.get(cand.id);
    if (!vec) continue; // never embedded / embed failed — absent, not zero
    // Regime mismatch (D4): a vector from a different model/version is
    // mathematically incomparable — treat as absent, re-embed lazily.
    if (!regimeMatches((cand.metadata as Record<string, unknown> | null)?.["embedRegime"], activeRegime)) {
      continue;
    }
    const score = cosineSimilarity(queryVec, vec);
    // Fixed floor (D2): below it, return nothing rather than a topically-
    // adjacent-but-wrong chunk.
    if (score > CHUNK_SIMILARITY_FLOOR) scored.push({ id: cand.id, content: cand.content, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);

  if (top.length > 0) {
    await db
      .update(chunks)
      .set({ lastAccessedAt: new Date(), accessCount: sql`${chunks.accessCount} + 1` })
      .where(inArray(chunks.id, top.map((c) => c.id)));
  }

  return top;
}
