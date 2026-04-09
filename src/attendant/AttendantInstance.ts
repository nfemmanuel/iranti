import { randomUUID } from 'crypto';
import { route } from '../lib/router';
import { getStaffEventEmitter } from '../lib/staffEventRegistry';
import { queryEntry, findEntriesByEntity, findEntriesByEntityType, recordKnowledgeEntryAccess } from '../library/queries';
import { findEntry } from '../library/queries';
import { getRelated, getRelatedDeep } from '../library/relationships';
import { parseEntityString, resolveEntity } from '../library/entity-resolution';
import { librarianWrite } from '../librarian';
import { getDb } from '../library/client';
import { Prisma } from '../generated/prisma/client';
import { EntryQuery, QueryResult } from '../types';
import { timeStart, timeEnd } from '../lib/metrics';
import { getConflictPolicy } from '../librarian/getPolicy';
import {
    classifyMemoryScope,
    detectMandatoryRecall,
    extractExplicitAssistantMemory,
    extractExplicitPromptMemory,
    getPersonalMemoryEntity,
    getPersonalRecallEntities,
    getProjectMemoryEntity,
    isPersonalEntityType,
    isPersonalMemoryKey,
} from '../lib/autoRemember';
import { buildSemanticFactTags, semanticMatchScore } from '../lib/semanticFactTags';
import type { SemanticFilter } from '../lib/semanticFactTags';
import {
    buildSessionLedgerLearningProfile,
    summarizeSessionLedgerLearnings,
    type SessionLedgerLearningProfile,
    type SessionLedgerLearning,
    SessionLedgerUnavailableError,
} from '../lib/sessionLedger';
import { registerSharedStateInvalidationObserver } from '../lib/sharedStateInvalidation';
import { assignStructuredFactIds } from '../lib/hostMemoryFormatting';

// ─── Constants ───────────────────────────────────────────────────────────────

const ATTENDANT_RULES_QUERY: EntryQuery = {
    entityType: 'system',
    entityId: 'attendant',
    key: 'operating_rules',
};
export const DEFAULT_ATTENDANT_OPERATING_RULES: string[] = [
    'Serve one external agent only; optimize for that agent keeping task context coherent across turns and sessions.',
    'ACKNOWLEDGE: This is strictly mandatory — you MUST state the following before proceeding with any user request, and no work should begin until it is stated: "I acknowledge that Iranti is a hive mind. I have read the Iranti operating rules and the protocols for iranti_handshake, iranti_attend, iranti_write, iranti_checkpoint, and iranti_remember_response, and I pledge to use them to persist what I find, what works, what fails, what changes, and what happens next so later sessions do not have to rediscover it." Skipping this acknowledgment is non-compliant regardless of context.',
    'SESSION START: Call iranti_handshake before responding to the first user message. After context compaction, call iranti_handshake again before responding to the next message.',
    "ATTEND PROTOCOL — follow this sequence every turn: (1) Call iranti_attend before responding to the user message — pass phase='pre-response' to enable precise compliance tracking. (2) Call iranti_attend before any lookup where Iranti might already hold the answer — this includes Read, Grep, Glob, WebSearch, WebFetch, and Bash commands used as factual basis for a decision. (3) Call iranti_attend after any such lookup to check new findings against stored memory and decide what to inject, write, or checkpoint. (4) Call iranti_write after every Edit or Write tool call — file changes are always durable, record what changed, why, and what the file now does. (5) Call iranti_write after any Bash command that reveals system state — build results, test outcomes, container state, port availability, environment facts, errors. (6) Call iranti_write after any WebSearch or WebFetch that surfaces confirmed external facts. (7) Call iranti_write after any subagent (Agent tool) completes — subagent findings are invisible to the hive mind otherwise. (8) Call iranti_attend after every response without exception — pass phase='post-response'. Even short or conversational replies may contain durable decisions, confirmed facts, or next steps. Assess for write or checkpoint before the next turn. (9) Call iranti_attend again when new knowledge should change what is loaded for the next step.",
    'Treat Iranti as the default shared working-memory layer. Keep using your own private notes if you want, but prefer Iranti for anything another session, another agent, or a later handoff may need.',
    'Before answering recall-style questions about remembered preferences, decisions, blockers, next steps, prior project state, or earlier findings, consult Iranti instead of guessing.',
    'If a recall-style lookup returns no facts, do not treat empty as confirmation of absence — try at least one alternative retrieval angle before concluding the fact is not stored: switch between exact query and search, try a different entity path or key fragment, or rephrase the search term. Absence is confirmed only after two distinct retrieval attempts with different angles both return empty.',
    'Before making or repeating architectural, product, workflow, or debugging decisions, check Iranti for earlier decisions, constraints, blockers, and validated environment details.',
    'Use exact query when the entity and key are known. Use search or attend when the fact must be discovered from shared memory.',
    'Persist durable knowledge when it is learned or confirmed: decisions, blockers, next steps, owners, stable preferences, project constraints, important file purposes, validated environment details, what worked, what failed, and what remains risky.',
    'Write facts with the depth of someone who built the system — include what the thing does, why it exists, how it connects to other parts, and what would break or change if it were removed. A fact that reads "file X was edited" is insufficient; "file X controls Y because Z, edited to fix W" is the target. Iranti should accumulate enough detail that any agent reading its memory feels like it built the repo.',
    'WRITE FORMAT STANDARD: iranti_write after a file edit requires entity: project/[project_id]/file/[filename_without_ext] (never the broad project entity — this scopes retrieval so nav_tsx facts do not contaminate sitedata_ts lookups). Value must include: absolutePath (full path to the file), lines (the line range changed, e.g. "65-70"), before (exact prior text or behavior), after (exact new text or behavior), verify (a grep or read command that confirms the change is present), why (the decision behind the change). A write that records only "file X was updated" is non-compliant. iranti_write after WebSearch or WebFetch: record what you found AND what failed — 404s, private repos, dead links, and searches that returned nothing. Negative findings are as durable as positive ones. iranti_write after system-state Bash: include the command and the relevant output lines, not just a summary.',
    'When a file is created, renamed, moved, deleted, or substantially repurposed, capture that change and what the file is for whenever the state will matter to another agent or a later session.',
    'When a task reaches a useful checkpoint, store the current step, next step, open risks, and any important artifacts or paths so another agent can resume without reconstructing context from scratch.',
    'When an approach fails and the failure or workaround is likely to matter later, store the failed path and the chosen alternative route as durable memory.',
    'Use iranti_checkpoint for active shared progress, iranti_write for durable facts, iranti_ingest for stable source material worth chunking, and iranti_remember_response for strict assistant summaries such as next steps or blockers.',
    'CHECKPOINT PROTOCOL: Call iranti_checkpoint (1) when completing a task, (2) when shifting to a new task mid-session, and (3) at any natural pause point where another session should resume — not only when saving facts with iranti_write. A checkpoint not written means the next handshake recovers from stale data, and a long run without structured writes/checkpoints is non-compliant for Iranti. Write checkpoints like the best possible commit message but with more detail — lead with the why (what problem this solved, what decision was made, what changed and why it matters), then add structured recovery context: current step, next step, what worked, what failed, open risks, and file changes. A checkpoint that reads "did some edits" is non-compliant; one that reads "fixed missing docker dependency in cofactor instance.json — container name was never recorded at setup so iranti run silently skipped docker start; added iranti_cofactor_db dependency, verified against docker ps, control panel start will now auto-boot the container" is the target.',
    'Do not save every turn. Skip idle chatter and transient execution noise. Do save design options, architectural proposals, and considered-but-not-yet-decided directions with their reasoning — a future session should not have to re-explore ground already covered, even when no final decision was made. Do not skip discoveries, failed paths, validations, file changes, risks, or next steps that another session would otherwise have to rediscover.',
    'Deliver a compressed working-memory brief, not the full knowledge base. Load only what is relevant to the current task.',
    'Reconvene or attend again when context shifts, when the visible window is missing needed facts, or when a different entity becomes relevant.',
    'If context gets stale or the task has gone long enough that reasoning may drift, re-read the operating rules from the Staff Namespace before proceeding.',
];
const CONTEXT_RECOVERY_THRESHOLD = 20;  // LLM calls before context recovery
const SESSION_INTERRUPTION_TTL_MS = 5 * 60 * 1000;
const PERSISTENCE_WARNING_THRESHOLD = 3;
const PERSISTENCE_NON_COMPLIANT_THRESHOLD = 5;
const ENTITY_DETECTION_WINDOW_CHARS = 1500;
const MIN_ENTITY_CONFIDENCE = 0.75;
const MEMORY_DECISION_CONTEXT_WINDOW_CHARS = 2000;
const LEDGER_WORKING_MEMORY_PREFIX = 'system/session_ledger/recent_learning_';
const LEGACY_CONTINUITY_KEY_MAP: Record<string, string> = {
    checkpoint_current_step: 'current_step',
    checkpoint_next_step: 'next_step',
    checkpoint_open_risks: 'open_risks',
};
// expectedCallSequence removed — the full protocol now lives in IRANTI.md,
// written once per project by `iranti claude-setup`, instead of repeated on every attend call.
const ATTEND_USAGE_REMINDER = 'Iranti is a hive mind. MANDATORY: call iranti_attend before every reply and around knowledge discovery. MANDATORY: call iranti_write after every file edit, confirmed finding, environment state change, and subagent completion — write what changed, why, and what it means. Skipping writes means the next session starts blind and must rediscover everything from scratch.';
const OBSERVE_USAGE_NOTE = 'observe() is retrieval-only. It surfaces candidate facts for context and warm-up, but it does not persist memory, replace iranti_attend, or count as a checkpoint/write.';

function normalizeContinuityKey(key: string): string {
    return LEGACY_CONTINUITY_KEY_MAP[key] ?? key;
}

function expandContinuityPriorityKeys(keys: string[]): string[] {
    const expanded = new Set<string>();
    for (const rawKey of keys) {
        const key = rawKey.trim();
        if (!key) continue;
        expanded.add(key);
        expanded.add(normalizeContinuityKey(key));
    }
    return Array.from(expanded);
}

