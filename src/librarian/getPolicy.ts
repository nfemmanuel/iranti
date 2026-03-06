import { DEFAULT_POLICY, ConflictPolicy } from './policy';
import { findEntry } from '../library/queries';
import { getReliabilityScores } from './source-reliability';

export async function getConflictPolicy(db?: any): Promise<ConflictPolicy> {
  const entry = await findEntry({
    entityType: 'system',
    entityId: 'librarian',
    key: 'conflict_policy',
  }, db);

  const learnedReliability = await getReliabilityScores().catch(() => ({}));
  if (!entry) {
    return {
      ...DEFAULT_POLICY,
      sourceReliability: {
        ...DEFAULT_POLICY.sourceReliability,
        ...learnedReliability,
      },
    };
  }

  try {
    const parsed = typeof entry.valueRaw === 'string' ? JSON.parse(entry.valueRaw) : entry.valueRaw;
    return {
      ...DEFAULT_POLICY,
      ...parsed,
      sourceReliability: {
        ...DEFAULT_POLICY.sourceReliability,
        ...(parsed?.sourceReliability ?? {}),
        ...learnedReliability,
      },
    };
  } catch {
    return {
      ...DEFAULT_POLICY,
      sourceReliability: {
        ...DEFAULT_POLICY.sourceReliability,
        ...learnedReliability,
      },
    };
  }
}
