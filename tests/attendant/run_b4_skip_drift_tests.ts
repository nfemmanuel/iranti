/**
 * B4: M1 skipTool-with-teeth + M4 drift detection tests.
 *
 * M1 turns A2's advisory toolCallGuidance into an actionable skip verdict:
 *   - shouldSkip: boolean
 *   - skipConfidence: 0..1 (mean stored-fact confidence / 100)
 *   - skipReasonCode: 'facts_cover_target' | 'no_facts_for_target' |
 *                     'no_entities_derived' | 'memory_not_needed'
 *
 * M4 emits a DriftSignal when the current message/context diverges from the
 * declared (inferred) task type by Jaccard overlap < DRIFT_JACCARD_MIN.
 *
 * This file has two layers mirroring run_tool_call_retrieval_tests.ts:
 *   - Pure unit tests for deriveSkipVerdict and detectTaskDrift.
 *   - Stubbed integration tests that verify attend() wiring for both.
 */

import assert from 'node:assert/strict';

// B4: mirror A2's env bootstrap so getProjectMemoryEntity() resolves during
// stubbed integration tests. Without this the tool-call hint derivation returns
// empty and the M1 wiring cannot be exercised end-to-end.
const PRIOR_MEMORY_ENTITY = process.env.IRANTI_MEMORY_ENTITY;
process.env.IRANTI_MEMORY_ENTITY = 'project/iranti';

