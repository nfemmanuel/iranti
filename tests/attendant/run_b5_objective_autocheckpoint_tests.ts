/**
 * B5: A6 SessionObjective + M5 AutoCheckpointSignal tests.
 *
 * A6 derives a structured SessionObjective from the task string (and
 * optionally from an interrupted checkpoint's nextStep). The objective is
 * stored on WorkingMemoryBrief so drift checks and auto-checkpoint logic can
 * reason about "what the session was for" without re-parsing the task.
 *
 * M5 surfaces a soft AutoCheckpointSignal when pressure has built up:
 *   - drift_detected     (critical)
 *   - turns_without_write (strong, >= AUTO_CHECKPOINT_TURN_THRESHOLD)
 *   - tool_cost_threshold (suggested, >= AUTO_CHECKPOINT_TOOL_COST_THRESHOLD)
 *
 * M5 is a SIGNAL only — the host still calls iranti_checkpoint. This mirrors
 * the M3 writeNudge approach.
 *
 * This file has two layers mirroring run_b4_skip_drift_tests.ts:
 *   - Pure unit tests for deriveSessionObjective and detectAutoCheckpointTrigger.
 *   - Stubbed integration tests that verify attend() wiring for both.
 */

import assert from 'node:assert/strict';

// B5: mirror B4's env bootstrap so getProjectMemoryEntity() resolves during
// stubbed integration tests.
const PRIOR_MEMORY_ENTITY = process.env.IRANTI_MEMORY_ENTITY;
process.env.IRANTI_MEMORY_ENTITY = 'project/iranti';

