// ─── Entity Types ────────────────────────────────────────────────────────────

export type EntityType =
    | 'system'
    | 'agent'
    | 'researcher'
    | 'market'
    | 'technology'
    | string;

// ─── Knowledge Entry ─────────────────────────────────────────────────────────

export interface EntryInput {
    entityType: EntityType;
    entityId: string;
    key: string;
    valueRaw: unknown;
    valueSummary: string;
    confidence: number;
    source: string;
    validUntil?: Date;
    createdBy: string;
    isProtected?: boolean;
    conflictLog?: ConflictLogEntry[];
}

export interface ConflictLogEntry {
    detectedAt: string;
    incomingSource: string;
    incomingConfidence: number;
    existingConfidence: number;
    resolution: 'overwritten' | 'kept' | 'escalated' | 'human_resolved';
    resolvedBy?: string;
    notes?: string;
}

// ─── Escalation ──────────────────────────────────────────────────────────────

export type EscalationStatus = 'PENDING' | 'RESOLVED';

export interface EscalationFile {
    id: string;
    status: EscalationStatus;
    librarianAssessment: {
        conflict: string;
        existingConfidence: number;
        incomingConfidence: number;
        reasoning: string;
    };
    humanResolution?: string;
    createdAt: string;
    resolvedAt?: string;
}

// ─── Query ───────────────────────────────────────────────────────────────────

export interface EntryQuery {
    entityType: EntityType;
    entityId: string;
    key: string;
}

export interface QueryResult {
    found: boolean;
    entry?: {
        valueRaw: unknown;
        valueSummary: string;
        confidence: number;
        source: string;
        validUntil?: Date | null;
    };
}