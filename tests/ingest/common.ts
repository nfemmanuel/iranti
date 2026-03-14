import 'dotenv/config';
import { bootstrapHarness } from '../../scripts/harness';
import { getDb } from '../../src/library/client';

let client: import('../../src/sdk').Iranti | null = null;
let counter = 0;

export async function prepareIngestSuite(): Promise<import('../../src/sdk').Iranti> {
    process.env.LLM_PROVIDER = 'mock';
    bootstrapHarness({ requireDb: true, forceLocalEscalationDir: true });

    const { configureMock } = await import('../../src/lib/providers/mock');
    configureMock({
        scenario: 'default',
        seed: 42,
        failureRate: 0,
    });

    if (!client) {
        const { Iranti } = await import('../../src/sdk');
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('DATABASE_URL is required to run ingest tests.');
        }
        client = new Iranti({
            connectionString,
            llmProvider: 'mock',
        });
    }

    return client;
}

export function uniqueEntity(base: string): string {
    counter += 1;
    return `project/${base}_${Date.now()}_${counter}`;
}

export async function getKnowledgeEntry(entity: string, key: string) {
    const [entityType, entityId] = entity.split('/');
    return getDb().knowledgeEntry.findUnique({
        where: {
            entityType_entityId_key: {
                entityType,
                entityId,
                key,
            },
        },
    });
}

export function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}
