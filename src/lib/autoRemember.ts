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

function isQuestionLike(prompt: string): boolean {
    const trimmed = prompt.trim();
    if (!trimmed) return false;
    if (trimmed.endsWith('?')) return true;
    return /^(what|when|where|who|why|how|do|did|does|can|could|should|would|is|are|am|was|were)\b/i.test(trimmed);
}

function buildTextFact(key: string, value: string): ExtractedMemoryFact {
    const cleanKey = canonicalizeMemoryKey(key);
    const cleanValue = value.trim();
    return {
        key: cleanKey,
        value: { text: cleanValue },
        summary: `${cleanKey.replace(/_/g, ' ')} is ${cleanValue}`,
    };
}

export function isAutoRememberEnabled(): boolean {
    const raw = process.env.IRANTI_AUTO_REMEMBER?.trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function extractExplicitPromptMemory(prompt: string): ExtractedMemoryFact[] {
    const raw = normalizePrompt(prompt);
    if (!raw || raw.startsWith('/')) return [];
    if (isQuestionLike(raw)) return [];

    const lower = raw.toLowerCase();
    const prefixes = ['actually ', 'correction: ', 'correction ', 'for the record, '];
    const stripped = prefixes.reduce((value, prefix) => value.startsWith(prefix) ? value.slice(prefix.length) : value, lower);

    const facts: ExtractedMemoryFact[] = [];

    const favoriteMatch = stripped.match(/^my favou?rite ([a-z0-9_\-\s]+?) is (.+)$/i);
    if (favoriteMatch) {
        facts.push(buildTextFact(`favorite_${favoriteMatch[1]}`, favoriteMatch[2]));
    }

    const myFieldMatch = stripped.match(/^my ([a-z0-9_\-\s]+?) is (.+)$/i);
    if (myFieldMatch && !facts.some((fact) => fact.key === canonicalizeMemoryKey(myFieldMatch[1]))) {
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
            key: 'decision',
            value: { text: decisionMatch[1].trim() },
            summary: `decision is ${decisionMatch[1].trim()}`,
        });
    }

    const nextStepMatch = stripped.match(/^(?:the )?next step is (.+)$/i);
    if (nextStepMatch) {
        facts.push({
            key: 'next_step',
            value: { instruction: nextStepMatch[1].trim() },
            summary: `next step is ${nextStepMatch[1].trim()}`,
        });
    }

    const blockerMatch = stripped.match(/^(?:the )?blocker is (.+)$/i);
    if (blockerMatch) {
        facts.push({
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
    if (yourFieldMatch && !facts.some((fact) => fact.key === canonicalizeMemoryKey(yourFieldMatch[1]))) {
        facts.push(buildTextFact(yourFieldMatch[1], yourFieldMatch[2]));
    }

    const decisionMatch = lower.match(/^we decided(?: that)? (.+)$/i);
    if (decisionMatch) {
        facts.push({
            key: 'decision',
            value: { text: decisionMatch[1].trim() },
            summary: `decision is ${decisionMatch[1].trim()}`,
        });
    }

    const nextStepMatch = lower.match(/^(?:the )?next step is (.+)$/i);
    if (nextStepMatch) {
        facts.push({
            key: 'next_step',
            value: { instruction: nextStepMatch[1].trim() },
            summary: `next step is ${nextStepMatch[1].trim()}`,
        });
    }

    const blockerMatch = lower.match(/^(?:the )?blocker is (.+)$/i);
    if (blockerMatch) {
        facts.push({
            key: 'blocker',
            value: { text: blockerMatch[1].trim() },
            summary: `blocker is ${blockerMatch[1].trim()}`,
        });
    }

    const ownerMatch = lower.match(/^(?:the )?current owner is (.+)$/i);
    if (ownerMatch) {
        facts.push({
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

export async function autoRememberPromptFacts(params: {
    iranti: IrantiQueryClient;
    prompt: string;
    agent: string;
    source: string;
    entity?: string | null;
    confidence?: number;
}): Promise<AutoRememberResult> {
    const {
        iranti,
        prompt,
        agent,
        source,
        entity = process.env.IRANTI_MEMORY_ENTITY?.trim(),
        confidence = 96,
    } = params;

    if (!isAutoRememberEnabled() || !entity) {
        return {
            enabled: false,
            extracted: 0,
            written: 0,
            skipped: [],
        };
    }

    const facts = extractExplicitPromptMemory(prompt);
    const skipped: Array<{ key: string; reason: string }> = [];
    let written = 0;

    for (const fact of facts) {
        const existing: { found: boolean; value?: unknown } = await iranti.query(entity, fact.key).catch(() => ({ found: false }));
        if (existing.found && comparableValue(existing.value) === comparableValue(fact.value)) {
            skipped.push({ key: fact.key, reason: 'unchanged' });
            continue;
        }

        await iranti.write({
            entity,
            key: fact.key,
            value: fact.value,
            summary: fact.summary,
            confidence,
            source,
            agent,
        });
        written += 1;
    }

    return {
        enabled: true,
        entity,
        extracted: facts.length,
        written,
        skipped,
    };
}

export async function autoRememberAssistantFacts(params: {
    iranti: IrantiQueryClient;
    response: string;
    agent: string;
    source: string;
    entity?: string | null;
    confidence?: number;
}): Promise<AutoRememberResult> {
    const {
        iranti,
        response,
        agent,
        source,
        entity = process.env.IRANTI_MEMORY_ENTITY?.trim(),
        confidence = 90,
    } = params;

    if (!isAutoRememberEnabled() || !entity) {
        return {
            enabled: false,
            extracted: 0,
            written: 0,
            skipped: [],
        };
    }

    const facts = extractExplicitAssistantMemory(response);
    const skipped: Array<{ key: string; reason: string }> = [];
    let written = 0;

    for (const fact of facts) {
        const existing: { found: boolean; value?: unknown } = await iranti.query(entity, fact.key).catch(() => ({ found: false }));
        if (existing.found && comparableValue(existing.value) === comparableValue(fact.value)) {
            skipped.push({ key: fact.key, reason: 'unchanged' });
            continue;
        }

        await iranti.write({
            entity,
            key: fact.key,
            value: fact.value,
            summary: fact.summary,
            confidence,
            source,
            agent,
        });
        written += 1;
    }

    return {
        enabled: true,
        entity,
        extracted: facts.length,
        written,
        skipped,
    };
}
