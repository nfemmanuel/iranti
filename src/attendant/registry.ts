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
