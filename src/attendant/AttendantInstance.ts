import { route } from '../lib/router';
import { getStaffEventEmitter } from '../lib/staffEventRegistry';
import { queryEntry, findEntriesByEntity, recordKnowledgeEntryAccess } from '../library/queries';
import { getRelatedDeep } from '../library/relationships';
import { parseEntityString, resolveEntity } from '../library/entity-resolution';
import { getDb } from '../library/client';
import { Prisma } from '../generated/prisma/client';
import { EntryQuery, QueryResult } from '../types';
import { timeStart, timeEnd } from '../lib/metrics';
import { getConflictPolicy } from '../librarian/getPolicy';
import { classifyMemoryScope, getPersonalMemoryEntity, getProjectMemoryEntity } from '../lib/autoRemember';

// ─── Constants ───────────────────────────────────────────────────────────────

const ATTENDANT_RULES_QUERY: EntryQuery = {
    entityType: 'system',
    entityId: 'attendant',
    key: 'operating_rules',
};
const CONTEXT_RECOVERY_THRESHOLD = 20;  // LLM calls before context recovery
const SESSION_INTERRUPTION_TTL_MS = 5 * 60 * 1000;
const ENTITY_DETECTION_WINDOW_CHARS = 1500;
const MIN_ENTITY_CONFIDENCE = 0.75;
const MEMORY_DECISION_CONTEXT_WINDOW_CHARS = 2000;

