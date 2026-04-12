/**
 * Attendant singleton registry for iranti.
 *
 * Ensures at most one `AttendantInstance` is alive per `agentId` per process.
 * The registry is intentionally process-local — cross-process coordination is
 * handled by the shared-state invalidation layer
 * (`unregisterSharedStateInvalidationObserver` is called on `clearAttendant`
 * so subscriptions don't leak when an instance is evicted).
 *
 * Key exports:
 *  - `getAttendant(agentId)`   — get-or-create the singleton for an agent
 *  - `clearAttendant(agentId)` — evict and deregister (used in tests / restarts)
 *  - `activeAttendants()`      — list all agentIds with live instances
 *  - `AttendantInstance`       — re-exported for convenience
 */

import { AttendantInstance } from './AttendantInstance';
import { unregisterSharedStateInvalidationObserver } from '../lib/sharedStateInvalidation';

// ─── Singleton Registry ──────────────────────────────────────────────────────
// One AttendantInstance per agentId per process.
// Same agentId always returns the same instance.

const instances = new Map<string, AttendantInstance>();

export function getAttendant(agentId: string): AttendantInstance {
    if (!instances.has(agentId)) {
        instances.set(agentId, new AttendantInstance(agentId));
    }
    return instances.get(agentId) as AttendantInstance;
}

export function clearAttendant(agentId: string): void {
    unregisterSharedStateInvalidationObserver(agentId);
    instances.delete(agentId);
}

export function activeAttendants(): string[] {
    return Array.from(instances.keys());
}

// Re-export AttendantInstance for convenience
export { AttendantInstance } from './AttendantInstance';
