import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { bootstrapHarness } from '../../scripts/harness';
import { Iranti } from '../../src/sdk';
import { configureMock } from '../../src/lib/providers/mock';
import { getDb } from '../../src/library/client';
import { Prisma } from '../../src/generated/prisma/client';

export type BenchmarkExpectation = 'pass' | 'xfail';

export type BenchmarkCase = {
    name: string;
    expectation: BenchmarkExpectation;
    note?: string;
    run: (ctx: ScenarioContext) => Promise<void>;
};

export type BenchmarkSuite = {
    label: string;
    cases: BenchmarkCase[];
};

export type ScenarioContext = {
    iranti: Iranti;
    suffix: string;
    entity: (entityType: string, base: string) => string;
};

export type CaseStatus = 'pass' | 'fail' | 'xfail' | 'xpass';

export type CaseResult = {
    suite: string;
    name: string;
    status: CaseStatus;
    note?: string;
    details?: string;
};

let client: Iranti | null = null;
let counter = 0;

const BENCHMARK_SOURCE_RELIABILITY: Record<string, number> = {
    OpenAlex: 0.9,
    briefing_note: 0.5,
    finance_memo: 0.4,
    project_brief: 0.7,
    source_alpha: 0.5,
    source_beta: 0.5,
    timeline_brief: 0.7,
    delivery_report: 0.7,
    task_board: 0.6,
    org_chart: 0.7,
    recruiting_plan: 0.6,
    finance_notice: 0.7,
    ops_notice: 0.6,
    hr_exit_log: 0.9,
    project_roster: 0.7,
    legal_notice: 0.95,
    team_roster: 0.7,
    compliance_audit: 0.95,
    procurement_board: 0.7,
    grant_registry: 0.8,
};

export async function prepareConflictBenchmark(): Promise<Iranti> {
    process.env.LLM_PROVIDER = 'mock';
    process.env.IRANTI_ESCALATION_DIR = path.resolve(process.cwd(), 'tests', 'conflict', '.runtime', 'escalation');
    await fs.mkdir(process.env.IRANTI_ESCALATION_DIR, { recursive: true });

    bootstrapHarness({ requireDb: true, forceLocalEscalationDir: false });
    configureMock({
        scenario: 'default',
        seed: 42,
        failureRate: 0,
    });

    if (!client) {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('DATABASE_URL is required to run the conflict benchmark.');
        }
        client = new Iranti({
            connectionString,
            llmProvider: 'mock',
        });
    }

    return client;
}

export function makeScenarioContext(iranti: Iranti, suiteLabel: string, caseName: string): ScenarioContext {
    const suffix = `${slug(suiteLabel)}_${slug(caseName)}_${Date.now()}_${++counter}`;
    return {
        iranti,
        suffix,
        entity: (entityType: string, base: string) => `${entityType}/${slug(base)}_${suffix}`,
    };
}

export function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

export async function runSuite(suite: BenchmarkSuite, iranti: Iranti): Promise<CaseResult[]> {
    const results: CaseResult[] = [];

    for (const testCase of suite.cases) {
        await resetConflictState();
        const ctx = makeScenarioContext(iranti, suite.label, testCase.name);
        try {
            await testCase.run(ctx);
            results.push({
                suite: suite.label,
                name: testCase.name,
                status: testCase.expectation === 'xfail' ? 'xpass' : 'pass',
                note: testCase.note,
                details: testCase.expectation === 'xfail'
                    ? 'Scenario passed unexpectedly; capability may now be implemented.'
                    : undefined,
            });
        } catch (err) {
            const details = err instanceof Error ? err.message : String(err);
            results.push({
                suite: suite.label,
                name: testCase.name,
                status: testCase.expectation === 'xfail' ? 'xfail' : 'fail',
                note: testCase.note,
                details,
            });
        }
    }

    return results;
}

function slug(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

async function resetConflictState(): Promise<void> {
    const db = getDb();
    const conflictPolicy = {
        minConfidenceToOverwrite: 10,
        minConfidenceToAccept: 50,
        minResolutionCertainty: 0.7,
        sourceReliability: BENCHMARK_SOURCE_RELIABILITY,
        ttlDefaultsByKey: {},
        authoritativeSourcesByKey: {},
        observeKeyPriority: {},
        maxKeysPerEntity: 5,
        maxEntitiesPerObserve: 5,
    };

    const reliabilityStore = {
        scores: BENCHMARK_SOURCE_RELIABILITY,
        lastUpdated: new Date().toISOString(),
        totalResolutions: 0,
    };

    await db.knowledgeEntry.upsert({
        where: {
            entityType_entityId_key: {
                entityType: 'system',
                entityId: 'librarian',
                key: 'conflict_policy',
            },
        },
        update: {
            valueRaw: conflictPolicy as unknown as Prisma.InputJsonValue,
            valueSummary: 'Deterministic benchmark conflict policy.',
            confidence: 100,
            source: 'seed',
            createdBy: 'seed',
            updatedAt: new Date(),
            isProtected: true,
        },
        create: {
            entityType: 'system',
            entityId: 'librarian',
            key: 'conflict_policy',
            valueRaw: conflictPolicy as unknown as Prisma.InputJsonValue,
            valueSummary: 'Deterministic benchmark conflict policy.',
            confidence: 100,
            source: 'seed',
            createdBy: 'seed',
            isProtected: true,
            conflictLog: [],
        },
    });

    await db.knowledgeEntry.upsert({
        where: {
            entityType_entityId_key: {
                entityType: 'system',
                entityId: 'librarian',
                key: 'source_reliability',
            },
        },
        update: {
            valueRaw: reliabilityStore as unknown as Prisma.InputJsonValue,
            valueSummary: `Benchmark source reliability scores for ${Object.keys(BENCHMARK_SOURCE_RELIABILITY).length} sources`,
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
            valueSummary: `Benchmark source reliability scores for ${Object.keys(BENCHMARK_SOURCE_RELIABILITY).length} sources`,
            confidence: 100,
            source: 'system',
            createdBy: 'librarian',
            isProtected: true,
            conflictLog: [],
        },
    });
}