const MEMORY_NEED_POSITIVE_PATTERNS: RegExp[] = [
    /\bwhat(?:'s| is| was)?\s+my\b/i,
    /\bdo you remember\b/i,
    /\bremind me\b/i,
    /\bmy\s+(?:favorite|favourite|name|email|phone|address|city|country|movie|snack|color|colour)\b/i,
    /\bwe decided\b/i,
    /\bearlier\b/i,
    /\bprevious(?:ly)?\b/i,
    /\bagain\b/i,
];

const MEMORY_NEED_NEGATIVE_PATTERNS: RegExp[] = [
    /^\s*(hi|hello|hey|yo|sup|good (?:morning|afternoon|evening))\b[!.?\s]*$/i,
    /^\s*(thanks|thank you|cool|great|nice)\b[!.?\s]*$/i,
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentContext {
    task: string;
    recentMessages: string[];
}

export interface WorkingMemoryEntry {
    entityKey: string;       // format: entityType/entityId/key
    summary: string;
    confidence: number;
    source: string;
    lastUpdated: string;
}

export interface WorkingMemoryBrief {
    agentId: string;
    operatingRules: string;
    inferredTaskType: string;
    workingMemory: WorkingMemoryEntry[];
    sessionStarted: string;
    briefGeneratedAt: string;
    contextCallCount: number;
    sessionCheckpoint?: SessionCheckpointRecord | null;
    sessionRecovery?: SessionRecoveryInfo | null;
}

export type SessionStatus = 'active' | 'interrupted' | 'completed' | 'abandoned';

export interface SessionCheckpointPayload {
    currentStep?: string;
    nextStep?: string;
    openRisks?: string[];
    recentOutputs?: string[];
    entityTargets?: string[];
    notes?: string;
}

export interface SessionCheckpointRecord {
    sessionId: string;
    task: string;
    taskFingerprint: string;
    status: SessionStatus;
    startedAt: string;
    lastHeartbeatAt: string;
    updatedAt: string;
    checkpoint: SessionCheckpointPayload;
    interruptedAt?: string;
    completedAt?: string;
    abandonedAt?: string;
    resumedAt?: string;
}

export interface SessionRecoveryInfo {
    available: boolean;
    sessionId: string;
    task: string;
    taskFingerprint: string;
    matchedCurrentTask: boolean;
    matchConfidence: number;
    recommendation: 'resume' | 'review' | 'ignore';
    summary: string;
    lastHeartbeatAt: string;
    interruptedAt: string;
    checkpoint: SessionCheckpointPayload | null;
}

export interface PersistedSessionState {
    agentId: string;
    sessionStarted: string;
    briefGeneratedAt: string;
    sessionCheckpoint: SessionCheckpointRecord | null;
    sessionRecovery: SessionRecoveryInfo | null;
}

export interface SessionInspection {
    agentId: string;
    hasCheckpoint: boolean;
    sessionCheckpoint: SessionCheckpointRecord | null;
    sessionRecovery: SessionRecoveryInfo | null;
    persistedBriefGeneratedAt?: string;
    summary: SessionSummary;
}

export type SessionOperatorState = 'none' | SessionStatus;

export interface SessionCheckpointSummary {
    currentStep: string | null;
    nextStep: string | null;
    openRiskCount: number;
    entityTargetCount: number;
}

export interface SessionSummary {
    agentId: string;
    hasCheckpoint: boolean;
    sessionId: string | null;
    task: string | null;
    status: SessionStatus | null;
    operatorState: SessionOperatorState;
    startedAt: string | null;
    lastHeartbeatAt: string | null;
    updatedAt: string | null;
    interruptedAt: string | null;
    completedAt: string | null;
    abandonedAt: string | null;
    resumedAt: string | null;
    isStale: boolean;
    persistedBriefGeneratedAt?: string;
    checkpointSummary: SessionCheckpointSummary | null;
}

// ─── Observe Types ────────────────────────────────────────────────────────────

export interface ObserveInput {
    currentContext: string;
    maxFacts?: number;          // default 5 — don't overwhelm context
    entityHints?: string[];     // deterministic canonical entities from caller
}

export interface FactInjection {
    entityKey: string;          // entityType/entityId/key
    summary: string;
    value: unknown;
    confidence: number;
    source: string;
}

type RetrievedFact = FactInjection & { entryId: number };

export interface ObserveResult {
    facts: FactInjection[];           // inject these into context
    entitiesDetected: string[];       // entities found in context
    alreadyPresent: number;           // facts skipped (already in context)
    totalFound: number;               // total facts found before filtering
    entitiesResolved?: Array<{
        name: string;
        input: string;
        canonicalEntity: string;
        confidence: number;
        matchedBy: 'exact' | 'alias' | 'created' | 'hint';
    }>;
    debug?: {
        skipped?: 'empty_context';
        contextLength: number;
        detectionWindowChars: number;
        detectedCandidates: number;
        keptCandidates: number;
        hintsProvided?: number;
        hintsResolved?: number;
        dropped: Array<{ name: string; reason: string }>;
    };
}

export interface AttendInput extends ObserveInput {
    latestMessage?: string;
    forceInject?: boolean;
}

export interface SessionCheckpointInput extends AgentContext {
    sessionId?: string;
    heartbeatAt?: string;
    checkpoint: SessionCheckpointPayload | string | Record<string, unknown>;
}

export interface SessionActionInput {
    sessionId?: string;
}

export interface AttendDecision {
    needed: boolean;
    confidence: number;
    method: 'heuristic' | 'llm' | 'forced';
    explanation: string;
}

export interface AttendResult extends ObserveResult {
    shouldInject: boolean;
    reason:
        | 'forced'
        | 'memory_not_needed'
        | 'memory_needed_no_facts'
        | 'memory_needed_but_in_context'
        | 'memory_needed_injected';
    decision: AttendDecision;
}

async function readPersistedBriefForAgent(agentId: string): Promise<WorkingMemoryBrief | null> {
    const entry = await getDb().knowledgeEntry.findUnique({
        where: {
            entityType_entityId_key: {
                entityType: 'agent',
                entityId: agentId,
                key: 'attendant_state',
            },
        },
    });

    if (!entry) return null;
    return entry.valueRaw as unknown as WorkingMemoryBrief;
}

export async function readPersistedSessionState(agentId: string): Promise<PersistedSessionState | null> {
    const state = await readPersistedBriefForAgent(agentId);
    if (!state) return null;

    return {
        agentId,
        sessionStarted: state.sessionStarted,
        briefGeneratedAt: state.briefGeneratedAt,
        sessionCheckpoint: state.sessionCheckpoint ?? null,
        sessionRecovery: state.sessionRecovery ?? null,
    };
}

function buildCheckpointSummary(checkpoint: SessionCheckpointRecord | null): SessionCheckpointSummary | null {
    if (!checkpoint) return null;
    return {
        currentStep: checkpoint.checkpoint.currentStep ?? null,
        nextStep: checkpoint.checkpoint.nextStep ?? null,
        openRiskCount: Array.isArray(checkpoint.checkpoint.openRisks) ? checkpoint.checkpoint.openRisks.length : 0,
        entityTargetCount: Array.isArray(checkpoint.checkpoint.entityTargets) ? checkpoint.checkpoint.entityTargets.length : 0,
    };
}

export function summarizeSessionState(
    agentId: string,
    checkpoint: SessionCheckpointRecord | null,
    persistedBriefGeneratedAt?: string,
): SessionSummary {
    const hasCheckpoint = Boolean(checkpoint);
    const lastHeartbeatAt = checkpoint?.lastHeartbeatAt ?? null;
    const isStale = Boolean(
        checkpoint
        && checkpoint.status === 'active'
        && Date.now() - new Date(checkpoint.lastHeartbeatAt).getTime() >= SESSION_INTERRUPTION_TTL_MS
    );
    const operatorState: SessionOperatorState = !checkpoint
        ? 'none'
        : checkpoint.status === 'active' && isStale
            ? 'interrupted'
            : checkpoint.status;

    return {
        agentId,
        hasCheckpoint,
        sessionId: checkpoint?.sessionId ?? null,
        task: checkpoint?.task ?? null,
        status: checkpoint?.status ?? null,
        operatorState,
        startedAt: checkpoint?.startedAt ?? null,
        lastHeartbeatAt,
        updatedAt: checkpoint?.updatedAt ?? null,
        interruptedAt: checkpoint?.interruptedAt ?? null,
        completedAt: checkpoint?.completedAt ?? null,
        abandonedAt: checkpoint?.abandonedAt ?? null,
        resumedAt: checkpoint?.resumedAt ?? null,
        isStale,
        persistedBriefGeneratedAt,
        checkpointSummary: buildCheckpointSummary(checkpoint),
    };
}

type EntityCandidate = {
    type: string;
    name: string;
    id_guess: string;
    confidence: number;
    evidence: string;
    start?: number;
    end?: number;
};

type MemoryDecisionHeuristic = {
    needed: boolean | null;
    confidence: number;
    explanation: string;
};

function heuristicEntityId(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function extractFallbackCandidates(text: string): EntityCandidate[] {
    const candidates: EntityCandidate[] = [];
    const seen = new Set<string>();

    // Explicit typed entities, e.g. project/atlas_2026
    const typedRegex = /\b([a-z][a-z0-9_]*)\/([A-Za-z0-9][A-Za-z0-9_\-]{1,80})\b/g;
    for (const match of text.matchAll(typedRegex)) {
        const type = match[1];
        const idGuess = heuristicEntityId(match[2]);
        if (!idGuess) continue;
        const evidence = match[0];
        const key = `${type}/${idGuess}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
            type,
            name: idGuess.replace(/_/g, ' '),
            id_guess: idGuess,
            confidence: 0.8,
            evidence,
            start: typeof match.index === 'number' ? match.index : undefined,
            end: typeof match.index === 'number' ? match.index + evidence.length : undefined,
        });
    }

    // Named project mentions, e.g. "Project Atlas 2026"
    const projectRegex = /\bProject\s+([A-Z0-9][A-Za-z0-9_\-]*(?:\s+[A-Z0-9][A-Za-z0-9_\-]*){0,4})\b/g;
    for (const match of text.matchAll(projectRegex)) {
        const name = `Project ${match[1]}`.trim();
        const normalized = heuristicEntityId(match[1]);
        const idGuess = normalized ? `project_${normalized}` : '';
        if (!idGuess) continue;
        const key = `project/${idGuess}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
            type: 'project',
            name,
            id_guess: idGuess,
            confidence: 0.78,
            evidence: name,
            start: typeof match.index === 'number' ? match.index : undefined,
            end: typeof match.index === 'number' ? match.index + name.length : undefined,
        });
    }

    // Capitalized multi-word names fallback, e.g. "Atlas Initiative"
    const titleCaseRegex = /\b([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){1,3})\b/g;
    for (const match of text.matchAll(titleCaseRegex)) {
        const name = match[1].trim();
        const normalized = heuristicEntityId(name);
        if (!normalized) continue;
        const idGuess = `project_${normalized}`;
        const key = `project/${idGuess}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
            type: 'project',
            name,
            id_guess: idGuess,
            confidence: 0.75,
            evidence: name,
            start: typeof match.index === 'number' ? match.index : undefined,
            end: typeof match.index === 'number' ? match.index + name.length : undefined,
        });
    }

    // Bare technical slug identifiers, e.g. lunar_api_v3
    const slugRegex = /\b([a-z][a-z0-9]+(?:_[a-z0-9]+)+)\b/g;
    for (const match of text.matchAll(slugRegex)) {
        const slug = match[1];
        if (!slug || slug.includes('/')) continue;
        const idGuess = heuristicEntityId(slug);
        if (!idGuess) continue;
        const key = `project/${idGuess}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
            type: 'project',
            name: slug.replace(/_/g, ' '),
            id_guess: idGuess,
            confidence: 0.82,
            evidence: slug,
            start: typeof match.index === 'number' ? match.index : undefined,
            end: typeof match.index === 'number' ? match.index + slug.length : undefined,
        });
    }

    return candidates;
}

