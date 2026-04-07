export type ProtocolEnforcementMode = 'off' | 'warn' | 'strict';

export type ProtocolOperation =
    | 'attend'
    | 'observe'
    | 'query'
    | 'history'
    | 'queryAll'
    | 'search'
    | 'related'
    | 'related_deep'
    | 'who_knows';

export type ProtocolViolationCode =
    | 'handshake_required'
    | 'attend_required'
    | 'post_response_required'
    | 'memory_use_required';

export type ProtocolViolation = {
    code: ProtocolViolationCode;
    agentId: string;
    operation: ProtocolOperation;
    message: string;
    requiredAction: string;
};

type AgentProtocolState = {
    lastHandshakeAt?: number;
    lastAttendAt?: number;
    lastAttendPhase?: 'pre-response' | 'post-response' | 'mid-turn';
    discoveryBudget: number;
    pendingPostResponse: boolean;
    pendingMemoryUseAck: boolean;
};

export class ProtocolViolationError extends Error {
    readonly protocolViolation: ProtocolViolation;

    constructor(protocolViolation: ProtocolViolation) {
        super(protocolViolation.message);
        this.name = 'ProtocolViolationError';
        this.protocolViolation = protocolViolation;
    }
}

export class AgentProtocolTracker {
    private readonly state = new Map<string, AgentProtocolState>();

    markHandshake(agentId: string): void {
        const current = this.state.get(agentId) ?? { discoveryBudget: 0, pendingPostResponse: false, pendingMemoryUseAck: false };
        this.state.set(agentId, {
            ...current,
            lastHandshakeAt: Date.now(),
            discoveryBudget: 0,
            pendingPostResponse: false,
        });
    }

    markAttend(agentId: string, phase?: 'pre-response' | 'post-response' | 'mid-turn'): void {
        const current = this.state.get(agentId) ?? { discoveryBudget: 0, pendingPostResponse: false, pendingMemoryUseAck: false };
        const lastAttendAt = Date.now();
        let discoveryBudget = current.discoveryBudget;
        let pendingPostResponse = current.pendingPostResponse;

        if (phase === 'pre-response') {
            discoveryBudget = 1;
            pendingPostResponse = true;
        } else if (phase === 'post-response') {
            discoveryBudget = 0;
            pendingPostResponse = false;
        } else if (phase === 'mid-turn') {
            discoveryBudget = 1;
        }

        this.state.set(agentId, {
            ...current,
            lastAttendAt,
            lastAttendPhase: phase,
            discoveryBudget,
            pendingPostResponse,
        });
    }

    markMemoryUseAcknowledgementRequired(agentId: string): void {
        const current = this.state.get(agentId) ?? { discoveryBudget: 0, pendingPostResponse: false, pendingMemoryUseAck: false };
        this.state.set(agentId, {
            ...current,
            discoveryBudget: 0,
            pendingMemoryUseAck: true,
        });
    }

    clearMemoryUseAcknowledgementRequired(agentId: string): void {
        const current = this.state.get(agentId);
        if (!current) return;
        this.state.set(agentId, {
            ...current,
            pendingMemoryUseAck: false,
        });
    }

    clearPendingPostResponse(agentId: string): void {
        const current = this.state.get(agentId);
        if (!current) return;
        this.state.set(agentId, {
            ...current,
            pendingPostResponse: false,
        });
    }

    notifyDiscoveryConsumed(agentId: string): void {
        const current = this.state.get(agentId);
        if (!current) return;
        this.state.set(agentId, {
            ...current,
            discoveryBudget: Math.max(0, current.discoveryBudget - 1),
        });
    }

    bootstrapState(agentId: string, state: {
        lastHandshakeAt?: number;
        lastAttendAt?: number;
        lastAttendPhase?: 'pre-response' | 'post-response' | 'mid-turn';
        discoveryBudget?: number;
        pendingPostResponse?: boolean;
    }): void {
        const current = this.state.get(agentId) ?? { discoveryBudget: 0, pendingPostResponse: false, pendingMemoryUseAck: false };
        const next: AgentProtocolState = { ...current };
        if (state.lastHandshakeAt !== undefined) next.lastHandshakeAt = state.lastHandshakeAt;
        if (state.lastAttendAt !== undefined) next.lastAttendAt = state.lastAttendAt;
        if (state.lastAttendPhase !== undefined) next.lastAttendPhase = state.lastAttendPhase;
        if (state.discoveryBudget !== undefined) next.discoveryBudget = state.discoveryBudget;
        if (state.pendingPostResponse !== undefined) next.pendingPostResponse = state.pendingPostResponse;
        this.state.set(agentId, next);
    }

    clearAgent(agentId: string): void {
        this.state.delete(agentId);
    }

    check(agentId: string, operation: ProtocolOperation, requirements: {
        handshake?: boolean;
        attend?: boolean;
        postResponse?: boolean;
    }): ProtocolViolation | null {
        const current = this.state.get(agentId);
        if (requirements.handshake && !current?.lastHandshakeAt) {
            return {
                code: 'handshake_required',
                agentId,
                operation,
                message: `Protocol violation: ${operation} is blocked for agent ${agentId} until iranti_handshake runs for the current session.`,
                requiredAction: 'Call iranti_handshake for this agent, then call iranti_attend before discovery if the operation is a read/search traversal tool.',
            };
        }

        if (requirements.postResponse && current?.pendingPostResponse) {
            return {
                code: 'post_response_required',
                agentId,
                operation,
                message: `Protocol violation: ${operation} is blocked for agent ${agentId} until the previous turn is closed with iranti_attend(phase='post-response').`,
                requiredAction: 'Call iranti_attend(phase=\'post-response\') to close the previous turn, persist any durable findings with iranti_write or iranti_checkpoint, then begin the next turn with iranti_attend(phase=\'pre-response\').',
            };
        }

        if (current?.pendingMemoryUseAck && operation !== 'attend') {
            return {
                code: 'memory_use_required',
                agentId,
                operation,
                message: `Protocol violation: ${operation} is blocked for agent ${agentId} until the host explains why previously injected memory was insufficient via iranti_write or iranti_checkpoint.`,
                requiredAction: 'Persist why the injected memory was insufficient with iranti_write or iranti_checkpoint before performing more rediscovery on this task.',
            };
        }

        if (requirements.attend) {
            const handshakeFresh = current?.lastHandshakeAt && (!current.lastAttendAt || current.lastAttendAt < current.lastHandshakeAt);
            const missingBudget = !current || current.discoveryBudget <= 0;
            if (handshakeFresh || missingBudget) {
                return {
                    code: 'attend_required',
                    agentId,
                    operation,
                    message: `Protocol violation: ${operation} is blocked for agent ${agentId} until iranti_attend is called for this turn.`,
                    requiredAction: 'Call iranti_attend(phase=\'pre-response\'), then RETRY this exact operation (' + operation + '). The attend call is a protocol gate, not a search — empty facts from attend does NOT mean the data is absent. You MUST retry the blocked operation after attend succeeds.',
                };
            }
        }

        return null;
    }
}
