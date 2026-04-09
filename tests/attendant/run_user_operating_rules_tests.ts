import assert from 'assert';
import {
    extractRuleTriggers,
    matchesRuleTriggers,
    formatMatchedUserRules,
    type MatchedUserRule,
} from '../../src/attendant/AttendantInstance';

function main(): void {
    // ─── extractRuleTriggers ────────────────────────────────────────────────

    // Returns triggers from properties
    assert.deepStrictEqual(
        extractRuleTriggers({ triggers: ['release', 'publish', 'npm'] }),
        ['release', 'publish', 'npm'],
        'Expected triggers to be extracted from properties.',
    );

    // Trims and lowercases triggers
    assert.deepStrictEqual(
        extractRuleTriggers({ triggers: ['  Release ', 'PUBLISH'] }),
        ['release', 'publish'],
        'Expected triggers to be trimmed and lowercased.',
    );

    // Filters out non-string and empty triggers
    assert.deepStrictEqual(
        extractRuleTriggers({ triggers: ['valid', '', 42, null, 'also_valid'] as any }),
        ['valid', 'also_valid'],
        'Expected non-string and empty triggers to be filtered out.',
    );

    // Returns empty for null/undefined/missing properties
    assert.deepStrictEqual(extractRuleTriggers(null), [], 'Expected empty array for null properties.');
    assert.deepStrictEqual(extractRuleTriggers(undefined), [], 'Expected empty array for undefined properties.');
    assert.deepStrictEqual(extractRuleTriggers({}), [], 'Expected empty array for missing triggers.');

    // ─── matchesRuleTriggers ────────────────────────────────────────────────

    // Single-word trigger matches token
    assert.ok(
        matchesRuleTriggers(['release'], new Set(['release', 'branch', 'build']), 'creating a release branch'),
        'Expected single-word trigger to match token.',
    );

    // Single-word trigger does not match partial token
    assert.ok(
        !matchesRuleTriggers(['lease'], new Set(['release', 'branch']), 'creating a release branch'),
        'Expected single-word trigger NOT to match partial token.',
    );

    // Multi-word trigger matches phrase in context
    assert.ok(
        matchesRuleTriggers(['npm publish'], new Set(['npm', 'publish']), 'running npm publish to deploy'),
        'Expected multi-word trigger to match phrase in context.',
    );

    // Multi-word trigger does not match when words are separated
    assert.ok(
        !matchesRuleTriggers(['npm publish'], new Set(['npm', 'publish']), 'npm install and then publish later'),
        'Expected multi-word trigger NOT to match when words are not adjacent.',
    );

    // Empty triggers never match
    assert.ok(
        !matchesRuleTriggers([], new Set(['release']), 'creating a release'),
        'Expected empty triggers to never match.',
    );

    // Any trigger matching is sufficient
    assert.ok(
        matchesRuleTriggers(['deploy', 'release', 'publish'], new Set(['testing', 'before', 'publish']), 'testing before we publish'),
        'Expected match when any one trigger matches.',
    );

    // ─── formatMatchedUserRules ─────────────────────────────────────────────

    const softRule: MatchedUserRule = {
        entityKey: 'rule/no_npm_publish',
        key: 'definition',
        rule: 'Use GitHub Releases to publish, not npm publish directly.',
        triggers: ['publish', 'release', 'npm'],
        scope: 'project',
        enforcement: 'soft',
        source: 'user_stated',
        lastUpdated: '2026-04-09T10:00:00.000Z',
    };

    const hardRule: MatchedUserRule = {
        entityKey: 'rule/watch_ci',
        key: 'definition',
        rule: 'Always watch CI after pushing code.',
        triggers: ['push', 'ci'],
        scope: 'project',
        enforcement: 'hard',
        source: 'user_stated',
        lastUpdated: '2026-04-09T10:00:00.000Z',
    };

    // Soft rule uses USER RULE prefix
    const softFormatted = formatMatchedUserRules([softRule]);
    assert.ok(
        softFormatted.includes('USER RULE (definition)'),
        `Expected soft rule to use USER RULE prefix. Got: ${softFormatted}`,
    );
    assert.ok(
        softFormatted.includes('Use GitHub Releases'),
        'Expected soft rule text to be included.',
    );

    // Hard rule uses REQUIRED RULE prefix
    const hardFormatted = formatMatchedUserRules([hardRule]);
    assert.ok(
        hardFormatted.includes('REQUIRED RULE (definition)'),
        `Expected hard rule to use REQUIRED RULE prefix. Got: ${hardFormatted}`,
    );

    // Empty rules return empty string
    assert.strictEqual(
        formatMatchedUserRules([]),
        '',
        'Expected empty string for no matched rules.',
    );

    // Multiple rules are formatted together
    const bothFormatted = formatMatchedUserRules([softRule, hardRule]);
    assert.ok(
        bothFormatted.includes('USER RULE') && bothFormatted.includes('REQUIRED RULE'),
        'Expected both rule types to be formatted.',
    );

    console.log('user operating rules tests passed');
}

main();
