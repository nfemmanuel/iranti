import {
    __setVectorBackendSingletonForTests,
    archiveEntry,
    deleteEntryById,
    findArchiveHistory,
    findPendingEscalation,
} from '../../src/library/queries';
import { ArchivedReason } from '../../src/generated/prisma/client';
import { VectorBackend } from '../../src/library/vectorBackend';

type CaseResult = {
    name: string;
    passed: boolean;
    details?: string;
};

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

async function runCase(name: string, run: () => Promise<void>): Promise<CaseResult> {
    try {
        await run();
        return { name, passed: true };
    } catch (error) {
        return {
            name,
            passed: false,
            details: error instanceof Error ? error.message : String(error),
        };
    }
}

function failingVectorBackend(message: string): VectorBackend {
    return {
        upsert: async () => undefined,
        delete: async () => {
            throw new Error(message);
        },
        search: async () => [],
        ping: async () => true,
    };
}

function sampleEntry() {
    const now = new Date('2026-03-24T00:00:00.000Z');
    return {
        id: 77,
        entityType: 'project',
        entityId: 'archive_vector_case',
        key: 'status',
        valueRaw: { state: 'active' },
        valueSummary: 'Status is active.',
        confidence: 91,
        source: 'contract_test',
        validFrom: now,
        validUntil: null,
        createdBy: 'contract_tester',
        isProtected: false,
        conflictLog: [],
        properties: {},
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        stability: 1,
        embedding: null,
    };
}

async function main(): Promise<void> {
    const results: CaseResult[] = [];

    results.push(await runCase('deleteEntryById stops before KB delete when vector deletion fails', async () => {
        const deletedIds: number[] = [];
        __setVectorBackendSingletonForTests(failingVectorBackend('vector delete failed'));
        try {
            const fakeDb = {
                knowledgeEntry: {
                    delete: async ({ where }: { where: { id: number } }) => {
                        deletedIds.push(where.id);
                    },
                },
            };

            let error: Error | null = null;
            try {
                await deleteEntryById(42, fakeDb as any);
            } catch (err) {
                error = err as Error;
            }

            expect(error, 'Expected deleteEntryById() to surface the vector deletion failure.');
            expect(deletedIds.length === 0, 'Expected KB row delete to be skipped after vector deletion failure.');
        } finally {
            __setVectorBackendSingletonForTests(null);
        }
    }));

    results.push(await runCase('archiveEntry wraps tx-capable clients and rolls back on vector delete failure', async () => {
        const committedArchiveRows: Array<{ entityId: string; key: string }> = [];
        const committedDeletes: number[] = [];
        let transactionCalls = 0;

        __setVectorBackendSingletonForTests(failingVectorBackend('vector delete failed'));
        try {
            const fakeClient = {
                archive: {
                    create: async () => {
                        throw new Error('archive.create should only run inside the transaction client.');
                    },
                },
                knowledgeEntry: {
                    delete: async () => {
                        throw new Error('knowledgeEntry.delete should only run inside the transaction client.');
                    },
                },
                $transaction: async (callback: (tx: any) => Promise<void>) => {
                    transactionCalls += 1;
                    const stagedArchiveRows: Array<{ entityId: string; key: string }> = [];
                    const stagedDeletes: number[] = [];
                    const tx = {
                        archive: {
                            create: async ({ data }: { data: { entityId: string; key: string } }) => {
                                stagedArchiveRows.push({ entityId: data.entityId, key: data.key });
                                return { id: 1, ...data };
                            },
                        },
                        knowledgeEntry: {
                            delete: async ({ where }: { where: { id: number } }) => {
                                stagedDeletes.push(where.id);
                            },
                        },
                    };

                    try {
                        await callback(tx);
                        committedArchiveRows.push(...stagedArchiveRows);
                        committedDeletes.push(...stagedDeletes);
                    } catch (error) {
                        throw error;
                    }
                },
            };

            let error: Error | null = null;
            try {
                await archiveEntry(sampleEntry() as any, ArchivedReason.superseded, undefined, fakeClient as any);
            } catch (err) {
                error = err as Error;
            }

            expect(error, 'Expected archiveEntry() to fail when the vector backend delete fails.');
            expect(transactionCalls === 1, `Expected exactly one transaction attempt, got ${transactionCalls}.`);
            expect(committedArchiveRows.length === 0, 'Expected archive insert to roll back on vector deletion failure.');
            expect(committedDeletes.length === 0, 'Expected KB delete to roll back on vector deletion failure.');
        } finally {
            __setVectorBackendSingletonForTests(null);
        }
    }));

    results.push(await runCase('archive query helpers request deterministic id tie-breakers', async () => {
        let historyOrderBy: unknown = null;
        let pendingOrderBy: unknown = null;

        const fakeDb = {
            archive: {
                findMany: async (args: { orderBy: unknown }) => {
                    historyOrderBy = args.orderBy;
                    return [];
                },
                findFirst: async (args: { orderBy: unknown }) => {
                    pendingOrderBy = args.orderBy;
                    return null;
                },
            },
        };

        await findArchiveHistory({ entityType: 'project', entityId: 'alpha', key: 'status' }, undefined, fakeDb as any);
        await findPendingEscalation({ entityType: 'project', entityId: 'alpha', key: 'status' }, fakeDb as any);

        expect(
            JSON.stringify(historyOrderBy) === JSON.stringify([{ validFrom: 'asc' }, { archivedAt: 'asc' }, { id: 'asc' }]),
            `Expected deterministic history tie-break ordering, got ${JSON.stringify(historyOrderBy)}.`
        );
        expect(
            JSON.stringify(pendingOrderBy) === JSON.stringify([{ archivedAt: 'desc' }, { id: 'desc' }]),
            `Expected deterministic pending escalation ordering, got ${JSON.stringify(pendingOrderBy)}.`
        );
    }));

    printSummary(results);
    process.exit(results.every((result) => result.passed) ? 0 : 1);
}

function printSummary(results: CaseResult[]): void {
    console.log('Archive/vector contract tests');
    console.log('-----------------------------');
    for (const result of results) {
        if (result.passed) {
            console.log(`PASS  ${result.name}`);
        } else {
            console.log(`FAIL  ${result.name} - ${result.details}`);
        }
    }
    console.log('-----------------------------');
    console.log(`Total: ${results.filter((result) => result.passed).length}/${results.length}`);
}

main().catch((error) => {
    console.error('Archive/vector contract tests failed:', error);
    process.exit(1);
});
