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
    assert.ok(
        formatted.includes('- Treat Iranti as the default shared working-memory layer. Keep using your own private notes if you want, but prefer Iranti for anything another session, another agent, or a later handoff may need.'),
        'Expected handshake rules to push agents toward using Iranti as the shared working-memory layer.'
    );
    assert.ok(
        formatted.includes('- When a file is created, renamed, moved, deleted, or substantially repurposed, capture that change and what the file is for whenever the state will matter to another agent or a later session.'),
        'Expected file-state changes to be part of the durable-memory discipline.'
    );
    assert.ok(
        formatted.includes('- When a task reaches a useful checkpoint, store the current step, next step, open risks, and any important artifacts or paths so another agent can resume without reconstructing context from scratch.'),
        'Expected checkpoint-style handoff guidance to be included in the operating rules.'
    );

    const fallbackOnly = formatOperatingRulesText(null, 'Attendant operating rules:');
    assert.ok(
        fallbackOnly.includes(DEFAULT_ATTENDANT_OPERATING_RULES[0] ?? ''),
        'Expected fallback formatting to include the default attendant operating rules.'
    );

    console.log('attendant operating rules formatting passed');
}

main();
