// CORE-16 — bench:semantic (minimal skeleton).
//
// A SEPARATE, embedder-required mode from the default `pnpm bench` (which
// stays embedder-free and byte-deterministic — see harness.test.ts). This
// spec requires IRANTI_EMBEDDER != off (a real Ollama endpoint, since the
// PRD's efficacy gate is measuring the REAL model's paraphrase-closing
// power, not the deterministic MockEmbedder used by
// src/tests/semantic-retrieval.test.ts) and skips cleanly with a clear
// console message when no embedder is reachable — it must never gate CI or
// the default `pnpm bench` path.
//
// Scope note (PRD-authorized minimalism): the full bench:semantic mode
// (per-persona corpus reuse, baseline diffing, precision-of-semantic-hits
// metric, etc., matching harness.test.ts's sophistication) would exceed the
// ~150 LOC-beyond-the-runner-flag budget the PRD sets for this build. This
// file is the skeleton: it detects the embedder, runs the shipped corpora's
// existing positive probes through attend() with the embedder active, and
// reports how many probes were answered ONLY via semantic fill (i.e. the
// deterministic tiers alone would have missed them) plus a bare precision
// figure (of the semantic hits, how many matched an expected key). The
// richer paraphrase-probe corpus (dedicated alias/paraphrase fixtures beyond
// what the 4 personas already contain), baseline-diffing across runs, and a
// distinct precision-of-semantic-hits metric broken out per persona are
// named follow-ups — see the PRD changelog entry this ships alongside.

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, vi } from "vitest";
import { loadCorpora } from "./corpus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_SEMANTIC_PATH = path.resolve(__dirname, "../../bench/baseline-semantic.json");

const EMBED_ENDPOINT = process.env["IRANTI_EMBED_ENDPOINT"] ?? "http://localhost:11434";
const EMBED_MODEL = process.env["IRANTI_EMBED_MODEL"] ?? "nomic-embed-text";

async function embedderReachable(): Promise<boolean> {
  if ((process.env["IRANTI_EMBEDDER"] ?? "off") === "off") return false;
  try {
    const res = await fetch(`${EMBED_ENDPOINT}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: ["ping"] }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { embeddings?: unknown };
    return Array.isArray(json.embeddings) && json.embeddings.length > 0;
  } catch {
    return false;
  }
}

interface SemanticBenchResult {
  totalPositiveProbes: number;
  semanticOnlyHits: number; // probes where an expected key showed up ONLY via a semantic:true fact
  semanticPrecisionHits: number; // among ALL semantic:true facts returned, how many named an expected key
  semanticFactsReturned: number;
}

describe("CORE-16 — bench:semantic (embedder required)", () => {
  it("runs the shipped corpora's probes with a live embedder, or skips cleanly", async () => {
    const reachable = await embedderReachable();
    if (!reachable) {
      console.log(
        `\n[bench:semantic] SKIPPED — IRANTI_EMBEDDER is off, or no embedder reachable at ` +
          `${EMBED_ENDPOINT} with model "${EMBED_MODEL}". This mode is NOT wired into the ` +
          `default \`pnpm bench\` and never gates CI. To run it locally: start Ollama, ` +
          `\`ollama pull ${EMBED_MODEL}\`, then \`IRANTI_EMBEDDER=ollama pnpm bench:semantic\`.\n`,
      );
      return;
    }

    const corpora = loadCorpora();
    const dataDir = mkdtempSync(path.join(tmpdir(), "iranti-bench-semantic-"));
    const result: SemanticBenchResult = {
      totalPositiveProbes: 0,
      semanticOnlyHits: 0,
      semanticPrecisionHits: 0,
      semanticFactsReturned: 0,
    };

    try {
      process.env["IRANTI_DB_ENGINE"] = "pglite";
      process.env["IRANTI_DATA_DIR"] = dataDir;
      process.env["IRANTI_EXTRACTOR"] = "heuristic";
      delete process.env["DATABASE_URL"];
      vi.resetModules();

      const { attend } = await import("../mcp/tools/attend.js");

      for (const corpus of corpora) {
        // Ingest the transcript exactly like the default bench does.
        for (const message of corpus.messages) {
          await attend({
            entityHints: message.entityHints,
            message: message.text,
            agentName: `bench-semantic-${corpus.persona}`,
            phase: "pre-response",
          });
        }
        // Grace period for the fire-and-forget post-response chain (heuristic
        // extraction) — same reasoning as ingest.ts's polling wait, kept
        // simple here since this skeleton doesn't score extraction at all.
        await new Promise((resolve) => setTimeout(resolve, 300));

        for (const probe of corpus.probes) {
          if (probe.negative || probe.expectedKeys.length === 0) continue;
          result.totalPositiveProbes++;

          const res = await attend({
            entityHints: probe.entityHints,
            message: probe.query,
            agentName: `bench-semantic-${corpus.persona}`,
            phase: "pre-response",
          });

          const semanticFacts = res.facts.filter((f) => f.semantic === true);
          result.semanticFactsReturned += semanticFacts.length;

          const deterministicHitsExpectedKey = res.facts.some(
            (f) => !f.semantic && probe.expectedKeys.includes(f.key),
          );
          const semanticHitsExpectedKey = semanticFacts.some((f) =>
            probe.expectedKeys.includes(f.key),
          );

          if (!deterministicHitsExpectedKey && semanticHitsExpectedKey) {
            result.semanticOnlyHits++;
          }
          if (semanticHitsExpectedKey) {
            result.semanticPrecisionHits++;
          }
        }
      }

      console.log(
        `\n[bench:semantic] positive probes: ${result.totalPositiveProbes}, ` +
          `semantic-only hits (deterministic tiers alone would have missed): ${result.semanticOnlyHits}, ` +
          `semantic facts returned: ${result.semanticFactsReturned}, ` +
          `of which named an expected key: ${result.semanticPrecisionHits}\n`,
      );

      // Baseline file is created ONLY on an actual run (PRD requirement) —
      // no diffing logic yet (named follow-up); this just records the run so
      // a future fuller mode has a starting point to diff against.
      if (!existsSync(BASELINE_SEMANTIC_PATH)) {
        writeFileSync(BASELINE_SEMANTIC_PATH, JSON.stringify(result, null, 2) + "\n", "utf-8");
        console.log(`[bench:semantic] wrote initial ${BASELINE_SEMANTIC_PATH}`);
      }
    } finally {
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const conn = await import("../db/connection.js");
        await conn.closeDb();
      } catch {
        // best-effort, same posture as ingest.ts
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});
