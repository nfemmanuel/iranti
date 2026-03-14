export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type ArchivedReason = 'segment_closed' | 'superseded' | 'contradicted' | 'escalated' | 'expired';
export type ResolutionState = 'not_applicable' | 'pending' | 'resolved';
export type ResolutionOutcome = 'not_applicable' | 'challenger_won' | 'original_retained';
export type RelationshipDirection = 'outbound' | 'inbound';
export type ResolvedEntityMatch = 'exact' | 'alias' | 'created' | 'hint';
export type AttendDecisionMethod = 'heuristic' | 'llm' | 'forced';
export type AttendReason =
    | 'forced'
    | 'memory_not_needed'
    | 'memory_needed_no_facts'
    | 'memory_needed_but_in_context'
    | 'memory_needed_injected';
export type IngestFactAction = 'created' | 'updated' | 'escalated' | 'rejected' | 'failed';

export interface IrantiClientOptions {
    baseUrl?: string;
    apiKey: string;
    timeout?: number;
}

export interface LastHttpMetadata {
    status: number | null;
    method: string | null;
    path: string | null;
    ok: boolean | null;
}

export interface HealthResponse {
    status: string;
    version: string;
    provider: string;
}

export interface WriteParams {
    entity: string;
    key: string;
    value: JsonValue | Record<string, unknown> | unknown[];
    summary: string;
    confidence: number;
    source: string;
    agent: string;
    validFrom?: string | Date;
    requestId?: string;
}

export interface WriteResult {
    action: 'created' | 'updated' | 'escalated' | 'rejected';
    key: string;
    reason: string;
    resolvedEntity?: string;
    inputEntity?: string;
}

export interface IngestParams {
    entity: string;
    content: string;
    source: string;
    confidence: number;
    agent: string;
}

export interface IngestFactResult {
    action: IngestFactAction;
    key: string;
    reason: string;
}

export interface IngestResult {
    extractedCandidates: number;
    written: number;
    rejected: number;
    escalated: number;
    skippedMalformed: number;
    reason?: string;
    facts: IngestFactResult[];
}

export interface QueryOptions {
    asOf?: string | Date;
    includeExpired?: boolean;
    includeContested?: boolean;
}

export interface QueryResult {
    found: boolean;
    value?: unknown;
    summary?: string;
    confidence?: number;
    source?: string;
    validFrom?: string | null;
    validUntil?: string | null;
    contested?: boolean;
    fromArchive?: boolean;
    archivedReason?: ArchivedReason | null;
    resolutionState?: ResolutionState | null;
    resolutionOutcome?: ResolutionOutcome | null;
    resolvedEntity?: string;
    inputEntity?: string;
}

export interface HistoryEntry {
    value: unknown;
    summary: string;
    confidence: number;
    source: string;
    validFrom: string;
    validUntil: string | null;
    isCurrent: boolean;
    contested: boolean;
    archivedReason: ArchivedReason | null;
    resolutionState: ResolutionState | null;
    resolutionOutcome: ResolutionOutcome | null;
}

export interface QueryAllFact {
    key: string;
    value: unknown;
    summary: string;
    confidence: number;
    source: string;
}

export interface SearchParams {
    query: string;
    limit?: number;
    entityType?: string;
    entityId?: string;
    lexicalWeight?: number;
    vectorWeight?: number;
    minScore?: number;
}

export interface SearchResult {
    id: number;
    entity: string;
    key: string;
    value: unknown;
    summary: string;
    confidence: number;
    source: string;
    validUntil?: string | null;
    lexicalScore: number;
    vectorScore: number;
    score: number;
}

export interface RelateParams {
    fromEntity: string;
    relationshipType: string;
    toEntity: string;
    createdBy: string;
    properties?: Record<string, unknown>;
}

export interface RelateResult {
    success: boolean;
}

export interface RelatedResult {
    entityType: string;
    entityId: string;
    relationshipType: string;
    direction: RelationshipDirection;
    properties: Record<string, unknown>;
}

export interface WorkingMemoryEntry {
    entityKey: string;
    summary: string;
    confidence: number;
    source: string;
    lastUpdated: string;
}

export interface HandshakeParams {
    agent: string;
    task: string;
    recentMessages: string[];
}

export interface ReconveneParams {
    agentId: string;
    task: string;
    recentMessages: string[];
}

export interface WorkingMemoryBrief {
    agentId: string;
    operatingRules: string;
    inferredTaskType: string;
    workingMemory: WorkingMemoryEntry[];
    sessionStarted: string;
    briefGeneratedAt: string;
    contextCallCount: number;
}

export interface FactInjection {
    entityKey: string;
    summary: string;
    value: unknown;
    confidence: number;
    source: string;
}

export interface ObserveResolvedEntity {
    name: string;
    input: string;
    canonicalEntity: string;
    confidence: number;
    matchedBy: ResolvedEntityMatch;
}

export interface ObserveDebugDrop {
    name: string;
    reason: string;
}

export interface ObserveDebug {
    skipped?: 'empty_context';
    contextLength: number;
    detectionWindowChars: number;
    detectedCandidates: number;
    keptCandidates: number;
    hintsProvided?: number;
    hintsResolved?: number;
    dropped: ObserveDebugDrop[];
}

export interface ObserveParams {
    agentId: string;
    currentContext: string;
    maxFacts?: number;
    entityHints?: string[];
}

export interface ObserveResult {
    facts: FactInjection[];
    entitiesDetected: string[];
    alreadyPresent: number;
    totalFound: number;
    entitiesResolved?: ObserveResolvedEntity[];
    debug?: ObserveDebug;
}

export interface AttendParams extends ObserveParams {
    latestMessage?: string;
    forceInject?: boolean;
}

export interface AttendDecision {
    needed: boolean;
    confidence: number;
    method: AttendDecisionMethod;
    explanation: string;
}

export interface AttendResult extends ObserveResult {
    shouldInject: boolean;
    reason: AttendReason;
    decision: AttendDecision;
}

export interface WhoKnowsResult {
    agentId: string;
    keys: string[];
    totalContributions: number;
}

export interface RegisterAgentParams {
    agentId: string;
    name: string;
    description: string;
    capabilities: string[];
    model?: string;
    properties?: Record<string, unknown>;
}

export interface AgentProfile {
    agentId: string;
    name: string;
    description: string;
    capabilities: string[];
    model?: string;
    properties?: Record<string, unknown>;
}

export interface AgentStats {
    totalWrites: number;
    totalRejections: number;
    totalEscalations: number;
    avgConfidence: number;
    lastSeen: string;
    isActive: boolean;
}

export interface AgentRecord {
    profile: AgentProfile;
    stats: AgentStats;
}

export interface MaintenanceReport {
    expiredArchived: number;
    lowConfidenceArchived: number;
    escalationsProcessed: number;
    errors: string[];
}

export interface ResolveEntityResponse {
    canonicalEntity: string;
    canonicalType: string;
    canonicalId: string;
    addedAliases: string[];
    matchedBy: ResolvedEntityMatch;
    entityKey: string;
}

export interface AliasResponse {
    ok: boolean;
    canonicalEntity: string;
    aliasNormalized: string;
    created: boolean;
}
