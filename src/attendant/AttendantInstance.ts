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
import { planCouncilConsultation, type CouncilConsultationPlan } from '../staff/council';
import { planSubTurnLoop, type SubTurnLoopPlan } from '../staff/subTurnLoop';

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
// A1: mid-turn attends default to a smaller fact budget than pre-response.
// The agent is already deep in the task with a working memory frame; the point
// of a mid-turn attend is to surface 1-3 NEW facts on a topic shift, not to
// re-dump the whole briefing.
const MID_TURN_DEFAULT_MAX_FACTS = 3;
// M2: tool-result extraction bounds. Cap the amount of tool output we send to
// the extraction LLM so huge reads (e.g. a 2000-line file) do not blow the
// prompt budget. The head covers imports, types, and top declarations which
// are where durable facts tend to live.
const TOOL_RESULT_EXTRACTION_HEAD_CHARS = 8000;
const TOOL_RESULT_EXTRACTION_MIN_CHARS = 40;
const TOOL_RESULT_EXTRACTION_MAX_FACTS = 8;
const TOOL_RESULT_EXTRACTION_DEFAULT_CONFIDENCE = 70;
// M3: force a write nudge after this many tool calls with autowrite activity
// and no intervening host-initiated durable write. Threshold chosen low
// enough to catch "read five files and move on" but high enough that normal
// single-file reads do not trigger it.
const TOOL_COST_WRITE_NUDGE_THRESHOLD = 5;
// Keep a bounded buffer of recent autowrite batches so the nudge can surface
// concrete draft facts instead of a vague "write something" reminder.
const RECENT_AUTOWRITE_BUFFER_LIMIT = 12;
const AUTOWRITE_SOURCE_TAG = 'attendant_autowrite';
// M7: response file-change autowrite — constants governing the scan pass
// that runs at post-response to extract file paths from the agent's reply.
const RESPONSE_FILE_CAPTURE_MIN_CHARS = 50;
const RESPONSE_FILE_CAPTURE_MAX_FILES = 20;
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

// A6: objective memory — structured representation of what the user/agent is
// trying to accomplish in the current session. Pairs with A1 (adaptive
// surfacing) to become "session executive function". Extends the coarse
// inferredTaskType label with a richer object the host can render to the user
// and drift-check against on every turn.
//
// Derived purely from the task string + recent messages + any session
// checkpoint. No LLM call. The objective persists across turns on the
// WorkingMemoryBrief and is re-derived whenever handshake() or checkpoint()
// runs so task shifts are captured without any host-side plumbing.
export type SessionObjectiveSource =
    | 'task_string'           // derived directly from context.task on handshake
    | 'checkpoint_continuation' // carried forward from an interrupted session's nextStep
    | 'skipped';              // task was too short or empty to derive anything

export interface SessionObjective {
    // Short human-readable "verb phrase" summary of what the agent is doing.
    // Example: "ship B4 release" or "audit attendant lifecycle".
    primary: string;
    // Supporting signals extracted from the task (driving action verbs,
    // subject nouns) used for drift checks and objective-match scoring.
    taskSignals: string[];
    // Confidence 0..1 — how strong the extraction was. 1.0 means the task
    // string unambiguously produced a verb+noun objective.
    confidence: number;
    // Provenance: where the objective came from.
    source: SessionObjectiveSource;
    // ISO timestamp: when the objective was derived.
    derivedAt: string;
    // Human-readable note for the host to surface verbatim.
    note: string;
}

export interface WorkingMemoryBrief {
    agentId: string;
    operatingRules: string;
    inferredTaskType: string;
    // A6: optional because older hosts that don't know about objective memory
    // should continue to work unchanged. Populated on handshake and refreshed
    // on checkpoint.
    sessionObjective?: SessionObjective | null;
    workingMemory: WorkingMemoryEntry[];
    projectPolicies?: ProjectPolicyEntry[];
    sessionStarted: string;
    briefGeneratedAt: string;
    contextCallCount: number;
    backfillSuggestion?: BackfillSuggestion | null;
    planProposal?: PlanProposal | null;
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

// A4: plan proposal surfaced on handshake.
//
// When the task string or inferred task type contains a high-complexity verb
// (ship / implement / refactor / fix / audit / migrate / deploy / debug),
// the attendant builds a short structured plan that the host can surface to
// the user before the agent begins tool use. Purely heuristic — no LLM call,
// deterministic — so handshakes stay fast and snapshot-testable.
//
// When the agent has an interrupted session checkpoint, the plan switches to
// a `checkpoint_continuation` source that leads with `checkpoint.nextStep`
// instead of the keyword-template plan.
//
// The field is optional on WorkingMemoryBrief so older hosts that don't know
// about `planProposal` can ignore it safely.
export type PlanProposalSource =
    | 'heuristic_keyword'
    | 'checkpoint_continuation'
    | 'skipped';

export interface PlanProposalStep {
    n: number;
    description: string;
    rationale?: string;
}

export interface PlanProposal {
    suggested: boolean;
    reason: string;
    source: PlanProposalSource;
    steps: PlanProposalStep[];
    taskSignals: string[];
    note?: string;
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
        midTurnFilteredKeys?: string[];
    };
}

// A2: tool-call triggered retrieval — the caller can tell attend() that the
// agent is about to invoke a specific read-only tool. Attend derives entity
// hints from the tool's arguments (file_path, glob pattern, bash command,
// fetched URL, etc.) and surfaces any stored facts BEFORE the tool runs, so
// the agent can preempt redundant filesystem/web lookups with memory.
export type PendingToolCallName =
    | 'Read'
    | 'Grep'
    | 'Glob'
    | 'Bash'
    | 'WebSearch'
    | 'WebFetch';

export interface PendingToolCall {
    name: PendingToolCallName;
    args?: Record<string, unknown>;
}

// M2: tool-result extraction. The host passes the content of a just-completed
// read-only tool call and Iranti extracts durable facts from it automatically,
// writing them with source='attendant_autowrite' so they are distinguishable
// from host-initiated writes and can be reverted as a batch.
export interface ToolResultPayload {
    toolName: PendingToolCallName;
    status: 'success' | 'error';
    content: string;
    metadata?: {
        path?: string;
        url?: string;
        query?: string;
        command?: string;
        durationMs?: number;
    };
}

export interface AttendInput extends ObserveInput {
    latestMessage?: string;
    forceInject?: boolean;
    suppressEvents?: boolean;
    phase?: 'pre-response' | 'post-response' | 'mid-turn';
    pendingToolCall?: PendingToolCall;
    toolResult?: ToolResultPayload;
    // B8 M6: partial assistant response carried on a mid-turn attend so the
    // Attendant can re-score its own in-progress output against memory and
    // plan a bounded sub-turn retrieval retry. Only inspected when
    // phase='mid-turn'; ignored on pre-response and post-response.
    partialResponse?: string;
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
    // A2: only populated when the caller passed pendingToolCall.
    // Reports which entity hints were derived from the tool call so the agent
    // (and tests) can see which stored facts preempted the lookup.
    toolCallGuidance?: ToolCallGuidance;
    // M2: only populated when the caller passed toolResult.
    // Reports the outcome of automatic fact extraction from a tool's output —
    // how many facts were extracted, how many were written, which were skipped,
    // and the batch id assigned so they can be reverted as a group.
    toolResultExtraction?: ToolResultExtractionOutcome;
    // M3: only populated when the mid-turn pressure gauge triggers a forced
    // write nudge (too many tool calls without a matching durable write).
    writeNudge?: WriteNudge;
    // M4: only populated when the current message/context has drifted away
    // from the declared (inferred) task by more than DRIFT_JACCARD_MIN.
    // Absent in the healthy case — hosts should treat presence as a signal
    // to confirm with the user or to force a reconvene via handshake().
    drift?: DriftSignal;
    // M5: only populated when auto-checkpoint pressure has built up
    // (tool-cost, turn-cost, or drift). Hosts should treat presence as a
    // strong recommendation to call iranti_checkpoint before taking on more
    // work. Absent in the healthy case. Gated off on post-response.
    autoCheckpointSignal?: AutoCheckpointSignal;
    // A3: only populated when attend decided memory was needed AND the
    // initial retrieval pass returned zero facts. Describes the bounded
    // refinement pass (at most one extra observe call) and whether it
    // added anything. Absent when the first pass was sufficient or when
    // attend decided no memory was needed. Gated off on post-response.
    refinementPass?: RefinementPass;
    // A5: only populated when attend has enough signal to suggest
    // follow-up tool calls the host could run autonomously. Deterministic,
    // descriptive — the Attendant does NOT execute these in this release.
    // Hosts can surface the plan to the user or use it for compliance
    // scoring ("did the host run any of the suggested tools?"). Gated
    // off on post-response.
    attendantToolPlan?: AttendantToolPlan;
    // B7 S6: council consultation plan — describes which other Staff
    // members the Attendant would consult for relevance/reliability if
    // council mode were executed. Proposal only, never executed here.
    // Absent on post-response.
    councilConsultationPlan?: CouncilConsultationPlan;
    // B8 M6: sub-turn reasoning loop plan — when a mid-turn attend carries
    // a partial assistant response, the Attendant re-scores that partial
    // text against the baseline retrieval and decides whether to fire one
    // bounded extra observe() call with broadened hints harvested from the
    // partial. Pure plan + at most one retry; deterministic. Always echoed
    // on mid-turn; decline outcomes echoed on pre-response and post-response.
    subTurnLoopPlan?: SubTurnLoopPlan;
    // M7: response file-change autowrite — populated at post-response when the
    // agent's reply contains file paths. The Attendant scans for paths, infers
    // the most likely action (edited / created / read) from surrounding context,
    // and writes one fact per file-scoped entity (project/{id}/file/{basename})
    // so demand-driven recall can surface them in future sessions without any
    // host-side collection effort. Absent on pre-response and mid-turn.
    responseFileCapture?: ResponseFileCaptureResult;
}

export interface ToolCallGuidance {
    toolName: PendingToolCallName;
    derivedEntities: string[];
    factCount: number;
    note: string;
    // M1: skipTool with teeth — explicit, actionable skip decision.
    // A2 surfaced advisory guidance; M1 turns it into a structured verdict
    // the host can gate on programmatically instead of reading the note text.
    // shouldSkip is true only when Iranti has stored facts that directly
    // cover the tool target (factCount > 0 AND derivedEntities.length > 0).
    // skipConfidence is the mean fact confidence (0..1) scaled from 0..100.
    // skipReasonCode tags WHY skip was or was not recommended so the host
    // can log and debug skip misses without string-matching notes.
    shouldSkip: boolean;
    skipConfidence: number;
    skipReasonCode:
        | 'facts_cover_target'         // shouldSkip=true
        | 'no_facts_for_target'        // shouldSkip=false, facts empty but entities derived
        | 'no_entities_derived'        // shouldSkip=false, tool args yielded no hints
        | 'memory_not_needed';         // shouldSkip=false, early-return path (no memory at all)
}

// M4: drift detection — compares the current message/context against the
// declared/inferred task and flags when the agent appears to have wandered
// off. Hosts can surface this back to the user or force a task-shift
// reconvene. Pure and optional: only populated when drift is detected.
export interface DriftSignal {
    detected: boolean;
    // jaccard overlap of normalized tokens in (0..1). 1.0 means identical
    // token sets, 0.0 means completely disjoint. Threshold is DRIFT_JACCARD_MIN.
    overlap: number;
    // tokens present in the current message but absent from the declared
    // task — the likely "driving" topic of the new work.
    drivingTokens: string[];
    // tokens present in the declared task but absent from current context —
    // what the agent has stopped talking about.
    missingTokens: string[];
    declaredTaskType: string;
    // canned human-readable summary the host can forward verbatim.
    note: string;
}

// M5: auto-checkpoint signal — NOT an auto-persistence. M5 surfaces a soft
// recommendation that the host should call iranti_checkpoint now based on
// tool-cost pressure, turn-cost pressure, or detected drift. The host still
// authors the checkpoint; M5's job is to make sure the host knows it's time.
//
// Pairs with A6 (objective memory): when drift fires, the host can consult
// the stored sessionObjective to decide whether to reconvene or checkpoint
// the old objective before taking on the new one.
export type AutoCheckpointReason =
    | 'tool_cost_threshold'    // toolCallsSinceLastWrite >= AUTO_CHECKPOINT_TOOL_COST_THRESHOLD
    | 'turns_without_write'    // turnsWithoutWrite >= AUTO_CHECKPOINT_TURN_THRESHOLD
    | 'drift_detected'         // M4 drift fired this turn
    | 'none';                  // no trigger fired — field should be absent on wire

export type AutoCheckpointUrgency = 'suggested' | 'strong' | 'critical';

export interface AutoCheckpointSignal {
    reason: AutoCheckpointReason;
    urgency: AutoCheckpointUrgency;
    // The numeric counters that triggered this signal (echoed so hosts can
    // log and tests can assert on them without re-reading instance state).
    toolCallsSinceLastWrite: number;
    turnsWithoutWrite: number;
    driftOverlap: number | null;
    // Draft checkpoint fields the host can start from. These are heuristic
    // suggestions — the host should refine them before calling
    // iranti_checkpoint. Pulled from the session objective + drift tokens
    // + recent work context.
    draftCurrentStep: string | null;
    draftNextStep: string | null;
    // Canned human-readable message the host can surface verbatim.
    message: string;
}

// A3: iterative exploration — when the first retrieval pass comes back
// empty but the attend decision said memory was needed, the Attendant
// runs ONE bounded refinement pass with broadened entity hints and
// fallback search terms derived from the latest message. The pass is
// bounded (max 1 extra observe() call) to keep latency predictable.
// Populated when either the refinement was attempted or declined with a
// reason so the host can log why retrieval was not re-tried.
export type RefinementPassOutcome =
    | 'not_needed'           // initial pass returned facts OR decision.needed=false
    | 'attempted_added'      // second pass ran and returned extra facts
    | 'attempted_empty'      // second pass ran and returned no extra facts
    | 'declined_no_hints'    // no entity hints and no usable fallback terms — retry would be blind
    | 'declined_post_response'; // gated off on post-response closeouts

export interface RefinementPass {
    outcome: RefinementPassOutcome;
    attempted: boolean;
    initialFactCount: number;
    addedFactCount: number;
    widenedEntityHints: string[];
    fallbackTerms: string[];
    reason: string;
    note: string;
}

