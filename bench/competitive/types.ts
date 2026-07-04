// BENCH-1 — Fair Competitive Benchmark Harness: shared type contract.
//
// One Adapter interface every system implements (§6 of
// docs/prds/phases/bench-1-fair-competitive-harness.md), so the dual-track
// runner and the scorer never special-case a system. Transport (MCP stdio /
// SDK / HTTP / file-vault) varies inside each adapter; the driver only ever
// sees write()/query() and the shapes below.
//
// This tree is a SIBLING to src/harness/ (the internal golden-corpus bench).
// It does not import from or modify src/harness/ scoring. The only production
// touch is an additive optional `sessionBoundary` field on the shared Corpus
// shape (see src/harness/types.ts), used solely by the coding-continuity
// dataset loader.

// ---------------------------------------------------------------------------
// Run configuration — the ONLY thing that differs between Track G and Track H.
// ---------------------------------------------------------------------------
//
// D3/D3a: Track G reproduces the industry's generous *settings* applied
// UNIFORMLY (one high topK for every system, best-of-N on, favorable judge
// prompt) — never a per-system topK sweep (that per-system cherry-picking is
// the MemPalace-style inflation the plan's fairness rule forbids). Track H is
// a single strict fixed config. Both tracks flow through identical adapter and
// judge code; only this object + the judge/reader prompt variant change.
export type Track = "G" | "H";

export interface RunConfig {
  track: Track;
  // A SINGLE value applied identically to every system in a track — never
  // swept per-system. Track G: one fixed-generous value (e.g. 50, the
  // MemPalace figure). Track H: one fixed-strict value (e.g. 5).
  topK: number;
  // Track G: best-of-N, report the max. Track H: always 1.
  maxRuns: number;
  judgePromptVariant: "favorable" | "strict";
}

// ---------------------------------------------------------------------------
// Adapter I/O.
// ---------------------------------------------------------------------------

export interface WriteResult {
  ok: boolean;
  latencyMs: number;
  // System-native response, kept for debugging only — NEVER scored.
  raw?: unknown;
}

export interface QueryResult {
  // A system's RETRIEVED CONTEXT is its ONLY scored contribution. The shared
  // reader stage (reader.ts, D9) composes the graded answer from `retrieved`
  // using one fixed reader model + prompt for every system, so a system with
  // a better built-in answer-writer cannot win on composition instead of
  // memory. `retrieved` is topK-bounded per RunConfig.
  retrieved: string[];
  // The system's own answer if it happens to return one — retained for audit
  // and debugging ONLY. It is never sent to the judge and never scored (D9).
  nativeAnswer?: string | null;
  latencyMs: number;
  raw?: unknown;
}

// A single unit of memory to ingest. For multi-session datasets
// (LongMemEval-S, LoCoMo) the runner calls write() once per session in order;
// `sessionBoundary` carries the session index so systems that care about
// session structure can use it, and the coding-continuity dataset uses it to
// mark the boundary between two coding "sessions" (docs/research §d).
export interface WriteInput {
  conversation: string;
  sessionBoundary?: number;
}

