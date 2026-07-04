// messy-corpus build — `pnpm bench:messy` runner.
//
// A SEPARATE bench mode from the default `pnpm bench` (harness.test.ts),
// which stays pinned to bench/corpus/*.json and byte-deterministic. This
// spec loads bench/corpus-messy/*.json instead — realistic messy/rambling
// transcripts with implicit decisions, mid-sentence corrections, and a
// novel-vocabulary persona (invented product/tool/person names), authored so
// the heuristic extractor is expected to catch very little of it while an
// LLM extractor has real headroom to show its value. See
// docs/reviews/2026-07-04-v1-wave1-build.md §4 for the finding this build
// exists to fix: on the CLEAN authored bench/corpus/*.json, R1 (local LLM)
// scored IDENTICAL to R0 (heuristic) — a null-by-construction artifact,
// because (a) the scorer credited a gold fact only under the heuristic's
// exact synthesized key, and (b) the clean corpus left little conversational
// residue for an LLM to have an edge on. Fix (a) is scorer.ts's valueRecall
// (key-agnostic credit); fix (b) is this corpus.
//
// This module reuses the SAME ingest/scorer/report machinery as
// harness.test.ts (runPersonaIngest, scorePersona, buildOverallReport,
// renderReport) — the corpus content and the output destination are what's
// different, not the measurement mechanics. That's deliberate: a messy-
// corpus-specific bug in a hand-rolled second scorer would be indistinguishable
// from a real extraction-quality finding.
//
// Respects IRANTI_EXTRACTOR exactly like the default harness (ingest.ts's
// effectiveExtractorMode) — this is what lets the R0/R1/R2 regimes run
// against the SAME corpus+scorer with only the env changing:
//   IRANTI_EXTRACTOR=heuristic pnpm bench:messy                     (R0)
//   IRANTI_EXTRACTOR=local IRANTI_LLM_MODEL=qwen2.5:7b pnpm bench:messy  (R1)
//   IRANTI_EXTRACTOR=local IRANTI_LLM_ENDPOINT=... IRANTI_LLM_MODEL=... \
//     IRANTI_LLM_API_KEY=... pnpm bench:messy                       (R2)
//
// Deliberately does NOT:
//   - assert byte-determinism (an LLM regime is not expected to reproduce
//     identical output run-to-run — banner instead, mirroring
//     harness.test.ts's IS_HEURISTIC branch);
//   - touch bench/baseline.json (that file is the default corpus's
//     heuristic-only reference point; this mode has its own destination,
//     bench/latest-messy.json, and no checked-in baseline of its own yet —
//     a future build can add one if messy-corpus regression-gating is ever
//     wanted, but that's not this build's job);
//   - run as part of `pnpm bench` (package.json's "bench" script still only
//     runs harness.test.ts) or gate CI.

import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMessyCorpora } from "./corpus.js";
import { runPersonaIngest, effectiveExtractorMode } from "./ingest.js";
import { scorePersona, buildOverallReport, type BenchReport } from "./scorer.js";
import { renderReport } from "./report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A dedicated file — never bench/latest.json (the default corpus's own
// per-run artifact) so a messy run can never be mistaken for a default run
// or clobber it.
const LATEST_MESSY_PATH = path.resolve(__dirname, "../../bench/latest-messy.json");

const REQUESTED_EXTRACTOR = effectiveExtractorMode(process.env["IRANTI_EXTRACTOR"]);
const IS_HEURISTIC = REQUESTED_EXTRACTOR === "heuristic";

async function runFullMessyBench(): Promise<BenchReport> {
  const corpora = loadMessyCorpora();

  // Sequential on purpose — identical reasoning to harness.test.ts's
  // runFullBench: each persona mutates process.env and resets the module
  // graph (D7), so concurrent personas would race those global mutations.
  const personaReports = [];
  for (const corpus of corpora) {
    const result = await runPersonaIngest(corpus, vi);
    personaReports.push(scorePersona(corpus, result));
  }

  const overall = buildOverallReport(personaReports);
  return { personas: personaReports, overall };
}