// A5: tool-using Attendant (planned). The Attendant derives a small list
// of tools it WOULD call if it had an execution budget — search_related,
// observe_entity, query — based on the current brief, recent messages,
// and retrieval state. Purely descriptive in this release: the host sees
// the plan and can choose to execute one, or the plan can be compared to
// actual host tool calls for compliance scoring. Deterministic, no LLM.
export type AttendantProposedToolName =
    | 'search_related'   // follow-up relatedness walk from an existing entity
    | 'observe_entity'   // deeper fact-set dump for one entity
    | 'query';           // structured query by key or entity type

export interface AttendantProposedToolCall {
    name: AttendantProposedToolName;
    args: Record<string, string>;
    reason: string;
    confidence: number; // 0..1
}

export interface AttendantToolPlan {
    proposed: AttendantProposedToolCall[];
    basis: 'brief_entities' | 'drift_tokens' | 'objective_signals' | 'empty';
    note: string;
}

export interface ToolResultExtractionOutcome {
    toolName: PendingToolCallName;
    autowriteBatchId: string;
    factsExtracted: number;
    factsWritten: number;
    skipped: Array<{ reason: string; detail?: string }>;
    writtenEntries: Array<{
        entity: string;
        key: string;
        summary: string;
    }>;
    targetEntity: string;
    durationMs: number;
    extractorError?: string;
}

export interface WriteNudge {
    reason: 'tool_cost_threshold';
    toolCallsSinceLastWrite: number;
    threshold: number;
    draftFacts: Array<{
        entity: string;
        key: string;
        summary: string;
        fromTool: PendingToolCallName;
        autowriteBatchId: string;
    }>;
    message: string;
}

export interface PostResponseCaptureInfo {
    factsExtracted: number;
    factsWritten: number;
    checkpointExtracted: boolean;
    skipped: Array<{ key: string; reason: string }>;
}

// M7: response file-change autowrite — outcome of the post-response scan pass
// that detects file paths in the agent's reply and writes file-scoped entity
// facts so demand-driven recall can surface them in future sessions.
export interface ResponseFileCaptureResult {
    autowriteBatchId: string;
    filesDetected: number;
    factsWritten: number;
    entities: string[];
    skipped: Array<{ reason: string; detail?: string }>;
    durationMs: number;
}

export type MemoryAttributionEvidenceKind =
    | 'write'
    | 'checkpoint'
    | 'rediscovery'
    | 'response_reference'
    | 'response_recovery'
    | 'task_irrelevant';

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
    taskContext?: string;
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
        // Single-word triggers: check token membership first, then substring fallback
        // for short triggers (≤4 chars) that tokenizePresenceText would filter out
        if (contextTokens.has(trigger)) return true;
        if (trigger.length <= 4) {
            // Word-boundary substring match for short triggers like "git", "npm", "ci", "pr"
            const pattern = new RegExp(`(?:^|[^a-z0-9])${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`);
            return pattern.test(contextLower);
        }
        return false;
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

// ─── A2: Pending Tool-Call Entity Hints ─────────────────────────────────────
//
// Derive entity hints from a structured tool call that the agent is about to
// make. This lets attend() preempt redundant read-only tool calls by surfacing
// stored facts keyed to the target of the tool call (a file, a URL, a query).
//
// We deliberately keep this a PURE function so it is trivially unit-testable
// and so the caller can exercise different tool shapes without spinning up an
// attendant. It returns entity hints in `entityType/entityId` form.

function normalizeWebToken(value: string, maxLen = 48): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, maxLen);
}

function deriveFileEntityFromPath(
    rawPath: string,
    projectId: string,
    seen: Set<string>,
    hints: string[],
): void {
    const trimmed = rawPath.trim();
    if (!trimmed) return;
    const basename = trimmed.replace(/\\/g, '/').split('/').pop() ?? '';
    // Strip trailing args like "foo.ts:42" or "foo.ts,bar.ts"
    const stripped = basename.split(/[,:()]/)[0] ?? basename;
    const nameWithoutExt = stripped
        .replace(/\.\w+$/, '')
        .replace(/[^a-zA-Z0-9]/g, '_')
        .toLowerCase();
    if (!nameWithoutExt || nameWithoutExt.length < 2) return;
    const hint = `project/${projectId}/file/${nameWithoutExt}`;
    if (!seen.has(hint)) {
        seen.add(hint);
        hints.push(hint);
    }
}

function scanStringForPathEntities(
    text: string,
    projectId: string,
    seen: Set<string>,
    hints: string[],
): void {
    if (!text) return;
    FILE_PATH_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FILE_PATH_PATTERN.exec(text)) !== null) {
        deriveFileEntityFromPath(match[1], projectId, seen, hints);
    }
}

// M7: infer whether a file path mention in the agent's response represents
// an edit, a creation, or a read. Scans the ±150-char context window for
// action-bearing keywords. Defaults to 'read' when the signal is ambiguous.
// Exported for direct unit testing.
export function detectFileAction(contextWindow: string): 'edited' | 'created' | 'read' {
    const ctx = contextWindow.toLowerCase();
    if (/\bcreat\w*\b|\bnew file\b|\badded new\b|\bwrote new\b/.test(ctx)) return 'created';
    if (/\bedit\w*\b|\bupdat\w*\b|\bmodif\w*\b|\bchanged\b|\bwrote\b|\brewrote\b|\brefactor\w*\b/.test(ctx)) return 'edited';
    return 'read';
}

function extractBasenameFromGlobPattern(pattern: string): string | null {
    // A glob like "src/**/*.ts" has no meaningful basename; one like
    // "tests/attendant/run_mid_turn_attend_tests.ts" does. We only derive a
    // file entity from the last segment if it looks like a literal filename.
    const segments = pattern.replace(/\\/g, '/').split('/');
    for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (!seg || seg.includes('*') || seg.includes('?') || seg === '.' || seg === '..') continue;
        if (/\.\w+$/.test(seg)) return seg;
    }
    return null;
}

/**
 * Derive entity hints from a pending tool call. Pure, stateless, safe to call
 * from tests. Callers should merge the result into `effectiveEntityHints`
 * *after* text-derived hints so text signals still take precedence when a hint
 * appears in both places.
 */
// M2: resolve the best target entity for autowriting facts extracted from a
// tool result. For file-backed tools (Read/Grep/Glob/Bash with a path) we
// prefer a file-scoped entity so that retrieval can narrow to the specific
// file. For WebFetch we use a host-scoped entity. Fallback is the project
// memory entity, and finally a system bucket if no project context exists.
export function resolveAutowriteTargetEntity(
    toolResult: ToolResultPayload,
    projectEntity: string | null,
): string {
    const projectId = projectEntity ? parseEntityString(projectEntity).entityId : null;

    if (toolResult.toolName === 'Read' || toolResult.toolName === 'Grep' || toolResult.toolName === 'Glob') {
        const metadataPath = toolResult.metadata?.path;
        if (projectId && metadataPath) {
            const seen = new Set<string>();
            const hints: string[] = [];
            deriveFileEntityFromPath(metadataPath, projectId, seen, hints);
            if (hints.length > 0) return hints[0];
        }
    }
    if (toolResult.toolName === 'Bash') {
        const command = toolResult.metadata?.command;
        if (projectId && command) {
            const seen = new Set<string>();
            const hints: string[] = [];
            scanStringForPathEntities(command, projectId, seen, hints);
            if (hints.length > 0) return hints[0];
        }
    }
    if (toolResult.toolName === 'WebFetch') {
        const url = toolResult.metadata?.url;
        if (url) {
            try {
                const parsed = new URL(url);
                const host = normalizeWebToken(parsed.hostname);
                if (host) return `web/${host}`;
            } catch {
                // ignore, fall through to project/system
            }
        }
    }
    if (toolResult.toolName === 'WebSearch') {
        const query = toolResult.metadata?.query;
        const token = query ? normalizeWebToken(query) : null;
        if (token) return `web/search_${token}`;
    }

    if (projectEntity) return projectEntity;
    return 'system/tool_result_autowrite';
}

// M2: parse an entity string like "project/iranti" or "project/iranti/file/foo"
// into { entityType, entityId } for librarianWrite. This helper exists because
// parseEntityString() asserts the string is well-formed and we want safe
// fallbacks if a caller passes a bare type.
export function parseAutowriteEntity(entity: string): { entityType: string; entityId: string } {
    const trimmed = entity.trim();
    if (!trimmed.includes('/')) {
        return { entityType: 'system', entityId: trimmed || 'tool_result_autowrite' };
    }
    try {
        const parsed = parseEntityString(trimmed);
        return { entityType: parsed.entityType, entityId: parsed.entityId };
    } catch {
        const [type, ...rest] = trimmed.split('/');
        return {
            entityType: type || 'system',
            entityId: rest.join('/') || 'tool_result_autowrite',
        };
    }
}

// M2: build the per-tool context label that is injected into the extraction
// prompt. Gives the LLM just enough metadata about the origin of the tool
// output so it can decide how to scope each extracted fact.
export function buildToolResultContextLabel(toolResult: ToolResultPayload): string {
    const metadata = toolResult.metadata ?? {};
    const parts: string[] = [];
    if (metadata.path) parts.push(`Path: ${metadata.path}`);
    if (metadata.url) parts.push(`URL: ${metadata.url}`);
    if (metadata.query) parts.push(`Query: ${metadata.query}`);
    if (metadata.command) parts.push(`Command: ${metadata.command}`);
    if (typeof metadata.durationMs === 'number') parts.push(`Duration: ${metadata.durationMs}ms`);
    if (parts.length === 0) return 'No metadata provided.';
    return parts.join('\n');
}

// M2: normalize a parsed JSON fact from the extraction response into the
// shape librarianWrite expects. Returns null for malformed facts so the
// autowrite pipeline can count them as skipped instead of crashing.
export function normalizeAutowriteFact(raw: unknown): {
    key: string;
    value: unknown;
    summary: string;
    confidence: number;
} | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const key = typeof obj.key === 'string' ? obj.key.trim() : '';
    if (!key || !/^[a-zA-Z0-9_]+$/.test(key)) return null;
    if (key.length > 100) return null;
    if (!('value' in obj)) return null;
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    if (!summary) return null;
    let confidence = typeof obj.confidence === 'number' ? obj.confidence : TOOL_RESULT_EXTRACTION_DEFAULT_CONFIDENCE;
    if (!Number.isFinite(confidence)) confidence = TOOL_RESULT_EXTRACTION_DEFAULT_CONFIDENCE;
    if (confidence < 0) confidence = 0;
    if (confidence > 100) confidence = 100;
    return {
        key,
        value: obj.value,
        summary,
        confidence,
    };
}

