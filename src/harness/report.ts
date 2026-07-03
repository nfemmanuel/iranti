// Console reporting — Layer 0b.
//
// Formats a BenchReport + its baseline deltas as a readable table on
// stdout. Deliberately plain console.log formatting (no table-drawing
// dependency) — this is a measurement tool's output, not a UI.

import type { BenchReport } from "./scorer.js";
import type { MetricDelta } from "./baseline.js";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtDelta(d: MetricDelta): string {
  if (d.delta === null) return "(no baseline)";
  const sign = d.delta > 0 ? "+" : "";
  return `${sign}${(d.delta * 100).toFixed(1)}pp`;
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function renderReport(report: BenchReport, deltas: MetricDelta[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("iranti Layer 0b measurement harness — bench report");
  lines.push("=".repeat(72));

  const deltaByMetric = new Map(deltas.map((d) => [d.metric, d]));

  lines.push("");
  lines.push("Per-persona:");
  lines.push("-".repeat(72));
  for (const p of report.personas) {
    lines.push(`  ${p.persona}`);
    lines.push(
      `    extraction   recall=${pct(p.extraction.recall)} (${p.extraction.matchedCount}/${p.extraction.goldCount})` +
        `  precision=${pct(p.extraction.precision)} (${p.extraction.matchedCount}/${p.extraction.identityHits})` +
        `  stored=${p.extraction.storedCount}`,
    );
    const recallDelta = deltaByMetric.get(`${p.persona}.extraction.recall`);
    const precisionDelta = deltaByMetric.get(`${p.persona}.extraction.precision`);
    if (recallDelta || precisionDelta) {
      lines.push(
        `      vs baseline: recall ${recallDelta ? fmtDelta(recallDelta) : "n/a"}, ` +
          `precision ${precisionDelta ? fmtDelta(precisionDelta) : "n/a"}`,
      );
    }
    lines.push(
      `    retrieval    hit-rate=${pct(p.retrieval.hitRate)} (${p.retrieval.hitCount}/${p.retrieval.positiveCount})` +
        `  confirmation-rate=${pct(p.retrieval.confirmationRate)} (${p.retrieval.confirmedCount}/${p.retrieval.positiveCount})`,
    );
    lines.push(
      `    no-answer    false-positive-rate=${pct(p.retrieval.falsePositiveRate)} (${p.retrieval.falsePositiveCount}/${p.retrieval.negativeCount} negative probes; lower is better)`,
    );
    const hitDelta = deltaByMetric.get(`${p.persona}.retrieval.hitRate`);
    const confDelta = deltaByMetric.get(`${p.persona}.retrieval.confirmationRate`);
    const fpDelta = deltaByMetric.get(`${p.persona}.retrieval.falsePositiveRate`);
    if (hitDelta || confDelta || fpDelta) {
      lines.push(
        `      vs baseline: hit-rate ${hitDelta ? fmtDelta(hitDelta) : "n/a"}, ` +
          `confirmation-rate ${confDelta ? fmtDelta(confDelta) : "n/a"}, ` +
          `false-positive-rate ${fpDelta ? fmtDelta(fpDelta) : "n/a"}`,
      );
    }
    lines.push("");
  }

  lines.push("-".repeat(72));
  lines.push("Overall (micro-averaged across all personas):");
  const o = report.overall;
  lines.push(
    `  extraction   recall=${padRight(pct(o.extraction.recall), 7)} (${o.extraction.matchedCount}/${o.extraction.goldCount})` +
      `  precision=${padRight(pct(o.extraction.precision), 7)} (${o.extraction.matchedCount}/${o.extraction.identityHits})`,
  );
  lines.push(
    `  retrieval    hit-rate=${padRight(pct(o.retrieval.hitRate), 7)} (${o.retrieval.hitCount}/${o.retrieval.positiveCount})` +
      `  confirmation-rate=${padRight(pct(o.retrieval.confirmationRate), 7)} (${o.retrieval.confirmedCount}/${o.retrieval.positiveCount})`,
  );
  lines.push(
    `  no-answer    false-positive-rate=${padRight(pct(o.retrieval.falsePositiveRate), 7)} (${o.retrieval.falsePositiveCount}/${o.retrieval.negativeCount} negative probes; lower is better)`,
  );
  const overallDeltas = [
    deltaByMetric.get("overall.extraction.recall"),
    deltaByMetric.get("overall.extraction.precision"),
    deltaByMetric.get("overall.retrieval.hitRate"),
    deltaByMetric.get("overall.retrieval.confirmationRate"),
    deltaByMetric.get("overall.retrieval.falsePositiveRate"),
  ].filter((d): d is MetricDelta => d !== undefined);
  if (overallDeltas.length > 0) {
    lines.push("  vs baseline:");
    for (const d of overallDeltas) {
      lines.push(`    ${d.metric}: ${d.baseline === null ? "(no baseline)" : pct(d.baseline)} -> ${pct(d.current)}  [${fmtDelta(d)}]`);
    }
  }
  lines.push("=".repeat(72));
  lines.push("");

  return lines.join("\n");
}
