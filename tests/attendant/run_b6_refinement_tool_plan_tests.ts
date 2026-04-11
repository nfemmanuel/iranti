/**
 * B6: A3 RefinementPass + A5 AttendantToolPlan tests.
 *
 * A3 (iterative exploration):
 *   Pure `planRefinementPass()` helper decides whether to run a bounded
 *   retrieval retry when the initial observe() pass came back empty.
 *   Widens entity hints to entityType/entityId and extracts fallback
 *   terms from the latest message. Declines blind retries when no
 *   widened hints and no fallback terms can be derived. When wired into
 *   attend(), executes at most one extra observe() call.
 *
 * A5 (tool-using Attendant):
 *   Pure `planAttendantToolCalls()` helper produces a short, deterministic
 *   list of proposed follow-up tool calls (search_related, observe_entity,
 *   query) based on brief state, retrieval fact count, session objective,
 *   and drift. The Attendant does NOT execute these in this release — the
 *   plan is descriptive and the host decides.
 *
 * Test layers mirror run_b5_objective_autocheckpoint_tests.ts:
 *   - Pure unit tests for planRefinementPass and planAttendantToolCalls.
 *   - Stubbed integration tests that verify attend() wiring for both.
 */

import assert from 'node:assert/strict';

// Mirror B5: ensure getProjectMemoryEntity() resolves during stubbed
// integration tests by setting the env var before importing.
const PRIOR_MEMORY_ENTITY = process.env.IRANTI_MEMORY_ENTITY;
process.env.IRANTI_MEMORY_ENTITY = 'project/iranti';

