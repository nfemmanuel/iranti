type IrantiQueryClient = {
    query(entity: string, key: string): Promise<{ found: boolean; value?: unknown }>;
    write(input: {
        entity: string;
        key: string;
        value: unknown;
        summary: string;
        confidence: number;
        source: string;
        agent: string;
    }): Promise<unknown>;
};

type ExtractedMemoryFact = {
    scope: 'personal' | 'project';
    key: string;
    value: unknown;
    summary: string;
};

type AutoRememberResult = {
    enabled: boolean;
    entity?: string;
    extracted: number;
    written: number;
    skipped: Array<{ key: string; reason: string }>;
};

export type MandatoryRecallDecision = {
    required: boolean;
    scope: 'personal' | 'project' | null;
    key?: string;
    reason?: string;
};

export type BackfillChatRole = 'user' | 'assistant' | 'unknown';

export type BackfillChatMessage = {
    role: BackfillChatRole;
    text: string;
};

export const USER_PROMPT_AUTO_REMEMBER_SOURCE = 'UserPromptAutoRemember';

const PERSONAL_MEMORY_KEYS = new Set([
    'name',
    'email',
    'phone',
    'address',
    'city',
    'country',
    'home_city',
    'hometown',
    'likes',
]);

export function canonicalizeMemoryKey(text: string): string {
    return normalizeKey(text)
        .replace(/favourite/g, 'favorite')
        .replace(/colour/g, 'color');
}

