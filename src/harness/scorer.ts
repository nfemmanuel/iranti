// Scoring — Layer 0b.
//
// Turns raw ingest/probe output into the named metrics (PRD §5 D3):
//   1. extraction recall & precision (vs gold facts)
//   2. retrieval hit-rate (+ rank)
//   3. confirmation rate (top-of-list, not just "somewhere in the list")
//   4. false-positive rate on negative (no-answer) probes — whether
//      retrieval knows when it doesn't know (see types.ts CorpusProbe).
//   5. determinism (scored separately, in harness.test.ts, by diffing two
//      full report JSONs — not a per-persona metric, so it isn't here).

import { normalizeKey } from "../library/keys.js";
import type { Corpus, GoldFact } from "./types.js";
import type {
  FabricationOutcome,
  PersonaIngestResult,
  ProbeFactResult,
  RuleProbeOutcome,
} from "./ingest.js";

// --------------------------------------------------------------------------
// Value matching — deliberately lenient (PRD §9 risk, documented here too).
// --------------------------------------------------------------------------

function normalizeValue(v: string): string {
  return v.toLowerCase().replace(/\s+/g, " ").trim();
}

// A stored fact's value "matches" a gold value if either contains the other
// after normalization. Real extractors paraphrase ("we decided to use X" ->
// stores "to use X" or "X") so exact equality would be a scorer bug, not a
// real signal of correctness. This is intentionally permissive; see PRD §9.
export function valueMatches(storedValue: string, goldValue: string): boolean {
  const a = normalizeValue(storedValue);
  const b = normalizeValue(goldValue);
  if (a.length === 0 || b.length === 0) return false;
  return a.includes(b) || b.includes(a);
}

function factIdentity(entityType: string, entityId: string, key: string): string {
  return `${entityType}/${entityId}::${normalizeKey(key)}`;
}

// --------------------------------------------------------------------------
// Extraction recall / precision
// --------------------------------------------------------------------------

export interface ExtractionScore {
  goldCount: number;
  storedCount: number;
  // Gold-fact identity slots (entity+key) that exist among the stored facts,
  // regardless of whether the value matched. Exposed explicitly (rather than
  // reconstructed from precision) so aggregation across personas is exact.
  identityHits: number;
  // Gold facts that were found (identity + lenient value match) among the
  // stored facts.
  matchedCount: number;
  recall: number; // matchedCount / goldCount (0 when goldCount === 0)
  // extraction-measurement.md (messy-corpus build) — KEY-AGNOSTIC credit.
  // A gold fact counts here if its VALUE lenient-matches (valueMatches)
  // ANY stored fact's value, regardless of entity/key. This is deliberately
  // separate from identityHits/matchedCount above (recall's key-identity
  // path is UNCHANGED by this field's existence — see valueRecallCount's own
  // independent loop below, not a reuse of the identity-keyed map) because
  // the whole point is to credit an extractor that stored the SAME fact
  // under a DIFFERENT key than the heuristic's synthesized one — the exact
  // blind spot the docs/reviews/2026-07-04-v1-wave1-build.md §4 finding
  // named: "a gold fact is credited only if stored under the extractor's
  // exact synthesized key... recall structurally cannot rise on the LLM
  // path even when it should." valueRecall is the metric that CAN rise.
  valueRecallCount: number;
  valueRecall: number; // valueRecallCount / goldCount (0 when goldCount === 0)
  // Stored facts that matched SOME gold fact's identity+value. Facts stored
  // that don't correspond to any gold fact are not "wrong" in a strict sense
  // (the corpus doesn't enumerate every non-gold fact that's fine to store)
  // — precision here means "of the gold-identity slots iranti filled, how
  // many had the right value", which is the precision question this corpus
  // can actually answer with its lenient-value-match gold labels.
  precision: number; // matchedCount / identityHits (0 when identityHits === 0)
  // AX-9 — fabrication dimension. goldFacts is an allow-list, so recall/
  // precision above structurally cannot punish an INVENTED fact (the scorer
  // ignores stored facts matching no gold identity — see the precision doc
  // comment). fabricationProbes close that blind spot: each probe text must
  // extract NOTHING; a probe that extracts anything is a violation.
  fabricationProbeCount: number;
  fabricationViolationCount: number;
  fabricationRate: number; // violations / probes (0 when no probes; LOWER is better)
  perFabricationProbe: FabricationProbeScore[];
}

