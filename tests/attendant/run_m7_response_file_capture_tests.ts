/**
 * M7: response file-change autowrite tests.
 *
 * When `iranti_attend` is called with `phase='post-response'`, the attendant:
 *   1. Scans the agent's response text for file path mentions using
 *      FILE_PATH_PATTERN.
 *   2. Determines the most likely action (edited / created / read) from the
 *      ±150-char context window around each match via `detectFileAction`.
 *   3. Writes one durable fact per distinct file-scoped entity
 *      (project/{id}/file/{basename}) via `librarianWrite` with
 *      source='attendant_autowrite' and capturePhase='response_file_change_autowrite'.
 *   4. Surfaces the outcome as `responseFileCapture` on the attend result so
 *      hosts can log how many file facts were written without parsing memory events.
 *   5. Resets pressure counters (attendsWithoutPersist, turnsWithoutWrite)
 *      if any facts were written, so the compliance snapshot reflects the write.
 *
 * This file has two layers:
 *   - Pure unit tests for `detectFileAction`.
 *   - Stubbed integration tests that swap out `runResponseFileCapture` on the
 *     instance and verify the attend() wiring.
 */

import assert from 'node:assert/strict';

const PRIOR_MEMORY_ENTITY = process.env.IRANTI_MEMORY_ENTITY;
process.env.IRANTI_MEMORY_ENTITY = 'project/iranti';