describe("messy-corpus bench (pnpm bench:messy)", () => {
  it(
    "ingests bench/corpus-messy personas, scores identity-recall + value-recall + precision + fabricationRate, and writes bench/latest-messy.json",
    async () => {
      const report = await runFullMessyBench();

      if (IS_HEURISTIC) {
        console.log(
          `\n[bench:messy] HEURISTIC-MODE RUN (IRANTI_EXTRACTOR="${REQUESTED_EXTRACTOR}")\n` +
            `  This corpus is authored so the heuristic extractor is expected to catch very\n` +
            `  little of it (no clean 'Decision:'/'Requirement:' labels, implicit decisions,\n` +
            `  mid-sentence corrections, novel vocabulary) — a low recall/value-recall here is\n` +
            `  the EXPECTED R0 floor this mode exists to contrast an LLM regime against, not a\n` +
            `  regression. See each persona's goldFacts[].note for the specific phrasing gap.\n`,
        );
      } else {
        console.log(
          `\n[bench:messy] NON-DETERMINISTIC MEASUREMENT RUN (IRANTI_EXTRACTOR="${REQUESTED_EXTRACTOR}")\n` +
            `  Byte-determinism is NOT asserted for this invocation — an LLM extractor is not\n` +
            `  expected to reproduce identical output run-to-run. This run's numbers are a\n` +
            `  single sample. Do not treat this run alone as a definitive measurement result;\n` +
            `  compare identity-recall AND value-recall against an R0 (heuristic) run of this\n` +
            `  same corpus to see whether the LLM's value is visible.\n`,
        );
      }

      // ---- The star comparison this build exists to enable: identity-recall
      // (key-exact, same metric the default bench has always printed) side by
      // side with value-recall (key-agnostic — credits a fact stored under
      // ANY key, the fix for the null-by-construction R0-vs-R1 result). ----
      const o = report.overall;
      const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
      console.log(
        `[bench:messy] OVERALL — ` +
          `identity-recall=${pct(o.extraction.recall)} (${o.extraction.matchedCount}/${o.extraction.goldCount})  ` +
          `value-recall=${pct(o.extraction.valueRecall)} (${o.extraction.valueRecallCount}/${o.extraction.goldCount})  ` +
          `precision=${pct(o.extraction.precision)} (${o.extraction.matchedCount}/${o.extraction.identityHits})  ` +
          `fabricationRate=${pct(o.extraction.fabricationRate)} (${o.extraction.fabricationViolationCount}/${o.extraction.fabricationProbeCount})`,
      );

      // Full per-persona detail via the SAME renderer the default bench uses
      // (no baseline deltas — deltas is an empty array, so renderReport's
      // "vs baseline" blocks are simply skipped, exactly like a fresh-
      // baseline first run of harness.test.ts would render).
      console.log(renderReport(report, []));

      writeFileSync(LATEST_MESSY_PATH, JSON.stringify(report, null, 2) + "\n", "utf-8");
      console.log(`[bench:messy] wrote ${LATEST_MESSY_PATH}`);

      // ---- Deliberately NOT asserted, same posture as harness.test.ts: -----
      // extraction recall/value-recall/precision, retrieval hit-rate,
      // confirmation rate, fabricationRate. This corpus is a MEASUREMENT
      // instrument, not a regression gate — numbers are reported honestly.
      // The one structural assertion below just confirms the instrument
      // itself ran and produced a well-formed report (goldFacts actually
      // existed and were scored), not that any particular number was hit.
      expect(o.extraction.goldCount).toBeGreaterThan(0);
    },
    // Same mode-dependent bound rationale as harness.test.ts: a non-heuristic
    // regime makes real LLM calls per message across 3 personas — generous
    // but bounded.
    IS_HEURISTIC ? 120_000 : 1_800_000,
  );
});
