// Source reliability — Phase 2b
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

import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { sourceReliability } from "../db/schema.js";

// Default score for a source with no history yet. Neutral — no advantage.
export const DEFAULT_SCORE = 0.5;

// If the existing source's score exceeds the new source's score by more than
// this threshold, the new write is escalated instead of superseding.
// 0.2 means: the existing source must be meaningfully more trusted (not just
// marginally) before we block a write. Default: supersede on equal or unknown.
export const ESCALATION_THRESHOLD = 0.2;

// Fetch a source's current reliability score. Returns DEFAULT_SCORE if the
// source has no recorded history.
export async function getScore(source: string): Promise<number> {
  const row = await db.query.sourceReliability.findFirst({
    where: eq(sourceReliability.source, source),
  });
  return row?.score ?? DEFAULT_SCORE;
}

// Get reliability row (full record), or undefined if not yet in the table.
export async function getReliabilityRow(
  source: string,
): Promise<{ wins: number; losses: number; score: number } | undefined> {
  const row = await db.query.sourceReliability.findFirst({
    where: eq(sourceReliability.source, source),
  });
  if (!row) return undefined;
  return { wins: row.wins, losses: row.losses, score: row.score };
}

// Record that `winner` beat `loser` in a conflict resolution. Both sources'
// records are updated atomically (separate upserts — they share no row).
export async function recordOutcome(
  winnerSource: string,
  loserSource: string,
): Promise<void> {
  await Promise.all([
    db
      .insert(sourceReliability)
      .values({ source: winnerSource, wins: 1, losses: 0, score: 1.0 })
      .onConflictDoUpdate({
        target: sourceReliability.source,
        set: {
          wins: sql`${sourceReliability.wins} + 1`,
          // score = (wins + 1) / (wins + losses + 1)
          score: sql`(${sourceReliability.wins} + 1.0) / (${sourceReliability.wins} + ${sourceReliability.losses} + 1.0)`,
          updatedAt: new Date(),
        },
      }),
    db
      .insert(sourceReliability)
      .values({ source: loserSource, wins: 0, losses: 1, score: 0.0 })
      .onConflictDoUpdate({
        target: sourceReliability.source,
        set: {
          losses: sql`${sourceReliability.losses} + 1`,
          // score = wins / (wins + losses + 1)
          score: sql`${sourceReliability.wins} / (${sourceReliability.wins} + ${sourceReliability.losses} + 1.0)`,
          updatedAt: new Date(),
        },
      }),
  ]);
}
