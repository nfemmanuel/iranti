/**
 * Attendant public API barrel for iranti.
 *
 * Exports two layers:
 *
 * **Class-based API (current)** — the preferred surface since the refactor:
 *  - `AttendantInstance`    — the stateful per-agent class
 *  - `getAttendant()`       — registry factory (singleton per agentId)
 *  - `clearAttendant()`     — evict a singleton (tests / restarts)
 *  - `activeAttendants()`   — list live agentIds
 *  - All type exports from AttendantInstance
 *
 * **Legacy functional API (backward-compat)** — thin wrappers around the
 * class-based API that accept the old `LegacyAgentContext` shape. Kept to
 * avoid breaking callers that haven't migrated yet; emits `initDb` internally
 * so callers don't need to manage the DB connection.
 *  - `handshake(context)`          → WorkingMemoryBrief
 *  - `reconvene(brief, context)`   → WorkingMemoryBrief
 */

// Re-export new class-based API
export { AttendantInstance } from './AttendantInstance';
export { getAttendant, clearAttendant, activeAttendants } from './registry';
export { readPersistedSessionState, summarizeSessionState } from './AttendantInstance';
export type {
    AgentContext,
    WorkingMemoryBrief,
    WorkingMemoryEntry,
    PersistedSessionState,
    SessionInspection,
    SessionSummary,
    SessionComplianceState,
    SessionCheckpointSummary,
    SessionOperatorState,
    ObserveInput,
    ObserveResult,
    BackfillSuggestion,
    AttendInput,
    AttendResult,
    AttendDecision,
    AttendBootstrapInfo,
    MemoryAttributionResult,
    MemoryAttributionEvidenceKind,
} from './AttendantInstance';

// Legacy functional API — kept for backward compatibility during transition
import { getAttendant } from './registry';
import { initDb } from '../library/client';
import type { AgentContext as NewAgentContext, WorkingMemoryBrief } from './AttendantInstance';

interface LegacyAgentContext {
    agentId: string;
    taskDescription: string;
    recentMessages: string[];
}

function ensureDbInitialized(): void {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL is required for legacy attendant API.');
    }
    initDb(connectionString, { applicationName: 'iranti:attendant:legacy_api' });
}

export async function handshake(context: LegacyAgentContext): Promise<WorkingMemoryBrief> {
    ensureDbInitialized();
    const attendant = getAttendant(context.agentId);
    return attendant.handshake({
        task: context.taskDescription,
        recentMessages: context.recentMessages,
    });
}

export async function reconvene(
    previousBrief: WorkingMemoryBrief,
    context: LegacyAgentContext
): Promise<WorkingMemoryBrief> {
    ensureDbInitialized();
    const attendant = getAttendant(context.agentId);
    return attendant.reconvene({
        task: context.taskDescription,
        recentMessages: context.recentMessages,
    });
}