export interface FabricationProbeScore {
  text: string;
  extractedKeys: string[];
  violated: boolean; // extractedKeys.length > 0
}

export function scoreExtraction(
  goldFacts: GoldFact[],
  storedFacts: ProbeFactResult[],
  fabricationOutcomes: FabricationOutcome[] = [],
): ExtractionScore {
  const goldCount = goldFacts.length;
  const storedCount = storedFacts.length;

  const storedByIdentity = new Map<string, ProbeFactResult[]>();
  for (const f of storedFacts) {
    // Only the FIRST "/" separates entityType from entityId. split("/", 2)
    // would TRUNCATE an entityId containing further slashes (JS's limit
    // drops the remainder, unlike Python's), silently zeroing recall for
    // e.g. org/repo-style ids — review finding.
    const sep = f.entity.indexOf("/");
    const entityType = f.entity.slice(0, sep);
    const entityId = f.entity.slice(sep + 1);
    const id = factIdentity(entityType, entityId, f.key);
    const list = storedByIdentity.get(id) ?? [];
    list.push(f);
    storedByIdentity.set(id, list);
  }

  let matchedCount = 0;
  let identityHits = 0;
  for (const gold of goldFacts) {
    const id = factIdentity(gold.entityType, gold.entityId, gold.key);
    const candidates = storedByIdentity.get(id);
    if (!candidates || candidates.length === 0) continue;
    identityHits++;
    if (candidates.some((c) => valueMatches(c.value, gold.value))) {
      matchedCount++;
    }
  }

  // valueRecall — independent loop, deliberately NOT derived from the
  // identity-keyed pass above: it must credit a stored fact under ANY key
  // (or even a different entity — an LLM extractor's entity-scoping errors
  // are a separate concern from its key-wording, and this metric isolates
  // key-wording specifically), so it scans every stored fact's value against
  // every gold fact's value with no identity gate at all. O(goldCount x
  // storedCount) — corpora here are small (tens of facts), so a nested loop
  // is clearer than building a second index for a one-off scorer pass.
  let valueRecallCount = 0;
  for (const gold of goldFacts) {
    if (storedFacts.some((f) => valueMatches(f.value, gold.value))) {
      valueRecallCount++;
    }
  }

  const perFabricationProbe: FabricationProbeScore[] = fabricationOutcomes.map((o) => ({
    text: o.text,
    extractedKeys: o.extractedKeys,
    violated: o.extractedKeys.length > 0,
  }));
  const fabricationProbeCount = perFabricationProbe.length;
  const fabricationViolationCount = perFabricationProbe.filter((p) => p.violated).length;

  return {
    goldCount,
    storedCount,
    identityHits,
    matchedCount,
    recall: goldCount > 0 ? matchedCount / goldCount : 0,
    valueRecallCount,
    valueRecall: goldCount > 0 ? valueRecallCount / goldCount : 0,
    // Precision here is scoped to the gold-identity slots that were filled
    // at all (identityHits) — of those, how many had the correct value.
    // A slot never filled counts against recall, not precision.
    precision: identityHits > 0 ? matchedCount / identityHits : 0,
    fabricationProbeCount,
    fabricationViolationCount,
    fabricationRate:
      fabricationProbeCount > 0 ? fabricationViolationCount / fabricationProbeCount : 0,
    perFabricationProbe,
  };
}

// --------------------------------------------------------------------------
// Retrieval hit-rate + confirmation rate
// --------------------------------------------------------------------------

