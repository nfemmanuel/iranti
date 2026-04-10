/**
 * A1: mid-turn attend behavior tests.
 *
 * Mid-turn attends must differ from pre-response attends in three ways:
 *   1. Facts already injected earlier in the same turn are dedup-filtered out.
 *   2. The default fact budget is smaller (MID_TURN_DEFAULT_MAX_FACTS = 3).
 *   3. User-operating-rule matching is NOT rerun mid-turn (it already fired at
 *      pre-response; rerunning wastes an LLM call and duplicates context).
 *
 * Runs entirely in-process with the AttendantInstance stubbed at its DB/LLM
 * boundaries. No DB required.
 */

import assert from 'node:assert/strict';
import { AttendantInstance, type AttendInput, type ObserveResult, type FactInjection } from '../../src/attendant/AttendantInstance';
import { bootstrapHarness } from '../../scripts/harness';

bootstrapHarness({ requireDb: false });

type TestFn = () => Promise<void>;

const AGENT_ID = 'a1_mid_turn_test_agent';
const ENTITY = 'project/a1_test_project';

interface StubbedAttendant extends AttendantInstance {
    observeCallCount: number;
    observeCallLog: Array<{ maxFacts: number | undefined; entityHints: string[] }>;
    ruleLoadCount: number;
    nextObserveFacts: FactInjection[];
}