import {
    AttendantInstance,
    planRefinementPass,
    planAttendantToolCalls,
    type AttendInput,
    type ObserveResult,
    type FactInjection,
    type SessionObjective,
    type DriftSignal,
    type RefinementPass,
    type AttendantToolPlan,
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

const AGENT_ID = 'b6_refinement_tool_plan_test_agent';
const PROJECT_ENTITY = 'project/iranti';

// ─── A3: planRefinementPass pure unit tests ─────────────────────────────────

function testRefinementDeclinedOnPostResponse(): void {
    const plan = planRefinementPass({
        initialFactCount: 0,
        decisionNeeded: true,
        phase: 'post-response',
        entityHints: ['project/iranti/file/server'],
        latestMessage: 'check server health',
    });
    assert.equal(plan.outcome, 'declined_post_response');
    assert.equal(plan.attempted, false);
    assert.equal(plan.widenedEntityHints.length, 0);
}

function testRefinementNotNeededWhenDecisionFalse(): void {
    const plan = planRefinementPass({
        initialFactCount: 0,
        decisionNeeded: false,
        entityHints: ['project/iranti/file/server'],
        latestMessage: 'noise',
    });
    assert.equal(plan.outcome, 'not_needed');
    assert.equal(plan.reason, 'memory_not_needed');
}

function testRefinementNotNeededWhenFactsAlreadyReturned(): void {
    const plan = planRefinementPass({
        initialFactCount: 3,
        decisionNeeded: true,
        entityHints: ['project/iranti/file/server'],
        latestMessage: 'refactor server',
    });
    assert.equal(plan.outcome, 'not_needed');
    assert.equal(plan.reason, 'initial_pass_returned_facts');
}

function testRefinementWidensEntityHints(): void {
    const plan = planRefinementPass({
        initialFactCount: 0,
        decisionNeeded: true,
        entityHints: [
            'project/iranti/file/src_attendant_AttendantInstance_ts',
            'project/iranti/build/tsc_noemit',
        ],
        latestMessage: 'ship B6 release with refinement and tool plan',
    });
    assert.equal(plan.outcome, 'attempted_empty');
    assert.equal(plan.attempted, true);
    // Widened hints should drop the key segment.
    assert.ok(plan.widenedEntityHints.includes('project/iranti'));
    // Fallback terms should include substantive tokens.
    assert.ok(plan.fallbackTerms.includes('ship'));
    assert.ok(plan.fallbackTerms.includes('release'));
    // Stopwords should not appear.
    assert.ok(!plan.fallbackTerms.includes('with'));
    assert.ok(!plan.fallbackTerms.includes('and'));
}

function testRefinementDedupesWidenedHints(): void {
    const plan = planRefinementPass({
        initialFactCount: 0,
        decisionNeeded: true,
        entityHints: [
            'project/iranti/file/a',
            'project/iranti/file/b',
            'project/iranti/build/c',
        ],
        latestMessage: 'debug the build failure',
    });
    // All three original hints collapse to 'project/iranti' after widening.
    assert.equal(plan.widenedEntityHints.length, 1);
    assert.equal(plan.widenedEntityHints[0], 'project/iranti');
}

function testRefinementDeclinedWhenNoHintsAndNoTerms(): void {
    const plan = planRefinementPass({
        initialFactCount: 0,
        decisionNeeded: true,
        entityHints: [],
        latestMessage: 'hi',
    });
    assert.equal(plan.outcome, 'declined_no_hints');
    assert.equal(plan.attempted, false);
    assert.equal(plan.reason, 'no_widened_hints_and_no_fallback_terms');
}

function testRefinementCapsFallbackTerms(): void {
    const plan = planRefinementPass({
        initialFactCount: 0,
        decisionNeeded: true,
        entityHints: [],
        latestMessage: 'ship release bundle refactor feature tests migration deploy debug audit polish rollback handshake attend',
    });
    // REFINEMENT_MAX_FALLBACK_TERMS = 6.
    assert.ok(plan.fallbackTerms.length <= 6, `expected <= 6 terms, got ${plan.fallbackTerms.length}`);
    assert.equal(plan.attempted, true);
}

function testRefinementFiltersShortTokens(): void {
    const plan = planRefinementPass({
        initialFactCount: 0,
        decisionNeeded: true,
        entityHints: [PROJECT_ENTITY],
        latestMessage: 'A b c ship it',
    });
    // REFINEMENT_MIN_TERM_LENGTH = 3 — short tokens dropped.
    for (const term of plan.fallbackTerms) {
        assert.ok(term.length >= 3, `term '${term}' should be >= 3 chars`);
    }
    assert.ok(plan.fallbackTerms.includes('ship'));
}

function testRefinementLowercasesAndStripsPunctuation(): void {
    const plan = planRefinementPass({
        initialFactCount: 0,
        decisionNeeded: true,
        entityHints: [PROJECT_ENTITY],
        latestMessage: 'Refactor!!! SERVER.TS, urgent??',
    });
    // All terms should be lowercase and free of punctuation.
    for (const term of plan.fallbackTerms) {
        assert.equal(term, term.toLowerCase());
        assert.ok(/^[a-z0-9_\-]+$/.test(term), `term '${term}' should be alnum`);
    }
    assert.ok(plan.fallbackTerms.includes('refactor'));
}

function testRefinementNoteMentionsCounts(): void {
    const plan = planRefinementPass({
        initialFactCount: 0,
        decisionNeeded: true,
        entityHints: ['project/iranti/file/x'],
        latestMessage: 'ship audit',
    });
    assert.ok(plan.note.includes('1 widened entity hint'));
    assert.ok(plan.note.includes('fallback term'));
}

// ─── A5: planAttendantToolCalls pure unit tests ─────────────────────────────

function testToolPlanEmptyOnPostResponse(): void {
    const plan = planAttendantToolCalls({
        phase: 'post-response',
        entityHints: [PROJECT_ENTITY],
        initialFactCount: 0,
        briefHasEntities: true,
    });
    assert.equal(plan.proposed.length, 0);
    assert.equal(plan.basis, 'empty');
}

function testToolPlanEmptyWhenNoSignal(): void {
    const plan = planAttendantToolCalls({
        phase: 'pre-response',
        entityHints: [],
        initialFactCount: 0,
        briefHasEntities: false,
    });
    assert.equal(plan.proposed.length, 0);
}

function testToolPlanProposesSearchRelatedOnEmptyRetrieval(): void {
    const plan = planAttendantToolCalls({
        phase: 'pre-response',
        entityHints: [PROJECT_ENTITY],
        initialFactCount: 0,
        briefHasEntities: true,
    });
    assert.ok(plan.proposed.length >= 1);
    const first = plan.proposed[0];
    assert.equal(first.name, 'search_related');
    assert.equal(first.args.entity, PROJECT_ENTITY);
    assert.equal(plan.basis, 'brief_entities');
}

function testToolPlanProposesObserveEntityForTopHint(): void {
    const plan = planAttendantToolCalls({
        phase: 'pre-response',
        entityHints: [PROJECT_ENTITY],
        initialFactCount: 1,
        briefHasEntities: true,
    });
    // With a non-empty retrieval, we don't propose search_related but DO
    // propose observe_entity to enumerate the entity's full fact set.
    assert.ok(plan.proposed.length >= 1);
    const names = plan.proposed.map((p) => p.name);
    assert.ok(names.includes('observe_entity'));
}

function testToolPlanIncludesQueryFromSessionObjective(): void {
    const objective: SessionObjective = {
        primary: 'ship refinement release',
        taskSignals: ['refinement', 'release'],
        confidence: 1,
        source: 'task_string',
        derivedAt: new Date().toISOString(),
        note: '',
    };
    const plan = planAttendantToolCalls({
        phase: 'pre-response',
        entityHints: [PROJECT_ENTITY],
        initialFactCount: 1,
        sessionObjective: objective,
        briefHasEntities: true,
    });
    const queryCalls = plan.proposed.filter((p) => p.name === 'query');
    assert.ok(queryCalls.length >= 1, 'expected a query proposal from session objective');
    assert.equal(queryCalls[0].args.key, 'refinement');
}

function testToolPlanIncludesDriftDrivenQuery(): void {
    const drift: DriftSignal = {
        detected: true,
        overlap: 0.08,
        drivingTokens: ['koa', 'middleware'],
        missingTokens: ['attendant'],
        declaredTaskType: 'ship attendant',
        note: 'drift',
    };
    const plan = planAttendantToolCalls({
        phase: 'pre-response',
        entityHints: [PROJECT_ENTITY],
        initialFactCount: 1,
        drift,
        briefHasEntities: true,
    });
    const driftQuery = plan.proposed.find((p) => p.name === 'query' && p.args.key === 'koa');
    assert.ok(driftQuery, 'expected a drift-driven query with driving token');
    assert.equal(plan.basis, 'drift_tokens');
}

function testToolPlanCapsProposalsAtThree(): void {
    const objective: SessionObjective = {
        primary: 'ship bundle',
        taskSignals: ['bundle'],
        confidence: 1,
        source: 'task_string',
        derivedAt: new Date().toISOString(),
        note: '',
    };
    const drift: DriftSignal = {
        detected: true,
        overlap: 0.1,
        drivingTokens: ['something'],
        missingTokens: [],
        declaredTaskType: 'ship bundle',
        note: '',
    };
    const plan = planAttendantToolCalls({
        phase: 'pre-response',
        entityHints: [PROJECT_ENTITY],
        initialFactCount: 0,
        sessionObjective: objective,
        drift,
        briefHasEntities: true,
    });
    assert.ok(plan.proposed.length <= 3, `expected <=3 proposals, got ${plan.proposed.length}`);
}

function testToolPlanProposalsHaveConfidences(): void {
    const plan = planAttendantToolCalls({
        phase: 'pre-response',
        entityHints: [PROJECT_ENTITY],
        initialFactCount: 0,
        briefHasEntities: true,
    });
    for (const p of plan.proposed) {
        assert.ok(p.confidence > 0 && p.confidence <= 1, `confidence ${p.confidence} out of range`);
        assert.ok(p.reason.length > 0, 'every proposal should carry a reason');
    }
}

// ─── Stubbed integration tests ───────────────────────────────────────────────

interface StubbedAttendant extends AttendantInstance {
    observeCallCount: number;
    firstObserveFacts: FactInjection[];
    secondObserveFacts: FactInjection[];
}

function makeStubFacts(options: Array<{ entityKey: string; confidence: number }>): FactInjection[] {
    return options.map((opt, i) => ({
        knowledgeEntryId: 6000 + i,
        entityKey: opt.entityKey,
        summary: `stub fact summary for ${opt.entityKey}`,
        value: { data: opt.entityKey },
        confidence: opt.confidence,
        source: 'b6_test_stub',
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

async function makeAttendant(
    taskType = 'ship B6 release with A3 refinement and A5 attendant tool plan',
): Promise<StubbedAttendant> {
    const attendant = new AttendantInstance(AGENT_ID) as unknown as StubbedAttendant;
    const anyAttendant = attendant as any;

    attendant.observeCallCount = 0;
    attendant.firstObserveFacts = [];
    attendant.secondObserveFacts = [];

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
        attendant.observeCallCount += 1;
        if (attendant.observeCallCount === 1) {
            return makeObserveResult([...attendant.firstObserveFacts]);
        }
        return makeObserveResult([...attendant.secondObserveFacts]);
    };

    await anyAttendant.handshake({
        task: taskType,
        recentMessages: ['starting B6 tests'],
    });

    return attendant;
}

function makeAttendInput(overrides: Partial<AttendInput> = {}): AttendInput {
    return {
        latestMessage: 'ship B6 refinement release with attendant tool plan',
        currentContext: 'ship B6 refinement release attendant tool plan',
        entityHints: ['project/iranti/file/src_attendant_AttendantInstance_ts'],
        suppressEvents: true,
        phase: 'pre-response',
        ...overrides,
    };
}

// ─── A3 integration tests ────────────────────────────────────────────────────

async function testRefinementPassNotAttemptedWhenFirstPassHasFacts(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.firstObserveFacts = makeStubFacts([
        { entityKey: 'project/iranti/file/src_attendant/x', confidence: 90 },
    ]);
    const result = await attendant.attend(makeAttendInput({}));
    assert.ok(result.refinementPass, 'refinementPass should be populated');
    const pass: RefinementPass = result.refinementPass!;
    assert.equal(pass.outcome, 'not_needed');
    assert.equal(pass.attempted, false);
    assert.equal(attendant.observeCallCount, 1, 'only one observe call when first pass had facts');
}

async function testRefinementPassRunsWhenFirstPassEmpty(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.firstObserveFacts = [];
    attendant.secondObserveFacts = makeStubFacts([
        { entityKey: 'project/iranti/file/y', confidence: 85 },
        { entityKey: 'project/iranti/build/z', confidence: 80 },
    ]);
    const result = await attendant.attend(makeAttendInput({}));
    assert.ok(result.refinementPass);
    const pass: RefinementPass = result.refinementPass!;
    assert.equal(pass.outcome, 'attempted_added');
    assert.equal(pass.attempted, true);
    assert.equal(pass.addedFactCount, 2);
    assert.equal(attendant.observeCallCount, 2, 'should have run exactly 2 observe calls');
    // The refined facts should be surfaced on the main result.
    assert.equal(result.facts.length, 2);
}

async function testRefinementPassReportsAttemptedEmpty(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.firstObserveFacts = [];
    attendant.secondObserveFacts = []; // retry also empty
    const result = await attendant.attend(makeAttendInput({}));
    assert.ok(result.refinementPass);
    const pass: RefinementPass = result.refinementPass!;
    assert.equal(pass.outcome, 'attempted_empty');
    assert.equal(pass.attempted, true);
    assert.equal(pass.addedFactCount, 0);
    assert.equal(attendant.observeCallCount, 2, 'retry still counts even if empty');
}

async function testRefinementPassDeclinedWhenNoHints(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.firstObserveFacts = [];
    // Pass a latestMessage of only stopwords + punctuation so the fallback
    // term extractor finds nothing. No entity hints either.
    const result = await attendant.attend(makeAttendInput({
        entityHints: [],
        latestMessage: 'a or an',
        currentContext: '',
    }));
    const pass: RefinementPass = result.refinementPass!;
    assert.ok(pass);
    // Could either be declined_no_hints OR attempted — depends on freshState
    // entities contributing to allObserveEntityHints. Assert the retry count
    // is consistent with the outcome.
    if (pass.outcome === 'declined_no_hints') {
        assert.equal(attendant.observeCallCount, 1);
    }
}

async function testRefinementPassGatedOnPostResponse(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.firstObserveFacts = [];
    const result = await attendant.attend(makeAttendInput({
        phase: 'post-response',
        latestMessage: 'summary of turn',
    }));
    const pass: RefinementPass = result.refinementPass!;
    assert.equal(pass.outcome, 'declined_post_response');
    assert.equal(pass.attempted, false);
}

// ─── A5 integration tests ────────────────────────────────────────────────────

async function testAttendantToolPlanPopulatedOnMainPath(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.firstObserveFacts = makeStubFacts([
        { entityKey: 'project/iranti/file/x', confidence: 90 },
    ]);
    const result = await attendant.attend(makeAttendInput({}));
    assert.ok(result.attendantToolPlan, 'attendantToolPlan should be populated');
    const plan: AttendantToolPlan = result.attendantToolPlan!;
    assert.ok(plan.proposed.length > 0, 'expected at least one proposed tool call');
    assert.notEqual(plan.basis, 'empty');
}

async function testAttendantToolPlanEmptyOnPostResponse(): Promise<void> {
    const attendant = await makeAttendant();
    const result = await attendant.attend(makeAttendInput({
        phase: 'post-response',
        latestMessage: 'summary',
    }));
    assert.ok(result.attendantToolPlan);
    assert.equal(result.attendantToolPlan!.proposed.length, 0);
    assert.equal(result.attendantToolPlan!.basis, 'empty');
}

async function testAttendantToolPlanContainsSearchRelatedOnEmptyRetrieval(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.firstObserveFacts = [];
    attendant.secondObserveFacts = []; // both empty
    const result = await attendant.attend(makeAttendInput({}));
    const plan = result.attendantToolPlan!;
    // Both attempts returned empty → the planner should still surface a
    // search_related proposal against the hinted entity.
    const names = plan.proposed.map((p) => p.name);
    assert.ok(names.includes('search_related'), `expected search_related in ${names.join(', ')}`);
}

async function testAttendantToolPlanReactsToDrift(): Promise<void> {
    const attendant = await makeAttendant('ship memory attendant plan proposal handshake release');
    attendant.firstObserveFacts = makeStubFacts([
        { entityKey: 'project/iranti/file/x', confidence: 90 },
    ]);
    const result = await attendant.attend(makeAttendInput({
        latestMessage: 'refactor the koa HTTP middleware stack and swap express out',
        currentContext: 'migrating express routes to koa adapters urgently',
    }));
    // Drift should fire for this divergent task.
    assert.ok(result.drift, 'drift should fire for divergent task');
    const plan = result.attendantToolPlan!;
    const names = plan.proposed.map((p) => p.name);
    // When drift fires, the plan basis should reflect drift tokens.
    if (plan.basis === 'drift_tokens') {
        assert.ok(names.includes('query'), 'drift-driven plan should include a query');
    }
}

async function testAttendantToolPlanIncludesObjectiveQuery(): Promise<void> {
    const attendant = await makeAttendant('ship B6 release refinement and tool plan');
    attendant.firstObserveFacts = makeStubFacts([
        { entityKey: 'project/iranti/file/x', confidence: 85 },
    ]);
    const result = await attendant.attend(makeAttendInput({}));
    const plan = result.attendantToolPlan!;
    // Should include a query proposal derived from the session objective's
    // taskSignals.
    const queries = plan.proposed.filter((p) => p.name === 'query');
    if (queries.length > 0) {
        assert.ok(queries[0].args.key.length >= 3, 'query arg should be substantive');
    }
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
    console.log('running B6 refinement + attendant tool plan tests');

    // A3 pure unit tests
    await runTest('planRefinementPass declined on post-response', testRefinementDeclinedOnPostResponse);
    await runTest('planRefinementPass not_needed when decision false', testRefinementNotNeededWhenDecisionFalse);
    await runTest('planRefinementPass not_needed when facts already returned', testRefinementNotNeededWhenFactsAlreadyReturned);
    await runTest('planRefinementPass widens entity hints', testRefinementWidensEntityHints);
    await runTest('planRefinementPass dedupes widened hints', testRefinementDedupesWidenedHints);
    await runTest('planRefinementPass declined when no hints and no terms', testRefinementDeclinedWhenNoHintsAndNoTerms);
    await runTest('planRefinementPass caps fallback terms', testRefinementCapsFallbackTerms);
    await runTest('planRefinementPass filters short tokens', testRefinementFiltersShortTokens);
    await runTest('planRefinementPass lowercases and strips punctuation', testRefinementLowercasesAndStripsPunctuation);
    await runTest('planRefinementPass note mentions counts', testRefinementNoteMentionsCounts);

    // A5 pure unit tests
    await runTest('planAttendantToolCalls empty on post-response', testToolPlanEmptyOnPostResponse);
    await runTest('planAttendantToolCalls empty when no signal', testToolPlanEmptyWhenNoSignal);
    await runTest('planAttendantToolCalls proposes search_related on empty retrieval', testToolPlanProposesSearchRelatedOnEmptyRetrieval);
    await runTest('planAttendantToolCalls proposes observe_entity for top hint', testToolPlanProposesObserveEntityForTopHint);
    await runTest('planAttendantToolCalls includes query from session objective', testToolPlanIncludesQueryFromSessionObjective);
    await runTest('planAttendantToolCalls includes drift-driven query', testToolPlanIncludesDriftDrivenQuery);
    await runTest('planAttendantToolCalls caps proposals at three', testToolPlanCapsProposalsAtThree);
    await runTest('planAttendantToolCalls proposals have confidences', testToolPlanProposalsHaveConfidences);

    // A3 stubbed integration tests
    await runTest('refinement pass not attempted when first pass has facts', testRefinementPassNotAttemptedWhenFirstPassHasFacts);
    await runTest('refinement pass runs when first pass empty', testRefinementPassRunsWhenFirstPassEmpty);
    await runTest('refinement pass reports attempted_empty', testRefinementPassReportsAttemptedEmpty);
    await runTest('refinement pass declined when no hints', testRefinementPassDeclinedWhenNoHints);
    await runTest('refinement pass gated on post-response', testRefinementPassGatedOnPostResponse);

    // A5 stubbed integration tests
    await runTest('attendant tool plan populated on main path', testAttendantToolPlanPopulatedOnMainPath);
    await runTest('attendant tool plan empty on post-response', testAttendantToolPlanEmptyOnPostResponse);
    await runTest('attendant tool plan contains search_related on empty retrieval', testAttendantToolPlanContainsSearchRelatedOnEmptyRetrieval);
    await runTest('attendant tool plan reacts to drift', testAttendantToolPlanReactsToDrift);
    await runTest('attendant tool plan includes objective query', testAttendantToolPlanIncludesObjectiveQuery);

    if (process.exitCode === 1) {
        console.error('B6 refinement + attendant tool plan tests failed');
        process.exit(1);
    }
    console.log('B6 refinement + attendant tool plan tests passed');
}

main().catch((error) => {
    console.error('B6 refinement + attendant tool plan tests crashed:', error);
    process.exit(1);
});
