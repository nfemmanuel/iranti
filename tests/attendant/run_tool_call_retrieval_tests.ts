/**
 * A2: tool-call triggered retrieval tests.
 *
 * When the caller passes `pendingToolCall` to iranti_attend, the attendant:
 *   1. Derives structured entity hints from the tool's target (file path,
 *      glob basename, bash command paths, URL host, WebSearch query).
 *   2. Merges those hints into the effective entity hint set so the downstream
 *      observe() call can surface stored facts for that target.
 *   3. Returns a `toolCallGuidance` block summarising what was derived and how
 *      many stored facts preempted the lookup.
 *
 * This file has two layers:
 *   - Pure unit tests for `derivePendingToolCallEntityHints` (no harness).
 *   - Integration tests that stub AttendantInstance at its DB/LLM boundaries
 *     and verify the full attend() pipeline respects pendingToolCall.
 */

import assert from 'node:assert/strict';

// A2: set IRANTI_MEMORY_ENTITY BEFORE importing the attendant module so
// getProjectMemoryEntity() resolves to a real project entity during the
// stubbed integration tests. Without this, deriveePendingToolCallEntityHints
// would get a null projectEntity and return [] regardless of the tool call.
const PRIOR_MEMORY_ENTITY = process.env.IRANTI_MEMORY_ENTITY;
process.env.IRANTI_MEMORY_ENTITY = 'project/iranti';

import {
    AttendantInstance,
    derivePendingToolCallEntityHints,
    type AttendInput,
    type ObserveResult,
    type FactInjection,
} from '../../src/attendant/AttendantInstance';
import { bootstrapHarness } from '../../scripts/harness';

bootstrapHarness({ requireDb: false });

process.on('exit', () => {
    if (PRIOR_MEMORY_ENTITY === undefined) {
        delete process.env.IRANTI_MEMORY_ENTITY;
    } else {
        process.env.IRANTI_MEMORY_ENTITY = PRIOR_MEMORY_ENTITY;
    }
});

type TestFn = () => Promise<void> | void;

const AGENT_ID = 'a2_tool_call_test_agent';
const PROJECT_ENTITY = 'project/iranti';

// ─── Pure unit tests for derivePendingToolCallEntityHints ────────────────────

function testDeriveReturnsEmptyWithoutToolCall(): void {
    assert.deepEqual(derivePendingToolCallEntityHints(undefined, PROJECT_ENTITY), []);
    assert.deepEqual(derivePendingToolCallEntityHints(undefined, null), []);
}

function testDeriveReturnsEmptyWithoutProjectEntity(): void {
    assert.deepEqual(
        derivePendingToolCallEntityHints({ name: 'Read', args: { file_path: 'src/foo.ts' } }, null),
        [],
    );
}

function testReadDerivesFileEntity(): void {
    const hints = derivePendingToolCallEntityHints(
        { name: 'Read', args: { file_path: 'src/api/server.ts' } },
        PROJECT_ENTITY,
    );
    assert.deepEqual(hints, ['project/iranti/file/server']);
}

function testReadWithWindowsPath(): void {
    const hints = derivePendingToolCallEntityHints(
        { name: 'Read', args: { file_path: 'C:\\Users\\NF\\Documents\\Projects\\iranti\\src\\attendant\\AttendantInstance.ts' } },
        PROJECT_ENTITY,
    );
    assert.deepEqual(hints, ['project/iranti/file/attendantinstance']);
}

function testReadWithMissingArgsReturnsEmpty(): void {
    assert.deepEqual(
        derivePendingToolCallEntityHints({ name: 'Read', args: {} }, PROJECT_ENTITY),
        [],
    );
    assert.deepEqual(
        derivePendingToolCallEntityHints({ name: 'Read' }, PROJECT_ENTITY),
        [],
    );
}

function testGrepWithLiteralPathDerivesFileEntity(): void {
    const hints = derivePendingToolCallEntityHints(
        { name: 'Grep', args: { pattern: 'TODO', path: 'src/attendant/AttendantInstance.ts' } },
        PROJECT_ENTITY,
    );
    assert.deepEqual(hints, ['project/iranti/file/attendantinstance']);
}

function testGrepWithGlobPatternDerivesBasename(): void {
    const hints = derivePendingToolCallEntityHints(
        { name: 'Grep', args: { pattern: 'x', glob: 'tests/attendant/run_mid_turn_attend_tests.ts' } },
        PROJECT_ENTITY,
    );
    assert.deepEqual(hints, ['project/iranti/file/run_mid_turn_attend_tests']);
}

function testGrepWithWildcardGlobReturnsEmpty(): void {
    // A pattern like "src/**/*.ts" has no literal basename → no hint.
    const hints = derivePendingToolCallEntityHints(
        { name: 'Grep', args: { pattern: 'x', glob: 'src/**/*.ts' } },
        PROJECT_ENTITY,
    );
    assert.deepEqual(hints, []);
}

