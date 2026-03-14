import 'dotenv/config';
import { bootstrapHarness } from '../../scripts/harness';
import { Iranti } from '../../src/sdk';
import { getDb } from '../../src/library/client';
import { Prisma } from '../../src/generated/prisma/client';

let client: Iranti | null = null;
let counter = 0;

export function prepareDecayEnv(): void {
    process.env.IRANTI_DECAY_ENABLED = 'true';
    process.env.IRANTI_DECAY_STABILITY_BASE = '30';
    process.env.IRANTI_DECAY_STABILITY_INCREMENT = '5';
    process.env.IRANTI_DECAY_STABILITY_MAX = '365';
    process.env.IRANTI_DECAY_THRESHOLD = '10';
}

export async function prepareDecaySuite(): Promise<Iranti> {
    prepareDecayEnv();
    bootstrapHarness({ requireDb: true, forceLocalEscalationDir: true });

    if (!client) {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('DATABASE_URL is required to run decay tests.');
        }
        client = new Iranti({
            connectionString,
            llmProvider: 'mock',
        });
    }

    await seedReliability({
        decay_source: 0.5,
        sticky_source: 0.95,
        cold_source: 0.3,
        threshold_source: 0.2,
    });

    return client;
}

export function uniqueEntity(base: string): string {
    counter += 1;
    return `project/${base}_${Date.now()}_${counter}`;
}

export function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

export async function seedReliability(scores: Record<string, number>): Promise<void> {
    const reliabilityStore = {
        scores,
        lastUpdated: new Date().toISOString(),
        totalResolutions: 0,
    };

    await getDb().knowledgeEntry.upsert({
        where: {
            entityType_entityId_key: {
                entityType: 'system',
                entityId: 'librarian',
                key: 'source_reliability',
            },
        },
        update: {
            valueRaw: reliabilityStore as unknown as Prisma.InputJsonValue,
            valueSummary: `Decay test reliability scores for ${Object.keys(scores).length} sources`,
            confidence: 100,
            source: 'system',
            createdBy: 'librarian',
            updatedAt: new Date(),
            isProtected: true,
        },
        create: {
            entityType: 'system',
            entityId: 'librarian',
            key: 'source_reliability',
            valueRaw: reliabilityStore as unknown as Prisma.InputJsonValue,
            valueSummary: `Decay test reliability scores for ${Object.keys(scores).length} sources`,
            confidence: 100,
            source: 'system',
            createdBy: 'librarian',
            isProtected: true,
            conflictLog: [],
        },
    });
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

export async function ageEntry(entryId: number, daysAgo: number, stability?: number): Promise<void> {
    const lastAccessedAt = new Date(Date.now() - daysAgo * 86_400_000);
    await getDb().knowledgeEntry.update({
        where: { id: entryId },
        data: {
            lastAccessedAt,
            ...(stability !== undefined ? { stability } : {}),
        },
    });
}
