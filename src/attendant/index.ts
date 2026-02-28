// Re-export new class-based API
export { AttendantInstance } from './AttendantInstance';
export { getAttendant, clearAttendant, activeAttendants } from './registry';
export type { AgentContext, WorkingMemoryBrief, WorkingMemoryEntry } from './AttendantInstance';

// Legacy functional API — kept for backward compatibility during transition
import { getAttendant } from './registry';
import type { AgentContext as NewAgentContext, WorkingMemoryBrief } from './AttendantInstance';

interface LegacyAgentContext {
    agentId: string;
    taskDescription: string;
    recentMessages: string[];
}

export async function handshake(context: LegacyAgentContext): Promise<WorkingMemoryBrief> {
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
    const attendant = getAttendant(context.agentId);
    return attendant.reconvene({
        task: context.taskDescription,
        recentMessages: context.recentMessages,
    });
}