// Per-persona ingest — Layer 0b.
//
// Runs one corpus's messages through the REAL attend() path against a
// fresh, isolated embedded PGlite store, then runs its probes through
// attend() and collects the raw results for scoring.
//
// Isolation strategy (PRD §5 D7): attend() depends on module-level
// singletons — src/mcp/context.ts's agent/session handshake state and
// src/db/connection.ts's top-level-await'd db/pool. To get one fresh store
// per persona in a single vitest process (so all personas land in one
// latest.json), we:
//   1. Point IRANTI_DATA_DIR at a fresh mkdtemp'd directory.
//   2. vi.resetModules() so the next dynamic import() re-evaluates
//      connection.ts (fresh PGlite + auto-migrate) and context.ts (fresh
//      agent/session state) from scratch.
//   3. Dynamically import attend.js AFTER steps 1-2, every time.
// This is the same reset-and-reimport technique src/tests/persistence.test.ts
// already uses for a single restart cycle; this module generalizes it to a
// loop over N personas.
//
// This module is only ever called from within a vitest test (it needs
// `vi.resetModules()`, a vitest-only capability) — the caller passes it in
// as a `ModuleResetter` (below) rather than this module importing vitest
// directly, so harness logic stays decoupled from the test runner's API.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Corpus } from "./types.js";

// The minimal shape of a fact from AttendResult this module needs.
// Duplicated (not imported) from mcp/tools/attend.js's AttendResult on
// purpose: importing that module at harness-module scope would defeat the
// whole reset-and-reimport isolation story (see header comment) by pulling
// connection.ts into the module graph before the per-persona env vars are
// set. Every real import happens dynamically, inside runPersonaIngest.
export interface ProbeFactResult {
  entity: string;
  key: string;
  value: string;
  source: string;
  updatedAt: string;
  // Layer 0f: present on attend() probe responses (matched vs ambient);
  // absent on store read-backs (allFactsAfterIngest), where the concept
  // doesn't apply — extraction scoring ignores it.
  matched?: boolean;
}

export interface ProbeOutcome {
  query: string;
  expectedKeys: string[];
  // Mirrors CorpusProbe.negative — a no-answer probe whose returned facts
  // are all false positives (see types.ts / scorer.ts).
  negative: boolean;
  // All facts attend() returned for this probe (already rank-ordered).
  returnedFacts: ProbeFactResult[];
}

// Layer 0d — mirrors ProbeOutcome's shape for the rules dimension.
export interface RuleProbeOutcome {
  query: string;
  expectedRuleTextContains: string[];
  negative: boolean;
  // Every rule text attend() returned for this probe (rules[], budget-capped,
  // priority-ordered — see mcp/tools/attend.ts).
  returnedRuleTexts: string[];
}

// AX-9 — one outcome per fabrication probe. The probe text is fed DIRECTLY
// through the semantic extractor (extractor.extract), not through attend():
// the property under test is "does the extractor invent a fact from this
// text", which needs no store, no entity hints, and no retrieval — and
// keeping it store-free means a violating fact can never pollute the same
// run's extraction/retrieval scoring.
export interface FabricationOutcome {
  text: string;
  // Keys of every fact the extractor produced from the probe text.
  // Non-empty = violation.
  extractedKeys: string[];
}

export interface PersonaIngestResult {
  persona: string;
  // Every fact present in the store after ingest, across all entities the
  // transcript touched. Used for extraction recall/precision scoring.
  allFactsAfterIngest: ProbeFactResult[];
  // One outcome per probe, in corpus order.
  probeOutcomes: ProbeOutcome[];
  // Layer 0d — one outcome per ruleProbe, in corpus order. Empty when the
  // corpus defines no ruleProbes (optional field — see types.ts).
  ruleProbeOutcomes: RuleProbeOutcome[];
  // AX-9 — one outcome per fabricationProbe, in corpus order. Empty when the
  // corpus defines none.
  fabricationOutcomes: FabricationOutcome[];
}