export function derivePendingToolCallEntityHints(
    toolCall: PendingToolCall | undefined,
    projectEntity: string | null,
): string[] {
    if (!toolCall || !projectEntity) return [];
    const parsed = parseEntityString(projectEntity);
    const projectId = parsed.entityId;
    if (!projectId) return [];

    const args = (toolCall.args ?? {}) as Record<string, unknown>;
    const seen = new Set<string>();
    const hints: string[] = [];

    switch (toolCall.name) {
        case 'Read': {
            const filePath = typeof args.file_path === 'string' ? args.file_path : '';
            if (filePath) {
                deriveFileEntityFromPath(filePath, projectId, seen, hints);
            }
            break;
        }
        case 'Grep': {
            // Grep has pattern + optional path + optional glob. Only path/glob
            // can yield file-level entities; the regex pattern itself is
            // content-level and gets surfaced via the existing text hints from
            // latestMessage/currentContext.
            if (typeof args.path === 'string') {
                deriveFileEntityFromPath(args.path, projectId, seen, hints);
            }
            if (typeof args.glob === 'string') {
                const base = extractBasenameFromGlobPattern(args.glob);
                if (base) deriveFileEntityFromPath(base, projectId, seen, hints);
            }
            break;
        }
        case 'Glob': {
            if (typeof args.pattern === 'string') {
                const base = extractBasenameFromGlobPattern(args.pattern);
                if (base) deriveFileEntityFromPath(base, projectId, seen, hints);
                // If the pattern has no literal basename, fall through to the
                // project entity so stored project-level facts still surface.
            }
            if (typeof args.path === 'string') {
                deriveFileEntityFromPath(args.path, projectId, seen, hints);
            }
            break;
        }
        case 'Bash': {
            // Scan the command string for embedded paths. This covers
            // `cat src/foo.ts`, `rm ./dist/bar.js`, `node scripts/baz.ts`, etc.
            const command = typeof args.command === 'string' ? args.command : '';
            scanStringForPathEntities(command, projectId, seen, hints);
            break;
        }
        case 'WebSearch': {
            const query = typeof args.query === 'string' ? args.query : '';
            const token = normalizeWebToken(query);
            if (token) {
                const hint = `web/search_${token}`;
                if (!seen.has(hint)) {
                    seen.add(hint);
                    hints.push(hint);
                }
            }
            break;
        }
        case 'WebFetch': {
            const url = typeof args.url === 'string' ? args.url : '';
            if (url) {
                try {
                    const parsedUrl = new URL(url);
                    const host = normalizeWebToken(parsedUrl.hostname);
                    if (host) {
                        const hostHint = `web/${host}`;
                        if (!seen.has(hostHint)) {
                            seen.add(hostHint);
                            hints.push(hostHint);
                        }
                    }
                    const path = normalizeWebToken(parsedUrl.pathname);
                    if (host && path && path.length >= 2) {
                        const pathHint = `web/${host}_${path}`;
                        if (!seen.has(pathHint)) {
                            seen.add(pathHint);
                            hints.push(pathHint);
                        }
                    }
                } catch {
                    // Non-URL string — fall back to a normalized token entity.
                    const token = normalizeWebToken(url);
                    if (token) {
                        const hint = `web/${token}`;
                        if (!seen.has(hint)) {
                            seen.add(hint);
                            hints.push(hint);
                        }
                    }
                }
            }
            break;
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

// ─── A4: plan proposal heuristic ────────────────────────────────────────────
//
// Pure functions used by handshake() to build a short structured plan. These
// are exported for test access and intentionally contain no LLM calls so the
// handshake stays fast, deterministic, and snapshot-testable. The templates
// below are deliberately terse and align with the standing Iranti protocol
// (e.g. "write after every edit", "verify CI after push").

const PLAN_MIN_TASK_CHARS = 24;

export type PlanSignal =
    | 'ship_release'
    | 'implement_add'
    | 'refactor_rewrite'
    | 'fix_debug'
    | 'audit_review'
    | 'migrate'
    | 'test_author'
    | 'deploy';

interface PlanSignalMatch {
    signal: PlanSignal;
    matchedKeyword: string;
}

const PLAN_SIGNAL_KEYWORDS: Record<PlanSignal, string[]> = {
    ship_release: ['ship', 'release', 'cut v', 'tag v', 'publish'],
    implement_add: ['implement', 'add', 'build', 'create', 'introduce', 'wire'],
    refactor_rewrite: ['refactor', 'rewrite', 'restructure', 'rename', 'extract'],
    fix_debug: ['fix', 'debug', 'bug', 'repair', 'broken'],
    audit_review: ['audit', 'review', 'inspect', 'check', 'verify'],
    migrate: ['migrate', 'port', 'upgrade', 'backfill'],
    test_author: ['test', 'cover', 'regression', 'assert'],
    deploy: ['deploy', 'rollout', 'promote'],
};

const PLAN_TEMPLATES: Record<PlanSignal, PlanProposalStep[]> = {
    ship_release: [
        { n: 1, description: 'Run tsc --noEmit and the relevant targeted test suite.', rationale: 'Catch type errors and regressions before the commit.' },
        { n: 2, description: 'Run backward-compat regression suites.', rationale: 'Make sure adjacent features still behave.' },
        { n: 3, description: 'Bump version across package.json, clients, and server.ts.', rationale: 'Keep the 5-file version pattern consistent.' },
        { n: 4, description: 'Commit, tag, push, create GitHub Release.', rationale: 'Never npm publish manually — Releases drive publish via CI.' },
        { n: 5, description: 'Watch CI with gh run watch --exit-status and verify all 3 jobs green.', rationale: 'Do not trust the push until Secret Scan + Contract Checks + Release Quality are confirmed green.' },
    ],
    implement_add: [
        { n: 1, description: 'Search Iranti and read existing patterns before writing new code.', rationale: 'Prefer extending established patterns over reinventing.' },
        { n: 2, description: 'Draft the minimum type + data plumbing first.', rationale: 'Shapes force the design before the logic.' },
        { n: 3, description: 'Implement in a single focused edit, iranti_write after each change.', rationale: 'Every edit should leave a durable trail for future sessions.' },
        { n: 4, description: 'Write unit + integration tests, run them locally.', rationale: 'Prove the new surface area before committing.' },
        { n: 5, description: 'Run backward-compat regressions, then commit.', rationale: 'Catch cross-feature breakage before review.' },
    ],
    refactor_rewrite: [
        { n: 1, description: 'Map the current call sites of the symbol or module being changed.', rationale: 'Know the blast radius before editing.' },
        { n: 2, description: 'Sketch the target shape and document the invariant being preserved.', rationale: 'Refactors without a stated invariant drift.' },
        { n: 3, description: 'Perform the refactor in small, compiling increments.', rationale: 'Keep tsc green at every step.' },
        { n: 4, description: 'Run the existing test suite unmodified first.', rationale: 'If old tests still pass, behavior is preserved.' },
        { n: 5, description: 'Add a regression test that locks in the new structural contract.', rationale: 'Prevents silent regression of the refactor goal.' },
    ],
    fix_debug: [
        { n: 1, description: 'Reproduce the bug locally with the minimal repro.', rationale: 'You cannot fix what you cannot reproduce.' },
        { n: 2, description: 'Isolate the failing component with targeted reads and grep.', rationale: 'Narrow the surface before editing.' },
        { n: 3, description: 'Make the smallest change that restores correctness.', rationale: 'Scope creep masks root cause.' },
        { n: 4, description: 'Add a regression test that would have caught the original bug.', rationale: 'Prevents the same bug re-landing later.' },
        { n: 5, description: 'iranti_write the finding, the fix, and the root cause.', rationale: 'Future sessions should not have to rediscover this.' },
    ],
    audit_review: [
        { n: 1, description: 'Enumerate the audit scope: files, subsystems, or issue list.', rationale: 'Audits without scope miss half the surface area.' },
        { n: 2, description: 'For each item, read the current state and iranti_write the finding.', rationale: 'Durable findings are how audits compound across sessions.' },
        { n: 3, description: 'Classify each finding (open / resolved / wontfix) with evidence.', rationale: 'Unclassified findings bit-rot.' },
        { n: 4, description: 'Run the relevant test suites to validate assumptions.', rationale: 'Tests are how assertions become facts.' },
        { n: 5, description: 'Checkpoint the audit summary with open risks and next step.', rationale: 'Hand off cleanly, even if incomplete.' },
    ],
    migrate: [
        { n: 1, description: 'Document the source shape and target shape side by side.', rationale: 'Migrations without a diff have no finish line.' },
        { n: 2, description: 'Write a dry-run path that produces target without mutating source.', rationale: 'Dry runs catch 80% of migration bugs before real data moves.' },
        { n: 3, description: 'Run the dry run, compare against expected, iranti_write the diff.', rationale: 'Evidence for the real run.' },
        { n: 4, description: 'Perform the real migration behind a reversible flag or tx.', rationale: 'Always leave a rollback path.' },
        { n: 5, description: 'Verify + checkpoint + write a post-mortem fact.', rationale: 'Durable record of what changed and why.' },
    ],
    test_author: [
        { n: 1, description: 'Identify the code under test and the contract being locked in.', rationale: 'Tests without a contract are noise.' },
        { n: 2, description: 'Read nearby test files to match conventions.', rationale: 'Consistency reduces review friction.' },
        { n: 3, description: 'Write failing tests first where practical.', rationale: 'TDD catches misaligned assumptions.' },
        { n: 4, description: 'Run the new suite, iterate until green.', rationale: 'Green-on-first-run often means mis-assertion.' },
        { n: 5, description: 'Register the new suite in package.json and iranti_write.', rationale: 'Untracked suites do not run in CI.' },
    ],
    deploy: [
        { n: 1, description: 'Verify CI is green on the target commit before promoting.', rationale: 'Never promote a red build.' },
        { n: 2, description: 'Confirm environment variables and secrets are present.', rationale: 'Most rollouts fail on config, not code.' },
        { n: 3, description: 'Promote, then watch logs and health checks for the first N minutes.', rationale: 'Early rollback is cheap, late rollback is expensive.' },
        { n: 4, description: 'Verify the canary metric crosses the success threshold.', rationale: 'Objective signal beats subjective feeling.' },
        { n: 5, description: 'iranti_write the rollout + any anomalies.', rationale: 'Future deploys inherit this learning.' },
    ],
};

export function detectPlanSignals(task: string): PlanSignalMatch[] {
    const lower = task.toLowerCase();
    const matches: PlanSignalMatch[] = [];
    const seen = new Set<PlanSignal>();
    for (const signal of Object.keys(PLAN_SIGNAL_KEYWORDS) as PlanSignal[]) {
        for (const keyword of PLAN_SIGNAL_KEYWORDS[signal]) {
            if (lower.includes(keyword) && !seen.has(signal)) {
                matches.push({ signal, matchedKeyword: keyword });
                seen.add(signal);
                break;
            }
        }
    }
    return matches;
}

export function buildPlanProposal(
    task: string,
    inferredTaskType: string,
    sessionCheckpoint?: SessionCheckpointRecord | null,
): PlanProposal {
    const combined = [task, inferredTaskType].filter(Boolean).join(' ').trim();

    // Checkpoint continuation takes precedence. If a prior interrupted session
    // exists, the plan leads with "resume from checkpoint" so the agent can
    // pick up in place instead of re-deriving a plan from scratch.
    if (sessionCheckpoint?.status === 'interrupted' && sessionCheckpoint.checkpoint) {
        const nextStep = sessionCheckpoint.checkpoint.nextStep?.trim() ?? '';
        const currentStep = sessionCheckpoint.checkpoint.currentStep?.trim() ?? '';
        const steps: PlanProposalStep[] = [];
        if (nextStep) {
            steps.push({
                n: 1,
                description: `Resume: ${nextStep}`,
                rationale: 'Interrupted session — continue from the recorded next step.',
            });
        }
        if (currentStep) {
            steps.push({
                n: steps.length + 1,
                description: `Re-confirm prior state: ${currentStep}`,
                rationale: 'Verify the recorded current step is still accurate before acting.',
            });
        }
        steps.push({
            n: steps.length + 1,
            description: 'After completing the resumed step, iranti_checkpoint with updated current/next/risks.',
            rationale: 'Close the loop so the next interruption resumes cleanly.',
        });
        return {
            suggested: true,
            reason: 'interrupted_session_checkpoint_found',
            source: 'checkpoint_continuation',
            steps,
            taskSignals: ['resume_from_checkpoint'],
            note: 'This plan was derived from the persisted session checkpoint, not the current task string.',
        };
    }

    // Keyword heuristic for normal (non-resume) tasks.
    const tooShort = combined.length < PLAN_MIN_TASK_CHARS;
    const signals = detectPlanSignals(combined);

    if (tooShort && signals.length === 0) {
        return {
            suggested: false,
            reason: 'task_too_short_and_no_plan_signals_detected',
            source: 'skipped',
            steps: [],
            taskSignals: [],
        };
    }

    if (signals.length === 0) {
        return {
            suggested: false,
            reason: 'no_complexity_keywords_detected',
            source: 'skipped',
            steps: [],
            taskSignals: [],
        };
    }

    // Pick the highest-priority signal (ship > migrate > deploy > refactor >
    // fix > audit > implement > test) when multiple match, then emit that
    // template. Priority captures "what matters most to plan around" when a
    // single task hits several verbs.
    const priority: PlanSignal[] = [
        'ship_release',
        'migrate',
        'deploy',
        'refactor_rewrite',
        'fix_debug',
        'audit_review',
        'implement_add',
        'test_author',
    ];
    const topSignal = priority.find((sig) => signals.some((s) => s.signal === sig))
        ?? signals[0]!.signal;
    const template = PLAN_TEMPLATES[topSignal];

    return {
        suggested: true,
        reason: `matched_signal_${topSignal}`,
        source: 'heuristic_keyword',
        steps: template.map((step) => ({ ...step })),
        taskSignals: signals.map((s) => s.signal),
        note: signals.length > 1
            ? `Multiple plan signals detected (${signals.map((s) => s.signal).join(', ')}); surfaced ${topSignal} template by priority.`
            : undefined,
    };
}

// ----------------------------------------------------------------------------
// A6: objective memory — pure derivation of a SessionObjective from a task
// string (and optionally an interrupted checkpoint's nextStep). No LLM call.
// Uses a small action-verb list to anchor the objective; nouns are extracted
// as supporting signals. Deterministic so handshakes remain fast and
// snapshot-testable.
// ----------------------------------------------------------------------------

const OBJECTIVE_MIN_TASK_CHARS = 6;
// Action verbs that signal "what the agent is DOING". Ordered by priority —
// the first match wins so "refactor the auth flow" becomes "refactor" not
// "authenticate" even if both verbs appear in the text.
const OBJECTIVE_ACTION_VERBS: readonly string[] = [
    'ship', 'release', 'deploy', 'publish',
    'implement', 'build', 'add', 'create',
    'refactor', 'rewrite', 'redesign', 'rework',
    'fix', 'patch', 'repair', 'resolve',
    'audit', 'review', 'inspect', 'verify',
    'migrate', 'port', 'convert',
    'debug', 'investigate', 'diagnose',
    'test', 'validate', 'benchmark',
    'document', 'explain', 'describe',
    'extend', 'enhance', 'improve',
    'remove', 'delete', 'retire',
];
const OBJECTIVE_NOISE_TOKENS = new Set<string>([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'than',
    'are', 'was', 'were', 'has', 'had', 'have', 'but', 'not', 'its',
    'you', 'your', 'our', 'their', 'them', 'they',
    'all', 'any', 'one', 'two', 'can', 'will', 'should', 'would', 'could',
    'just', 'also', 'now', 'still', 'yet',
    'task', 'work', 'please', 'help',
]);
const OBJECTIVE_MAX_SIGNALS = 8;

function extractObjectiveSignals(task: string): { verb: string | null; signals: string[] } {
    const lower = task.toLowerCase();
    const tokens = lower.replace(/[^a-z0-9_\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return { verb: null, signals: [] };
    }
    let verb: string | null = null;
    for (const candidate of OBJECTIVE_ACTION_VERBS) {
        if (tokens.includes(candidate) || tokens.includes(`${candidate}s`) || tokens.includes(`${candidate}ed`) || tokens.includes(`${candidate}ing`)) {
            verb = candidate;
            break;
        }
    }
    const signals: string[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
        if (t.length < 3) continue;
        if (OBJECTIVE_NOISE_TOKENS.has(t)) continue;
        if (verb && (t === verb || t === `${verb}s` || t === `${verb}ed` || t === `${verb}ing`)) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        signals.push(t);
        if (signals.length >= OBJECTIVE_MAX_SIGNALS) break;
    }
    return { verb, signals };
}

export function deriveSessionObjective(options: {
    task: string;
    recentMessages?: readonly string[];
    checkpointNextStep?: string | null;
    now?: string;
}): SessionObjective {
    const { task, checkpointNextStep, now } = options;
    const derivedAt = now ?? new Date().toISOString();
    const trimmed = (task ?? '').trim();

    // Checkpoint continuation wins when the task string is ambiguous or the
    // session was interrupted. A checkpoint nextStep is always a stronger
    // signal than a keyword-template on the task string because the agent
    // chose the wording.
    if (checkpointNextStep && checkpointNextStep.trim().length >= OBJECTIVE_MIN_TASK_CHARS) {
        const nextStep = checkpointNextStep.trim();
        const { signals } = extractObjectiveSignals(nextStep);
        return {
            primary: nextStep.length <= 120 ? nextStep : `${nextStep.slice(0, 117)}...`,
            taskSignals: signals,
            confidence: 0.95,
            source: 'checkpoint_continuation',
            derivedAt,
            note: `Session objective carried forward from interrupted checkpoint: "${nextStep.length <= 80 ? nextStep : nextStep.slice(0, 77) + '...'}"`,
        };
    }

    if (!trimmed || trimmed.length < OBJECTIVE_MIN_TASK_CHARS) {
        return {
            primary: trimmed || '(no task stated)',
            taskSignals: [],
            confidence: 0,
            source: 'skipped',
            derivedAt,
            note: 'Task string was empty or too short to derive a structured objective.',
        };
    }

    const { verb, signals } = extractObjectiveSignals(trimmed);
    const primaryRaw = verb && signals.length > 0
        ? `${verb} ${signals.slice(0, 4).join(' ')}`
        : verb
            ? verb
            : signals.length > 0
                ? signals.slice(0, 4).join(' ')
                : trimmed.slice(0, 60);
    const primary = primaryRaw.length <= 120 ? primaryRaw : `${primaryRaw.slice(0, 117)}...`;

    // Confidence scoring: verb present AND signals present -> 1.0; verb or
    // signals alone -> 0.6; neither -> 0.3 (we still produced a primary from
    // the raw task string).
    const confidence = verb && signals.length > 0
        ? 1
        : verb || signals.length > 0
            ? 0.6
            : 0.3;

    return {
        primary,
        taskSignals: signals,
        confidence,
        source: 'task_string',
        derivedAt,
        note: verb
            ? `Objective derived from task: action="${verb}", subjects=[${signals.slice(0, 4).join(', ')}].`
            : `Objective derived from task subjects only: [${signals.slice(0, 4).join(', ')}].`,
    };
}

// ----------------------------------------------------------------------------
// M1: skipTool with teeth — pure derivation of a structured skip verdict.
// Inputs: derived entity hints, stored facts that matched those entities,
// and whether the early-return "memory not needed" branch was taken.
// Output: { shouldSkip, skipConfidence, skipReasonCode } ready to drop into
// a ToolCallGuidance record.
// ----------------------------------------------------------------------------

export interface SkipVerdict {
    shouldSkip: boolean;
    skipConfidence: number;
    skipReasonCode: ToolCallGuidance['skipReasonCode'];
}

// Confidence on FactInjection is stored 0..100 (see KnowledgeEntry). M1 surfaces
// 0..1 to keep the field intuitive on the wire; the helper below scales once.
export function deriveSkipVerdict(options: {
    derivedEntities: readonly string[];
    factConfidences: readonly number[];
    memoryWasSkipped: boolean;
}): SkipVerdict {
    const { derivedEntities, factConfidences, memoryWasSkipped } = options;

    if (memoryWasSkipped) {
        // Early return path: decideMemoryNeed already said "no memory needed".
        // We intentionally do NOT recommend a skip here — absence of facts is
        // not evidence the tool call is redundant; it's evidence attend never
        // looked. Hosts that want to skip on this path should gate on
        // factCount, not on memoryWasSkipped.
        return {
            shouldSkip: false,
            skipConfidence: 0,
            skipReasonCode: 'memory_not_needed',
        };
    }

    if (derivedEntities.length === 0) {
        return {
            shouldSkip: false,
            skipConfidence: 0,
            skipReasonCode: 'no_entities_derived',
        };
    }

    if (factConfidences.length === 0) {
        return {
            shouldSkip: false,
            skipConfidence: 0,
            skipReasonCode: 'no_facts_for_target',
        };
    }

    const mean = factConfidences.reduce((acc, c) => acc + c, 0) / factConfidences.length;
    // Clamp to [0..100] before scaling to [0..1]; hostile inputs should not
    // produce negative or >1 confidences on the wire.
    const clamped = Math.max(0, Math.min(100, mean));
    return {
        shouldSkip: true,
        skipConfidence: Math.round((clamped / 100) * 1000) / 1000,
        skipReasonCode: 'facts_cover_target',
    };
}

// ----------------------------------------------------------------------------
// M4: drift detection — pure Jaccard overlap between the current
// message/context and the declared (inferred) task type. Hosts can use the
// returned DriftSignal to surface "you set out to do X, you're now doing Y"
// to the user or to force a task-shift reconvene.
// ----------------------------------------------------------------------------

const DRIFT_MIN_MESSAGE_CHARS = 20;
const DRIFT_JACCARD_MIN = 0.15;
const DRIFT_TOKEN_STOP = new Set<string>([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'than',
    'are', 'was', 'were', 'has', 'had', 'have', 'but', 'not', 'its', 'it\'s',
    'you', 'your', 'our', 'their', 'them', 'they', 'who', 'what', 'when', 'where',
    'why', 'how', 'all', 'any', 'each', 'one', 'two', 'new', 'old', 'can', 'will',
    'should', 'would', 'could', 'just', 'also', 'now', 'still', 'yet', 'off', 'out',
    'ok', 'okay', 'yeah', 'sure', 'keep', 'going', 'done',
]);
const DRIFT_MAX_DRIVING_TOKENS = 6;

function tokenizeForDrift(text: string): Set<string> {
    if (!text) return new Set();
    const tokens = text
        .toLowerCase()
        .replace(/[^a-z0-9_\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !DRIFT_TOKEN_STOP.has(t));
    return new Set(tokens);
}

export function detectTaskDrift(
    currentMessage: string,
    currentContext: string,
    declaredTaskType: string,
): DriftSignal | undefined {
    const combinedCurrent = `${currentMessage ?? ''} ${currentContext ?? ''}`.trim();
    if (combinedCurrent.length < DRIFT_MIN_MESSAGE_CHARS) {
        // Too little signal to make a judgment — stay silent.
        return undefined;
    }
    if (!declaredTaskType || declaredTaskType.length < 3) {
        return undefined;
    }

    const currentTokens = tokenizeForDrift(combinedCurrent);
    const declaredTokens = tokenizeForDrift(declaredTaskType);

    if (currentTokens.size === 0 || declaredTokens.size === 0) {
        return undefined;
    }

    let intersectionSize = 0;
    for (const t of currentTokens) {
        if (declaredTokens.has(t)) intersectionSize += 1;
    }
    const unionSize = currentTokens.size + declaredTokens.size - intersectionSize;
    const overlap = unionSize === 0 ? 0 : intersectionSize / unionSize;

    if (overlap >= DRIFT_JACCARD_MIN) {
        // No drift detected — return undefined so the field is absent on the
        // wire for the common healthy case.
        return undefined;
    }

    const drivingTokens: string[] = [];
    for (const t of currentTokens) {
        if (!declaredTokens.has(t)) {
            drivingTokens.push(t);
            if (drivingTokens.length >= DRIFT_MAX_DRIVING_TOKENS) break;
        }
    }
    const missingTokens: string[] = [];
    for (const t of declaredTokens) {
        if (!currentTokens.has(t)) {
            missingTokens.push(t);
            if (missingTokens.length >= DRIFT_MAX_DRIVING_TOKENS) break;
        }
    }

    return {
        detected: true,
        overlap: Math.round(overlap * 1000) / 1000,
        drivingTokens,
        missingTokens,
        declaredTaskType,
        note: `Task drift detected: current context overlaps declared task by ${(overlap * 100).toFixed(1)}%. Driving topic tokens: ${drivingTokens.slice(0, 4).join(', ') || '(none)'}.`,
    };
}

// ----------------------------------------------------------------------------
// M5: auto-checkpoint trigger — pure decision function. Returns undefined
// when no trigger fires so the field is absent from the attend result shape
// in the healthy common case. Pairs with A6 (objective memory) so the draft
// currentStep/nextStep surfaces can use the stored sessionObjective without
// threading it through every call site.
// ----------------------------------------------------------------------------

export const AUTO_CHECKPOINT_TOOL_COST_THRESHOLD = 15;
export const AUTO_CHECKPOINT_TURN_THRESHOLD = 3;

export function detectAutoCheckpointTrigger(options: {
    toolCallsSinceLastWrite: number;
    turnsWithoutWrite: number;
    driftDetected: boolean;
    driftOverlap?: number | null;
    sessionObjective?: SessionObjective | null;
    driftDrivingTokens?: readonly string[];
}): AutoCheckpointSignal | undefined {
    const {
        toolCallsSinceLastWrite,
        turnsWithoutWrite,
        driftDetected,
        driftOverlap,
        sessionObjective,
        driftDrivingTokens,
    } = options;

    // Priority: drift > turns_without_write > tool_cost. Drift is the
    // highest-urgency signal because it means the agent is solving a
    // different problem than the one the session was handshaken for.
    if (driftDetected) {
        const drivers = driftDrivingTokens && driftDrivingTokens.length > 0
            ? driftDrivingTokens.slice(0, 4).join(', ')
            : '(unspecified)';
        const draftCurrentStep = sessionObjective?.primary
            ? `Was working on: ${sessionObjective.primary}`
            : 'Was working on prior task (objective not captured).';
        const draftNextStep = `New focus appears to be: ${drivers}. Checkpoint the prior objective before continuing.`;
        return {
            reason: 'drift_detected',
            urgency: 'critical',
            toolCallsSinceLastWrite,
            turnsWithoutWrite,
            driftOverlap: typeof driftOverlap === 'number' ? driftOverlap : null,
            draftCurrentStep,
            draftNextStep,
            message: `AUTO-CHECKPOINT SIGNAL: drift detected (overlap ${typeof driftOverlap === 'number' ? (driftOverlap * 100).toFixed(1) + '%' : 'unknown'}). Before switching focus to "${drivers}", call iranti_checkpoint to preserve progress on the prior objective.`,
        };
    }

    if (turnsWithoutWrite >= AUTO_CHECKPOINT_TURN_THRESHOLD) {
        const draftCurrentStep = sessionObjective?.primary
            ? `In progress: ${sessionObjective.primary} (${turnsWithoutWrite} active turns without a durable write)`
            : `${turnsWithoutWrite} active turns without a durable write.`;
        return {
            reason: 'turns_without_write',
            urgency: 'strong',
            toolCallsSinceLastWrite,
            turnsWithoutWrite,
            driftOverlap: null,
            draftCurrentStep,
            draftNextStep: 'Persist what has been learned so far, then continue.',
            message: `AUTO-CHECKPOINT SIGNAL: ${turnsWithoutWrite} active turns have elapsed without iranti_checkpoint or iranti_write. Call iranti_checkpoint now so progress on "${sessionObjective?.primary ?? 'current task'}" is durable before the next shift.`,
        };
    }

    if (toolCallsSinceLastWrite >= AUTO_CHECKPOINT_TOOL_COST_THRESHOLD) {
        const draftCurrentStep = sessionObjective?.primary
            ? `Running exploration for: ${sessionObjective.primary} (${toolCallsSinceLastWrite} tool calls since last write)`
            : `${toolCallsSinceLastWrite} tool calls since last durable write.`;
        const objectiveTag = sessionObjective?.primary
            ? ` on "${sessionObjective.primary}"`
            : '';
        return {
            reason: 'tool_cost_threshold',
            urgency: 'suggested',
            toolCallsSinceLastWrite,
            turnsWithoutWrite,
            driftOverlap: null,
            draftCurrentStep,
            draftNextStep: 'Summarize what has been discovered and continue.',
            message: `AUTO-CHECKPOINT SIGNAL: ${toolCallsSinceLastWrite} tool calls have run since the last durable write${objectiveTag}. Consider calling iranti_checkpoint to persist discoveries before continuing.`,
        };
    }

    return undefined;
}

// ----------------------------------------------------------------------------
// A3: iterative exploration — bounded refinement pass planning
// ----------------------------------------------------------------------------
// When initial retrieval returns empty but memory was wanted, produce a
// deterministic refinement plan: broaden entity hints (strip the key
// segment, keeping only the entity type + id), and pick fallback search
// terms from the latest user message (action verbs + content tokens
// minus stopwords). The plan is bounded to one retry so latency stays
// predictable. Pure: no instance state access, no LLM, snapshot-testable.
// ----------------------------------------------------------------------------

const REFINEMENT_STOPWORDS = new Set<string>([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'for',
    'to', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was',
    'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
    'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can', 'this',
    'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
    'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our',
    'their', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why',
    'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
    'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
    'very', 'just', 'also', 'please', 'thanks', 'thank',
]);

const REFINEMENT_MAX_FALLBACK_TERMS = 6;
const REFINEMENT_MIN_TERM_LENGTH = 3;

export function planRefinementPass(options: {
    initialFactCount: number;
    decisionNeeded: boolean;
    phase?: 'pre-response' | 'mid-turn' | 'post-response';
    entityHints: readonly string[];
    latestMessage: string;
}): RefinementPass {
    const { initialFactCount, decisionNeeded, phase, entityHints, latestMessage } = options;

    // Gate 1: post-response never refines — it's a closeout path.
    if (phase === 'post-response') {
        return {
            outcome: 'declined_post_response',
            attempted: false,
            initialFactCount,
            addedFactCount: 0,
            widenedEntityHints: [],
            fallbackTerms: [],
            reason: 'post_response_closeout',
            note: 'Refinement is gated off on post-response attends.',
        };
    }

    // Gate 2: if memory was not needed at all, there's nothing to refine.
    // Same if the first pass returned facts — skip cheaply.
    if (!decisionNeeded || initialFactCount > 0) {
        return {
            outcome: 'not_needed',
            attempted: false,
            initialFactCount,
            addedFactCount: 0,
            widenedEntityHints: [],
            fallbackTerms: [],
            reason: initialFactCount > 0 ? 'initial_pass_returned_facts' : 'memory_not_needed',
            note: 'No refinement pass required.',
        };
    }

    // Gate 3: widen entity hints by keeping only the first two segments
    // (entityType/entityId) so downstream retrieval matches siblings of
    // the originally targeted key. A hint that already has only two
    // segments is kept as-is.
    const widened: string[] = [];
    const seenWidened = new Set<string>();
    for (const hint of entityHints) {
        if (typeof hint !== 'string') continue;
        const trimmed = hint.trim();
        if (!trimmed) continue;
        const parts = trimmed.split('/').filter((p) => p.length > 0);
        const widenedHint = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : trimmed;
        if (!seenWidened.has(widenedHint)) {
            seenWidened.add(widenedHint);
            widened.push(widenedHint);
        }
    }

    // Gate 4: extract fallback search terms from the latest message.
    // Lowercase, strip punctuation, filter stopwords and short tokens,
    // dedupe, cap.
    const fallbackTerms: string[] = [];
    const seenTerms = new Set<string>();
    const normalized = (latestMessage || '').toLowerCase().replace(/[^a-z0-9_\-\s]/g, ' ');
    for (const token of normalized.split(/\s+/)) {
        if (!token) continue;
        if (token.length < REFINEMENT_MIN_TERM_LENGTH) continue;
        if (REFINEMENT_STOPWORDS.has(token)) continue;
        if (seenTerms.has(token)) continue;
        seenTerms.add(token);
        fallbackTerms.push(token);
        if (fallbackTerms.length >= REFINEMENT_MAX_FALLBACK_TERMS) break;
    }

    // Gate 5: if we have neither widened hints nor fallback terms, the
    // retry would be blind. Decline so the attend returns empty cleanly
    // rather than thrashing.
    if (widened.length === 0 && fallbackTerms.length === 0) {
        return {
            outcome: 'declined_no_hints',
            attempted: false,
            initialFactCount,
            addedFactCount: 0,
            widenedEntityHints: [],
            fallbackTerms: [],
            reason: 'no_widened_hints_and_no_fallback_terms',
            note: 'Initial retrieval was empty but refinement has no entities to widen and no fallback terms to search — refusing a blind retry.',
        };
    }

    return {
        outcome: 'attempted_empty', // filled to attempted_added by caller if retry returned facts
        attempted: true,
        initialFactCount,
        addedFactCount: 0,
        widenedEntityHints: widened,
        fallbackTerms,
        reason: 'initial_pass_empty_retry_planned',
        note: `Initial retrieval returned 0 facts. Retrying with ${widened.length} widened entity hint(s) and ${fallbackTerms.length} fallback term(s).`,
    };
}

// ----------------------------------------------------------------------------
// A5: tool-using Attendant — planned (not executed) tool-call surface
// ----------------------------------------------------------------------------
// Given the brief, the latest message, the current entity hints, and the
// initial retrieval fact count, derive a small list of follow-up tool
// calls the host COULD run autonomously. Pure, deterministic — no LLM,
// no execution. This is the A4 plan-proposal pattern applied to tool
// invocations: the Attendant describes what it would do next given more
// budget, and the host decides whether to honor the plan or not.
//
// Priority of proposals:
//  1. search_related on the top detected entity when brief has entities
//     but retrieval returned nothing — walk the relatedness graph.
//  2. observe_entity on the first entity hint when the brief is present
//     but the host supplied no hints for the latest message.
//  3. query using the session objective's top signal when one exists.
// ----------------------------------------------------------------------------

const ATTENDANT_TOOL_PLAN_MAX_PROPOSALS = 3;

export function planAttendantToolCalls(options: {
    phase?: 'pre-response' | 'mid-turn' | 'post-response';
    entityHints: readonly string[];
    initialFactCount: number;
    sessionObjective?: SessionObjective | null;
    drift?: DriftSignal | undefined;
    briefHasEntities: boolean;
}): AttendantToolPlan {
    const {
        phase,
        entityHints,
        initialFactCount,
        sessionObjective,
        drift,
        briefHasEntities,
    } = options;

    // Gate 1: post-response is a closeout — no planned tool use.
    if (phase === 'post-response') {
        return {
            proposed: [],
            basis: 'empty',
            note: 'Attendant tool plan is gated off on post-response attends.',
        };
    }

    const proposed: AttendantProposedToolCall[] = [];
    let basis: AttendantToolPlan['basis'] = 'empty';

    // Proposal 1: search_related when the host gave us a concrete entity
    // hint but the first retrieval pass came back empty. Walk the graph.
    if (entityHints.length > 0 && initialFactCount === 0) {
        proposed.push({
            name: 'search_related',
            args: { entity: entityHints[0], depth: '1' },
            reason: 'initial_retrieval_empty_walk_relatedness_graph',
            confidence: 0.75,
        });
        basis = 'brief_entities';
    }

    // Proposal 2: observe_entity on the top hint when we haven't dumped
    // its full fact set yet. Useful when the attend bounds kept facts to
    // a small maxFacts budget but the host could benefit from the full
    // entity view.
    if (entityHints.length > 0 && proposed.length < ATTENDANT_TOOL_PLAN_MAX_PROPOSALS) {
        proposed.push({
            name: 'observe_entity',
            args: { entity: entityHints[0], limit: '10' },
            reason: 'enumerate_all_known_facts_for_top_entity',
            confidence: 0.6,
        });
        if (basis === 'empty') basis = 'brief_entities';
    }

    // Proposal 3: query by the session objective's strongest signal token
    // when one exists — drives cross-entity recall that a pure
    // entity-hint lookup would miss.
    if (
        sessionObjective?.taskSignals?.length
        && proposed.length < ATTENDANT_TOOL_PLAN_MAX_PROPOSALS
    ) {
        const topSignal = sessionObjective.taskSignals[0];
        if (typeof topSignal === 'string' && topSignal.length >= REFINEMENT_MIN_TERM_LENGTH) {
            proposed.push({
                name: 'query',
                args: { key: topSignal },
                reason: 'session_objective_top_signal_structured_query',
                confidence: 0.55,
            });
            basis = 'objective_signals';
        }
    }

    // If drift fired and we still have budget, propose a drift-driven
    // search so the host can surface facts on the NEW direction quickly.
    if (
        drift?.detected
        && drift.drivingTokens.length > 0
        && proposed.length < ATTENDANT_TOOL_PLAN_MAX_PROPOSALS
    ) {
        proposed.push({
            name: 'query',
            args: { key: drift.drivingTokens[0] },
            reason: 'drift_detected_query_new_driving_topic',
            confidence: 0.65,
        });
        basis = 'drift_tokens';
    }

    if (proposed.length === 0) {
        if (!briefHasEntities && entityHints.length === 0) {
            return {
                proposed: [],
                basis: 'empty',
                note: 'No brief entities and no hints — Attendant has nothing to propose without more signal.',
            };
        }
        return {
            proposed: [],
            basis: 'empty',
            note: 'Attendant found no gap worth proposing extra tool calls for this turn.',
        };
    }

    const proposalNames = proposed.map((p) => p.name).join(', ');
    return {
        proposed,
        basis,
        note: `Attendant proposes ${proposed.length} follow-up tool call(s): ${proposalNames}. Host may execute any subset.`,
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

/**
 * Determine whether injected facts are relevant to the current task context.
 * Uses token overlap between the task description and fact keys/summaries.
 * Exported for unit testing.
 */
export function injectedFactsAreTaskRelevant(
    taskContext: string | undefined,
    injectedKeys: string[],
    injectedSummaries: string[] | undefined,
): boolean {
    if (!taskContext) return true;
    const taskTokens = new Set(tokenize(taskContext));
    if (taskTokens.size === 0) return true;

    for (const entityKey of injectedKeys) {
        const key = entityKey.split('/').slice(2).join('/');
        for (const token of tokenize(key.replace(/[_/.-]+/g, ' '))) {
            if (taskTokens.has(token)) return true;
        }
    }

    if (injectedSummaries && injectedSummaries.length > 0) {
        const contentTokens = injectedSummaries
            .flatMap((s) => tokenize(s).filter((t) => t.length > 5));
        let contentMatches = 0;
        for (const token of contentTokens) {
            if (taskTokens.has(token)) {
                contentMatches++;
                if (contentMatches >= 2) return true;
            }
        }
    }

    return false;
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
    // M3: tool-cost counter — incremented every time M2 extraction runs on a
    // mid-turn attend, reset every time a durable write is recorded. When it
    // crosses TOOL_COST_WRITE_NUDGE_THRESHOLD we force-inject a write nudge.
    private toolCallsSinceLastWrite: number = 0;
    // M3: recent extractions buffer. Populated by M2 autowrites, consumed by
    // M3 nudges. Bounded to keep the nudge block under a single screenful.
    private recentAutowriteBatches: Array<{
        autowriteBatchId: string;
        toolName: PendingToolCallName;
        occurredAt: string;
        factCount: number;
        writtenEntries: Array<{ entity: string; key: string; summary: string }>;
    }> = [];
    // M3: tracks whether the current turn has already forced a nudge so we do
    // not nag repeatedly within the same turn.
    private writeNudgeEmittedThisTurn: boolean = false;

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
        taskContext?: string;
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
            taskContext: input.taskContext,
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

    private checkInjectedFactsTaskRelevant(attribution: MemoryAttributionResult): boolean {
        return injectedFactsAreTaskRelevant(
            attribution.taskContext,
            attribution.injectedKeys,
            attribution.injectedSummaries,
        );
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
            // Check task-relevance: if facts are not relevant to the current task,
            // mark as task_irrelevant so the compliance scorer does not penalize.
            const taskRelevant = this.checkInjectedFactsTaskRelevant(entry);
            if (!taskRelevant && !evidenceKinds.includes('task_irrelevant')) {
                evidenceKinds.push('task_irrelevant');
            }

            const used = evidenceKinds.includes('write')
                || evidenceKinds.includes('checkpoint')
                || evidenceKinds.includes('response_reference')
                || evidenceKinds.includes('response_recovery')
                || evidenceKinds.includes('task_irrelevant');
            const helpful = evidenceKinds.includes('checkpoint')
                || evidenceKinds.includes('write')
                || evidenceKinds.includes('response_recovery');

            const reason = helpful
                ? 'response_or_action_confirmed_memory_helpfulness'
                : evidenceKinds.includes('task_irrelevant')
                    ? 'injected_facts_not_relevant_to_current_task'
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

        // A6: derive structured session objective from the task string (or
        // from an interrupted checkpoint's nextStep if one exists). Pure, no
        // LLM. Stays on the brief across turns so drift/auto-checkpoint can
        // reason about "what the session was for" without re-parsing the
        // task every call.
        const sessionObjective = deriveSessionObjective({
            task: context.task,
            recentMessages: context.recentMessages,
            checkpointNextStep: this.sessionCheckpoint?.checkpoint?.nextStep ?? null,
        });

        this.brief = {
            agentId: this.agentId,
            operatingRules: operatingRulesPayload,
            inferredTaskType,
            sessionObjective,
            workingMemory: workingMemoryWithLedger,
            projectPolicies,
            sessionStarted: persisted?.sessionStarted ?? this.sessionStarted,
            briefGeneratedAt: new Date().toISOString(),
            contextCallCount: this.contextCallCount,
            backfillSuggestion: buildBackfillSuggestion(context, workingMemoryWithLedger),
            // A4: plan proposal derived from the task + inferred task type + any
            // prior interrupted checkpoint. Pure + fast, never calls the LLM.
            planProposal: buildPlanProposal(context.task, inferredTaskType, this.sessionCheckpoint),
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
        // A6: re-derive the session objective on task shift so drift and
        // auto-checkpoint logic track against the NEW task, not the one the
        // session was originally handshaken with.
        const shiftedObjective = deriveSessionObjective({
            task: context.task,
            recentMessages: context.recentMessages,
            checkpointNextStep: this.sessionCheckpoint?.checkpoint?.nextStep ?? null,
        });
        this.brief = {
            ...this.brief,
            operatingRules: applyAdvisoryOperatingRules(
                applyProjectPolicyOperatingRules(await this.loadOperatingRules(), projectPolicies),
                this.advisoryLearningProfile,
            ),
            inferredTaskType: newTaskType,
            sessionObjective: shiftedObjective,
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

    // M2: run fact extraction on the content of a just-completed read-only
    // tool call and persist the extracted facts to the knowledge library with
    // source='attendant_autowrite' and properties.autowriteBatchId set to the
    // shared batch identifier, so they are distinguishable from host writes
    // and reversible as a group.
    //
    // This helper is intentionally isolated from the main attend pipeline:
    // extraction failures (malformed JSON, mock returning nothing, downstream
    // write errors) MUST NOT abort the attend call. On failure we return a
    // zero-fact outcome with extractorError set and the attend response is
    // otherwise unaffected.
    private async runToolResultAutowrite(
        toolResult: ToolResultPayload,
        autowriteBatchId: string,
    ): Promise<ToolResultExtractionOutcome> {
        const extractionStart = Date.now();
        const skipped: Array<{ reason: string; detail?: string }> = [];

        const projectEntity = getProjectMemoryEntity() ?? null;
        const targetEntityString = resolveAutowriteTargetEntity(toolResult, projectEntity);
        const targetEntity = parseAutowriteEntity(targetEntityString);

        const baseOutcome: ToolResultExtractionOutcome = {
            toolName: toolResult.toolName,
            autowriteBatchId,
            factsExtracted: 0,
            factsWritten: 0,
            skipped,
            writtenEntries: [],
            targetEntity: targetEntityString,
            durationMs: 0,
        };

        if (toolResult.status !== 'success') {
            skipped.push({ reason: 'tool_result_not_success', detail: toolResult.status });
            baseOutcome.durationMs = Date.now() - extractionStart;
            return baseOutcome;
        }

        const rawContent = typeof toolResult.content === 'string' ? toolResult.content : '';
        if (rawContent.trim().length < TOOL_RESULT_EXTRACTION_MIN_CHARS) {
            skipped.push({ reason: 'tool_result_too_short' });
            baseOutcome.durationMs = Date.now() - extractionStart;
            return baseOutcome;
        }

        const excerpt = rawContent.length > TOOL_RESULT_EXTRACTION_HEAD_CHARS
            ? `${rawContent.slice(0, TOOL_RESULT_EXTRACTION_HEAD_CHARS)}\n...[truncated at ${TOOL_RESULT_EXTRACTION_HEAD_CHARS} chars of ${rawContent.length}]`
            : rawContent;

        const contextLabel = buildToolResultContextLabel(toolResult);

        let parsed: unknown;
        let providerUsed = 'unknown';
        let modelUsed = 'unknown';
        try {
            const response = await route('extraction', [
                {
                    role: 'user',
                    content: `You are extracting structured facts from the output of a read-only tool call that an agent just executed.

Tool: ${toolResult.toolName}
${contextLabel}
Target entity: ${targetEntityString}

Tool output:
"""
${excerpt}
"""

Extract up to ${TOOL_RESULT_EXTRACTION_MAX_FACTS} distinct durable facts that would help a future agent avoid re-running this same tool call. Focus on:
- What the file or resource IS (purpose, role, exports, key types)
- Concrete line ranges for interesting declarations
- Configuration values that look canonical
- Public API shapes surfaced by the output
- For Bash output: environment state, versions, command results that describe durable reality
- For WebFetch/WebSearch: confirmed external facts only (not transient snippets)

Rules:
- Discard vague impressions, recommendations, and unsupported inferences
- Each fact must be concrete enough that another agent reading it could skip re-running the tool
- If the output is a test run or log, extract only durable signal (what passed, what failed, what is now known), not transient progress
- Do not invent keys or values

Return ONLY a valid JSON array. No explanation, no markdown, no backticks.
Each fact must have:
- key: a short snake_case identifier (e.g. "exports", "line_ranges", "config_port", "test_result")
- value: a concrete JSON value (string, number, boolean, array, or object)
- summary: a one-sentence natural-language summary
- confidence: integer 0-100 based on how explicitly the fact appears in the tool output

Example:
[
  {"key": "purpose", "value": "HTTP route registration for /attend endpoint", "summary": "File defines the POST /attend Express route with validation middleware.", "confidence": 92},
  {"key": "line_range_attend_handler", "value": {"start": 343, "end": 371}, "summary": "Attend handler lives at lines 343-371.", "confidence": 95}
]

If no durable facts can be extracted, return an empty array: [].`,
                },
            ], 1024);
            providerUsed = response.providerUsed;
            modelUsed = response.model;
            const clean = response.text.replace(/```json|```/g, '').trim();
            parsed = JSON.parse(clean);
        } catch (err) {
            baseOutcome.extractorError = err instanceof Error ? err.message : String(err);
            baseOutcome.durationMs = Date.now() - extractionStart;
            skipped.push({ reason: 'extractor_failure', detail: baseOutcome.extractorError });
            return baseOutcome;
        }

        if (!Array.isArray(parsed) || parsed.length === 0) {
            skipped.push({ reason: 'no_facts_extracted' });
            baseOutcome.durationMs = Date.now() - extractionStart;
            return baseOutcome;
        }

        const capped = parsed.slice(0, TOOL_RESULT_EXTRACTION_MAX_FACTS);
        baseOutcome.factsExtracted = capped.length;

        const writtenEntries: Array<{ entity: string; key: string; summary: string }> = [];
        for (const rawFact of capped) {
            const fact = normalizeAutowriteFact(rawFact);
            if (!fact) {
                skipped.push({ reason: 'fact_shape_invalid' });
                continue;
            }

            const ingestMetadata = {
                method: 'tool_result_extraction',
                provider: providerUsed,
                model: modelUsed,
                originalSource: `tool:${toolResult.toolName}`,
                extractedAt: new Date().toISOString(),
                toolMetadata: toolResult.metadata ?? null,
            };

            try {
                await librarianWrite({
                    entityType: targetEntity.entityType,
                    entityId: targetEntity.entityId,
                    key: fact.key,
                    valueRaw: fact.value,
                    valueSummary: fact.summary.slice(0, 500),
                    confidence: fact.confidence,
                    source: AUTOWRITE_SOURCE_TAG,
                    createdBy: `attendant:${this.agentId}`,
                    properties: {
                        memoryScope: 'project',
                        capturePhase: 'tool_result_autowrite',
                        autowriteBatchId,
                        autowriteToolName: toolResult.toolName,
                        autowriteOccurredAt: new Date().toISOString(),
                        ingest: ingestMetadata,
                        ...buildSemanticFactTags({
                            memoryScope: 'project',
                            durableClass: 'tool_result_fact',
                            mergeStrategy: 'replace',
                            extraTags: ['autowrite', `tool:${toolResult.toolName.toLowerCase()}`],
                        }),
                    } as Record<string, unknown>,
                });
                writtenEntries.push({
                    entity: targetEntityString,
                    key: fact.key,
                    summary: fact.summary.slice(0, 220),
                });
            } catch (writeErr) {
                skipped.push({
                    reason: 'librarian_write_failed',
                    detail: writeErr instanceof Error ? writeErr.message : String(writeErr),
                });
            }
        }

        baseOutcome.factsWritten = writtenEntries.length;
        baseOutcome.writtenEntries = writtenEntries;
        baseOutcome.durationMs = Date.now() - extractionStart;

        // M3: track this batch in the recent-autowrite buffer so a later
        // forced nudge can surface concrete draft facts from these reads.
        if (writtenEntries.length > 0) {
            this.recentAutowriteBatches.push({
                autowriteBatchId,
                toolName: toolResult.toolName,
                occurredAt: new Date().toISOString(),
                factCount: writtenEntries.length,
                writtenEntries,
            });
            while (this.recentAutowriteBatches.length > RECENT_AUTOWRITE_BUFFER_LIMIT) {
                this.recentAutowriteBatches.shift();
            }
        }

        // Every tool-result extraction counts against the write-cost gauge,
        // whether or not the extraction actually produced facts. The point of
        // the counter is to pressure the host to checkpoint after N expensive
        // tool calls; a barren read still consumed budget.
        this.toolCallsSinceLastWrite += 1;

        // Autowrites are durable persistence — reset persistence counters and
        // notify write observers so compliance state reflects the write.
        this.attendsWithoutPersist = 0;
        this.turnsWithoutWrite = 0;
        this.writeOccurredThisTurn = true;
        this.recordMemoryEvidence('write');

        if (this.eventSource && writtenEntries.length > 0) {
            getStaffEventEmitter().emit({
                staffComponent: 'Attendant',
                actionType: 'attendant_autowrite',
                agentId: this.agentId,
                source: this.eventSource,
                reason: `tool_result_extraction:${toolResult.toolName}`,
                level: 'audit',
                metadata: this.buildEventMetadata({
                    autowriteBatchId,
                    toolName: toolResult.toolName,
                    targetEntity: targetEntityString,
                    factsExtracted: baseOutcome.factsExtracted,
                    factsWritten: baseOutcome.factsWritten,
                    durationMs: baseOutcome.durationMs,
                }),
            });
        }

        return baseOutcome;
    }

    // M7: scan the agent's post-response text for file path mentions, infer
    // the most likely action (edited / created / read) from surrounding context,
    // and write one durable fact per file-scoped entity. This populates the
    // project/{id}/file/{basename} entity namespace so demand-driven recall
    // (extractFilePathEntityHints + observe) can surface the facts in future
    // sessions without any host-side collection effort.
    //
    // Isolation policy: extraction failures (regex errors, downstream write
    // errors) MUST NOT abort the attend call. This method swallows its own
    // errors and reports them via the skipped array.
    private async runResponseFileCapture(
        responseText: string,
        batchId: string,
    ): Promise<ResponseFileCaptureResult> {
        const t0 = Date.now();
        const skipped: Array<{ reason: string; detail?: string }> = [];
        const baseResult: ResponseFileCaptureResult = {
            autowriteBatchId: batchId,
            filesDetected: 0,
            factsWritten: 0,
            entities: [],
            skipped,
            durationMs: 0,
        };

        if (!responseText || responseText.trim().length < RESPONSE_FILE_CAPTURE_MIN_CHARS) {
            skipped.push({ reason: 'response_too_short' });
            baseResult.durationMs = Date.now() - t0;
            return baseResult;
        }

        const projectEntity = getProjectMemoryEntity() ?? null;
        if (!projectEntity) {
            skipped.push({ reason: 'no_project_entity' });
            baseResult.durationMs = Date.now() - t0;
            return baseResult;
        }
        const projectId = parseEntityString(projectEntity).entityId;

        // Scan the response text for file path occurrences. One fact per
        // distinct basename — first occurrence wins if the same file appears
        // multiple times in the same response.
        const seenEntities = new Set<string>();
        const fileOccurrences: Array<{
            path: string;
            entity: string;
            contextWindow: string;
        }> = [];

        FILE_PATH_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = FILE_PATH_PATTERN.exec(responseText)) !== null) {
            const filePath = match[1].trim();
            const basename = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
            const stripped = basename.split(/[,:()]/)[0] ?? basename;
            const nameWithoutExt = stripped
                .replace(/\.\w+$/, '')
                .replace(/[^a-zA-Z0-9]/g, '_')
                .toLowerCase();
            if (!nameWithoutExt || nameWithoutExt.length < 2) continue;

            const entity = `project/${projectId}/file/${nameWithoutExt}`;
            if (seenEntities.has(entity)) continue;
            seenEntities.add(entity);

            // Grab a context window around the match for action detection.
            const matchStart = match.index;
            const contextStart = Math.max(0, matchStart - 150);
            const contextEnd = Math.min(
                responseText.length,
                matchStart + filePath.length + 150,
            );
            const contextWindow = responseText.slice(contextStart, contextEnd);

            fileOccurrences.push({ path: filePath, entity, contextWindow });
            if (fileOccurrences.length >= RESPONSE_FILE_CAPTURE_MAX_FILES) break;
        }

        baseResult.filesDetected = fileOccurrences.length;
        if (fileOccurrences.length === 0) {
            baseResult.durationMs = Date.now() - t0;
            return baseResult;
        }

        const writtenEntities: string[] = [];
        for (const { path, entity, contextWindow } of fileOccurrences) {
            const action = detectFileAction(contextWindow);
            const key = (action === 'edited' || action === 'created') ? 'last_edit' : 'last_access';
            const confidence = (action === 'edited' || action === 'created') ? 85 : 70;
            const parsedEntity = parseAutowriteEntity(entity);
            const displayName = path.replace(/\\/g, '/').split('/').pop() ?? path;

            const value = {
                action,
                path,
                capturedAt: new Date().toISOString(),
            };
            const summary = `${displayName} was ${action} — captured from agent response at post-response.`;

            try {
                await librarianWrite({
                    entityType: parsedEntity.entityType,
                    entityId: parsedEntity.entityId,
                    key,
                    valueRaw: value,
                    valueSummary: summary.slice(0, 500),
                    confidence,
                    source: AUTOWRITE_SOURCE_TAG,
                    createdBy: `attendant:${this.agentId}`,
                    properties: {
                        memoryScope: 'project',
                        capturePhase: 'response_file_change_autowrite',
                        autowriteBatchId: batchId,
                        fileAction: action,
                        autowriteOccurredAt: new Date().toISOString(),
                        ...buildSemanticFactTags({
                            memoryScope: 'project',
                            durableClass: 'file_change',
                            mergeStrategy: 'replace',
                            extraTags: ['autowrite', 'response_capture', `action:${action}`],
                        }),
                    } as Record<string, unknown>,
                });
                writtenEntities.push(entity);
            } catch (err) {
                skipped.push({
                    reason: 'librarian_write_failed',
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
        }

        baseResult.factsWritten = writtenEntities.length;
        baseResult.entities = writtenEntities;
        baseResult.durationMs = Date.now() - t0;

        if (writtenEntities.length > 0) {
            // Autowriting file-change facts counts as durable persistence —
            // reset pressure counters and notify compliance tracking.
            this.attendsWithoutPersist = 0;
            this.turnsWithoutWrite = 0;
            this.writeOccurredThisTurn = true;
            this.recordMemoryEvidence('write');

            if (this.eventSource) {
                getStaffEventEmitter().emit({
                    staffComponent: 'Attendant',
                    actionType: 'attendant_autowrite',
                    agentId: this.agentId,
                    source: this.eventSource,
                    reason: 'response_file_change_autowrite',
                    level: 'audit',
                    metadata: this.buildEventMetadata({
                        autowriteBatchId: batchId,
                        filesDetected: baseResult.filesDetected,
                        factsWritten: baseResult.factsWritten,
                        entities: writtenEntities,
                    }),
                });
            }
        }

        return baseResult;
    }

    // M3: build a forced write-nudge payload when tool-cost pressure crosses
    // TOOL_COST_WRITE_NUDGE_THRESHOLD and the nudge has not already been
    // emitted this turn. Returns null when no nudge should fire. The nudge
    // surfaces draft facts from the recent autowrite buffer so the host has
    // something concrete to confirm or edit instead of a vague "write
    // something" reminder.
    private maybeBuildWriteNudge(): WriteNudge | null {
        if (this.writeNudgeEmittedThisTurn) return null;
        if (this.toolCallsSinceLastWrite < TOOL_COST_WRITE_NUDGE_THRESHOLD) return null;
        if (this.recentAutowriteBatches.length === 0) return null;

        const draftFacts: WriteNudge['draftFacts'] = [];
        for (const batch of this.recentAutowriteBatches) {
            for (const entry of batch.writtenEntries) {
                draftFacts.push({
                    entity: entry.entity,
                    key: entry.key,
                    summary: entry.summary,
                    fromTool: batch.toolName,
                    autowriteBatchId: batch.autowriteBatchId,
                });
                if (draftFacts.length >= 6) break;
            }
            if (draftFacts.length >= 6) break;
        }

        if (draftFacts.length === 0) return null;

        this.writeNudgeEmittedThisTurn = true;

        return {
            reason: 'tool_cost_threshold',
            toolCallsSinceLastWrite: this.toolCallsSinceLastWrite,
            threshold: TOOL_COST_WRITE_NUDGE_THRESHOLD,
            draftFacts,
            message: `COMPLIANCE NUDGE: ${this.toolCallsSinceLastWrite} expensive tool calls have run without a host-initiated iranti_write. Iranti has auto-extracted the draft facts below via attendant_autowrite (source='${AUTOWRITE_SOURCE_TAG}'). Review, edit, or confirm them with iranti_write, or call iranti_checkpoint to record progress. To revert the autowrites, run: iranti revert-autowrite --since <duration> [--dry-run].`,
        };
    }

    async notifyWriteOccurred(): Promise<void> {
        this.attendsWithoutPersist = 0;
        this.turnsWithoutWrite = 0;
        this.writeOccurredThisTurn = true;
        this.lastAttendPhase = undefined;
        this.consecutivePreResponseWithoutPost = 0;
        // M3: a real host-initiated (or autowrite-initiated) write closes out
        // any accumulated tool-cost pressure. Note autowrites also call this
        // path, which is intentional — once M2 writes something, the nudge
        // has served its purpose for this batch of reads.
        this.toolCallsSinceLastWrite = 0;
        this.writeNudgeEmittedThisTurn = false;
        this.recentAutowriteBatches = [];
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
        // M3: a checkpoint is a strong durable signal. Clear tool-cost
        // pressure so we don't nag the host right after they already flushed
        // progress to the shared ledger.
        this.toolCallsSinceLastWrite = 0;
        this.writeNudgeEmittedThisTurn = false;
        this.recentAutowriteBatches = [];
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
            // M3: turn-scoped nudge suppression resets on post-response so a
            // fresh turn can emit a nudge again if the pressure persists.
            this.writeNudgeEmittedThisTurn = false;
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
            this.writeNudgeEmittedThisTurn = false;
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
        // A2: tool-call triggered retrieval. If the caller says "I'm about to
        // run Read(file_path=X) / Grep / Bash / WebFetch / WebSearch", derive
        // structured entity hints from the tool arguments BEFORE the tool
        // runs, so stored facts can preempt the lookup.
        const toolCallHints = derivePendingToolCallEntityHints(
            input.pendingToolCall,
            getProjectMemoryEntity() ?? null,
        );
        const allExtraHints = filePathHints.length === 0 && toolCallHints.length === 0
            ? null
            : [...filePathHints, ...toolCallHints];
        const effectiveEntityHints = allExtraHints === null
            ? baseEntityHints
            : [...new Set([...baseEntityHints, ...allExtraHints])];

        // User operating rules: load rules whose triggers match the current context.
        // Mid-turn attends skip this — rules were already surfaced at pre-response,
        // and reloading them on every mid-turn call would duplicate context and burn
        // an LLM call on the trigger match.
        const matchedUserRules = (phase !== 'post-response' && phase !== 'mid-turn')
            ? await this.loadMatchingUserRules(`${latestMessage}\n${currentContext}`)
            : [];

        // M2: tool-result extraction. If the host passed a completed tool result,
        // extract durable facts from it and autowrite them BEFORE the main attend
        // flow runs, so the extracted content can surface as draft facts in any
        // M3 write nudge this turn. Skip on post-response — that phase is the
        // closeout for the reply and has its own capture path. Isolated failures
        // never abort the attend call; runToolResultAutowrite swallows its own
        // errors and reports them via the extractorError field.
        let toolResultExtraction: ToolResultExtractionOutcome | undefined;
        if (input.toolResult && phase !== 'post-response') {
            const autowriteBatchId = Date.now().toString();
            toolResultExtraction = await this.runToolResultAutowrite(input.toolResult, autowriteBatchId);
        }

        // M3: compute the forced write nudge ONCE, right after the autowrite pass,
        // so the counter bumps from M2 feed straight into the nudge threshold check.
        // maybeBuildWriteNudge has a once-per-turn guard (writeNudgeEmittedThisTurn)
        // so calling it here and then reusing the stored value across return paths
        // is both correct and lighter than calling it three times. If the nudge is
        // present, we force-upgrade the final decision below so the host cannot
        // miss the cue — the draft facts in the nudge are the agent's own work
        // captured via autowrite, and the host should review them before
        // proceeding with any more tool calls.
        const writeNudge = this.maybeBuildWriteNudge() ?? undefined;

        // M4: drift detection — compare the current message/context against
        // the declared (inferred) task type in the brief. Only fires on
        // pre-response and mid-turn; post-response is the closeout for a
        // reply and drift there is less actionable. Computed once near the
        // top so every return path can echo the same value without re-running
        // the tokenization. Pure — no instance state reads beyond brief.
        const drift: DriftSignal | undefined = (phase !== 'post-response' && this.brief?.inferredTaskType)
            ? detectTaskDrift(latestMessage, currentContext, this.brief.inferredTaskType)
            : undefined;

        // M5: auto-checkpoint signal — gated on phase !== post-response
        // (post-response has its own closeout) and computed once so every
        // return path can echo the same value. Pure — uses only the counters
        // and the drift signal computed above. Pairs with A6 by reading
        // this.brief.sessionObjective for the draft step labels.
        const autoCheckpointSignal: AutoCheckpointSignal | undefined = phase !== 'post-response'
            ? detectAutoCheckpointTrigger({
                toolCallsSinceLastWrite: this.toolCallsSinceLastWrite,
                turnsWithoutWrite: this.turnsWithoutWrite,
                driftDetected: drift?.detected === true,
                driftOverlap: drift?.overlap ?? null,
                sessionObjective: this.brief?.sessionObjective ?? null,
                driftDrivingTokens: drift?.drivingTokens,
            })
            : undefined;

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
            // M7: scan the agent's response for file path mentions and write file-scoped facts.
            // Must run BEFORE buildComplianceState so that any writes here reset the
            // pressure counters and are reflected in the compliance snapshot.
            const responseFileCapture = await this.runResponseFileCapture(
                latestMessage,
                `rfca_${Date.now()}`,
            );
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
                // M2: extraction is gated out on post-response (see guard above),
                // so this will always be undefined here, but we include the field
                // for shape consistency with the main return path.
                toolResultExtraction,
                // M3: nudge surfaces even on closeout — if the turn ran many tool
                // calls without a host-initiated write, the agent should see the
                // draft facts before compliance is persisted.
                writeNudge,
                // M4: drift is gated on phase !== post-response above, so this
                // will always be undefined here. Field present for shape parity.
                drift,
                // M5: auto-checkpoint signal is gated on phase !== post-response,
                // so it's always undefined here. Field echoed for shape parity
                // so downstream consumers can safely destructure.
                autoCheckpointSignal,
                // A3: refinement pass is gated off on post-response — the
                // closeout path never runs retrieval so there is nothing to
                // refine. Field present for shape parity.
                refinementPass: {
                    outcome: 'declined_post_response',
                    attempted: false,
                    initialFactCount: 0,
                    addedFactCount: 0,
                    widenedEntityHints: [],
                    fallbackTerms: [],
                    reason: 'post_response_closeout',
                    note: 'Refinement is gated off on post-response attends.',
                },
                // A5: attendant tool plan is gated off on post-response for
                // the same reason. Surfaced as an empty plan so hosts can
                // safely destructure the field on every attend response.
                attendantToolPlan: {
                    proposed: [],
                    basis: 'empty',
                    note: 'Attendant tool plan is gated off on post-response attends.',
                },
                // B7 S6: council consultation plan is also gated off on
                // post-response. Surface as empty shell for parity.
                councilConsultationPlan: {
                    consultations: [],
                    note: 'Council consultation plan is gated off on post-response attends.',
                    outcome: 'no_context',
                    budgetMax: 0,
                },
                // B8 M6: sub-turn reasoning loop is gated off on post-response.
                // Field echoed as a declined shell for destructure parity.
                subTurnLoopPlan: {
                    outcome: 'declined_post_response',
                    attempted: false,
                    partialResponseLength: 0,
                    initialFactCount: 0,
                    addedFactCount: 0,
                    rescoreTokens: [],
                    proposedHints: [],
                    budgetMax: 0,
                    reason: 'post_response_closeout',
                    note: 'Sub-turn loop is gated off on post-response attends.',
                },
                // M7: response file-change autowrite — populated at post-response.
                // Contains the outcome of the scan pass over the agent's reply.
                responseFileCapture,
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
        // M3: if a write nudge is present, force memory needed. The nudge carries
        // the agent's own autowrite drafts — the host must surface them, even if
        // entity/recall heuristics would otherwise skip injection. We leave the
        // existing method='heuristic' rather than inventing a new enum to keep
        // telemetry stable; the explanation disambiguates the origin.
        if (writeNudge && !decision.needed) {
            decision = {
                needed: true,
                confidence: 0.98,
                method: 'heuristic',
                explanation: 'write_nudge_forced',
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
            // A2: even on the "memory not needed" early return, if the caller
            // passed pendingToolCall, echo the derived entities so the agent
            // can see that attend() was tool-call-aware on this call.
            const skipGuidance: ToolCallGuidance | undefined = input.pendingToolCall
                ? (() => {
                    // M1: derive a structured skip verdict. On the "memory not
                    // needed" early-return path, the verdict is always
                    // shouldSkip=false/memory_not_needed because we never
                    // actually looked up facts — absence of retrieval is not
                    // evidence the tool is redundant.
                    const verdict = deriveSkipVerdict({
                        derivedEntities: toolCallHints,
                        factConfidences: [],
                        memoryWasSkipped: true,
                    });
                    return {
                        toolName: input.pendingToolCall.name,
                        derivedEntities: toolCallHints,
                        factCount: 0,
                        note: `Memory was not deemed necessary for this ${input.pendingToolCall.name} call. Proceed.`,
                        shouldSkip: verdict.shouldSkip,
                        skipConfidence: verdict.skipConfidence,
                        skipReasonCode: verdict.skipReasonCode,
                    };
                })()
                : undefined;
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
                toolCallGuidance: skipGuidance,
                // M2: report tool-result extraction even when attend decided no
                // memory was needed — the autowrites already happened and the
                // caller should see what was persisted so they can verify or revert.
                toolResultExtraction,
                // M3: surface the forced-write nudge even on the not-needed path.
                // The whole point of the nudge is to fire when the agent is doing
                // lookup work without persisting; that's the exact shape of a
                // "no memory needed" turn after several Read/Grep/Bash calls.
                // Note: when the nudge is set, the decision was force-upgraded to
                // needed:true above and this branch is skipped. This field stays
                // wired for shape consistency and for tests that simulate state.
                writeNudge,
                // M4: drift may fire here even when attend decides no memory is
                // needed — the agent may be drifting off-task without requiring
                // memory injection. Surface it so the host can reconvene.
                drift,
                // M5: auto-checkpoint signal surfaces on the not-needed path —
                // the whole point of M5 is to fire when pressure has built up
                // without a matching durable write. That pressure often
                // coincides with "no new memory needed, just keep working"
                // turns, which is exactly when the host needs the nudge.
                autoCheckpointSignal,
                // A3: memory not needed → no retrieval ran → refinement is
                // "not_needed" by definition. Field echoed for shape parity.
                refinementPass: {
                    outcome: 'not_needed',
                    attempted: false,
                    initialFactCount: 0,
                    addedFactCount: 0,
                    widenedEntityHints: [],
                    fallbackTerms: [],
                    reason: 'memory_not_needed',
                    note: 'Attend declined memory injection; no refinement pass required.',
                },
                // A5: attendant tool plan can still populate on the not-needed
                // path when entity hints exist — the host might still benefit
                // from a follow-up walk even when attend didn't inject facts.
                // Pure helper so no latency concern.
                attendantToolPlan: planAttendantToolCalls({
                    phase,
                    entityHints: effectiveEntityHints,
                    initialFactCount: 0,
                    sessionObjective: this.brief?.sessionObjective ?? null,
                    drift,
                    briefHasEntities: (this.brief?.watchedEntities?.length ?? 0) > 0,
                }),
                // B7 S6: council consultation plan populated even on the
                // not-needed path — the Attendant can still decide to consult
                // a peer (e.g. Librarian for source-reliability) when drift
                // is present or entity hints suggest a topic.
                councilConsultationPlan: planCouncilConsultation({
                    from: 'Attendant',
                    task: (latestMessage ?? '').trim() || 'relevance_check_no_retrieval',
                    context: {
                        relevanceCheckTopic: effectiveEntityHints[0] ?? null,
                        lowConfidenceCount: 0,
                    },
                }),
                // B8 M6: sub-turn loop plan populated even on the not-needed
                // path — the helper will decline cleanly because no retrieval
                // ran (initialFactCount=0) and, on non-mid-turn phases, the
                // phase gate fires first. Pure helper so no latency concern.
                subTurnLoopPlan: planSubTurnLoop({
                    phase,
                    partialResponse: input.partialResponse,
                    latestMessage,
                    originalEntityHints: effectiveEntityHints,
                    initialFactCount: 0,
                }),
            };
        }

        // Post-compaction recovery: re-surface facts that were recently injected (likely in context
        // just before the compact) without blocking them on the already-in-context filter.
        // The flag is set by handshake(postCompaction:true) and consumed exactly once here.
        const postCompactionRecoveryKeys: string[] = [];
        let effectiveMaxFacts = input.maxFacts;
        if (this.postCompactionPending) {
            const recentInjections = this.pendingMemoryAttributions.slice(-5);
            for (const attr of recentInjections) {
                postCompactionRecoveryKeys.push(...attr.injectedKeys);
            }
            effectiveMaxFacts = Math.min((input.maxFacts ?? 5) * 2, 10);
            this.postCompactionPending = false;
        } else if (phase === 'mid-turn' && input.maxFacts === undefined) {
            // A1: mid-turn attends default to a smaller fact budget than pre-response.
            // The agent already has a working-memory frame from the pre-response attend;
            // mid-turn is about surfacing 1-3 NEW facts on a topic shift, not re-dumping briefs.
            effectiveMaxFacts = MID_TURN_DEFAULT_MAX_FACTS;
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
            maxFacts: effectiveMaxFacts,
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

        // A3: iterative exploration — bounded refinement pass when initial
        // retrieval came back empty but attend decided memory was needed.
        // Widens entity hints by stripping the key segment (keeping entity
        // type + id), then runs one extra observe() call. Pure-helper plan
        // is computed first so we can record the decline reason when we
        // choose not to retry. Gated off on post-response above via the
        // post-response return. Max 1 extra retrieval call.
        let refinementPass: RefinementPass | undefined;
        let augmentedObservedFacts = observed.facts;
        let augmentedObservedTotalFound = observed.totalFound;
        const initialObservedCount = observed.facts.length;
        if (initialObservedCount === 0) {
            const refinementPlan = planRefinementPass({
                initialFactCount: initialObservedCount,
                decisionNeeded: decision.needed,
                phase,
                entityHints: allObserveEntityHints,
                latestMessage,
            });
            refinementPass = refinementPlan;
            if (refinementPlan.attempted && refinementPlan.widenedEntityHints.length > 0) {
                // Retry uses the UNION of the original hints and widened hints.
                // This preserves any specific entity hint supplied by the host
                // (including pendingToolCall-derived entities) while adding
                // broader prefixes so the vector search can hit a wider set.
                const refinementRetryHints = Array.from(new Set([
                    ...allObserveEntityHints,
                    ...refinementPlan.widenedEntityHints,
                ]));
                try {
                    const refined = await this.observe({
                        currentContext: observationContext,
                        maxFacts: effectiveMaxFacts,
                        entityHints: refinementRetryHints,
                        priorityKeys: expandContinuityPriorityKeys(Array.from(new Set([
                            ...(mandatoryRecall.key ? [mandatoryRecall.key] : []),
                            ...(this.advisoryLearningProfile?.priorityKeys ?? []),
                            ...freshState.priorityKeys,
                        ]))),
                        skipContextFilter: forceInject,
                        recoveryKeys: postCompactionRecoveryKeys.length > 0 ? postCompactionRecoveryKeys : undefined,
                        ledgerContext: input.ledgerContext,
                    });
                    if (refined.facts.length > 0) {
                        augmentedObservedFacts = refined.facts;
                        augmentedObservedTotalFound = refined.totalFound;
                        refinementPass = {
                            ...refinementPlan,
                            outcome: 'attempted_added',
                            addedFactCount: refined.facts.length,
                            note: `Refinement pass added ${refined.facts.length} fact(s) via widened entity hints (${refinementPlan.widenedEntityHints.join(', ')}).`,
                        };
                    } else {
                        refinementPass = {
                            ...refinementPlan,
                            outcome: 'attempted_empty',
                            addedFactCount: 0,
                            note: `Refinement pass with widened entity hints (${refinementPlan.widenedEntityHints.join(', ')}) still returned 0 facts.`,
                        };
                    }
                } catch (err) {
                    // Refinement must never crash the attend call. If the
                    // retry observe blows up, record the decline and press on.
                    refinementPass = {
                        ...refinementPlan,
                        outcome: 'declined_no_hints',
                        attempted: false,
                        addedFactCount: 0,
                        reason: `refinement_retry_threw: ${err instanceof Error ? err.message : String(err)}`,
                        note: 'Refinement pass aborted due to retry error; initial empty result stands.',
                    };
                }
            }
        } else {
            refinementPass = {
                outcome: 'not_needed',
                attempted: false,
                initialFactCount: initialObservedCount,
                addedFactCount: 0,
                widenedEntityHints: [],
                fallbackTerms: [],
                reason: 'initial_pass_returned_facts',
                note: 'No refinement pass required.',
            };
        }

        // B8 M6: sub-turn reasoning loop. When the caller passed a partial
        // assistant response on a mid-turn attend, re-score that partial
        // against the baseline retrieval and decide whether to fire ONE
        // bounded extra observe() call with broadened hints harvested from
        // the partial text. This is A3's refinement pattern re-applied on
        // response progress rather than initial-pass emptiness. Pure plan
        // + at most one retry; same union-of-original+proposed hint fix as
        // B6's refinement retry above. Gates ensure it only fires on
        // mid-turn with a non-trivial partial response carrying novel
        // tokens or type/id patterns beyond the baseline.
        const subTurnInitialCount = augmentedObservedFacts.length;
        let subTurnLoopPlan: SubTurnLoopPlan = planSubTurnLoop({
            phase,
            partialResponse: input.partialResponse,
            latestMessage,
            originalEntityHints: allObserveEntityHints,
            initialFactCount: subTurnInitialCount,
        });
        if (subTurnLoopPlan.attempted && subTurnLoopPlan.proposedHints.length > 0) {
            // Retry uses the UNION of allObserveEntityHints and the
            // sub-turn proposed hints — same preservation fix as B6 so a
            // specific host-supplied hint is not dropped when the sub-turn
            // widens with patterns harvested from the partial response.
            const subTurnRetryHints = Array.from(new Set([
                ...allObserveEntityHints,
                ...subTurnLoopPlan.proposedHints,
            ]));
            try {
                const subTurnObserved = await this.observe({
                    currentContext: observationContext,
                    maxFacts: effectiveMaxFacts,
                    entityHints: subTurnRetryHints,
                    priorityKeys: expandContinuityPriorityKeys(Array.from(new Set([
                        ...(mandatoryRecall.key ? [mandatoryRecall.key] : []),
                        ...(this.advisoryLearningProfile?.priorityKeys ?? []),
                        ...freshState.priorityKeys,
                    ]))),
                    skipContextFilter: forceInject,
                    recoveryKeys: postCompactionRecoveryKeys.length > 0 ? postCompactionRecoveryKeys : undefined,
                    ledgerContext: input.ledgerContext,
                });
                // Merge new facts that weren't already in augmentedObservedFacts.
                // Uses entityKey as the dedup key, same as the mid-turn
                // filter below. A net-new fact count of 0 means the retry
                // resolved the same facts we already had — treat as empty.
                const existingKeys = new Set(augmentedObservedFacts.map((f) => f.entityKey));
                const netNewFacts = subTurnObserved.facts.filter((f) => !existingKeys.has(f.entityKey));
                if (netNewFacts.length > 0) {
                    augmentedObservedFacts = [...augmentedObservedFacts, ...netNewFacts];
                    augmentedObservedTotalFound = augmentedObservedTotalFound + netNewFacts.length;
                    subTurnLoopPlan = {
                        ...subTurnLoopPlan,
                        outcome: 'attempted_added',
                        addedFactCount: netNewFacts.length,
                        note: `Sub-turn loop added ${netNewFacts.length} fact(s) via proposed hints (${subTurnLoopPlan.proposedHints.join(', ')}).`,
                    };
                } else {
                    subTurnLoopPlan = {
                        ...subTurnLoopPlan,
                        outcome: 'attempted_empty',
                        addedFactCount: 0,
                        note: `Sub-turn loop with proposed hints (${subTurnLoopPlan.proposedHints.join(', ')}) returned no net-new facts.`,
                    };
                }
            } catch (err) {
                // Sub-turn loop must never crash attend. Record a declined
                // outcome with the error and continue.
                subTurnLoopPlan = {
                    ...subTurnLoopPlan,
                    outcome: 'attempted_empty',
                    attempted: false,
                    addedFactCount: 0,
                    reason: `sub_turn_retry_threw: ${err instanceof Error ? err.message : String(err)}`,
                    note: 'Sub-turn loop aborted due to retry error; baseline retrieval stands.',
                };
            }
        }

        // A5: tool-using Attendant (planned). Derive the proposed follow-up
        // tool calls from current brief state + retrieval outcome + drift.
        // Pure and deterministic — the Attendant does not execute them.
        const attendantToolPlan: AttendantToolPlan = planAttendantToolCalls({
            phase,
            entityHints: allObserveEntityHints,
            initialFactCount: augmentedObservedFacts.length,
            sessionObjective: this.brief?.sessionObjective ?? null,
            drift,
            briefHasEntities: (this.brief?.watchedEntities?.length ?? 0) > 0,
        });

        // B7 S6: council consultation plan. Proposes which peer Staff
        // members the Attendant would consult for this turn — Librarian
        // for source-reliability on clear topics, Archivist when the
        // injection surface has multiple low-confidence facts. Pure,
        // deterministic, never executed here.
        const lowConfidenceInjectionCount = augmentedObservedFacts.filter((f) =>
            typeof f.confidence === 'number' && f.confidence < 60
        ).length;
        const councilConsultationPlan: CouncilConsultationPlan = planCouncilConsultation({
            from: 'Attendant',
            task: (latestMessage ?? '').trim() || (drift ? 'drift_observed' : 'pre_response_relevance_check'),
            context: {
                relevanceCheckTopic: allObserveEntityHints[0] ?? null,
                lowConfidenceCount: lowConfidenceInjectionCount,
            },
        });

        // Replace observed.facts in the downstream pipeline with the
        // augmented (possibly refined) facts. observed.totalFound is only
        // used for debug metadata, so we substitute both via local aliases
        // used directly below instead of mutating the upstream object.
        (observed as { facts: typeof augmentedObservedFacts }).facts = augmentedObservedFacts;
        (observed as { totalFound: number }).totalFound = augmentedObservedTotalFound;

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

        // A1: mid-turn dedup — drop facts whose entityKey was already injected earlier
        // in the SAME turn. pendingMemoryAttributions is reset at post-response, so any
        // entry in that list belongs to the current turn. This prevents mid-turn attends
        // from spamming the agent with facts it already has in working memory from a
        // previous pre-response or mid-turn attend call.
        const midTurnFilteredKeys: string[] = [];
        let factsAfterDedup = remappedFacts;
        if (phase === 'mid-turn' && this.pendingMemoryAttributions.length > 0) {
            const alreadyInjectedThisTurn = new Set<string>();
            for (const attr of this.pendingMemoryAttributions) {
                for (const key of attr.injectedKeys) {
                    alreadyInjectedThisTurn.add(key);
                }
            }
            if (alreadyInjectedThisTurn.size > 0) {
                factsAfterDedup = remappedFacts.filter((fact) => {
                    if (alreadyInjectedThisTurn.has(fact.entityKey)) {
                        midTurnFilteredKeys.push(fact.entityKey);
                        return false;
                    }
                    return true;
                });
            }
        }
        const structuredFacts = assignStructuredFactIds(factsAfterDedup);
        watchedEntitiesChanged = this.updateWatchedEntities(observed.entitiesResolved?.map((entry) => entry.canonicalEntity) ?? []) || watchedEntitiesChanged;
        this.markSharedStateObserved(observeEntityHints.length > 0 ? observeEntityHints : freshState.entities);

        let reason: AttendResult['reason'] = 'memory_needed_injected';
        // M3: when a write nudge forced the decision, the host MUST see the
        // nudge regardless of whether observe() surfaced facts. Treat it like
        // an injection path (shouldInject=true) so the guidance rides out in
        // the standard response shape. The nudge carries the draft facts.
        // Also include matchedUserRules so rule-only injections don't fall
        // into the !shouldInject branch below which would mark them as
        // memory_checked_no_match.
        const shouldInject = structuredFacts.length > 0
            || writeNudge !== undefined
            || matchedUserRules.length > 0;
        const memorySearchPerformed = true;
        const memoryResultsConsidered = observed.totalFound;
        let searchSuggestion: AttendSearchSuggestion | undefined;

        if (!shouldInject) {
            // A1: if mid-turn dedup ate everything observe returned, treat it as
            // "already in context" — the agent has these facts from an earlier attend.
            const allDroppedByMidTurnDedup = phase === 'mid-turn'
                && midTurnFilteredKeys.length > 0
                && remappedFacts.length > 0
                && factsAfterDedup.length === 0;
            const allAlreadyInContext = observed.totalFound > 0 && observed.alreadyPresent >= observed.totalFound;
            reason = (allAlreadyInContext || allDroppedByMidTurnDedup) ? 'memory_needed_but_in_context' : 'memory_checked_no_match';
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
        } else if (writeNudge && structuredFacts.length === 0) {
            // M3: nudge-only injection — no observed facts matched, but the
            // compliance nudge is the entire point of this injection. Mark as
            // forced so the host treats it as an intentional surfacing.
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
                    taskContext: this.brief?.inferredTaskType,
                }),
            ]
            : [];

        // A1: when mid-turn dedup filtered keys, surface them in debug so the
        // caller (and tests) can reason about which facts were suppressed.
        const debugWithMidTurn = (midTurnFilteredKeys.length > 0 && observed.debug)
            ? { ...observed.debug, midTurnFilteredKeys: [...midTurnFilteredKeys] }
            : observed.debug;

        // A2: if the caller supplied pendingToolCall, surface a guidance block
        // so the agent can see what entities were derived and how many stored
        // facts preempted the lookup. Only populated when a tool call was
        // actually passed — no allocation overhead for the common path.
        const toolCallGuidance: ToolCallGuidance | undefined = input.pendingToolCall
            ? (() => {
                // M1: derive structured skip verdict. Scored against only the
                // facts that actually matched the derived entity hints — not
                // the wider structuredFacts set — so unrelated context-level
                // facts don't falsely trigger a skip recommendation.
                const entityCovered = toolCallHints.length > 0
                    ? structuredFacts.filter((fact) => {
                        if (!fact?.entityKey) return false;
                        return toolCallHints.some((hint) => fact.entityKey.startsWith(`${hint}/`) || fact.entityKey === hint);
                    })
                    : [];
                const factConfidences = entityCovered.map((fact) => fact.confidence ?? 0);
                const verdict = deriveSkipVerdict({
                    derivedEntities: toolCallHints,
                    factConfidences,
                    memoryWasSkipped: false,
                });
                const skipNote = verdict.shouldSkip
                    ? `Iranti surfaced ${entityCovered.length} stored fact(s) for this ${input.pendingToolCall.name} target. shouldSkip=true (confidence ${verdict.skipConfidence}). Read the facts before running the tool — you may not need to run it.`
                    : toolCallHints.length === 0
                        ? `No entity hints derived from ${input.pendingToolCall.name} args. Memory check ran on message/context only.`
                        : entityCovered.length === 0
                            ? `No stored facts matched the ${input.pendingToolCall.name} target. Proceed with the tool call.`
                            : `Facts surfaced but shouldSkip=false (reason=${verdict.skipReasonCode}). Proceed with the tool call.`;
                return {
                    toolName: input.pendingToolCall.name,
                    derivedEntities: toolCallHints,
                    factCount: entityCovered.length,
                    note: skipNote,
                    shouldSkip: verdict.shouldSkip,
                    skipConfidence: verdict.skipConfidence,
                    skipReasonCode: verdict.skipReasonCode,
                };
            })()
            : undefined;

        const attendResult = {
            ...observed,
            debug: debugWithMidTurn,
            facts: structuredFacts,
            // M3: use the centralized shouldInject const so writeNudge-only
            // injections surface. Recomputing here would drop the nudge path.
            shouldInject,
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
            toolCallGuidance,
            // M2: surface the outcome of tool-result extraction (or undefined if
            // no toolResult was passed). Populated BEFORE decideMemoryNeed so
            // extracted facts can influence that decision via counter updates.
            toolResultExtraction,
            // M3: forced write nudge — computed once near the top of attend()
            // so the same instance is reused on every return path without
            // double-tripping the once-per-turn guard. Non-null only when
            // toolCallsSinceLastWrite crossed TOOL_COST_WRITE_NUDGE_THRESHOLD
            // and no nudge has been emitted this turn yet. Carries up to 6
            // draft facts from recentAutowriteBatches so the agent can review
            // them before the next tool call.
            writeNudge,
            // M4: drift signal — populated only when the current message/context
            // has diverged from the declared (inferred) task by more than
            // DRIFT_JACCARD_MIN. Computed once near the top and threaded here
            // so hosts can surface it alongside injected facts in one reply.
            drift,
            // M5: auto-checkpoint signal — populated only when tool-cost,
            // turn-cost, or drift pressure has built up. Computed once near
            // the top and threaded here so hosts see it in the same reply
            // as any injected facts.
            autoCheckpointSignal,
            // A3: refinement pass outcome — describes whether the Attendant
            // ran a bounded retrieval retry when the initial pass was empty.
            // Always populated on the main success path so hosts can log why
            // retrieval was OR was not re-tried. Pure-descriptive metadata.
            refinementPass,
            // A5: planned Attendant tool calls — a small list of follow-up
            // tool calls the Attendant would run if it had an execution
            // budget. Deterministic, not executed. Hosts can surface the
            // plan to the user or feed it to compliance scoring.
            attendantToolPlan,
            // B7 S6: council consultation plan — which peer Staff members
            // the Attendant would consult if council mode were live.
            // Pure, deterministic, never executed here.
            councilConsultationPlan,
            // B8 M6: sub-turn reasoning loop plan — when a mid-turn attend
            // carries a partial assistant response, the Attendant re-scores
            // that partial against baseline retrieval and fires at most one
            // extra observe() call with broadened hints harvested from the
            // partial text. attempted=false / decline outcomes are echoed
            // on non-mid-turn phases so hosts can safely destructure.
            subTurnLoopPlan,
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

