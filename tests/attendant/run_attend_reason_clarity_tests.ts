/**
 * Unit tests for attend reason clarity: the new reason values
 * and memorySearchPerformed/memoryResultsConsidered fields.
 *
 * In-memory — no DB required. Tests the reason assignment logic.
 */

import assert from 'node:assert/strict';

// Replicate the attend reason assignment logic for isolated unit testing

type AttendReason =
    | 'forced'
    | 'memory_not_needed'
    | 'memory_needed_no_facts'
    | 'memory_checked_no_match'
    | 'memory_needed_but_in_context'
    | 'memory_needed_injected';

function computeAttendReason(input: {
    structuredFactsCount: number;
    totalFound: number;
    alreadyPresent: number;
    forceInject: boolean;
}): { reason: AttendReason; shouldInject: boolean; memorySearchPerformed: boolean; memoryResultsConsidered: number } {
    const shouldInject = input.structuredFactsCount > 0;
    const memorySearchPerformed = true;
    const memoryResultsConsidered = input.totalFound;

    let reason: AttendReason = 'memory_needed_injected';

    if (!shouldInject) {
        const allAlreadyInContext = input.totalFound > 0 && input.alreadyPresent >= input.totalFound;
        reason = allAlreadyInContext ? 'memory_needed_but_in_context' : 'memory_checked_no_match';
    } else if (input.forceInject) {
        reason = 'forced';
    }

    return { reason, shouldInject, memorySearchPerformed, memoryResultsConsidered };
}

// ─── Test Scenarios ─────────────────────────────────────────────────────────

function testA_emptyMemoryGivesCheckedNoMatch() {
    const result = computeAttendReason({
        structuredFactsCount: 0,
        totalFound: 0,
        alreadyPresent: 0,
        forceInject: false,
    });

    assert.equal(result.reason, 'memory_checked_no_match', 'Scenario A: empty memory → memory_checked_no_match');
    assert.equal(result.shouldInject, false, 'Scenario A: shouldInject is false');
    assert.equal(result.memorySearchPerformed, true, 'Scenario A: memorySearchPerformed is true');
    assert.equal(result.memoryResultsConsidered, 0, 'Scenario A: memoryResultsConsidered is 0');
    console.log('  ✓ Scenario A: empty memory → memory_checked_no_match');
}

function testB_allInContextGivesButInContext() {
    const result = computeAttendReason({
        structuredFactsCount: 0,
        totalFound: 3,
        alreadyPresent: 3,
        forceInject: false,
    });

    assert.equal(result.reason, 'memory_needed_but_in_context', 'Scenario B: all in context');
    assert.equal(result.shouldInject, false, 'Scenario B: shouldInject is false');
    assert.equal(result.memoryResultsConsidered, 3, 'Scenario B: memoryResultsConsidered is 3');
    console.log('  ✓ Scenario B: facts all in context → memory_needed_but_in_context');
}

function testC_injectableFactsGivesInjected() {
    const result = computeAttendReason({
        structuredFactsCount: 2,
        totalFound: 3,
        alreadyPresent: 1,
        forceInject: false,
    });

    assert.equal(result.reason, 'memory_needed_injected', 'Scenario C: injectable facts');
    assert.equal(result.shouldInject, true, 'Scenario C: shouldInject is true');
    assert.equal(result.memoryResultsConsidered, 3, 'Scenario C: memoryResultsConsidered is 3');
    console.log('  ✓ Scenario C: injectable facts → memory_needed_injected');
}

function testD_forceInjectGivesForced() {
    const result = computeAttendReason({
        structuredFactsCount: 2,
        totalFound: 2,
        alreadyPresent: 0,
        forceInject: true,
    });

    assert.equal(result.reason, 'forced', 'Scenario D: force inject');
    assert.equal(result.shouldInject, true, 'Scenario D: shouldInject is true');
    console.log('  ✓ Scenario D: forceInject → forced');
}

function testE_partialMatchStillCheckedNoMatch() {
    // Some facts found but all filtered out (not in context but removed by other filters)
    const result = computeAttendReason({
        structuredFactsCount: 0,
        totalFound: 2,
        alreadyPresent: 1,
        forceInject: false,
    });

    // totalFound=2, alreadyPresent=1 → not all in context, but structuredFacts=0
    // This means facts were found but none survived after filtering
    assert.equal(result.reason, 'memory_checked_no_match', 'Scenario E: partial match but all filtered');
    assert.equal(result.memoryResultsConsidered, 2, 'Scenario E: memoryResultsConsidered shows original count');
    console.log('  ✓ Scenario E: partial match filtered out → memory_checked_no_match');
}

function testF_reasonDoesNotUseDeprecated() {
    // Verify the new reason is used instead of the deprecated one
    const result = computeAttendReason({
        structuredFactsCount: 0,
        totalFound: 0,
        alreadyPresent: 0,
        forceInject: false,
    });

    assert.notEqual(result.reason, 'memory_needed_no_facts', 'Scenario F: should NOT use deprecated reason');
    assert.equal(result.reason, 'memory_checked_no_match', 'Scenario F: should use new reason');
    console.log('  ✓ Scenario F: uses memory_checked_no_match, not deprecated memory_needed_no_facts');
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log('Running attend reason clarity tests...');

testA_emptyMemoryGivesCheckedNoMatch();
testB_allInContextGivesButInContext();
testC_injectableFactsGivesInjected();
testD_forceInjectGivesForced();
testE_partialMatchStillCheckedNoMatch();
testF_reasonDoesNotUseDeprecated();

console.log('\nAll attend reason clarity tests passed.');
process.exit(0);
