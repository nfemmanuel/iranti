// BENCH-1 — LongMemEval-S dataset loader.
//
// Downloads and normalizes `longmemeval_s_cleaned.json` (HuggingFace
// xiaowu0162/longmemeval-cleaned, MIT) into EvalCase[] per bench/competitive/
// types.ts's Dataset contract. See docs/prds/phases/bench-1-fair-competitive-
// harness.md §4/§6 and docs/research/2026-07-04-memory-benchmark-methods.md
// (method #2) for why this is the primary apples-to-apples anchor.
//
// This file only downloads/parses/normalizes. It does not score, does not
// call an adapter, and (per the task that produced it) is not invoked by
// anything yet — the 277MB download only happens the first time a caller
// actually awaits loadLongMemEvalS().

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import type { DatasetLoader, EvalCase, WriteInput } from "../types.js";

const DATASET_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";

// Cached alongside this file, per the task spec.
const DATA_DIR = fileURLToPath(new URL("./data/", import.meta.url));
const CACHE_PATH = fileURLToPath(new URL("./data/longmemeval_s_cleaned.json", import.meta.url));

// -----------------------------------------------------------------------
// Raw on-disk schema (VERIFIED, per the task brief) — one element of the
// top-level JSON array in longmemeval_s_cleaned.json.
// -----------------------------------------------------------------------

interface RawTurn {
  role: string;
  content: string;
  has_answer?: boolean;
}

interface RawInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: RawTurn[][];
  answer_session_ids: string[];
}

// -----------------------------------------------------------------------
// Download (on-demand, cached).
// -----------------------------------------------------------------------

// Streams the ~277MB HF file to CACHE_PATH if it isn't already there. Safe
// to call repeatedly — a no-op once the file exists. Downloads to a `.part`
// sibling first and renames on success, so a killed download never leaves a
// truncated file masquerading as a complete cache hit.
async function ensureDownloaded(): Promise<void> {
  if (existsSync(CACHE_PATH)) return;

  await mkdir(DATA_DIR, { recursive: true });
  const partPath = `${CACHE_PATH}.part`;

  const res = await fetch(DATASET_URL);
  if (!res.ok || !res.body) {
    throw new Error(
      `longmemeval-s: download failed (${res.status} ${res.statusText}) from ${DATASET_URL}`,
    );
  }

  const fileStream = createWriteStream(partPath);
  try {
    await finished(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).pipe(fileStream));
  } catch (err) {
    // Clean up the partial file so a retry doesn't see a corrupt cache hit.
    await rm(partPath, { force: true });
    throw err;
  }

  await rename(partPath, CACHE_PATH);
}

// -----------------------------------------------------------------------
// Normalization.
// -----------------------------------------------------------------------

// Renders one haystack session's turns as "role: content" lines, prefixed
// with a date header — the shape the task spec asks for, and consistent
// with LongMemEval's own reader (run_generation.py's `nl` history_format:
// "{role}: {content}" per turn, one session per block).
function renderSession(dateHeader: string, turns: RawTurn[]): string {
  const lines = turns.map((t) => `${t.role}: ${t.content}`);
  return `Date: ${dateHeader}\n${lines.join("\n")}`;
}

function toEvalCase(raw: RawInstance): EvalCase {
  const history: WriteInput[] = raw.haystack_sessions.map((turns, i) => {
    const dateHeader = raw.haystack_dates[i] ?? "";
    return {
      conversation: renderSession(dateHeader, turns),
      sessionBoundary: i,
    };
  });

  return {
    id: raw.question_id,
    history,
    question: raw.question,
    gold: raw.answer,
    category: raw.question_type,
    isAbstention: raw.question_id.endsWith("_abs"),
  };
}

// -----------------------------------------------------------------------
// Stratified subsampling.
// -----------------------------------------------------------------------

// A plain first-N-by-id sample is NOT category-balanced (verified: first-30
// dropped single-session-assistant entirely and over-weighted knowledge-
// update). Since full-500 is infeasible for the LLM-extractor configs (~48
// sessions/case × 500 = tens of thousands of extraction calls), a subset MUST
// be stratified so every question_type is represented in proportion to the
// full set. Deterministic: id-sorted within each category, largest categories
// absorb the rounding remainder. Abstention (`_abs`, ~6% of the set, crossing
// categories) is included proportionally by construction — the returned count
// is reported in the results so a subset is never passed off as full-500.
function stratifiedSample(sorted: RawInstance[], limit: number): RawInstance[] {
  const byCat = new Map<string, RawInstance[]>();
  for (const r of sorted) {
    const arr = byCat.get(r.question_type) ?? [];
    arr.push(r);
    byCat.set(r.question_type, arr);
  }
  const cats = [...byCat.keys()].sort();
  const total = sorted.length;
  const alloc = new Map<string, number>();
  let assigned = 0;
  for (const cat of cats) {
    const n = Math.max(1, Math.round((byCat.get(cat)!.length / total) * limit));
    alloc.set(cat, n);
    assigned += n;
  }
  // Reconcile to hit `limit` exactly: largest categories give/take the diff.
  const catsBySize = [...cats].sort((a, b) => byCat.get(b)!.length - byCat.get(a)!.length);
  let diff = limit - assigned;
  let guard = 0;
  while (diff !== 0 && guard++ < 10000) {
    const cat = catsBySize[guard % catsBySize.length]!;
    const cur = alloc.get(cat)!;
    if (diff > 0) {
      alloc.set(cat, cur + 1);
      diff--;
    } else if (cur > 1) {
      alloc.set(cat, cur - 1);
      diff++;
    }
  }
  const picked: RawInstance[] = [];
  for (const cat of cats) picked.push(...byCat.get(cat)!.slice(0, alloc.get(cat)!));
  return picked.sort((a, b) => (a.question_id < b.question_id ? -1 : a.question_id > b.question_id ? 1 : 0));
}

// -----------------------------------------------------------------------
// Loader.
// -----------------------------------------------------------------------

export const loadLongMemEvalS: DatasetLoader = async (opts) => {
  await ensureDownloaded();

  const raw = JSON.parse(await readFile(CACHE_PATH, "utf-8")) as RawInstance[];

  // Stable id-sort so any subset is deterministic regardless of on-disk order.
  const sorted = [...raw].sort((a, b) => (a.question_id < b.question_id ? -1 : a.question_id > b.question_id ? 1 : 0));
  // `limit` now yields a STRATIFIED subset (all 6 categories, proportional),
  // not the first-N — see stratifiedSample above.
  const limited = opts?.limit !== undefined ? stratifiedSample(sorted, opts.limit) : sorted;

  const cases: EvalCase[] = limited.map(toEvalCase);

  return { id: "longmemeval-s", cases };
};
