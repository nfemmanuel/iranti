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
