import assert from 'assert';
import { extractFilePathEntityHints } from '../../src/attendant/AttendantInstance';

function main(): void {
    // ─── extractFilePathEntityHints ─────────────────────────────────────────

    // Unix-style relative path
    assert.deepStrictEqual(
        extractFilePathEntityHints('editing src/api/server.ts now', 'project/iranti'),
        ['project/iranti/file/server'],
        'Expected Unix-style relative path to produce file entity hint.',
    );

    // Dotted relative path
    assert.deepStrictEqual(
        extractFilePathEntityHints('reading ./config/settings.json', 'project/iranti'),
        ['project/iranti/file/settings'],
        'Expected dotted relative path to produce file entity hint.',
    );

    // Multiple file paths in same text
    const multi = extractFilePathEntityHints(
        'modified src/api/server.ts and tests/attendant/run_tests.ts',
        'project/iranti',
    );
    assert.ok(multi.includes('project/iranti/file/server'), 'Expected server hint.');
    assert.ok(multi.includes('project/iranti/file/run_tests'), 'Expected run_tests hint.');
    assert.strictEqual(multi.length, 2, 'Expected exactly 2 file hints.');

    // Deduplicates same file mentioned twice
    const dedup = extractFilePathEntityHints(
        'reading src/api/server.ts and then src/api/server.ts again',
        'project/iranti',
    );
    assert.strictEqual(dedup.length, 1, 'Expected deduplication of same file path.');

    // No file paths returns empty
    assert.deepStrictEqual(
        extractFilePathEntityHints('just a normal message with no paths', 'project/iranti'),
        [],
        'Expected empty array when no file paths are present.',
    );

    // Null project entity returns empty
    assert.deepStrictEqual(
        extractFilePathEntityHints('src/api/server.ts', null),
        [],
        'Expected empty array when project entity is null.',
    );

    // Path in backticks
    const backtick = extractFilePathEntityHints(
        'check the file `src/lib/metrics.ts` for details',
        'project/iranti',
    );
    assert.ok(
        backtick.some((h) => h.includes('metrics')),
        `Expected backtick-wrapped path to be detected. Got: ${JSON.stringify(backtick)}`,
    );

    // Path in quotes
    const quoted = extractFilePathEntityHints(
        'the file "src/lib/router.ts" handles routing',
        'project/iranti',
    );
    assert.ok(
        quoted.some((h) => h.includes('router')),
        `Expected quoted path to be detected. Got: ${JSON.stringify(quoted)}`,
    );

    // Nested directory path
    const nested = extractFilePathEntityHints(
        'updated clients/typescript/src/index.ts',
        'project/iranti',
    );
    assert.ok(
        nested.some((h) => h.includes('index')),
        `Expected nested path to be detected. Got: ${JSON.stringify(nested)}`,
    );

    // Extension is stripped from entity hint
    const ext = extractFilePathEntityHints('editing src/types.ts here', 'project/iranti');
    assert.ok(
        ext.some((h) => h === 'project/iranti/file/types'),
        `Expected extension to be stripped. Got: ${JSON.stringify(ext)}`,
    );

    console.log('file change recall tests passed');
}

main();
