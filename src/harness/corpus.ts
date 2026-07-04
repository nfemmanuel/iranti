// Corpus loading — Layer 0b.
//
// Reads bench/corpus/*.json off disk and validates the minimal shape the
// harness depends on. Deliberately no zod dependency here: the harness's own
// constraint is "no new runtime deps unless truly necessary" (PRD
// Constraints) and this validation is a handful of array/string checks.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Corpus } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/harness/corpus.ts -> ../../bench/corpus
export const CORPUS_DIR = path.resolve(__dirname, "../../bench/corpus");
// messy-corpus build — a SEPARATE directory (never bench/corpus itself) so
// the default `pnpm bench` corpus stays untouched/deterministic. Same Corpus
// schema, same validation (assertCorpusShape below), different content:
// realistic messy/rambling transcripts + a novel-vocabulary persona, gold-
// labeled primarily by VALUE (see extraction-measurement.md / the v1-wave1
// build report §4 for why key-identity credit can't see an LLM's value on
// differently-worded keys — this corpus + the scorer's valueRecall metric
// are the pair that closes that blind spot).
export const CORPUS_MESSY_DIR = path.resolve(__dirname, "../../bench/corpus-messy");

function assertCorpusShape(value: unknown, file: string): asserts value is Corpus {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Corpus file ${file} did not parse to an object.`);
  }
  const c = value as Record<string, unknown>;
  if (typeof c["persona"] !== "string" || c["persona"].length === 0) {
    throw new Error(`Corpus file ${file} is missing a non-empty "persona" string.`);
  }
  if (!Array.isArray(c["messages"]) || c["messages"].length === 0) {
    throw new Error(`Corpus file ${file} ("${c["persona"]}") has no messages.`);
  }
  if (!Array.isArray(c["goldFacts"])) {
    throw new Error(`Corpus file ${file} ("${c["persona"]}") is missing "goldFacts" array.`);
  }
  if (!Array.isArray(c["probes"]) || c["probes"].length === 0) {
    throw new Error(`Corpus file ${file} ("${c["persona"]}") has no probes.`);
  }
  // Authoring guard: a negative probe with expectedKeys (or a positive probe
  // without them) is a corpus bug that would silently corrupt both the
  // false-positive metric and hit-rate. Fail loudly at load time instead.
  for (const probe of c["probes"] as Array<Record<string, unknown>>) {
    const isNegative = probe["negative"] === true;
    const expectedKeys = probe["expectedKeys"];
    const hasKeys = Array.isArray(expectedKeys) && expectedKeys.length > 0;
    if (isNegative && hasKeys) {
      throw new Error(
        `Corpus file ${file} ("${c["persona"]}"): negative probe "${String(probe["query"])}" must have empty expectedKeys.`,
      );
    }
    if (!isNegative && !hasKeys) {
      throw new Error(
        `Corpus file ${file} ("${c["persona"]}"): probe "${String(probe["query"])}" has no expectedKeys and is not marked negative.`,
      );
    }
  }

  // Layer 0d: same authoring guard, applied to the optional ruleProbes array
  // — a negative rule probe with expectedRuleTextContains (or a positive one
  // without) would silently corrupt ruleRelevanceRate/ruleNoiseRate.
  if (c["ruleProbes"] !== undefined) {
    if (!Array.isArray(c["ruleProbes"])) {
      throw new Error(`Corpus file ${file} ("${c["persona"]}"): "ruleProbes" must be an array.`);
    }
    for (const probe of c["ruleProbes"] as Array<Record<string, unknown>>) {
      const isNegative = probe["negative"] === true;
      const expected = probe["expectedRuleTextContains"];
      const hasExpected = Array.isArray(expected) && expected.length > 0;
      if (isNegative && hasExpected) {
        throw new Error(
          `Corpus file ${file} ("${c["persona"]}"): negative rule probe "${String(probe["query"])}" must have empty expectedRuleTextContains.`,
        );
      }
      if (!isNegative && !hasExpected) {
        throw new Error(
          `Corpus file ${file} ("${c["persona"]}"): rule probe "${String(probe["query"])}" has no expectedRuleTextContains and is not marked negative.`,
        );
      }
    }
  }
  if (c["rules"] !== undefined && !Array.isArray(c["rules"])) {
    throw new Error(`Corpus file ${file} ("${c["persona"]}"): "rules" must be an array.`);
  }

  // AX-9: fabrication probes are text-only; an empty text would make the
  // probe vacuously pass (nothing extracts from ""), silently inflating the
  // honesty number — fail loudly at load time instead.
  if (c["fabricationProbes"] !== undefined) {
    if (!Array.isArray(c["fabricationProbes"])) {
      throw new Error(
        `Corpus file ${file} ("${c["persona"]}"): "fabricationProbes" must be an array.`,
      );
    }
    for (const probe of c["fabricationProbes"] as Array<Record<string, unknown>>) {
      if (typeof probe["text"] !== "string" || probe["text"].trim().length === 0) {
        throw new Error(
          `Corpus file ${file} ("${c["persona"]}"): every fabrication probe needs non-empty "text".`,
        );
      }
    }
  }
}

// Load every *.json file in an arbitrary corpus directory, sorted by
// filename so run order (and therefore report row order) is stable across
// machines and runs. Shared by loadCorpora() (bench/corpus, the default
// heuristic bench) and loadMessyCorpora() (bench/corpus-messy, below) so
// both directories get IDENTICAL shape validation — a messy-corpus author
// typo is caught the same way a default-corpus one is.
function loadCorporaFrom(dir: string): Corpus[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No corpus files found in ${dir}`);
  }

  return files.map((file) => {
    const full = path.join(dir, file);
    const parsed: unknown = JSON.parse(readFileSync(full, "utf-8"));
    assertCorpusShape(parsed, file);
    return parsed;
  });
}

// Load every *.json file in bench/corpus. Unchanged behavior/signature from
// before the messy-corpus build — this function's body is now a thin
// delegation to loadCorporaFrom(CORPUS_DIR) instead of its own copy of the
// same loop, but every existing caller sees identical results.
export function loadCorpora(): Corpus[] {
  return loadCorporaFrom(CORPUS_DIR);
}

// messy-corpus build — loads bench/corpus-messy instead. Never called by
// harness.test.ts (the default `pnpm bench` spec) — only by
// messy-bench.test.ts (`pnpm bench:messy`, new in this build).
export function loadMessyCorpora(): Corpus[] {
  return loadCorporaFrom(CORPUS_MESSY_DIR);
}
