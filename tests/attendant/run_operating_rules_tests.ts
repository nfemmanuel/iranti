import assert from 'assert';
import { DEFAULT_ATTENDANT_OPERATING_RULES, formatOperatingRulesText } from '../../src/attendant/AttendantInstance';

function main(): void {
    const formatted = formatOperatingRulesText(
        {
            rules: [
                'Serve one external agent only; optimize for that agent keeping task context coherent across turns and sessions.',
                'Use exact query when the entity and key are known. Use search or attend when the fact must be discovered from shared memory.',
            ],
        },
        'Attendant manages per-agent working memory and instructs agents when to read and write durable memory.'
    );

    assert.ok(
        formatted.includes('Attendant manages per-agent working memory and instructs agents when to read and write durable memory.'),
        'Expected the summary heading to be preserved.'
    );
    assert.ok(
        formatted.includes('- Use exact query when the entity and key are known. Use search or attend when the fact must be discovered from shared memory.'),
        'Expected stored rules to be included in the formatted operating rules.'
    );
    assert.ok(
        formatted.includes('- Persist durable knowledge when it is learned or confirmed: decisions, blockers, next steps, owners, stable preferences, project constraints, important file purposes, and validated environment details.'),
        'Expected stronger fallback rules to be merged for older installs with thin Staff rules.'
    );

    const fallbackOnly = formatOperatingRulesText(null, 'Attendant operating rules:');
    assert.ok(
        fallbackOnly.includes(DEFAULT_ATTENDANT_OPERATING_RULES[0] ?? ''),
        'Expected fallback formatting to include the default attendant operating rules.'
    );

    console.log('attendant operating rules formatting passed');
}

main();