export interface ProbeScore {
  query: string;
  expectedKeys: string[];
  negative: boolean;
  // 1-based rank of the first matching expected fact in returnedFacts, or
  // null if none of the expected keys appear anywhere in the returned list.
  // Always null for negative probes (they expect nothing).
  rank: number | null;
  hit: boolean; // rank !== null (always false for negative probes)
  confirmed: boolean; // rank === 1 (always false for negative probes)
  // Negative probes only: attend() returned one or more MATCHED facts for
  // a query whose answer is not in the corpus (Layer 0f redefinition:
  // ambient-labeled context is honest background, not a false claim; a
  // matched-labeled fact on a no-answer query IS). Always false for
  // positive probes.
  falsePositive: boolean;
  // Negative probes only: the ORIGINAL harsh pre-0f definition — ANY fact
  // returned at all, matched or ambient. Printed alongside for one release
  // (PRD 0f §5) so the improvement reads as a measured delta, not a silent
  // definition swap. Always false for positive probes.
  falsePositiveRaw: boolean;
}

export interface RetrievalScore {
  probeCount: number; // all probes, positive + negative
  positiveCount: number;
  hitCount: number;
  confirmedCount: number;
  hitRate: number; // hitCount / positiveCount
  confirmationRate: number; // confirmedCount / positiveCount
  negativeCount: number;
  falsePositiveCount: number;
  falsePositiveRate: number; // falsePositiveCount / negativeCount (lower is better)
  falsePositiveRawCount: number;
  falsePositiveRateRaw: number; // pre-0f any-fact definition, for transparency
  perProbe: ProbeScore[];
}

export function scoreRetrieval(result: PersonaIngestResult): RetrievalScore {
  const perProbe: ProbeScore[] = result.probeOutcomes.map((outcome) => {
    if (outcome.negative) {
      return {
        query: outcome.query,
        expectedKeys: outcome.expectedKeys,
        negative: true,
        rank: null,
        hit: false,
        confirmed: false,
        falsePositive: outcome.returnedFacts.some((f) => f.matched === true),
        falsePositiveRaw: outcome.returnedFacts.length > 0,
      };
    }
    const expectedNormalized = new Set(outcome.expectedKeys.map(normalizeKey));
    let rank: number | null = null;
    for (let i = 0; i < outcome.returnedFacts.length; i++) {
      const fact = outcome.returnedFacts[i]!;
      if (expectedNormalized.has(normalizeKey(fact.key))) {
        rank = i + 1;
        break;
      }
    }
    return {
      query: outcome.query,
      expectedKeys: outcome.expectedKeys,
      negative: false,
      rank,
      hit: rank !== null,
      confirmed: rank === 1,
      falsePositive: false,
      falsePositiveRaw: false,
    };
  });

  const positives = perProbe.filter((p) => !p.negative);
  const negatives = perProbe.filter((p) => p.negative);
  const positiveCount = positives.length;
  const hitCount = positives.filter((p) => p.hit).length;
  const confirmedCount = positives.filter((p) => p.confirmed).length;
  const negativeCount = negatives.length;
  const falsePositiveCount = negatives.filter((p) => p.falsePositive).length;
  const falsePositiveRawCount = negatives.filter((p) => p.falsePositiveRaw).length;

  return {
    probeCount: perProbe.length,
    positiveCount,
    hitCount,
    confirmedCount,
    // Hit/confirmation rates are over POSITIVE probes only — negative probes
    // expect nothing, so counting them here would deflate both rates with
    // guaranteed misses instead of measuring what they actually measure
    // (falsePositiveRate below).
    hitRate: positiveCount > 0 ? hitCount / positiveCount : 0,
    confirmationRate: positiveCount > 0 ? confirmedCount / positiveCount : 0,
    negativeCount,
    falsePositiveCount,
    falsePositiveRate: negativeCount > 0 ? falsePositiveCount / negativeCount : 0,
    falsePositiveRawCount,
    falsePositiveRateRaw: negativeCount > 0 ? falsePositiveRawCount / negativeCount : 0,
    perProbe,
  };
}

// --------------------------------------------------------------------------
// Rule relevance / noise (Layer 0d) — mirrors the retrieval section above.
// --------------------------------------------------------------------------

