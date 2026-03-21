import assert from 'node:assert/strict';

async function main(): Promise<void> {
    const router = require('../../src/lib/router') as {
        route: (taskType: string, messages: Array<{ role: string; content: string }>, maxTokens?: number) => Promise<{
            text: string;
            model: string;
            providerUsed: string;
        }>;
    };

    const originalRoute = router.route;
    let callCount = 0;

    router.route = async (_taskType, messages) => {
        callCount += 1;
        const prompt = messages[messages.length - 1]?.content ?? '';

        if (callCount === 1) {
            return {
                text: '[]',
                model: 'mock-extraction',
                providerUsed: 'mock',
            };
        }

        if (prompt.includes('operates in Lisbon')) {
            return {
                text: JSON.stringify([
                    {
                        key: 'hq_city',
                        value: { city: 'Lisbon' },
                        summary: 'Headquartered in Lisbon.',
                        confidence: 96,
                    },
                ]),
                model: 'mock-extraction',
                providerUsed: 'mock',
            };
        }

        if (prompt.includes('42 employees')) {
            return {
                text: JSON.stringify([
                    {
                        key: 'team_size',
                        value: { count: 42 },
                        summary: 'Team size is 42.',
                        confidence: 95,
                    },
                ]),
                model: 'mock-extraction',
                providerUsed: 'mock',
            };
        }

        if (prompt.includes('18 months of runway')) {
            return {
                text: JSON.stringify([
                    {
                        key: 'runway_months',
                        value: { months: 18 },
                        summary: 'Runway is 18 months.',
                        confidence: 93,
                    },
                ]),
                model: 'mock-extraction',
                providerUsed: 'mock',
            };
        }

        return {
            text: '[]',
            model: 'mock-extraction',
            providerUsed: 'mock',
        };
    };

    try {
        delete require.cache[require.resolve('../../src/librarian/chunker')];
        const { chunkContent } = require('../../src/librarian/chunker') as {
            chunkContent: (input: {
                entityType: string;
                entityId: string;
                rawContent: string;
                source: string;
                confidence: number;
                createdBy: string;
            }) => Promise<{
                chunks: Array<{ key: string; valueRaw: unknown; valueSummary: string }>;
                extractedCandidates: number;
                skipped: number;
                reason?: string;
            }>;
        };

        const result = await chunkContent({
            entityType: 'project',
            entityId: 'sentence_fallback_case',
            rawContent: 'Avalon Spectrum currently operates in Lisbon. Avalon Spectrum has 42 employees. Avalon Spectrum has 18 months of runway.',
            source: 'benchmark_probe',
            confidence: 82,
            createdBy: 'ingest_tester',
        });

        assert.equal(callCount > 1, true, 'Expected sentence-level fallback to make multiple extraction calls.');
        assert.equal(result.extractedCandidates >= 3, true, `Expected at least 3 extracted candidates, got ${result.extractedCandidates}`);
        assert.equal(result.chunks.length === 3, true, `Expected 3 chunks, got ${result.chunks.length}`);
        assert.equal(result.reason, undefined, `Expected no failure reason, got ${result.reason}`);
        assert.equal(result.skipped, 0, `Expected no skipped facts, got ${result.skipped}`);
        assert.deepEqual(
            result.chunks.map((chunk) => chunk.key).sort(),
            ['hq_city', 'runway_months', 'team_size'].sort(),
            'Expected the sentence fallback to recover the expected keys.'
        );
    } finally {
        router.route = originalRoute;
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
