import { DEFAULT_POLICY, ConflictPolicy } from './policy';
import { findEntry } from '../library/queries';

export async function getConflictPolicy(db?: any): Promise<ConflictPolicy> {
  const entry = await findEntry({
    entityType: 'system',
    entityId: 'librarian',
    key: 'conflict_policy',
  }, db);

  if (!entry) return DEFAULT_POLICY;

  try {
    const parsed = typeof entry.valueRaw === 'string' ? JSON.parse(entry.valueRaw) : entry.valueRaw;
    return { ...DEFAULT_POLICY, ...parsed };
  } catch {
    return DEFAULT_POLICY;
  }
}
