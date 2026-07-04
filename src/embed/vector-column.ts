// Vector-column accessor — CORE-16.
//
// facts.embedding is vector(768) on Postgres and text on PGlite (see
// src/db/connection.ts's PGLITE_MIGRATION_OVERRIDES comment for why). This
// is the ONE module that knows that — every other caller (writeFact's embed
// hook, the semantic candidate fetch) calls readEmbedding/writeEmbeddingSql
// below and never branches on engine itself.
//
// Drizzle's typed `vector` column (src/db/schema.ts) maps a JS number[] to
// JSON.stringify(value) as the driver value on BOTH engines (see
// node_modules/drizzle-orm/pg-core/columns/vector_extension/vector.js) — on
// Postgres that JSON-array string is cast into a real vector(768) by
// pg/pgvector; on PGlite (a plain text column) it would just be stored
// as-is. That happens to already be engine-correct for a bare vector, BUT
// we bypass the typed column entirely and go through raw SQL here instead,
// because:
//   1. We need engine-conditional CAST syntax on the way IN (Postgres needs
//      an explicit `::vector` cast when binding a text/jsonb parameter;
//      PGlite's text column must NOT get that cast — it would fail against
//      a plain text column with no vector type registered).
//   2. Reads need the inverse: Postgres returns a "[1,2,3]" vector literal
//      string (via ::text cast, applied uniformly below) that we parse the
//      same way as PGlite's stored JSON text — one parse path, not two.
//
// The regime signature is NOT stored in this column (see regime.ts) — it
// rides in facts.metadata.embedRegime on both engines, so this column stays
// a pure vector on Postgres and a pure JSON-number-array text blob on PGlite.

import { sql, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { isPostgresEngine } from "../db/connection.js";
import { facts } from "../db/schema.js";

// Serialize a vector for the write side. Same JSON-array text form on both
// engines — the engine split is entirely in HOW it's bound (see
// writeEmbeddingSql), not in this string's shape.
function serializeVector(vec: number[]): string {
  return JSON.stringify(vec);
}

// Parse whatever comes back from a SELECT of facts.embedding. Postgres's
// pgvector, when selected with an explicit ::text cast (below), renders as
// "[1,2,3]" (no spaces). PGlite's text column holds exactly what we wrote:
// JSON.stringify's "[1,2,3]" too. So one parser serves both.
export function parseStoredVector(raw: string | null | undefined): number[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((n): n is number => typeof n === "number")) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Build the SQL fragment to assign facts.embedding in an UPDATE ... SET.
// Postgres: bind as text, cast to vector(768) (pgvector accepts a `'[...]'`
// text literal cast this way). PGlite: bind as plain text, no cast (the
// column IS text; a `::vector` cast would fail — no vector type exists).
export function embeddingAssignmentSql(vec: number[]) {
  const serialized = serializeVector(vec);
  return isPostgresEngine ? sql`${serialized}::vector` : sql`${serialized}`;
}

// Write a fact's embedding column directly (raw SQL — bypasses the Drizzle
// typed column so the cast above is under our control). Callers pass the
// already-resolved fact id; this does not touch metadata/regime — pair with
// a regime write at the same call site (see writeFactEmbedding in
// src/embed/write-hook.ts, the actual call site used by writeFact's hook).
export async function setEmbeddingColumn(
  factId: string,
  vec: number[],
): Promise<void> {
  await db
    .update(facts)
    // Drizzle's `.set()` accepts a raw SQL fragment for a column value
    // directly (no cast needed) — this deliberately bypasses the typed
    // vector column's own mapToDriverValue (see embeddingAssignmentSql's
    // comment for why: the engine-conditional ::vector cast must be under
    // our control).
    .set({ embedding: embeddingAssignmentSql(vec) })
    .where(eq(facts.id, factId));
}

// Read a fact's raw embedding column value as a parsed number[] (or null if
// absent). Casts to ::text uniformly on read so both engines' driver values
// arrive as plain strings before parseStoredVector runs — Postgres would
// otherwise hand back a raw vector wire value that a naive JSON.parse can't
// read directly (pgvector's non-cast output differs from PGlite's text
// column) — see the module comment above.
export async function readEmbeddingColumn(factId: string): Promise<number[] | null> {
  const rows = await db
    .select({ embedding: sql<string | null>`${facts.embedding}::text` })
    .from(facts)
    .where(eq(facts.id, factId))
    .limit(1);
  const row = rows[0];
  return row ? parseStoredVector(row.embedding) : null;
}

// Batch read for the semantic candidate fetch (facts.ts) — one SELECT ...
// FROM facts WHERE id IN (...) rather than N round trips. Returns a
// Map<factId, number[]> containing only rows with a non-null, parseable
// vector (facts with no embedding yet, or a malformed one, are simply
// absent from the map — the caller treats absence as "no vector").
export async function readEmbeddingColumnsBatch(
  factIds: string[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (factIds.length === 0) return out;
  const rows = await db
    .select({ id: facts.id, embedding: sql<string | null>`${facts.embedding}::text` })
    .from(facts)
    .where(inArray(facts.id, factIds));
  for (const row of rows) {
    const vec = parseStoredVector(row.embedding);
    if (vec) out.set(row.id, vec);
  }
  return out;
}
