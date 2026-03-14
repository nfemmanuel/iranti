import 'dotenv/config';
import path from 'path';
import { bootstrapHarness } from '../../scripts/harness';
import { Iranti } from '../../src/sdk';
import { configureMock } from '../../src/lib/providers/mock';
import { getDb } from '../../src/library/client';
import { librarianWrite } from '../../src/librarian';
import { createEntry, findPendingEscalation } from '../../src/library/queries';
import { resolveEntity } from '../../src/library/entity-resolution';

type CaseResult = {
    name: string;
    passed: boolean;
    details?: string;
};

let counter = 0;

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function uniqueEntity(prefix: string): string {
    counter += 1;
    return `project/${prefix}_${Date.now()}_${counter}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prepareSuite(): Promise<Iranti> {
    process.env.LLM_PROVIDER = 'mock';
    process.env.IRANTI_ESCALATION_DIR = path.resolve(process.cwd(), 'tests', 'consistency', '.runtime', 'escalation');
    bootstrapHarness({ requireDb: true, forceLocalEscalationDir: false });
    configureMock({
        scenario: 'default',
        seed: 17,
        failureRate: 0,
    });

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL is required to run the consistency suite.');
    }

    return new Iranti({
        connectionString,
        llmProvider: 'mock',
    });
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

async function main() {
    const iranti = await prepareSuite();
    const results: CaseResult[] = [];

    results.push(await runCase('Concurrent write serialization', async () => {
        const entity = uniqueEntity('consistency_concurrent');
        const [resultA, resultB] = await Promise.all([
            librarianWrite({
                entityType: 'project',
                entityId: entity.split('/')[1],
                key: 'status',
                valueRaw: { state: 'alpha' },
                valueSummary: 'Status is alpha.',
                confidence: 80,
                source: 'sync_feed',
                createdBy: 'agent_a',
            }),
            librarianWrite({
                entityType: 'project',
                entityId: entity.split('/')[1],
                key: 'status',
                valueRaw: { state: 'beta' },
                valueSummary: 'Status is beta.',
                confidence: 80,
                source: 'sync_feed',
                createdBy: 'agent_b',
            }),
        ]);

        const current = await iranti.query(entity, 'status');
        expect(current.found, 'Expected exactly one committed current value after concurrent writes.');
        expect(
            JSON.stringify(current.value) === JSON.stringify({ state: 'alpha' }) ||
            JSON.stringify(current.value) === JSON.stringify({ state: 'beta' }),
            `Expected surviving value to be alpha or beta, got ${JSON.stringify(current.value)}.`
        );
        expect(typeof current.confidence === 'number', 'Expected surviving value to keep a numeric confidence score.');
        expect(
            ['created', 'updated'].includes(resultA.action) && ['created', 'updated'].includes(resultB.action),
            `Expected serialized writes to resolve as created/updated, got ${resultA.action}/${resultB.action}.`
        );
    }));

    results.push(await runCase('Read-after-write visibility', async () => {
        const entity = uniqueEntity('consistency_read_after_write');
        await iranti.write({
            entity,
            key: 'budget',
            value: { amount: 64000 },
            summary: 'Budget is 64K.',
            confidence: 88,
            source: 'finance_sheet',
            agent: 'agent_writer',
        });

        const read = await iranti.query(entity, 'budget');
        expect(read.found, 'Expected immediate read-after-write to find the newly committed fact.');
        expect(JSON.stringify(read.value) === JSON.stringify({ amount: 64000 }), 'Expected immediate read to return the newly written value.');
        expect(read.confidence === 88, `Expected confidence 88, got ${read.confidence}.`);
    }));

    results.push(await runCase('Escalation state integrity', async () => {
        const entity = uniqueEntity('consistency_escalation');
        await iranti.write({
            entity,
            key: 'owner',
            value: { name: 'Iria Sol' },
            summary: 'Owner is Iria Sol.',
            confidence: 82,
            source: 'source_alpha',
            agent: 'agent_writer',
        });

        const second = await iranti.write({
            entity,
            key: 'owner',
            value: { name: 'Cael Vorn' },
            summary: 'Owner is Cael Vorn.',
            confidence: 82,
            source: 'source_beta',
            agent: 'agent_conflict',
        });

        expect(second.action === 'escalated', `Expected conflicting equal-confidence write to escalate, got ${second.action}.`);

        const current = await iranti.query(entity, 'owner');
        expect(!current.found, 'Expected current query to return not found while escalation is pending.');

        const asOf = await iranti.query(entity, 'owner', { asOf: new Date() });
        expect(asOf.found, 'Expected temporal query during escalation window to find archived contested state.');
        expect(asOf.fromArchive === true, 'Expected temporal escalation view to come from archive.');
        expect(asOf.contested === true, 'Expected temporal escalation view to be marked contested.');
        expect(asOf.archivedReason === 'escalated', `Expected archivedReason=escalated, got ${String(asOf.archivedReason)}.`);

        const [entityType, entityId] = entity.split('/');
        const pending = await findPendingEscalation({ entityType, entityId, key: 'owner' });
        expect(Boolean(pending), 'Expected pending escalated archive row to exist.');
    }));

    results.push(await runCase('Observe isolation', async () => {
        const entity = uniqueEntity('consistency_observe');
        const [entityType, entityId] = entity.split('/');
        await resolveEntity({
            entityType,
            entityId,
            rawName: entity,
            aliases: [entity],
            source: 'consistency_test',
            confidence: 100,
            createIfMissing: true,
        });

        let uncommittedEntryId = 0;
        let releaseTx!: () => void;
        const txBlocked = new Promise<void>((resolve) => {
            releaseTx = resolve;
        });
        let inserted!: () => void;
        const insertedSignal = new Promise<void>((resolve) => {
            inserted = resolve;
        });

        const txPromise = getDb().$transaction(async (tx) => {
            const entry = await createEntry({
                entityType,
                entityId,
                key: 'phase',
                valueRaw: { name: 'uncommitted' },
                valueSummary: 'Phase is uncommitted.',
                confidence: 77,
                source: 'observe_tx',
                createdBy: 'agent_tx',
                validUntil: null,
            }, tx);
            uncommittedEntryId = entry.id;
            inserted();
            await txBlocked;
        });

        await insertedSignal;
        await sleep(100);

        const beforeCommit = await iranti.observe({
            agent: 'observer_agent',
            currentContext: '',
            entityHints: [entity],
            maxFacts: 5,
        });

        expect(
            beforeCommit.facts.every((fact) => fact.entityKey !== `${entity}/phase`),
            'Expected observe() to hide the uncommitted fact while the transaction is open.'
        );

        releaseTx();
        await txPromise;

        const afterCommit = await iranti.observe({
            agent: 'observer_agent',
            currentContext: '',
            entityHints: [entity],
            maxFacts: 5,
        });

        expect(
            afterCommit.facts.some((fact) => fact.entityKey === `${entity}/phase`),
            'Expected observe() to surface the fact after commit.'
        );
        expect(uncommittedEntryId > 0, 'Expected test transaction to create an entry.');
    }));

    printSummary(results);
    process.exit(results.every((result) => result.passed) ? 0 : 1);
}

function printSummary(results: CaseResult[]): void {
    console.log('Consistency test suite');
    console.log('----------------------');
    for (const result of results) {
        if (result.passed) {
            console.log(`PASS  ${result.name}`);
        } else {
            console.log(`FAIL  ${result.name} - ${result.details}`);
        }
    }
    console.log('----------------------');
    console.log(`Total: ${results.filter((result) => result.passed).length}/${results.length}`);
}

main().catch((error) => {
    console.error('Consistency tests failed:', error);
    process.exit(1);
});
