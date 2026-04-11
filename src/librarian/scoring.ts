/**
 * Librarian candidate scorer — computes a composite score for a knowledge
 * entry candidate to determine whether it should overwrite an existing entry.
 *
 * Score formula: `base × (0.7 + 0.3 × reliability) × expiryPenalty`
 *  - `base`          — the entry's raw confidence (0–100)
 *  - `reliability`   — source trust multiplier from `ConflictPolicy.sourceReliability`
 *                      (defaults to 0.5 for unknown sources)
 *  - `expiryPenalty` — 0.5× if `validUntil` is in the past, otherwise 1.0
 */

import { ConflictPolicy } from './policy';

export function scoreCandidate(input: {
  confidence: number;
  source: string;
  validUntil?: Date | null;
  policy: ConflictPolicy;
}): number {
  const base = input.confidence;
  const reliability = input.policy.sourceReliability[input.source] ?? 0.5;
  const expiryPenalty = input.validUntil && input.validUntil.getTime() < Date.now() ? 0.5 : 1.0;
  
  return base * (0.7 + 0.3 * reliability) * expiryPenalty;
}
