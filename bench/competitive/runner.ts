// BENCH-1 — Fair Competitive Benchmark Harness: the dual-track runner.
//
// Orchestrates (system × dataset × track) cells and writes a per-question,
// append-only ledger so an interrupted multi-hour run resumes WITHOUT
// re-spending frontier calls (PRD §7 resumability gate, NF chose full-500).
//
// Two cost/fidelity decisions baked in here, both documented in the PRD
// changelog:
//   1. INGEST-ONCE per case. A LongMemEval question's 30-40 session haystack is
//      ingested once per (system, dataset, case); Track G and Track H then
//      query that same store at different topK. Ingestion — the expensive part
//      for the frontier config — never multiplies by tracks or runs.
//   2. N=1 UNDER temperature-0. LongMemEval's published reader+judge run at
//      temperature 0 (deterministic). Repeating a deterministic cell N times
//      yields byte-identical results, so N=3 (PRD D5) would be 3x the spend for
//      zero added information AND less reproducible than a fixed single run.
//      RUNS_PER_CELL defaults to 1; the loop still supports >1 for a future
//      stochastic dataset, and variance is reported (0 under temp-0).
//
// Track G vs Track H for M1/LongMemEval is topK-driven (50 vs 5) over the SAME
// published LongMemEval judge prompt — the judge-prompt-variance lever (G =
// lenient LLM judge, H = strict) becomes load-bearing for LoCoMo in M2, where
// the native F1 scorer is the H track. Recorded in each ResultRow either way.

import { config as loadDotenv } from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Adapter,
  AdapterFactory,
  CellLedger,
  Dataset,
  DatasetId,
  DatasetLoader,
  JudgeConfig,
  QuestionResult,
  ReaderConfig,
  ResultRow,
  RunConfig,
  Track,
} from "./types.js";

import { irantiNextFactory } from "./adapters/iranti-next.js";
import { irantiOldFactory } from "./adapters/iranti-old.js";
import { aiMemFactory } from "./adapters/ai-mem.js";
import { chunkRagFactory } from "./adapters/chunk-rag.js";
import { loadLongMemEvalS } from "./datasets/longmemeval-s.js";
import { loadCodingContinuity } from "./datasets/coding-continuity.js";
import { composeAnswer } from "./reader.js";
import { judge } from "./judge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

// Load the temp Anthropic key for reader+judge from the gitignored bench/.env.
// Never logged/echoed anywhere in this file.
loadDotenv({ path: path.join(REPO_ROOT, "bench", ".env") });

// ---------------------------------------------------------------------------
// Run configuration — env-driven so cost/scale is controllable at run time
// without editing code (M1 is deliberately expensive; these are the levers).
// ---------------------------------------------------------------------------

const RESULTS_DIR = process.env["BENCH_OUT_DIR"]
  ? path.resolve(process.env["BENCH_OUT_DIR"])
  : path.join(__dirname, "results");

const READER_MODEL = process.env["BENCH_READER_MODEL"] ?? "claude-sonnet-5";
const JUDGE_MODEL = process.env["BENCH_JUDGE_MODEL"] ?? "claude-sonnet-5";
const RUNS_PER_CELL = Number(process.env["BENCH_RUNS"] ?? "1"); // see header note 2
// A labeled subset for cost-bounded runs; 0/unset = full dataset. Any subset
// run is stamped `limit` in the summary so it is never mistaken for full-500.
const LIMIT = Number(process.env["BENCH_LIMIT"] ?? "0") || undefined;

const READER_CONFIG: ReaderConfig = {
  readerModel: READER_MODEL,
  promptRef: "longmemeval/src/generation/run_generation.py::prepare_prompt@main",
};

const TRACKS: Record<Track, RunConfig> = {
  // Track G — the industry's generous knobs applied UNIFORMLY (D3a): one high
  // topK for every system. Favorable judge variant (a no-op vs the published
  // LongMemEval prompt for M1; load-bearing for LoCoMo M2).
  G: { track: "G", topK: 50, maxRuns: 1, judgePromptVariant: "favorable" },
  // Track H — fixed strict config: shallow topK, the number we actually trust.
  H: { track: "H", topK: 5, maxRuns: 1, judgePromptVariant: "strict" },
};

function judgeConfig(track: Track): JudgeConfig {
  return {
    judgeModel: JUDGE_MODEL,
    promptRef: "longmemeval/src/evaluation/evaluate_qa.py::get_anscheck_prompt@main",
    variant: track === "G" ? "favorable" : "strict",
  };
}

// Ingestion config is track-agnostic (ingest-once); topK is irrelevant to a
// write, so any track's config works. Use Track H's (arbitrary, stable).
const INGEST_CONFIG: RunConfig = TRACKS.H;

// ---------------------------------------------------------------------------
// System + dataset registries.
// ---------------------------------------------------------------------------

