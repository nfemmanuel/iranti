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
//      hard assertion in this spec (PRD §5 D5). Extraction/retrieval
//      quality is reported, never gated: numbers may be (and today, are)
//      low — see bench/baseline.json and the PRD's D9/§9 for why that's
//      expected, not a bug.
//
// No timestamps in the compared payload: BenchReport (scorer.ts) carries no
// wall-clock fields at all — every field is either a corpus-derived string
// (query text, keys, entity labels) or a derived count/ratio. So there is
// nothing to strip before comparing; the two full JSON payloads are
// compared directly.

import { describe, expect, it, vi } from "vitest";
import { loadCorpora } from "./corpus.js";
import { runPersonaIngest } from "./ingest.js";
import { scorePersona, buildOverallReport, type BenchReport } from "./scorer.js";
import { loadBaseline, writeBaseline, writeLatest, diffReports } from "./baseline.js";
import { renderReport } from "./report.js";

// pnpm bench --update-baseline (or UPDATE_BASELINE=1 pnpm bench) regenerates
// bench/baseline.json from the current run instead of diffing against it.
const UPDATE_BASELINE =
  process.env["UPDATE_BASELINE"] === "1" || process.argv.includes("--update-baseline");

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

      // ---- The one hard assertion: determinism (PRD §5 D3/D5). -------------
      // Two independent runs, each against its own brand-new PGlite store,
      // must produce byte-identical scored output in heuristic mode. This is
      // the harness proving its own instrument is trustworthy — a property
      // of the harness, not of memory quality.
      expect(JSON.stringify(runB)).toBe(JSON.stringify(runA));

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