function normalizeMessage(message: string | undefined): string {
    return (message ?? '').trim();
}

function normalizeText(text: string | undefined): string {
    return (text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text: string | undefined): string[] {
    return normalizeText(text)
        .split(' ')
        .map((part) => part.trim())
        .filter((part) => part.length > 2);
}

function fingerprintTask(task: string, recentMessages: string[] = []): string {
    const messageSeed = recentMessages
        .slice(-3)
        .map((message) => normalizeText(message))
        .filter((message) => message.length > 0)
        .join(' ');

    return normalizeText([task, messageSeed].filter(Boolean).join(' | '));
}

function similarityScore(left: string, right: string): number {
    const normalizedLeft = normalizeText(left);
    const normalizedRight = normalizeText(right);

    if (!normalizedLeft || !normalizedRight) return 0;
    if (normalizedLeft === normalizedRight) return 1;
    if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
        return 0.92;
    }

    const leftTokens = new Set(tokenize(normalizedLeft));
    const rightTokens = new Set(tokenize(normalizedRight));
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

    let overlap = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token)) overlap++;
    }

    return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeStringArray(value: unknown, maxItems: number = 5, maxLength: number = 160): string[] {
    if (!Array.isArray(value)) return [];

    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const normalized = truncate(item.trim(), maxLength);
        if (!normalized) continue;
        out.push(normalized);
        if (out.length >= maxItems) break;
    }

    return out;
}

function normalizeCheckpointPayload(
    payload: SessionCheckpointInput['checkpoint']
): SessionCheckpointPayload {
    if (typeof payload === 'string') {
        return {
            notes: truncate(payload.trim(), 500),
        };
    }

    if (!payload || typeof payload !== 'object') {
        return {};
    }

    const raw = payload as Record<string, unknown>;
    const normalized: SessionCheckpointPayload = {};

    if (typeof raw.currentStep === 'string') {
        normalized.currentStep = truncate(raw.currentStep.trim(), 180);
    }
    if (typeof raw.nextStep === 'string') {
        normalized.nextStep = truncate(raw.nextStep.trim(), 180);
    }

    const openRisks = normalizeStringArray(raw.openRisks, 5, 180);
    if (openRisks.length > 0) {
        normalized.openRisks = openRisks;
    }

    const recentOutputs = normalizeStringArray(raw.recentOutputs, 5, 220);
    if (recentOutputs.length > 0) {
        normalized.recentOutputs = recentOutputs;
    }

    const entityTargets = normalizeStringArray(raw.entityTargets, 5, 180);
    if (entityTargets.length > 0) {
        normalized.entityTargets = entityTargets;
    }

    if (typeof raw.notes === 'string') {
        normalized.notes = truncate(raw.notes.trim(), 500);
    }

    return normalized;
}