import {
    AttendantInstance,
    deriveSessionObjective,
    detectAutoCheckpointTrigger,
    AUTO_CHECKPOINT_TOOL_COST_THRESHOLD,
    AUTO_CHECKPOINT_TURN_THRESHOLD,
    type AttendInput,
    type ObserveResult,
    type FactInjection,
    type SessionObjective,
    type AutoCheckpointSignal,
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

const AGENT_ID = 'b5_objective_autocheckpoint_test_agent';
const PROJECT_ENTITY = 'project/iranti';

// ─── A6: deriveSessionObjective pure unit tests ──────────────────────────────

function testObjectiveSkippedForEmptyTask(): void {
    const obj = deriveSessionObjective({ task: '' });
    assert.equal(obj.source, 'skipped');
    assert.equal(obj.confidence, 0);
    assert.equal(obj.taskSignals.length, 0);
}

function testObjectiveSkippedForVeryShortTask(): void {
    const obj = deriveSessionObjective({ task: 'hi' });
    assert.equal(obj.source, 'skipped');
    assert.equal(obj.confidence, 0);
}

function testObjectiveExtractsVerbAndSubjects(): void {
    const obj = deriveSessionObjective({
        task: 'ship B5 release with A6 objective memory and M5 auto checkpoint',
    });
    assert.equal(obj.source, 'task_string');
    assert.equal(obj.confidence, 1, 'verb + subjects should give full confidence');
    // Primary should start with the matched verb.
    assert.ok(obj.primary.startsWith('ship'), `primary should start with 'ship', got: ${obj.primary}`);
    // Subjects should include the substantive nouns, not stopwords.
    assert.ok(obj.taskSignals.includes('release'), 'signals should include release');
    assert.ok(obj.taskSignals.includes('objective'), 'signals should include objective');
    assert.ok(obj.taskSignals.includes('memory'), 'signals should include memory');
    assert.ok(!obj.taskSignals.includes('the'), 'signals should not include stopwords');
}

function testObjectivePicksFirstPriorityVerb(): void {
    // "refactor" and "fix" both appear; "ship" comes first in OBJECTIVE_ACTION_VERBS.
    const obj = deriveSessionObjective({
        task: 'ship the refactor fix that landed yesterday',
    });
    assert.equal(obj.source, 'task_string');
    assert.ok(obj.primary.startsWith('ship'), `first-priority verb should win, got: ${obj.primary}`);
}

function testObjectiveHandlesVerbOnly(): void {
    // Task reduces to a verb with no standalone subject signals.
    const obj = deriveSessionObjective({ task: 'refactor and refactor' });
    assert.equal(obj.source, 'task_string');
    // Confidence is 0.6 when only verb OR only signals are present.
    assert.equal(obj.confidence, 0.6);
    assert.ok(obj.primary.includes('refactor'));
}

function testObjectiveHandlesSubjectsOnly(): void {
    // No known action verb — subjects only. Should still be task_string, 0.6.
    const obj = deriveSessionObjective({
        task: 'attendant memory lifecycle architecture notes',
    });
    assert.equal(obj.source, 'task_string');
    assert.equal(obj.confidence, 0.6);
    assert.ok(obj.taskSignals.includes('attendant'));
}

function testObjectiveCheckpointContinuationWins(): void {
    // With a meaningful checkpoint nextStep, the objective should carry it
    // forward instead of re-deriving from the task string.
    const obj = deriveSessionObjective({
        task: 'resume session',
        checkpointNextStep: 'Finish wiring B5 tests and run regression before ship',
    });
    assert.equal(obj.source, 'checkpoint_continuation');
    assert.equal(obj.confidence, 0.95);
    assert.ok(obj.primary.startsWith('Finish wiring B5 tests'));
    assert.ok(obj.note.includes('carried forward'));
}

function testObjectiveIgnoresShortCheckpointNextStep(): void {
    // Empty or very short nextStep should NOT override task_string derivation.
    const obj = deriveSessionObjective({
        task: 'ship B5 release',
        checkpointNextStep: '...',
    });
    assert.equal(obj.source, 'task_string');
}

function testObjectiveCapsPrimaryLength(): void {
    const huge = 'ship ' + 'feature '.repeat(60);
    const obj = deriveSessionObjective({ task: huge });
    assert.ok(obj.primary.length <= 120, `primary should be capped, got length ${obj.primary.length}`);
}

function testObjectiveNoteIncludesSignals(): void {
    const obj = deriveSessionObjective({
        task: 'audit attendant lifecycle handshake attend checkpoint',
    });
    assert.ok(obj.note.includes('audit') || obj.note.includes('attendant'));
}

// ─── M5: detectAutoCheckpointTrigger pure unit tests ─────────────────────────

function testAutoCheckpointUndefinedForHealthyState(): void {
    const result = detectAutoCheckpointTrigger({
        toolCallsSinceLastWrite: 2,
        turnsWithoutWrite: 0,
        driftDetected: false,
    });
    assert.equal(result, undefined, 'no trigger should fire for healthy state');
}

function testAutoCheckpointFiresOnDrift(): void {
    const result = detectAutoCheckpointTrigger({
        toolCallsSinceLastWrite: 0,
        turnsWithoutWrite: 0,
        driftDetected: true,
        driftOverlap: 0.05,
        driftDrivingTokens: ['koa', 'middleware', 'http'],
        sessionObjective: {
            primary: 'ship B5 release',
            taskSignals: ['release', 'b5'],
            confidence: 1,
            source: 'task_string',
            derivedAt: new Date().toISOString(),
            note: '',
        },
    });
    assert.ok(result, 'drift should fire the signal');
    assert.equal(result!.reason, 'drift_detected');
    assert.equal(result!.urgency, 'critical');
    assert.equal(result!.driftOverlap, 0.05);
    assert.ok(result!.draftCurrentStep && result!.draftCurrentStep.includes('ship B5 release'));
    assert.ok(result!.draftNextStep && result!.draftNextStep.includes('koa'));
    assert.ok(result!.message.includes('drift detected'));
}

function testAutoCheckpointFiresOnTurnsWithoutWrite(): void {
    const result = detectAutoCheckpointTrigger({
        toolCallsSinceLastWrite: 1,
        turnsWithoutWrite: AUTO_CHECKPOINT_TURN_THRESHOLD,
        driftDetected: false,
    });
    assert.ok(result);
    assert.equal(result!.reason, 'turns_without_write');
    assert.equal(result!.urgency, 'strong');
    assert.equal(result!.turnsWithoutWrite, AUTO_CHECKPOINT_TURN_THRESHOLD);
}

function testAutoCheckpointFiresOnToolCostThreshold(): void {
    const result = detectAutoCheckpointTrigger({
        toolCallsSinceLastWrite: AUTO_CHECKPOINT_TOOL_COST_THRESHOLD,
        turnsWithoutWrite: 0,
        driftDetected: false,
    });
    assert.ok(result);
    assert.equal(result!.reason, 'tool_cost_threshold');
    assert.equal(result!.urgency, 'suggested');
    assert.equal(result!.toolCallsSinceLastWrite, AUTO_CHECKPOINT_TOOL_COST_THRESHOLD);
}

function testAutoCheckpointDriftWinsOverOtherTriggers(): void {
    // All 3 triggers active — drift should win as the highest-urgency signal.
    const result = detectAutoCheckpointTrigger({
        toolCallsSinceLastWrite: AUTO_CHECKPOINT_TOOL_COST_THRESHOLD + 10,
        turnsWithoutWrite: AUTO_CHECKPOINT_TURN_THRESHOLD + 2,
        driftDetected: true,
        driftOverlap: 0.1,
        driftDrivingTokens: ['new_topic'],
    });
    assert.ok(result);
    assert.equal(result!.reason, 'drift_detected');
    assert.equal(result!.urgency, 'critical');
}

function testAutoCheckpointTurnsWinOverToolCost(): void {
    // Both turn and tool-cost triggers — turns has higher urgency.
    const result = detectAutoCheckpointTrigger({
        toolCallsSinceLastWrite: AUTO_CHECKPOINT_TOOL_COST_THRESHOLD + 5,
        turnsWithoutWrite: AUTO_CHECKPOINT_TURN_THRESHOLD + 1,
        driftDetected: false,
    });
    assert.ok(result);
    assert.equal(result!.reason, 'turns_without_write');
}

function testAutoCheckpointMessageUsesObjectiveWhenPresent(): void {
    const objective: SessionObjective = {
        primary: 'refactor session brief',
        taskSignals: ['session', 'brief'],
        confidence: 1,
        source: 'task_string',
        derivedAt: new Date().toISOString(),
        note: '',
    };
    const result = detectAutoCheckpointTrigger({
        toolCallsSinceLastWrite: AUTO_CHECKPOINT_TOOL_COST_THRESHOLD,
        turnsWithoutWrite: 0,
        driftDetected: false,
        sessionObjective: objective,
    });
    assert.ok(result);
    assert.ok(result!.message.includes('refactor session brief'));
    assert.ok(result!.draftCurrentStep && result!.draftCurrentStep.includes('refactor session brief'));
}

function testAutoCheckpointHandlesMissingObjectiveGracefully(): void {
    // No objective → the draft fields should still be populated with useful text.
    const result = detectAutoCheckpointTrigger({
        toolCallsSinceLastWrite: AUTO_CHECKPOINT_TOOL_COST_THRESHOLD,
        turnsWithoutWrite: 0,
        driftDetected: false,
        sessionObjective: null,
    });
    assert.ok(result);
    assert.ok(result!.draftCurrentStep && result!.draftCurrentStep.length > 0);
    assert.ok(result!.message.length > 0);
}

// ─── Stubbed integration tests ───────────────────────────────────────────────

interface StubbedAttendant extends AttendantInstance {
    observeCallCount: number;
    nextObserveFacts: FactInjection[];
}

function makeStubFacts(options: Array<{ entityKey: string; confidence: number }>): FactInjection[] {
    return options.map((opt, i) => ({
        knowledgeEntryId: 5000 + i,
        entityKey: opt.entityKey,
        summary: `stub fact summary for ${opt.entityKey}`,
        value: { data: opt.entityKey },
        confidence: opt.confidence,
        source: 'b5_test_stub',
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

async function makeAttendant(taskType = 'ship B5 release with A6 objective memory and M5 auto checkpoint'): Promise<StubbedAttendant> {
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
        recentMessages: ['starting B5 tests'],
    });

    return attendant;
}

function makeAttendInput(overrides: Partial<AttendInput> = {}): AttendInput {
    return {
        latestMessage: 'shipping B5 release verification work',
        currentContext: 'ship B5 release A6 objective memory M5 auto checkpoint',
        entityHints: [PROJECT_ENTITY],
        suppressEvents: true,
        phase: 'pre-response',
        ...overrides,
    };
}

// ─── A6 integration tests ────────────────────────────────────────────────────

async function testHandshakePopulatesSessionObjective(): Promise<void> {
    const attendant = await makeAttendant();
    const anyAttendant = attendant as any;
    const brief = anyAttendant.brief;
    assert.ok(brief, 'brief should exist after handshake');
    assert.ok(brief.sessionObjective, 'sessionObjective should be populated on handshake');
    const obj: SessionObjective = brief.sessionObjective;
    assert.equal(obj.source, 'task_string');
    assert.ok(obj.primary.startsWith('ship'));
    assert.ok(obj.taskSignals.length > 0);
}

async function testObjectiveSurvivesAcrossAttendCalls(): Promise<void> {
    const attendant = await makeAttendant();
    const anyAttendant = attendant as any;
    const objectiveBefore = anyAttendant.brief.sessionObjective;
    await attendant.attend(makeAttendInput({}));
    const objectiveAfter = anyAttendant.brief.sessionObjective;
    assert.deepEqual(objectiveBefore, objectiveAfter, 'objective should not change on a normal attend call');
}

// ─── M5 integration tests ────────────────────────────────────────────────────

async function testAutoCheckpointUndefinedOnHealthyTurn(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextObserveFacts = makeStubFacts([
        { entityKey: 'project/iranti/file/server/last_edit', confidence: 88 },
    ]);
    const result = await attendant.attend(makeAttendInput({}));
    assert.equal(result.autoCheckpointSignal, undefined, 'no auto-checkpoint signal on a healthy turn');
}

async function testAutoCheckpointFiresOnDriftedTurn(): Promise<void> {
    const attendant = await makeAttendant('ship memory attendant plan proposal handshake release');
    const result = await attendant.attend(makeAttendInput({
        latestMessage: 'refactoring the HTTP middleware stack and switching to koa',
        currentContext: 'migrating express routes to generic adapters',
    }));
    assert.ok(result.drift, 'drift should fire for this divergent task');
    assert.ok(result.autoCheckpointSignal, 'auto-checkpoint signal should fire when drift fires');
    assert.equal(result.autoCheckpointSignal!.reason, 'drift_detected');
    assert.equal(result.autoCheckpointSignal!.urgency, 'critical');
}

async function testAutoCheckpointFiresWhenToolCostCrossesThreshold(): Promise<void> {
    const attendant = await makeAttendant();
    const anyAttendant = attendant as any;
    // Manually simulate tool-cost pressure — the integration path sets this
    // via runToolResultAutowrite, which requires real fact extraction. For
    // the unit shape test, direct state manipulation is simpler and the
    // pure unit tests above already cover the trigger helper itself.
    anyAttendant.toolCallsSinceLastWrite = AUTO_CHECKPOINT_TOOL_COST_THRESHOLD;

    const result = await attendant.attend(makeAttendInput({}));
    assert.ok(result.autoCheckpointSignal, 'auto-checkpoint should fire at tool-cost threshold');
    assert.equal(result.autoCheckpointSignal!.reason, 'tool_cost_threshold');
    assert.equal(result.autoCheckpointSignal!.urgency, 'suggested');
    // Should reference the handshaken objective in the message.
    assert.ok(result.autoCheckpointSignal!.message.length > 0);
}

async function testAutoCheckpointFiresWhenTurnsWithoutWriteCrossesThreshold(): Promise<void> {
    const attendant = await makeAttendant();
    const anyAttendant = attendant as any;
    anyAttendant.turnsWithoutWrite = AUTO_CHECKPOINT_TURN_THRESHOLD;

    const result = await attendant.attend(makeAttendInput({}));
    assert.ok(result.autoCheckpointSignal);
    assert.equal(result.autoCheckpointSignal!.reason, 'turns_without_write');
    assert.equal(result.autoCheckpointSignal!.urgency, 'strong');
}

async function testAutoCheckpointGatedOnPostResponse(): Promise<void> {
    const attendant = await makeAttendant();
    const anyAttendant = attendant as any;
    anyAttendant.toolCallsSinceLastWrite = AUTO_CHECKPOINT_TOOL_COST_THRESHOLD + 5;

    const result = await attendant.attend(makeAttendInput({
        phase: 'post-response',
        latestMessage: 'summary of this turn',
    }));
    // Post-response is a closeout phase — gated off.
    assert.equal(result.autoCheckpointSignal, undefined);
}

async function testAutoCheckpointCoexistsWithToolCallGuidance(): Promise<void> {
    const attendant = await makeAttendant();
    const anyAttendant = attendant as any;
    anyAttendant.turnsWithoutWrite = AUTO_CHECKPOINT_TURN_THRESHOLD;
    attendant.nextObserveFacts = makeStubFacts([
        { entityKey: 'project/iranti/file/server/last_edit', confidence: 90 },
    ]);

    const result = await attendant.attend(makeAttendInput({
        pendingToolCall: { name: 'Read', args: { file_path: 'src/api/server.ts' } },
    }));
    assert.ok(result.toolCallGuidance, 'tool call guidance should still emit');
    assert.ok(result.autoCheckpointSignal, 'auto-checkpoint should still emit');
    assert.equal(result.autoCheckpointSignal!.reason, 'turns_without_write');
}

async function testAutoCheckpointMessageMentionsObjectivePrimary(): Promise<void> {
    const attendant = await makeAttendant('ship B5 release with A6 objective memory');
    const anyAttendant = attendant as any;
    anyAttendant.turnsWithoutWrite = AUTO_CHECKPOINT_TURN_THRESHOLD;

    const result = await attendant.attend(makeAttendInput({}));
    assert.ok(result.autoCheckpointSignal);
    const sig: AutoCheckpointSignal = result.autoCheckpointSignal!;
    // The draft current step should reference the objective primary.
    assert.ok(
        sig.draftCurrentStep && sig.draftCurrentStep.toLowerCase().includes('ship'),
        `draftCurrentStep should mention the objective, got: ${sig.draftCurrentStep}`,
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
    console.log('running B5 objective + auto-checkpoint tests');

    // A6 pure unit tests
    await runTest('deriveSessionObjective skipped for empty task', testObjectiveSkippedForEmptyTask);
    await runTest('deriveSessionObjective skipped for very short task', testObjectiveSkippedForVeryShortTask);
    await runTest('deriveSessionObjective extracts verb and subjects', testObjectiveExtractsVerbAndSubjects);
    await runTest('deriveSessionObjective picks first-priority verb', testObjectivePicksFirstPriorityVerb);
    await runTest('deriveSessionObjective handles verb only', testObjectiveHandlesVerbOnly);
    await runTest('deriveSessionObjective handles subjects only', testObjectiveHandlesSubjectsOnly);
    await runTest('deriveSessionObjective checkpoint continuation wins', testObjectiveCheckpointContinuationWins);
    await runTest('deriveSessionObjective ignores short checkpoint nextStep', testObjectiveIgnoresShortCheckpointNextStep);
    await runTest('deriveSessionObjective caps primary length', testObjectiveCapsPrimaryLength);
    await runTest('deriveSessionObjective note includes signals', testObjectiveNoteIncludesSignals);

    // M5 pure unit tests
    await runTest('detectAutoCheckpointTrigger undefined for healthy state', testAutoCheckpointUndefinedForHealthyState);
    await runTest('detectAutoCheckpointTrigger fires on drift', testAutoCheckpointFiresOnDrift);
    await runTest('detectAutoCheckpointTrigger fires on turns_without_write', testAutoCheckpointFiresOnTurnsWithoutWrite);
    await runTest('detectAutoCheckpointTrigger fires on tool_cost_threshold', testAutoCheckpointFiresOnToolCostThreshold);
    await runTest('detectAutoCheckpointTrigger drift wins over other triggers', testAutoCheckpointDriftWinsOverOtherTriggers);
    await runTest('detectAutoCheckpointTrigger turns win over tool_cost', testAutoCheckpointTurnsWinOverToolCost);
    await runTest('detectAutoCheckpointTrigger message uses objective when present', testAutoCheckpointMessageUsesObjectiveWhenPresent);
    await runTest('detectAutoCheckpointTrigger handles missing objective gracefully', testAutoCheckpointHandlesMissingObjectiveGracefully);

    // A6 stubbed integration tests
    await runTest('handshake populates sessionObjective', testHandshakePopulatesSessionObjective);
    await runTest('objective survives across attend calls', testObjectiveSurvivesAcrossAttendCalls);

    // M5 stubbed integration tests
    await runTest('auto-checkpoint undefined on healthy turn', testAutoCheckpointUndefinedOnHealthyTurn);
    await runTest('auto-checkpoint fires on drifted turn', testAutoCheckpointFiresOnDriftedTurn);
    await runTest('auto-checkpoint fires when tool cost crosses threshold', testAutoCheckpointFiresWhenToolCostCrossesThreshold);
    await runTest('auto-checkpoint fires when turns without write crosses threshold', testAutoCheckpointFiresWhenTurnsWithoutWriteCrossesThreshold);
    await runTest('auto-checkpoint gated on post-response', testAutoCheckpointGatedOnPostResponse);
    await runTest('auto-checkpoint coexists with tool call guidance', testAutoCheckpointCoexistsWithToolCallGuidance);
    await runTest('auto-checkpoint message mentions objective primary', testAutoCheckpointMessageMentionsObjectivePrimary);

    if (process.exitCode === 1) {
        console.error('B5 objective + auto-checkpoint tests failed');
        process.exit(1);
    }
    console.log('B5 objective + auto-checkpoint tests passed');
}

main().catch((error) => {
    console.error('B5 objective + auto-checkpoint tests crashed:', error);
    process.exit(1);
});
