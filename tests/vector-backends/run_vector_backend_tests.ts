import 'dotenv/config';
import { bootstrapHarness } from '../../scripts/harness';
import { createVectorBackend } from '../../src/library/backends';
import { createEntry, deleteEntryById } from '../../src/library/queries';
import { generateEmbedding } from '../../src/library/embeddings';

type CaseResult = {
    name: string;
    status: 'pass' | 'skip' | 'fail';
    details?: string;
};

let counter = 0;

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function uniqueId(prefix: string): string {
    counter += 1;
    return `${prefix}_${Date.now()}_${counter}`;
}

async function runCase(name: string, run: () => Promise<void>): Promise<CaseResult> {
    try {
        await run();
        return { name, status: 'pass' };
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('SKIP:')) {
            return {
                name,
                status: 'skip',
                details: error.message.replace(/^SKIP:\s*/, ''),
            };
        }
        return {
            name,
            status: 'fail',
            details: error instanceof Error ? error.message : String(error),
        };
    }
}

async function withMockFetch(
    handler: (url: string, init?: RequestInit) => Promise<Response>,
    run: () => Promise<void>
): Promise<void> {
    const original = global.fetch;
    global.fetch = (async (input: any, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : String(input);
        return handler(url, init);
    }) as typeof fetch;

    try {
        await run();
    } finally {
        global.fetch = original;
    }
}

async function testPgvectorBackend(): Promise<void> {
    process.env.LLM_PROVIDER = 'mock';
    bootstrapHarness({ requireDb: true, forceLocalEscalationDir: true });

    const entityId = uniqueId('vector_backend');
    const entry = await createEntry({
        entityType: 'project',
        entityId,
        key: 'tagline',
        valueRaw: { text: 'luminous harbor analytics' },
        valueSummary: 'Luminous Harbor analytics platform',
        confidence: 88,
        source: 'vector_test',
        createdBy: 'vector_test_runner',
    });

    try {
        const backend = createVectorBackend({ vectorBackend: 'pgvector' });
        if (!(await backend.ping())) {
            throw new Error('SKIP: validation database does not expose pgvector support.');
        }
        const results = await backend.search(generateEmbedding('luminous harbor analytics'), 5, {
            entityType: 'project',
            entityId,
        });

        expect(results.some((result) => Number(result.metadata.id) === entry.id), 'Expected pgvector backend to return the created fact.');
    } finally {
        await deleteEntryById(entry.id);
    }
}

async function testFactorySelection(): Promise<void> {
    expect(createVectorBackend({ vectorBackend: 'pgvector' }).constructor.name === 'PgvectorBackend', 'Expected pgvector backend.');
    expect(
        createVectorBackend({ vectorBackend: 'qdrant', qdrantUrl: 'http://localhost:6333' }).constructor.name === 'QdrantBackend',
        'Expected qdrant backend.'
    );
    expect(
        createVectorBackend({ vectorBackend: 'chroma', chromaUrl: 'http://localhost:8000' }).constructor.name === 'ChromaBackend',
        'Expected chroma backend.'
    );

    let unknownFailed = false;
    try {
        createVectorBackend({ vectorBackend: 'unknown' });
    } catch {
        unknownFailed = true;
    }
    expect(unknownFailed, 'Expected unknown vector backend to throw.');

    let missingQdrantUrlFailed = false;
    try {
        createVectorBackend({ vectorBackend: 'qdrant' });
    } catch {
        missingQdrantUrlFailed = true;
    }
    expect(missingQdrantUrlFailed, 'Expected missing Qdrant URL to throw.');
}

