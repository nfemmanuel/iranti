// tests/staff/run_b8_subturn_loop_tests.ts
//
// B8 — M6 (sub-turn reasoning loop) pure-helper tests.
//
// planSubTurnLoop is a pure, deterministic helper with no I/O. This file
// tests the five gates (phase, partial presence, length, budget, novelty)
// plus the token/hint extraction logic and the budget caps. Integration
// with AttendantInstance.attend() is covered by the mid-turn-attend
// regression suite, which exercises the wiring across the three return
// paths (post-response closeout, memory_not_needed, main success).
//
// Run with: npm run test:b8-subturn-loop

import assert from 'assert';

import {
    planSubTurnLoop,
    SUB_TURN_LOOP_DEFAULT_BUDGET,
    SUB_TURN_LOOP_MIN_PARTIAL_LENGTH,
    SUB_TURN_LOOP_MAX_RESCORE_TOKENS,
    SUB_TURN_LOOP_MAX_PROPOSED_HINTS,
    SUB_TURN_LOOP_MIN_TOKEN_LENGTH,
} from '../../src/staff/subTurnLoop';

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Long partial response we can reuse for length-gate tests. Deliberately
// contains a mix of novel tokens ("calibration", "throttle") and baseline
// tokens ("subturnloop") so individual tests can tune the baseline.
const NOVEL_PARTIAL =
    'The calibration pipeline throttle needs re-measurement against the baseline dataset.';

// A 3-segment entity hint in the partial response — the helper should
// harvest the 2-segment prefix for retrieval widening.
const ENTITY_PARTIAL =
    'Looking at project/iranti/feature_idea_user_rules and agent/main_agent/profile for the baseline.';

// ─── A. Phase gate tests ─────────────────────────────────────────────────────

function testPostResponsePhaseDeclines(): void {
    const plan = planSubTurnLoop({
        phase: 'post-response',
        partialResponse: NOVEL_PARTIAL,
        latestMessage: 'unrelated',
        originalEntityHints: [],
        initialFactCount: 2,
    });
    assert.equal(plan.outcome, 'declined_post_response');
    assert.equal(plan.attempted, false);
    assert.equal(plan.reason, 'post_response_closeout');
    assert.deepEqual(plan.rescoreTokens, []);
    assert.deepEqual(plan.proposedHints, []);
}

function testPreResponsePhaseDeclines(): void {
    const plan = planSubTurnLoop({
        phase: 'pre-response',
        partialResponse: NOVEL_PARTIAL,
        latestMessage: 'unrelated',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.equal(plan.outcome, 'declined_phase');
    assert.equal(plan.attempted, false);
    assert.equal(plan.reason, 'phase_not_mid_turn');
}

function testMissingPhaseDeclines(): void {
    const plan = planSubTurnLoop({
        partialResponse: NOVEL_PARTIAL,
        latestMessage: 'unrelated',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.equal(plan.outcome, 'declined_phase');
    assert.equal(plan.attempted, false);
    assert.ok(plan.note.includes('unknown'));
}

// ─── B. Partial response presence gate ───────────────────────────────────────

function testNoPartialResponseDeclines(): void {
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        latestMessage: 'unrelated',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.equal(plan.outcome, 'declined_no_partial');
    assert.equal(plan.attempted, false);
    assert.equal(plan.reason, 'no_partial_response');
}

function testEmptyPartialResponseDeclines(): void {
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: '',
        latestMessage: 'unrelated',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.equal(plan.outcome, 'declined_no_partial');
    assert.equal(plan.attempted, false);
}

function testWhitespaceOnlyPartialDeclines(): void {
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: '   \n\t  ',
        latestMessage: 'unrelated',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.equal(plan.outcome, 'declined_no_partial');
    assert.equal(plan.partialResponseLength, 0);
}

// ─── C. Length gate ──────────────────────────────────────────────────────────

function testShortPartialDeclines(): void {
    const short = 'too short';
    assert.ok(short.length < SUB_TURN_LOOP_MIN_PARTIAL_LENGTH);
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: short,
        latestMessage: 'unrelated',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.equal(plan.outcome, 'declined_too_short');
    assert.equal(plan.attempted, false);
    assert.equal(plan.reason, 'partial_response_below_min_length');
    assert.equal(plan.partialResponseLength, short.length);
}

function testAtLengthThresholdPassesLengthGate(): void {
    // Build a string that is exactly MIN_PARTIAL_LENGTH chars of novel tokens.
    const partial = 'calibration throttle measure baseline refactor'; // 46 chars
    assert.ok(partial.length >= SUB_TURN_LOOP_MIN_PARTIAL_LENGTH);
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: partial,
        latestMessage: 'unrelated',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    // length gate cleared; novelty gate should allow it through.
    assert.notEqual(plan.outcome, 'declined_too_short');
}

// ─── D. Budget gate ──────────────────────────────────────────────────────────

function testZeroBudgetDeclines(): void {
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: NOVEL_PARTIAL,
        latestMessage: 'unrelated',
        originalEntityHints: [],
        initialFactCount: 0,
        budget: 0,
    });
    assert.equal(plan.outcome, 'budget_exhausted');
    assert.equal(plan.attempted, false);
    assert.equal(plan.budgetMax, 0);
    assert.equal(plan.reason, 'budget_zero');
}

function testNegativeBudgetIsClampedToZero(): void {
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: NOVEL_PARTIAL,
        latestMessage: 'unrelated',
        originalEntityHints: [],
        initialFactCount: 0,
        budget: -5,
    });
    assert.equal(plan.outcome, 'budget_exhausted');
    assert.equal(plan.budgetMax, 0);
}

