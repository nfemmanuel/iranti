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
// Loader.
// -----------------------------------------------------------------------

export const loadLongMemEvalS: DatasetLoader = async (opts) => {
  await ensureDownloaded();

  const raw = JSON.parse(await readFile(CACHE_PATH, "utf-8")) as RawInstance[];

  // Stable order: sort by id first so `limit` is deterministic regardless
  // of on-disk array order (the task's explicit "first N by id sort"
  // requirement), then normalize.
  const sorted = [...raw].sort((a, b) => (a.question_id < b.question_id ? -1 : a.question_id > b.question_id ? 1 : 0));
  const limited = opts?.limit !== undefined ? sorted.slice(0, opts.limit) : sorted;

  const cases: EvalCase[] = limited.map(toEvalCase);

  return { id: "longmemeval-s", cases };
};
