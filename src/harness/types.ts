// Shared types for the Layer 0b measurement harness.
//
// A corpus file is one developer persona's fixed, versioned transcript plus
// its gold labels. See docs/prds/phases/layer-0b-harness.md §5 (D8) for why
// transcript and gold labels live in one file.

// One message in the ordered transcript. `entityHints` mirrors the shape
// iranti_attend expects — the first hint is the primary entity that
// deterministic + heuristic extraction writes to.
export interface CorpusMessage {
  // Free text, as the user/agent would actually type it.
  text: string;
  // Entities in scope for this message, first = primary (attend's contract).
  entityHints: Array<{ entityType: string; entityId: string }>;
}

// A gold fact the corpus author asserts SHOULD be extracted from the
// transcript by the time ingest finishes (heuristic extractor + the always-on
// deterministic artifact extractor combined — whichever produces it).
//
// Matching contract (see scorer.ts):
//   - entity + key are matched on normalizeKey-equivalent identity (the
//     scorer normalizes both sides the same way writeFact does).
//   - value is matched leniently: case-insensitive substring, either
//     direction. Real extractors paraphrase ("we decided to use X" -> stores
//     "use X"), so exact string equality would be a scorer bug, not a signal.
export interface GoldFact {
  entityType: string;
  entityId: string;
  key: string;
  // Substring (case-insensitive, whitespace-collapsed) expected to appear in
  // the stored fact's value, OR expected to contain the stored value -- see
  // scorer.ts valueMatches().
  value: string;
  // Human-readable note: why this fact exists, what message it comes from,
  // whether it's a correction/alias case. Not scored -- documentation only.
  note?: string;
}

// A probe query: after the whole transcript is ingested, this is a
// representative "what does the user need surfaced right now" query run
// through attend(). expectedKeys names which gold fact(s) (by key) should
// come back in facts[].
export interface CorpusProbe {
  // The message text passed to attend() as `message`.
  query: string;
  entityHints: Array<{ entityType: string; entityId: string }>;
  // Keys (normalizeKey-equivalent) of the gold fact(s) this probe expects to
  // find in the returned facts[]. Usually one; occasionally two-related.
  // Empty (and `negative: true`) for negative probes.
  expectedKeys: string[];
  // A negative (no-answer) probe: the question sounds plausible for this
  // persona but its correct answer is NOT in the corpus. Any fact returned
  // for it is a false positive. Measures whether retrieval knows when it
  // doesn't know — the failure mode that produced 5/5 confident wrong
  // answers in the external 0.4.1 bench's trick queries. Scored as
  // falsePositiveRate (scorer.ts), excluded from hit/confirmation rates.
  negative?: boolean;
  note?: string;
}

export interface Corpus {
  // Stable persona id -- used as part of the fresh-store project entityId
  // namespace and as the report's row label. Keep short, kebab-case.
  persona: string;
  // One-line description of the voice/style this persona represents --
  // documents the overfitting-guard intent (see PRD D2).
  description: string;
  messages: CorpusMessage[];
  goldFacts: GoldFact[];
  probes: CorpusProbe[];
}