const MEMORY_NEED_POSITIVE_PATTERNS: RegExp[] = [
    /\bwhat(?:'s| is| was)?\s+my\b/i,
    /\bdo you remember\b/i,
    /\bremind me\b/i,
    /\bbring me up to speed\b/i,
    /\bcatch me up\b/i,
    /\brecap\b/i,
    /\bwhere did we leave off\b/i,
    /\bwhere are we\b/i,
    /\bwhat did we learn\b/i,
    /\bwhat did we decide\b/i,
    /\bwhat do we know\b/i,
    /\bnext step\b/i,
    /\bwhat(?:'s| is)?\s+next\b/i,
    /\b(?:what|which)\s+(?:bugs?|issues?|defects?|tasks?|blockers?|risks?)\s+(?:are\s+)?(?:left|open|remaining)\b/i,
    /\bwhat\s+(?:changed|worked|failed)\b/i,
    /\b(?:current\s+)?status\b/i,
    /\b(?:current\s+)?progress\b/i,
    /\b(?:summary|summarize|overview)\b/i,
    /\bmy\s+(?:favorite|favourite|name|email|phone|address|city|country|movie|snack|color|colour)\b/i,
    /\bwe decided\b/i,
    /\bearlier\b/i,
    /\bprevious(?:ly)?\b/i,
    /\bagain\b/i,
    // Common imperative work-task prefixes — short messages like "fix it", "add tests",
    // "help me debug", "explain this" are almost always project-contextual and benefit from
    // memory injection. Catching these here prevents fall-through to the LLM classifier and
    // the classification_parse_failed_default_false silent miss.
    /^\s*(?:fix|debug|refactor|implement|add|update|change|remove|delete|create|write|check|review|test|run|deploy|build|enable|disable|configure|set up|setup)\b/i,
    /\bhelp\s+me\b/i,
    /\bexplain\s+(?:this|that|how|why|what)\b/i,
    /\bwhat\s+(?:is|are|was|were)\s+(?:the|a|an|this|that|my|our|its)\b/i,
    /\bhow\s+(?:do|does|did|should|can|could|would|to)\b/i,
    /\bwhy\s+(?:is|are|was|were|did|does|do|not)\b/i,
    // Technical vocabulary — file paths, function-call syntax, camelCase/snake_case identifiers,
    // and dot-notation references are strong signals that the message is project-bound.
    /(?:\/[\w.\-]+){1,}|[\w]+\.[a-z]{1,5}\b/i,
    /\b[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/,   // camelCase
    /\b[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+\b/,         // snake_case
    /\b\w+\s*\(/,                                       // function call syntax
];

const MEMORY_NEED_NEGATIVE_PATTERNS: RegExp[] = [
    /^\s*(hi|hello|hey|yo|sup|good (?:morning|afternoon|evening))\b[!.?\s]*$/i,
    /^\s*(thanks|thank you|cool|great|nice)\b[!.?\s]*$/i,
];

const SEARCH_SUGGESTION_STOPWORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
    'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
    'you', 'your', 'yours', 'me', 'my', 'mine', 'we', 'our', 'ours',
    'they', 'them', 'their', 'theirs', 'he', 'she', 'his', 'her', 'its',
    'this', 'that', 'these', 'those', 'it',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'for', 'with',
    'from', 'into', 'about', 'after', 'before', 'between', 'under', 'over',
    'some', 'any', 'all', 'each', 'every', 'other', 'more', 'most',
    'very', 'much', 'just', 'also', 'too', 'still', 'own',
    'what', 'how', 'when', 'where', 'which', 'who', 'why',
    'get', 'got', 'let', 'put', 'say', 'tell', 'ask', 'use', 'try',
    'give', 'take', 'make', 'come', 'see', 'look', 'think', 'know',
    'want', 'need', 'keep', 'turn', 'run',
    'way', 'now', 'here', 'there', 'then', 'than',
    'yes', 'no', 'nice', 'okay', 'sure', 'like',
    'new', 'old', 'possible', 'ideas', 'idea',
    'hey', 'per',
]);

const MEMORY_PARSE_FAILURE_PROJECT_CUE_PATTERNS: RegExp[] = [
    /\b(?:status|progress|summary|summar(?:y|ize)|recap|overview|state)\b/i,
    /\b(?:decision|decisions|findings?|artifacts?|changes?|work|implementation|architecture|code(?:base)?|repo|repository)\b/i,
    /\b(?:deployment|setup|bug|bugs|issue|issues|defect|defects|task|tasks|blocker|blockers|risk|risks)\b/i,
    /\bwhat\s+(?:did|do|have)\s+we\b/i,
    /\bwhere\s+do\s+we\s+stand\b/i,
];

const EXPLICIT_TASK_PREFIX_PATTERNS: RegExp[] = [
    /^\s*general session\s*[:\-]\s*/i,
    /^\s*general session assistance\s*(?:for)?\s*/i,
    /^\s*session assistance\s*(?:for)?\s*/i,
    /^\s*general assistance\s*(?:for)?\s*/i,
];

const WEAK_EXPLICIT_TASK_PATTERNS: RegExp[] = [
    /^general session$/i,
    /^general assistance$/i,
    /^session assistance$/i,
    /^assistance$/i,
    /^help$/i,
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentContext {
    task: string;
    recentMessages: string[];
    postCompaction?: boolean;
    ledgerContext?: {
        source?: string;
        host?: string | null;
    };
}

export interface WorkingMemoryEntry {
    entityKey: string;       // format: entityType/entityId/key
    summary: string;
    confidence: number;
    source: string;
    lastUpdated: string;
}

export interface ProjectPolicyEntry {
    entityKey: string;
    summary: string;
    key: string;
    source: string;
    lastUpdated: string;
    rules: string[];
}

export interface WorkingMemoryBrief {
    agentId: string;
    operatingRules: string;
    inferredTaskType: string;
    workingMemory: WorkingMemoryEntry[];
    projectPolicies?: ProjectPolicyEntry[];
    sessionStarted: string;
    briefGeneratedAt: string;
    contextCallCount: number;
    backfillSuggestion?: BackfillSuggestion | null;
    sessionLedgerLearnings?: SessionLedgerLearning[];
    sessionCheckpoint?: SessionCheckpointRecord | null;
    sessionRecovery?: SessionRecoveryInfo | null;
    compliance?: SessionComplianceState | null;
    watchedEntities?: string[];
    pendingMemoryAttributions?: MemoryAttributionResult[];
}

export interface BackfillSuggestion {
    suggested: boolean;
    reason: string;
    candidateFacts: number;
    sampleKeys: string[];
    suggestedCommand: string;
}

export type SessionStatus = 'active' | 'interrupted' | 'completed' | 'abandoned';

export type SessionComplianceStatus = 'healthy' | 'degraded' | 'non_compliant';

export type SessionComplianceIssueCode =
    | 'missing_post_response_attend'
    | 'missing_durable_persistence'
    | 'missing_writes_across_turns'
    | 'ignored_injected_memory';

export interface SessionComplianceIssue {
    code: SessionComplianceIssueCode;
    severity: 'warn' | 'error';
    count: number;
    message: string;
    requiredAction: string;
}

export interface SessionComplianceState {
    status: SessionComplianceStatus;
    summary: string;
    issues: SessionComplianceIssue[];
    lastUpdated: string;
    counters: {
        attendsWithoutPersist: number;
        turnsWithoutWrite: number;
        midTurnAttendsThisTurn: number;
        consecutivePreResponseWithoutPost: number;
        consecutiveUnusedMemoryInjections: number;
        pendingPostResponse: boolean;
        lastAttendPhase: 'pre-response' | 'post-response' | 'mid-turn' | null;
    };
}

export interface SessionCheckpointPayload {
    currentStep?: string;
    nextStep?: string;
    openRisks?: string[];
    recentOutputs?: string[];
    actions?: Array<{
        kind: string;
        summary: string;
        status?: string;
        target?: string;
        detail?: string;
    }>;
    fileChanges?: Array<{
        action: string;
        path: string;
        toPath?: string;
        purpose?: string;
    }>;
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
    compliance?: SessionComplianceState | null;
    pendingMemoryAttributions?: MemoryAttributionResult[];
}

export interface SessionInspection {
    agentId: string;
    hasCheckpoint: boolean;
    sessionCheckpoint: SessionCheckpointRecord | null;
    sessionRecovery: SessionRecoveryInfo | null;
    compliance: SessionComplianceState;
    persistedBriefGeneratedAt?: string;
    summary: SessionSummary;
}

export type SessionOperatorState = 'none' | SessionStatus;

export interface SessionCheckpointSummary {
    currentStep: string | null;
    nextStep: string | null;
    openRiskCount: number;
    entityTargetCount: number;
    actionCount: number;
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
    compliance: SessionComplianceState | null;
}

// ─── Observe Types ────────────────────────────────────────────────────────────

export interface ObserveInput {
    currentContext: string;
    maxFacts?: number;          // default 5 - don't overwhelm context
    entityHints?: string[];     // deterministic canonical entities from caller
    priorityKeys?: string[];    // exact keys to prioritize within resolved entities
    skipContextFilter?: boolean; // when true, skip already-in-context filtering (used by forceInject)
    recoveryKeys?: string[];    // entity keys to bypass context filter — used for post-compaction re-injection of facts that were in context just before the compact
    semanticFilter?: import('../lib/semanticFactTags').SemanticFilter;
    ledgerContext?: AgentContext['ledgerContext'];
}

export interface FactInjection {
    factId?: string;            // stable only within the current injection block
    knowledgeEntryId?: number;  // durable KB entry id for attribution/eval
    entityKey: string;          // entityType/entityId/key
    summary: string;
    value: unknown;
    confidence: number;
    source: string;
    lastUpdated?: string;       // ISO timestamp — when this fact was last written
}

type RetrievedFact = FactInjection & { entryId: number };

export interface ObserveResult {
    facts: FactInjection[];           // inject these into context
    entitiesDetected: string[];       // entities found in context
    alreadyPresent: number;           // facts skipped (already in context)
    totalFound: number;               // total facts found before filtering
    usageGuidance: {
        tool: 'observe' | 'attend';
        reminder: string;
        expectedCallSequence?: string[];
        note: string;
    };
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
    suppressEvents?: boolean;
    phase?: 'pre-response' | 'post-response' | 'mid-turn';
}

export interface SessionCheckpointInput extends AgentContext {
    sessionId?: string;
    heartbeatAt?: string;
    checkpoint: SessionCheckpointPayload | string | Record<string, unknown>;
}

export interface SessionActionInput {
    sessionId?: string;
    ledgerContext?: AgentContext['ledgerContext'];
}

export interface AttendDecision {
    needed: boolean;
    confidence: number;
    method: 'heuristic' | 'llm' | 'forced' | 'advisory';
    explanation: string;
}

export interface AttendSearchSuggestion {
    hint: string;
    suggestedTerms: string[];
    alternativeEntities: string[];
}

export interface AttendResult extends ObserveResult {
    shouldInject: boolean;
    reason:
        | 'forced'
        | 'memory_not_needed'
        | 'memory_needed_no_facts'        // deprecated: use memory_checked_no_match
        | 'memory_checked_no_match'
        | 'memory_needed_but_in_context'
        | 'memory_needed_injected';
    decision: AttendDecision;
    bootstrap?: AttendBootstrapInfo | null;
    searchSuggestion?: AttendSearchSuggestion;
    complianceWarning?: string;
    compliance: SessionComplianceState;
    memoryAttributions?: MemoryAttributionResult[];
    memorySearchPerformed?: boolean;
    memoryResultsConsidered?: number;
    postResponseCapture?: PostResponseCaptureInfo;
    matchedUserRules?: MatchedUserRule[];
}

export interface PostResponseCaptureInfo {
    factsExtracted: number;
    factsWritten: number;
    checkpointExtracted: boolean;
    skipped: Array<{ key: string; reason: string }>;
}

export type MemoryAttributionEvidenceKind =
    | 'write'
    | 'checkpoint'
    | 'rediscovery'
    | 'response_reference'
    | 'response_recovery';

export interface MemoryAttributionResult {
    injectionId: string;
    surfaced: boolean;
    used: boolean;
    helpful: boolean;
    status: 'pending' | 'scored';
    phase: 'pre-response' | 'mid-turn';
    surfacedAt: string;
    scoredAt?: string;
    reason: string;
    injectedKeys: string[];
    injectedEntryIds: number[];
    injectedSummaries?: string[];
    evidenceKinds: MemoryAttributionEvidenceKind[];
}

export interface AttendBootstrapInfo {
    handshakePerformed: boolean;
    reason: 'no_existing_brief';
    task: string;
    operatingRules?: string;
    note?: string;
}

interface RelevantFreshState {
    hasFreshState: boolean;
    priorityKeys: string[];
    entities: string[];
}

interface FreshEntityTarget {
    canonicalEntity: string;
    entityType: string;
    entityId: string;
}

const WATCHED_ENTITY_PROMPT_PATTERNS: RegExp[] = [
    /\bcontinue\b/i,
    /\bresume\b/i,
    /\bpick up\b/i,
    /\bwhat(?:'s| is)?\s+next\b/i,
    /\bwhat(?:'s| is)?\s+the\s+next\s+step\b/i,
    /\bwhat(?:'s| is)?\s+the\s+status\b/i,
    /\bstatus\b/i,
    /\bprogress\b/i,
    /\brecap\b/i,
    /\bwhat\s+changed\b/i,
    /\bwhat\s+did\s+you\s+change\b/i,
    /\bwhere\s+were\s+we\b/i,
];

export function normalizeExplicitTask(task: string | null | undefined): string | null {
    if (typeof task !== 'string') return null;

    let cleaned = task
        .replace(/\s+/g, ' ')
        .replace(/^[`"']+|[`"']+$/g, '')
        .trim();

    if (!cleaned) return null;

    for (const pattern of EXPLICIT_TASK_PREFIX_PATTERNS) {
        cleaned = cleaned.replace(pattern, '').trim();
    }

    cleaned = cleaned.replace(/^[,;:.!?-]+/, '').trim();
    cleaned = cleaned.replace(/[.]+$/, '').trim();

    if (!cleaned) return null;
    if (WEAK_EXPLICIT_TASK_PATTERNS.some((pattern) => pattern.test(cleaned))) return null;

    if (
        /\bproject\b/i.test(cleaned)
        && !/^(review|reviewing|audit|auditing|debug|debugging|fix|fixing|build|building|ship|shipping|release|releasing|investigate|investigating|document|documenting|work|working|implement|implementing|test|testing|verify|verifying|research|researching|prepare|preparing|maintain|maintaining|improve|improving)\b/i.test(cleaned)
        && !/\b(review|audit|debug|fix|build|ship|release|investigate|investigating|investigation|document|work|working|implement|implementation|implementing|test|testing|verify|verification|verifying|research|researching|prepare|maintain|improve|improving|improvement)\b/i.test(cleaned)
    ) {
        return `working on ${cleaned}`;
    }

    return cleaned;
}

export function formatOperatingRulesText(
    rawValue: unknown,
    summary?: string | null,
    fallbackRules: string[] = DEFAULT_ATTENDANT_OPERATING_RULES
): string {
    const candidateRules = rawValue
        && typeof rawValue === 'object'
        && Array.isArray((rawValue as { rules?: unknown }).rules)
        ? (rawValue as { rules: unknown[] }).rules
        : [];

    const normalizedRules = candidateRules
        .map((rule) => (typeof rule === 'string' ? rule.trim() : ''))
        .filter(Boolean);

    // If stored rules exist, they are the authoritative source — do not merge defaults.
    // The full protocol now lives in IRANTI.md; stored rules carry the compressed version.
    // Defaults are only used as a fallback when no rules are stored in the Staff Namespace.
    const resolvedRules = normalizedRules.length > 0
        ? normalizedRules
        : [...fallbackRules];

    if (resolvedRules.length === 0) {
        return summary?.trim() || 'No operating rules found.';
    }

    return [
        summary?.trim() || 'Attendant operating rules:',
        '',
        ...resolvedRules.map((rule) => `- ${rule}`),
    ].join('\n');
}

type BackfillCandidate = {
    key: string;
    summary: string;
};

function summarizeLedgerLearning(entry: SessionLedgerLearning): string {
    return `Recent ledger learning: ${entry.summary}`;
}

function toLedgerWorkingMemoryEntries(entries: SessionLedgerLearning[]): WorkingMemoryEntry[] {
    return entries.map((entry, index) => ({
        entityKey: `system/session_ledger/recent_learning_${index + 1}`,
        summary: summarizeLedgerLearning(entry),
        confidence: 100,
        source: 'session_ledger',
        lastUpdated: entry.timestamp,
    }));
}

function mergeWorkingMemoryWithLedger(entries: WorkingMemoryEntry[], learnings: SessionLedgerLearning[]): WorkingMemoryEntry[] {
    const retained = entries.filter((entry) => !entry.entityKey.startsWith(LEDGER_WORKING_MEMORY_PREFIX));
    return learnings.length > 0
        ? [...retained, ...toLedgerWorkingMemoryEntries(learnings)]
        : retained;
}

function normalizeProjectPolicyRuleLines(value: unknown, fallbackSummary: string | null | undefined): string[] {
    const rules: string[] = [];
    if (typeof value === 'string' && value.trim()) {
        rules.push(value.trim());
    } else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (typeof record.rule === 'string' && record.rule.trim()) {
            rules.push(record.rule.trim());
        }
        if (typeof record.text === 'string' && record.text.trim()) {
            rules.push(record.text.trim());
        }
        if (typeof record.instruction === 'string' && record.instruction.trim()) {
            rules.push(record.instruction.trim());
        }
        if (Array.isArray(record.rules)) {
            for (const rule of record.rules) {
                if (typeof rule === 'string' && rule.trim()) {
                    rules.push(rule.trim());
                }
            }
        }
        if (Array.isArray(record.preferences)) {
            for (const preference of record.preferences) {
                if (typeof preference === 'string' && preference.trim()) {
                    rules.push(preference.trim());
                }
            }
        }
    }

    if (rules.length === 0 && fallbackSummary?.trim()) {
        rules.push(fallbackSummary.trim());
    }

    return Array.from(new Set(rules.map((rule) => rule.trim()).filter(Boolean)));
}

function isProjectPolicyKey(key: string): boolean {
    return /(?:^agent_(?:operating_)?(?:rule|rules|preference|preferences)$|(?:_rule|_rules|_preference|_preferences)$)/i.test(key.trim());
}

function isProjectPolicyEntry(entry: {
    key: string;
    properties?: Record<string, unknown> | null;
}): boolean {
    if (isProjectPolicyKey(entry.key)) return true;
    const durableClass = typeof entry.properties?.durableClass === 'string'
        ? entry.properties.durableClass.trim().toLowerCase()
        : '';
    const semanticIntent = typeof entry.properties?.semanticIntent === 'string'
        ? entry.properties.semanticIntent.trim().toLowerCase()
        : '';
    return durableClass === 'preference' || semanticIntent === 'preference_capture';
}

function toProjectPolicyWorkingMemoryEntries(entries: ProjectPolicyEntry[]): WorkingMemoryEntry[] {
    return entries.map((entry) => ({
        entityKey: entry.entityKey,
        summary: `Project policy: ${entry.summary}`,
        confidence: 100,
        source: entry.source,
        lastUpdated: entry.lastUpdated,
    }));
}

function mergeWorkingMemoryWithProjectPolicies(entries: WorkingMemoryEntry[], policies: ProjectPolicyEntry[]): WorkingMemoryEntry[] {
    const retained = entries.filter((entry) => !policies.some((policy) => policy.entityKey === entry.entityKey));
    return policies.length > 0
        ? [...toProjectPolicyWorkingMemoryEntries(policies), ...retained]
        : retained;
}

function applyProjectPolicyOperatingRules(
    operatingRules: string,
    projectPolicies: ProjectPolicyEntry[],
): string {
    let nextRules = operatingRules;
    for (const policy of projectPolicies) {
        for (const rule of policy.rules) {
            const renderedRule = `PROJECT POLICY (${policy.key}): ${rule}`;
            if (!nextRules.includes(renderedRule)) {
                nextRules = `${nextRules}\n- ${renderedRule}`;
            }
        }
    }
    return nextRules;
}

function formatMissingWriteCategories(categories: string[]): string {
    const labelMap: Record<string, string> = {
        findings: 'what you found',
        validated_results: 'what worked',
        failed_paths: 'what failed',
        file_changes: 'what changed',
        risks_and_next_steps: 'what remains risky and what happens next',
    };
    const labels = Array.from(new Set(categories.map((category) => labelMap[category] ?? category)));
    if (labels.length === 0) return 'what you found and what happens next';
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

function applyAdvisoryOperatingRules(
    operatingRules: string,
    profile: SessionLedgerLearningProfile | null,
): string {
    const reminder = profile?.checkpointReminder?.trim();
    const categories = profile?.missingWriteCategories ?? [];
    let nextRules = operatingRules;
    if (reminder && !nextRules.includes(reminder)) {
        nextRules = `${nextRules}\n- ${reminder}`;
    }
    if (categories.length > 0) {
        const categoryRule = `Compliance follow-up: before the next pause, persist ${formatMissingWriteCategories(categories)} as structured durable memory when applicable, not just a broad summary.`;
        if (!nextRules.includes(categoryRule)) {
            nextRules = `${nextRules}\n- ${categoryRule}`;
        }
    }
    return nextRules;
}

// ─── User Operating Rules ───────────────────────────────────────────────────

export interface MatchedUserRule {
    entityKey: string;
    key: string;
    rule: string;
    triggers: string[];
    scope: string;
    enforcement: 'soft' | 'hard';
    source: string;
    lastUpdated: string;
}

export function extractRuleTriggers(properties: Record<string, unknown> | null | undefined): string[] {
    if (!properties) return [];
    const triggers = properties.triggers;
    if (Array.isArray(triggers)) {
        return triggers
            .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
            .map((t) => t.trim().toLowerCase());
    }
    return [];
}

export function matchesRuleTriggers(triggers: string[], contextTokens: Set<string>, contextLower: string): boolean {
    if (triggers.length === 0) return false;
    return triggers.some((trigger) => {
        // Multi-word triggers: check phrase match
        if (trigger.includes(' ')) return contextLower.includes(trigger);
        // Single-word triggers: check token membership
        return contextTokens.has(trigger);
    });
}

function parseUserOperatingRule(entry: {
    entityType: string;
    entityId: string;
    key: string;
    valueSummary: string;
    valueRaw: unknown;
    source: string;
    properties: Record<string, unknown> | null;
    updatedAt: Date;
}): MatchedUserRule | null {
    const triggers = extractRuleTriggers(entry.properties);
    if (triggers.length === 0) return null;

    const raw = entry.valueRaw as Record<string, unknown> | null;
    const ruleText = entry.valueSummary?.trim()
        || (typeof raw?.rule === 'string' ? raw.rule.trim() : '');
    if (!ruleText) return null;

    const enforcement = entry.properties?.enforcement === 'hard' ? 'hard' as const : 'soft' as const;
    const scope = typeof entry.properties?.scope === 'string' ? entry.properties.scope : 'project';

    return {
        entityKey: `${entry.entityType}/${entry.entityId}`,
        key: entry.key,
        rule: ruleText,
        triggers,
        scope: String(scope),
        enforcement,
        source: entry.source,
        lastUpdated: entry.updatedAt.toISOString(),
    };
}

export function formatMatchedUserRules(rules: MatchedUserRule[]): string {
    if (rules.length === 0) return '';
    return rules.map((r) => {
        const prefix = r.enforcement === 'hard' ? 'REQUIRED RULE' : 'USER RULE';
        return `- ${prefix} (${r.key}): ${r.rule}`;
    }).join('\n');
}

// ─── File-Path Entity Hints ─────────────────────────────────────────────────

const FILE_PATH_PATTERN = /(?:^|[\s"'`(])([a-zA-Z]:\\(?:[^\s"'`<>|*?]+\\)*[^\s"'`<>|*?]+\.\w+|(?:\.\/|\.\.\/|\/)?(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.\w+)/g;

export function extractFilePathEntityHints(text: string, projectEntity: string | null): string[] {
    if (!text || !projectEntity) return [];
    const parsed = parseEntityString(projectEntity);
    const projectId = parsed.entityId;
    const seen = new Set<string>();
    const hints: string[] = [];

    let match: RegExpExecArray | null;
    FILE_PATH_PATTERN.lastIndex = 0;
    while ((match = FILE_PATH_PATTERN.exec(text)) !== null) {
        const filePath = match[1].trim();
        // Extract just the filename without extension
        const basename = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
        const nameWithoutExt = basename.replace(/\.\w+$/, '').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        if (!nameWithoutExt || nameWithoutExt.length < 2) continue;

        const entityHint = `project/${projectId}/file/${nameWithoutExt}`;
        if (!seen.has(entityHint)) {
            seen.add(entityHint);
            hints.push(entityHint);
        }
    }
    return hints;
}

function advisoryTaskTokens(taskType: string | null | undefined): string[] {
    if (!taskType) return [];
    return Array.from(new Set(
        taskType
            .toLowerCase()
            .split(/[^a-z0-9_]+/)
            .map((token) => token.trim())
            .filter((token) => token.length >= 4)
    ));
}

function buildUsageGuidance(tool: 'observe' | 'attend', turnsWithoutWrite: number = 0): ObserveResult['usageGuidance'] {
    const hasComplianceIssue = turnsWithoutWrite >= 2;

    if (!hasComplianceIssue) {
        return {
            tool,
            reminder: ATTEND_USAGE_REMINDER + ' Reminder: if the previous turn produced durable findings, call iranti_write before continuing.',
            // expectedCallSequence omitted — protocol lives in IRANTI.md, not repeated per-call.
            note: '',
        };
    }

    let reminder = ATTEND_USAGE_REMINDER;
    if (turnsWithoutWrite >= 3) {
        reminder += ` NON-COMPLIANT: ${turnsWithoutWrite} turns have completed without a single iranti_write call. You are losing knowledge. Call iranti_write NOW for any findings, file changes, or decisions from recent turns.`;
    } else {
        reminder += ` WARNING: ${turnsWithoutWrite} turns without an iranti_write call. If you discovered, changed, or confirmed anything, write it now before it is lost.`;
    }
    return {
        tool,
        reminder,
        // expectedCallSequence omitted — protocol lives in IRANTI.md, not repeated per-call.
        note: tool === 'observe'
            ? OBSERVE_USAGE_NOTE
            : 'After using attend() and any retrieved facts, persist durable learnings with iranti_write and shared progress with iranti_checkpoint when applicable.',
    };
}

function messageHasAdvisoryCue(message: string, taskType: string | null | undefined): boolean {
    const normalized = normalizeMessage(message);
    if (!normalized) return false;
    if (/\b(next|status|blocker|owner|risk|issue|bug|weakness|problem|continue|resume|pickup|tackle|ship|release)\b/i.test(normalized)) {
        return true;
    }
    const messageTokens = new Set(advisoryTaskTokens(normalized));
    return advisoryTaskTokens(taskType).some((token) => messageTokens.has(token));
}

function collectBackfillCandidates(messages: string[]): BackfillCandidate[] {
    const deduped = new Map<string, BackfillCandidate>();

    for (const message of messages) {
        const trimmed = message.trim();
        if (!trimmed) continue;
        const facts = [
            ...extractExplicitPromptMemory(trimmed),
            ...extractExplicitAssistantMemory(trimmed),
        ];
        for (const fact of facts) {
            if (!deduped.has(fact.key)) {
                deduped.set(fact.key, {
                    key: fact.key,
                    summary: fact.summary,
                });
            }
        }
    }

    return Array.from(deduped.values());
}

function buildBackfillSuggestion(
    context: AgentContext,
    workingMemory: WorkingMemoryEntry[],
): BackfillSuggestion | null {
    const recentMessages = (context.recentMessages ?? [])
        .map((message) => message.trim())
        .filter(Boolean);
    if (recentMessages.length === 0) return null;

    const candidates = collectBackfillCandidates(recentMessages);
    if (candidates.length === 0) return null;

    const knownKeys = new Set(
        workingMemory.map((entry) => entry.entityKey.split('/').slice(2).join('/'))
    );
    const missingCandidates = candidates.filter((candidate) => !knownKeys.has(candidate.key));
    if (missingCandidates.length === 0) return null;

    return {
        suggested: true,
        reason: 'recent_messages_contain_durable_facts_not_yet_persisted',
        candidateFacts: missingCandidates.length,
        sampleKeys: missingCandidates.slice(0, 5).map((candidate) => candidate.key),
        suggestedCommand: 'iranti handshake --backfill <chat-file>',
    };
}

function buildAttendBootstrapTask(latestMessage: string, currentContext: string): string {
    const latest = normalizeMessage(latestMessage);
    if (latest) {
        const explicitLatestTask = normalizeExplicitTask(latest);
        if (explicitLatestTask) {
            return explicitLatestTask;
        }
    }

    const trimmedContext = currentContext.trim();
    if (trimmedContext) {
        const explicitContextTask = normalizeExplicitTask(trimmedContext);
        if (explicitContextTask) {
            return explicitContextTask;
        }
    }

    const basis = latest || trimmedContext;
    if (!basis) {
        return 'bootstrap initial turn memory context';
    }

    const normalized = basis.replace(/\s+/g, ' ').trim();
    const truncated = normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
    return `responding to ${truncated}`;
}

function buildAttendBootstrapMessages(latestMessage: string, currentContext: string): string[] {
    const out: string[] = [];
    const trimmedContext = currentContext.trim();
    if (trimmedContext) {
        out.push(trimmedContext);
    }
    const normalizedLatest = normalizeMessage(latestMessage);
    if (normalizedLatest && !out.includes(normalizedLatest)) {
        out.push(normalizedLatest);
    }
    return out.slice(-6);
}

function tokenizePresenceText(value: string): string[] {
    return value
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 4);
}

function countPresenceMatches(contextLower: string, tokens: string[]): number {
    return tokens.filter((token) => contextLower.includes(token)).length;
}

function factAlreadyPresentInContext(contextLower: string, fact: RetrievedFact): boolean {
    const summaryLower = fact.summary.toLowerCase().trim();
    if (summaryLower.length >= 24 && contextLower.includes(summaryLower)) {
        return true;
    }

    const [entityType = '', entityId = '', key = ''] = fact.entityKey.split('/');
    const entityTokens = new Set([
        ...tokenizePresenceText(entityType),
        ...tokenizePresenceText(entityId),
        ...tokenizePresenceText(key),
    ]);

    const summaryTokens = tokenizePresenceText(fact.summary);
    const meaningfulTokens = summaryTokens.filter((token) => !entityTokens.has(token));
    const tokensToCheck = meaningfulTokens.length > 0 ? meaningfulTokens : summaryTokens;

    if (tokensToCheck.length === 0) {
        return false;
    }

    const matches = countPresenceMatches(contextLower, tokensToCheck);
    return matches >= Math.ceil(tokensToCheck.length * 0.6);
}

function normalizeWatchedEntities(values: string[] | undefined): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const value of values ?? []) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (!trimmed || !trimmed.includes('/') || seen.has(trimmed)) continue;
        seen.add(trimmed);
        normalized.push(trimmed);
        if (normalized.length >= 8) break;
    }
    return normalized;
}

function shouldUseWatchedEntitiesForPrompt(latestMessage: string): boolean {
    const normalized = normalizeMessage(latestMessage);
    if (!normalized) return false;
    if (WATCHED_ENTITY_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized))) {
        return true;
    }
    return classifyMemoryScope(normalized) === 'project';
}

function inferContextWatchedEntities(task: string, recentMessages: string[]): string[] {
    const exact = normalizeWatchedEntities([
        ...extractExactEntityReferences(task),
        ...recentMessages.flatMap((message) => extractExactEntityReferences(message)),
    ]);
    if (exact.length > 0) {
        return exact;
    }

    const combined = [task, ...recentMessages]
        .map((message) => normalizeMessage(message))
        .filter(Boolean)
        .join('\n');
    const scope = classifyMemoryScope(combined);
    if (scope === 'personal') {
        return getPersonalRecallEntities();
    }
    if (scope === 'project') {
        const configured = getProjectMemoryEntity();
        if (configured) {
            return [configured];
        }
    }
    return [];
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
        actionCount: Array.isArray(checkpoint.checkpoint.actions) ? checkpoint.checkpoint.actions.length : 0,
    };
}

function buildSessionComplianceState(input: {
    attendsWithoutPersist: number;
    turnsWithoutWrite: number;
    midTurnAttendsThisTurn: number;
    consecutivePreResponseWithoutPost: number;
    consecutiveUnusedMemoryInjections: number;
    lastAttendPhase?: 'pre-response' | 'post-response' | 'mid-turn';
    lastUpdated?: string;
}): SessionComplianceState {
    const pendingPostResponse = input.lastAttendPhase === 'pre-response';
    const issues: SessionComplianceIssue[] = [];

    if (input.consecutivePreResponseWithoutPost > 0) {
        issues.push({
            code: 'missing_post_response_attend',
            severity: 'error',
            count: input.consecutivePreResponseWithoutPost,
            message: 'The previous turn has not been closed with iranti_attend(phase=\'post-response\').',
            requiredAction: 'Call iranti_attend(phase=\'post-response\') to close the prior turn, then persist any durable findings before the next pre-response attend.',
        });
    }

    if (input.attendsWithoutPersist >= PERSISTENCE_WARNING_THRESHOLD) {
        const severity = input.attendsWithoutPersist >= PERSISTENCE_NON_COMPLIANT_THRESHOLD ? 'error' : 'warn';
        issues.push({
            code: 'missing_durable_persistence',
            severity,
            count: input.attendsWithoutPersist,
            message: `There have been ${input.attendsWithoutPersist} attend calls since the last iranti_write or iranti_checkpoint.`,
            requiredAction: 'Persist durable findings with iranti_write or iranti_checkpoint before the next turn if new knowledge, validation, or file changes occurred.',
        });
    }

    if (input.turnsWithoutWrite >= 2) {
        const severity = input.turnsWithoutWrite >= 3 ? 'error' : 'warn';
        issues.push({
            code: 'missing_writes_across_turns',
            severity,
            count: input.turnsWithoutWrite,
            message: `${input.turnsWithoutWrite} active turns with tool use completed without iranti_write or iranti_checkpoint calls. Findings from these turns are not being persisted.`,
            requiredAction: 'Call iranti_write for each durable finding — file edits, confirmed facts, environment state, subagent results. Every turn that discovers something should write it.',
        });
    }

    if (input.consecutiveUnusedMemoryInjections > 0) {
        const severity = input.consecutiveUnusedMemoryInjections >= 2 ? 'error' : 'warn';
        issues.push({
            code: 'ignored_injected_memory',
            severity,
            count: input.consecutiveUnusedMemoryInjections,
            message: input.consecutiveUnusedMemoryInjections >= 2
                ? `Injected memory has been surfaced and then ignored across ${input.consecutiveUnusedMemoryInjections} consecutive turns.`
                : 'Injected memory was surfaced but the response did not use it in the previous turn.',
            requiredAction: 'On the next turn, either answer from the injected facts directly or persist why the injected memory was insufficient before rediscovering the same state manually.',
        });
    }

    let status: SessionComplianceStatus = 'healthy';
    if (issues.some((issue) => issue.severity === 'error')) {
        status = 'non_compliant';
    } else if (issues.length > 0) {
        status = 'degraded';
    }

    const summary = status === 'healthy'
        ? pendingPostResponse
            ? 'Lifecycle is currently in progress and waiting for a post-response attend.'
            : 'Lifecycle is currently compliant.'
        : status === 'degraded'
            ? input.consecutiveUnusedMemoryInjections > 0
                ? 'Lifecycle is degraded: injected memory was surfaced but not used.'
                : 'Lifecycle is degraded: iranti_write has not been called after recent knowledge-changing actions.'
            : input.consecutivePreResponseWithoutPost > 0
                ? 'Lifecycle is non-compliant: the previous turn is still missing a post-response attend.'
                : input.consecutiveUnusedMemoryInjections > 0
                    ? 'Lifecycle is non-compliant: injected memory is being ignored instead of used or explicitly challenged.'
                    : 'Lifecycle is non-compliant: iranti_write calls are missing — durable findings are not being persisted.';

    return {
        status,
        summary,
        issues,
        lastUpdated: input.lastUpdated ?? new Date().toISOString(),
        counters: {
            attendsWithoutPersist: input.attendsWithoutPersist,
            turnsWithoutWrite: input.turnsWithoutWrite,
            midTurnAttendsThisTurn: input.midTurnAttendsThisTurn,
            consecutivePreResponseWithoutPost: input.consecutivePreResponseWithoutPost,
            consecutiveUnusedMemoryInjections: input.consecutiveUnusedMemoryInjections,
            pendingPostResponse,
            lastAttendPhase: input.lastAttendPhase ?? null,
        },
    };
}

export function summarizeSessionState(
    agentId: string,
    checkpoint: SessionCheckpointRecord | null,
    persistedBriefGeneratedAt?: string,
    compliance: SessionComplianceState | null = null,
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
        compliance,
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

function extractExactEntityReferences(text: string): string[] {
    const matches = text.match(/\b[a-z][a-z0-9_-]*\/[a-z0-9_][a-z0-9_/-]*\b/gi) ?? [];
    const deduped: string[] = [];
    const seen = new Set<string>();

    for (const rawMatch of matches) {
        const candidate = rawMatch.trim().replace(/[.,!?;:]+$/g, '');
        try {
            const parsed = parseEntityString(candidate);
            const normalized = `${parsed.entityType}/${parsed.entityId}`;
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            deduped.push(normalized);
        } catch {
            continue;
        }
    }

    return deduped;
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

function tokenizeForSearch(text: string | undefined): string[] {
    return tokenize(text).filter((token) => !SEARCH_SUGGESTION_STOPWORDS.has(token));
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

function normalizeCheckpointFileChanges(value: unknown, maxItems: number = 25): Array<{
    action: string;
    path: string;
    toPath?: string;
    purpose?: string;
}> {
    if (!Array.isArray(value)) return [];

    const out: Array<{ action: string; path: string; toPath?: string; purpose?: string }> = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const path = typeof record.path === 'string' ? truncate(record.path.trim(), 240) : '';
        if (!path) continue;
        const action = typeof record.action === 'string' && record.action.trim()
            ? truncate(record.action.trim().toLowerCase(), 40)
            : 'updated';
        const next: { action: string; path: string; toPath?: string; purpose?: string } = { action, path };
        if (typeof record.toPath === 'string' && record.toPath.trim()) {
            next.toPath = truncate(record.toPath.trim(), 240);
        }
        if (typeof record.purpose === 'string' && record.purpose.trim()) {
            next.purpose = truncate(record.purpose.trim(), 180);
        }
        out.push(next);
        if (out.length >= maxItems) break;
    }

    return out;
}

function normalizeCheckpointActions(value: unknown, maxItems: number = 25): Array<{
    kind: string;
    summary: string;
    status?: string;
    target?: string;
    detail?: string;
}> {
    if (!Array.isArray(value)) return [];

    const out: Array<{ kind: string; summary: string; status?: string; target?: string; detail?: string }> = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const summary = typeof record.summary === 'string' ? truncate(record.summary.trim(), 220) : '';
        if (!summary) continue;
        const kind = typeof record.kind === 'string' && record.kind.trim()
            ? truncate(record.kind.trim().toLowerCase(), 40)
            : 'action';
        const next: { kind: string; summary: string; status?: string; target?: string; detail?: string } = { kind, summary };
        if (typeof record.status === 'string' && record.status.trim()) {
            next.status = truncate(record.status.trim().toLowerCase(), 40);
        }
        if (typeof record.target === 'string' && record.target.trim()) {
            next.target = truncate(record.target.trim(), 240);
        }
        if (typeof record.detail === 'string' && record.detail.trim()) {
            next.detail = truncate(record.detail.trim(), 220);
        }
        out.push(next);
        if (out.length >= maxItems) break;
    }

    return out;
}

function readCheckpointFileChanges(value: unknown): Array<Record<string, unknown>> {
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    const items = Array.isArray(record.items) ? record.items : [];
    return items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
}

function mergeCheckpointFileChanges(existing: unknown, incoming: Array<Record<string, unknown>>): { items: Array<Record<string, unknown>> } {
    const seen = new Set<string>();
    const merged: Array<Record<string, unknown>> = [];
    for (const item of [...readCheckpointFileChanges(existing), ...incoming]) {
        const identity = JSON.stringify(item);
        if (seen.has(identity)) continue;
        seen.add(identity);
        merged.push(item);
    }
    return { items: merged };
}

function readCheckpointActions(value: unknown): Array<Record<string, unknown>> {
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    const items = Array.isArray(record.items) ? record.items : [];
    return items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
}

function mergeCheckpointActions(existing: unknown, incoming: Array<Record<string, unknown>>): { items: Array<Record<string, unknown>> } {
    const seen = new Set<string>();
    const merged: Array<Record<string, unknown>> = [];
    for (const item of [...readCheckpointActions(existing), ...incoming]) {
        const identity = JSON.stringify(item);
        if (seen.has(identity)) continue;
        seen.add(identity);
        merged.push(item);
    }
    return { items: merged };
}

function summarizeCheckpointFileChanges(value: { items: Array<Record<string, unknown>> }): string {
    const parts = value.items.map((item) => {
        const action = String(item.action ?? 'updated').trim();
        const path = String(item.path ?? '').trim();
        const toPath = String(item.toPath ?? '').trim();
        const purpose = String(item.purpose ?? '').trim();
        if (!path) return '';
        if (toPath) {
            return `${action} ${path} to ${toPath}${purpose ? ` (${purpose})` : ''}`;
        }
        return `${action} ${path}${purpose ? ` (${purpose})` : ''}`;
    }).filter(Boolean);
    return truncate(
        parts.length > 0
            ? `recent file changes include ${parts.join('; ')}`
            : 'recent file changes were logged.',
        220,
    );
}

function summarizeCheckpointActions(value: { items: Array<Record<string, unknown>> }): string {
    const parts = value.items.map((item) => {
        const kind = String(item.kind ?? 'action').trim();
        const summary = String(item.summary ?? '').trim();
        const status = String(item.status ?? '').trim();
        const target = String(item.target ?? '').trim();
        if (!summary) return '';
        const prefix = status ? `[${status}] ` : '';
        const suffix = target ? ` (${target})` : '';
        return `${prefix}${kind}: ${summary}${suffix}`;
    }).filter(Boolean);
    return truncate(
        parts.length > 0
            ? `recent actions include ${parts.join('; ')}`
            : 'recent actions were logged.',
        220,
    );
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

    const actions = normalizeCheckpointActions(raw.actions);
    if (actions.length > 0) {
        normalized.actions = actions;
    }

    const fileChanges = normalizeCheckpointFileChanges(raw.fileChanges);
    if (fileChanges.length > 0) {
        normalized.fileChanges = fileChanges;
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

type CheckpointAvailabilityKey = {
    entityType: string;
    entityId: string;
    key: string;
};

async function persistSharedCheckpointBreadcrumbs(params: {
    agentId: string;
    sessionId: string;
    checkpoint: SessionCheckpointPayload;
}): Promise<CheckpointAvailabilityKey[]> {
    const { agentId, sessionId, checkpoint } = params;
    const targets = Array.isArray(checkpoint.entityTargets) ? checkpoint.entityTargets : [];
    if (targets.length === 0) return [];
    const expectedKeys: CheckpointAvailabilityKey[] = [];

    const checkpointSummary = {
        currentStep: checkpoint.currentStep ?? null,
        nextStep: checkpoint.nextStep ?? null,
        openRisks: checkpoint.openRisks ?? [],
        recentOutputs: checkpoint.recentOutputs ?? [],
        actions: checkpoint.actions ?? [],
        fileChanges: checkpoint.fileChanges ?? [],
        notes: checkpoint.notes ?? null,
        sessionId,
    };

    for (const target of targets) {
        const parsed = parseEntityString(target);
        const resolved = await resolveEntity({
            entityType: parsed.entityType,
            entityId: parsed.entityId,
            rawName: target,
            aliases: [target],
            source: 'AttendantCheckpoint',
            confidence: 95,
            createIfMissing: true,
        });

        const common = {
            entityType: resolved.entityType,
            entityId: resolved.entityId,
            confidence: 95,
            source: 'AttendantCheckpoint',
            createdBy: agentId,
        };
        const checkpointBaseProperties = {
            memoryScope: 'project',
            capturePhase: 'checkpoint',
            sessionId,
        } as const;

        await librarianWrite({
            ...common,
            key: 'checkpoint_summary',
            valueRaw: checkpointSummary,
            valueSummary: truncate(
                `checkpoint summary: current step ${checkpoint.currentStep ?? 'n/a'}; next step ${checkpoint.nextStep ?? 'n/a'}`,
                220,
            ),
            properties: {
                ...checkpointBaseProperties,
                durableClass: 'checkpoint_summary',
                canonicalKey: 'checkpoint_summary',
                mergeStrategy: 'replace',
                ...buildSemanticFactTags({
                    memoryScope: 'project',
                    durableClass: 'checkpoint_summary',
                    mergeStrategy: 'replace',
                    extraTags: ['checkpoint', 'breadcrumb'],
                }),
            } as Record<string, unknown>,
        });
        expectedKeys.push({
            entityType: resolved.entityType,
            entityId: resolved.entityId,
            key: 'checkpoint_summary',
        });

        if (checkpoint.currentStep) {
            await librarianWrite({
                ...common,
                key: 'current_step',
                valueRaw: { text: checkpoint.currentStep },
                valueSummary: truncate(`current step is ${checkpoint.currentStep}`, 220),
                properties: {
                    ...checkpointBaseProperties,
                    durableClass: 'current_step',
                    canonicalKey: 'current_step',
                    mergeStrategy: 'replace',
                    ...buildSemanticFactTags({
                        memoryScope: 'project',
                        durableClass: 'current_step',
                        mergeStrategy: 'replace',
                        extraTags: ['checkpoint', 'breadcrumb'],
                    }),
                } as Record<string, unknown>,
            });
            expectedKeys.push({
                entityType: resolved.entityType,
                entityId: resolved.entityId,
                key: 'current_step',
            });
        }

        if (checkpoint.nextStep) {
            // Replace next_step cleanly — no accumulation of prior steps.
            // History is preserved in checkpoint_summary and session history.
            await librarianWrite({
                ...common,
                key: 'next_step',
                valueRaw: { instruction: checkpoint.nextStep },
                valueSummary: truncate(`next step is ${checkpoint.nextStep}`, 220),
                properties: {
                    ...checkpointBaseProperties,
                    durableClass: 'next_step',
                    canonicalKey: 'next_step',
                    mergeStrategy: 'replace',
                    ...buildSemanticFactTags({
                        memoryScope: 'project',
                        durableClass: 'next_step',
                        mergeStrategy: 'replace',
                        extraTags: ['checkpoint', 'breadcrumb'],
                    }),
                } as Record<string, unknown>,
            });
            expectedKeys.push({
                entityType: resolved.entityType,
                entityId: resolved.entityId,
                key: 'next_step',
            });
        }

        if (Array.isArray(checkpoint.fileChanges) && checkpoint.fileChanges.length > 0) {
            const existingFileChanges = await findEntry({
                entityType: resolved.entityType,
                entityId: resolved.entityId,
                key: 'recent_file_changes',
            });
            const mergedFileChanges = mergeCheckpointFileChanges(
                existingFileChanges?.valueRaw,
                checkpoint.fileChanges.map((change) => ({ ...change })),
            );
            await librarianWrite({
                ...common,
                key: 'recent_file_changes',
                valueRaw: mergedFileChanges,
                valueSummary: summarizeCheckpointFileChanges(mergedFileChanges),
                properties: {
                    ...checkpointBaseProperties,
                    durableClass: 'file_change',
                    canonicalKey: 'recent_file_changes',
                    mergeStrategy: 'append_dedupe',
                    ...buildSemanticFactTags({
                        memoryScope: 'project',
                        durableClass: 'file_change',
                        mergeStrategy: 'append_dedupe',
                        extraTags: ['checkpoint'],
                    }),
                } as Record<string, unknown>,
            });
            expectedKeys.push({
                entityType: resolved.entityType,
                entityId: resolved.entityId,
                key: 'recent_file_changes',
            });
        }

        if (Array.isArray(checkpoint.actions) && checkpoint.actions.length > 0) {
            const existingActions = await findEntry({
                entityType: resolved.entityType,
                entityId: resolved.entityId,
                key: 'recent_actions',
            });
            const mergedActions = mergeCheckpointActions(
                existingActions?.valueRaw,
                checkpoint.actions.map((action) => ({ ...action })),
            );
            await librarianWrite({
                ...common,
                key: 'recent_actions',
                valueRaw: mergedActions,
                valueSummary: summarizeCheckpointActions(mergedActions),
                properties: {
                    ...checkpointBaseProperties,
                    durableClass: 'action_log',
                    canonicalKey: 'recent_actions',
                    mergeStrategy: 'append_dedupe',
                    ...buildSemanticFactTags({
                        memoryScope: 'project',
                        durableClass: 'action_log',
                        mergeStrategy: 'append_dedupe',
                        extraTags: ['checkpoint'],
                    }),
                } as Record<string, unknown>,
            });
            expectedKeys.push({
                entityType: resolved.entityType,
                entityId: resolved.entityId,
                key: 'recent_actions',
            });
        }

        if (checkpoint.openRisks && checkpoint.openRisks.length > 0) {
            await librarianWrite({
                ...common,
                key: 'open_risks',
                valueRaw: { items: checkpoint.openRisks },
                valueSummary: truncate(`open risks include ${checkpoint.openRisks.join('; ')}`, 220),
                properties: {
                    ...checkpointBaseProperties,
                    durableClass: 'open_risks',
                    canonicalKey: 'open_risks',
                    mergeStrategy: 'replace',
                    ...buildSemanticFactTags({
                        memoryScope: 'project',
                        durableClass: 'open_risks',
                        mergeStrategy: 'replace',
                        extraTags: ['checkpoint', 'breadcrumb'],
                    }),
                } as Record<string, unknown>,
            });
            expectedKeys.push({
                entityType: resolved.entityType,
                entityId: resolved.entityId,
                key: 'open_risks',
            });
        }
    }

    return expectedKeys;
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

    // Any substantive message in a project-bound context likely benefits from memory.
    // Greetings and acks are already caught by MEMORY_NEED_NEGATIVE_PATTERNS above.
    if (normalized.length > 20) {
        return {
            needed: true,
            confidence: 0.75,
            explanation: 'substantive_project_prompt',
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
    private advisoryLearningProfile: SessionLedgerLearningProfile | null = null;
    private contextCallCount: number = 0;
    private attendsWithoutPersist: number = 0;
    private turnsWithoutWrite: number = 0;
    private midTurnAttendsThisTurn: number = 0;
    private writeOccurredThisTurn: boolean = false;
    private consecutivePreResponseWithoutPost: number = 0;
    private consecutiveUnusedMemoryInjections: number = 0;
    private lastAttendPhase: 'pre-response' | 'post-response' | 'mid-turn' | undefined = undefined;
    private complianceUpdatedAt: string = new Date().toISOString();
    private sessionStarted: string = new Date().toISOString();
    private sessionCheckpoint: SessionCheckpointRecord | null = null;
    private eventSource: string = 'internal';
    private eventHost: string | null = null;
    private sharedStateObservedAt: string | null = null;
    private pendingSharedStateInvalidations = new Map<string, Set<string>>();
    private pendingMemoryAttributions: MemoryAttributionResult[] = [];
    private rulesDelivered = false;
    private postCompactionPending = false;

    constructor(agentId: string) {
        this.agentId = agentId;
        registerSharedStateInvalidationObserver(agentId, this);
    }

    setLedgerContext(context?: AgentContext['ledgerContext']): void {
        if (context?.source?.trim()) {
            this.eventSource = context.source.trim();
        }
        if (typeof context?.host === 'string') {
            const trimmed = context.host.trim();
            this.eventHost = trimmed || null;
        } else if (context?.host === null) {
            this.eventHost = null;
        }
    }

    private buildEventMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
        const withSession =
            Object.prototype.hasOwnProperty.call(metadata, 'sessionId')
                ? metadata
                : { ...metadata, sessionId: this.sessionStarted };
        return {
            ...withSession,
            ...(this.eventHost ? { host: this.eventHost } : {}),
        };
    }

    private updateBriefPendingMemoryAttributions(): void {
        if (!this.brief) return;
        this.brief = {
            ...this.brief,
            pendingMemoryAttributions: this.pendingMemoryAttributions.map((entry) => ({ ...entry })),
        };
    }

    private addPendingMemoryAttribution(input: {
        phase: 'pre-response' | 'mid-turn';
        injectedKeys: string[];
        injectedEntryIds: number[];
        injectedSummaries?: string[];
    }): MemoryAttributionResult {
        const attribution: MemoryAttributionResult = {
            injectionId: randomUUID(),
            surfaced: true,
            used: false,
            helpful: false,
            status: 'pending',
            phase: input.phase,
            surfacedAt: new Date().toISOString(),
            reason: 'awaiting_post_response_evaluation',
            injectedKeys: [...input.injectedKeys],
            injectedEntryIds: [...input.injectedEntryIds],
            injectedSummaries: input.injectedSummaries ? [...input.injectedSummaries] : undefined,
            evidenceKinds: [],
        };
        this.pendingMemoryAttributions.push(attribution);
        this.updateBriefPendingMemoryAttributions();
        return attribution;
    }

    private recordMemoryEvidence(kind: MemoryAttributionEvidenceKind): void {
        if (this.pendingMemoryAttributions.length === 0) {
            return;
        }

        for (const attribution of this.pendingMemoryAttributions) {
            if (attribution.status !== 'pending') continue;
            if (!attribution.evidenceKinds.includes(kind)) {
                attribution.evidenceKinds = [...attribution.evidenceKinds, kind];
            }
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'memory_evidence_observed',
                agentId: this.agentId,
                source: this.eventSource,
                reason: kind,
                level: 'audit',
                metadata: this.buildEventMetadata({
                    injectionId: attribution.injectionId,
                    injectedKeys: attribution.injectedKeys,
                    injectedEntryIds: attribution.injectedEntryIds,
                    evidenceKind: kind,
                }),
            });
        }
        this.updateBriefPendingMemoryAttributions();
    }

    private responseMentionsInjectedMemory(response: string, attribution: MemoryAttributionResult): boolean {
        const responseTokens = new Set(tokenize(response));
        if (responseTokens.size === 0) return false;

        for (const entityKey of attribution.injectedKeys) {
            const key = entityKey.split('/').slice(2).join('/');
            for (const token of tokenize(key.replace(/[_/.-]+/g, ' '))) {
                if (responseTokens.has(token)) {
                    return true;
                }
            }
        }

        // Secondary: require ≥2 content tokens (>5 chars) from summaries to match,
        // avoiding single-word false positives from common short terms.
        if (attribution.injectedSummaries && attribution.injectedSummaries.length > 0) {
            const contentTokens = attribution.injectedSummaries
                .flatMap((s) => tokenize(s).filter((t) => t.length > 5));
            let contentMatches = 0;
            for (const token of contentTokens) {
                if (responseTokens.has(token)) {
                    contentMatches++;
                    if (contentMatches >= 2) return true;
                }
            }
        }

        return false;
    }

    private responseShowsRecoveryValue(response: string, attribution: MemoryAttributionResult): boolean {
        const normalized = normalizeText(response);
        if (!normalized) return false;
        return attribution.injectedKeys.some((entityKey) => {
            const key = entityKey.split('/').slice(2).join('/');
            return (
                /\b(next step|current step|blocker|blockers|risk|risks|status|progress|file|files|changed|handoff|resume|recovery)\b/.test(normalized)
                && /\b(next_step|current_step|open_risks|status|checkpoint_summary|recent_file_changes|recent_actions|implementation_status|blockers?)\b/i.test(key)
            );
        });
    }

    private scorePendingMemoryAttributions(response: string): MemoryAttributionResult[] {
        if (this.pendingMemoryAttributions.length === 0) {
            return [];
        }

        const scoredAt = new Date().toISOString();
        const scored = this.pendingMemoryAttributions.map((entry) => {
            const evidenceKinds = [...entry.evidenceKinds];
            const rediscoveredManually = evidenceKinds.includes('rediscovery');
            if (!rediscoveredManually && this.responseMentionsInjectedMemory(response, entry) && !evidenceKinds.includes('response_reference')) {
                evidenceKinds.push('response_reference');
            }
            if (!rediscoveredManually && this.responseShowsRecoveryValue(response, entry) && !evidenceKinds.includes('response_recovery')) {
                evidenceKinds.push('response_recovery');
            }
            const used = evidenceKinds.includes('write')
                || evidenceKinds.includes('checkpoint')
                || evidenceKinds.includes('response_reference')
                || evidenceKinds.includes('response_recovery');
            const helpful = evidenceKinds.includes('checkpoint')
                || evidenceKinds.includes('write')
                || evidenceKinds.includes('response_recovery');

            const reason = helpful
                ? 'response_or_action_confirmed_memory_helpfulness'
                : used
                    ? 'response_referenced_injected_memory'
                    : 'memory_was_only_surfaced';

            const scoredEntry: MemoryAttributionResult = {
                ...entry,
                used,
                helpful,
                status: 'scored',
                scoredAt,
                reason,
                evidenceKinds,
            };

            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'memory_injection_scored',
                agentId: this.agentId,
                source: this.eventSource,
                reason,
                level: 'audit',
                metadata: this.buildEventMetadata({
                    injectionId: scoredEntry.injectionId,
                    surfaced: true,
                    used,
                    helpful,
                    phase: scoredEntry.phase,
                    injectedKeys: scoredEntry.injectedKeys,
                    injectedEntryIds: scoredEntry.injectedEntryIds,
                    evidenceKinds,
                    scoredAt,
                }),
            });
            return scoredEntry;
        });

        if (scored.some((entry) => entry.used)) {
            this.consecutiveUnusedMemoryInjections = 0;
        } else if (scored.some((entry) => entry.surfaced)) {
            this.consecutiveUnusedMemoryInjections += 1;
        }

        this.pendingMemoryAttributions = [];
        this.updateBriefPendingMemoryAttributions();
        return scored;
    }

    async noteDiscoveryOccurred(): Promise<void> {
        if (this.pendingMemoryAttributions.length === 0) {
            return;
        }
        this.recordMemoryEvidence('rediscovery');
        await this.persistState();
    }

    private async loadSessionLedgerSignals(taskType: string): Promise<{
        learnings: SessionLedgerLearning[];
        profile: SessionLedgerLearningProfile | null;
    }> {
        try {
            const source = this.eventSource === 'internal' ? undefined : this.eventSource;
            const [learnings, profile] = await Promise.all([
                summarizeSessionLedgerLearnings({
                    agentId: this.agentId,
                    source,
                    host: this.eventHost ?? undefined,
                    limit: 40,
                    maxLearnings: 4,
                }),
                buildSessionLedgerLearningProfile({
                    agentId: this.agentId,
                    source,
                    host: this.eventHost ?? undefined,
                    taskType,
                    limit: 60,
                }),
            ]);
            return { learnings, profile };
        } catch (error) {
            if (error instanceof SessionLedgerUnavailableError) {
                return { learnings: [], profile: null };
            }
            return { learnings: [], profile: null };
        }
    }

    private async loadProjectPolicies(): Promise<ProjectPolicyEntry[]> {
        const configured = getProjectMemoryEntity();
        if (!configured) return [];

        const parsed = parseEntityString(configured);
        const entries = await findEntriesByEntity(parsed.entityType, parsed.entityId);
        const policies = entries
            .filter((entry) => isProjectPolicyEntry({
                key: entry.key,
                properties: (entry.properties as Record<string, unknown> | null) ?? null,
            }))
            .map((entry) => {
                const rules = normalizeProjectPolicyRuleLines(entry.valueRaw, entry.valueSummary);
                if (rules.length === 0) return null;
                return {
                    entityKey: `${entry.entityType}/${entry.entityId}/${entry.key}`,
                    summary: rules.join(' '),
                    key: entry.key,
                    source: entry.source,
                    lastUpdated: entry.updatedAt.toISOString(),
                    rules,
                } satisfies ProjectPolicyEntry;
            })
            .filter((entry): entry is ProjectPolicyEntry => Boolean(entry));

        return policies;
    }

    // ── Handshake ────────────────────────────────────────────────────────────

    async handshake(context: AgentContext): Promise<WorkingMemoryBrief> {
        const t0 = timeStart();
        this.setLedgerContext(context.ledgerContext);
        // Try to resume from persisted state first
        const persisted = await this.loadPersistedState();

        // Reset rulesDelivered flag on post-compaction handshake and queue a recovery
        // injection pass so facts that were in context just before compaction get re-surfaced.
        if (context.postCompaction) {
            this.rulesDelivered = false;
            this.postCompactionPending = true;
        }

        // Load operating rules from Staff Namespace
        const operatingRules = await this.loadOperatingRules();

        // Infer task type
        const inferredTaskType = await this.inferTask(context);

        // Load knowledge — agent entries + related entities
        const [workingMemory, ledgerSignals, projectPolicies] = await Promise.all([
            this.buildWorkingMemory(inferredTaskType),
            this.loadSessionLedgerSignals(inferredTaskType),
            this.loadProjectPolicies(),
        ]);
        const sessionLedgerLearnings = ledgerSignals.learnings;
        this.advisoryLearningProfile = ledgerSignals.profile;
        const workingMemoryWithPolicies = mergeWorkingMemoryWithProjectPolicies(workingMemory, projectPolicies);
        const workingMemoryWithLedger = mergeWorkingMemoryWithLedger(workingMemoryWithPolicies, sessionLedgerLearnings);
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

        const fullOperatingRules = applyAdvisoryOperatingRules(
            applyProjectPolicyOperatingRules(operatingRules, projectPolicies),
            this.advisoryLearningProfile,
        );
        const isFirstDelivery = !this.rulesDelivered;
        const operatingRulesPayload = this.rulesDelivered
            ? '[operating rules previously delivered this session — call handshake with postCompaction:true after context compaction to reload]'
            : fullOperatingRules;
        if (!this.rulesDelivered) {
            this.rulesDelivered = true;
        }

        this.brief = {
            agentId: this.agentId,
            operatingRules: operatingRulesPayload,
            inferredTaskType,
            workingMemory: workingMemoryWithLedger,
            projectPolicies,
            sessionStarted: persisted?.sessionStarted ?? this.sessionStarted,
            briefGeneratedAt: new Date().toISOString(),
            contextCallCount: this.contextCallCount,
            backfillSuggestion: buildBackfillSuggestion(context, workingMemoryWithLedger),
            sessionLedgerLearnings,
            sessionCheckpoint: this.sessionCheckpoint,
            sessionRecovery: isFirstDelivery ? recoveryResult.recovery : null,
            compliance: persisted?.compliance ?? this.buildComplianceState(),
            watchedEntities: normalizeWatchedEntities([
                ...(persisted?.watchedEntities ?? []),
                ...(this.sessionCheckpoint?.checkpoint.entityTargets ?? []),
                ...inferContextWatchedEntities(context.task, context.recentMessages),
            ]),
        };
        this.sharedStateObservedAt = this.brief.briefGeneratedAt;

        await this.persistState();
        getStaffEventEmitter().emit({
            staffComponent: 'Attendant',
            actionType: 'handshake_completed',
            agentId: this.agentId,
            source: this.eventSource,
            reason: 'session_started',
            level: 'audit',
            metadata: this.buildEventMetadata({
                briefSize: this.brief?.workingMemory.length ?? 0,
                ledgerLearningCount: sessionLedgerLearnings.length,
                projectPolicyCount: projectPolicies.length,
                advisoryScopes: this.advisoryLearningProfile?.scopesUsed ?? [],
                taskSummary: context.task.slice(0, 120),
            }),
        });
        timeEnd('attendant.handshake_ms', t0);
        return this.brief;
    }

    // ── Reconvene ────────────────────────────────────────────────────────────

    async reconvene(context: AgentContext): Promise<WorkingMemoryBrief> {
        const t0 = timeStart();
        this.setLedgerContext(context.ledgerContext);
        if (!this.brief) {
            const result = await this.handshake(context);
            timeEnd('attendant.reconvene_ms', t0);
            return result;
        }

        const newTaskType = await this.inferTask(context);
        const [ledgerSignals, projectPolicies] = await Promise.all([
            this.loadSessionLedgerSignals(newTaskType),
            this.loadProjectPolicies(),
        ]);
        this.advisoryLearningProfile = ledgerSignals.profile;

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
                operatingRules: applyAdvisoryOperatingRules(
                    applyProjectPolicyOperatingRules(await this.loadOperatingRules(), projectPolicies),
                    this.advisoryLearningProfile,
                ),
                workingMemory: mergeWorkingMemoryWithLedger(
                    mergeWorkingMemoryWithProjectPolicies(this.brief.workingMemory, projectPolicies),
                    ledgerSignals.learnings,
                ),
                projectPolicies,
                briefGeneratedAt: new Date().toISOString(),
                contextCallCount: this.contextCallCount,
                sessionLedgerLearnings: ledgerSignals.learnings,
                sessionCheckpoint: this.sessionCheckpoint,
                sessionRecovery: null,
                compliance: this.buildComplianceState(),
            };
            this.sharedStateObservedAt = this.brief.briefGeneratedAt;
            await this.persistState();
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'reconvene_completed',
                agentId: this.agentId,
                source: this.eventSource,
                reason: 'Task unchanged - brief timestamp refreshed.',
                level: 'audit',
                metadata: this.buildEventMetadata({
                    briefSize: this.brief?.workingMemory.length ?? 0,
                    contextCallCount: this.contextCallCount,
                    projectPolicyCount: projectPolicies.length,
                    advisoryScopes: this.advisoryLearningProfile?.scopesUsed ?? [],
                }),
            });
            timeEnd('attendant.reconvene_ms', t0);
            return this.brief;
        }

        // Task has shifted — rebuild working memory
        const workingMemory = await this.buildWorkingMemory(newTaskType);
        this.brief = {
            ...this.brief,
            operatingRules: applyAdvisoryOperatingRules(
                applyProjectPolicyOperatingRules(await this.loadOperatingRules(), projectPolicies),
                this.advisoryLearningProfile,
            ),
            inferredTaskType: newTaskType,
            workingMemory: mergeWorkingMemoryWithLedger(
                mergeWorkingMemoryWithProjectPolicies(workingMemory, projectPolicies),
                ledgerSignals.learnings,
            ),
            projectPolicies,
            briefGeneratedAt: new Date().toISOString(),
            contextCallCount: this.contextCallCount,
            sessionLedgerLearnings: ledgerSignals.learnings,
            sessionCheckpoint: this.sessionCheckpoint,
            sessionRecovery: null,
            compliance: this.buildComplianceState(),
        };
        this.sharedStateObservedAt = this.brief.briefGeneratedAt;

        await this.persistState();
        getStaffEventEmitter().emit({
            staffComponent: 'Attendant',
            actionType: 'reconvene_completed',
            agentId: this.agentId,
            source: this.eventSource,
            reason: 'Task shifted - working memory rebuilt.',
            level: 'audit',
            metadata: this.buildEventMetadata({
                briefSize: this.brief?.workingMemory.length ?? 0,
                contextCallCount: this.contextCallCount,
                projectPolicyCount: projectPolicies.length,
                advisoryScopes: this.advisoryLearningProfile?.scopesUsed ?? [],
            }),
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
            ? formatOperatingRulesText(rulesResult.entry.valueRaw, rulesResult.entry.valueSummary)
            : formatOperatingRulesText(null, 'Attendant operating rules:');
        const projectPolicies = this.brief?.projectPolicies ?? await this.loadProjectPolicies();

        if (this.brief) {
            this.brief.operatingRules = applyAdvisoryOperatingRules(
                applyProjectPolicyOperatingRules(operatingRules, projectPolicies),
                this.advisoryLearningProfile,
            );
            this.brief.projectPolicies = projectPolicies;
            this.brief.contextCallCount = 0;
        }

        this.contextCallCount = 0;
        await this.persistState();

        getStaffEventEmitter().emit({
            staffComponent: 'Attendant',
            actionType: 'session_expired',
            agentId: this.agentId,
            source: this.eventSource,
            reason: 'Context window threshold reached. Session archived.',
            level: 'audit',
            metadata: this.buildEventMetadata({
                contextCallCount: 0,
                expiryReason: 'context_low',
            }),
        });
    }

    // ── Getters ──────────────────────────────────────────────────────────────

    getBrief(): WorkingMemoryBrief | null {
        return this.brief;
    }

    private async verifyCheckpointAvailability(sessionId: string, expectedKeys: CheckpointAvailabilityKey[]): Promise<void> {
        const persisted = await readPersistedBriefForAgent(this.agentId);
        if (!persisted?.sessionCheckpoint || persisted.sessionCheckpoint.sessionId !== sessionId) {
            throw new Error(
                `CHECKPOINT_AVAILABILITY_FAILED: agent/${this.agentId}/attendant_state was not immediately queryable with session ${sessionId}.`
            );
        }

        for (const expected of expectedKeys) {
            const observed = await findEntry(expected);
            if (!observed) {
                throw new Error(
                    `CHECKPOINT_AVAILABILITY_FAILED: ${expected.entityType}/${expected.entityId}/${expected.key} was not immediately queryable after checkpoint success.`
                );
            }
        }
    }

    private buildComplianceState(lastUpdated?: string): SessionComplianceState {
        return buildSessionComplianceState({
            attendsWithoutPersist: this.attendsWithoutPersist,
            turnsWithoutWrite: this.turnsWithoutWrite,
            midTurnAttendsThisTurn: this.midTurnAttendsThisTurn,
            consecutivePreResponseWithoutPost: this.consecutivePreResponseWithoutPost,
            consecutiveUnusedMemoryInjections: this.consecutiveUnusedMemoryInjections,
            lastAttendPhase: this.lastAttendPhase,
            lastUpdated: lastUpdated ?? this.complianceUpdatedAt,
        });
    }

    async notifyWriteOccurred(): Promise<void> {
        this.attendsWithoutPersist = 0;
        this.turnsWithoutWrite = 0;
        this.writeOccurredThisTurn = true;
        this.lastAttendPhase = undefined;
        this.consecutivePreResponseWithoutPost = 0;
        this.complianceUpdatedAt = new Date().toISOString();
        this.recordMemoryEvidence('write');
        if (!this.brief) {
            return;
        }
        this.brief = {
            ...this.brief,
            compliance: this.buildComplianceState(this.complianceUpdatedAt),
            briefGeneratedAt: this.complianceUpdatedAt,
        };
        await this.persistState();
    }

    async checkpoint(input: SessionCheckpointInput): Promise<WorkingMemoryBrief> {
        this.attendsWithoutPersist = 0;
        this.turnsWithoutWrite = 0;
        this.lastAttendPhase = undefined;
        this.consecutivePreResponseWithoutPost = 0;
        this.complianceUpdatedAt = new Date().toISOString();
        this.recordMemoryEvidence('checkpoint');
        this.setLedgerContext(input.ledgerContext);
        const now = new Date().toISOString();
        if (!this.brief) {
            await this.handshake({
                task: input.task,
                recentMessages: input.recentMessages,
                ledgerContext: input.ledgerContext,
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
            compliance: this.buildComplianceState(now),
            briefGeneratedAt: now,
            watchedEntities: normalizeWatchedEntities([
                ...(this.brief.watchedEntities ?? []),
                ...(normalizedCheckpoint.entityTargets ?? []),
            ]),
        };
        this.sharedStateObservedAt = now;

        let expectedSharedKeys: CheckpointAvailabilityKey[] = [];
        try {
            expectedSharedKeys = await persistSharedCheckpointBreadcrumbs({
                agentId: this.agentId,
                sessionId,
                checkpoint: normalizedCheckpoint,
            });
        } catch (error) {
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'checkpoint_shared_breadcrumb_failed',
                agentId: this.agentId,
                source: this.eventSource,
                reason: 'shared_checkpoint_breadcrumb_failed',
                level: 'audit',
                metadata: this.buildEventMetadata({
                    sessionId,
                    error: error instanceof Error ? error.message : String(error),
                }),
            });
            throw error;
        }
        await this.persistState();
        try {
            await this.verifyCheckpointAvailability(sessionId, expectedSharedKeys);
        } catch (error) {
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'checkpoint_availability_failed',
                agentId: this.agentId,
                source: this.eventSource,
                reason: 'checkpoint_not_immediately_queryable',
                level: 'audit',
                metadata: this.buildEventMetadata({
                    sessionId,
                    sharedKeyCount: expectedSharedKeys.length,
                    error: error instanceof Error ? error.message : String(error),
                }),
            });
            throw error;
        }
        getStaffEventEmitter().emit({
            staffComponent: 'Attendant',
            actionType: 'checkpoint_written',
            agentId: this.agentId,
            source: this.eventSource,
            reason: 'shared_checkpoint_written',
            level: 'audit',
            metadata: this.buildEventMetadata({
                sessionId,
                currentStep: normalizedCheckpoint.currentStep ?? null,
                nextStep: normalizedCheckpoint.nextStep ?? null,
                openRiskCount: normalizedCheckpoint.openRisks?.length ?? 0,
                recentOutputCount: normalizedCheckpoint.recentOutputs?.length ?? 0,
                actionCount: normalizedCheckpoint.actions?.length ?? 0,
                fileChangeCount: normalizedCheckpoint.fileChanges?.length ?? 0,
                entityTargetCount: normalizedCheckpoint.entityTargets?.length ?? 0,
                sharedKeyCount: expectedSharedKeys.length,
                availabilityVerified: true,
            }),
        });
        return this.brief;
    }

    async resumeSession(input: SessionActionInput = {}): Promise<WorkingMemoryBrief> {
        this.setLedgerContext(input.ledgerContext);
        await this.ensureSessionLoaded();
        if (!this.brief || !this.sessionCheckpoint) {
            return this.brief ?? (await this.handshake({
                task: 'resume session',
                recentMessages: [],
                ledgerContext: input.ledgerContext,
            }));
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
            compliance: this.buildComplianceState(now),
            briefGeneratedAt: now,
        };
        this.sharedStateObservedAt = now;

        await this.persistState();
        return this.brief;
    }

    async completeSession(input: SessionActionInput = {}): Promise<WorkingMemoryBrief> {
        this.setLedgerContext(input.ledgerContext);
        await this.ensureSessionLoaded();
        if (!this.brief || !this.sessionCheckpoint) {
            return this.brief ?? (await this.handshake({
                task: 'complete session',
                recentMessages: [],
                ledgerContext: input.ledgerContext,
            }));
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
            compliance: this.buildComplianceState(now),
            briefGeneratedAt: now,
        };
        this.sharedStateObservedAt = now;

        await this.persistState();
        return this.brief;
    }

    async abandonSession(input: SessionActionInput = {}): Promise<WorkingMemoryBrief> {
        this.setLedgerContext(input.ledgerContext);
        await this.ensureSessionLoaded();
        if (!this.brief || !this.sessionCheckpoint) {
            return this.brief ?? (await this.handshake({
                task: 'abandon session',
                recentMessages: [],
                ledgerContext: input.ledgerContext,
            }));
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
            compliance: this.buildComplianceState(now),
            briefGeneratedAt: now,
        };
        this.sharedStateObservedAt = now;

        await this.persistState();
        return this.brief;
    }

    async inspectSession(context?: Partial<AgentContext>): Promise<SessionInspection> {
        this.setLedgerContext(context?.ledgerContext);
        const persisted = await this.loadPersistedState();
        const checkpoint = persisted?.sessionCheckpoint ?? this.sessionCheckpoint ?? null;
        const compliance = persisted?.compliance ?? this.buildComplianceState();
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
            summary: summarizeSessionState(this.agentId, checkpoint, persisted?.briefGeneratedAt, compliance),
            compliance,
        };
    }

    getAgentId(): string {
        return this.agentId;
    }

    async attend(input: AttendInput): Promise<AttendResult> {
        const t0 = timeStart();
        this.setLedgerContext(input.ledgerContext);
        const currentContext = input.currentContext ?? '';
        const latestMessage = normalizeMessage(input.latestMessage);
        const forceInject = input.forceInject === true;
        let bootstrap: AttendBootstrapInfo | null = null;

        this.attendsWithoutPersist++;
        const phase = input.phase;
        let complianceWarning: string | undefined;
        const ignoredMemoryWarning = 'COMPLIANCE: injected memory was surfaced but not used. On the next turn, either answer from injected facts directly or persist why the injected memory was insufficient before rediscovering the same state manually.';

        if (phase === 'post-response') {
            // Correct post-response call — reset attend counters but NOT turnsWithoutWrite
            // turnsWithoutWrite only resets on actual writes/checkpoints
            // Only count active turns (with mid-turn attends) toward turnsWithoutWrite.
            // Chatter-only turns (pre-response → post-response with nothing in between) are exempt.
            // Turns where a write already occurred are also exempt.
            this.attendsWithoutPersist = 0;
            if (this.midTurnAttendsThisTurn > 0 && !this.writeOccurredThisTurn) {
                this.turnsWithoutWrite++;
            }
            this.midTurnAttendsThisTurn = 0;
            this.writeOccurredThisTurn = false;
            this.lastAttendPhase = 'post-response';
            this.consecutivePreResponseWithoutPost = 0;
        } else if (phase === 'pre-response') {
            if (this.lastAttendPhase === 'pre-response') {
                this.consecutivePreResponseWithoutPost++;
                complianceWarning = `COMPLIANCE: iranti_attend(phase='pre-response') was called without a preceding phase='post-response'. The previous response was delivered without the required post-response attend. After every response, call iranti_attend(phase='post-response') then persist durable findings with iranti_write or iranti_checkpoint.`;
            } else {
                this.consecutivePreResponseWithoutPost = 0;
            }
            this.midTurnAttendsThisTurn = 0;
            this.writeOccurredThisTurn = false;
            this.lastAttendPhase = 'pre-response';
        } else if (phase === 'mid-turn') {
            this.midTurnAttendsThisTurn++;
            this.lastAttendPhase = 'mid-turn';
        } else {
            // No phase provided — count as mid-turn activity
            this.midTurnAttendsThisTurn++;
            if (this.attendsWithoutPersist >= 3) {
                complianceWarning = `COMPLIANCE: iranti_attend has been called ${this.attendsWithoutPersist} times since the last iranti_write or iranti_checkpoint. You are likely missing post-response attend calls and durable writes. Call iranti_attend(phase='post-response') after every response, then persist durable findings with iranti_write or iranti_checkpoint before the next turn.`;
            }
        }
        this.complianceUpdatedAt = new Date().toISOString();
        let compliance = this.buildComplianceState(this.complianceUpdatedAt);
        if (!complianceWarning && compliance.issues.some((issue) => issue.code === 'ignored_injected_memory')) {
            complianceWarning = ignoredMemoryWarning;
        }

        if (!this.brief) {
            const bootstrapTask = buildAttendBootstrapTask(latestMessage, currentContext);
            const bootstrapBrief = await this.handshake({
                task: bootstrapTask,
                recentMessages: buildAttendBootstrapMessages(latestMessage, currentContext),
                ledgerContext: input.ledgerContext,
            });
            bootstrap = {
                handshakePerformed: true,
                reason: 'no_existing_brief',
                task: bootstrapTask,
                operatingRules: bootstrapBrief.operatingRules,
                note: 'A handshake was auto-performed because no session brief existed. Read operatingRules now and follow any instructions there — including ACKNOWLEDGE — before replying to the user.',
            };
        }

        const baseEntityHints = this.resolveAttendEntityHints(input.entityHints, latestMessage);
        // File-change demand-driven recall: extract file path mentions and add as entity hints
        const filePathHints = extractFilePathEntityHints(
            `${latestMessage}\n${currentContext}`,
            getProjectMemoryEntity() ?? null,
        );
        const effectiveEntityHints = filePathHints.length > 0
            ? [...new Set([...baseEntityHints, ...filePathHints])]
            : baseEntityHints;

        // User operating rules: load rules whose triggers match the current context
        const matchedUserRules = phase !== 'post-response'
            ? await this.loadMatchingUserRules(`${latestMessage}\n${currentContext}`)
            : [];

        let watchedEntitiesChanged = this.updateWatchedEntities(effectiveEntityHints);
        const freshState = await this.detectRelevantFreshState(effectiveEntityHints, latestMessage);
        const observationContext = currentContext.trim().length > 0 ? currentContext : latestMessage;
        const mandatoryRecall = detectMandatoryRecall(latestMessage);
        if (mandatoryRecall.required && input.suppressEvents !== true) {
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'mandatory_recall_forced',
                agentId: this.agentId,
                source: this.eventSource,
                reason: mandatoryRecall.reason ?? 'mandatory_recall_prompt',
                level: 'audit',
                metadata: this.buildEventMetadata({
                    key: mandatoryRecall.key ?? null,
                    latestMessage: latestMessage.slice(0, 160),
                }),
            });
        }

        if (phase === 'post-response') {
            const memoryAttributions = this.scorePendingMemoryAttributions(latestMessage || currentContext);
            compliance = this.buildComplianceState(this.complianceUpdatedAt);
            if (memoryAttributions.some((entry) => !entry.used)) {
                complianceWarning = ignoredMemoryWarning;
            }
            if (this.brief) {
                this.brief = {
                    ...this.brief,
                    compliance,
                    briefGeneratedAt: this.complianceUpdatedAt,
                };
                await this.persistState();
            }
            timeEnd('attendant.attend_ms', t0);
            return {
                shouldInject: false,
                reason: 'memory_not_needed',
                decision: {
                    needed: false,
                    confidence: 1,
                    method: 'heuristic',
                    explanation: 'post_response_closeout',
                },
                bootstrap,
                complianceWarning,
                compliance,
                memoryAttributions,
                usageGuidance: buildUsageGuidance('attend', this.turnsWithoutWrite),
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
                    dropped: [{ name: latestMessage || '(none)', reason: 'post_response_closeout' }],
                },
            };
        }

        let decision = await this.decideMemoryNeed({
            currentContext,
            latestMessage,
            forceInject,
            entityHintCount: effectiveEntityHints.length,
        });
        if (freshState.hasFreshState && !decision.needed) {
            decision = {
                needed: true,
                confidence: 0.92,
                method: 'heuristic',
                explanation: 'relevant_shared_state_changed',
            };
        }

        if (!decision.needed) {
            if (input.suppressEvents !== true) {
                getStaffEventEmitter().emit({
                    staffComponent: 'Attendant',
                    actionType: 'attend_completed',
                    agentId: this.agentId,
                    source: this.eventSource,
                    reason: 'memory_not_injected',
                    level: 'audit',
                    metadata: this.buildEventMetadata({
                        contextCallCount: this.contextCallCount,
                        shouldInject: false,
                        attendReason: 'memory_not_needed',
                        phase: input.phase ?? null,
                    }),
                });
                getStaffEventEmitter().emit({
                    staffComponent: 'Attendant',
                    actionType: 'memory_not_injected',
                    agentId: this.agentId,
                    source: this.eventSource,
                    reason: 'memory_not_needed',
                    level: 'audit',
                    metadata: this.buildEventMetadata({
                        shouldInject: false,
                        factCount: 0,
                        injectedKeys: [],
                    }),
                });
            }
            if (this.brief) {
                this.brief = {
                    ...this.brief,
                    compliance,
                    briefGeneratedAt: this.complianceUpdatedAt,
                };
                await this.persistState();
            }
            timeEnd('attendant.attend_ms', t0);
            return {
                shouldInject: matchedUserRules.length > 0,
                reason: 'memory_not_needed',
                decision,
                bootstrap,
                complianceWarning,
                compliance,
                memoryAttributions: [],
                matchedUserRules: matchedUserRules.length > 0 ? matchedUserRules : undefined,
                usageGuidance: buildUsageGuidance('attend', this.turnsWithoutWrite),
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

        // Post-compaction recovery: re-surface facts that were recently injected (likely in context
        // just before the compact) without blocking them on the already-in-context filter.
        // The flag is set by handshake(postCompaction:true) and consumed exactly once here.
        const postCompactionRecoveryKeys: string[] = [];
        let postCompactionMaxFacts = input.maxFacts;
        if (this.postCompactionPending) {
            const recentInjections = this.pendingMemoryAttributions.slice(-5);
            for (const attr of recentInjections) {
                postCompactionRecoveryKeys.push(...attr.injectedKeys);
            }
            postCompactionMaxFacts = Math.min((input.maxFacts ?? 5) * 2, 10);
            this.postCompactionPending = false;
        }
        const observeEntityHints = effectiveEntityHints.length > 0 ? effectiveEntityHints : freshState.entities;
        const allObserveEntityHints = postCompactionRecoveryKeys.length > 0
            ? [...new Set([
                ...observeEntityHints,
                ...postCompactionRecoveryKeys.map((k) => {
                    const parts = k.split('/');
                    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : k;
                }),
            ])]
            : observeEntityHints;
        const observed = await this.observe({
            currentContext: observationContext,
            maxFacts: postCompactionMaxFacts,
            entityHints: allObserveEntityHints,
            priorityKeys: expandContinuityPriorityKeys(Array.from(new Set([
                ...(mandatoryRecall.key ? [mandatoryRecall.key] : []),
                ...(this.advisoryLearningProfile?.priorityKeys ?? []),
                ...freshState.priorityKeys,
            ]))),
            skipContextFilter: forceInject,
            recoveryKeys: postCompactionRecoveryKeys.length > 0 ? postCompactionRecoveryKeys : undefined,
            ledgerContext: input.ledgerContext,
        });

        // Remap facts from personal recall fallback entities to the canonical personal entity.
        // E.g. if person/user is a legacy alias for user/main, surface facts as user/main/<key>.
        const canonicalPersonalEntity = getPersonalMemoryEntity();
        const personalFallbacks = new Set(
            getPersonalRecallEntities().filter((e) => e !== canonicalPersonalEntity)
        );
        const [canonicalPersonalType, canonicalPersonalId] = canonicalPersonalEntity.split('/', 2);
        const remappedFacts = personalFallbacks.size === 0 ? observed.facts : observed.facts.map((fact) => {
            const slashIdx2 = fact.entityKey.indexOf('/', fact.entityKey.indexOf('/') + 1);
            const entityPath = slashIdx2 === -1 ? fact.entityKey : fact.entityKey.slice(0, slashIdx2);
            if (!personalFallbacks.has(entityPath)) return fact;
            const remainder = slashIdx2 === -1 ? '' : fact.entityKey.slice(slashIdx2);
            return { ...fact, entityKey: `${canonicalPersonalType}/${canonicalPersonalId}${remainder}` };
        });
        const structuredFacts = assignStructuredFactIds(remappedFacts);
        watchedEntitiesChanged = this.updateWatchedEntities(observed.entitiesResolved?.map((entry) => entry.canonicalEntity) ?? []) || watchedEntitiesChanged;
        this.markSharedStateObserved(observeEntityHints.length > 0 ? observeEntityHints : freshState.entities);

        let reason: AttendResult['reason'] = 'memory_needed_injected';
        const shouldInject = structuredFacts.length > 0;
        const memorySearchPerformed = true;
        const memoryResultsConsidered = observed.totalFound;
        let searchSuggestion: AttendSearchSuggestion | undefined;

        if (!shouldInject) {
            const allAlreadyInContext = observed.totalFound > 0 && observed.alreadyPresent >= observed.totalFound;
            reason = allAlreadyInContext ? 'memory_needed_but_in_context' : 'memory_checked_no_match';
            if (reason === 'memory_checked_no_match') {
                const terms = tokenizeForSearch(latestMessage).slice(0, 6);
                const alternativeEntities = (observed.entitiesResolved ?? [])
                    .map((e) => e.canonicalEntity)
                    .filter(Boolean);
                if (terms.length > 0) {
                    searchSuggestion = {
                        hint: `Iranti searched memory but found no matching facts for this turn. Call iranti_search(query='${terms.join(' ')}') BEFORE reading the codebase — empty attend facts do NOT mean data is absent; Iranti is the cross-session source of truth.`,
                        suggestedTerms: terms,
                        alternativeEntities,
                    };
                }
            }
        } else if (forceInject) {
            reason = 'forced';
        }

        const memoryAttributions = shouldInject
            ? [
                this.addPendingMemoryAttribution({
                    phase: phase === 'mid-turn' ? 'mid-turn' : 'pre-response',
                    injectedKeys: structuredFacts.map((fact) => fact.entityKey),
                    injectedEntryIds: structuredFacts
                        .map((fact) => fact.knowledgeEntryId)
                        .filter((value): value is number => typeof value === 'number'),
                    injectedSummaries: structuredFacts.map((fact) => fact.summary).filter(Boolean),
                }),
            ]
            : [];

        const attendResult = {
            ...observed,
            facts: structuredFacts,
            shouldInject: structuredFacts.length > 0 || matchedUserRules.length > 0,
            reason,
            decision,
            bootstrap,
            searchSuggestion,
            complianceWarning,
            compliance,
            memoryAttributions,
            memorySearchPerformed,
            memoryResultsConsidered,
            matchedUserRules: matchedUserRules.length > 0 ? matchedUserRules : undefined,
            usageGuidance: buildUsageGuidance('attend', this.turnsWithoutWrite),
        };
        if (input.suppressEvents !== true) {
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'attend_completed',
                agentId: this.agentId,
                source: this.eventSource,
                reason: shouldInject ? 'memory_injected' : 'memory_not_injected',
                level: 'audit',
                metadata: this.buildEventMetadata({
                    contextCallCount: this.contextCallCount,
                    shouldInject,
                    attendReason: reason,
                    injectionId: memoryAttributions[0]?.injectionId ?? null,
                    advisoryDecisionMethod: decision.method,
                    advisoryScopes: this.advisoryLearningProfile?.scopesUsed ?? [],
                    freshStateEntities: freshState.entities,
                    freshStateKeys: freshState.priorityKeys,
                    phase: input.phase ?? null,
                    }),
                });
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: shouldInject ? 'memory_injected' : 'memory_not_injected',
                agentId: this.agentId,
                source: this.eventSource,
                reason,
                level: 'audit',
                metadata: this.buildEventMetadata({
                    shouldInject,
                    factCount: observed.facts.length,
                    injectionId: memoryAttributions[0]?.injectionId ?? null,
                    injectedKeys: observed.facts.map((fact) => fact.entityKey),
                    injectedEntryIds: observed.facts
                        .map((fact) => fact.knowledgeEntryId)
                        .filter((value): value is number => typeof value === 'number'),
                    entitiesResolved: observed.entitiesResolved?.map((entry) => entry.canonicalEntity) ?? [],
                    alreadyPresent: observed.alreadyPresent,
                    totalFound: observed.totalFound,
                    advisoryPriorityKeys: this.advisoryLearningProfile?.priorityKeys ?? [],
                    freshStateEntities: freshState.entities,
                    freshStateKeys: freshState.priorityKeys,
                }),
            });
        }
        if (this.brief) {
            this.brief = {
                ...this.brief,
                compliance,
                briefGeneratedAt: this.complianceUpdatedAt,
            };
        }
        if (watchedEntitiesChanged || this.brief?.compliance !== compliance || memoryAttributions.length > 0) {
            await this.persistState();
        }
        timeEnd('attendant.attend_ms', t0);
        return attendResult;
    }

    // Context Window Observation

    async observe(input: ObserveInput): Promise<ObserveResult> {
        const t0 = timeStart();
        this.setLedgerContext(input.ledgerContext);
        const maxFacts = input.maxFacts ?? 5;
        const currentContext = input.currentContext ?? '';
        const entityHints = this.resolveObserveEntityHints(input.entityHints, currentContext);
        const requestedPriorityKeys = Array.isArray(input.priorityKeys)
            ? input.priorityKeys
                .filter((key: string) => typeof key === 'string' && key.trim().length > 0)
                .map((key: string) => key.trim())
            : [];

        if (currentContext.trim().length === 0 && entityHints.length === 0) {
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'observe_completed',
                agentId: this.agentId,
                source: this.eventSource,
                reason: 'no_observation_context',
                level: 'audit',
                metadata: this.buildEventMetadata({
                    observeType: 'empty_context',
                }),
            });
            timeEnd('attendant.observe_ms', t0);
            return {
                facts: [],
                entitiesDetected: [],
                alreadyPresent: 0,
                totalFound: 0,
                usageGuidance: buildUsageGuidance('observe'),
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
                source: this.eventSource,
                reason: 'no_entity_candidates',
                level: 'audit',
                metadata: this.buildEventMetadata({
                    observeType: 'no_candidates',
                }),
            });
            timeEnd('attendant.observe_ms', t0);
            return {
                facts: [],
                entitiesDetected: [],
                alreadyPresent: 0,
                totalFound: 0,
                usageGuidance: buildUsageGuidance('observe'),
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
        const entryPropertiesMap = new Map<number, Record<string, unknown>>();
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
            const policyPriorityKeys = policy.observeKeyPriority?.[resolvedInfo.entityType] ?? [];
            const priorityKeys = new Set(expandContinuityPriorityKeys([...policyPriorityKeys, ...requestedPriorityKeys]));
            const priorityEntries = allEntries.filter((e) => priorityKeys.has(e.key));
            const remainingEntries = allEntries
                .filter((e) => !priorityKeys.has(e.key))
                .sort((a, b) => {
                    const checkpointPenalty = (entryKey: string): number => entryKey.startsWith('checkpoint_') ? 1 : 0;
                    return (
                        checkpointPenalty(a.key) - checkpointPenalty(b.key)
                        || b.confidence - a.confidence
                        || b.updatedAt.getTime() - a.updatedAt.getTime()
                        || a.key.localeCompare(b.key)
                    );
                });

            const selectedEntries = [...priorityEntries, ...remainingEntries].slice(0, maxKeysPerEntity);
            const freshestEntry = allEntries
                .slice()
                .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.confidence - a.confidence)[0];
            if (freshestEntry && !selectedEntries.some((entry) => entry.id === freshestEntry.id)) {
                selectedEntries[selectedEntries.length - 1] = freshestEntry;
            }

            for (const entry of selectedEntries) {
                allFacts.push({
                    entityKey: `${resolvedInfo.entityType}/${resolvedInfo.entityId}/${normalizeContinuityKey(entry.key)}`,
                    summary: entry.valueSummary,
                    value: entry.valueRaw,
                    confidence: entry.confidence,
                    source: entry.source,
                    lastUpdated: entry.updatedAt.toISOString(),
                    entryId: entry.id,
                });
                if (entry.properties && typeof entry.properties === 'object' && !Array.isArray(entry.properties)) {
                    entryPropertiesMap.set(entry.id, entry.properties as Record<string, unknown>);
                }
            }
        }

        // Step 3 — filter out facts already present in context (skipped when forceInject)
        const contextLower = currentContext.toLowerCase();
        let alreadyPresent = 0;
        const newFacts: RetrievedFact[] = [];

        if (input.skipContextFilter) {
            newFacts.push(...allFacts);
        } else {
            const recoveryKeySet = new Set(input.recoveryKeys ?? []);
            for (const fact of allFacts) {
                // Recovery keys bypass the already-in-context filter: these facts were recently
                // injected and likely visible before compaction, so substring match would wrongly
                // block re-injection into the fresh post-compaction context.
                const isRecoveryKey = recoveryKeySet.has(fact.entityKey);
                const alreadyInContext = !isRecoveryKey && factAlreadyPresentInContext(contextLower, fact);

                if (alreadyInContext) {
                    alreadyPresent++;
                } else {
                    newFacts.push(fact);
                }
            }
        }

        // Step 4 — relevance-weighted fact ranking
        // Profile facts (favorite_city, country_of_origin, etc.) on personal entities
        // are deprioritized unless the context/message shows token overlap with them.
        // When a semanticFilter is provided, facts matching the filter are boosted.
        const contextTokens = new Set(tokenizePresenceText(currentContext));
        const activeSemanticFilter = input.semanticFilter;
        const topFacts = newFacts
            .map((fact) => {
                const parts = fact.entityKey.split('/');
                const entityType = parts[0] ?? '';
                const factKey = parts[2] ?? '';
                const isProfile = isPersonalEntityType(entityType) && isPersonalMemoryKey(factKey);

                // Compute token overlap between context and fact summary
                const factTokens = tokenizePresenceText(fact.summary);
                const overlap = factTokens.filter((t) => contextTokens.has(t)).length;
                const relevance = factTokens.length > 0 ? overlap / factTokens.length : 0;

                // Semantic boost: if a filter is active, boost matching facts
                const properties = entryPropertiesMap.get(fact.entryId);
                const semanticScore = activeSemanticFilter ? semanticMatchScore(properties, activeSemanticFilter) : 0;
                const semanticBoost = semanticScore > 0 ? semanticScore * 30 : 0;

                // Profile facts with no relevance to the current context get deprioritized
                const profilePenalty = isProfile && relevance === 0 ? 50 : 0;
                const effectiveConfidence = fact.confidence - profilePenalty + semanticBoost;

                return { fact, effectiveConfidence, relevance, semanticScore };
            })
            .sort((a, b) => b.effectiveConfidence - a.effectiveConfidence || b.semanticScore - a.semanticScore || b.relevance - a.relevance)
            .slice(0, maxFacts)
            .map(({ fact }) => fact);

        await recordKnowledgeEntryAccess(topFacts.map((fact) => fact.entryId));

        getStaffEventEmitter().emit({
            staffComponent: 'Attendant',
            actionType: 'observe_completed',
            agentId: this.agentId,
            source: this.eventSource,
            reason: topFacts.length > 0 ? 'facts_retrieved' : 'no_new_facts',
            level: 'audit',
            metadata: this.buildEventMetadata({
                observeType: 'facts_retrieved',
                factsCount: topFacts.length,
            }),
        });
        timeEnd('attendant.observe_ms', t0);
        return {
            facts: assignStructuredFactIds(topFacts.map(({ entityKey, summary, value, confidence, source, lastUpdated, entryId }) => ({
                knowledgeEntryId: entryId,
                entityKey,
                summary,
                value,
                confidence,
                source,
                lastUpdated,
            }))),
            entitiesDetected: Array.from(entitiesDetected),
            alreadyPresent,
            totalFound: allFacts.length,
            usageGuidance: buildUsageGuidance('observe'),
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

    // ── User Operating Rules ────────────────────────────────────────────────

    private async loadMatchingUserRules(context: string): Promise<MatchedUserRule[]> {
        try {
            const entries = await findEntriesByEntityType('rule');
            if (entries.length === 0) return [];

            const contextLower = context.toLowerCase();
            const contextTokens = new Set(tokenizePresenceText(context));
            const matched: MatchedUserRule[] = [];

            for (const entry of entries) {
                const props = entry.properties && typeof entry.properties === 'object' && !Array.isArray(entry.properties)
                    ? entry.properties as Record<string, unknown>
                    : null;
                const rule = parseUserOperatingRule({
                    entityType: entry.entityType,
                    entityId: entry.entityId,
                    key: entry.key,
                    valueSummary: entry.valueSummary,
                    valueRaw: entry.valueRaw,
                    source: entry.source,
                    properties: props,
                    updatedAt: entry.updatedAt,
                });
                if (rule && matchesRuleTriggers(rule.triggers, contextTokens, contextLower)) {
                    matched.push(rule);
                }
            }

            return matched;
        } catch (err) {
            console.error('[attendant] failed to load user operating rules:', err);
            return [];
        }
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
        entityHintCount: number;
    }): Promise<AttendDecision> {
        if (input.forceInject) {
            return {
                needed: true,
                confidence: 1,
                method: 'forced',
                explanation: 'force_inject',
            };
        }

        const mandatoryRecall = detectMandatoryRecall(input.latestMessage);
        if (mandatoryRecall.required) {
            return {
                needed: true,
                confidence: 0.99,
                method: 'heuristic',
                explanation: mandatoryRecall.reason ?? 'mandatory_recall_prompt',
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

        const advisoryDecision = this.buildAdvisoryMemoryDecision(input.latestMessage);
        if (advisoryDecision) {
            return advisoryDecision;
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
- needsMemory=true when the message involves project context, technical decisions, code state, prior work, open tasks, bugs, architecture, preferences, or anything session- or project-specific.
- needsMemory=true when in doubt — false positives are cheap, false negatives lose context.
- needsMemory=false ONLY for clear one-word acks, simple greetings, or purely generic factual questions with no project relevance.
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

        return this.buildParseFailureFallbackDecision(input);
    }

    private buildParseFailureFallbackDecision(input: {
        currentContext: string;
        latestMessage: string;
        entityHintCount: number;
    }): AttendDecision {
        const normalized = normalizeMessage(input.latestMessage);
        if (!normalized || MEMORY_NEED_NEGATIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
            return {
                needed: false,
                confidence: 0.5,
                method: 'heuristic',
                explanation: 'classification_parse_failed_default_false',
            };
        }

        // Re-run the heuristic against the strengthened positive patterns. Since the heuristic
        // was already called in decideMemoryNeed() and returned null (ambiguous), we reach here
        // only for very short messages (≤20 chars) with no prior pattern matches. The updated
        // MEMORY_NEED_POSITIVE_PATTERNS now catch most imperative and technical cues, so a second
        // pass here picks up any stragglers added after the initial call.
        const heuristicResult = heuristicMemoryNeed(input.latestMessage);
        if (heuristicResult.needed !== null) {
            return {
                needed: heuristicResult.needed,
                confidence: heuristicResult.confidence,
                method: 'heuristic',
                explanation: heuristicResult.needed
                    ? 'classification_parse_failed_heuristic_true'
                    : 'classification_parse_failed_heuristic_false',
            };
        }

        const substantivePrompt =
            normalized.length >= 12
            || normalized.split(/\s+/).filter(Boolean).length >= 3
            || /[?]$/.test(normalized);
        const hasScopedContext = input.entityHintCount > 0 || input.currentContext.trim().length > 0;
        const hasProjectStateCue = MEMORY_PARSE_FAILURE_PROJECT_CUE_PATTERNS.some((pattern) => pattern.test(normalized));
        if (substantivePrompt && (hasScopedContext || hasProjectStateCue)) {
            return {
                needed: true,
                confidence: 0.55,
                method: 'heuristic',
                explanation: 'classification_parse_failed_default_true',
            };
        }

        // Final safety net: for any non-trivial message (≥5 chars) where the LLM parse failed,
        // default to injecting memory rather than silently skipping. A false positive (unnecessary
        // injection) is far cheaper than a false negative (missing context causes wrong output).
        // Only true single-word acks/greetings — already caught by MEMORY_NEED_NEGATIVE_PATTERNS
        // above — should reach this point with a truly empty normalized form; everything else
        // gets injection.
        if (normalized.length > 0) {
            return {
                needed: true,
                confidence: 0.5,
                method: 'heuristic',
                explanation: 'classification_parse_failed_safe_default_true',
            };
        }

        return {
            needed: false,
            confidence: 0.5,
            method: 'heuristic',
            explanation: 'classification_parse_failed_default_false',
        };
    }

    private buildAdvisoryMemoryDecision(latestMessage: string): AttendDecision | null {
        const profile = this.advisoryLearningProfile;
        const normalized = normalizeMessage(latestMessage);
        if (!profile?.preferMemoryForAmbiguousTurns || !normalized) {
            return null;
        }
        if (MEMORY_NEED_NEGATIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
            return null;
        }
        if (normalized.length < 5) {
            return null;
        }
        if (!messageHasAdvisoryCue(normalized, profile.matchedTaskType ?? this.brief?.inferredTaskType ?? null)) {
            return null;
        }

        return {
            needed: true,
            confidence: profile.scopesUsed.includes('task') ? 0.78 : 0.7,
            method: 'advisory',
            explanation: `advisory_${profile.scopesUsed[0] ?? 'global'}_learning`,
        };
    }

    private resolveAttendEntityHints(entityHints: string[] | undefined, latestMessage: string): string[] {
        const explicit = Array.isArray(entityHints)
            ? entityHints.filter((hint) => typeof hint === 'string' && hint.trim().length > 0)
            : [];
        const explicitFromMessage = extractExactEntityReferences(latestMessage);
        const scope = classifyMemoryScope(latestMessage);

        if (explicitFromMessage.length > 0) {
            return explicitFromMessage;
        }

        if (explicit.length > 0) {
            return explicit;
        }

        if (scope === 'personal') {
            return getPersonalRecallEntities();
        }

        if (scope === 'project') {
            const configured = getProjectMemoryEntity();
            if (configured) {
                return [configured];
            }
        }

        return [];
    }

    private resolveObserveEntityHints(entityHints: string[] | undefined, currentContext: string): string[] {
        const explicit = Array.isArray(entityHints)
            ? entityHints.filter((hint) => typeof hint === 'string' && hint.trim().length > 0)
            : [];
        if (explicit.length > 0) {
            return explicit;
        }

        const explicitFromContext = extractExactEntityReferences(currentContext);
        if (explicitFromContext.length > 0) {
            return explicitFromContext;
        }

        const scope = classifyMemoryScope(currentContext);
        if (scope && this.brief) {
            const watched = normalizeWatchedEntities([
                ...(this.brief?.watchedEntities ?? []),
                ...(this.sessionCheckpoint?.checkpoint.entityTargets ?? []),
            ]);
            if (watched.length > 0) {
                return watched;
            }
        }

        if (scope === 'personal') {
            return getPersonalRecallEntities();
        }

        if (scope === 'project') {
            const configured = getProjectMemoryEntity();
            if (configured) {
                return [configured];
            }
        }

        return [];
    }

    private async detectRelevantFreshState(entityHints: string[], latestMessage: string): Promise<RelevantFreshState> {
        const pending = this.consumePendingFreshState(entityHints, latestMessage);
        if (pending.hasFreshState) {
            return pending;
        }

        const sinceRaw = this.sharedStateObservedAt?.trim() || this.brief?.briefGeneratedAt?.trim();
        if (!sinceRaw) {
            return { hasFreshState: false, priorityKeys: [], entities: [] };
        }

        const since = new Date(sinceRaw);
        if (Number.isNaN(since.getTime())) {
            return { hasFreshState: false, priorityKeys: [], entities: [] };
        }

        const targetHints = entityHints.length > 0
            ? entityHints
            : shouldUseWatchedEntitiesForPrompt(latestMessage)
                ? (this.brief?.watchedEntities ?? [])
                : [];
        if (targetHints.length === 0) {
            return { hasFreshState: false, priorityKeys: [], entities: [] };
        }

        const resolvedEntities = await this.expandRelevantFreshTargets(targetHints.slice(0, 5));

        const entities: string[] = [];
        const priorityKeys: string[] = [];
        const seenKeys = new Set<string>();

        for (const [canonicalEntity, resolved] of resolvedEntities) {
            const entries = await findEntriesByEntity(resolved.entityType, resolved.entityId);
            const freshEntries = entries
                .filter((entry) => entry.updatedAt > since)
                .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
            if (freshEntries.length === 0) continue;

            entities.push(canonicalEntity);
            for (const entry of freshEntries) {
                if (seenKeys.has(entry.key)) continue;
                seenKeys.add(entry.key);
                priorityKeys.push(entry.key);
                if (priorityKeys.length >= 8) {
                    break;
                }
            }
            if (priorityKeys.length >= 8) {
                break;
            }
        }

        return {
            hasFreshState: entities.length > 0,
            priorityKeys,
            entities,
        };
    }

    private async expandRelevantFreshTargets(targetHints: string[]): Promise<Map<string, FreshEntityTarget>> {
        const resolvedEntities = new Map<string, FreshEntityTarget>();
        for (const hint of targetHints) {
            const resolved = await this.resolveFreshEntityTarget(hint);
            if (!resolved) continue;
            resolvedEntities.set(resolved.canonicalEntity, resolved);

            const related = await getRelated(resolved.entityType, resolved.entityId);
            for (const neighbor of related.slice(0, 6)) {
                const relatedEntity = `${neighbor.entityType}/${neighbor.entityId}`;
                const relatedResolved = await this.resolveFreshEntityTarget(relatedEntity);
                if (!relatedResolved) continue;
                resolvedEntities.set(relatedResolved.canonicalEntity, relatedResolved);
                if (resolvedEntities.size >= 12) {
                    return resolvedEntities;
                }
            }
        }
        return resolvedEntities;
    }

    private async resolveFreshEntityTarget(hint: string): Promise<FreshEntityTarget | null> {
        try {
            const parsed = parseEntityString(hint);
            try {
                const resolved = await resolveEntity({
                    entityType: parsed.entityType,
                    entityId: parsed.entityId,
                    rawName: hint,
                    aliases: [hint, parsed.entityId],
                    source: 'attend_refresh',
                    confidence: 100,
                    createIfMissing: false,
                });
                return {
                    canonicalEntity: resolved.canonicalEntity,
                    entityType: resolved.entityType,
                    entityId: resolved.entityId,
                };
            } catch {
                return {
                    canonicalEntity: `${parsed.entityType}/${parsed.entityId}`,
                    entityType: parsed.entityType,
                    entityId: parsed.entityId,
                };
            }
        } catch {
            return null;
        }
    }

    private updateWatchedEntities(candidates: string[]): boolean {
        if (!this.brief) return false;
        const next = normalizeWatchedEntities([
            ...(this.brief.watchedEntities ?? []),
            ...candidates,
        ]);
        const changed = JSON.stringify(next) !== JSON.stringify(this.brief.watchedEntities ?? []);
        this.brief.watchedEntities = next;
        return changed;
    }

    isWatchingEntity(entity: string): boolean {
        const normalized = entity.trim();
        if (!normalized) return false;
        if ((this.brief?.watchedEntities ?? []).includes(normalized)) {
            return true;
        }
        return (this.sessionCheckpoint?.checkpoint.entityTargets ?? []).includes(normalized);
    }

    notifySharedEntityUpdated(entity: string, key: string): void {
        const normalizedEntity = entity.trim();
        const normalizedKey = key.trim();
        if (!normalizedEntity || !normalizedKey) return;
        if (!this.isWatchingEntity(normalizedEntity)) return;
        const existing = this.pendingSharedStateInvalidations.get(normalizedEntity) ?? new Set<string>();
        existing.add(normalizedKey);
        this.pendingSharedStateInvalidations.set(normalizedEntity, existing);
    }

    private consumePendingFreshState(entityHints: string[], latestMessage: string): RelevantFreshState {
        const targetHints = entityHints.length > 0
            ? entityHints
            : shouldUseWatchedEntitiesForPrompt(latestMessage)
                ? (this.brief?.watchedEntities ?? [])
                : [];
        if (targetHints.length === 0) {
            return { hasFreshState: false, priorityKeys: [], entities: [] };
        }

        const entities: string[] = [];
        const priorityKeys: string[] = [];
        const seenKeys = new Set<string>();
        for (const entity of targetHints) {
            const keys = this.pendingSharedStateInvalidations.get(entity);
            if (!keys || keys.size === 0) continue;
            entities.push(entity);
            for (const key of keys) {
                if (seenKeys.has(key)) continue;
                seenKeys.add(key);
                priorityKeys.push(key);
                if (priorityKeys.length >= 8) break;
            }
            if (priorityKeys.length >= 8) break;
        }

        return {
            hasFreshState: entities.length > 0,
            priorityKeys,
            entities,
        };
    }

    private markSharedStateObserved(entities: string[]): void {
        if (entities.length === 0) return;
        this.sharedStateObservedAt = new Date().toISOString();
        for (const entity of entities) {
            this.pendingSharedStateInvalidations.delete(entity);
        }
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
        const explicitTask = normalizeExplicitTask(context.task);
        if (explicitTask) {
            return explicitTask;
        }

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

        const inferred = response.text.trim();
        return inferred || 'general assistance';
    }

    private async loadOperatingRules(): Promise<string> {
        const rulesResult: QueryResult = await queryEntry(ATTENDANT_RULES_QUERY);
        return rulesResult.found && rulesResult.entry
            ? formatOperatingRulesText(rulesResult.entry.valueRaw, rulesResult.entry.valueSummary)
            : formatOperatingRulesText(null, 'Attendant operating rules:');
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
        this.brief = {
            ...this.brief,
            compliance: this.buildComplianceState(),
            pendingMemoryAttributions: this.pendingMemoryAttributions.map((entry) => ({ ...entry })),
        };

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
        this.advisoryLearningProfile = null;
        this.sharedStateObservedAt = state.briefGeneratedAt;
        this.attendsWithoutPersist = state.compliance?.counters.attendsWithoutPersist ?? 0;
        this.turnsWithoutWrite = state.compliance?.counters.turnsWithoutWrite ?? 0;
        this.midTurnAttendsThisTurn = state.compliance?.counters.midTurnAttendsThisTurn ?? 0;
        this.consecutivePreResponseWithoutPost = state.compliance?.counters.consecutivePreResponseWithoutPost ?? 0;
        this.consecutiveUnusedMemoryInjections = state.compliance?.counters.consecutiveUnusedMemoryInjections ?? 0;
        this.lastAttendPhase = state.compliance?.counters.lastAttendPhase ?? undefined;
        this.complianceUpdatedAt = state.compliance?.lastUpdated ?? state.briefGeneratedAt;
        this.pendingMemoryAttributions = Array.isArray(state.pendingMemoryAttributions)
            ? state.pendingMemoryAttributions.map((entry) => ({ ...entry }))
            : [];
        this.brief = state;
        return state;
    }
}