import {
    AttendantInstance,
    detectFileAction,
    type AttendInput,
    type ObserveResult,
    type FactInjection,
    type ResponseFileCaptureResult,
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

const AGENT_ID = 'm7_response_file_capture_test_agent';
const PROJECT_ENTITY = 'project/iranti';

// ─── Pure unit tests for detectFileAction ───────────────────────────────────

function testDetectFileActionEdit(): void {
    // Standard edit patterns
    assert.equal(detectFileAction('I edited src/foo.ts to fix the bug'), 'edited');
    assert.equal(detectFileAction('updated the file src/bar.ts with new logic'), 'edited');
    assert.equal(detectFileAction('modified config.ts — removed unused fields'), 'edited');
    assert.equal(detectFileAction('wrote the new implementation to server.ts'), 'edited');
    assert.equal(detectFileAction('rewrote the routing logic in routes.ts'), 'edited');
    assert.equal(detectFileAction('refactored attendantInstance.ts for clarity'), 'edited');
    assert.equal(detectFileAction('changed the schema in schema.prisma'), 'edited');
}

function testDetectFileActionCreate(): void {
    assert.equal(detectFileAction('created a new file src/foo.ts'), 'created');
    assert.equal(detectFileAction('new file added at tests/m7_tests.ts'), 'created');
    assert.equal(detectFileAction('wrote new module at src/staff/responseFileCapture.ts'), 'created');
    assert.equal(detectFileAction('creating the scaffold in src/lib/newHelper.ts'), 'created');
}

function testDetectFileActionReadIsDefault(): void {
    // No clear action signal → read
    assert.equal(detectFileAction('I found the function in src/api/server.ts'), 'read');
    assert.equal(detectFileAction('src/attendant/AttendantInstance.ts contains the logic'), 'read');
    assert.equal(detectFileAction('looked at src/lib/autoRemember.ts'), 'read');
    assert.equal(detectFileAction(''), 'read');
}

function testDetectFileActionCreatedWinsOverEdit(): void {
    // "created" keyword should take precedence when both appear
    assert.equal(detectFileAction('created and modified src/foo.ts'), 'created');
}

function testDetectFileActionCaseInsensitive(): void {
    assert.equal(detectFileAction('EDITED the file src/foo.ts'), 'edited');
    assert.equal(detectFileAction('CREATED src/bar.ts'), 'created');
}

// ─── Stubbed integration tests ───────────────────────────────────────────────

interface StubbedAttendant extends AttendantInstance {
    runResponseFileCaptureCallCount: number;
    lastResponseFileCaptureText: string | null;
    lastResponseFileCaptureBatchId: string | null;
    nextFileCaptureResult: ResponseFileCaptureResult | null;
    observeCallCount: number;
    nextObserveFacts: FactInjection[];
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

function makeFileCaptureResult(overrides: Partial<ResponseFileCaptureResult> = {}): ResponseFileCaptureResult {
    return {
        autowriteBatchId: 'rfca_test_1',
        filesDetected: 2,
        factsWritten: 2,
        entities: [
            'project/iranti/file/attendantInstance_ts',
            'project/iranti/file/autoRemember_ts',
        ],
        skipped: [],
        durationMs: 8,
        ...overrides,
    };
}

async function makeAttendant(): Promise<StubbedAttendant> {
    const attendant = new AttendantInstance(AGENT_ID) as unknown as StubbedAttendant;
    const any = attendant as any;

    attendant.runResponseFileCaptureCallCount = 0;
    attendant.lastResponseFileCaptureText = null;
    attendant.lastResponseFileCaptureBatchId = null;
    attendant.nextFileCaptureResult = null;
    attendant.observeCallCount = 0;
    attendant.nextObserveFacts = [];

    any.loadPersistedState = async () => null;
    any.loadOperatingRules = async () => 'test operating rules';
    any.inferTask = async () => 'M7 response file capture testing';
    any.buildWorkingMemory = async () => [];
    any.loadSessionLedgerSignals = async () => ({ learnings: [], profile: null });
    any.loadProjectPolicies = async () => [];
    any.persistState = async () => {};
    any.detectRelevantFreshState = async () => ({
        hasFreshState: false,
        priorityKeys: [],
        entities: [],
    });
    any.updateWatchedEntities = () => false;
    any.markSharedStateObserved = () => {};
    any.decideMemoryNeed = async () => ({
        needed: true,
        confidence: 1,
        method: 'forced',
        explanation: 'test_forced_need',
    });
    any.loadMatchingUserRules = async () => [];

    any.observe = async () => {
        attendant.observeCallCount++;
        return makeObserveResult([...attendant.nextObserveFacts]);
    };

    // Stub runResponseFileCapture: record calls, return preset result.
    any.runResponseFileCapture = async (
        text: string,
        batchId: string,
    ): Promise<ResponseFileCaptureResult> => {
        attendant.runResponseFileCaptureCallCount++;
        attendant.lastResponseFileCaptureText = text;
        attendant.lastResponseFileCaptureBatchId = batchId;
        return attendant.nextFileCaptureResult ?? makeFileCaptureResult({ factsWritten: 0, entities: [] });
    };

    // Stub maybeBuildWriteNudge to keep pre-/mid-turn paths clean.
    any.maybeBuildWriteNudge = () => null;

    await any.handshake({
        task: 'M7 response file capture testing',
        recentMessages: ['starting M7 tests'],
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

// ─── Wiring: runResponseFileCapture called on post-response ─────────────────

async function testRunResponseFileCaptureCalledOnPostResponse(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextFileCaptureResult = makeFileCaptureResult();

    await attendant.attend(makeAttendInput({
        phase: 'post-response',
        latestMessage: 'I edited src/attendant/AttendantInstance.ts to add the M7 feature.',
    }));

    assert.equal(
        attendant.runResponseFileCaptureCallCount,
        1,
        'runResponseFileCapture should be called exactly once on post-response',
    );
    assert.ok(
        attendant.lastResponseFileCaptureText?.includes('AttendantInstance'),
        'the response text should be forwarded to runResponseFileCapture',
    );
    assert.ok(
        attendant.lastResponseFileCaptureBatchId?.startsWith('rfca_'),
        `batchId should start with rfca_, got: ${attendant.lastResponseFileCaptureBatchId}`,
    );
}

async function testRunResponseFileCaptureNotCalledOnPreResponse(): Promise<void> {
    const attendant = await makeAttendant();

    await attendant.attend(makeAttendInput({
        phase: 'pre-response',
        latestMessage: 'I edited src/attendant/AttendantInstance.ts',
    }));

    assert.equal(
        attendant.runResponseFileCaptureCallCount,
        0,
        'runResponseFileCapture should NOT be called on pre-response',
    );
}

async function testRunResponseFileCaptureNotCalledOnMidTurn(): Promise<void> {
    const attendant = await makeAttendant();

    await attendant.attend(makeAttendInput({
        phase: 'mid-turn',
        latestMessage: 'I edited src/attendant/AttendantInstance.ts',
    }));

    assert.equal(
        attendant.runResponseFileCaptureCallCount,
        0,
        'runResponseFileCapture should NOT be called on mid-turn',
    );
}

// ─── Wiring: responseFileCapture surfaces on attend result ──────────────────

async function testResponseFileCaptureOnResult(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextFileCaptureResult = makeFileCaptureResult({
        filesDetected: 3,
        factsWritten: 3,
        entities: [
            'project/iranti/file/server_ts',
            'project/iranti/file/attendantInstance_ts',
            'project/iranti/file/autoRemember_ts',
        ],
    });

    const result = await attendant.attend(makeAttendInput({
        phase: 'post-response',
    }));

    assert.ok(result.responseFileCapture, 'responseFileCapture should be present on post-response result');
    assert.equal(result.responseFileCapture!.filesDetected, 3);
    assert.equal(result.responseFileCapture!.factsWritten, 3);
    assert.equal(result.responseFileCapture!.entities.length, 3);
}

async function testResponseFileCaptureAbsentOnPreResponse(): Promise<void> {
    const attendant = await makeAttendant();

    const result = await attendant.attend(makeAttendInput({
        phase: 'pre-response',
    }));

    // M7 is post-response only; field should be absent (undefined) on other phases.
    assert.equal(
        result.responseFileCapture,
        undefined,
        'responseFileCapture should be undefined on pre-response',
    );
}

async function testResponseFileCaptureNoOpOnShortResponse(): Promise<void> {
    const attendant = await makeAttendant();
    // Return a no-op result (stubbed to 0 written).
    attendant.nextFileCaptureResult = makeFileCaptureResult({
        filesDetected: 0,
        factsWritten: 0,
        entities: [],
        skipped: [{ reason: 'response_too_short' }],
    });

    const result = await attendant.attend(makeAttendInput({
        phase: 'post-response',
        latestMessage: 'ok',
    }));

    assert.equal(result.responseFileCapture!.factsWritten, 0);
    assert.equal(result.responseFileCapture!.filesDetected, 0);
    assert.equal(result.responseFileCapture!.skipped[0].reason, 'response_too_short');
}

async function testResponseFileCaptureWithWriteErrorStillReturns(): Promise<void> {
    const attendant = await makeAttendant();
    // Partial failure: 2 detected, 1 written, 1 skipped.
    attendant.nextFileCaptureResult = makeFileCaptureResult({
        filesDetected: 2,
        factsWritten: 1,
        entities: ['project/iranti/file/server_ts'],
        skipped: [{ reason: 'librarian_write_failed', detail: 'DB timeout' }],
    });

    const result = await attendant.attend(makeAttendInput({
        phase: 'post-response',
    }));

    // Attend should still complete and surface what was captured.
    assert.ok(result.responseFileCapture);
    assert.equal(result.responseFileCapture!.factsWritten, 1);
    assert.equal(result.responseFileCapture!.skipped.length, 1);
    assert.equal(result.responseFileCapture!.skipped[0].reason, 'librarian_write_failed');
}

// ─── Test runner ─────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void> | void]> = [
    // Pure unit tests
    ['detectFileAction: edit patterns', testDetectFileActionEdit],
    ['detectFileAction: create patterns', testDetectFileActionCreate],
    ['detectFileAction: read is default', testDetectFileActionReadIsDefault],
    ['detectFileAction: created wins over edit', testDetectFileActionCreatedWinsOverEdit],
    ['detectFileAction: case insensitive', testDetectFileActionCaseInsensitive],
    // Integration: wiring
    ['runResponseFileCapture called on post-response', testRunResponseFileCaptureCalledOnPostResponse],
    ['runResponseFileCapture NOT called on pre-response', testRunResponseFileCaptureNotCalledOnPreResponse],
    ['runResponseFileCapture NOT called on mid-turn', testRunResponseFileCaptureNotCalledOnMidTurn],
    ['responseFileCapture surfaced on post-response result', testResponseFileCaptureOnResult],
    ['responseFileCapture absent on pre-response result', testResponseFileCaptureAbsentOnPreResponse],
    ['responseFileCapture no-op on short response', testResponseFileCaptureNoOpOnShortResponse],
    ['responseFileCapture partial write error still returns', testResponseFileCaptureWithWriteErrorStillReturns],
];

async function main(): Promise<void> {
    let passed = 0;
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ✗ ${name}`);
            console.error(`    ${err instanceof Error ? err.message : String(err)}`);
            failed++;
        }
    }
    console.log(`\nM7 response file capture: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