function createSessionId(agentId: string, taskFingerprint: string): string {
    const seed = `${agentId}:${taskFingerprint}:${Date.now()}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    return `session_${hash.toString(36)}`;
}

function createRecoverySummary(record: SessionCheckpointRecord, matchedCurrentTask: boolean): string {
    const checkpoint = record.checkpoint;
    const stepSummary = checkpoint.currentStep ? `Last completed step: ${checkpoint.currentStep}.` : 'No completed step was stored.';
    const nextStepSummary = checkpoint.nextStep ? `Recommended next step: ${checkpoint.nextStep}.` : 'No next step was stored.';
    const matchSummary = matchedCurrentTask
        ? 'The returning task matches the interrupted session.'
        : 'The returning task does not strongly match the interrupted session.';

    return [matchSummary, stepSummary, nextStepSummary].join(' ');
}

function evaluateSessionRecovery(
    record: SessionCheckpointRecord,
    context: AgentContext
): { recovery: SessionRecoveryInfo | null; interrupted: boolean } {
    const heartbeatAt = new Date(record.lastHeartbeatAt);
    const stale = Number.isNaN(heartbeatAt.getTime())
        ? true
        : Date.now() - heartbeatAt.getTime() > SESSION_INTERRUPTION_TTL_MS;
    const interrupted = record.status === 'interrupted' || stale;

    if (!interrupted) {
        return { recovery: null, interrupted: false };
    }

    const currentFingerprint = fingerprintTask(context.task, context.recentMessages);
    const matchConfidence = similarityScore(currentFingerprint, record.taskFingerprint);
    const matchedCurrentTask = matchConfidence >= 0.45;
    const recommendation = matchedCurrentTask ? 'resume' : 'review';

    return {
        interrupted: true,
        recovery: {
            available: true,
            sessionId: record.sessionId,
            task: record.task,
            taskFingerprint: record.taskFingerprint,
            matchedCurrentTask,
            matchConfidence,
            recommendation,
            summary: createRecoverySummary(record, matchedCurrentTask),
            lastHeartbeatAt: record.lastHeartbeatAt,
            interruptedAt: record.interruptedAt ?? record.lastHeartbeatAt,
            checkpoint: record.checkpoint ?? null,
        },
    };
}

function heuristicMemoryNeed(message: string): MemoryDecisionHeuristic {
    const normalized = normalizeMessage(message);
    if (!normalized) {
        return {
            needed: null,
            confidence: 0.5,
            explanation: 'no_latest_message',
        };
    }

    if (MEMORY_NEED_NEGATIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
        return {
            needed: false,
            confidence: 0.95,
            explanation: 'simple_greeting_or_ack',
        };
    }

    if (MEMORY_NEED_POSITIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
        return {
            needed: true,
            confidence: 0.92,
            explanation: 'memory_reference_detected',
        };
    }

    return {
        needed: null,
        confidence: 0.55,
        explanation: 'ambiguous',
    };
}

// ─── AttendantInstance ───────────────────────────────────────────────────────

export class AttendantInstance {
    private agentId: string;
    private brief: WorkingMemoryBrief | null = null;
    private contextCallCount: number = 0;
    private sessionStarted: string = new Date().toISOString();
    private sessionCheckpoint: SessionCheckpointRecord | null = null;

    constructor(agentId: string) {
        this.agentId = agentId;
    }

    // ── Handshake ────────────────────────────────────────────────────────────

    async handshake(context: AgentContext): Promise<WorkingMemoryBrief> {
        const t0 = timeStart();
        // Try to resume from persisted state first
        const persisted = await this.loadPersistedState();

        // Load operating rules from Staff Namespace
        const operatingRules = await this.loadOperatingRules();

        // Infer task type
        const inferredTaskType = await this.inferTask(context);

        // Load knowledge — agent entries + related entities
        const workingMemory = await this.buildWorkingMemory(inferredTaskType);
        const recoveryResult = persisted?.sessionCheckpoint
            ? this.buildRecovery(context, persisted.sessionCheckpoint)
            : { interrupted: false, recovery: null as SessionRecoveryInfo | null };

        if (recoveryResult.interrupted && recoveryResult.recovery) {
            this.sessionCheckpoint = {
                ...persisted!.sessionCheckpoint!,
                status: 'interrupted',
                interruptedAt: recoveryResult.recovery.interruptedAt,
                updatedAt: new Date().toISOString(),
            };
        } else {
            this.sessionCheckpoint = persisted?.sessionCheckpoint ?? null;
        }

        this.brief = {
            agentId: this.agentId,
            operatingRules,
            inferredTaskType,
            workingMemory,
            sessionStarted: persisted?.sessionStarted ?? this.sessionStarted,
            briefGeneratedAt: new Date().toISOString(),
            contextCallCount: this.contextCallCount,
            sessionCheckpoint: this.sessionCheckpoint,
            sessionRecovery: recoveryResult.recovery,
        };

        await this.persistState();
        getStaffEventEmitter().emit({
            staffComponent: 'Attendant',
            actionType: 'handshake_completed',
            agentId: this.agentId,
            source: 'internal', // Source not threaded to AttendantInstance in this PR; follow-up required
            reason: null,
            level: 'debug',
            metadata: {
                briefSize: this.brief?.workingMemory.length ?? 0,
                taskSummary: context.task.slice(0, 120),
                sessionId: this.sessionStarted,
            },
        });
        timeEnd('attendant.handshake_ms', t0);
        return this.brief;
    }

    // ── Reconvene ────────────────────────────────────────────────────────────

    async reconvene(context: AgentContext): Promise<WorkingMemoryBrief> {
        const t0 = timeStart();
        if (!this.brief) {
            const result = await this.handshake(context);
            timeEnd('attendant.reconvene_ms', t0);
            return result;
        }

        const newTaskType = await this.inferTask(context);

        // Task hasn't shifted — update timestamp only
        if (newTaskType.toLowerCase() === this.brief.inferredTaskType.toLowerCase()) {
            if (this.sessionCheckpoint && this.sessionCheckpoint.status === 'active') {
                const now = new Date().toISOString();
                this.sessionCheckpoint = {
                    ...this.sessionCheckpoint,
                    lastHeartbeatAt: now,
                    updatedAt: now,
                };
            }
            this.brief = {
                ...this.brief,
                briefGeneratedAt: new Date().toISOString(),
                contextCallCount: this.contextCallCount,
                sessionCheckpoint: this.sessionCheckpoint,
                sessionRecovery: null,
            };
            await this.persistState();
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'reconvene_completed',
                agentId: this.agentId,
                source: 'internal',
                reason: 'Task unchanged — brief timestamp refreshed.',
                level: 'audit',
                metadata: {
                    briefSize: this.brief?.workingMemory.length ?? 0,
                    sessionId: this.sessionStarted,
                    contextCallCount: this.contextCallCount,
                },
            });
            timeEnd('attendant.reconvene_ms', t0);
            return this.brief;
        }

        // Task has shifted — rebuild working memory
        const workingMemory = await this.buildWorkingMemory(newTaskType);
        this.brief = {
            ...this.brief,
            inferredTaskType: newTaskType,
            workingMemory,
            briefGeneratedAt: new Date().toISOString(),
            contextCallCount: this.contextCallCount,
            sessionCheckpoint: this.sessionCheckpoint,
            sessionRecovery: null,
        };

        await this.persistState();
        getStaffEventEmitter().emit({
            staffComponent: 'Attendant',
            actionType: 'reconvene_completed',
            agentId: this.agentId,
            source: 'internal',
            reason: 'Task shifted — working memory rebuilt.',
            level: 'audit',
            metadata: {
                briefSize: this.brief?.workingMemory.length ?? 0,
                sessionId: this.sessionStarted,
                contextCallCount: this.contextCallCount,
            },
        });
        timeEnd('attendant.reconvene_ms', t0);
        return this.brief;
    }

    // ── Context Update (fast, in-memory) ─────────────────────────────────────

    updateWorkingMemory(entry: WorkingMemoryEntry): void {
        if (!this.brief) return;

        const existing = this.brief.workingMemory.findIndex(
            (e) => e.entityKey === entry.entityKey
        );

        if (existing >= 0) {
            // Keep higher confidence entry
            if (entry.confidence >= this.brief.workingMemory[existing].confidence) {
                this.brief.workingMemory[existing] = entry;
            }
        } else {
            this.brief.workingMemory.push(entry);
        }
    }

    // ── Context Recovery ─────────────────────────────────────────────────────

    async onContextLow(): Promise<void> {
        const rulesResult: QueryResult = await queryEntry(ATTENDANT_RULES_QUERY);
        const operatingRules = rulesResult.found && rulesResult.entry
            ? rulesResult.entry.valueSummary
            : 'No operating rules found.';

        if (this.brief) {
            this.brief.operatingRules = operatingRules;
            this.brief.contextCallCount = 0;
        }

        this.contextCallCount = 0;
        await this.persistState();

        getStaffEventEmitter().emit({
            staffComponent: 'Attendant',
            actionType: 'session_expired',
            agentId: this.agentId,
            source: 'internal',
            reason: 'Context window threshold reached. Session archived.',
            level: 'audit',
            metadata: {
                sessionId: this.sessionStarted,
                contextCallCount: 0,
                expiryReason: 'context_low',
            },
        });
    }

    // ── Getters ──────────────────────────────────────────────────────────────

    getBrief(): WorkingMemoryBrief | null {
        return this.brief;
    }

    async checkpoint(input: SessionCheckpointInput): Promise<WorkingMemoryBrief> {
        const now = new Date().toISOString();
        if (!this.brief) {
            await this.handshake({
                task: input.task,
                recentMessages: input.recentMessages,
            });
        }

        const normalizedCheckpoint = normalizeCheckpointPayload(input.checkpoint);
        const taskFingerprint = fingerprintTask(input.task, input.recentMessages);
        const existing = this.sessionCheckpoint;
        const sessionId = input.sessionId?.trim() || existing?.sessionId || createSessionId(this.agentId, taskFingerprint);
        const startedAt = existing?.sessionId === sessionId ? existing.startedAt : now;

        this.sessionCheckpoint = {
            sessionId,
            task: input.task,
            taskFingerprint,
            status: 'active',
            startedAt,
            lastHeartbeatAt: input.heartbeatAt ?? now,
            updatedAt: now,
            checkpoint: normalizedCheckpoint,
        };

        if (!this.brief) {
            throw new Error('Unable to initialize attendant brief for checkpoint persistence.');
        }

        this.brief = {
            ...this.brief,
            sessionCheckpoint: this.sessionCheckpoint,
            sessionRecovery: null,
            briefGeneratedAt: now,
        };

        await this.persistState();
        return this.brief;
    }

    async resumeSession(input: SessionActionInput = {}): Promise<WorkingMemoryBrief> {
        await this.ensureSessionLoaded();
        if (!this.brief || !this.sessionCheckpoint) {
            return this.brief ?? (await this.handshake({ task: 'resume session', recentMessages: [] }));
        }

        if (input.sessionId && input.sessionId.trim() !== this.sessionCheckpoint.sessionId) {
            throw new Error(`Session "${input.sessionId}" does not match the active checkpoint.`);
        }

        const now = new Date().toISOString();
        this.sessionCheckpoint = {
            ...this.sessionCheckpoint,
            status: 'active',
            resumedAt: now,
            lastHeartbeatAt: now,
            updatedAt: now,
        };

        this.brief = {
            ...this.brief,
            sessionCheckpoint: this.sessionCheckpoint,
            sessionRecovery: null,
            briefGeneratedAt: now,
        };

        await this.persistState();
        return this.brief;
    }

    async completeSession(input: SessionActionInput = {}): Promise<WorkingMemoryBrief> {
        await this.ensureSessionLoaded();
        if (!this.brief || !this.sessionCheckpoint) {
            return this.brief ?? (await this.handshake({ task: 'complete session', recentMessages: [] }));
        }

        if (input.sessionId && input.sessionId.trim() !== this.sessionCheckpoint.sessionId) {
            throw new Error(`Session "${input.sessionId}" does not match the active checkpoint.`);
        }

        const now = new Date().toISOString();
        this.sessionCheckpoint = {
            ...this.sessionCheckpoint,
            status: 'completed',
            completedAt: now,
            lastHeartbeatAt: now,
            updatedAt: now,
        };

        this.brief = {
            ...this.brief,
            sessionCheckpoint: this.sessionCheckpoint,
            sessionRecovery: null,
            briefGeneratedAt: now,
        };

        await this.persistState();
        return this.brief;
    }

    async abandonSession(input: SessionActionInput = {}): Promise<WorkingMemoryBrief> {
        await this.ensureSessionLoaded();
        if (!this.brief || !this.sessionCheckpoint) {
            return this.brief ?? (await this.handshake({ task: 'abandon session', recentMessages: [] }));
        }

        if (input.sessionId && input.sessionId.trim() !== this.sessionCheckpoint.sessionId) {
            throw new Error(`Session "${input.sessionId}" does not match the active checkpoint.`);
        }

        const now = new Date().toISOString();
        this.sessionCheckpoint = {
            ...this.sessionCheckpoint,
            status: 'abandoned',
            abandonedAt: now,
            lastHeartbeatAt: now,
            updatedAt: now,
        };

        this.brief = {
            ...this.brief,
            sessionCheckpoint: this.sessionCheckpoint,
            sessionRecovery: null,
            briefGeneratedAt: now,
        };

        await this.persistState();
        return this.brief;
    }

    async inspectSession(context?: Partial<AgentContext>): Promise<SessionInspection> {
        const persisted = await this.loadPersistedState();
        const checkpoint = persisted?.sessionCheckpoint ?? this.sessionCheckpoint ?? null;
        const normalizedTask = typeof context?.task === 'string' ? context.task.trim() : '';
        const recentMessages = Array.isArray(context?.recentMessages) ? context.recentMessages : [];
        const recovery = checkpoint && normalizedTask
            ? this.buildRecovery({ task: normalizedTask, recentMessages }, checkpoint).recovery
            : null;

        return {
            agentId: this.agentId,
            hasCheckpoint: Boolean(checkpoint),
            sessionCheckpoint: checkpoint,
            sessionRecovery: recovery,
            persistedBriefGeneratedAt: persisted?.briefGeneratedAt,
            summary: summarizeSessionState(this.agentId, checkpoint, persisted?.briefGeneratedAt),
        };
    }

    getAgentId(): string {
        return this.agentId;
    }

    async attend(input: AttendInput): Promise<AttendResult> {
        const t0 = timeStart();
        const currentContext = input.currentContext ?? '';
        const latestMessage = normalizeMessage(input.latestMessage);
        const forceInject = input.forceInject === true;
        const effectiveEntityHints = this.resolveAttendEntityHints(input.entityHints, latestMessage);
        const observationContext = currentContext.trim().length > 0 ? currentContext : latestMessage;

        const decision = await this.decideMemoryNeed({
            currentContext,
            latestMessage,
            forceInject,
        });

        if (!decision.needed) {
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'attend_completed',
                agentId: this.agentId,
                source: 'internal',
                reason: null,
                level: 'debug',
                metadata: {
                    contextCallCount: this.contextCallCount,
                    sessionId: this.sessionStarted,
                    shouldInject: false,
                    attendReason: 'memory_not_needed',
                },
            });
            timeEnd('attendant.attend_ms', t0);
            return {
                shouldInject: false,
                reason: 'memory_not_needed',
                decision,
                facts: [],
                entitiesDetected: [],
                alreadyPresent: 0,
                totalFound: 0,
                entitiesResolved: [],
                debug: {
                    skipped: 'empty_context',
                    contextLength: currentContext.length,
                    detectionWindowChars: Math.min(currentContext.length, ENTITY_DETECTION_WINDOW_CHARS),
                    detectedCandidates: 0,
                    keptCandidates: 0,
                    hintsProvided: effectiveEntityHints.length,
                    hintsResolved: 0,
                    dropped: [{ name: latestMessage || '(none)', reason: 'memory_not_needed' }],
                },
            };
        }

        const observed = await this.observe({
            currentContext: observationContext,
            maxFacts: input.maxFacts,
            entityHints: effectiveEntityHints,
        });

        let reason: AttendResult['reason'] = 'memory_needed_injected';
        const shouldInject = observed.facts.length > 0;

        if (!shouldInject) {
            const allAlreadyInContext = observed.totalFound > 0 && observed.alreadyPresent >= observed.totalFound;
            reason = allAlreadyInContext ? 'memory_needed_but_in_context' : 'memory_needed_no_facts';
        } else if (forceInject) {
            reason = 'forced';
        }

        const attendResult = {
            ...observed,
            shouldInject,
            reason,
            decision,
        };
        getStaffEventEmitter().emit({
            staffComponent: 'Attendant',
            actionType: 'attend_completed',
            agentId: this.agentId,
            source: 'internal',
            reason: null,
            level: 'debug',
            metadata: {
                contextCallCount: this.contextCallCount,
                sessionId: this.sessionStarted,
                shouldInject,
                attendReason: reason,
            },
        });
        timeEnd('attendant.attend_ms', t0);
        return attendResult;
    }

    // Context Window Observation

    async observe(input: ObserveInput): Promise<ObserveResult> {
        const t0 = timeStart();
        const maxFacts = input.maxFacts ?? 5;
        const currentContext = input.currentContext ?? '';
        const entityHints = Array.isArray(input.entityHints)
            ? input.entityHints.filter((hint) => typeof hint === 'string' && hint.trim().length > 0)
            : [];

        if (currentContext.trim().length === 0 && entityHints.length === 0) {
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'observe_completed',
                agentId: this.agentId,
                source: 'internal',
                reason: null,
                level: 'debug',
                metadata: {
                    observeType: 'empty_context',
                    sessionId: this.sessionStarted,
                },
            });
            timeEnd('attendant.observe_ms', t0);
            return {
                facts: [],
                entitiesDetected: [],
                alreadyPresent: 0,
                totalFound: 0,
                entitiesResolved: [],
                debug: {
                    skipped: 'empty_context',
                    contextLength: 0,
                    detectionWindowChars: 0,
                    detectedCandidates: 0,
                    keptCandidates: 0,
                    hintsProvided: 0,
                    hintsResolved: 0,
                    dropped: [],
                },
            };
        }

        const detectionWindow = currentContext.length <= ENTITY_DETECTION_WINDOW_CHARS
            ? currentContext
            : currentContext.slice(-ENTITY_DETECTION_WINDOW_CHARS);
        const droppedCandidates: Array<{ name: string; reason: string }> = [];

        // Step 1 - extract entity mentions only when the caller did not already
        // provide deterministic entity hints. Explicit hints should be authoritative.
        let parsedCandidates: EntityCandidate[] = [];
        if (detectionWindow.trim().length > 0 && entityHints.length === 0) {
            const entityResponse = await route('extraction', [
                {
                    role: 'user',
                    content: `Extract explicitly named entities from the text.
An entity can be a person, organization, project, technology, or named concept.

Return ONLY valid JSON as an array of objects in this exact shape:
[
  {
    "type": "project",
    "name": "Project Atlas",
    "id_guess": "project_atlas",
    "confidence": 0.92,
    "evidence": "Project Atlas",
    "start": 123,
    "end": 136
  }
]

Rules:
- Only include entities explicitly named in the provided text.
- Do not infer or carry over entities not present in the text.
- If uncertain, omit.
- If none are present, return [].

Text:
${detectionWindow}`,
                },
            ], 512);

            try {
                const clean = entityResponse.text.replace(/```json|```/g, '').trim();
                const parsed = JSON.parse(clean);
                if (Array.isArray(parsed)) {
                    for (const item of parsed) {
                        if (typeof item === 'string') {
                            const raw = item.trim();
                            if (!raw) continue;

                            if (raw.includes('/')) {
                                const [type, ...rest] = raw.split('/');
                                const idGuess = heuristicEntityId(rest.join('/'));
                                if (!type || !idGuess) continue;
                                parsedCandidates.push({
                                    type,
                                    name: idGuess.replace(/_/g, ' '),
                                    id_guess: idGuess,
                                    confidence: 0.9,
                                    evidence: raw,
                                });
                            } else {
                                const idGuess = heuristicEntityId(raw);
                                if (!idGuess) continue;
                                parsedCandidates.push({
                                    type: 'project',
                                    name: raw,
                                    id_guess: `project_${idGuess}`,
                                    confidence: 0.76,
                                    evidence: raw,
                                });
                            }
                            continue;
                        }

                        if (!item || typeof item !== 'object') continue;
                        const candidate = item as Partial<EntityCandidate>;
                        if (
                            typeof candidate.type === 'string' &&
                            typeof candidate.name === 'string' &&
                            typeof candidate.id_guess === 'string' &&
                            typeof candidate.confidence === 'number' &&
                            typeof candidate.evidence === 'string'
                        ) {
                            parsedCandidates.push({
                                type: candidate.type,
                                name: candidate.name,
                                id_guess: candidate.id_guess,
                                confidence: candidate.confidence,
                                evidence: candidate.evidence,
                                start: candidate.start,
                                end: candidate.end,
                            });
                        }
                    }
                }
            } catch {
                droppedCandidates.push({ name: 'entity_extraction_parse_error', reason: 'invalid_json' });
            }

            if (parsedCandidates.length === 0) {
                parsedCandidates = extractFallbackCandidates(detectionWindow);
                if (parsedCandidates.length > 0) {
                    droppedCandidates.push({ name: 'entity_extraction_fallback', reason: 'heuristic_used' });
                }
            }
        }

        const gatedCandidates: EntityCandidate[] = [];
        for (const candidate of parsedCandidates) {
            if (candidate.confidence < MIN_ENTITY_CONFIDENCE) {
                droppedCandidates.push({ name: candidate.name, reason: 'low_confidence' });
                continue;
            }
            const evidenceLower = candidate.evidence.toLowerCase().trim();
            if (!evidenceLower || !detectionWindow.toLowerCase().includes(evidenceLower)) {
                droppedCandidates.push({ name: candidate.name, reason: 'missing_evidence' });
                continue;
            }
            gatedCandidates.push(candidate);
        }

        if (gatedCandidates.length === 0 && entityHints.length === 0) {
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'observe_completed',
                agentId: this.agentId,
                source: 'internal',
                reason: null,
                level: 'debug',
                metadata: {
                    observeType: 'no_candidates',
                    sessionId: this.sessionStarted,
                },
            });
            timeEnd('attendant.observe_ms', t0);
            return {
                facts: [],
                entitiesDetected: [],
                alreadyPresent: 0,
                totalFound: 0,
                entitiesResolved: [],
                debug: {
                    contextLength: currentContext.length,
                    detectionWindowChars: detectionWindow.length,
                    detectedCandidates: parsedCandidates.length,
                    keptCandidates: 0,
                    hintsProvided: entityHints.length,
                    hintsResolved: 0,
                    dropped: droppedCandidates,
                },
            };
        }

        // Step 2 — resolve hints and candidates to canonical entities, then query Library
        const policy = await getConflictPolicy();
        const maxEntities = policy.maxEntitiesPerObserve ?? 5;
        const maxKeysPerEntity = policy.maxKeysPerEntity ?? 5;
        const allFacts: RetrievedFact[] = [];
        const entitiesResolved: ObserveResult['entitiesResolved'] = [];
        const entitiesDetected = new Set<string>();
        const resolvedEntities = new Map<string, {
            entityType: string;
            entityId: string;
            canonicalEntity: string;
            name: string;
            input: string;
            confidence: number;
            matchedBy: 'exact' | 'alias' | 'created' | 'hint';
        }>();

        for (const hint of entityHints) {
            try {
                const parsedHint = parseEntityString(hint);
                const resolved = await resolveEntity({
                    entityType: parsedHint.entityType,
                    entityId: parsedHint.entityId,
                    rawName: hint,
                    aliases: [hint, parsedHint.entityId],
                    source: 'observe_hint',
                    confidence: 100,
                    createIfMissing: false,
                });

                if (!resolvedEntities.has(resolved.canonicalEntity)) {
                    resolvedEntities.set(resolved.canonicalEntity, {
                        entityType: resolved.entityType,
                        entityId: resolved.entityId,
                        canonicalEntity: resolved.canonicalEntity,
                        name: parsedHint.entityId.replace(/_/g, ' '),
                        input: hint,
                        confidence: 1,
                        matchedBy: 'hint',
                    });
                }
            } catch {
                droppedCandidates.push({ name: hint, reason: 'invalid_or_unresolved_hint' });
                continue;
            }
        }

        for (const candidate of gatedCandidates.slice(0, maxEntities)) {
            const fallbackEntity = `${candidate.type}/${candidate.id_guess}`;

            try {
                const resolved = await resolveEntity({
                    entityType: candidate.type,
                    entityId: candidate.id_guess,
                    rawName: candidate.name,
                    aliases: [
                        candidate.name,
                        candidate.evidence,
                        fallbackEntity,
                    ],
                    source: 'observe',
                    confidence: Math.round(candidate.confidence * 100),
                    createIfMissing: false,
                });

                if (!resolvedEntities.has(resolved.canonicalEntity)) {
                    resolvedEntities.set(resolved.canonicalEntity, {
                        entityType: resolved.entityType,
                        entityId: resolved.entityId,
                        canonicalEntity: resolved.canonicalEntity,
                        name: candidate.name,
                        input: fallbackEntity,
                        confidence: candidate.confidence,
                        matchedBy: resolved.matchedBy,
                    });
                }
            } catch {
                droppedCandidates.push({ name: candidate.name, reason: 'unresolved' });
                continue;
            }
        }

        for (const resolvedInfo of Array.from(resolvedEntities.values()).slice(0, maxEntities)) {
            entitiesDetected.add(resolvedInfo.canonicalEntity);
            entitiesResolved?.push({
                name: resolvedInfo.name,
                input: resolvedInfo.input,
                canonicalEntity: resolvedInfo.canonicalEntity,
                confidence: resolvedInfo.confidence,
                matchedBy: resolvedInfo.matchedBy,
            });

            const allEntries = await findEntriesByEntity(resolvedInfo.entityType, resolvedInfo.entityId);

            // Priority keys first
            const priorityKeys = policy.observeKeyPriority?.[resolvedInfo.entityType] ?? [];
            const priorityEntries = allEntries.filter((e) => priorityKeys.includes(e.key));
            const remainingEntries = allEntries
                .filter((e) => !priorityKeys.includes(e.key))
                .sort((a, b) => b.confidence - a.confidence);

            const selectedEntries = [...priorityEntries, ...remainingEntries].slice(0, maxKeysPerEntity);

            for (const entry of selectedEntries) {
                allFacts.push({
                    entityKey: `${resolvedInfo.entityType}/${resolvedInfo.entityId}/${entry.key}`,
                    summary: entry.valueSummary,
                    value: entry.valueRaw,
                    confidence: entry.confidence,
                    source: entry.source,
                    entryId: entry.id,
                });
            }
        }

        // Step 3 — filter out facts already present in context
        const contextLower = currentContext.toLowerCase();
        let alreadyPresent = 0;
        const newFacts: RetrievedFact[] = [];

        for (const fact of allFacts) {
            // Check if summary key words appear in context
            const summaryWords = fact.summary.toLowerCase().split(' ').filter((w) => w.length > 4);
            const alreadyInContext = summaryWords.length > 0 &&
                summaryWords.filter((w) => contextLower.includes(w)).length >= Math.ceil(summaryWords.length * 0.6);

            if (alreadyInContext) {
                alreadyPresent++;
            } else {
                newFacts.push(fact);
            }
        }

        // Step 4 — return top facts by confidence
        const topFacts = newFacts
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, maxFacts);

        await recordKnowledgeEntryAccess(topFacts.map((fact) => fact.entryId));

        getStaffEventEmitter().emit({
            staffComponent: 'Attendant',
            actionType: 'observe_completed',
            agentId: this.agentId,
            source: 'internal',
            reason: null,
            level: 'debug',
            metadata: {
                observeType: 'facts_retrieved',
                factsCount: topFacts.length,
                sessionId: this.sessionStarted,
            },
        });
        timeEnd('attendant.observe_ms', t0);
        return {
            facts: topFacts.map(({ entityKey, summary, value, confidence, source }) => ({
                entityKey,
                summary,
                value,
                confidence,
                source,
            })),
            entitiesDetected: Array.from(entitiesDetected),
            alreadyPresent,
            totalFound: allFacts.length,
            entitiesResolved,
            debug: {
                contextLength: currentContext.length,
                detectionWindowChars: detectionWindow.length,
                detectedCandidates: parsedCandidates.length,
                keptCandidates: gatedCandidates.length,
                hintsProvided: entityHints.length,
                hintsResolved: entitiesResolved?.filter((e) => e.matchedBy === 'hint').length ?? 0,
                dropped: droppedCandidates,
            },
        };
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private buildRecovery(
        context: AgentContext,
        record: SessionCheckpointRecord
    ): { interrupted: boolean; recovery: SessionRecoveryInfo | null } {
        return evaluateSessionRecovery(record, context);
    }

    private async ensureSessionLoaded(): Promise<void> {
        if (this.brief) return;
        await this.loadPersistedState();
    }

    private async decideMemoryNeed(input: {
        currentContext: string;
        latestMessage: string;
        forceInject: boolean;
    }): Promise<AttendDecision> {
        if (input.forceInject) {
            return {
                needed: true,
                confidence: 1,
                method: 'forced',
                explanation: 'force_inject',
            };
        }

        const heuristic = heuristicMemoryNeed(input.latestMessage);
        if (heuristic.needed !== null) {
            return {
                needed: heuristic.needed,
                confidence: heuristic.confidence,
                method: 'heuristic',
                explanation: heuristic.explanation,
            };
        }

        const contextWindow = input.currentContext.length <= MEMORY_DECISION_CONTEXT_WINDOW_CHARS
            ? input.currentContext
            : input.currentContext.slice(-MEMORY_DECISION_CONTEXT_WINDOW_CHARS);

        const response = await route('classification', [
            {
                role: 'user',
                content: `Decide whether this assistant should fetch persistent memory before replying.

Latest user message:
${input.latestMessage || '(none)'}

Recent context excerpt:
${contextWindow || '(empty)'}

Return ONLY valid JSON with this exact shape:
{"needsMemory":true,"confidence":0.81,"reason":"short_reason"}

Rules:
- needsMemory=true when the answer likely depends on user-specific or session-specific facts.
- needsMemory=false for generic chit-chat, open-domain facts, or when no memory lookup is needed.
- confidence is a float from 0 to 1.`,
            },
        ], 128);

        const parsed = this.parseMemoryDecision(response.text);
        if (parsed) {
            return {
                needed: parsed.needsMemory,
                confidence: parsed.confidence,
                method: 'llm',
                explanation: parsed.reason,
            };
        }

        return {
            needed: false,
            confidence: 0.5,
            method: 'heuristic',
            explanation: 'classification_parse_failed_default_false',
        };
    }

    private resolveAttendEntityHints(entityHints: string[] | undefined, latestMessage: string): string[] {
        const explicit = Array.isArray(entityHints)
            ? entityHints.filter((hint) => typeof hint === 'string' && hint.trim().length > 0)
            : [];
        const scope = classifyMemoryScope(latestMessage);

        if (explicit.length > 0) {
            return explicit;
        }

        if (scope === 'personal') {
            return [getPersonalMemoryEntity()];
        }

        if (scope === 'project') {
            const configured = getProjectMemoryEntity();
            if (configured) {
                return [configured];
            }
        }

        return [];
    }

    private parseMemoryDecision(raw: string): { needsMemory: boolean; confidence: number; reason: string } | null {
        try {
            const cleaned = raw.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(cleaned) as {
                needsMemory?: unknown;
                confidence?: unknown;
                reason?: unknown;
            };

            if (typeof parsed.needsMemory !== 'boolean') return null;
            const confidence = typeof parsed.confidence === 'number'
                ? Math.max(0, Math.min(1, parsed.confidence))
                : 0.6;
            const reason = typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
                ? parsed.reason.trim()
                : 'llm_classification';

            return {
                needsMemory: parsed.needsMemory,
                confidence,
                reason,
            };
        } catch {
            return null;
        }
    }

    private async inferTask(context: AgentContext): Promise<string> {
        this.contextCallCount++;
        if (this.contextCallCount >= CONTEXT_RECOVERY_THRESHOLD) {
            await this.onContextLow();
        }

        const response = await route('task_inference', [
            {
                role: 'user',
                content: `You are analyzing what an AI agent is currently working on.

Agent ID: ${this.agentId}
Task description: ${context.task}
Recent messages:
${context.recentMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')}

In one short sentence, describe the specific type of task this agent is currently performing.
Be specific and concrete.`,
            },
        ], 256);

        return response.text;
    }

    private async loadOperatingRules(): Promise<string> {
        const rulesResult: QueryResult = await queryEntry(ATTENDANT_RULES_QUERY);
        return rulesResult.found && rulesResult.entry
            ? rulesResult.entry.valueSummary
            : 'No operating rules found.';
    }

    private async buildWorkingMemory(taskType: string): Promise<WorkingMemoryEntry[]> {
        this.contextCallCount++;

        // Fetch agent entries + related entity entries
        const agentEntries = await findEntriesByEntity('agent', this.agentId);
        const relatedEntities = await getRelatedDeep('agent', this.agentId, 2);
        const relatedEntries = await Promise.all(
            relatedEntities.map((r) => findEntriesByEntity(r.entityType, r.entityId))
        );

        const allEntries = [...agentEntries, ...relatedEntries.flat()];

        if (allEntries.length === 0) return [];

        const entryInputs = allEntries.map((e) => ({
            id: e.id,
            key: `${e.entityType}/${e.entityId}/${e.key}`,
            valueSummary: e.valueSummary,
            confidence: e.confidence,
            source: e.source,
        }));

        // Filter to relevant entries for current task
        const response = await route('relevance_filtering', [
            {
                role: 'user',
                content: `You are deciding what knowledge an AI agent needs for its current task.

Agent task: ${taskType}

Available knowledge entries:
${entryInputs.map((e, i) => `${i + 1}. [${e.key}] ${e.valueSummary} (confidence: ${e.confidence})`).join('\n')}

Return only the numbers of entries that are directly relevant to the current task.
Format: comma-separated numbers only. Example: 1,3,5
If nothing is relevant, return: none`,
            },
        ], 128);

        if (response.text.trim() === 'none') return [];

        const indices = response.text
            .split(',')
            .map((s) => parseInt(s.trim()) - 1)
            .filter((i) => i >= 0 && i < entryInputs.length);

        const selectedEntries = indices.map((i) => entryInputs[i]);
        await recordKnowledgeEntryAccess(selectedEntries.map((entry) => entry.id));

        return selectedEntries.map((entry) => ({
            entityKey: entry.key,
            summary: entry.valueSummary,
            confidence: entry.confidence,
            source: entry.source,
            lastUpdated: new Date().toISOString(),
        }));
    }

    private async persistState(): Promise<void> {
        if (!this.brief) return;

        await getDb().knowledgeEntry.upsert({
            where: {
                entityType_entityId_key: {
                    entityType: 'agent',
                    entityId: this.agentId,
                    key: 'attendant_state',
                },
            },
            update: {
                valueRaw: this.brief as unknown as Prisma.InputJsonValue,
                valueSummary: `Attendant state for ${this.agentId}`,
                updatedAt: new Date(),
            },
            create: {
                entityType: 'agent',
                entityId: this.agentId,
                key: 'attendant_state',
                valueRaw: this.brief as unknown as Prisma.InputJsonValue,
                valueSummary: `Attendant state for ${this.agentId}`,
                confidence: 100,
                source: 'attendant',
                createdBy: 'attendant',
                isProtected: false,
                conflictLog: [],
            },
        });
    }

    private async loadPersistedState(): Promise<WorkingMemoryBrief | null> {
        const state = await readPersistedBriefForAgent(this.agentId);
        if (!state) return null;

        this.sessionStarted = state.sessionStarted;
        this.contextCallCount = state.contextCallCount ?? 0;
        this.sessionCheckpoint = state.sessionCheckpoint ?? null;
        this.brief = state;
        return state;
    }
}