const SYSTEMS: Record<string, AdapterFactory> = {
  "iranti-next:heuristic": irantiNextFactory("heuristic"),
  "iranti-next:local": irantiNextFactory("local"),
  "iranti-next:frontier": irantiNextFactory("frontier"),
  "iranti-old": irantiOldFactory,
  "ai-mem": aiMemFactory,
  "iranti-next:chunk-rag": chunkRagFactory,
};

const DATASETS: Record<DatasetId, DatasetLoader> = {
  "longmemeval-s": loadLongMemEvalS,
  "coding-continuity": loadCodingContinuity,
  // M2 targets — loaders not built for M1.
  locomo: async () => {
    throw new Error("locomo loader is a Milestone-2 target, not built yet");
  },
  dmr: async () => {
    throw new Error("dmr was dropped from the program (never packaged; see PRD §9)");
  },
};

// Which cells to run this invocation (comma-lists in env, else the M1 defaults).
function selected<K extends string>(envVar: string, all: K[]): K[] {
  const raw = process.env[envVar];
  if (!raw) return all;
  // Preserve the REQUESTED order (not the definition order) so the caller can
  // control run sequencing — e.g. run the fast/cheap configs first so their
  // numbers land before a multi-hour one.
  const valid = new Set(all);
  return raw
    .split(",")
    .map((s) => s.trim() as K)
    .filter((k) => valid.has(k));
}

// ---------------------------------------------------------------------------
// Ledger persistence — one file per cell, append-only, question-keyed.
// ---------------------------------------------------------------------------

function ledgerPath(system: string, dataset: DatasetId, track: Track): string {
  const safe = (s: string) => s.replace(/[^a-z0-9._-]/gi, "_");
  return path.join(RESULTS_DIR, `cell__${safe(system)}__${dataset}__${track}.json`);
}

function loadLedger(system: string, dataset: DatasetId, track: Track): CellLedger {
  const p = ledgerPath(system, dataset, track);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8")) as CellLedger;
  return {
    system,
    dataset,
    track,
    readerModel: READER_MODEL,
    readerPromptRef: READER_CONFIG.promptRef,
    judgeModel: JUDGE_MODEL,
    judgePromptRef: judgeConfig(track).promptRef,
    results: [],
  };
}

function saveLedger(ledger: CellLedger): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(ledgerPath(ledger.system, ledger.dataset, ledger.track), JSON.stringify(ledger, null, 2) + "\n");
}

// Has this (runIndex, questionId) already been scored? (resume guard)
function alreadyDone(ledger: CellLedger, runIndex: number, questionId: string): boolean {
  const run = ledger.results.find((r) => r.runIndex === runIndex);
  return !!run?.questions.some((q) => q.questionId === questionId);
}

function record(ledger: CellLedger, runIndex: number, q: QuestionResult): void {
  let run = ledger.results.find((r) => r.runIndex === runIndex);
  if (!run) {
    run = { runIndex, questions: [] };
    ledger.results.push(run);
  }
  run.questions.push(q);
}

// ---------------------------------------------------------------------------
// The per-cell run: ingest-once, then query→read→judge per track per run.
// ---------------------------------------------------------------------------

// Track which (system,dataset,case) haystacks are already ingested this
// process, so the two tracks of the same case share one ingestion. (Cross-
// process resume re-ingests — cheap for local configs; the frontier config
// relies on iranti's content-hash cache AX-2 to make re-ingest near-free.)
const ingested = new Set<string>();

async function ingestCase(
  adapter: Adapter,
  system: string,
  dataset: DatasetId,
  caseId: string,
  history: Dataset["cases"][number]["history"],
): Promise<void> {
  const key = `${system}::${dataset}::${caseId}`;
  if (ingested.has(key)) return;
  for (const session of history) {
    await adapter.write(session, caseId, INGEST_CONFIG);
  }
  ingested.add(key);
}

async function runCell(adapter: Adapter, system: string, dataset: Dataset, track: Track): Promise<CellLedger> {
  const ledger = loadLedger(system, dataset.id, track);
  const cfg = TRACKS[track];
  if (!cfg) throw new Error(`unknown track: ${track}`);
  const jcfg = judgeConfig(track);

  for (let runIndex = 0; runIndex < RUNS_PER_CELL; runIndex++) {
    let done = 0;
    for (const c of dataset.cases) {
      if (alreadyDone(ledger, runIndex, c.id)) {
        done++;
        continue;
      }
      // Ingest the haystack once (shared across tracks/runs in-process).
      await ingestCase(adapter, system, dataset.id, c.id, c.history);

      // Retrieve at this track's depth, compose the graded answer with the
      // shared reader, judge against gold.
      const qr = await adapter.query(c.question, c.id, cfg);
      const answer = await composeAnswer(c.question, qr.retrieved, READER_CONFIG);
      const verdict = await judge(
        { question: c.question, gold: c.gold, answer, category: c.category, isAbstention: c.isAbstention },
        jcfg,
      );
      record(ledger, runIndex, {
        questionId: c.id,
        score: verdict.score,
        composedAnswer: answer,
        goldAnswer: c.gold,
        abstained: c.isAbstention,
      });
      done++;
      // Persist every question so a kill mid-cell loses at most one question.
      saveLedger(ledger);
      if (done % 25 === 0) {
        console.log(`  [${system} / ${dataset.id} / ${track}] run ${runIndex}: ${done}/${dataset.cases.length}`);
      }
    }
  }
  saveLedger(ledger);
  return ledger;
}

