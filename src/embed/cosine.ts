// Cosine similarity — CORE-16.
//
// Plain JS, O(dim) per pair. Non-goal per the PRD: no ANN index at Layer-0
// scale (tens-to-hundreds of facts per entity) — see src/embed/candidates.ts
// for the 500-cap that's the named escalation trigger.

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// D2 (PRD): a fixed, conservative floor — not tuned by feel. Below this,
// return nothing rather than noise (no-answer honesty, mirroring the
// no-keyword-match fallback in readRelevantFactsWithMatch). Validated
// against the corpus during build (see the PRD build-report changelog
// entry this ships alongside); moves only with a measured bench:semantic
// justification, never by ad hoc adjustment.
export const SIMILARITY_FLOOR = 0.6;
