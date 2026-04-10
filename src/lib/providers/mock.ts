import { CompleteOptions, LLMMessage, LLMProvider, LLMResponse } from '../llm';

export type MockScenario =
    | 'default'
    | 'disagreement'
    | 'unreliable'
    | 'collaborative'
    | 'noisy';

export interface MockFallthroughEvent {
    prompt: string;
    promptSnippet: string;
    callCount: number;
    at: number;
}

/**
 * Post-dispatch failure modes used to simulate a misbehaving LLM. These fire
 * AFTER a prompt branch has computed its normal answer, then corrupt it on the
 * way out. Staff code paths (Librarian, Attendant, Archivist) should degrade
 * gracefully when they see these shapes.
 *
 * - 'malformed_json': Returns truncated/invalid JSON where valid JSON is expected.
 *   Exercises JSON.parse try/catch fallback paths in Staff prompt consumers.
 * - 'wrong_shape': Returns syntactically valid JSON with the wrong schema.
 *   Exercises schema validation / type-guard fallbacks.
 * - 'truncated': Returns the first half of the normal response. Exercises
 *   incomplete-output handling for both JSON and free-text responses.
 * - 'empty': Returns an empty string. Exercises the "LLM gave us nothing"
 *   fallback paths which are often missing entirely.
 * - 'throw': Throws a provider error. Stronger than 'failureRate' because it
 *   can be scheduled (see failBeforeSuccessCount) instead of random.
 */
export type MockFailureMode = 'malformed_json' | 'wrong_shape' | 'truncated' | 'empty' | 'throw';

export interface MockFailureEvent {
    mode: MockFailureMode;
    callCount: number;
    at: number;
    /** Whether this failure was scheduled (failBeforeSuccessCount) or sampled (failureModeRate). */
    scheduled: boolean;
}

export interface MockConfig {
    scenario: MockScenario;
    agentId?: string;
    failureRate?: number;
    confidenceRange?: [number, number];
    seed?: number;
    responseDelayMs?: number;
    /**
     * When set, each call sleeps a random duration in this [min, max] ms range
     * BEFORE dispatch. Takes precedence over responseDelayMs. Useful for
     * simulating a flaky provider where latency varies wildly call to call.
     */
    responseDelayRangeMs?: [number, number];
    /**
     * When true, the mock throws instead of returning the canned researcher-profile
     * JSON when no prompt-branch matches. Use this in tests to catch silently
     * unhandled Staff prompt shapes. Default: false (backward compatible).
     */
    strictFallthrough?: boolean;
    /**
     * Optional callback invoked every time the mock falls through to its canned
     * response. Fires regardless of strictFallthrough. Useful for asserting
     * expected vs. unexpected fallthroughs in tests.
     */
    onFallthrough?: (event: MockFallthroughEvent) => void;
    /**
     * Primary failure mode applied to the normal response on the way out.
     * If omitted, no failure mode is applied and the mock behaves exactly as
     * S1 specified. Combined with failureModeRate (probabilistic) or
     * failBeforeSuccessCount (scheduled) to decide when it fires.
     */
    failureMode?: MockFailureMode;
    /**
     * Probability (0..1) of firing failureMode on any given call. Ignored
     * when failBeforeSuccessCount > 0 — scheduled failures win over random ones
     * until the schedule is exhausted.
     */
    failureModeRate?: number;
    /**
     * Force the first N calls to fail with failureMode, then succeed from
     * call N+1 onward. Models the "timeout-then-success" pattern needed to
     * exercise retry-with-backoff paths in Staff consumers.
     */
    failBeforeSuccessCount?: number;
    /**
     * Optional callback invoked every time a failure mode fires. Fires for
     * both scheduled and sampled failures. Useful for asserting failure
     * counts and shapes in tests.
     */
    onFailureMode?: (event: MockFailureEvent) => void;
}

type ExtractedFact = {
    key: string;
    value: unknown;
    summary: string;
    confidence: number;
};

type DetectedEntity = {
    type: string;
    name: string;
    id_guess: string;
    confidence: number;
    evidence: string;
    start?: number;
    end?: number;
};

