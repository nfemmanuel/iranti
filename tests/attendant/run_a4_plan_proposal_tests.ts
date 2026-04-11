/**
 * A4: plan proposal on handshake tests.
 *
 * Two layers:
 *   1. Pure unit tests for detectPlanSignals and buildPlanProposal — no db,
 *      no LLM, fully deterministic.
 *   2. Stubbed integration tests that swap out dependencies on an
 *      AttendantInstance and verify handshake() returns a WorkingMemoryBrief
 *      with a populated planProposal field that matches the builder output.
 *
 * A4 has no LLM calls (deterministic keyword matching), so the integration
 * layer just needs to confirm the wiring — not the LLM behavior.
 */

import assert from 'node:assert/strict';

// A4: set IRANTI_MEMORY_ENTITY BEFORE importing the attendant module so
// getProjectMemoryEntity() resolves to a real project entity during the
// stubbed integration tests. Same pattern as run_tool_call_retrieval and
// run_m2_tool_result_autowrite.
const PRIOR_MEMORY_ENTITY = process.env.IRANTI_MEMORY_ENTITY;
process.env.IRANTI_MEMORY_ENTITY = 'project/iranti';

import {
    AttendantInstance,
    buildPlanProposal,
    detectPlanSignals,
    type PlanProposal,
    type PlanProposalStep,
    type PlanSignal,
    type SessionCheckpointRecord,
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

const AGENT_ID = 'a4_plan_proposal_test_agent';

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

// ─── Pure unit tests: detectPlanSignals ─────────────────────────────────────

function testDetectShipSignal(): void {
    const matches = detectPlanSignals('ship v0.3.26 with all tests green');
    const signals = matches.map((m) => m.signal);
    assert.ok(signals.includes('ship_release'), `expected ship_release in ${signals.join(',')}`);
}

function testDetectImplementSignal(): void {
    const matches = detectPlanSignals('implement plan proposal on handshake');
    const signals = matches.map((m) => m.signal);
    assert.ok(signals.includes('implement_add'));
}

function testDetectRefactorSignal(): void {
    const matches = detectPlanSignals('refactor the mock provider classifier');
    const signals = matches.map((m) => m.signal);
    assert.ok(signals.includes('refactor_rewrite'));
}

function testDetectFixSignal(): void {
    const matches = detectPlanSignals('fix the post-compaction Tufacle bug');
    const signals = matches.map((m) => m.signal);
    assert.ok(signals.includes('fix_debug'));
}

function testDetectAuditSignal(): void {
    const matches = detectPlanSignals('audit the attend flow for compliance gaps');
    const signals = matches.map((m) => m.signal);
    assert.ok(signals.includes('audit_review'));
}

function testDetectMigrateSignal(): void {
    const matches = detectPlanSignals('migrate the knowledge entries to the new schema');
    const signals = matches.map((m) => m.signal);
    assert.ok(signals.includes('migrate'));
}

function testDetectTestSignal(): void {
    const matches = detectPlanSignals('write regression tests for the librarian conflict resolver');
    const signals = matches.map((m) => m.signal);
    assert.ok(signals.includes('test_author'));
}

function testDetectDeploySignal(): void {
    const matches = detectPlanSignals('deploy the new iranti daemon to production');
    const signals = matches.map((m) => m.signal);
    assert.ok(signals.includes('deploy'));
}

function testDetectMultipleSignals(): void {
    const matches = detectPlanSignals('implement the fix and write tests');
    const signals = matches.map((m) => m.signal);
    assert.ok(signals.length >= 2, `expected 2+ signals, got ${signals.length}`);
    assert.ok(signals.includes('implement_add'));
    assert.ok(signals.includes('fix_debug'));
    assert.ok(signals.includes('test_author'));
}

function testDetectNoSignals(): void {
    const matches = detectPlanSignals('hello world');
    assert.equal(matches.length, 0);
}

function testDetectIsCaseInsensitive(): void {
    const matches = detectPlanSignals('SHIP V0.3.26');
    const signals = matches.map((m) => m.signal);
    assert.ok(signals.includes('ship_release'));
}

function testDetectDeduplicatesSignalsWithinSameKeywordSet(): void {
    // 'fix' and 'bug' are both in fix_debug keyword set. Expect one signal,
    // not two.
    const matches = detectPlanSignals('fix the bug');
    const fixMatches = matches.filter((m) => m.signal === 'fix_debug');
    assert.equal(fixMatches.length, 1);
}

// ─── Pure unit tests: buildPlanProposal ─────────────────────────────────────

function testBuildPlanForShortTaskSkips(): void {
    const plan = buildPlanProposal('hi', 'general', null);
    assert.equal(plan.suggested, false);
    assert.equal(plan.source, 'skipped');
    assert.equal(plan.reason, 'task_too_short_and_no_plan_signals_detected');
    assert.equal(plan.steps.length, 0);
}

function testBuildPlanForNoSignalsSkips(): void {
    // Long enough to clear min-length, but no complexity keywords
    const plan = buildPlanProposal(
        'answer the user question about what the weather was like yesterday',
        'general assistance',
        null,
    );
    assert.equal(plan.suggested, false);
    assert.equal(plan.source, 'skipped');
    assert.equal(plan.reason, 'no_complexity_keywords_detected');
    assert.equal(plan.steps.length, 0);
}

function testBuildPlanForShipProducesShipTemplate(): void {
    const plan = buildPlanProposal('ship v0.3.26 with all tests green and CI verified', 'release', null);
    assert.equal(plan.suggested, true);
    assert.equal(plan.source, 'heuristic_keyword');
    assert.equal(plan.reason, 'matched_signal_ship_release');
    assert.ok(plan.steps.length >= 4, `expected 4+ steps, got ${plan.steps.length}`);
    assert.ok(
        plan.steps.some((s) => s.description.toLowerCase().includes('tag')),
        'ship template should mention tag step',
    );
    assert.ok(
        plan.steps.some((s) => s.description.toLowerCase().includes('ci')),
        'ship template should mention CI verification',
    );
    assert.ok(plan.taskSignals.includes('ship_release'));
}

function testBuildPlanForFixProducesFixTemplate(): void {
    const plan = buildPlanProposal('fix the failing compliance test in production build', 'debugging', null);
    assert.equal(plan.suggested, true);
    assert.equal(plan.source, 'heuristic_keyword');
    assert.ok(
        plan.steps.some((s) => s.description.toLowerCase().includes('reprodu')),
        'fix template should include reproduce step',
    );
    assert.ok(
        plan.steps.some((s) => s.description.toLowerCase().includes('regression test')),
        'fix template should include regression test step',
    );
}

function testBuildPlanForImplementProducesImplementTemplate(): void {
    const plan = buildPlanProposal('implement a new caching layer for the retrieval path', 'feature', null);
    assert.equal(plan.suggested, true);
    assert.equal(plan.source, 'heuristic_keyword');
    assert.ok(plan.steps.some((s) => s.description.toLowerCase().includes('search')));
    assert.ok(plan.steps.some((s) => s.description.toLowerCase().includes('test')));
}

function testBuildPlanPrioritizesShipOverOthers(): void {
    // Task has both implement and ship. Ship should win by priority.
    const plan = buildPlanProposal('implement then ship v0.3.27 with full test coverage', 'release', null);
    assert.equal(plan.reason, 'matched_signal_ship_release');
    assert.ok(plan.taskSignals.includes('implement_add'));
    assert.ok(plan.taskSignals.includes('ship_release'));
    assert.ok(plan.note && plan.note.includes('Multiple plan signals'));
}

function testBuildPlanPrioritizesFixOverImplement(): void {
    const plan = buildPlanProposal('implement a fix for the bug in the router', 'debugging', null);
    // fix_debug > implement_add in priority
    assert.equal(plan.reason, 'matched_signal_fix_debug');
}

function testBuildPlanWithOnlyInferredTaskType(): void {
    // Task string is short but inferredTaskType has complexity signals
    const plan = buildPlanProposal('x', 'implement a new feature in the attendant', null);
    assert.equal(plan.suggested, true);
    assert.equal(plan.source, 'heuristic_keyword');
}

// Checkpoint continuation tests

function makeInterruptedCheckpoint(
    overrides: Partial<SessionCheckpointRecord['checkpoint']> = {},
): SessionCheckpointRecord {
    return {
        task: 'prior task',
        status: 'interrupted',
        sessionId: 'session_test_a4',
        startedAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T01:00:00.000Z',
        interruptedAt: '2026-04-10T01:00:00.000Z',
        lastHeartbeatAt: '2026-04-10T01:00:00.000Z',
        taskFingerprint: 'prior task prior task',
        checkpoint: {
            nextStep: 'run tsc --noEmit to verify the S4 edit',
            currentStep: 'applied the gatherConflictEvidence edit to librarian/index.ts',
            openRisks: [],
            recentOutputs: [],
            entityTargets: ['project/iranti'],
            ...overrides,
        },
    } as SessionCheckpointRecord;
}

function testBuildPlanUsesCheckpointWhenInterrupted(): void {
    const checkpoint = makeInterruptedCheckpoint();
    const plan = buildPlanProposal('ship v0.3.26', 'release', checkpoint);
    // Checkpoint takes precedence even when keywords match
    assert.equal(plan.source, 'checkpoint_continuation');
    assert.equal(plan.reason, 'interrupted_session_checkpoint_found');
    assert.ok(plan.steps[0]!.description.includes('run tsc'));
    assert.ok(plan.taskSignals.includes('resume_from_checkpoint'));
    assert.ok(plan.note && plan.note.includes('persisted session checkpoint'));
}

function testBuildPlanCheckpointWithoutNextStepStillEmitsPlan(): void {
    const checkpoint = makeInterruptedCheckpoint({ nextStep: undefined });
    const plan = buildPlanProposal('ship it', 'release', checkpoint);
    assert.equal(plan.source, 'checkpoint_continuation');
    // Should still include the re-confirm + close-loop steps
    assert.ok(plan.steps.length >= 2);
}

function testBuildPlanIgnoresCompletedCheckpoint(): void {
    const checkpoint = makeInterruptedCheckpoint();
    (checkpoint as any).status = 'completed';
    const plan = buildPlanProposal('refactor the storage layer', 'refactor', checkpoint);
    // Completed checkpoints should NOT take precedence; keyword heuristic runs
    assert.equal(plan.source, 'heuristic_keyword');
    assert.equal(plan.reason, 'matched_signal_refactor_rewrite');
}

function testBuildPlanNullCheckpointRunsKeywordHeuristic(): void {
    const plan = buildPlanProposal('audit the librarian scoring logic', 'audit', null);
    assert.equal(plan.source, 'heuristic_keyword');
    assert.equal(plan.reason, 'matched_signal_audit_review');
}

function testBuildPlanUndefinedCheckpointRunsKeywordHeuristic(): void {
    const plan = buildPlanProposal('migrate the old schema to the new one', 'migration', undefined);
    assert.equal(plan.source, 'heuristic_keyword');
    assert.equal(plan.reason, 'matched_signal_migrate');
}

function testStepsAreSequentiallyNumbered(): void {
    const plan = buildPlanProposal('implement a new feature', 'feature', null);
    for (let i = 0; i < plan.steps.length; i++) {
        assert.equal(plan.steps[i]!.n, i + 1, `step at index ${i} should have n=${i + 1}`);
    }
}

function testAllStepsHaveRationale(): void {
    const plan = buildPlanProposal('refactor the attendant class', 'refactor', null);
    for (const step of plan.steps) {
        assert.ok(step.rationale && step.rationale.length > 0, `step "${step.description}" missing rationale`);
    }
}

// ─── Integration: handshake wiring ──────────────────────────────────────────

function makeAttendant(): AttendantInstance {
    return new AttendantInstance(AGENT_ID);
}

function stubAttendantDeps(attendant: AttendantInstance): void {
    const anyAttendant = attendant as any;
    // No-op all the I/O so handshake runs without hitting the db/LLM
    anyAttendant.loadPersistedState = async () => null;
    anyAttendant.loadOperatingRules = async () => 'stubbed operating rules';
    anyAttendant.inferTask = async (ctx: any) => ctx.task || 'general assistance';
    anyAttendant.buildWorkingMemory = async () => [];
    anyAttendant.loadSessionLedgerSignals = async () => ({ learnings: [], profile: null });
    anyAttendant.loadProjectPolicies = async () => [];
    anyAttendant.persistState = async () => {};
}

async function testHandshakePopulatesPlanProposalForShipTask(): Promise<void> {
    const attendant = makeAttendant();
    stubAttendantDeps(attendant);
    const brief = await attendant.handshake({
        task: 'ship v0.3.26 with all tests green and CI verified',
        recentMessages: [],
    });
    assert.ok(brief.planProposal, 'brief should include planProposal');
    const plan = brief.planProposal as PlanProposal;
    assert.equal(plan.suggested, true);
    assert.equal(plan.source, 'heuristic_keyword');
    assert.equal(plan.reason, 'matched_signal_ship_release');
    assert.ok(plan.steps.length >= 4);
}

async function testHandshakePopulatesSkippedPlanForTrivialTask(): Promise<void> {
    const attendant = makeAttendant();
    stubAttendantDeps(attendant);
    const brief = await attendant.handshake({
        task: 'hi',
        recentMessages: [],
    });
    assert.ok(brief.planProposal, 'brief should always include planProposal (even when skipped)');
    const plan = brief.planProposal as PlanProposal;
    assert.equal(plan.suggested, false);
    assert.equal(plan.source, 'skipped');
}

async function testHandshakeUsesCheckpointContinuationWhenInterrupted(): Promise<void> {
    const attendant = makeAttendant();
    stubAttendantDeps(attendant);
    // Seed an interrupted checkpoint on the instance, then call handshake
    const anyAttendant = attendant as any;
    anyAttendant.loadPersistedState = async () => ({
        sessionStarted: '2026-04-10T00:00:00.000Z',
        sessionCheckpoint: makeInterruptedCheckpoint(),
        compliance: null,
        watchedEntities: [],
    });
    const brief = await attendant.handshake({
        task: 'ship v0.3.26',
        recentMessages: [],
    });
    assert.ok(brief.planProposal);
    const plan = brief.planProposal as PlanProposal;
    assert.equal(plan.source, 'checkpoint_continuation');
    assert.ok(plan.steps[0]!.description.includes('run tsc'));
}

async function testHandshakePlanProposalIsPureAndDeterministic(): Promise<void> {
    const attendant1 = makeAttendant();
    stubAttendantDeps(attendant1);
    const brief1 = await attendant1.handshake({
        task: 'implement a feature flag gate for the new route',
        recentMessages: [],
    });

    const attendant2 = makeAttendant();
    stubAttendantDeps(attendant2);
    const brief2 = await attendant2.handshake({
        task: 'implement a feature flag gate for the new route',
        recentMessages: [],
    });

    // Same input -> same plan (no randomness, no side effects, no LLM)
    assert.deepEqual(brief1.planProposal?.steps, brief2.planProposal?.steps);
    assert.equal(brief1.planProposal?.source, brief2.planProposal?.source);
    assert.equal(brief1.planProposal?.reason, brief2.planProposal?.reason);
}

async function testHandshakePlanProposalIsNeverUndefined(): Promise<void> {
    const attendant = makeAttendant();
    stubAttendantDeps(attendant);
    const brief = await attendant.handshake({
        task: '',
        recentMessages: [],
    });
    // Should always be present — may be suggested:false, never undefined.
    assert.ok(brief.planProposal !== undefined, 'planProposal should never be undefined');
    assert.ok(brief.planProposal !== null, 'planProposal should never be null');
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('running A4 plan proposal tests');

    // detectPlanSignals unit tests
    await runTest('detectPlanSignals -> ship_release', testDetectShipSignal);
    await runTest('detectPlanSignals -> implement_add', testDetectImplementSignal);
    await runTest('detectPlanSignals -> refactor_rewrite', testDetectRefactorSignal);
    await runTest('detectPlanSignals -> fix_debug', testDetectFixSignal);
    await runTest('detectPlanSignals -> audit_review', testDetectAuditSignal);
    await runTest('detectPlanSignals -> migrate', testDetectMigrateSignal);
    await runTest('detectPlanSignals -> test_author', testDetectTestSignal);
    await runTest('detectPlanSignals -> deploy', testDetectDeploySignal);
    await runTest('detectPlanSignals detects multiple signals in one task', testDetectMultipleSignals);
    await runTest('detectPlanSignals returns empty on unrelated text', testDetectNoSignals);
    await runTest('detectPlanSignals is case-insensitive', testDetectIsCaseInsensitive);
    await runTest('detectPlanSignals dedupes within one signal keyword set', testDetectDeduplicatesSignalsWithinSameKeywordSet);

    // buildPlanProposal unit tests
    await runTest('buildPlanProposal skips short task with no signals', testBuildPlanForShortTaskSkips);
    await runTest('buildPlanProposal skips long task with no signals', testBuildPlanForNoSignalsSkips);
    await runTest('buildPlanProposal produces ship template for ship task', testBuildPlanForShipProducesShipTemplate);
    await runTest('buildPlanProposal produces fix template for fix task', testBuildPlanForFixProducesFixTemplate);
    await runTest('buildPlanProposal produces implement template for implement task', testBuildPlanForImplementProducesImplementTemplate);
    await runTest('buildPlanProposal prioritizes ship_release over implement_add', testBuildPlanPrioritizesShipOverOthers);
    await runTest('buildPlanProposal prioritizes fix_debug over implement_add', testBuildPlanPrioritizesFixOverImplement);
    await runTest('buildPlanProposal can match off inferredTaskType alone', testBuildPlanWithOnlyInferredTaskType);

    // Checkpoint continuation tests
    await runTest('buildPlanProposal uses checkpoint when interrupted', testBuildPlanUsesCheckpointWhenInterrupted);
    await runTest('buildPlanProposal checkpoint without nextStep still emits plan', testBuildPlanCheckpointWithoutNextStepStillEmitsPlan);
    await runTest('buildPlanProposal ignores completed checkpoint', testBuildPlanIgnoresCompletedCheckpoint);
    await runTest('buildPlanProposal null checkpoint runs keyword heuristic', testBuildPlanNullCheckpointRunsKeywordHeuristic);
    await runTest('buildPlanProposal undefined checkpoint runs keyword heuristic', testBuildPlanUndefinedCheckpointRunsKeywordHeuristic);

    // Step structure tests
    await runTest('plan steps are sequentially numbered', testStepsAreSequentiallyNumbered);
    await runTest('all plan steps have rationale', testAllStepsHaveRationale);

    // Integration: handshake wiring
    await runTest('handshake populates planProposal for ship task', testHandshakePopulatesPlanProposalForShipTask);
    await runTest('handshake populates skipped planProposal for trivial task', testHandshakePopulatesSkippedPlanForTrivialTask);
    await runTest('handshake uses checkpoint continuation when interrupted', testHandshakeUsesCheckpointContinuationWhenInterrupted);
    await runTest('handshake planProposal is pure + deterministic across calls', testHandshakePlanProposalIsPureAndDeterministic);
    await runTest('handshake planProposal is never undefined', testHandshakePlanProposalIsNeverUndefined);

    if (process.exitCode && process.exitCode !== 0) {
        console.error('A4 plan proposal tests FAILED');
    } else {
        console.log('A4 plan proposal tests passed');
    }
}

main().catch((error) => {
    console.error('test harness crashed', error);
    process.exitCode = 1;
});
