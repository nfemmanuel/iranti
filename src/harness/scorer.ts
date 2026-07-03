// Scoring — Layer 0b.
//
// Turns raw ingest/probe output into the four named metrics (PRD §5 D3):
//   1. extraction recall & precision (vs gold facts)
//   2. retrieval hit-rate (+ rank)
//   3. confirmation rate (top-of-list, not just "somewhere in the list")
//   4. determinism (scored separately, in harness.test.ts, by diffing two
//      full report JSONs — not a per-persona metric, so it isn't here).

import { normalizeKey } from "../library/keys.js";
import type { Corpus, GoldFact } from "./types.js";
import type { PersonaIngestResult, ProbeFactResult } from "./ingest.js";

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
  // Stored facts that matched SOME gold fact's identity+value. Facts stored
  // that don't correspond to any gold fact are not "wrong" in a strict sense
  // (the corpus doesn't enumerate every non-gold fact that's fine to store)
  // — precision here means "of the gold-identity slots iranti filled, how
  // many had the right value", which is the precision question this corpus
  // can actually answer with its lenient-value-match gold labels.
  precision: number; // matchedCount / identityHits (0 when identityHits === 0)
}

export function scoreExtraction(
  goldFacts: GoldFact[],
  storedFacts: ProbeFactResult[],
): ExtractionScore {
  const goldCount = goldFacts.length;
  const storedCount = storedFacts.length;

  const storedByIdentity = new Map<string, ProbeFactResult[]>();
  for (const f of storedFacts) {
    const [entityType, entityId] = f.entity.split("/", 2) as [string, string];
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

  return {
    goldCount,
    storedCount,
    identityHits,
    matchedCount,
    recall: goldCount > 0 ? matchedCount / goldCount : 0,
    // Precision here is scoped to the gold-identity slots that were filled
    // at all (identityHits) — of those, how many had the correct value.
    // A slot never filled counts against recall, not precision.
    precision: identityHits > 0 ? matchedCount / identityHits : 0,
  };
}

// --------------------------------------------------------------------------
// Retrieval hit-rate + confirmation rate
// --------------------------------------------------------------------------

export interface ProbeScore {
  query: string;
  expectedKeys: string[];
  // 1-based rank of the first matching expected fact in returnedFacts, or
  // null if none of the expected keys appear anywhere in the returned list.
  rank: number | null;
  hit: boolean; // rank !== null
  confirmed: boolean; // rank === 1
}

export interface RetrievalScore {
  probeCount: number;
  hitCount: number;
  confirmedCount: number;
  hitRate: number; // hitCount / probeCount
  confirmationRate: number; // confirmedCount / probeCount
  perProbe: ProbeScore[];
}

export function scoreRetrieval(result: PersonaIngestResult): RetrievalScore {
  const perProbe: ProbeScore[] = result.probeOutcomes.map((outcome) => {
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
      rank,
      hit: rank !== null,
      confirmed: rank === 1,
    };
  });

  const probeCount = perProbe.length;
  const hitCount = perProbe.filter((p) => p.hit).length;
  const confirmedCount = perProbe.filter((p) => p.confirmed).length;

  return {
    probeCount,
    hitCount,
    confirmedCount,
    hitRate: probeCount > 0 ? hitCount / probeCount : 0,
    confirmationRate: probeCount > 0 ? confirmedCount / probeCount : 0,
    perProbe,
  };
}

// --------------------------------------------------------------------------
// Per-persona + overall report shape
// --------------------------------------------------------------------------

export interface PersonaReport {
  persona: string;
  extraction: ExtractionScore;
  retrieval: RetrievalScore;
}

export interface OverallReport {
  // Micro-average across all personas (weights every gold fact / probe
  // equally, not every persona equally) — the fairest single number given
  // personas have different corpus sizes.
  extraction: ExtractionScore;
  retrieval: RetrievalScore;
}

export interface BenchReport {
  personas: PersonaReport[];
  overall: OverallReport;
}

export function scorePersona(corpus: Corpus, result: PersonaIngestResult): PersonaReport {
  return {
    persona: corpus.persona,
    extraction: scoreExtraction(corpus.goldFacts, result.allFactsAfterIngest),
    retrieval: scoreRetrieval(result),
  };
}

export function buildOverallReport(personas: PersonaReport[]): OverallReport {
  const goldCount = personas.reduce((s, p) => s + p.extraction.goldCount, 0);
  const storedCount = personas.reduce((s, p) => s + p.extraction.storedCount, 0);
  const identityHits = personas.reduce((s, p) => s + p.extraction.identityHits, 0);
  const matchedCount = personas.reduce((s, p) => s + p.extraction.matchedCount, 0);

  const extraction: ExtractionScore = {
    goldCount,
    storedCount,
    identityHits,
    matchedCount,
    recall: goldCount > 0 ? matchedCount / goldCount : 0,
    // Micro-averaged exactly (matched / identity-hits summed across all
    // personas first, then divided once) — equivalent to weighting each
    // persona's precision by its identityHits, without the reconstruction
    // ambiguity that would come from trying to recover identityHits from a
    // precision ratio alone (precision === 0 is ambiguous between
    // identityHits === 0 and identityHits > 0 with zero value-matches).
    precision: identityHits > 0 ? matchedCount / identityHits : 0,
  };

  const probeCount = personas.reduce((s, p) => s + p.retrieval.probeCount, 0);
  const hitCount = personas.reduce((s, p) => s + p.retrieval.hitCount, 0);
  const confirmedCount = personas.reduce((s, p) => s + p.retrieval.confirmedCount, 0);

  const retrieval: RetrievalScore = {
    probeCount,
    hitCount,
    confirmedCount,
    hitRate: probeCount > 0 ? hitCount / probeCount : 0,
    confirmationRate: probeCount > 0 ? confirmedCount / probeCount : 0,
    perProbe: personas.flatMap((p) => p.retrieval.perProbe),
  };

  return { extraction, retrieval };
}