function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        return (s >>> 0) / 0xffffffff;
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function heuristicEntityId(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function extractBlock(message: string, startLabel: string, endLabels: string[] = []): string {
    const lower = message.toLowerCase();
    const start = lower.indexOf(startLabel.toLowerCase());
    if (start < 0) {
        return '';
    }

    let content = message.slice(start + startLabel.length);
    let end = content.length;
    for (const label of endLabels) {
        const idx = content.toLowerCase().indexOf(label.toLowerCase());
        if (idx >= 0 && idx < end) {
            end = idx;
        }
    }

    content = content.slice(0, end).trim();
    return content.replace(/^"+|"+$/g, '').trim();
}

function titleCase(value: string): string {
    return value
        .trim()
        .split(/\s+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
}

function summarizeFact(key: string, value: unknown): string {
    if (key === 'hq_city' && typeof (value as { city?: unknown })?.city === 'string') {
        return `Headquartered in ${(value as { city: string }).city}.`;
    }
    if (key === 'team_size' && typeof (value as { count?: unknown })?.count === 'number') {
        return `Team size is ${(value as { count: number }).count}.`;
    }
    if (key === 'runway_months' && typeof (value as { months?: unknown })?.months === 'number') {
        return `Runway is ${(value as { months: number }).months} months.`;
    }
    if (key === 'pilot_count' && typeof (value as { count?: unknown })?.count === 'number') {
        return `Pilot count is ${(value as { count: number }).count}.`;
    }
    if (key === 'publication_count' && typeof (value as { count?: unknown })?.count === 'number') {
        return `Has published ${(value as { count: number }).count} papers.`;
    }
    if (key === 'budget') {
        const budget = value as { amount?: unknown; currency?: unknown };
        if (typeof budget.amount === 'number' && typeof budget.currency === 'string') {
            return `Budget is ${budget.amount.toLocaleString('en-US')} ${budget.currency}.`;
        }
    }
    if (key === 'affiliation') {
        const affiliation = value as { institution?: unknown };
        if (typeof affiliation.institution === 'string') {
            return `Affiliated with ${affiliation.institution}.`;
        }
    }
    if (key === 'research_focus') {
        const focus = value as { primary?: unknown };
        if (typeof focus.primary === 'string') {
            return `Primary research focus is ${focus.primary}.`;
        }
    }
    if (key === 'favorite_city') {
        const city = value as { city?: unknown };
        if (typeof city.city === 'string') {
            return `Favorite city is ${city.city}.`;
        }
    }
    return `${key}: ${JSON.stringify(value)}`;
}

function extractFactsFromText(text: string): ExtractedFact[] {
    const facts: ExtractedFact[] = [];
    const trimmed = text.trim();
    if (!trimmed || /no durable facts/i.test(trimmed)) {
        return facts;
    }

    const pushFact = (fact: ExtractedFact) => {
        if (!facts.some((existing) => existing.key === fact.key)) {
            facts.push(fact);
        }
    };

    const cityMatch = trimmed.match(/\b(?:currently\s+)?operates in\s+([A-Za-z][A-Za-z\s-]+?)(?:[.!,]|$)/i);
    if (cityMatch) {
        const city = titleCase(cityMatch[1]);
        pushFact({
            key: 'hq_city',
            value: { city },
            summary: `Headquartered in ${city}.`,
            confidence: 96,
        });
    }

    const teamMatch = trimmed.match(/\bhas\s+(\d+)\s+employees\b/i);
    if (teamMatch) {
        pushFact({
            key: 'team_size',
            value: { count: Number(teamMatch[1]) },
            summary: `Team size is ${teamMatch[1]}.`,
            confidence: 95,
        });
    }

    const runwayMatch = trimmed.match(/\bhas\s+(\d+)\s+months?\s+of\s+runway\b/i);
    if (runwayMatch) {
        pushFact({
            key: 'runway_months',
            value: { months: Number(runwayMatch[1]) },
            summary: `Runway is ${runwayMatch[1]} months.`,
            confidence: 93,
        });
    }

    const pilotMatch = trimmed.match(/\bhas\s+(\d+)\s+pilots?\b/i);
    if (pilotMatch) {
        pushFact({
            key: 'pilot_count',
            value: { count: Number(pilotMatch[1]) },
            summary: `Pilot count is ${pilotMatch[1]}.`,
            confidence: 95,
        });
    }

    const expansionMatch = trimmed.match(/\bcould be expanding into\s+([a-z][a-z\s-]+?)(?:\s+next year|[.!,]|$)/i);
    if (expansionMatch) {
        pushFact({
            key: 'expansion_target',
            value: { market: heuristicEntityId(expansionMatch[1]).replace(/_/g, ' ') },
            summary: `May expand into ${expansionMatch[1].trim()}.`,
            confidence: 38,
        });
    }

    const budgetMatch = trimmed.match(/\bbudget of\s+(\d[\d,]*)\s*(usd|eur|gbp)\b/i);
    if (budgetMatch) {
        pushFact({
            key: 'budget',
            value: {
                amount: Number(budgetMatch[1].replace(/,/g, '')),
                currency: budgetMatch[2].toUpperCase(),
            },
            summary: `Budget is ${budgetMatch[1]} ${budgetMatch[2].toUpperCase()}.`,
            confidence: 91,
        });
    }

    const publicationsMatch = trimmed.match(/\bhas\s+(\d+)\s+publications?\b/i);
    if (publicationsMatch) {
        pushFact({
            key: 'publication_count',
            value: { count: Number(publicationsMatch[1]) },
            summary: `Has published ${publicationsMatch[1]} papers.`,
            confidence: 93,
        });
    }

    const professorMatch = trimmed.match(/\bis a professor at\s+([A-Za-z][A-Za-z\s().-]+?)(?:[.!,]|$)/i);
    if (professorMatch) {
        const institution = professorMatch[1].trim();
        pushFact({
            key: 'affiliation',
            value: { institution },
            summary: `Affiliated with ${institution}.`,
            confidence: 92,
        });
    }

    const focusMatch = trimmed.match(/\bresearch focus:\s*([A-Za-z][A-Za-z\s-]+?)(?:[.!,]|$)/i);
    if (focusMatch) {
        const primary = focusMatch[1].trim().toLowerCase();
        pushFact({
            key: 'research_focus',
            value: { primary },
            summary: `Primary research focus is ${primary}.`,
            confidence: 88,
        });
    }

    const favoriteCityMatch = trimmed.match(/\bfavorite city is\s+([A-Za-z][A-Za-z\s-]+?)(?:[.!,]|$)/i);
    if (favoriteCityMatch) {
        const city = titleCase(favoriteCityMatch[1]);
        pushFact({
            key: 'favorite_city',
            value: { city },
            summary: `Favorite city is ${city}.`,
            confidence: 92,
        });
    }

    return facts;
}

function detectEntities(text: string): DetectedEntity[] {
    const candidates: DetectedEntity[] = [];
    const seen = new Set<string>();

    const add = (candidate: DetectedEntity) => {
        const key = `${candidate.type}/${candidate.id_guess}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        candidates.push(candidate);
    };

    for (const match of text.matchAll(/\b([a-z][a-z0-9_]*)\/([A-Za-z0-9][A-Za-z0-9_\-]{1,80})\b/g)) {
        add({
            type: match[1],
            name: match[2].replace(/_/g, ' '),
            id_guess: heuristicEntityId(match[2]),
            confidence: 0.95,
            evidence: match[0],
            start: typeof match.index === 'number' ? match.index : undefined,
            end: typeof match.index === 'number' ? match.index + match[0].length : undefined,
        });
    }

    for (const match of text.matchAll(/\bProject\s+([A-Z0-9][A-Za-z0-9_\-]*(?:\s+[A-Z0-9][A-Za-z0-9_\-]*){0,4})\b/g)) {
        const name = `Project ${match[1]}`.trim();
        add({
            type: 'project',
            name,
            id_guess: `project_${heuristicEntityId(match[1])}`,
            confidence: 0.88,
            evidence: name,
            start: typeof match.index === 'number' ? match.index : undefined,
            end: typeof match.index === 'number' ? match.index + name.length : undefined,
        });
    }

    for (const match of text.matchAll(/\b([a-z][a-z0-9]+(?:_[a-z0-9]+)+)\b/g)) {
        const slug = match[1];
        add({
            type: 'project',
            name: slug.replace(/_/g, ' '),
            id_guess: heuristicEntityId(slug),
            confidence: 0.86,
            evidence: slug,
            start: typeof match.index === 'number' ? match.index : undefined,
            end: typeof match.index === 'number' ? match.index + slug.length : undefined,
        });
    }

    if (/\b(my|our|we)\b/i.test(text)) {
        add({
            type: 'user',
            name: 'main',
            id_guess: 'main',
            confidence: 0.84,
            evidence: /\bmy\b/i.test(text) ? 'my' : /\bour\b/i.test(text) ? 'our' : 'we',
        });
    }

    return candidates;
}

function classifyMemoryNeed(message: string): { needsMemory: boolean; confidence: number; reason: string } {
    const normalized = message.trim().toLowerCase();
    if (!normalized) {
        return { needsMemory: false, confidence: 0.51, reason: 'no_latest_message' };
    }
    if (/^\s*(hi|hello|hey|yo|thanks|thank you|cool|great)\b/.test(normalized)) {
        return { needsMemory: false, confidence: 0.96, reason: 'simple_greeting_or_ack' };
    }
    if (/\b(my|our|we|remember|earlier|previous|again|favorite|favourite)\b/.test(normalized)) {
        return { needsMemory: true, confidence: 0.93, reason: 'memory_reference_detected' };
    }
    if (normalized.includes('?')) {
        return { needsMemory: false, confidence: 0.64, reason: 'generic_question_without_memory_signal' };
    }
    return { needsMemory: false, confidence: 0.58, reason: 'generic_statement_without_memory_signal' };
}

function normalizeTokens(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .replace(/[^a-z0-9\s]+/g, ' ')
            .split(/\s+/)
            .map((token) => token.trim())
            .filter((token) => token.length > 2),
    );
}

function chooseRelevantEntries(task: string, entriesBlock: string): string {
    const taskTokens = normalizeTokens(task);
    const matches: number[] = [];

    for (const line of entriesBlock.split('\n')) {
        const match = line.match(/^\s*(\d+)\.\s+(.+)$/);
        if (!match) continue;
        const index = Number(match[1]);
        const lineTokens = normalizeTokens(match[2]);
        let overlap = 0;
        for (const token of lineTokens) {
            if (taskTokens.has(token)) {
                overlap += 1;
            }
        }
        if (overlap > 0) {
            matches.push(index);
        }
    }

    return matches.length > 0 ? matches.join(',') : 'none';
}

const TASK_INFERENCES: Record<string, string[]> = {
    default: [
        'Researching academic publication history for a researcher',
        'Analyzing citation patterns across research institutions',
        'Mapping collaboration networks between research groups',
    ],
    disagreement: [
        'Independently verifying researcher affiliations',
        'Cross-referencing conflicting institutional records',
    ],
    collaborative: [
        'Building on prior findings about researcher profiles',
        'Extending existing knowledge base with new data points',
    ],
    noisy: [
        'Researching academic publication history for a researcher',
        'Performing general web research',
        'Analyzing unstructured data sources',
        'Unclear task type',
    ],
};

const CONFLICT_RESOLUTIONS = {
    KEEP_EXISTING: 'KEEP_EXISTING: The existing entry has a more established source and the confidence difference is minimal.',
    KEEP_INCOMING: 'KEEP_INCOMING: The incoming entry cites a more authoritative and recent source.',
    ESCALATE: 'ESCALATE: Both sources have comparable authority and the values are genuinely contradictory.',
};

const UNRELIABLE_FAILURE_ROTATION: MockFailureMode[] = [
    'malformed_json',
    'truncated',
    'wrong_shape',
    'empty',
    'throw',
];

/**
 * S3: deterministic prompt kinds the mock knows how to answer. Every Staff
 * prompt gets classified into exactly one of these kinds before any response
 * is computed. The flat substring-based if/else chain that used to drive
 * complete() is now a single switch on the classifier output. Benefits:
 *
 * - The classifier is a pure function: easy to unit-test in isolation, no
 *   provider state required. Tests can assert which kind a given Staff
 *   prompt classifies to WITHOUT running the mock.
 * - Kind counts are tracked so tests can verify that a scenario exercised
 *   every expected branch instead of guessing from fallthrough counts alone.
 * - Adding a new Staff prompt means adding one kind + one case, not hunting
 *   for a spot in a regex chain.
 *
 * 'unknown' is the deliberate fallthrough — a prompt the classifier did not
 * recognize. The existing fallthrough machinery (strictFallthrough,
 * onFallthrough, canned researcher JSON) still handles this case so behavior
 * is exactly preserved across the refactor.
 */
export type PromptKind =
    | 'memory_need'
    | 'entity_extraction'
    | 'task_inference'
    | 'relevance_filter'
    | 'conflict_resolution'
    | 'fact_extraction'
    | 'compression'
    | 'unknown';

/**
 * S3: classify a Staff prompt into its deterministic kind. Pure function —
 * no side effects, no provider state, no randomness. The matching rules are
 * intentionally the same substrings the flat dispatch used, so this refactor
 * preserves behavior bit-for-bit; only the structure changes.
 */
export function classifyPromptKind(message: string): PromptKind {
    const lower = message.toLowerCase();
    if (
        lower.includes('return only valid json with this exact shape:')
        && lower.includes('"needsmemory"')
    ) {
        return 'memory_need';
    }
    if (lower.includes('extract explicitly named entities from the text')) {
        return 'entity_extraction';
    }
    if (lower.includes('specific type of task')) {
        return 'task_inference';
    }
    if (lower.includes('return only the numbers of entries that are directly relevant')) {
        return 'relevance_filter';
    }
    if (lower.includes('genuinely contradictory') || lower.includes('keep_existing')) {
        return 'conflict_resolution';
    }
    if (
        lower.includes('extract only distinct facts')
        || lower.includes('extract every distinct')
        || lower.includes('extracting structured facts')
        || lower.includes('atomic facts')
    ) {
        return 'fact_extraction';
    }
    if (lower.includes('compress') || lower.includes('summarize')) {
        return 'compression';
    }
    return 'unknown';
}

class MockProvider implements LLMProvider {
    private config: MockConfig;
    private rand: () => number;
    private callCount = 0;
    private fallthroughCount = 0;
    private lastFallthrough: MockFallthroughEvent | null = null;
    private failureModeCount = 0;
    private lastFailureMode: MockFailureEvent | null = null;
    private scheduledFailuresRemaining = 0;
    private unreliableRotationIndex = 0;
    // S3: counter per prompt kind. Tests can assert specific scenarios
    // exercised specific branches instead of guessing from fallthrough counts.
    private kindCounts: Record<PromptKind, number> = {
        memory_need: 0,
        entity_extraction: 0,
        task_inference: 0,
        relevance_filter: 0,
        conflict_resolution: 0,
        fact_extraction: 0,
        compression: 0,
        unknown: 0,
    };

    constructor(config: MockConfig = { scenario: 'default' }) {
        this.config = config;
        this.rand = seededRandom(config.seed ?? 42);
    }

    configure(config: Partial<MockConfig>): void {
        Object.assign(this.config, config);
        this.rand = seededRandom(this.config.seed ?? 42);
        this.callCount = 0;
        this.fallthroughCount = 0;
        this.lastFallthrough = null;
        this.failureModeCount = 0;
        this.lastFailureMode = null;
        this.scheduledFailuresRemaining = this.config.failBeforeSuccessCount ?? 0;
        this.unreliableRotationIndex = 0;
        this.resetKindCounts();
    }

    private resetKindCounts(): void {
        this.kindCounts = {
            memory_need: 0,
            entity_extraction: 0,
            task_inference: 0,
            relevance_filter: 0,
            conflict_resolution: 0,
            fact_extraction: 0,
            compression: 0,
            unknown: 0,
        };
    }

    async complete(messages: LLMMessage[], options?: CompleteOptions): Promise<LLMResponse> {
        this.callCount += 1;
        const lastMessage = messages[messages.length - 1].content;
        const scenario = this.config.scenario;
        const model = options?.model ?? 'mock';
        // S3: classify the prompt exactly once and record the kind. All
        // branch decisions below dispatch on this value instead of re-scanning
        // the message with substring checks.
        const kind = classifyPromptKind(lastMessage);
        this.kindCounts[kind] += 1;

        const delayRange = this.config.responseDelayRangeMs;
        if (delayRange && delayRange[1] > 0) {
            const [min, max] = delayRange;
            const lo = Math.max(0, Math.min(min, max));
            const hi = Math.max(0, Math.max(min, max));
            const span = hi - lo;
            const ms = span > 0 ? lo + Math.floor(this.rand() * (span + 1)) : lo;
            if (ms > 0) {
                await sleep(ms);
            }
        } else {
            const responseDelayMs = this.config.responseDelayMs ?? 0;
            if (responseDelayMs > 0) {
                await sleep(responseDelayMs);
            }
        }

        const failureRate = this.config.failureRate ?? 0;
        if (failureRate > 0 && this.rand() < failureRate) {
            throw new Error(`[mock] Simulated provider failure (rate: ${failureRate})`);
        }

        // Resolve whether this call should fire a failure mode. Scheduled
        // failures (failBeforeSuccessCount) win over probabilistic ones so
        // tests can deterministically exercise retry paths.
        const activeFailure = this.resolveActiveFailureMode();
        if (activeFailure && activeFailure.mode === 'throw') {
            this.recordFailureMode('throw', activeFailure.scheduled);
            throw new Error(`[mock] Simulated failure mode: throw (call #${this.callCount})`);
        }

        // S3: deterministic dispatch. Every branch reads exactly the same
        // blocks of lastMessage it used to read in the flat if/else chain,
        // so behavior is unchanged — but the structure is now a single
        // exhaustive switch keyed on the classifier output, and each case
        // is independently testable via the exported kind counts.
        switch (kind) {
            case 'memory_need': {
                const latestMessage = extractBlock(lastMessage, 'Latest user message:', ['Recent context excerpt:']);
                return this.respond(JSON.stringify(classifyMemoryNeed(latestMessage)), model, activeFailure);
            }
            case 'entity_extraction': {
                const text = extractBlock(lastMessage, 'Text:');
                return this.respond(JSON.stringify(detectEntities(text)), model, activeFailure);
            }
            case 'task_inference': {
                const opts = TASK_INFERENCES[scenario] ?? TASK_INFERENCES.default;
                const idx = Math.floor(this.rand() * opts.length);
                return this.respond(opts[idx], model, activeFailure);
            }
            case 'relevance_filter': {
                const task = extractBlock(lastMessage, 'Agent task:', ['Available knowledge entries:']);
                const entries = extractBlock(lastMessage, 'Available knowledge entries:');
                return this.respond(chooseRelevantEntries(task, entries), model, activeFailure);
            }
            case 'conflict_resolution': {
                if (scenario === 'disagreement') {
                    const r = this.rand();
                    if (r < 0.4) return this.respond(CONFLICT_RESOLUTIONS.KEEP_EXISTING, model, activeFailure);
                    if (r < 0.7) return this.respond(CONFLICT_RESOLUTIONS.KEEP_INCOMING, model, activeFailure);
                    return this.respond(CONFLICT_RESOLUTIONS.ESCALATE, model, activeFailure);
                }
                return this.respond(CONFLICT_RESOLUTIONS.KEEP_EXISTING, model, activeFailure);
            }
            case 'fact_extraction': {
                const text = extractBlock(lastMessage, 'Text to chunk:', ['Extract only distinct facts', 'Return ONLY a valid JSON array', 'If no facts can be extracted']);
                const facts = extractFactsFromText(text);
                return this.respond(JSON.stringify(facts), model, activeFailure);
            }
            case 'compression': {
                return this.respond('Compressed working memory summary for current task context.', model, activeFailure);
            }
            case 'unknown':
                // Fall through to the canned fallthrough handling below so the
                // strictFallthrough + onFallthrough + canned researcher JSON
                // path is preserved bit-for-bit across the refactor.
                break;
        }

        this.fallthroughCount += 1;
        const fallthroughEvent: MockFallthroughEvent = {
            prompt: lastMessage,
            promptSnippet: lastMessage.length > 240 ? `${lastMessage.slice(0, 240)}…` : lastMessage,
            callCount: this.callCount,
            at: Date.now(),
        };
        this.lastFallthrough = fallthroughEvent;
        if (this.config.onFallthrough) {
            try {
                this.config.onFallthrough(fallthroughEvent);
            } catch {
                // Intentionally swallow observer errors so the mock cannot be
                // destabilized by a misbehaving test hook.
            }
        }
        if (this.config.strictFallthrough) {
            throw new Error(
                `[mock] Unmatched prompt on call #${this.callCount}. `
                + `Enable a specific branch in MockProvider.complete() or remove strictFallthrough to allow the canned researcher JSON. `
                + `Prompt snippet: ${fallthroughEvent.promptSnippet}`,
            );
        }

        return this.respond(
            `I have completed my analysis.\n\n` +
            `{\n` +
            `  "name": "Sample Researcher",\n` +
            `  "affiliation": "MIT",\n` +
            `  "publication_count": 45,\n` +
            `  "research_focus": "machine learning",\n` +
            `  "notable_contribution": "Foundational work in neural networks",\n` +
            `  "confidence": 85\n` +
            `}`,
            model,
            activeFailure,
        );
    }

    private respond(
        text: string,
        model: string,
        activeFailure?: { mode: MockFailureMode; scheduled: boolean } | null,
    ): LLMResponse {
        if (activeFailure && activeFailure.mode !== 'throw') {
            const corrupted = this.applyFailureMode(text, activeFailure.mode);
            this.recordFailureMode(activeFailure.mode, activeFailure.scheduled);
            return { text: corrupted, model, provider: 'mock' };
        }
        return { text, model, provider: 'mock' };
    }

    private resolveActiveFailureMode(): { mode: MockFailureMode; scheduled: boolean } | null {
        // Scheduled failures (failBeforeSuccessCount) take priority so retry
        // tests can rely on deterministic sequencing.
        if (this.scheduledFailuresRemaining > 0) {
            this.scheduledFailuresRemaining -= 1;
            const scheduledMode = this.config.failureMode
                ?? (this.config.scenario === 'unreliable' ? this.nextUnreliableMode() : 'throw');
            return { mode: scheduledMode, scheduled: true };
        }

        // Unreliable scenario: rotate through failure modes at a steady rate
        // so Staff consumers see every shape over a handful of calls.
        if (this.config.scenario === 'unreliable') {
            const rate = this.config.failureModeRate ?? 0.6;
            if (rate > 0 && this.rand() < rate) {
                return { mode: this.nextUnreliableMode(), scheduled: false };
            }
            return null;
        }

        // Explicit probabilistic failure mode.
        if (this.config.failureMode) {
            const rate = this.config.failureModeRate ?? 0;
            if (rate > 0 && this.rand() < rate) {
                return { mode: this.config.failureMode, scheduled: false };
            }
        }

        return null;
    }

    private nextUnreliableMode(): MockFailureMode {
        const mode = UNRELIABLE_FAILURE_ROTATION[this.unreliableRotationIndex % UNRELIABLE_FAILURE_ROTATION.length];
        this.unreliableRotationIndex += 1;
        return mode;
    }

    private recordFailureMode(mode: MockFailureMode, scheduled: boolean): void {
        this.failureModeCount += 1;
        const event: MockFailureEvent = {
            mode,
            callCount: this.callCount,
            at: Date.now(),
            scheduled,
        };
        this.lastFailureMode = event;
        if (this.config.onFailureMode) {
            try {
                this.config.onFailureMode(event);
            } catch {
                // Observer errors must not destabilize the provider itself.
            }
        }
    }

    private applyFailureMode(text: string, mode: MockFailureMode): string {
        switch (mode) {
            case 'empty':
                return '';
            case 'truncated': {
                if (text.length === 0) return '';
                const half = Math.max(1, Math.floor(text.length / 2));
                return text.slice(0, half);
            }
            case 'malformed_json': {
                // If the text was meant to be JSON, drop the closing bracket.
                // Otherwise, wrap it in a broken JSON envelope so Staff JSON
                // parsers still fail loudly.
                const trimmed = text.trim();
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    // Strip the final closing bracket and append a stray comma
                    // so JSON.parse will reject it.
                    const withoutLast = trimmed.slice(0, -1);
                    return `${withoutLast},`;
                }
                return `{"partial": ${JSON.stringify(trimmed)}, "truncated": tru`;
            }
            case 'wrong_shape': {
                // Return syntactically valid JSON that does not match any
                // Staff consumer's expected schema. Useful for exercising
                // schema / type-guard fallbacks rather than parse fallbacks.
                return JSON.stringify({ unexpected: true, original: text });
            }
            case 'throw':
                // Handled earlier in complete(); if we get here it's a bug.
                return text;
        }
    }

    getCallCount(): number {
        return this.callCount;
    }

    resetCallCount(): void {
        this.callCount = 0;
    }

    getFallthroughCount(): number {
        return this.fallthroughCount;
    }

    getLastFallthrough(): MockFallthroughEvent | null {
        return this.lastFallthrough;
    }

    resetFallthroughTracking(): void {
        this.fallthroughCount = 0;
        this.lastFallthrough = null;
    }

    getFailureModeCount(): number {
        return this.failureModeCount;
    }

    getLastFailureMode(): MockFailureEvent | null {
        return this.lastFailureMode;
    }

    getScheduledFailuresRemaining(): number {
        return this.scheduledFailuresRemaining;
    }

    resetFailureModeTracking(): void {
        this.failureModeCount = 0;
        this.lastFailureMode = null;
        this.scheduledFailuresRemaining = this.config.failBeforeSuccessCount ?? 0;
        this.unreliableRotationIndex = 0;
    }

    // S3: externally observable kind-count snapshots. Tests can call
    // getKindCounts() to assert which classifier branches were exercised
    // by a run. resetKindCountsExternal() clears counts between test cases
    // without touching call/fallthrough/failure counters.
    getKindCounts(): Record<PromptKind, number> {
        return { ...this.kindCounts };
    }

    resetKindCountsExternal(): void {
        this.resetKindCounts();
    }
}

const mockProvider = new MockProvider();

export function configureMock(config: Partial<MockConfig>): void {
    mockProvider.configure(config);
}

export function getMockFallthroughCount(): number {
    return mockProvider.getFallthroughCount();
}

export function getLastMockFallthrough(): MockFallthroughEvent | null {
    return mockProvider.getLastFallthrough();
}

export function resetMockFallthroughTracking(): void {
    mockProvider.resetFallthroughTracking();
}

export function getMockFailureModeCount(): number {
    return mockProvider.getFailureModeCount();
}

export function getLastMockFailureMode(): MockFailureEvent | null {
    return mockProvider.getLastFailureMode();
}

export function getMockScheduledFailuresRemaining(): number {
    return mockProvider.getScheduledFailuresRemaining();
}

export function resetMockFailureModeTracking(): void {
    mockProvider.resetFailureModeTracking();
}

// S3: module-level accessors for the prompt-kind counts. Tests can import
// these directly without touching the singleton.
export function getMockKindCounts(): Record<PromptKind, number> {
    return mockProvider.getKindCounts();
}

export function resetMockKindCounts(): void {
    mockProvider.resetKindCountsExternal();
}

export default mockProvider;