function testGlobWithLiteralBasenameDerivesEntity(): void {
    const hints = derivePendingToolCallEntityHints(
        { name: 'Glob', args: { pattern: 'src/api/server.ts' } },
        PROJECT_ENTITY,
    );
    assert.deepEqual(hints, ['project/iranti/file/server']);
}

function testGlobWithWildcardOnlyReturnsEmpty(): void {
    const hints = derivePendingToolCallEntityHints(
        { name: 'Glob', args: { pattern: '**/*.ts' } },
        PROJECT_ENTITY,
    );
    assert.deepEqual(hints, []);
}

function testBashScansCommandForPaths(): void {
    const hints = derivePendingToolCallEntityHints(
        { name: 'Bash', args: { command: 'node scripts/iranti-mcp.ts --help' } },
        PROJECT_ENTITY,
    );
    assert.ok(
        hints.includes('project/iranti/file/iranti_mcp'),
        `expected iranti_mcp hint, got: ${JSON.stringify(hints)}`,
    );
}

function testBashWithMultiplePathsDedups(): void {
    const hints = derivePendingToolCallEntityHints(
        { name: 'Bash', args: { command: 'cat src/api/server.ts && cat src/api/server.ts' } },
        PROJECT_ENTITY,
    );
    assert.equal(hints.length, 1);
    assert.equal(hints[0], 'project/iranti/file/server');
}

function testBashWithoutPathsReturnsEmpty(): void {
    const hints = derivePendingToolCallEntityHints(
        { name: 'Bash', args: { command: 'git status' } },
        PROJECT_ENTITY,
    );
    assert.deepEqual(hints, []);
}

function testWebSearchDerivesNormalizedQueryEntity(): void {
    const hints = derivePendingToolCallEntityHints(
        { name: 'WebSearch', args: { query: 'Vercel Fluid Compute pricing 2026' } },
        PROJECT_ENTITY,
    );
    assert.equal(hints.length, 1);
    assert.ok(
        hints[0].startsWith('web/search_'),
        `expected web/search_ prefix, got: ${hints[0]}`,
    );
    assert.ok(hints[0].includes('vercel'));
    assert.ok(hints[0].includes('fluid'));
}

function testWebFetchDerivesHostAndPathEntities(): void {
    const hints = derivePendingToolCallEntityHints(
        { name: 'WebFetch', args: { url: 'https://vercel.com/docs/fluid-compute' } },
        PROJECT_ENTITY,
    );
    assert.ok(hints.includes('web/vercel_com'));
    assert.ok(
        hints.some((h) => h.startsWith('web/vercel_com_') && h.includes('fluid')),
        `expected path-level hint with fluid, got: ${JSON.stringify(hints)}`,
    );
}

function testWebFetchWithNonUrlFallsBack(): void {
    const hints = derivePendingToolCallEntityHints(
        { name: 'WebFetch', args: { url: 'not a url at all' } },
        PROJECT_ENTITY,
    );
    assert.equal(hints.length, 1);
    assert.ok(hints[0].startsWith('web/'));
}

// ─── Stubbed integration tests ───────────────────────────────────────────────

interface StubbedAttendant extends AttendantInstance {
    observeCallCount: number;
    observeCallLog: Array<{
        maxFacts: number | undefined;
        entityHints: string[];
    }>;
    nextObserveFacts: FactInjection[];
}

function makeStubFacts(entityKeys: string[]): FactInjection[] {
    return entityKeys.map((key, i) => ({
        knowledgeEntryId: 2000 + i,
        entityKey: key,
        summary: `stub fact summary for ${key}`,
        value: { data: key },
        confidence: 90,
        source: 'test_stub',
        lastUpdated: new Date().toISOString(),
    }));
}

function makeObserveResult(facts: FactInjection[]): ObserveResult {
    return {
        facts,
        entitiesDetected: [PROJECT_ENTITY],
        alreadyPresent: 0,
        totalFound: facts.length,
        usageGuidance: { tool: 'observe', reminder: '', note: '' },
        entitiesResolved: [],
        debug: {
            contextLength: 0,
            detectionWindowChars: 0,
            detectedCandidates: 0,
            keptCandidates: 0,
            hintsProvided: 1,
            hintsResolved: 1,
            dropped: [],
        },
    };
}