// ---------------------------------------------------------------------------
// Summary derivation — ResultRow[] from the ledgers.
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
}

function toResultRow(ledger: CellLedger): ResultRow {
  // Per-run aggregate = fraction correct across that run's questions.
  const perRun = ledger.results.map((r) => mean(r.questions.map((q) => q.score)));
  return {
    system: ledger.system,
    dataset: ledger.dataset,
    track: ledger.track,
    runs: ledger.results.length,
    scores: perRun,
    mean: mean(perRun),
    variance: variance(perRun),
    readerModel: ledger.readerModel,
    readerPromptRef: ledger.readerPromptRef,
    judgeModel: ledger.judgeModel,
    judgePromptRef: ledger.judgePromptRef,
    timestamp: new Date().toISOString(),
  };
}

function renderTable(rows: ResultRow[]): string {
  const lines: string[] = [];
  lines.push("| system | dataset | track | n | mean | variance |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows.sort((a, b) => a.dataset.localeCompare(b.dataset) || a.system.localeCompare(b.system) || a.track.localeCompare(b.track))) {
    lines.push(
      `| ${r.system} | ${r.dataset} | ${r.track} | ${r.runs} | ${(r.mean * 100).toFixed(1)}% | ${r.variance.toFixed(4)} |`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const systems = selected("BENCH_SYSTEMS", Object.keys(SYSTEMS));
  const datasetIds = selected("BENCH_DATASETS", ["longmemeval-s", "coding-continuity"] as DatasetId[]);
  const tracks = selected("BENCH_TRACKS", ["G", "H"] as Track[]);

  console.log("BENCH-1 runner — Milestone 1");
  console.log(`  systems:  ${systems.join(", ")}`);
  console.log(`  datasets: ${datasetIds.join(", ")}${LIMIT ? ` (limit ${LIMIT})` : " (full)"}`);
  console.log(`  tracks:   ${tracks.join(", ")}  runs/cell: ${RUNS_PER_CELL}`);
  console.log(`  reader:   ${READER_MODEL}   judge: ${JUDGE_MODEL}`);
  console.log(`  out:      ${RESULTS_DIR}`);

  // Load datasets once (shared across systems).
  const datasets: Dataset[] = [];
  for (const id of datasetIds) {
    console.log(`Loading dataset ${id}...`);
    const loader = DATASETS[id];
    if (!loader) throw new Error(`unknown dataset: ${id}`);
    datasets.push(await loader({ limit: LIMIT }));
  }

  const ledgers: CellLedger[] = [];
  for (const system of systems) {
    console.log(`\n=== system: ${system} ===`);
    let adapter: Adapter | null = null;
    try {
      const factory = SYSTEMS[system];
      if (!factory) throw new Error(`unknown system: ${system}`);
      adapter = await factory();
      for (const dataset of datasets) {
        for (const track of tracks) {
          console.log(`-- ${dataset.id} / track ${track}`);
          ledgers.push(await runCell(adapter, system, dataset, track));
        }
      }
    } catch (err) {
      // A whole-system failure (e.g. an unreachable adapter) is recorded and
      // skipped — the run continues with the other systems (NF: document
      // blockers, don't halt).
      console.error(`SYSTEM FAILED: ${system}: ${(err as Error).message}`);
    } finally {
      if (adapter?.teardown) await adapter.teardown().catch(() => {});
    }
  }

  // Emit summary: JSON rows + a markdown table.
  const rows = ledgers.map(toResultRow);
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(path.join(RESULTS_DIR, "summary.json"), JSON.stringify(rows, null, 2) + "\n");
  const table = renderTable(rows);
  writeFileSync(path.join(RESULTS_DIR, "summary.md"), table + "\n");
  console.log("\n" + table);
  console.log(`\nWrote ${rows.length} result rows to ${RESULTS_DIR}`);
}

main()
  // Force a clean exit once results are written. Teardown tree-kills the MCP
  // servers, but a stray handle (an orphaned child's pipe on Windows) could
  // still keep the event loop alive — this guarantees the run doesn't hang.
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