export interface Adapter {
  // Stable id used as the results-table row label (e.g. "iranti-next:frontier",
  // "iranti-old", "ai-mem"). Must be constant across runs.
  readonly systemName: string;
  // `scope` isolates one EvalCase's haystack from every other case's. Each
  // LongMemEval question carries its OWN 30-40 session haystack; if case B's
  // sessions were visible when answering case A, retrieval would be corrupted.
  // Every adapter maps `scope` to its native isolation: iranti -> a per-case
  // project entityId, Mem0 -> user_id, a file-vault -> a subfolder. The runner
  // passes EvalCase.id as scope and never assumes cross-case memory.
  write(input: WriteInput, scope: string, config: RunConfig): Promise<WriteResult>;
  query(question: string, scope: string, config: RunConfig): Promise<QueryResult>;
  // Stop the MCP subprocess / close the SDK client. Optional: file-vault
  // adapters have nothing to tear down.
  teardown?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared reader / answer-generation stage (D9) — fairness-critical.
// ---------------------------------------------------------------------------
//
// One reader model + one prompt per track, applied to EVERY system's
// retrieved context. This is the LoCoMo/LongMemEval "Justify"/QA step: the
// memory system supplies `retrieved`, the reader composes the answer the judge
// then grades. Identical for all systems by construction. Implemented in
// reader.ts; config lives here so ResultRow and the runner can reference it.
export interface ReaderConfig {
  // Fixed for a run, same for all systems (e.g. "claude-sonnet-5").
  readerModel: string;
  // Published/fixed prompt id, recorded in ResultRow for reproducibility
  // (e.g. "brv-bench/justify.txt@<commit>" or
  // "longmemeval-s/qa-prompt@<commit>").
  promptRef: string;
}

// ---------------------------------------------------------------------------
// Judge stage.
// ---------------------------------------------------------------------------
//
// Grades a composed answer against the gold answer for one question. One fixed
// prompt per track (D4): reused from a published source where one exists
// (brv-bench for LoCoMo, LongMemEval-S's own published prompt with only the
// judge MODEL swapped), iranti-original ONLY for coding-continuity (labeled as
// such). The judge model choice must never leak into the prompt design.
export interface JudgeConfig {
  judgeModel: string;
  promptRef: string;
  variant: "favorable" | "strict";
}

// A single graded question: the judge's binary/scaled verdict plus enough
// provenance to audit it. Kept per-question so runs are resumable at question
// granularity (an interrupted full-500 run must not re-spend — PRD §7 gate).
export interface QuestionResult {
  questionId: string;
  score: number; // 0..1 — 1 = judged correct/answerable-and-correct
  composedAnswer: string; // what the shared reader produced (audited, never re-graded)
  goldAnswer: string;
  // For the abstention category: whether the system correctly declined.
  abstained?: boolean;
}

// ---------------------------------------------------------------------------
// Results.
// ---------------------------------------------------------------------------

export type DatasetId = "longmemeval-s" | "locomo" | "dmr" | "coding-continuity";

// One row per (system × dataset × track). `scores` holds the N=3 per-run
// aggregate scores (D5); `mean`/`variance` summarize them. reader*/judge*
// fields pin exactly how the number was produced so it is reproducible and the
// judge/reader-model confound (sonnet-5 vs published GPT-4o) is visible on the
// face of every row.
export interface ResultRow {
  system: string;
  dataset: DatasetId;
  track: Track;
  runs: number; // 3, per D5
  scores: number[]; // one aggregate per run
  mean: number;
  variance: number;
  readerModel: string;
  readerPromptRef: string;
  judgeModel: string;
  judgePromptRef: string;
  // ISO timestamp. Stamped by the runner from a real clock at write time
  // (never inside a workflow script — determinism constraint).
  timestamp: string;
}

// The append-only per-question ledger the runner writes incrementally so a
// killed run resumes without re-spending frontier calls. One file per
// (system × dataset × track); each run appends its questions keyed by
// (runIndex, questionId). The ResultRow above is derived from this once all
// N runs of a cell are complete.
export interface CellLedger {
  system: string;
  dataset: DatasetId;
  track: Track;
  readerModel: string;
  readerPromptRef: string;
  judgeModel: string;
  judgePromptRef: string;
  // results[runIndex] = the per-question results for that repetition.
  results: Array<{ runIndex: number; questions: QuestionResult[] }>;
}

// ---------------------------------------------------------------------------
// Dataset contract — the runner's iteration unit.
// ---------------------------------------------------------------------------
//
// Every dataset (LongMemEval-S, coding-continuity, later LoCoMo) normalizes to
// a list of EvalCase. The runner is dataset-agnostic: for each case it ingests
// `history` into the system under the case's own scope (one write() per
// session, in order), asks `question`, composes an answer via the shared
// reader, and judges it against `gold`. Loaders own raw-format parsing; the
// runner never sees the on-disk shape.

export interface EvalCase {
  // Stable id — LongMemEval's question_id (e.g. "gpt4_..._abs"), or a
  // coding-continuity case id. Used BOTH as the per-case isolation scope AND
  // as the QuestionResult key for resumability, so it MUST be stable across
  // runs.
  id: string;
  // Sessions to ingest before asking, in chronological order. Each becomes one
  // adapter.write(input, scope=case.id, config) call; sessionBoundary carries
  // the session index.
  history: WriteInput[];
  question: string;
  gold: string;
  // Category label (a LongMemEval question_type, or "coding-continuity").
  // Selects the task-conditional judge prompt (LongMemEval has 5 variants).
  category: string;
  // True for LongMemEval "_abs" abstention cases: the correct behavior is to
  // decline, and the judge uses the abstention-override prompt.
  isAbstention?: boolean;
}

export interface Dataset {
  id: DatasetId;
  cases: EvalCase[];
}

// A loader downloads/parses its raw source and returns normalized cases. Pure
// w.r.t. the run (no track/config) — the same cases feed both tracks. Accepts
// an optional limit for cost-bounded runs (subset runs MUST be labeled as such
// in the results, never passed off as full-500).
export type DatasetLoader = (opts?: { limit?: number }) => Promise<Dataset>;

// ---------------------------------------------------------------------------
// Reader + Judge function contracts (implemented in reader.ts / judge.ts).
// ---------------------------------------------------------------------------

// D9 shared reader: retrieved context -> composed answer. ONE model+prompt for
// every system in a run — this is the signature the runner calls.
export type ComposeAnswer = (
  question: string,
  retrieved: string[],
  config: ReaderConfig,
) => Promise<string>;

export interface JudgeVerdict {
  // 1 = judged correct (or, for abstention, correctly declined); 0 otherwise.
  score: number;
  // The judge model's raw reply, kept for audit.
  raw?: string;
}

// Grades one composed answer. `category` selects the task-conditional prompt;
// `isAbstention` switches to the abstention-override prompt (per LongMemEval's
// evaluate_qa.py contract). ONE model + prompt-family per track.
export type Judge = (
  input: {
    question: string;
    gold: string;
    answer: string;
    category: string;
    isAbstention?: boolean;
  },
  config: JudgeConfig,
) => Promise<JudgeVerdict>;

// ---------------------------------------------------------------------------
// Adapter registry — how the runner instantiates each system.
// ---------------------------------------------------------------------------
//
// Each adapter module exports a factory. The runner builds the adapter, runs a
// cell, then calls teardown(). Factories are lazy (nothing spawned until
// called) so enumerating available systems is free.
export type AdapterFactory = () => Adapter | Promise<Adapter>;
