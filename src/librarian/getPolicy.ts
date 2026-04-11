/**
 * Librarian policy loader — resolves the active `ConflictPolicy` at runtime.
 *
 * Merges three layers in priority order (lowest → highest):
 *  1. `DEFAULT_POLICY` — hard-coded baseline from `policy.ts`
 *  2. Stored policy entry at `system/librarian/conflict_policy` — operator
 *     overrides persisted to the knowledge store
 *  3. Learned source-reliability scores from `source-reliability.ts` — online
 *     updates from past conflict resolutions
 *
 * Falls back to `DEFAULT_POLICY` + learned scores if the stored entry is
 * missing or unparseable. Errors from `getReliabilityScores` are silenced so
 * a reliability-store failure never blocks a write path.
 */

import { DEFAULT_POLICY, ConflictPolicy } from './policy';
import { findEntry } from '../library/queries';
import { getReliabilityScores } from './source-reliability';

export async function getConflictPolicy(db?: Parameters<typeof findEntry>[1]): Promise<ConflictPolicy> {
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
