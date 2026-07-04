// The Layer 0b measurement harness — golden-corpus bench runner.
//
// Runs THROUGH VITEST (not plain `node`) because plain `node
// --experimental-strip-types` cannot resolve this repo's TS-source
// `.js`-suffixed relative specifiers (see PRD layer-0b-harness.md §5 D6,
// and it-runs.test.ts's header comment for the same limitation). `pnpm
// bench` runs this one spec.
//
// What this spec does:
//   1. Loads the 4 persona corpora from bench/corpus/*.json.
//   2. For each persona, ingests its transcript through the REAL
//      attend()/write() paths against a FRESH embedded PGlite store (D7:
//      vi.resetModules() + a fresh IRANTI_DATA_DIR per persona), then runs
//      its probes through attend() and scores the results.
//   3. Diffs the result against the checked-in bench/baseline.json and
//      prints a console table (report.ts).
//   4. Writes bench/latest.json.
//   5. Repeats the entire run a second time and asserts the two reports are
//      byte-identical (modulo nothing — there are no timestamps in the
//      report shape; see the "no timestamps" note below) — this is the ONE
//      hard assertion in this spec (PRD §5 D5), IN HEURISTIC MODE.
//      Extraction/retrieval quality is reported, never gated: numbers may
//      be (and today, are) low — see bench/baseline.json and the PRD's
//      D9/§9 for why that's expected, not a bug.
//
// No timestamps in the compared payload: BenchReport (scorer.ts) carries no
// wall-clock fields at all — every field is either a corpus-derived string
// (query text, keys, entity labels) or a derived count/ratio. So there is
// nothing to strip before comparing; the two full JSON payloads are
// compared directly.
//
// extraction-measurement.md §3 (change 1) — env-respect: this harness used
// to force IRANTI_EXTRACTOR="heuristic" unconditionally (ingest.ts), making
// `IRANTI_EXTRACTOR=local pnpm bench` a no-op. It now defaults to heuristic
// ONLY when the env is unset (see ingest.ts's effectiveExtractorMode) — a
// pre-set value runs that extractor through this SAME corpus+scorer+
// baseline machinery. When the effective extractor is non-heuristic:
//   - the byte-determinism assertion above is REPLACED by a console banner
//     (an LLM is not expected to be byte-deterministic; asserting it would
//     fail spuriously on a working non-deterministic run — the real N=3
//     variance protocol lives outside this spec, in the measurement doc);
//   - UPDATE_BASELINE=1 is a hard error (the checked-in baseline is
//     heuristic-only and must never be overwritten by an LLM run).

import { describe, expect, it, vi } from "vitest";
import { loadCorpora } from "./corpus.js";
import { runPersonaIngest, effectiveExtractorMode } from "./ingest.js";
import { scorePersona, buildOverallReport, type BenchReport } from "./scorer.js";
import { loadBaseline, writeBaseline, writeLatest, diffReports } from "./baseline.js";
import { renderReport } from "./report.js";

// UPDATE_BASELINE=1 pnpm bench regenerates bench/baseline.json from the
// current run instead of diffing against it. Env var ONLY — a
// `--update-baseline` CLI flag cannot work here because vitest's own CLI
// parser rejects unknown options with a CACError before this file ever
// loads (review finding: the previously-documented flag form crashed).
const UPDATE_BASELINE = process.env["UPDATE_BASELINE"] === "1";

// extraction-measurement.md §3 change 1 — the harness now respects a
// pre-set IRANTI_EXTRACTOR (ingest.ts's effectiveExtractorMode) instead of
// forcing "heuristic" unconditionally. Read it here, BEFORE runPersonaIngest
// mutates process.env per-persona, so this spec's own top-level decisions
// (skip determinism? refuse UPDATE_BASELINE?) are based on what the caller
// actually asked for, not on a mutated value from a previous persona's loop
// iteration.
const REQUESTED_EXTRACTOR = effectiveExtractorMode(process.env["IRANTI_EXTRACTOR"]);
const IS_HEURISTIC = REQUESTED_EXTRACTOR === "heuristic";

