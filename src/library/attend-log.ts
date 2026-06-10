// Attend log — Phase 2.5 (CORE-14)
//
// Persists one row per iranti_attend call (counts, sizes, latency) and
// persists comprehension metric counters so they survive process restarts.
//
// Both operations are fire-and-forget: called after the attend response is
// assembled so they never add latency to the host-facing call.
//
// Content-free by design: no fact values, message text, or session content
// ever enters this module — only counts, sizes, and durations.

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { attendLog, metricCounters } from "../db/schema.js";

export interface AttendLogEntry {
  tenantId?: string;
  sessionId?: string;
  agentId?: string;
  surface?: string;
  factCount: number;
  ruleCount: number;
  alreadyPresent: number;
  injectedChars: number;
  injectedTokensEst: number;
  suppressedTokensEst: number;
  latencyMs: number;
  phase?: string;
  factsExtracted?: number;
  correctionsCount?: number;
}

export async function writeAttendLog(entry: AttendLogEntry): Promise<void> {
  await db.insert(attendLog).values({
    tenantId: entry.tenantId ?? "default",
    sessionId: entry.sessionId ?? undefined,
    agentId: entry.agentId ?? undefined,
    surface: entry.surface,
    factCount: entry.factCount,
    ruleCount: entry.ruleCount,
    alreadyPresent: entry.alreadyPresent,
    injectedChars: entry.injectedChars,
    injectedTokensEst: entry.injectedTokensEst,
    suppressedTokensEst: entry.suppressedTokensEst,
    latencyMs: entry.latencyMs,
    phase: entry.phase,
    factsExtracted: entry.factsExtracted ?? 0,
    correctionsCount: entry.correctionsCount ?? 0,
  });
}

// Persist a delta of comprehension counter increments to metric_counters.
// Uses INSERT ... ON CONFLICT DO UPDATE SET value = value + delta so the
// all-time total accumulates correctly even when the process restarts.
// Pass only non-zero deltas; zero increments are skipped to avoid noise.
export async function persistMetricCounters(
  delta: Record<string, number>,
  tenantId = "default",
): Promise<void> {
  const entries = Object.entries(delta).filter(([, v]) => v > 0);
  if (entries.length === 0) return;

  for (const [name, increment] of entries) {
    await db
      .insert(metricCounters)
      .values({ tenantId, name, value: increment })
      .onConflictDoUpdate({
        target: [metricCounters.tenantId, metricCounters.name],
        set: {
          value: sql`${metricCounters.value} + ${increment}`,
          updatedAt: new Date(),
        },
      });
  }
}
