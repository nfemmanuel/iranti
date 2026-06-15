// One-off overhead report (not part of the build).
// Reads attend_log from the dev DB and reports the real injection-size
// distribution per attend, so we can check the "negligible overhead" claim
// against recorded behavior rather than assume it.
//
// Run: npx tsx scripts/overhead-report.mts
//
// NOTE: the dev DB's attend_log is populated by the test suite, not real
// production sessions — so treat these as "what attend actually records when
// it runs," a proxy for per-turn cost, not a usage study.

import { db } from "../src/db/connection.js";
import { attendLog } from "../src/db/schema.js";
import { sql } from "drizzle-orm";

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function run() {
  const rows = await db
    .select({
      phase: attendLog.phase,
      injectedTokensEst: attendLog.injectedTokensEst,
      suppressedTokensEst: attendLog.suppressedTokensEst,
      factCount: attendLog.factCount,
      ruleCount: attendLog.ruleCount,
      latencyMs: attendLog.latencyMs,
    })
    .from(attendLog);

  console.log(`==== ATTEND_LOG OVERHEAD (n=${rows.length}) ====`);
  if (rows.length === 0) {
    console.log("No attend_log rows. Run `pnpm test` first or point at a DB with data.");
    return;
  }

  const inj = rows.map((r) => r.injectedTokensEst ?? 0).sort((a, b) => a - b);
  const sup = rows.map((r) => r.suppressedTokensEst ?? 0).sort((a, b) => a - b);
  const lat = rows.map((r) => r.latencyMs ?? 0).sort((a, b) => a - b);
  const facts = rows.map((r) => r.factCount ?? 0).sort((a, b) => a - b);

  const stat = (label: string, s: number[]) =>
    console.log(
      `${label.padEnd(22)} min=${s[0]} p50=${pct(s, 50)} p75=${pct(s, 75)} p95=${pct(s, 95)} max=${s[s.length - 1]} mean=${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1)}`,
    );

  stat("injected_tokens_est", inj);
  stat("suppressed_tokens_est", sup);
  stat("fact_count", facts);
  stat("latency_ms", lat);

  // per-phase injected tokens
  const byPhase = await db
    .select({
      phase: attendLog.phase,
      n: sql<number>`count(*)::int`,
      avgInjected: sql<number>`avg(${attendLog.injectedTokensEst})::float`,
      maxInjected: sql<number>`max(${attendLog.injectedTokensEst})::int`,
    })
    .from(attendLog)
    .groupBy(attendLog.phase);

  console.log("\n==== BY PHASE ====");
  for (const p of byPhase) {
    console.log(
      `${(p.phase ?? "(null)").padEnd(16)} n=${p.n} avgInjected=${(p.avgInjected ?? 0).toFixed(1)} maxInjected=${p.maxInjected}`,
    );
  }
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("OVERHEAD REPORT ERROR:", e);
    process.exit(1);
  });