function testDefaultBudgetIsOne(): void {
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: NOVEL_PARTIAL,
        latestMessage: 'unrelated',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.equal(plan.budgetMax, SUB_TURN_LOOP_DEFAULT_BUDGET);
    assert.equal(plan.budgetMax, 1);
}

// ─── E. Novelty gate ─────────────────────────────────────────────────────────

function testNoNovelTokensDeclines(): void {
    // Partial response is entirely made of words also in latestMessage.
    const baseline = 'calibration throttle measure baseline refactor';
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: 'refactor the calibration throttle measure baseline once more',
        latestMessage: baseline,
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.equal(plan.outcome, 'declined_no_new_tokens');
    assert.equal(plan.attempted, false);
    assert.equal(plan.reason, 'all_partial_tokens_covered_by_baseline');
    assert.deepEqual(plan.rescoreTokens, []);
    assert.deepEqual(plan.proposedHints, []);
}

function testShortTokensAreFiltered(): void {
    // "the", "and", "for" etc. are stopwords; "is", "to", "of" are too short.
    // All tokens below MIN_TOKEN_LENGTH (4) are dropped.
    assert.ok(SUB_TURN_LOOP_MIN_TOKEN_LENGTH >= 4);
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: 'a b c de fg hi jk lm no pq rs tu vw xy z ab cd ef gh',
        latestMessage: '',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    // Everything gets filtered as too-short → declined_no_new_tokens.
    assert.equal(plan.outcome, 'declined_no_new_tokens');
}

function testStopwordsAreFiltered(): void {
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: 'the that this these those have will would should could because before after while',
        latestMessage: '',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.equal(plan.outcome, 'declined_no_new_tokens');
}

function testNovelTokensTriggerRetry(): void {
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: NOVEL_PARTIAL,
        latestMessage: 'baseline dataset',
        originalEntityHints: [],
        initialFactCount: 2,
    });
    assert.equal(plan.outcome, 'attempted_empty');
    assert.equal(plan.attempted, true);
    assert.equal(plan.reason, 'mid_turn_partial_response_has_novel_signal');
    assert.ok(plan.rescoreTokens.length > 0);
    // "calibration", "throttle", "measurement" should appear; "baseline" and
    // "dataset" should be filtered as already-in-baseline.
    assert.ok(plan.rescoreTokens.includes('calibration'));
    assert.ok(plan.rescoreTokens.includes('throttle'));
    assert.ok(!plan.rescoreTokens.includes('baseline'));
    assert.ok(!plan.rescoreTokens.includes('dataset'));
}