function makeStubFacts(entityKeys: string[]): FactInjection[] {
    return entityKeys.map((key, i) => ({
        knowledgeEntryId: 1000 + i,
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
        entitiesDetected: [ENTITY],
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
    attendant.ruleLoadCount = 0;
    attendant.nextObserveFacts = [];

    anyAttendant.loadPersistedState = async () => null;
    anyAttendant.loadOperatingRules = async () => 'test operating rules';
    anyAttendant.inferTask = async () => 'A1 mid-turn attend testing';
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

    // Memory always needed — we are testing the POST-decision pipeline.
    anyAttendant.decideMemoryNeed = async () => ({
        needed: true,
        confidence: 1,
        method: 'forced',
        explanation: 'test_forced_need',
    });

    anyAttendant.loadMatchingUserRules = async () => {
        attendant.ruleLoadCount++;
        return [];
    };

    anyAttendant.observe = async (input: { maxFacts?: number; entityHints?: string[] }) => {
        attendant.observeCallCount++;
        attendant.observeCallLog.push({
            maxFacts: input.maxFacts,
            entityHints: input.entityHints ?? [],
        });
        return makeObserveResult([...attendant.nextObserveFacts]);
    };

    await anyAttendant.handshake({
        task: 'A1 mid-turn attend testing',
        recentMessages: ['starting A1 tests'],
    });

    return attendant;
}

function makeAttendInput(phase: AttendInput['phase'], overrides: Partial<AttendInput> = {}): AttendInput {
    return {
        latestMessage: 'test message',
        currentContext: 'test context',
        entityHints: [ENTITY],
        suppressEvents: true,
        phase,
        ...overrides,
    };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

async function testMidTurnFiltersFactsAlreadyInjectedThisTurn(): Promise<void> {
    const attendant = await makeAttendant();

    // Pre-response surfaces F1 and F2.
    attendant.nextObserveFacts = makeStubFacts([
        `${ENTITY}/fact_alpha`,
        `${ENTITY}/fact_beta`,
    ]);
    const pre = await attendant.attend(makeAttendInput('pre-response'));
    assert.equal(pre.facts.length, 2, 'pre-response should surface both facts');
    assert.equal(pre.reason, 'memory_needed_injected');

    // Mid-turn: observe returns F1, F2, AND F3 — we only want F3 to survive dedup.
    attendant.nextObserveFacts = makeStubFacts([
        `${ENTITY}/fact_alpha`,
        `${ENTITY}/fact_beta`,
        `${ENTITY}/fact_gamma`,
    ]);
    const mid = await attendant.attend(makeAttendInput('mid-turn'));

    assert.equal(mid.facts.length, 1, `mid-turn should dedup to 1 new fact, got ${mid.facts.length}`);
    assert.equal(mid.facts[0].entityKey, `${ENTITY}/fact_gamma`, 'surviving fact should be the new one');
    assert.equal(mid.reason, 'memory_needed_injected');
    assert.deepEqual(
        mid.debug?.midTurnFilteredKeys?.slice().sort(),
        [`${ENTITY}/fact_alpha`, `${ENTITY}/fact_beta`].sort(),
        'midTurnFilteredKeys should list the deduped keys',
    );
}

async function testMidTurnWithAllFactsAlreadyInjectedReturnsAlreadyInContext(): Promise<void> {
    const attendant = await makeAttendant();

    attendant.nextObserveFacts = makeStubFacts([
        `${ENTITY}/fact_a`,
        `${ENTITY}/fact_b`,
    ]);
    await attendant.attend(makeAttendInput('pre-response'));

    // Mid-turn: observe returns only the facts already injected.
    attendant.nextObserveFacts = makeStubFacts([
        `${ENTITY}/fact_a`,
        `${ENTITY}/fact_b`,
    ]);
    const mid = await attendant.attend(makeAttendInput('mid-turn'));

    assert.equal(mid.facts.length, 0, 'mid-turn should dedup to zero when all facts repeat');
    assert.equal(
        mid.reason,
        'memory_needed_but_in_context',
        'all-dedup mid-turn should report already_in_context',
    );
    assert.equal(mid.shouldInject, false);
    assert.equal(mid.debug?.midTurnFilteredKeys?.length, 2);
}

async function testMidTurnWithNoPriorAttendDoesNotDedup(): Promise<void> {
    const attendant = await makeAttendant();

    // Directly call mid-turn with no pre-response first.
    attendant.nextObserveFacts = makeStubFacts([
        `${ENTITY}/fact_x`,
        `${ENTITY}/fact_y`,
    ]);
    const mid = await attendant.attend(makeAttendInput('mid-turn'));

    assert.equal(mid.facts.length, 2, 'mid-turn with empty pending attributions should not drop anything');
    assert.ok(
        !mid.debug?.midTurnFilteredKeys || mid.debug.midTurnFilteredKeys.length === 0,
        'midTurnFilteredKeys should be absent or empty when nothing was deduped',
    );
}

async function testMidTurnDefaultsToSmallerFactBudget(): Promise<void> {
    const attendant = await makeAttendant();

    attendant.nextObserveFacts = [];
    await attendant.attend(makeAttendInput('mid-turn'));

    const lastCall = attendant.observeCallLog[attendant.observeCallLog.length - 1];
    assert.equal(
        lastCall.maxFacts,
        3,
        `mid-turn without explicit maxFacts should pass 3 to observe, got ${lastCall.maxFacts}`,
    );
}

async function testPreResponseDoesNotUseMidTurnDefault(): Promise<void> {
    const attendant = await makeAttendant();

    attendant.nextObserveFacts = [];
    await attendant.attend(makeAttendInput('pre-response'));

    const lastCall = attendant.observeCallLog[attendant.observeCallLog.length - 1];
    assert.equal(
        lastCall.maxFacts,
        undefined,
        `pre-response should leave maxFacts undefined (observe defaults to 5), got ${lastCall.maxFacts}`,
    );
}

async function testMidTurnRespectsExplicitMaxFacts(): Promise<void> {
    const attendant = await makeAttendant();

    attendant.nextObserveFacts = [];
    await attendant.attend(makeAttendInput('mid-turn', { maxFacts: 7 }));

    const lastCall = attendant.observeCallLog[attendant.observeCallLog.length - 1];
    assert.equal(
        lastCall.maxFacts,
        7,
        `mid-turn with explicit maxFacts=7 should forward 7 to observe, got ${lastCall.maxFacts}`,
    );
}

async function testMidTurnSkipsUserRuleReload(): Promise<void> {
    const attendant = await makeAttendant();

    attendant.nextObserveFacts = [];
    await attendant.attend(makeAttendInput('pre-response'));
    const ruleLoadsAfterPre = attendant.ruleLoadCount;
    assert.equal(ruleLoadsAfterPre, 1, 'pre-response should load user rules once');

    await attendant.attend(makeAttendInput('mid-turn'));
    assert.equal(
        attendant.ruleLoadCount,
        ruleLoadsAfterPre,
        'mid-turn must NOT re-load user rules (already surfaced at pre-response)',
    );

    await attendant.attend(makeAttendInput('mid-turn'));
    assert.equal(
        attendant.ruleLoadCount,
        ruleLoadsAfterPre,
        'subsequent mid-turn attends must also skip rule loading',
    );

    // A fresh pre-response (next turn) should reload rules.
    await attendant.attend(makeAttendInput('post-response'));
    await attendant.attend(makeAttendInput('pre-response'));
    assert.equal(
        attendant.ruleLoadCount,
        ruleLoadsAfterPre + 1,
        'the next turn pre-response should reload rules',
    );
}

async function testPostResponseResetsDedupTurnSet(): Promise<void> {
    const attendant = await makeAttendant();

    // Turn 1: pre-response injects F_a, F_b
    attendant.nextObserveFacts = makeStubFacts([
        `${ENTITY}/fact_a`,
        `${ENTITY}/fact_b`,
    ]);
    await attendant.attend(makeAttendInput('pre-response'));

    // Close the turn
    await attendant.attend(makeAttendInput('post-response'));

    // Turn 2: a fresh pre-response re-injects F_a, F_b without dedup
    attendant.nextObserveFacts = makeStubFacts([
        `${ENTITY}/fact_a`,
        `${ENTITY}/fact_b`,
    ]);
    const pre2 = await attendant.attend(makeAttendInput('pre-response'));
    assert.equal(pre2.facts.length, 2, 'turn 2 pre-response should re-inject — the dedup set is per-turn');

    // Turn 2 mid-turn should dedup against the turn-2 injection only.
    attendant.nextObserveFacts = makeStubFacts([
        `${ENTITY}/fact_a`,
        `${ENTITY}/fact_c`,
    ]);
    const mid2 = await attendant.attend(makeAttendInput('mid-turn'));
    assert.equal(mid2.facts.length, 1, 'turn 2 mid-turn should dedup against turn 2 pre-response');
    assert.equal(mid2.facts[0].entityKey, `${ENTITY}/fact_c`);
}

async function testMultipleMidTurnAttendsAccumulateDedupSet(): Promise<void> {
    const attendant = await makeAttendant();

    // Pre-response injects alpha
    attendant.nextObserveFacts = makeStubFacts([`${ENTITY}/fact_alpha`]);
    await attendant.attend(makeAttendInput('pre-response'));

    // Mid-turn #1 injects beta (new)
    attendant.nextObserveFacts = makeStubFacts([
        `${ENTITY}/fact_alpha`, // deduped
        `${ENTITY}/fact_beta`,  // new
    ]);
    const mid1 = await attendant.attend(makeAttendInput('mid-turn'));
    assert.equal(mid1.facts.length, 1);
    assert.equal(mid1.facts[0].entityKey, `${ENTITY}/fact_beta`);

    // Mid-turn #2 should now dedup BOTH alpha and beta (accumulated across attends)
    attendant.nextObserveFacts = makeStubFacts([
        `${ENTITY}/fact_alpha`, // deduped
        `${ENTITY}/fact_beta`,  // deduped by mid-turn #1
        `${ENTITY}/fact_gamma`, // new
    ]);
    const mid2 = await attendant.attend(makeAttendInput('mid-turn'));
    assert.equal(mid2.facts.length, 1, 'mid-turn #2 should dedup alpha AND beta');
    assert.equal(mid2.facts[0].entityKey, `${ENTITY}/fact_gamma`);
    assert.deepEqual(
        mid2.debug?.midTurnFilteredKeys?.slice().sort(),
        [`${ENTITY}/fact_alpha`, `${ENTITY}/fact_beta`].sort(),
    );
}

// ─── Runner ────────────────────────────────────────────────────────────────

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
    console.log('running A1 mid-turn attend tests');
    await runTest('mid-turn filters facts already injected this turn', testMidTurnFiltersFactsAlreadyInjectedThisTurn);
    await runTest('mid-turn with all facts already injected returns already_in_context', testMidTurnWithAllFactsAlreadyInjectedReturnsAlreadyInContext);
    await runTest('mid-turn with no prior attend does not dedup', testMidTurnWithNoPriorAttendDoesNotDedup);
    await runTest('mid-turn defaults to MID_TURN_DEFAULT_MAX_FACTS=3', testMidTurnDefaultsToSmallerFactBudget);
    await runTest('pre-response does not use mid-turn default budget', testPreResponseDoesNotUseMidTurnDefault);
    await runTest('mid-turn respects explicit maxFacts override', testMidTurnRespectsExplicitMaxFacts);
    await runTest('mid-turn skips user rule reload', testMidTurnSkipsUserRuleReload);
    await runTest('post-response resets the mid-turn dedup set', testPostResponseResetsDedupTurnSet);
    await runTest('multiple mid-turn attends accumulate the dedup set', testMultipleMidTurnAttendsAccumulateDedupSet);

    if (process.exitCode === 1) {
        console.error('A1 mid-turn attend tests failed');
        process.exit(1);
    }
    console.log('A1 mid-turn attend tests passed');
}

main().catch((error) => {
    console.error('A1 mid-turn attend tests crashed:', error);
    process.exit(1);
});
