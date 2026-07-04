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
  write(input: WriteInput, config: RunConfig): Promise<WriteResult>;
  query(question: string, config: RunConfig): Promise<QueryResult>;
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
