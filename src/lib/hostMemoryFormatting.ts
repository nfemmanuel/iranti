/**
 * Host memory injection block formatter.
 *
 * Converts raw fact objects into structured text blocks that get injected into
 * an LLM host's context window. The format uses stable F-prefixed fact IDs,
 * entity/key attribution, and operating instructions so the host knows to
 * prefer injected facts over re-inference.
 *
 * Compact mode: facts with confidence ≥ 90 and age ≤ 7 days are rendered in
 * a shorter one-line form (omitting confidence, source detail, and lastUpdated)
 * to reduce token noise for high-signal recent facts.
 *
 * Key exports:
 *   - formatStructuredFactBlock()  — render a fact array into an injection block
 *   - assignStructuredFactIds()    — stamp F-prefixed IDs onto facts
 *   - splitEntityKey()             — split "type/id/key" into entity + key parts
 *   - StructuredHostMemoryFact     — typed fact with guaranteed factId
 */

type HostMemoryFactInput = {
    factId?: string;
    entityKey: string;
    summary: string;
    value?: unknown;
    confidence: number;
    source: string;
    lastUpdated?: string;
};

export type StructuredHostMemoryFact<T extends HostMemoryFactInput = HostMemoryFactInput> = T & {
    factId: string;
};

type StructuredFactBlockOptions = {
    title: string;
    includeValues?: boolean;
    introLines?: string[];
};

function formatValue(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

// Compact header threshold: high-confidence recent facts don't need
// confidence/source/lastUpdated in the injection block — they add noise.
const COMPACT_CONFIDENCE_MIN = 90;
const COMPACT_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isCompactFact(fact: HostMemoryFactInput): boolean {
    if (fact.confidence < COMPACT_CONFIDENCE_MIN) return false;
    if (!fact.lastUpdated) return false;
    return Date.now() - new Date(fact.lastUpdated).getTime() < COMPACT_AGE_MS;
}

export function splitEntityKey(entityKey: string): { entity: string; key: string } {
    const segments = entityKey.split('/');
    if (segments.length < 3) {
        return {
            entity: entityKey,
            key: '',
        };
    }

    return {
        entity: `${segments[0]}/${segments[1]}`,
        key: segments.slice(2).join('/'),
    };
}

export function assignStructuredFactIds<T extends HostMemoryFactInput>(facts: T[]): Array<StructuredHostMemoryFact<T>> {
    return facts.map((fact, index) => ({
        ...fact,
        factId: fact.factId?.trim() || `F${index + 1}`,
    }));
}

export function formatStructuredFactBlock<T extends HostMemoryFactInput>(
    facts: T[],
    options: StructuredFactBlockOptions,
): string {
    const structuredFacts = assignStructuredFactIds(facts);
    if (structuredFacts.length === 0) {
        return '';
    }

    const lines = [
        `[${options.title}]`,
        ...(options.introLines ?? [
            'REQUIRED: Prefer the injected facts below before re-inference.',
            'If an injected fact conflicts with your guess, use the injected fact.',
            'REQUIRED: Call mcp__iranti__iranti_write after every file edit, confirmed finding, and subagent completion.',
            'Fact IDs are stable only within this block.',
        ]),
        'FACTS:',
    ];

    for (const fact of structuredFacts) {
        const identity = splitEntityKey(fact.entityKey);
        const compact = isCompactFact(fact);
        if (compact) {
            lines.push(`- ${fact.factId} | ${fact.entityKey} | source=${fact.source}`);
        } else {
            lines.push(`- ${fact.factId} | entity=${identity.entity} | key=${identity.key || '(none)'} | confidence=${fact.confidence} | source=${fact.source}`);
        }
        lines.push(`  summary: ${fact.summary}`);
        if (options.includeValues && fact.value !== undefined) {
            lines.push(`  value: ${formatValue(fact.value)}`);
        }
        if (!compact && fact.lastUpdated) {
            lines.push(`  last_updated: ${fact.lastUpdated}`);
        }
    }

    return lines.join('\n');
}
