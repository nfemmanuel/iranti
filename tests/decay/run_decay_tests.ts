import 'dotenv/config';
import { runArchivist } from '../../src/archivist';
import { ArchivedReason } from '../../src/generated/prisma/client';
import { calculateDecayedConfidence } from '../../src/lib/decay';
import { getDb } from '../../src/library/client';
import { prepareDecaySuite, expect, uniqueEntity, getKnowledgeEntry, ageEntry } from './common';

type CaseResult = {
    name: string;
    passed: boolean;
    details?: string;
};

async function main() {
    const iranti = await prepareDecaySuite();
    const cases: Array<() => Promise<CaseResult>> = [
        async () => runCase('Formula', async () => {
            const decayed = calculateDecayedConfidence(100, 30, 30);
            expect(decayed === 37, `Expected 37 after 30 days at stability 30, got ${decayed}`);
        }),
        async () => runCase('Confidence decreases over time', async () => {
            const entity = uniqueEntity('decay_drop');
            await iranti.write({
                entity,
                key: 'status',
                value: { phase: 'active' },
                summary: 'Project is active.',
                confidence: 80,
                source: 'decay_source',
                agent: 'decay_runner',
            });

            const entry = await getKnowledgeEntry(entity, 'status');
            expect(entry, 'Expected newly written fact to exist.');
            await ageEntry(entry.id, 30, 30);

            await runArchivist();

            const updated = await getKnowledgeEntry(entity, 'status');
            expect(updated, 'Expected decayed fact to remain active.');
            expect(updated.confidence < 80, `Expected confidence to decrease from 80, got ${updated.confidence}`);
        }),
        async () => runCase('Accessed facts decay slower', async () => {
            const touchedEntity = uniqueEntity('decay_sticky');
            const coldEntity = uniqueEntity('decay_cold');

            await iranti.write({
                entity: touchedEntity,
                key: 'owner',
                value: { name: 'Valdris Ohen' },
                summary: 'Owner is Valdris Ohen.',
                confidence: 80,
                source: 'sticky_source',
                agent: 'decay_runner',
            });
            await iranti.write({
                entity: coldEntity,
                key: 'owner',
                value: { name: 'Cora Leth' },
                summary: 'Owner is Cora Leth.',
                confidence: 80,
                source: 'cold_source',
                agent: 'decay_runner',
            });

            await iranti.query(touchedEntity, 'owner');
            await iranti.query(touchedEntity, 'owner');
            await iranti.query(touchedEntity, 'owner');

            const touched = await getKnowledgeEntry(touchedEntity, 'owner');
            const cold = await getKnowledgeEntry(coldEntity, 'owner');
            expect(touched && cold, 'Expected both facts to exist before decay.');
            expect(touched.stability > cold.stability, 'Expected accessed fact stability to increase.');

            await ageEntry(touched.id, 30, touched.stability);
            await ageEntry(cold.id, 30, cold.stability);

            await runArchivist();

            const touchedAfter = await getKnowledgeEntry(touchedEntity, 'owner');
            const coldAfter = await getKnowledgeEntry(coldEntity, 'owner');
            expect(touchedAfter && coldAfter, 'Expected both facts to remain active after decay.');
            expect(
                touchedAfter.confidence > coldAfter.confidence,
                `Expected accessed fact confidence (${touchedAfter.confidence}) to exceed cold fact confidence (${coldAfter.confidence}).`
            );
        }),
        async () => runCase('Decay archives facts below threshold', async () => {
            const entity = uniqueEntity('decay_archive');
            await iranti.write({
                entity,
                key: 'priority',
                value: { level: 'low' },
                summary: 'Priority is low.',
                confidence: 80,
                source: 'threshold_source',
                agent: 'decay_runner',
            });

            const entry = await getKnowledgeEntry(entity, 'priority');
            expect(entry, 'Expected threshold test fact to exist.');
            await ageEntry(entry.id, 180, 10);

            await runArchivist();

            const current = await getKnowledgeEntry(entity, 'priority');
            expect(!current, 'Expected fact to be archived after decay threshold crossing.');

            const [entityType, entityId] = entity.split('/');
            const archived = await getDb().archive.findFirst({
                where: {
                    entityType,
                    entityId,
                    key: 'priority',
                    archivedReason: ArchivedReason.expired,
                },
                orderBy: { archivedAt: 'desc' },
            });
            expect(archived, 'Expected archived expired row to exist.');
        }),
    ];

    const results: CaseResult[] = [];
    for (const testCase of cases) {
        results.push(await testCase());
    }

    printSummary(results);
    process.exit(results.every((result) => result.passed) ? 0 : 1);
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

function printSummary(results: CaseResult[]): void {
    console.log('Decay test suite');
    console.log('----------------');
    for (const result of results) {
        if (result.passed) {
            console.log(`PASS  ${result.name}`);
        } else {
            console.log(`FAIL  ${result.name} — ${result.details}`);
        }
    }
    console.log('----------------');
    console.log(`Total: ${results.filter((result) => result.passed).length}/${results.length}`);
}

main().catch((error) => {
    console.error('Decay tests failed:', error);
    process.exit(1);
});
