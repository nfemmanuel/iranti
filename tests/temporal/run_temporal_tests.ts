import 'dotenv/config';
import { prepareTemporalTests, expect, makeTemporalEntity } from './common';

async function main() {
    const { iranti, databaseUrl } = await prepareTemporalTests();
    console.log(`Temporal tests using ${databaseUrl}`);
    console.log('------------------------------');

    await testHistoricalAsOf(iranti);
    await testHistoryOrdering(iranti);
    await testEscalationVisibility(iranti);

    console.log('------------------------------');
    console.log('Temporal tests passed');
    process.exit(0);
}

async function testHistoricalAsOf(iranti: Awaited<ReturnType<typeof prepareTemporalTests>>['iranti']) {
    const entity = makeTemporalEntity('temporal_asof');

    await iranti.write({
        entity,
        key: 'status',
        value: { state: 'planning' },
        summary: 'Status is planning.',
        confidence: 82,
        source: 'timeline_brief',
        agent: 'temporal_tester',
        validFrom: new Date('2026-01-01T00:00:00Z'),
    });

    await iranti.write({
        entity,
        key: 'status',
        value: { state: 'launched' },
        summary: 'Status is launched.',
        confidence: 82,
        source: 'timeline_brief',
        agent: 'temporal_tester',
        validFrom: new Date('2026-03-01T00:00:00Z'),
    });

    const feb = await iranti.query(entity, 'status', { asOf: new Date('2026-02-15T00:00:00Z') });
    const apr = await iranti.query(entity, 'status', { asOf: new Date('2026-04-01T00:00:00Z') });

    expect(feb.found, 'Expected historical asOf query to find February status.');
    expect((feb.value as any)?.state === 'planning', `Expected February state planning, got ${JSON.stringify(feb.value)}.`);
    expect(apr.found, 'Expected current asOf query to find April status.');
    expect((apr.value as any)?.state === 'launched', `Expected April state launched, got ${JSON.stringify(apr.value)}.`);

    console.log('PASS historical asOf query');
}

async function testHistoryOrdering(iranti: Awaited<ReturnType<typeof prepareTemporalTests>>['iranti']) {
    const entity = makeTemporalEntity('temporal_history');

    await iranti.write({
        entity,
        key: 'budget',
        value: { amount: 50000 },
        summary: 'Budget is 50K.',
        confidence: 75,
        source: 'briefing_note',
        agent: 'temporal_tester',
        validFrom: new Date('2026-01-01T00:00:00Z'),
    });

    await iranti.write({
        entity,
        key: 'budget',
        value: { amount: 75000 },
        summary: 'Budget is 75K.',
        confidence: 90,
        source: 'OpenAlex',
        agent: 'temporal_tester',
        validFrom: new Date('2026-02-01T00:00:00Z'),
    });

    const history = await iranti.history(entity, 'budget');

    expect(history.length === 2, `Expected 2 history entries, got ${history.length}.`);
    expect((history[0].value as any)?.amount === 50000, `Expected first history amount 50000, got ${JSON.stringify(history[0]?.value)}.`);
    expect(history[0].validUntil !== null, 'Expected superseded interval to be closed.');
    expect((history[1].value as any)?.amount === 75000, `Expected current history amount 75000, got ${JSON.stringify(history[1]?.value)}.`);
    expect(history[1].isCurrent === true, 'Expected final history row to be current.');

    console.log('PASS ordered history query');
}

async function testEscalationVisibility(iranti: Awaited<ReturnType<typeof prepareTemporalTests>>['iranti']) {
    const entity = makeTemporalEntity('temporal_escalation');

    await iranti.write({
        entity,
        key: 'owner',
        value: { name: 'alpha' },
        summary: 'Owner is alpha.',
        confidence: 80,
        source: 'source_alpha',
        agent: 'temporal_tester',
        validFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const escalated = await iranti.write({
        entity,
        key: 'owner',
        value: { name: 'beta' },
        summary: 'Owner is beta.',
        confidence: 80,
        source: 'source_beta',
        agent: 'temporal_tester',
        validFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const current = await iranti.query(entity, 'owner');
    const asOf = await iranti.query(entity, 'owner', { asOf: new Date() });

    expect(escalated.action === 'escalated', `Expected escalated write, got ${escalated.action}.`);
    expect(current.found === false, 'Expected no current row while escalation is pending.');
    expect(asOf.found, 'Expected temporal asOf query to find contested archive state.');
    expect(asOf.fromArchive === true, 'Expected contested state to come from archive.');
    expect(asOf.contested === true, 'Expected contested temporal read to be marked contested.');

    console.log('PASS contested escalation visibility');
}

main().catch((err) => {
    console.error('Temporal tests failed:', err);
    process.exit(1);
});
