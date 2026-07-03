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
}

// Load every *.json file in bench/corpus, sorted by filename so run order
// (and therefore report row order) is stable across machines and runs.
export function loadCorpora(): Corpus[] {
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No corpus files found in ${CORPUS_DIR}`);
  }

  return files.map((file) => {
    const full = path.join(CORPUS_DIR, file);
    const parsed: unknown = JSON.parse(readFileSync(full, "utf-8"));
    assertCorpusShape(parsed, file);
    return parsed;
  });
}