function testRescoreTokensCappedAtMax(): void {
    // Build a partial response with >MAX_RESCORE_TOKENS novel tokens.
    const novel = ['calibration', 'throttle', 'pipeline', 'refinement', 'modifier', 'assembler', 'coordinator', 'delegate'];
    const partial = novel.join(' ') + ' some extra padding text here too';
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: partial,
        latestMessage: '',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.equal(plan.attempted, true);
    assert.ok(plan.rescoreTokens.length <= SUB_TURN_LOOP_MAX_RESCORE_TOKENS);
    assert.equal(plan.rescoreTokens.length, SUB_TURN_LOOP_MAX_RESCORE_TOKENS);
}

function testRescoreTokensAreDeduped(): void {
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: 'calibration calibration calibration calibration calibration some more',
        latestMessage: '',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    const unique = new Set(plan.rescoreTokens);
    assert.equal(unique.size, plan.rescoreTokens.length);
}

// ─── F. Proposed hints (type/id extraction) ──────────────────────────────────

function testProposedHintsExtractedFromPartial(): void {
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: ENTITY_PARTIAL,
        latestMessage: '',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.equal(plan.attempted, true);
    // Both 2-segment prefixes should be harvested.
    assert.ok(plan.proposedHints.includes('project/iranti'));
    assert.ok(plan.proposedHints.includes('agent/main_agent'));
}

function testProposedHintsSkipExistingHints(): void {
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: ENTITY_PARTIAL,
        latestMessage: '',
        // Original hints already include one of the entities in the partial.
        originalEntityHints: ['project/iranti'],
        initialFactCount: 0,
    });
    assert.ok(!plan.proposedHints.includes('project/iranti'));
    assert.ok(plan.proposedHints.includes('agent/main_agent'));
}

function testProposedHintsSkipThreeSegmentPrefixOfExisting(): void {
    // The partial mentions a 3-segment entity; the existing hint is already
    // the 2-segment prefix, so the helper should not re-propose it.
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: 'see project/iranti/some_key for details and agent/main_agent for the rest.',
        latestMessage: '',
        originalEntityHints: ['project/iranti'],
        initialFactCount: 0,
    });
    assert.ok(!plan.proposedHints.includes('project/iranti'));
}

function testProposedHintsCappedAtMax(): void {
    const many = [
        'a1/b1', 'c2/d2', 'e3/f3', 'g4/h4', 'i5/j5', 'k6/l6',
    ].join(' and ') + ' something novel here too';
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: many,
        latestMessage: '',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.ok(plan.proposedHints.length <= SUB_TURN_LOOP_MAX_PROPOSED_HINTS);
}

function testShortRatiosNotExtractedAsHints(): void {
    // "2/3" and "a/b" are below the 2-char segment minimum and must not be
    // misread as entity hints.
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: 'The ratio is 2/3 and the path a/b is irrelevant calibration throttle here.',
        latestMessage: '',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.ok(!plan.proposedHints.includes('2/3'));
    assert.ok(!plan.proposedHints.includes('a/b'));
}

function testProposedHintsAloneTriggerRetry(): void {
    // A partial response that has NO novel tokens but DOES carry a novel
    // entity hint should still trigger the retry — the hint alone is
    // enough signal to widen retrieval.
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: 'calibration throttle project/iranti/new_entity baseline calibration',
        latestMessage: 'calibration throttle baseline',
        originalEntityHints: [],
        initialFactCount: 0,
    });
    assert.equal(plan.attempted, true);
    assert.ok(plan.proposedHints.includes('project/iranti'));
}

// ─── G. Entity-shaped tokens decompose into baseline ─────────────────────────

function testEntityShapedBaselineTokensSplitIntoParts(): void {
    // If the original hint is "project/iranti", the baseline should include
    // "project" and "iranti" as separate tokens so a partial that echoes
    // "iranti" does not register as novel.
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: 'iranti iranti iranti iranti iranti',
        latestMessage: '',
        originalEntityHints: ['project/iranti'],
        initialFactCount: 0,
    });
    assert.ok(!plan.rescoreTokens.includes('iranti'));
}

// ─── H. Plan shape invariants ────────────────────────────────────────────────