// A stripped-down signature so this module doesn't need to import vitest's
// real Vi type (avoids a devDependency-only import at a module that's
// otherwise pure logic). The one method used is resetModules().
export interface ModuleResetter {
  resetModules(): void;
}

// extraction-measurement.md §3 change 1 — the harness must RESPECT a
// pre-set IRANTI_EXTRACTOR, defaulting to "heuristic" only when unset.
// Previously runPersonaIngest unconditionally forced "heuristic", so
// `IRANTI_EXTRACTOR=local pnpm bench` had ZERO effect (the protocol doc's
// "already exists as a mode" claim was false — see its §3 changelog).
//
// Pulled out as a pure function (no env access) so the default-vs-respect
// decision has a direct unit test independent of the env-mutation dance the
// rest of this module does.
export function effectiveExtractorMode(preset: string | undefined): string {
  return preset ?? "heuristic";
}

// Run one persona's full ingest + probe cycle against a brand-new embedded
// PGlite store. Returns the resulting facts and probe outcomes for scoring.
//
// Must be called sequentially per persona from the test (not concurrently)
// — env var mutation + module reset is inherently a shared, one-at-a-time
// resource, exactly like it-runs.test.ts's single-store setup.
export async function runPersonaIngest(
  corpus: Corpus,
  vi: ModuleResetter,
): Promise<PersonaIngestResult> {
  const dataDir = mkdtempSync(path.join(tmpdir(), `iranti-bench-${corpus.persona}-`));

  try {
    process.env["IRANTI_DB_ENGINE"] = "pglite";
    process.env["IRANTI_DATA_DIR"] = dataDir;
    // Default-only: a caller who pre-set IRANTI_EXTRACTOR (e.g. `local`,
    // to run the R1/R2 measurement regimes) is respected; unset falls back
    // to the deterministic heuristic default (R0, and every other suite
    // that calls this harness without setting the var at all).
    process.env["IRANTI_EXTRACTOR"] = effectiveExtractorMode(process.env["IRANTI_EXTRACTOR"]);
    delete process.env["DATABASE_URL"];

    vi.resetModules();

    const { attend } = await import("../mcp/tools/attend.js");

    // Layer 0 (D5/D6): attend() scopes every write to ctx.project.id, resolved
    // from process.cwd() (this repo's own git root when the harness runs
    // locally/in CI — resolveCurrentProject() is deterministic so calling it
    // again here yields the SAME id attend() already used internally).
    // Without this, the harness's direct DB reads below (readFactsByEntity)
    // would default to the "default" project scope and find nothing, even
    // though attend() itself still ingests and retrieves correctly (attend's
    // OWN return value is project-scoped consistently within itself — only
    // this harness's side-channel verification reads were affected).
    const { resolveCurrentProject } = await import("../library/projects.js");
    const harnessProject = (await resolveCurrentProject()).id;

    // ---- Layer 0d: seed corpus-declared rules via the REAL write path. -----
    // Rules have no extraction path (see PRD layer-0d-rules-enforcement.md
    // §9) — a corpus declares them explicitly and they are written through
    // writeRule exactly as iranti_write_rule would, BEFORE any transcript
    // message or probe runs, so every probe sees the fully-seeded rule set.
    if (corpus.rules && corpus.rules.length > 0) {
      const { writeRule } = await import("../library/rules.js");
      for (const rule of corpus.rules) {
        await writeRule({
          entityType: rule.entityType,
          entityId: rule.entityId,
          text: rule.text,
          priority: rule.priority,
          source: "bench-seed",
          project: harnessProject,
        });
      }
    }

    // ---- Ingest: feed every transcript message through attend(). ----------
    // Using attend() (not write()) for every message mirrors how a real host
    // would call iranti: the message is passed as `message`, entity hints as
    // given, and BOTH extraction paths fire exactly as they would in
    // production — the always-on deterministic artifact extractor (URLs/
    // paths) and the heuristic semantic extractor (decisions/preferences/
    // constraints/corrections/failed-approaches). This corpus format doesn't
    // need explicit write() calls: every gold fact in the four transcripts is
    // reachable via attend's extraction paths — see the PRD's non-goal that
    // this harness measures what exists, not exercises every tool.
    for (const message of corpus.messages) {
      await attend({
        entityHints: message.entityHints,
        message: message.text,
        agentName: `bench-${corpus.persona}`,
        phase: "pre-response",
      });
    }

    // The heuristic extractor's writes happen in attend's fire-and-forget
    // post-response chain (see mcp/tools/attend.ts's `void (async () => ...)`
    // block) — NOT before attend() resolves. A fixed sleep here would be
    // calibrated to one machine and become a nondeterminism flake on a
    // slower/loaded runner (review finding: run A settles in time, run B
    // doesn't, and the byte-identical assertion fails). Instead, poll the
    // store until the total fact count is identical across THREE
    // consecutive 100ms checks, with a bounded attempt ceiling. The chain
    // only ever ADDS facts, so a quiet 200ms window means it has drained
    // as far as this read can observe. (A true completion signal would
    // require changing attend() internals — an explicit PRD non-goal; the
    // residual risk is documented in the PRD §9.)
    const { readFactsByEntity } = await import("../library/facts.js");

    // extraction-measurement fix (found live, first R1 attempt): the
    // stability poll below was calibrated for the heuristic extractor's
    // near-instant writes. An LLM regime's extraction chains take SECONDS
    // per message — the poll's quiet 200ms window reported "settled" while
    // most extractions were still in flight, so the store was read back
    // nearly empty and R1 printed recall 16.7% — an instrument artifact,
    // not a model result. Every extraction chain is trackBackground'd
    // (RULE-2), so the DETERMINISTIC settle is to await the registry —
    // same module instance as attend's, because this import happens after
    // the same vi.resetModules() boundary. Generous bound in LLM mode;
    // heuristic keeps a short bound (its chains settle in milliseconds and
    // the poll below remains as belt-and-braces for both).
    const { settleBackground } = await import("../library/background.js");
    const settleBound =
      process.env["IRANTI_EXTRACTOR"] === "heuristic" ? 10_000 : 600_000;
    if (!(await settleBackground(settleBound))) {
      console.error(
        `[iranti bench] ingest settle exceeded ${settleBound}ms — fact readback may be incomplete`,
      );
    }

    // Deduped entity refs kept as real tuples — never joined into a
    // delimited string and re-split, so an entity id containing any
    // would-be separator character can never be truncated (same bug class
    // as the scorer's split("/", 2) review finding). Map preserves
    // insertion order, so iteration order stays corpus-deterministic.
    const entityRefs = new Map<string, { entityType: string; entityId: string }>();
    for (const m of corpus.messages) {
      for (const hint of m.entityHints) {
        entityRefs.set(JSON.stringify([hint.entityType, hint.entityId]), {
          entityType: hint.entityType,
          entityId: hint.entityId,
        });
      }
    }

    const countAllFacts = async (): Promise<number> => {
      let total = 0;
      for (const ref of entityRefs.values()) {
        total += (await readFactsByEntity(ref.entityType, ref.entityId, "default", harnessProject))
          .length;
      }
      return total;
    };
    let lastCount = -1;
    let stableChecks = 0;
    for (let attempt = 0; attempt < 100 && stableChecks < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const count = await countAllFacts();
      stableChecks = count === lastCount ? stableChecks + 1 : 0;
      lastCount = count;
    }

    // ---- Collect every fact written for every entity the transcript touched.
    const allFactsAfterIngest: ProbeFactResult[] = [];
    for (const ref of entityRefs.values()) {
      const facts = await readFactsByEntity(
        ref.entityType,
        ref.entityId,
        "default",
        harnessProject,
      );
      for (const f of facts) {
        allFactsAfterIngest.push({
          entity: `${f.entityType}/${f.entityId}`,
          key: f.key,
          value: f.value,
          source: f.source,
          updatedAt: f.updatedAt.toISOString(),
        });
      }
    }

    // ---- Run every probe through attend() and record what came back. ------
    // Note: attend() also runs its (write-side) artifact/extraction pass on
    // the probe's own query text — that's real attend() behavior, not
    // something to special-case away. It does not affect allFactsAfterIngest
    // (already captured above) or the scorer (which only reads
    // returnedFacts), so it's harmless here, but it does mean a probe run
    // AFTER other probes could theoretically surface a fact written by an
    // EARLIER probe's query text. None of this corpus's probe queries happen
    // to contain decision/preference/constraint phrasing, so this is a
    // documented non-issue today rather than a hidden one.
    const probeOutcomes: ProbeOutcome[] = [];
    for (const probe of corpus.probes) {
      const result = await attend({
        entityHints: probe.entityHints,
        message: probe.query,
        agentName: `bench-${corpus.persona}`,
        phase: "pre-response",
      });
      probeOutcomes.push({
        query: probe.query,
        expectedKeys: probe.expectedKeys,
        negative: probe.negative === true,
        returnedFacts: result.facts.map((f) => ({
          entity: f.entity,
          key: f.key,
          value: f.value,
          source: f.source,
          updatedAt: f.updatedAt,
          matched: f.matched,
        })),
      });
    }

    // ---- Layer 0d: run every ruleProbe through attend(), record rules[]. ---
    // Same attend() call shape as the fact probes above — a ruleProbe is
    // just another attend() call whose result is scored on rules[] instead
    // of facts[]. Runs after the fact probes so it never affects fact
    // scoring; rule seeding already happened before ingest, above.
    const ruleProbeOutcomes: RuleProbeOutcome[] = [];
    for (const ruleProbe of corpus.ruleProbes ?? []) {
      const result = await attend({
        entityHints: ruleProbe.entityHints,
        message: ruleProbe.query,
        agentName: `bench-${corpus.persona}`,
        phase: "pre-response",
      });
      ruleProbeOutcomes.push({
        query: ruleProbe.query,
        expectedRuleTextContains: ruleProbe.expectedRuleTextContains,
        negative: ruleProbe.negative === true,
        returnedRuleTexts: result.rules.map((r) => r.text),
      });
    }

    // ---- AX-9: fabrication probes — extractor-direct, store-free. ----------
    // Imported dynamically AFTER the module reset like everything else in
    // this function, so the extractor honors this persona run's
    // IRANTI_EXTRACTOR=heuristic env (buildExtractor reads it at module
    // evaluation time).
    const fabricationOutcomes: FabricationOutcome[] = [];
    if (corpus.fabricationProbes && corpus.fabricationProbes.length > 0) {
      const { extractor } = await import("../extract/index.js");
      for (const probe of corpus.fabricationProbes) {
        const extracted = await extractor.extract(probe.text);
        fabricationOutcomes.push({
          text: probe.text,
          extractedKeys: extracted.map((f) => f.key),
        });
      }
    }

    return {
      persona: corpus.persona,
      allFactsAfterIngest,
      probeOutcomes,
      ruleProbeOutcomes,
      fabricationOutcomes,
    };
  } finally {
    // Best-effort close + cleanup. A failure here must not mask a real test
    // failure above, so errors are swallowed (same posture as
    // it-runs.test.ts's afterAll).
    try {
      // Every probe above is itself an attend() call, which queues its own
      // fire-and-forget post-response chain (edge recording, extraction,
      // attend-log write — see mcp/tools/attend.ts). Those chains are still
      // running against the SAME single PGlite connection when the probes
      // loop returns. Closing immediately races that in-flight work: PGlite
      // is single-connection, so a query still queued when close() tears
      // down the connection can wedge the close (confirmed by reproduction
      // — see this module's PR discussion / the harness's own timing spike).
      // The same grace period used before reading facts back (above, and in
      // it-runs.test.ts's afterAll) is needed again here, after the LAST
      // attend() call in this function (the final probe), not just after
      // ingest's message loop.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const conn = await import("../db/connection.js");
      await conn.closeDb();
    } catch {
      // Store may already be in a bad state if ingest itself threw — nothing
      // more useful to do here.
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}
