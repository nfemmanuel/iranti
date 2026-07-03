// Baseline diffing — Layer 0b (PRD §5 D4).
//
// bench/baseline.json is checked in. Every bench run compares the current
// result against it and reports a per-metric delta, so "improved/regressed"
// is a printed number rather than a claim. --update-baseline (or the
// UPDATE_BASELINE env var, since this runs through vitest, not a CLI parser)
// regenerates it from the current run.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchReport } from "./scorer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = path.resolve(__dirname, "../../bench/baseline.json");
export const LATEST_PATH = path.resolve(__dirname, "../../bench/latest.json");

export function loadBaseline(): BenchReport | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as BenchReport;
}

export function writeBaseline(report: BenchReport): void {
  writeFileSync(BASELINE_PATH, JSON.stringify(report, null, 2) + "\n", "utf-8");
}

export function writeLatest(report: BenchReport): void {
  writeFileSync(LATEST_PATH, JSON.stringify(report, null, 2) + "\n", "utf-8");
}

export interface MetricDelta {
  metric: string;
  baseline: number | null;
  current: number;
  // current - baseline, rounded to 4dp; null when there's no baseline yet
  // (first-ever run) — reported as "n/a", not 0, so a fresh baseline isn't
  // misread as "no change".
  delta: number | null;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// Build the flat list of per-metric deltas the console reporter prints.
// Only the headline ratios are diffed (recall/precision/hitRate/
// confirmationRate) — raw counts are reported alongside but not diffed,
// since count deltas are only meaningful if the corpus size also changed,
// which the ratios already normalize for.
export function diffReports(baseline: BenchReport | null, current: BenchReport): MetricDelta[] {
  const metrics: Array<{ name: string; get: (r: BenchReport) => number }> = [
    { name: "overall.extraction.recall", get: (r) => r.overall.extraction.recall },
    { name: "overall.extraction.precision", get: (r) => r.overall.extraction.precision },
    { name: "overall.retrieval.hitRate", get: (r) => r.overall.retrieval.hitRate },
    { name: "overall.retrieval.confirmationRate", get: (r) => r.overall.retrieval.confirmationRate },
    // NaN-coalesced (not ?? 0) so a baseline generated before the negative-
    // probe class existed reports "(no baseline)" instead of a fake +delta.
    { name: "overall.retrieval.falsePositiveRate", get: (r) => r.overall.retrieval.falsePositiveRate ?? NaN },
    // Layer 0f — the pre-0f any-fact definition, kept printed for one
    // release. NaN-coalesced: pre-0f baselines lack the field.
    { name: "overall.retrieval.falsePositiveRateRaw", get: (r) => r.overall.retrieval.falsePositiveRateRaw ?? NaN },
    // Layer 0d — new metric class. NaN-coalesced for the same reason: any
    // baseline generated before this PRD shipped has no `rules` field at
    // all, so this must print "(no baseline)" rather than a fabricated
    // delta against `undefined`.
    { name: "overall.rules.ruleRelevanceRate", get: (r) => r.overall.rules?.ruleRelevanceRate ?? NaN },
    { name: "overall.rules.ruleNoiseRate", get: (r) => r.overall.rules?.ruleNoiseRate ?? NaN },
  ];

  for (const p of current.personas) {
    metrics.push(
      { name: `${p.persona}.extraction.recall`, get: (r) => r.personas.find((x) => x.persona === p.persona)?.extraction.recall ?? NaN },
      { name: `${p.persona}.extraction.precision`, get: (r) => r.personas.find((x) => x.persona === p.persona)?.extraction.precision ?? NaN },
      { name: `${p.persona}.retrieval.hitRate`, get: (r) => r.personas.find((x) => x.persona === p.persona)?.retrieval.hitRate ?? NaN },
      { name: `${p.persona}.retrieval.confirmationRate`, get: (r) => r.personas.find((x) => x.persona === p.persona)?.retrieval.confirmationRate ?? NaN },
      { name: `${p.persona}.retrieval.falsePositiveRate`, get: (r) => r.personas.find((x) => x.persona === p.persona)?.retrieval.falsePositiveRate ?? NaN },
      { name: `${p.persona}.rules.ruleRelevanceRate`, get: (r) => r.personas.find((x) => x.persona === p.persona)?.rules?.ruleRelevanceRate ?? NaN },
      { name: `${p.persona}.rules.ruleNoiseRate`, get: (r) => r.personas.find((x) => x.persona === p.persona)?.rules?.ruleNoiseRate ?? NaN },
    );
  }

  return metrics.map(({ name, get }) => {
    const currentValue = round4(get(current));
    if (!baseline) {
      return { metric: name, baseline: null, current: currentValue, delta: null };
    }
    const baselineValue = round4(get(baseline));
    if (Number.isNaN(baselineValue)) {
      // Metric didn't exist in the baseline (e.g. a persona added since) —
      // report as no-baseline rather than a misleading numeric delta.
      return { metric: name, baseline: null, current: currentValue, delta: null };
    }
    return {
      metric: name,
      baseline: baselineValue,
      current: currentValue,
      delta: round4(currentValue - baselineValue),
    };
  });
}