export interface RuleProbeScore {
  query: string;
  expectedRuleTextContains: string[];
  negative: boolean;
  // True if some returned rule's text contains one of the expected
  // substrings (case-insensitive). Always false for negative probes.
  relevant: boolean;
  // Negative rule probes only: attend() injected one or more rules for a
  // situation where none of this entity's active rules should have fired.
  // Always false for positive probes.
  noise: boolean;
}

export interface RuleRetrievalScore {
  ruleProbeCount: number; // all rule probes, positive + negative
  positiveCount: number;
  relevantCount: number;
  // expected rule surfaced / positive rule probe count (higher is better).
  ruleRelevanceRate: number;
  negativeCount: number;
  noiseCount: number;
  // rule injected on a negative rule probe / negative rule probe count
  // (lower is better) — exact mirror of falsePositiveRate's shape.
  ruleNoiseRate: number;
  perRuleProbe: RuleProbeScore[];
}

function containsSubstring(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function scoreRules(ruleProbeOutcomes: RuleProbeOutcome[]): RuleRetrievalScore {
  const perRuleProbe: RuleProbeScore[] = ruleProbeOutcomes.map((outcome) => {
    if (outcome.negative) {
      return {
        query: outcome.query,
        expectedRuleTextContains: outcome.expectedRuleTextContains,
        negative: true,
        relevant: false,
        noise: outcome.returnedRuleTexts.length > 0,
      };
    }
    const relevant = outcome.expectedRuleTextContains.some((needle) =>
      outcome.returnedRuleTexts.some((text) => containsSubstring(text, needle)),
    );
    return {
      query: outcome.query,
      expectedRuleTextContains: outcome.expectedRuleTextContains,
      negative: false,
      relevant,
      noise: false,
    };
  });

  const positives = perRuleProbe.filter((p) => !p.negative);
  const negatives = perRuleProbe.filter((p) => p.negative);
  const positiveCount = positives.length;
  const relevantCount = positives.filter((p) => p.relevant).length;
  const negativeCount = negatives.length;
  const noiseCount = negatives.filter((p) => p.noise).length;

  return {
    ruleProbeCount: perRuleProbe.length,
    positiveCount,
    relevantCount,
    ruleRelevanceRate: positiveCount > 0 ? relevantCount / positiveCount : 0,
    negativeCount,
    noiseCount,
    ruleNoiseRate: negativeCount > 0 ? noiseCount / negativeCount : 0,
    perRuleProbe,
  };
}

// --------------------------------------------------------------------------
// Per-persona + overall report shape
// --------------------------------------------------------------------------

export interface PersonaReport {
  persona: string;
  extraction: ExtractionScore;
  retrieval: RetrievalScore;
  rules: RuleRetrievalScore;
}

export interface OverallReport {
  // Micro-average across all personas (weights every gold fact / probe
  // equally, not every persona equally) — the fairest single number given
  // personas have different corpus sizes.
  extraction: ExtractionScore;
  retrieval: RetrievalScore;
  rules: RuleRetrievalScore;
}

export interface BenchReport {
  personas: PersonaReport[];
  overall: OverallReport;
}

export function scorePersona(corpus: Corpus, result: PersonaIngestResult): PersonaReport {
  return {
    persona: corpus.persona,
    extraction: scoreExtraction(
      corpus.goldFacts,
      result.allFactsAfterIngest,
      result.fabricationOutcomes,
    ),
    retrieval: scoreRetrieval(result),
    rules: scoreRules(result.ruleProbeOutcomes),
  };
}

export function buildOverallReport(personas: PersonaReport[]): OverallReport {
  const goldCount = personas.reduce((s, p) => s + p.extraction.goldCount, 0);
  const storedCount = personas.reduce((s, p) => s + p.extraction.storedCount, 0);
  const identityHits = personas.reduce((s, p) => s + p.extraction.identityHits, 0);
  const matchedCount = personas.reduce((s, p) => s + p.extraction.matchedCount, 0);
  const valueRecallCount = personas.reduce((s, p) => s + p.extraction.valueRecallCount, 0);

  // AX-9 — micro-averaged exactly like every other overall ratio.
  const fabricationProbeCount = personas.reduce(
    (s, p) => s + p.extraction.fabricationProbeCount,
    0,
  );
  const fabricationViolationCount = personas.reduce(
    (s, p) => s + p.extraction.fabricationViolationCount,
    0,
  );

  const extraction: ExtractionScore = {
    goldCount,
    storedCount,
    identityHits,
    matchedCount,
    recall: goldCount > 0 ? matchedCount / goldCount : 0,
    valueRecallCount,
    valueRecall: goldCount > 0 ? valueRecallCount / goldCount : 0,
    // Micro-averaged exactly (matched / identity-hits summed across all
    // personas first, then divided once) — equivalent to weighting each
    // persona's precision by its identityHits, without the reconstruction
    // ambiguity that would come from trying to recover identityHits from a
    // precision ratio alone (precision === 0 is ambiguous between
    // identityHits === 0 and identityHits > 0 with zero value-matches).
    precision: identityHits > 0 ? matchedCount / identityHits : 0,
    fabricationProbeCount,
    fabricationViolationCount,
    fabricationRate:
      fabricationProbeCount > 0 ? fabricationViolationCount / fabricationProbeCount : 0,
    perFabricationProbe: personas.flatMap((p) => p.extraction.perFabricationProbe),
  };

  const probeCount = personas.reduce((s, p) => s + p.retrieval.probeCount, 0);
  const positiveCount = personas.reduce((s, p) => s + p.retrieval.positiveCount, 0);
  const hitCount = personas.reduce((s, p) => s + p.retrieval.hitCount, 0);
  const confirmedCount = personas.reduce((s, p) => s + p.retrieval.confirmedCount, 0);
  const negativeCount = personas.reduce((s, p) => s + p.retrieval.negativeCount, 0);
  const falsePositiveCount = personas.reduce((s, p) => s + p.retrieval.falsePositiveCount, 0);
  const falsePositiveRawCount = personas.reduce(
    (s, p) => s + p.retrieval.falsePositiveRawCount,
    0,
  );

  const retrieval: RetrievalScore = {
    probeCount,
    positiveCount,
    hitCount,
    confirmedCount,
    hitRate: positiveCount > 0 ? hitCount / positiveCount : 0,
    confirmationRate: positiveCount > 0 ? confirmedCount / positiveCount : 0,
    negativeCount,
    falsePositiveCount,
    falsePositiveRate: negativeCount > 0 ? falsePositiveCount / negativeCount : 0,
    falsePositiveRawCount,
    falsePositiveRateRaw: negativeCount > 0 ? falsePositiveRawCount / negativeCount : 0,
    perProbe: personas.flatMap((p) => p.retrieval.perProbe),
  };

  // Layer 0d — micro-averaged exactly like retrieval above.
  const rulePositiveCount = personas.reduce((s, p) => s + p.rules.positiveCount, 0);
  const ruleRelevantCount = personas.reduce((s, p) => s + p.rules.relevantCount, 0);
  const ruleNegativeCount = personas.reduce((s, p) => s + p.rules.negativeCount, 0);
  const ruleNoiseCount = personas.reduce((s, p) => s + p.rules.noiseCount, 0);

  const rules: RuleRetrievalScore = {
    ruleProbeCount: personas.reduce((s, p) => s + p.rules.ruleProbeCount, 0),
    positiveCount: rulePositiveCount,
    relevantCount: ruleRelevantCount,
    ruleRelevanceRate: rulePositiveCount > 0 ? ruleRelevantCount / rulePositiveCount : 0,
    negativeCount: ruleNegativeCount,
    noiseCount: ruleNoiseCount,
    ruleNoiseRate: ruleNegativeCount > 0 ? ruleNoiseCount / ruleNegativeCount : 0,
    perRuleProbe: personas.flatMap((p) => p.rules.perRuleProbe),
  };

  return { extraction, retrieval, rules };
}
