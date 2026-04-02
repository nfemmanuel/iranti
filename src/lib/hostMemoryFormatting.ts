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
            'Fact IDs are stable only within this block.',
        ]),
        'FACTS:',
    ];

    for (const fact of structuredFacts) {
        const identity = splitEntityKey(fact.entityKey);
        lines.push(`- ${fact.factId} | entity=${identity.entity} | key=${identity.key || '(none)'} | confidence=${fact.confidence} | source=${fact.source}`);
        lines.push(`  summary: ${fact.summary}`);
        if (options.includeValues && fact.value !== undefined) {
            lines.push(`  value: ${formatValue(fact.value)}`);
        }
        if (fact.lastUpdated) {
            lines.push(`  last_updated: ${fact.lastUpdated}`);
        }
    }

    return lines.join('\n');
}