import {
    AttendantInstance,
    deriveSkipVerdict,
    detectTaskDrift,
    type AttendInput,
    type ObserveResult,
    type FactInjection,
    type ToolCallGuidance,
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

const AGENT_ID = 'b4_skip_drift_test_agent';
const PROJECT_ENTITY = 'project/iranti';

// ─── M1: deriveSkipVerdict pure unit tests ───────────────────────────────────

function testSkipVerdictMemoryNotNeeded(): void {
    const v = deriveSkipVerdict({
        derivedEntities: ['project/iranti/file/server'],
        factConfidences: [95],
        memoryWasSkipped: true,
    });
    // Even with facts + entities, the memory-not-needed branch must never
    // recommend skip — the facts were never actually retrieved.
    assert.equal(v.shouldSkip, false);
    assert.equal(v.skipConfidence, 0);
    assert.equal(v.skipReasonCode, 'memory_not_needed');
}

function testSkipVerdictNoEntitiesDerived(): void {
    const v = deriveSkipVerdict({
        derivedEntities: [],
        factConfidences: [90],
        memoryWasSkipped: false,
    });
    assert.equal(v.shouldSkip, false);
    assert.equal(v.skipConfidence, 0);
    assert.equal(v.skipReasonCode, 'no_entities_derived');
}

function testSkipVerdictNoFactsForTarget(): void {
    const v = deriveSkipVerdict({
        derivedEntities: ['project/iranti/file/server'],
        factConfidences: [],
        memoryWasSkipped: false,
    });
    assert.equal(v.shouldSkip, false);
    assert.equal(v.skipConfidence, 0);
    assert.equal(v.skipReasonCode, 'no_facts_for_target');
}

function testSkipVerdictFactsCoverTarget(): void {
    const v = deriveSkipVerdict({
        derivedEntities: ['project/iranti/file/server'],
        factConfidences: [90, 80, 100],
        memoryWasSkipped: false,
    });
    assert.equal(v.shouldSkip, true);
    assert.equal(v.skipReasonCode, 'facts_cover_target');
    // mean = 90; scaled to 0..1 = 0.9
    assert.equal(v.skipConfidence, 0.9);
}

function testSkipVerdictClampsOutOfRangeConfidence(): void {
    // Hostile / buggy inputs should not produce negative or >1 confidences.
    const v = deriveSkipVerdict({
        derivedEntities: ['project/iranti/file/server'],
        factConfidences: [-50, 300],
        memoryWasSkipped: false,
    });
    assert.equal(v.shouldSkip, true);
    assert.ok(v.skipConfidence >= 0 && v.skipConfidence <= 1, `skipConfidence should be clamped 0..1, got ${v.skipConfidence}`);
}

function testSkipVerdictSingleLowConfidenceFact(): void {
    // A single low-confidence fact still counts as coverage — the host can
    // inspect skipConfidence and decide whether to honor it.
    const v = deriveSkipVerdict({
        derivedEntities: ['project/iranti/file/server'],
        factConfidences: [30],
        memoryWasSkipped: false,
    });
    assert.equal(v.shouldSkip, true);
    assert.equal(v.skipConfidence, 0.3);
    assert.equal(v.skipReasonCode, 'facts_cover_target');
}

// ─── M4: detectTaskDrift pure unit tests ─────────────────────────────────────

function testDriftReturnsUndefinedForShortMessage(): void {
    const result = detectTaskDrift('hi', '', 'Ship B4 v0.3.27 release');
    assert.equal(result, undefined);
}

function testDriftReturnsUndefinedForEmptyDeclaredTask(): void {
    const result = detectTaskDrift(
        'This message is definitely long enough for drift detection',
        '',
        '',
    );
    assert.equal(result, undefined);
}

function testDriftReturnsUndefinedWhenTopicsOverlap(): void {
    // Same topic vocabulary → overlap well above 0.15 → healthy, no drift.
    const result = detectTaskDrift(
        'Shipping the release candidate for B4 and verifying CI',
        'release candidate CI verification B4',
        'Ship B4 release with CI verification',
    );
    assert.equal(result, undefined);
}

function testDriftFiresWhenTopicsDiverge(): void {
    // Completely unrelated topics → overlap below 0.15 → drift.
    const result = detectTaskDrift(
        'refactoring the HTTP middleware stack and switching to koa',
        '',
        'ship memory attendant plan proposal handshake release',
    );
    assert.ok(result, 'drift should be detected');
    assert.equal(result!.detected, true);
    assert.ok(result!.overlap < 0.15, `overlap should be < 0.15, got ${result!.overlap}`);
    assert.ok(result!.drivingTokens.length > 0, 'drivingTokens should be populated');
    assert.ok(result!.missingTokens.length > 0, 'missingTokens should be populated');
    assert.equal(result!.declaredTaskType, 'ship memory attendant plan proposal handshake release');
    assert.ok(result!.note.includes('Task drift detected'));
}

function testDriftIgnoresStopwords(): void {
    // Stopword-only overlap does NOT count as real topic overlap.
    // 'the and for with that' — all stopwords. Actual topics diverge.
    const result = detectTaskDrift(
        'refactoring the HTTP stack and switching to koa for the middleware with that plan',
        '',
        'ship memory attendant with that handshake and the release',
    );
    assert.ok(result, 'drift should be detected when only stopwords overlap');
    assert.equal(result!.detected, true);
}

function testDriftIsCaseInsensitive(): void {
    const result = detectTaskDrift(
        'SHIPPING the RELEASE candidate for b4 verification',
        '',
        'ship b4 release verification',
    );
    // Topic vocabulary is identical modulo case → no drift.
    assert.equal(result, undefined);
}

function testDriftDedupsTokensInCurrentContext(): void {
    // Duplicated token 'ship ship ship' should not inflate the overlap.
    const result = detectTaskDrift(
        'ship ship ship database migration tooling overhaul',
        '',
        'ship memory attendant plan proposal handshake release',
    );
    // Only 'ship' overlaps; current has many driving tokens.
    assert.ok(result, 'drift should fire');
    assert.ok(result!.overlap < 0.15, `overlap should be low, got ${result!.overlap}`);
}

function testDriftCapsDrivingTokens(): void {
    const manyDrivers = Array.from({ length: 20 }, (_, i) => `driver${i}`).join(' ');
    const result = detectTaskDrift(
        `completely unrelated work ${manyDrivers}`,
        '',
        'ship release',
    );
    assert.ok(result);
    assert.ok(result!.drivingTokens.length <= 6, `drivingTokens should be capped to 6, got ${result!.drivingTokens.length}`);
}

// ─── Stubbed integration tests ───────────────────────────────────────────────

interface StubbedAttendant extends AttendantInstance {
    observeCallCount: number;
    nextObserveFacts: FactInjection[];
}

function makeStubFacts(options: Array<{ entityKey: string; confidence: number }>): FactInjection[] {
    return options.map((opt, i) => ({
        knowledgeEntryId: 4000 + i,
        entityKey: opt.entityKey,
        summary: `stub fact summary for ${opt.entityKey}`,
        value: { data: opt.entityKey },
        confidence: opt.confidence,
        source: 'b4_test_stub',
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

async function makeAttendant(taskType = 'B4 skip-tool and drift testing'): Promise<StubbedAttendant> {
    const attendant = new AttendantInstance(AGENT_ID) as unknown as StubbedAttendant;
    const anyAttendant = attendant as any;

    attendant.observeCallCount = 0;
    attendant.nextObserveFacts = [];

    anyAttendant.loadPersistedState = async () => null;
    anyAttendant.loadOperatingRules = async () => 'test operating rules';
    anyAttendant.inferTask = async () => taskType;
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

    anyAttendant.observe = async () => {
        attendant.observeCallCount++;
        return makeObserveResult([...attendant.nextObserveFacts]);
    };

    await anyAttendant.handshake({
        task: taskType,
        recentMessages: ['starting B4 tests'],
    });

    return attendant;
}

function makeAttendInput(overrides: Partial<AttendInput> = {}): AttendInput {
    return {
        latestMessage: 'skip-tool and drift verification',
        currentContext: 'testing B4 wiring with stubbed attendant',
        entityHints: [PROJECT_ENTITY],
        suppressEvents: true,
        phase: 'pre-response',
        ...overrides,
    };
}

// ─── M1 integration tests ────────────────────────────────────────────────────

async function testAttendSurfacesShouldSkipWhenFactsCoverTarget(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextObserveFacts = makeStubFacts([
        { entityKey: 'project/iranti/file/server/last_edit', confidence: 88 },
    ]);

    const result = await attendant.attend(makeAttendInput({
        pendingToolCall: { name: 'Read', args: { file_path: 'src/api/server.ts' } },
    }));

    assert.ok(result.toolCallGuidance, 'toolCallGuidance should be present');
    const g: ToolCallGuidance = result.toolCallGuidance!;
    assert.equal(g.shouldSkip, true, 'shouldSkip should be true when a fact covers the derived entity');
    assert.equal(g.skipReasonCode, 'facts_cover_target');
    assert.equal(g.skipConfidence, 0.88);
    assert.equal(g.factCount, 1);
    assert.ok(g.note.includes('shouldSkip=true'), `note should report the skip verdict, got: ${g.note}`);
}

async function testAttendShouldNotSkipWhenFactsMissTarget(): Promise<void> {
    const attendant = await makeAttendant();
    // Fact exists but is on a DIFFERENT entity — should not trigger a skip.
    attendant.nextObserveFacts = makeStubFacts([
        { entityKey: 'project/iranti/file/librarian/some_key', confidence: 95 },
    ]);

    const result = await attendant.attend(makeAttendInput({
        pendingToolCall: { name: 'Read', args: { file_path: 'src/api/server.ts' } },
    }));

    assert.ok(result.toolCallGuidance);
    const g = result.toolCallGuidance!;
    assert.equal(g.shouldSkip, false);
    assert.equal(g.skipReasonCode, 'no_facts_for_target');
    assert.equal(g.skipConfidence, 0);
    // factCount counts only entity-covered facts, not all structuredFacts.
    assert.equal(g.factCount, 0);
}

async function testAttendShouldNotSkipWhenNoEntitiesDerived(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextObserveFacts = makeStubFacts([
        { entityKey: 'project/iranti/file/server/last_edit', confidence: 88 },
    ]);

    const result = await attendant.attend(makeAttendInput({
        pendingToolCall: { name: 'Glob', args: { pattern: '**/*.ts' } },
    }));

    assert.ok(result.toolCallGuidance);
    const g = result.toolCallGuidance!;
    assert.equal(g.shouldSkip, false);
    assert.equal(g.skipReasonCode, 'no_entities_derived');
    assert.deepEqual(g.derivedEntities, []);
}

async function testSkipVerdictShapeEchoedWithoutPendingToolCall(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextObserveFacts = [];

    const result = await attendant.attend(makeAttendInput({}));
    // With no pendingToolCall, guidance should be absent entirely.
    assert.equal(result.toolCallGuidance, undefined);
}

async function testSkipVerdictFieldsAlwaysPresentWhenGuidanceExists(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextObserveFacts = [];

    const result = await attendant.attend(makeAttendInput({
        pendingToolCall: { name: 'Read', args: { file_path: 'src/unknown.ts' } },
    }));

    assert.ok(result.toolCallGuidance);
    const g = result.toolCallGuidance!;
    // Shape invariant: whenever guidance is emitted, the three skip fields
    // must all be present so hosts can gate on them without optional checks.
    assert.equal(typeof g.shouldSkip, 'boolean');
    assert.equal(typeof g.skipConfidence, 'number');
    assert.equal(typeof g.skipReasonCode, 'string');
}

// ─── M4 integration tests ────────────────────────────────────────────────────

async function testDriftUndefinedOnHealthyTask(): Promise<void> {
    const attendant = await makeAttendant('ship B4 release with CI verification');
    const result = await attendant.attend(makeAttendInput({
        latestMessage: 'Shipping the B4 release candidate and verifying CI',
        currentContext: 'release B4 CI verification pipeline',
    }));
    assert.equal(result.drift, undefined, 'drift should be undefined when topics overlap');
}

async function testDriftFiresWhenCurrentMessageDivergesFromDeclaredTask(): Promise<void> {
    const attendant = await makeAttendant('ship memory attendant plan proposal handshake release');
    const result = await attendant.attend(makeAttendInput({
        latestMessage: 'refactoring the HTTP middleware stack and switching to koa',
        currentContext: 'migrating express routes to generic adapters',
    }));
    assert.ok(result.drift, 'drift should fire when topics diverge');
    assert.equal(result.drift!.detected, true);
    assert.ok(result.drift!.overlap < 0.15);
    assert.ok(result.drift!.drivingTokens.length > 0);
    assert.equal(result.drift!.declaredTaskType, 'ship memory attendant plan proposal handshake release');
}

async function testDriftGatedOnPostResponsePhase(): Promise<void> {
    const attendant = await makeAttendant('ship memory attendant plan proposal');
    const result = await attendant.attend(makeAttendInput({
        latestMessage: 'refactoring the HTTP middleware stack and switching to koa',
        currentContext: '',
        phase: 'post-response',
    }));
    // Post-response is a closeout phase — drift is gated off.
    assert.equal(result.drift, undefined);
}

async function testDriftFiresOnMidTurnPhase(): Promise<void> {
    const attendant = await makeAttendant('ship memory attendant plan proposal');
    const result = await attendant.attend(makeAttendInput({
        latestMessage: 'rewriting the sql migration tooling completely from scratch',
        currentContext: '',
        phase: 'mid-turn',
    }));
    assert.ok(result.drift, 'drift should fire on mid-turn phase when topics diverge');
    assert.equal(result.drift!.detected, true);
}

async function testDriftUndefinedWhenMessageTooShort(): Promise<void> {
    const attendant = await makeAttendant('ship memory attendant plan proposal');
    const result = await attendant.attend(makeAttendInput({
        latestMessage: 'ok',
        currentContext: '',
    }));
    assert.equal(result.drift, undefined);
}

async function testDriftCoexistsWithToolCallGuidance(): Promise<void> {
    const attendant = await makeAttendant('ship memory attendant plan proposal');
    attendant.nextObserveFacts = makeStubFacts([
        { entityKey: 'project/iranti/file/server/last_edit', confidence: 90 },
    ]);
    const result = await attendant.attend(makeAttendInput({
        latestMessage: 'refactoring HTTP middleware koa express',
        currentContext: 'unrelated server work',
        pendingToolCall: { name: 'Read', args: { file_path: 'src/api/server.ts' } },
    }));
    // Both signals can coexist — host sees drift AND skip recommendation.
    assert.ok(result.drift, 'drift should still fire with pendingToolCall present');
    assert.ok(result.toolCallGuidance, 'guidance should still be emitted with drift present');
    assert.equal(result.toolCallGuidance!.shouldSkip, true);
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
    console.log('running B4 skip-tool and drift tests');

    // M1 pure unit tests
    await runTest('deriveSkipVerdict memory_not_needed short-circuits', testSkipVerdictMemoryNotNeeded);
    await runTest('deriveSkipVerdict no entities → no_entities_derived', testSkipVerdictNoEntitiesDerived);
    await runTest('deriveSkipVerdict no facts → no_facts_for_target', testSkipVerdictNoFactsForTarget);
    await runTest('deriveSkipVerdict facts cover target → shouldSkip=true', testSkipVerdictFactsCoverTarget);
    await runTest('deriveSkipVerdict clamps out-of-range confidences', testSkipVerdictClampsOutOfRangeConfidence);
    await runTest('deriveSkipVerdict single low-confidence fact still covers', testSkipVerdictSingleLowConfidenceFact);

    // M4 pure unit tests
    await runTest('detectTaskDrift undefined for short message', testDriftReturnsUndefinedForShortMessage);
    await runTest('detectTaskDrift undefined for empty declared task', testDriftReturnsUndefinedForEmptyDeclaredTask);
    await runTest('detectTaskDrift undefined when topics overlap', testDriftReturnsUndefinedWhenTopicsOverlap);
    await runTest('detectTaskDrift fires when topics diverge', testDriftFiresWhenTopicsDiverge);
    await runTest('detectTaskDrift ignores stopwords', testDriftIgnoresStopwords);
    await runTest('detectTaskDrift is case-insensitive', testDriftIsCaseInsensitive);
    await runTest('detectTaskDrift dedupes repeated tokens', testDriftDedupsTokensInCurrentContext);
    await runTest('detectTaskDrift caps drivingTokens at 6', testDriftCapsDrivingTokens);

    // M1 stubbed integration tests
    await runTest('attend surfaces shouldSkip=true when facts cover target', testAttendSurfacesShouldSkipWhenFactsCoverTarget);
    await runTest('attend shouldSkip=false when facts miss target', testAttendShouldNotSkipWhenFactsMissTarget);
    await runTest('attend shouldSkip=false when no entities derived', testAttendShouldNotSkipWhenNoEntitiesDerived);
    await runTest('attend leaves guidance undefined without pendingToolCall', testSkipVerdictShapeEchoedWithoutPendingToolCall);
    await runTest('skip verdict fields always present when guidance exists', testSkipVerdictFieldsAlwaysPresentWhenGuidanceExists);

    // M4 stubbed integration tests
    await runTest('attend drift undefined on healthy task', testDriftUndefinedOnHealthyTask);
    await runTest('attend drift fires when current message diverges', testDriftFiresWhenCurrentMessageDivergesFromDeclaredTask);
    await runTest('attend drift gated on post-response phase', testDriftGatedOnPostResponsePhase);
    await runTest('attend drift fires on mid-turn phase', testDriftFiresOnMidTurnPhase);
    await runTest('attend drift undefined when message too short', testDriftUndefinedWhenMessageTooShort);
    await runTest('attend drift coexists with toolCallGuidance', testDriftCoexistsWithToolCallGuidance);

    if (process.exitCode === 1) {
        console.error('B4 skip-tool and drift tests failed');
        process.exit(1);
    }
    console.log('B4 skip-tool and drift tests passed');
}

main().catch((error) => {
    console.error('B4 skip-tool and drift tests crashed:', error);
    process.exit(1);
});