function testPlanShapeInvariants(): void {
    const plan = planSubTurnLoop({
        phase: 'mid-turn',
        partialResponse: NOVEL_PARTIAL,
        latestMessage: '',
        originalEntityHints: [],
        initialFactCount: 5,
    });
    // All fields must be present regardless of outcome.
    assert.equal(typeof plan.outcome, 'string');
    assert.equal(typeof plan.attempted, 'boolean');
    assert.equal(typeof plan.partialResponseLength, 'number');
    assert.equal(plan.initialFactCount, 5);
    assert.equal(typeof plan.addedFactCount, 'number');
    assert.ok(Array.isArray(plan.rescoreTokens));
    assert.ok(Array.isArray(plan.proposedHints));
    assert.equal(typeof plan.budgetMax, 'number');
    assert.equal(typeof plan.reason, 'string');
    assert.equal(typeof plan.note, 'string');
}

function testConstantsExposed(): void {
    assert.equal(SUB_TURN_LOOP_DEFAULT_BUDGET, 1);
    assert.equal(SUB_TURN_LOOP_MIN_PARTIAL_LENGTH, 40);
    assert.equal(SUB_TURN_LOOP_MAX_RESCORE_TOKENS, 5);
    assert.equal(SUB_TURN_LOOP_MAX_PROPOSED_HINTS, 3);
    assert.equal(SUB_TURN_LOOP_MIN_TOKEN_LENGTH, 4);
}

// ─── Runner ──────────────────────────────────────────────────────────────────

type TestFn = () => void | Promise<void>;

async function runTest(name: string, fn: TestFn): Promise<void> {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        console.error(`  FAIL  ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

async function main(): Promise<void> {
    console.log('running B8 sub-turn loop tests');

    // A: phase gate
    await runTest('post-response phase declines', testPostResponsePhaseDeclines);
    await runTest('pre-response phase declines', testPreResponsePhaseDeclines);
    await runTest('missing phase declines', testMissingPhaseDeclines);

    // B: partial response presence
    await runTest('no partial response declines', testNoPartialResponseDeclines);
    await runTest('empty partial response declines', testEmptyPartialResponseDeclines);
    await runTest('whitespace-only partial declines', testWhitespaceOnlyPartialDeclines);

    // C: length gate
    await runTest('short partial declines', testShortPartialDeclines);
    await runTest('at length threshold passes length gate', testAtLengthThresholdPassesLengthGate);

    // D: budget gate
    await runTest('zero budget declines', testZeroBudgetDeclines);
    await runTest('negative budget is clamped to zero', testNegativeBudgetIsClampedToZero);
    await runTest('default budget is one', testDefaultBudgetIsOne);

    // E: novelty gate and token extraction
    await runTest('no novel tokens declines', testNoNovelTokensDeclines);
    await runTest('short tokens are filtered', testShortTokensAreFiltered);
    await runTest('stopwords are filtered', testStopwordsAreFiltered);
    await runTest('novel tokens trigger retry', testNovelTokensTriggerRetry);
    await runTest('rescore tokens capped at max', testRescoreTokensCappedAtMax);
    await runTest('rescore tokens are deduped', testRescoreTokensAreDeduped);

    // F: proposed hint extraction
    await runTest('proposed hints extracted from partial', testProposedHintsExtractedFromPartial);
    await runTest('proposed hints skip existing hints', testProposedHintsSkipExistingHints);
    await runTest('proposed hints skip 3-segment prefix of existing', testProposedHintsSkipThreeSegmentPrefixOfExisting);
    await runTest('proposed hints capped at max', testProposedHintsCappedAtMax);
    await runTest('short ratios not extracted as hints', testShortRatiosNotExtractedAsHints);
    await runTest('proposed hints alone trigger retry', testProposedHintsAloneTriggerRetry);

    // G: baseline token decomposition
    await runTest('entity-shaped baseline tokens split into parts', testEntityShapedBaselineTokensSplitIntoParts);

    // H: plan shape + constants
    await runTest('plan shape invariants', testPlanShapeInvariants);
    await runTest('constants exposed', testConstantsExposed);

    if (process.exitCode !== 1) {
        console.log('B8 sub-turn loop tests passed');
    } else {
        console.log('B8 sub-turn loop tests failed');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
