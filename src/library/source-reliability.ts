// Source reliability — Phase 2b / 2.5
//
// Tracks the conflict track record of each fact source. A source that
// consistently wins conflict resolutions earns a higher score (toward 1.0);
// a source that consistently loses earns a lower score (toward 0.0).
//
// score = wins / (wins + losses), initialised to 0.5 (neutral / no history).
//
// The score is applied as a confidence weight on writes so trusted sources
// carry more weight automatically — no configuration required. It is updated
// only on resolved conflicts (supersede = new wins, old loses), not on every
// write, so writes from unchallenged sources do not inflate their score.
//
// Phase 2.5 (CORE-28): tenant_id added so reliability scores are scoped per
// tenant. All functions accept tenantId (default "default") to remain
// backward-compatible with single-tenant use.

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { sourceReliability } from "../db/schema.js";

// Default score for a source with no history yet. Neutral — no advantage.
export const DEFAULT_SCORE = 0.5;

// If the existing source's score exceeds the new source's score by more than
// this threshold, the new write is escalated instead of superseding.
// 0.2 means: the existing source must be meaningfully more trusted (not just
// marginally) before we block a write. Default: supersede on equal or unknown.
export const ESCALATION_THRESHOLD = 0.2;

// `dbClient` lets a caller already inside a transaction (writeFact,
// checkConflict, createEscalation) pass that transaction through instead of
// implicitly querying on the module-level `db`. On postgres-js (a pool of
// up to 10 connections) querying `db` while a `tx` is open on another
// connection is harmless. On embedded PGlite (single connection, Layer 0)
// it is NOT harmless: the same underlying connection is mid-transaction, so
// a `db` query queues behind it — and if the open transaction is itself
// awaiting that query's result (as writeFact's confidence-formula step
// does), the two await each other and the process hangs forever. Only
// `.query` is needed, so the type is narrowed — both `db` and a Drizzle
// transaction satisfy it.

// Fetch a source's current reliability score. Returns DEFAULT_SCORE if the
// source has no recorded history.
export async function getScore(
  source: string,
  tenantId = "default",
  dbClient: Pick<typeof db, "query"> = db,
): Promise<number> {
  const row = await dbClient.query.sourceReliability.findFirst({
    where: and(
      eq(sourceReliability.tenantId, tenantId),
      eq(sourceReliability.source, source),
    ),
  });
  return row?.score ?? DEFAULT_SCORE;
}

// Get reliability row (full record), or undefined if not yet in the table.
// See getScore's dbClient comment above — same single-connection rationale.
export async function getReliabilityRow(
  source: string,
  tenantId = "default",
  dbClient: Pick<typeof db, "query"> = db,
): Promise<{ wins: number; losses: number; score: number } | undefined> {
  const row = await dbClient.query.sourceReliability.findFirst({
    where: and(
      eq(sourceReliability.tenantId, tenantId),
      eq(sourceReliability.source, source),
    ),
  });
  if (!row) return undefined;
  return { wins: row.wins, losses: row.losses, score: row.score };
}

// Record that `winner` beat `loser` in a conflict resolution. Both sources'
// records are updated atomically (separate upserts — they share no row).
export async function recordOutcome(
  winnerSource: string,
  loserSource: string,
  tenantId = "default",
): Promise<void> {
  await Promise.all([
    db
      .insert(sourceReliability)
      .values({ tenantId, source: winnerSource, wins: 1, losses: 0, score: 1.0 })
      .onConflictDoUpdate({
        target: [sourceReliability.tenantId, sourceReliability.source],
        set: {
          wins: sql`${sourceReliability.wins} + 1`,
          // score = (wins + 1) / (wins + losses + 1)
          score: sql`(${sourceReliability.wins} + 1.0) / (${sourceReliability.wins} + ${sourceReliability.losses} + 1.0)`,
          updatedAt: new Date(),
        },
      }),
    db
      .insert(sourceReliability)
      .values({ tenantId, source: loserSource, wins: 0, losses: 1, score: 0.0 })
      .onConflictDoUpdate({
        target: [sourceReliability.tenantId, sourceReliability.source],
        set: {
          losses: sql`${sourceReliability.losses} + 1`,
          // score = wins / (wins + losses + 1)
          score: sql`${sourceReliability.wins} / (${sourceReliability.wins} + ${sourceReliability.losses} + 1.0)`,
          updatedAt: new Date(),
        },
      }),
  ]);
}