async function makeAttendant(): Promise<StubbedAttendant> {
    const attendant = new AttendantInstance(AGENT_ID) as unknown as StubbedAttendant;
    const anyAttendant = attendant as any;

    attendant.observeCallCount = 0;
    attendant.observeCallLog = [];
    attendant.nextObserveFacts = [];

    anyAttendant.loadPersistedState = async () => null;
    anyAttendant.loadOperatingRules = async () => 'test operating rules';
    anyAttendant.inferTask = async () => 'A2 tool-call retrieval testing';
    anyAttendant.buildWorkingMemory = async () => [];
    anyAttendant.loadSessionLedgerSignals = async () => ({ learnings: [], profile: null });
    anyAttendant.loadProjectPolicies = async () => [];
    anyAttendant.persistState = async () => {};
    anyAttendant.detectRelevantFreshState = async () => ({
        hasFreshState: false,
        priorityKeys: [],
        entities: [],
    });
    anyAttendant.updateWatchedEntities = () => false;
    anyAttendant.markSharedStateObserved = () => {};
    anyAttendant.decideMemoryNeed = async () => ({
        needed: true,
        confidence: 1,
        method: 'forced',
        explanation: 'test_forced_need',
    });
    anyAttendant.loadMatchingUserRules = async () => [];

    anyAttendant.observe = async (input: { maxFacts?: number; entityHints?: string[] }) => {
        attendant.observeCallCount++;
        attendant.observeCallLog.push({
            maxFacts: input.maxFacts,
            entityHints: input.entityHints ?? [],
        });
        return makeObserveResult([...attendant.nextObserveFacts]);
    };

    await anyAttendant.handshake({
        task: 'A2 tool-call retrieval testing',
        recentMessages: ['starting A2 tests'],
    });

    return attendant;
}

function makeAttendInput(overrides: Partial<AttendInput> = {}): AttendInput {
    return {
        latestMessage: 'test message',
        currentContext: 'test context',
        entityHints: [PROJECT_ENTITY],
        suppressEvents: true,
        phase: 'pre-response',
        ...overrides,
    };
}

async function testPendingReadForwardsFileEntityHint(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextObserveFacts = makeStubFacts(['project/iranti/file/server/last_edit']);

    const result = await attendant.attend(makeAttendInput({
        pendingToolCall: { name: 'Read', args: { file_path: 'src/api/server.ts' } },
    }));

    const lastCall = attendant.observeCallLog[attendant.observeCallLog.length - 1];
    assert.ok(
        lastCall.entityHints.includes('project/iranti/file/server'),
        `expected observe() to see project/iranti/file/server hint, got: ${JSON.stringify(lastCall.entityHints)}`,
    );
    assert.ok(result.toolCallGuidance, 'toolCallGuidance should be present');
    assert.equal(result.toolCallGuidance!.toolName, 'Read');
    assert.deepEqual(result.toolCallGuidance!.derivedEntities, ['project/iranti/file/server']);
    assert.equal(result.toolCallGuidance!.factCount, 1);
    assert.ok(result.toolCallGuidance!.note.includes('surfaced'));
}

async function testPendingReadWithNoFactsStillEmitsGuidance(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextObserveFacts = [];

    const result = await attendant.attend(makeAttendInput({
        pendingToolCall: { name: 'Read', args: { file_path: 'src/unknown.ts' } },
    }));

    assert.ok(result.toolCallGuidance);
    assert.equal(result.toolCallGuidance!.factCount, 0);
    assert.deepEqual(result.toolCallGuidance!.derivedEntities, ['project/iranti/file/unknown']);
    assert.ok(
        result.toolCallGuidance!.note.includes('No stored facts matched'),
        `expected 'No stored facts matched' note, got: ${result.toolCallGuidance!.note}`,
    );
}

async function testPendingBashForwardsPathEntityHint(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextObserveFacts = [];

    await attendant.attend(makeAttendInput({
        pendingToolCall: {
            name: 'Bash',
            args: { command: 'node scripts/iranti-mcp.ts --help' },
        },
    }));

    const lastCall = attendant.observeCallLog[attendant.observeCallLog.length - 1];
    assert.ok(
        lastCall.entityHints.some((h) => h.includes('iranti_mcp')),
        `expected iranti_mcp hint to be forwarded to observe, got: ${JSON.stringify(lastCall.entityHints)}`,
    );
}

async function testPendingWebFetchForwardsWebEntityHint(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextObserveFacts = [];

    const result = await attendant.attend(makeAttendInput({
        pendingToolCall: {
            name: 'WebFetch',
            args: { url: 'https://vercel.com/docs/fluid-compute' },
        },
    }));

    const lastCall = attendant.observeCallLog[attendant.observeCallLog.length - 1];
    assert.ok(
        lastCall.entityHints.some((h) => h.startsWith('web/vercel_com')),
        `expected web/vercel_com hint in observe call, got: ${JSON.stringify(lastCall.entityHints)}`,
    );
    assert.equal(result.toolCallGuidance!.toolName, 'WebFetch');
    assert.ok(result.toolCallGuidance!.derivedEntities.some((e) => e.startsWith('web/vercel_com')));
}