function normalizeKey(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function normalizePrompt(prompt: string): string {
    return prompt.trim().replace(/\s+/g, ' ');
}

function normalizeEntity(entity: string | null | undefined): string | undefined {
    const trimmed = entity?.trim();
    return trimmed && trimmed.includes('/') ? trimmed : undefined;
}

function isQuestionLike(prompt: string): boolean {
    const trimmed = prompt.trim();
    if (!trimmed) return false;
    if (trimmed.endsWith('?')) return true;
    return /^(what|when|where|who|why|how|do|did|does|can|could|should|would|is|are|am|was|were)\b/i.test(trimmed);
}

function buildTextFact(key: string, value: string, scope: 'personal' | 'project' = 'personal'): ExtractedMemoryFact {
    const cleanKey = canonicalizeMemoryKey(key);
    const cleanValue = value.trim();
    return {
        scope,
        key: cleanKey,
        value: { text: cleanValue },
        summary: `${cleanKey.replace(/_/g, ' ')} is ${cleanValue}`,
    };
}

export function isAutoRememberEnabled(): boolean {
    const raw = process.env.IRANTI_AUTO_REMEMBER?.trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function stripDeclarativeLeadIns(text: string): string {
    let value = text.trim();
    const patterns = [
        /^(?:hey|hi|hello|yo)\s*,?\s*/i,
        /^(?:so|okay|ok|alright|well|right|btw|by the way)\s*,?\s*/i,
        /^(?:actually|correction:|correction|for the record)\s*,?\s*/i,
    ];

    let changed = true;
    while (changed) {
        changed = false;
        for (const pattern of patterns) {
            const next = value.replace(pattern, '');
            if (next !== value) {
                value = next.trim();
                changed = true;
            }
        }
    }

    return value;
}

export function getPersonalMemoryEntity(explicit?: string | null): string {
    return normalizeEntity(explicit)
        ?? normalizeEntity(process.env.IRANTI_PERSONAL_MEMORY_ENTITY)
        ?? 'user/main';
}

export function getProjectMemoryEntity(explicit?: string | null): string | undefined {
    return normalizeEntity(explicit)
        ?? normalizeEntity(process.env.IRANTI_MEMORY_ENTITY);
}

export function classifyMemoryScope(message: string): 'personal' | 'project' | null {
    const normalized = normalizePrompt(message).toLowerCase();
    if (!normalized) return null;

    if (/\b(next step|blocker|decision|current owner)\b/.test(normalized)) {
        return 'project';
    }
    if (/\b(my|me|i)\b/.test(normalized)) {
        return 'personal';
    }
    if (/\b(our|we)\b/.test(normalized)) {
        return 'project';
    }
    return null;
}

export function isPersonalMemoryKey(key: string): boolean {
    const normalized = canonicalizeMemoryKey(key);
    return normalized.startsWith('favorite_') || PERSONAL_MEMORY_KEYS.has(normalized);
}

export function detectMandatoryRecall(message: string): MandatoryRecallDecision {
    const normalized = normalizePrompt(message).toLowerCase();
    if (!normalized || normalized.startsWith('/')) {
        return { required: false, scope: null };
    }

    const favoriteMatch = normalized.match(/\bwhat(?:'s| is| was)?\s+my\s+favou?rite\s+([a-z0-9_\-\s]+)\b/i);
    if (favoriteMatch) {
        return {
            required: true,
            scope: 'personal',
            key: canonicalizeMemoryKey(`favorite_${favoriteMatch[1]}`),
            reason: 'favorite_recall_prompt',
        };
    }

    const myFieldMatch = normalized.match(/\bwhat(?:'s| is| was)?\s+my\s+([a-z0-9_\-\s]+)\b/i);
    if (myFieldMatch) {
        return {
            required: true,
            scope: 'personal',
            key: canonicalizeMemoryKey(myFieldMatch[1]),
            reason: 'personal_recall_prompt',
        };
    }

    if (/\b(?:what|remind me)(?:[^.?!]*)\bnext step\b/i.test(normalized)) {
        return {
            required: true,
            scope: 'project',
            key: 'next_step',
            reason: 'project_next_step_recall',
        };
    }

    if (/\b(?:what|remind me)(?:[^.?!]*)\bblocker\b/i.test(normalized)) {
        return {
            required: true,
            scope: 'project',
            key: 'blocker',
            reason: 'project_blocker_recall',
        };
    }

    if (/\bwhat did we decide\b/i.test(normalized) || /\b(?:what|remind me)(?:[^.?!]*)\bdecision\b/i.test(normalized)) {
        return {
            required: true,
            scope: 'project',
            key: 'decision',
            reason: 'project_decision_recall',
        };
    }

    if (/\b(?:who(?:'s| is)?\s+(?:the|our)\s+current owner|who owns (?:this|that|it))\b/i.test(normalized)) {
        return {
            required: true,
            scope: 'project',
            key: 'current_owner',
            reason: 'project_owner_recall',
        };
    }

    return { required: false, scope: null };
}

export function extractExplicitPromptMemory(prompt: string): ExtractedMemoryFact[] {
    const raw = normalizePrompt(prompt);
    if (!raw || raw.startsWith('/')) return [];
    if (isQuestionLike(raw)) return [];

    const lower = raw.toLowerCase();
    const stripped = stripDeclarativeLeadIns(lower);

    const facts: ExtractedMemoryFact[] = [];

    const favoriteMatch = stripped.match(/^my favou?rite ([a-z0-9_\-\s]+?) is (.+)$/i);
    if (favoriteMatch) {
        facts.push(buildTextFact(`favorite_${favoriteMatch[1]}`, favoriteMatch[2]));
    }

    const myFieldMatch = stripped.match(/^my ([a-z0-9_\-\s]+?) is (.+)$/i);
    if (myFieldMatch && !facts.some((fact) => {
        const fieldKey = canonicalizeMemoryKey(myFieldMatch[1]);
        return fact.key === fieldKey || fact.key === canonicalizeMemoryKey(`favorite_${myFieldMatch[1]}`);
    })) {
        facts.push(buildTextFact(myFieldMatch[1], myFieldMatch[2]));
    }

    const homeCityMatch = stripped.match(/^i live in (.+)$/i);
    if (homeCityMatch) {
        facts.push(buildTextFact('home_city', homeCityMatch[1]));
    }

    const hometownMatch = stripped.match(/^i(?:'m| am) from (.+)$/i);
    if (hometownMatch) {
        facts.push(buildTextFact('hometown', hometownMatch[1]));
    }

    const preferenceMatch = stripped.match(/^i (?:like|love|prefer) (.+)$/i);
    if (preferenceMatch) {
        facts.push(buildTextFact('likes', preferenceMatch[1]));
    }

    const decisionMatch = stripped.match(/^we decided(?: that)? (.+)$/i);
    if (decisionMatch) {
        facts.push({
            scope: 'project',
            key: 'decision',
            value: { text: decisionMatch[1].trim() },
            summary: `decision is ${decisionMatch[1].trim()}`,
        });
    }

    const nextStepMatch = stripped.match(/^(?:the )?next step is (.+)$/i);
    if (nextStepMatch) {
        facts.push({
            scope: 'project',
            key: 'next_step',
            value: { instruction: nextStepMatch[1].trim() },
            summary: `next step is ${nextStepMatch[1].trim()}`,
        });
    }

    const blockerMatch = stripped.match(/^(?:the )?blocker is (.+)$/i);
    if (blockerMatch) {
        facts.push({
            scope: 'project',
            key: 'blocker',
            value: { text: blockerMatch[1].trim() },
            summary: `blocker is ${blockerMatch[1].trim()}`,
        });
    }

    const deduped = new Map<string, ExtractedMemoryFact>();
    for (const fact of facts) {
        if (!fact.key || fact.summary.length > 220) continue;
        deduped.set(fact.key, fact);
    }

    return Array.from(deduped.values());
}

export function extractExplicitAssistantMemory(response: string): ExtractedMemoryFact[] {
    const raw = normalizePrompt(response);
    if (!raw) return [];

    const lower = raw.toLowerCase();
    const facts: ExtractedMemoryFact[] = [];

    const yourFavoriteMatch = lower.match(/^your favou?rite ([a-z0-9_\-\s]+?) is (.+)$/i);
    if (yourFavoriteMatch) {
        facts.push(buildTextFact(`favorite_${yourFavoriteMatch[1]}`, yourFavoriteMatch[2]));
    }

    const yourFieldMatch = lower.match(/^your ([a-z0-9_\-\s]+?) is (.+)$/i);
    if (yourFieldMatch && !facts.some((fact) => {
        const fieldKey = canonicalizeMemoryKey(yourFieldMatch[1]);
        return fact.key === fieldKey || fact.key === canonicalizeMemoryKey(`favorite_${yourFieldMatch[1]}`);
    })) {
        facts.push(buildTextFact(yourFieldMatch[1], yourFieldMatch[2]));
    }

    const decisionMatch = lower.match(/^we decided(?: that)? (.+)$/i);
    if (decisionMatch) {
        facts.push({
            scope: 'project',
            key: 'decision',
            value: { text: decisionMatch[1].trim() },
            summary: `decision is ${decisionMatch[1].trim()}`,
        });
    }

    const nextStepMatch = lower.match(/^(?:the )?next step is (.+)$/i);
    if (nextStepMatch) {
        facts.push({
            scope: 'project',
            key: 'next_step',
            value: { instruction: nextStepMatch[1].trim() },
            summary: `next step is ${nextStepMatch[1].trim()}`,
        });
    }

    const blockerMatch = lower.match(/^(?:the )?blocker is (.+)$/i);
    if (blockerMatch) {
        facts.push({
            scope: 'project',
            key: 'blocker',
            value: { text: blockerMatch[1].trim() },
            summary: `blocker is ${blockerMatch[1].trim()}`,
        });
    }

    const ownerMatch = lower.match(/^(?:the )?current owner is (.+)$/i);
    if (ownerMatch) {
        facts.push({
            scope: 'project',
            key: 'current_owner',
            value: { text: ownerMatch[1].trim() },
            summary: `current owner is ${ownerMatch[1].trim()}`,
        });
    }

    const deduped = new Map<string, ExtractedMemoryFact>();
    for (const fact of facts) {
        if (!fact.key || fact.summary.length > 220) continue;
        deduped.set(fact.key, fact);
    }

    return Array.from(deduped.values());
}

function comparableValue(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

async function persistExtractedFacts(params: {
    iranti: IrantiQueryClient;
    facts: ExtractedMemoryFact[];
    agent: string;
    source: string;
    phase: 'user_prompt' | 'assistant_response' | 'backfill';
    confidence: number;
    entity?: string | null;
    projectEntity?: string | null;
    personalEntity?: string | null;
}): Promise<AutoRememberResult> {
    const {
        iranti,
        facts,
        agent,
        source,
        phase,
        confidence,
        entity,
        projectEntity,
        personalEntity,
    } = params;

    const skipped: Array<{ key: string; reason: string }> = [];
    let written = 0;
    const writtenEntities = new Set<string>();

    for (const fact of facts) {
        const targetEntity = fact.scope === 'personal'
            ? getPersonalMemoryEntity(personalEntity)
            : getProjectMemoryEntity(projectEntity ?? entity);
        if (!targetEntity) {
            skipped.push({ key: fact.key, reason: 'missing_entity' });
            continue;
        }

        const existing: { found: boolean; value?: unknown } = await iranti.query(targetEntity, fact.key).catch(() => ({ found: false }));
        if (existing.found && comparableValue(existing.value) === comparableValue(fact.value)) {
            skipped.push({ key: fact.key, reason: 'unchanged' });
            continue;
        }

        const writeSource = phase === 'user_prompt' && fact.scope === 'personal'
            ? USER_PROMPT_AUTO_REMEMBER_SOURCE
            : source;

        await iranti.write({
            entity: targetEntity,
            key: fact.key,
            value: fact.value,
            summary: fact.summary,
            confidence,
            source: writeSource,
            agent,
        });
        written += 1;
        writtenEntities.add(targetEntity);
    }

    return {
        enabled: true,
        entity: writtenEntities.size === 1 ? Array.from(writtenEntities)[0] : undefined,
        extracted: facts.length,
        written,
        skipped,
    };
}

export async function autoRememberPromptFacts(params: {
    iranti: IrantiQueryClient;
    prompt: string;
    agent: string;
    source: string;
    entity?: string | null;
    projectEntity?: string | null;
    personalEntity?: string | null;
    confidence?: number;
}): Promise<AutoRememberResult> {
    const {
        iranti,
        prompt,
        agent,
        source,
        entity,
        projectEntity,
        personalEntity,
        confidence = 96,
    } = params;

    if (!isAutoRememberEnabled()) {
        return {
            enabled: false,
            extracted: 0,
            written: 0,
            skipped: [],
        };
    }

    const facts = extractExplicitPromptMemory(prompt);
    return persistExtractedFacts({
        iranti,
        facts,
        agent,
        source,
        phase: 'user_prompt',
        confidence,
        entity,
        projectEntity,
        personalEntity,
    });
}

export async function autoRememberAssistantFacts(params: {
    iranti: IrantiQueryClient;
    response: string;
    agent: string;
    source: string;
    entity?: string | null;
    projectEntity?: string | null;
    personalEntity?: string | null;
    confidence?: number;
}): Promise<AutoRememberResult> {
    const {
        iranti,
        response,
        agent,
        source,
        entity,
        projectEntity,
        personalEntity,
        confidence = 90,
    } = params;

    if (!isAutoRememberEnabled()) {
        return {
            enabled: false,
            extracted: 0,
            written: 0,
            skipped: [],
        };
    }

    const facts = extractExplicitAssistantMemory(response);
    return persistExtractedFacts({
        iranti,
        facts,
        agent,
        source,
        phase: 'assistant_response',
        confidence,
        entity,
        projectEntity,
        personalEntity,
    });
}

export async function rememberAssistantResponseFacts(params: {
    iranti: IrantiQueryClient;
    response: string;
    agent: string;
    source: string;
    entity?: string | null;
    projectEntity?: string | null;
    personalEntity?: string | null;
    confidence?: number;
}): Promise<AutoRememberResult> {
    const {
        iranti,
        response,
        agent,
        source,
        entity,
        projectEntity,
        personalEntity,
        confidence = 90,
    } = params;

    return persistExtractedFacts({
        iranti,
        facts: extractExplicitAssistantMemory(response),
        agent,
        source,
        phase: 'assistant_response',
        confidence,
        entity,
        projectEntity,
        personalEntity,
    });
}

export function parseBackfillChatTranscript(content: string): BackfillChatMessage[] {
    const normalized = content.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const messages: BackfillChatMessage[] = [];
    let current: BackfillChatMessage | null = null;

    const flush = (): void => {
        if (!current) return;
        const text = current.text.trim();
        if (text) {
            messages.push({
                role: current.role,
                text,
            });
        }
        current = null;
    };

    const detectRole = (line: string): BackfillChatMessage | null => {
        const match = line.match(/^\s*(user|human|assistant|claude|codex|system)\s*:\s*(.*)$/i);
        if (!match) return null;
        const label = (match[1] ?? '').toLowerCase();
        const text = (match[2] ?? '').trim();
        if (label === 'user' || label === 'human') {
            return { role: 'user', text };
        }
        if (label === 'assistant' || label === 'claude' || label === 'codex') {
            return { role: 'assistant', text };
        }
        return { role: 'unknown', text };
    };

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const detected = detectRole(line);
        if (detected) {
            flush();
            current = detected;
            continue;
        }

        if (!current) {
            if (!line.trim()) continue;
            current = {
                role: 'unknown',
                text: line,
            };
            continue;
        }

        if (!line.trim()) {
            flush();
            continue;
        }

        current.text = `${current.text}\n${line}`;
    }

    flush();
    return messages;
}

export async function backfillChatHistory(params: {
    iranti: IrantiQueryClient;
    content: string;
    agent: string;
    source: string;
    entity?: string | null;
    projectEntity?: string | null;
    personalEntity?: string | null;
    confidence?: number;
}): Promise<AutoRememberResult & { messagesParsed: number }> {
    const {
        iranti,
        content,
        agent,
        source,
        entity,
        projectEntity,
        personalEntity,
        confidence = 94,
    } = params;

    const messages = parseBackfillChatTranscript(content);
    const facts: ExtractedMemoryFact[] = [];
    for (const message of messages) {
        if (message.role === 'user') {
            facts.push(...extractExplicitPromptMemory(message.text));
            continue;
        }
        if (message.role === 'assistant') {
            facts.push(...extractExplicitAssistantMemory(message.text));
            continue;
        }
        facts.push(...extractExplicitPromptMemory(message.text));
        facts.push(...extractExplicitAssistantMemory(message.text));
    }

    const result = await persistExtractedFacts({
        iranti,
        facts,
        agent,
        source,
        phase: 'backfill',
        confidence,
        entity,
        projectEntity,
        personalEntity,
    });

    return {
        ...result,
        messagesParsed: messages.length,
    };
}