async function testQdrantBackend(): Promise<void> {
    const seen: Array<{ url: string; method: string }> = [];

    await withMockFetch(async (url, init) => {
        seen.push({ url, method: init?.method ?? 'GET' });
        if (url.endsWith('/collections/iranti_facts') && init?.method === 'GET') {
            return new Response(JSON.stringify({ result: { status: 'green' } }), { status: 200 });
        }
        if (url.endsWith('/collections/iranti_facts/points') && init?.method === 'PUT') {
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        if (url.endsWith('/collections/iranti_facts/points/query') && init?.method === 'POST') {
            return new Response(JSON.stringify({
                result: {
                    points: [{
                        score: 0.92,
                        payload: {
                            id: 17,
                            entityType: 'project',
                            entityId: 'aurora',
                            key: 'summary',
                        },
                    }],
                },
            }), { status: 200 });
        }
        if (url.endsWith('/collections') && init?.method === 'GET') {
            return new Response(JSON.stringify({ result: { collections: [] } }), { status: 200 });
        }
        if (url.endsWith('/collections/iranti_facts/points/delete') && init?.method === 'POST') {
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'unexpected route' }), { status: 500 });
    }, async () => {
        const backend = createVectorBackend({
            vectorBackend: 'qdrant',
            qdrantUrl: 'http://qdrant.local',
            qdrantCollection: 'iranti_facts',
        });

        await backend.upsert({
            id: '17',
            vector: [0.1, 0.2],
            metadata: { id: 17, entityType: 'project', entityId: 'aurora', key: 'summary' },
        });
        const results = await backend.search([0.1, 0.2], 3, { entityType: 'project' });
        await backend.delete('17');

        expect(results.length === 1, 'Expected one Qdrant result.');
        expect(results[0].metadata.id === 17, 'Expected Qdrant metadata id mapping.');
        expect(seen.some((call) => call.url.endsWith('/collections/iranti_facts/points/query')), 'Expected Qdrant query endpoint call.');
    });
}

async function testChromaBackend(): Promise<void> {
    const seen: Array<{ url: string; method: string }> = [];

    await withMockFetch(async (url, init) => {
        seen.push({ url, method: init?.method ?? 'GET' });
        if (url.includes('/collections') && init?.method === 'GET') {
            return new Response(JSON.stringify([{ id: 'collection-1', name: 'iranti_facts' }]), { status: 200 });
        }
        if (url.endsWith('/collection-1/upsert') && init?.method === 'POST') {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith('/collection-1/query') && init?.method === 'POST') {
            return new Response(JSON.stringify({
                metadatas: [[{
                    id: 22,
                    entityType: 'project',
                    entityId: 'beacon',
                    key: 'summary',
                }]],
                distances: [[0.08]],
            }), { status: 200 });
        }
        if (url.endsWith('/collection-1/delete') && init?.method === 'POST') {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'unexpected route' }), { status: 500 });
    }, async () => {
        const backend = createVectorBackend({
            vectorBackend: 'chroma',
            chromaUrl: 'http://chroma.local',
            chromaCollection: 'iranti_facts',
        });

        await backend.upsert({
            id: '22',
            vector: [0.4, 0.6],
            metadata: { id: 22, entityType: 'project', entityId: 'beacon', key: 'summary' },
        });
        const results = await backend.search([0.4, 0.6], 2, { entityType: 'project' });
        await backend.delete('22');

        expect(results.length === 1, 'Expected one Chroma result.');
        expect(results[0].metadata.id === 22, 'Expected Chroma metadata id mapping.');
        expect(seen.some((call) => call.url.endsWith('/collection-1/query')), 'Expected Chroma query endpoint call.');
    });
}

async function main(): Promise<void> {
    const results = [
        await runCase('pgvector backend returns stored fact from vector search', testPgvectorBackend),
        await runCase('backend factory selects and validates backends', testFactorySelection),
        await runCase('qdrant backend maps REST responses correctly', testQdrantBackend),
        await runCase('chroma backend maps REST responses correctly', testChromaBackend),
    ];

    console.log('Vector backend tests');
    console.log('--------------------');
    for (const result of results) {
        const label = result.status === 'pass' ? 'PASS' : result.status === 'skip' ? 'SKIP' : 'FAIL';
        console.log(`${label} ${result.name}${result.details ? ` — ${result.details}` : ''}`);
    }
    console.log('--------------------');
    console.log(`Passed: ${results.filter((result) => result.status === 'pass').length}`);
    console.log(`Skipped: ${results.filter((result) => result.status === 'skip').length}`);
    console.log(`Failed: ${results.filter((result) => result.status === 'fail').length}`);

    process.exit(results.every((result) => result.status !== 'fail') ? 0 : 1);
}

main().catch((error) => {
    console.error('Vector backend tests failed:', error);
    process.exit(1);
});