// The checked-in baseline is heuristic-only (R0). Overwriting it from a
// non-deterministic LLM run would silently corrupt the one fixed reference
// point every other regime is diffed against — refuse hard rather than
// silently accept (extraction-measurement.md §3 change 1's explicit
// requirement).
if (UPDATE_BASELINE && !IS_HEURISTIC) {
  throw new Error(
    `UPDATE_BASELINE=1 refused: IRANTI_EXTRACTOR="${REQUESTED_EXTRACTOR}" is not "heuristic".\n` +
      `bench/baseline.json is heuristic-only and must never be overwritten by an LLM run ` +
      `(extraction-measurement.md §3). Unset IRANTI_EXTRACTOR (or set it to "heuristic") to update the baseline.`,
  );
}

async function runFullBench(): Promise<BenchReport> {
  const corpora = loadCorpora();

  // Sequential on purpose: each persona mutates process.env and resets the
  // module graph (D7) — running personas concurrently would race those
  // global mutations, exactly like why it-runs.test.ts and
  // persistence.test.ts don't parallelize their env-mutating setup either.
  const personaReports = [];
  for (const corpus of corpora) {
    const result = await runPersonaIngest(corpus, vi);
    personaReports.push(scorePersona(corpus, result));
  }

  const overall = buildOverallReport(personaReports);
  return { personas: personaReports, overall };
}

describe("Layer 0b measurement harness (deterministic, heuristic-only)", () => {
  it(
    "ingests all persona corpora, scores them, diffs against baseline, and is run-to-run deterministic",
    async () => {
      const runA = await runFullBench();
      const runB = await runFullBench();

      // ---- The one hard assertion: determinism (PRD §5 D3/D5) — HEURISTIC
      // MODE ONLY. -------------------------------------------------------
      // Two independent runs, each against its own brand-new PGlite store,
      // must produce byte-identical scored output in heuristic mode. This is
      // the harness proving its own instrument is trustworthy — a property
      // of the harness, not of memory quality.
      //
      // extraction-measurement.md §3 change 1: when IRANTI_EXTRACTOR is set
      // to a non-heuristic value (running the R1/R2 LLM regimes), this
      // assertion is REPLACED by a banner — an LLM is not expected to be
      // byte-deterministic across runs (temperature/sampling/endpoint
      // variance), and asserting it would fail spuriously on a correctly-
      // functioning non-deterministic measurement run. The N=3 variance
      // protocol that actually characterizes that non-determinism lives
      // outside this spec (extraction-measurement.md §2) — this spec's job
      // is only to not fail spuriously here.
      if (IS_HEURISTIC) {
        expect(JSON.stringify(runB)).toBe(JSON.stringify(runA));
      } else {
        console.log(
          `\n[iranti bench] NON-DETERMINISTIC MEASUREMENT RUN (IRANTI_EXTRACTOR="${REQUESTED_EXTRACTOR}")\n` +
            `  Byte-determinism is NOT asserted for this invocation — an LLM extractor is not\n` +
            `  expected to reproduce identical output run-to-run. This run's numbers are a single\n` +
            `  sample; see extraction-measurement.md §2 for the N=3 variance protocol that\n` +
            `  characterizes this properly. Do not treat this run alone as a measurement result.\n`,
        );
      }

      // ---- Report + baseline diff (using runA; runB already proved identical). ----
      const baseline = UPDATE_BASELINE ? null : loadBaseline();
      const deltas = diffReports(baseline, runA);

      // This console.log call IS the report — it's meant for a human reading
      // CI/local bench output, not incidental debug noise.
      console.log(renderReport(runA, deltas));

      writeLatest(runA);
      if (UPDATE_BASELINE) {
        writeBaseline(runA);
        console.log(`Baseline updated: bench/baseline.json now reflects this run.`);
      }

      // ---- Deliberately NOT asserted (PRD §5 D5): -----------------------
      // extraction recall/precision, retrieval hit-rate, confirmation rate.
      // Numbers are reported honestly; they must never fail this gate. See
      // bench/baseline.json + the PRD's D9 for why today's numbers are low
      // by design (alias/correction-phrasing gaps are intentional corpus
      // content, not bugs to fix here).
    },
    // 4 personas x 2 full runs x (fresh PGlite boot + auto-migrate) is
    // slower than a typical unit test; generous but bounded timeout.
    120_000,
  );
});