async function testAttendWithoutPendingToolCallLeavesGuidanceUndefined(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextObserveFacts = makeStubFacts(['project/iranti/file/server/last_edit']);

    const result = await attendant.attend(makeAttendInput());

    assert.equal(
        result.toolCallGuidance,
        undefined,
        'toolCallGuidance should be undefined when pendingToolCall not supplied',
    );
}

async function testPendingToolCallMergesWithExplicitEntityHints(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextObserveFacts = [];

    await attendant.attend(makeAttendInput({
        entityHints: ['project/iranti/custom_scope'],
        pendingToolCall: { name: 'Read', args: { file_path: 'src/lib/router.ts' } },
    }));

    const lastCall = attendant.observeCallLog[attendant.observeCallLog.length - 1];
    assert.ok(
        lastCall.entityHints.includes('project/iranti/custom_scope'),
        `explicit entity hint should survive merge, got: ${JSON.stringify(lastCall.entityHints)}`,
    );
    assert.ok(
        lastCall.entityHints.includes('project/iranti/file/router'),
        `tool-call-derived hint should be merged in, got: ${JSON.stringify(lastCall.entityHints)}`,
    );
}

async function testPendingGlobWithWildcardOnlyDoesNotOverrideBaseHints(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextObserveFacts = [];

    const result = await attendant.attend(makeAttendInput({
        pendingToolCall: { name: 'Glob', args: { pattern: '**/*.ts' } },
    }));

    assert.ok(result.toolCallGuidance);
    assert.equal(result.toolCallGuidance!.toolName, 'Glob');
    assert.deepEqual(result.toolCallGuidance!.derivedEntities, []);
    assert.ok(
        result.toolCallGuidance!.note.includes('No entity hints derived'),
        `expected "No entity hints derived" note, got: ${result.toolCallGuidance!.note}`,
    );
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function runTest(name: string, fn: TestFn): Promise<void> {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (error) {
        console.error(`  FAIL  ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

async function main(): Promise<void> {
    console.log('running A2 tool-call retrieval tests');

    // Pure unit tests
    await runTest('derive returns empty without tool call', testDeriveReturnsEmptyWithoutToolCall);
    await runTest('derive returns empty without project entity', testDeriveReturnsEmptyWithoutProjectEntity);
    await runTest('Read derives file entity', testReadDerivesFileEntity);
    await runTest('Read handles Windows absolute path', testReadWithWindowsPath);
    await runTest('Read with missing args returns empty', testReadWithMissingArgsReturnsEmpty);
    await runTest('Grep with literal path derives file entity', testGrepWithLiteralPathDerivesFileEntity);
    await runTest('Grep with glob pattern derives basename', testGrepWithGlobPatternDerivesBasename);
    await runTest('Grep with wildcard glob returns empty', testGrepWithWildcardGlobReturnsEmpty);
    await runTest('Glob with literal basename derives entity', testGlobWithLiteralBasenameDerivesEntity);
    await runTest('Glob with wildcard only returns empty', testGlobWithWildcardOnlyReturnsEmpty);
    await runTest('Bash scans command for paths', testBashScansCommandForPaths);
    await runTest('Bash with multiple path mentions dedups', testBashWithMultiplePathsDedups);
    await runTest('Bash without paths returns empty', testBashWithoutPathsReturnsEmpty);
    await runTest('WebSearch derives normalized query entity', testWebSearchDerivesNormalizedQueryEntity);
    await runTest('WebFetch derives host and path entities', testWebFetchDerivesHostAndPathEntities);
    await runTest('WebFetch with non-URL falls back to token', testWebFetchWithNonUrlFallsBack);

    // Stubbed integration tests
    await runTest('pending Read forwards file entity hint to observe', testPendingReadForwardsFileEntityHint);
    await runTest('pending Read with no facts still emits guidance', testPendingReadWithNoFactsStillEmitsGuidance);
    await runTest('pending Bash forwards path entity hint to observe', testPendingBashForwardsPathEntityHint);
    await runTest('pending WebFetch forwards web entity hint to observe', testPendingWebFetchForwardsWebEntityHint);
    await runTest('attend without pendingToolCall leaves guidance undefined', testAttendWithoutPendingToolCallLeavesGuidanceUndefined);
    await runTest('pendingToolCall merges with explicit entity hints', testPendingToolCallMergesWithExplicitEntityHints);
    await runTest('Glob with wildcard-only pattern emits no-derived guidance', testPendingGlobWithWildcardOnlyDoesNotOverrideBaseHints);

    if (process.exitCode === 1) {
        console.error('A2 tool-call retrieval tests failed');
        process.exit(1);
    }
    console.log('A2 tool-call retrieval tests passed');
}

main().catch((error) => {
    console.error('A2 tool-call retrieval tests crashed:', error);
    process.exit(1);
});
