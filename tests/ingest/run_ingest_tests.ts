import 'dotenv/config';
import { getDb } from '../../src/library/client';
import { prepareIngestSuite, uniqueEntity, getKnowledgeEntry, expect } from './common';

type CaseResult = {
    name: string;
    passed: boolean;
    details?: string;
};

async function main() {
    const iranti = await prepareIngestSuite();
    const cases: Array<() => Promise<CaseResult>> = [
        async () => runCase('Happy path writes retrievable facts', async () => {
            const entity = uniqueEntity('ingest_happy');
            const result = await iranti.ingest({
                entity,
                content: 'Avalon Spectrum currently operates in Lisbon. Avalon Spectrum has 42 employees. Avalon Spectrum has 18 months of runway.',
                source: 'briefing_note',
                confidence: 82,
                agent: 'ingest_runner',
            });

            expect(result.extractedCandidates === 3, `Expected 3 extracted candidates, got ${result.extractedCandidates}`);
            expect(result.written === 3, `Expected 3 written facts, got ${result.written}`);
            expect(result.skippedMalformed === 0, `Expected no malformed facts, got ${result.skippedMalformed}`);

            const city = await iranti.query(entity, 'hq_city');
            const team = await iranti.query(entity, 'team_size');
            const runway = await iranti.query(entity, 'runway_months');

            expect(city.found && team.found && runway.found, 'Expected all three ingested facts to be retrievable.');

            const stored = await getKnowledgeEntry(entity, 'hq_city');
            expect(stored, 'Expected stored entry for hq_city.');
            const ingestMeta = (stored.properties as Record<string, unknown> | null)?.ingest as Record<string, unknown> | undefined;
            expect(ingestMeta, 'Expected ingest provenance metadata on stored fact.');
            expect(ingestMeta?.method === 'llm_extraction', 'Expected ingest method metadata.');
            expect(typeof ingestMeta?.model === 'string', 'Expected ingest model metadata.');
        }),
        async () => runCase('Direct statements score higher than implied facts', async () => {
            const entity = uniqueEntity('ingest_confidence');
            const result = await iranti.ingest({
                entity,
                content: 'Helios Array has 12 pilots and could be expanding into ocean freight next year.',
                source: 'ops_notice',
                confidence: 80,
                agent: 'ingest_runner',
            });

            expect(result.written === 2, `Expected 2 written facts, got ${result.written}`);

            const pilotCount = await getKnowledgeEntry(entity, 'pilot_count');
            const expansion = await getKnowledgeEntry(entity, 'expansion_target');

            expect(pilotCount && expansion, 'Expected both mixed-confidence facts to be stored.');
            expect(
                pilotCount.confidence > expansion.confidence,
                `Expected direct fact confidence (${pilotCount.confidence}) to exceed implied fact confidence (${expansion.confidence}).`
            );
        }),
        async () => runCase('No usable facts returns zero writes cleanly', async () => {
            const entity = uniqueEntity('ingest_empty');
            const result = await iranti.ingest({
                entity,
                content: 'The rain over the harbor looked dramatic, but no durable facts were stated.',
                source: 'observer_note',
                confidence: 70,
                agent: 'ingest_runner',
            });

            expect(result.written === 0, `Expected zero writes, got ${result.written}`);
            expect(result.extractedCandidates === 0, `Expected zero extracted candidates, got ${result.extractedCandidates}`);
            expect(result.reason === 'No facts extracted', `Expected no-facts reason, got ${result.reason}`);

            const [entityType, entityId] = entity.split('/');
            const storedRows = await getDb().knowledgeEntry.findMany({
                where: { entityType, entityId },
            });
            expect(storedRows.length === 0, `Expected no stored rows, found ${storedRows.length}`);
        }),
        async () => runCase('Conflicts still route through Librarian handling', async () => {
            const entity = uniqueEntity('ingest_conflict');

            await iranti.write({
                entity,
                key: 'budget',
                value: { amount: 50000, currency: 'USD' },
                summary: 'Budget is 50,000 USD.',
                confidence: 92,
                source: 'finance_memo',
                agent: 'writer_agent',
            });

            const result = await iranti.ingest({
                entity,
                content: 'Northwind Lattice has a budget of 75000 USD.',
                source: 'project_brief',
                confidence: 30,
                agent: 'ingest_runner',
            });

            expect(result.facts.length === 1, `Expected one conflict fact result, got ${result.facts.length}`);
            expect(
                result.facts[0].action !== 'created',
                `Expected conflict path to avoid silent create, got ${result.facts[0].action}`
            );
            expect(
                ['updated', 'rejected', 'escalated'].includes(result.facts[0].action),
                `Expected conflict handling action, got ${result.facts[0].action}`
            );
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
    console.log('Ingest test suite');
    console.log('-----------------');
    for (const result of results) {
        if (result.passed) {
            console.log(`PASS  ${result.name}`);
        } else {
            console.log(`FAIL  ${result.name} — ${result.details}`);
        }
    }
    console.log('-----------------');
    console.log(`Total: ${results.filter((result) => result.passed).length}/${results.length}`);
}

main().catch((error) => {
    console.error('Ingest tests failed:', error);
    process.exit(1);
});
