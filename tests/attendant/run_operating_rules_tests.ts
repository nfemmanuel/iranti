import assert from 'assert';
import { DEFAULT_ATTENDANT_OPERATING_RULES, formatOperatingRulesText } from '../../src/attendant/AttendantInstance';

function main(): void {
    // When stored rules exist, they replace defaults — no merge.
    // The full protocol lives in IRANTI.md; stored rules are the compressed authoritative version.
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
    // Stored rules should NOT be merged with defaults — defaults are only a fallback.
    assert.ok(
        !formatted.includes('Persist durable knowledge when it is learned or confirmed'),
        'Expected defaults NOT to be merged when stored rules are present (protocol lives in IRANTI.md).'
    );
    assert.ok(
        !formatted.includes('CHECKPOINT PROTOCOL'),
        'Expected verbose default checkpoint rule NOT to be merged when stored rules are present.'
    );

    // When no stored rules exist, defaults are used as the fallback.
    const fallbackOnly = formatOperatingRulesText(null, 'Attendant operating rules:');
    assert.ok(
        fallbackOnly.includes(DEFAULT_ATTENDANT_OPERATING_RULES[0] ?? ''),
        'Expected fallback formatting to include the default attendant operating rules when no stored rules exist.'
    );

    // Empty rules array should also trigger fallback.
    const emptyRules = formatOperatingRulesText({ rules: [] }, 'Empty stored rules:');
    assert.ok(
        emptyRules.includes(DEFAULT_ATTENDANT_OPERATING_RULES[0] ?? ''),
        'Expected fallback formatting when stored rules array is empty.'
    );

    console.log('attendant operating rules formatting passed');
}

main();
