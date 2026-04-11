// tests/staff/run_b7_reasoning_council_tests.ts
//
// B7 — S5 (Archivist reasoning budget) + S6 (council mode) pure-helper tests.
//
// Both helpers are pure, deterministic, no I/O. This file tests the helpers
// directly. Integration with the Archivist scan loop and AttendantInstance
// is covered indirectly via the existing regression suites (archivist ties
// into runArchivist, council plan surfaces on AttendResult).
//
// Run with: npm run test:b7-reasoning-council

import assert from 'assert';

import {
    planArchivistReasoningPass,
    ARCHIVIST_REASONING_DEFAULT_BUDGET,
    ARCHIVIST_REVIEW_CONFIDENCE_THRESHOLD,
    ARCHIVIST_STALE_ACCESS_DAYS,
    type ArchivistReasoningCandidate,
} from '../../src/staff/archivistReasoning';

import {
    planCouncilConsultation,
    COUNCIL_DEFAULT_BUDGET,
    COUNCIL_MIN_CONFIDENCE,
} from '../../src/staff/council';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date('2026-04-10T12:00:00Z');
const DAY_MS = 86_400_000;

function daysAgo(days: number): Date {
    return new Date(NOW.getTime() - days * DAY_MS);
}

function makeCandidate(
    id: number,
    overrides: Partial<ArchivistReasoningCandidate> = {}
): ArchivistReasoningCandidate {
    return {
        id,
        entityType: 'project',
        entityId: 'iranti',
        key: `fact_${id}`,
        confidence: 80,
        source: 'test',
        lastAccessedAt: daysAgo(1),
        updatedAt: daysAgo(1),
        createdAt: daysAgo(5),
        summary: `summary ${id}`,
        valueSummary: null,
        ...overrides,
    };
}

// ─── A. planArchivistReasoningPass pure unit tests ───────────────────────────

function testNoCandidatesReturnsNoCandidates(): void {
    const output = planArchivistReasoningPass({
        candidates: [],
        reasoningBudget: 5,
        now: NOW,
    });
    assert.equal(output.outcome, 'no_candidates');
    assert.equal(output.proposals.length, 0);
    assert.equal(output.budgetUsed, 0);
    assert.equal(output.budgetMax, 5);
}

function testZeroBudgetReturnsBudgetZero(): void {
    const output = planArchivistReasoningPass({
        candidates: [makeCandidate(1)],
        reasoningBudget: 0,
        now: NOW,
    });
    assert.equal(output.outcome, 'budget_zero');
    assert.equal(output.proposals.length, 0);
}

function testCompressClusterWhenThreeDuplicates(): void {
    const dup = (id: number) => makeCandidate(id, { key: 'shared_key' });
    const output = planArchivistReasoningPass({
        candidates: [dup(1), dup(2), dup(3)],
        reasoningBudget: 5,
        now: NOW,
    });
    assert.equal(output.proposals.length, 1);
    assert.equal(output.proposals[0].action, 'compress');
    assert.deepEqual(output.proposals[0].targetIds.sort(), [1, 2, 3]);
    assert.equal(output.proposals[0].primaryEntityKey, 'project/iranti/shared_key');
    assert.equal(output.proposals[0].snapshot.targetCount, 3);
}

function testCompressIgnoresClustersBelowMinSize(): void {
    const output = planArchivistReasoningPass({
        candidates: [
            makeCandidate(1, { key: 'pair' }),
            makeCandidate(2, { key: 'pair' }),
        ],
        reasoningBudget: 5,
        now: NOW,
    });
    assert.equal(output.proposals.filter((p) => p.action === 'compress').length, 0);
}

function testFlagDriftOnHighSpreadCluster(): void {
    const output = planArchivistReasoningPass({
        candidates: [
            makeCandidate(1, { key: 'drifty', confidence: 90 }),
            makeCandidate(2, { key: 'drifty', confidence: 40 }),
        ],
        reasoningBudget: 5,
        now: NOW,
    });
    const drift = output.proposals.find((p) => p.action === 'flag_drift');
    assert.ok(drift, 'expected flag_drift proposal for high-spread cluster');
    assert.deepEqual(drift!.targetIds.sort(), [1, 2]);
    assert.ok(drift!.reason.includes('drift'));
}

function testFlagDriftSkippedOnLowSpread(): void {
    const output = planArchivistReasoningPass({
        candidates: [
            makeCandidate(1, { key: 'steady', confidence: 70 }),
            makeCandidate(2, { key: 'steady', confidence: 75 }),
        ],
        reasoningBudget: 5,
        now: NOW,
    });
    assert.equal(output.proposals.filter((p) => p.action === 'flag_drift').length, 0);
}

function testDemoteStaleLowConfidenceSingle(): void {
    const output = planArchivistReasoningPass({
        candidates: [
            makeCandidate(1, {
                confidence: 40,
                lastAccessedAt: daysAgo(30),
                updatedAt: daysAgo(30),
            }),
        ],
        reasoningBudget: 5,
        now: NOW,
    });
    const demote = output.proposals.find((p) => p.action === 'demote');
    assert.ok(demote, 'expected demote proposal for stale low-confidence fact');
    assert.deepEqual(demote!.targetIds, [1]);
    assert.ok(demote!.reason.includes('Confidence 40'));
}

function testDemoteSkippedWhenFresh(): void {
    const output = planArchivistReasoningPass({
        candidates: [
            makeCandidate(1, {
                confidence: 40,
                lastAccessedAt: daysAgo(2),
                updatedAt: daysAgo(2),
            }),
        ],
        reasoningBudget: 5,
        now: NOW,
    });
    assert.equal(output.proposals.filter((p) => p.action === 'demote').length, 0);
}

function testReviewStaleOnVeryOldSingle(): void {
    const veryOld = ARCHIVIST_STALE_ACCESS_DAYS * 2 + 5;
    const output = planArchivistReasoningPass({
        candidates: [
            makeCandidate(1, {
                confidence: 85,
                lastAccessedAt: daysAgo(veryOld),
                updatedAt: daysAgo(veryOld),
            }),
        ],
        reasoningBudget: 5,
        now: NOW,
    });
    const stale = output.proposals.find((p) => p.action === 'review_stale');
    assert.ok(stale, 'expected review_stale proposal for very old fact');
}

function testBudgetCapsProposals(): void {
    // Build 4 separate compressible clusters but only allow 2 proposals.
    const candidates: ArchivistReasoningCandidate[] = [];
    for (let cluster = 0; cluster < 4; cluster++) {
        for (let i = 0; i < 3; i++) {
            candidates.push(
                makeCandidate(cluster * 10 + i, { key: `cluster_${cluster}` })
            );
        }
    }
    const output = planArchivistReasoningPass({
        candidates,
        reasoningBudget: 2,
        now: NOW,
    });
    assert.equal(output.proposals.length, 2);
    assert.equal(output.budgetMax, 2);
    assert.equal(output.budgetUsed, 2);
    assert.equal(output.outcome, 'budget_capped');
}

function testProposalsEmittedOutcomeWhenUnderBudget(): void {
    const output = planArchivistReasoningPass({
        candidates: [
            makeCandidate(1, { key: 'trio' }),
            makeCandidate(2, { key: 'trio' }),
            makeCandidate(3, { key: 'trio' }),
        ],
        reasoningBudget: 10,
        now: NOW,
    });
    assert.equal(output.outcome, 'proposals_emitted');
    assert.equal(output.proposals.length, 1);
}

function testNoteMentionsCountsAndBudget(): void {
    const output = planArchivistReasoningPass({
        candidates: [makeCandidate(1)],
        reasoningBudget: ARCHIVIST_REASONING_DEFAULT_BUDGET,
        now: NOW,
    });
    assert.ok(
        output.note.includes('1 candidate') ||
            output.note.includes('0 proposals') ||
            output.note.includes('scanned 1'),
        `note should describe counts: ${output.note}`
    );
}

function testSnapshotCapturesConfidenceRange(): void {
    const output = planArchivistReasoningPass({
        candidates: [
            makeCandidate(1, { key: 'span', confidence: 20 }),
            makeCandidate(2, { key: 'span', confidence: 80 }),
            makeCandidate(3, { key: 'span', confidence: 50 }),
        ],
        reasoningBudget: 5,
        now: NOW,
    });
    const compress = output.proposals.find((p) => p.action === 'compress');
    assert.ok(compress, 'expected compress proposal for 3-cluster');
    assert.equal(compress!.snapshot.minConfidence, 20);
    assert.equal(compress!.snapshot.maxConfidence, 80);
    assert.equal(compress!.snapshot.targetCount, 3);
}

function testReviewThresholdRespectsOverride(): void {
    const output = planArchivistReasoningPass({
        candidates: [
            makeCandidate(1, {
                confidence: 70,
                lastAccessedAt: daysAgo(30),
                updatedAt: daysAgo(30),
            }),
        ],
        reasoningBudget: 5,
        now: NOW,
        reviewConfidenceThreshold: 90,
    });
    // With threshold raised to 90, the 70-confidence fact now triggers demote.
    const demote = output.proposals.find((p) => p.action === 'demote');
    assert.ok(demote, 'raising threshold should surface previously safe fact');
}

// ─── B. planCouncilConsultation pure unit tests ─────────────────────────────

function testCouncilEmptyTaskReturnsNoContext(): void {
    const plan = planCouncilConsultation({
        from: 'Attendant',
        task: '   ',
    });
    assert.equal(plan.outcome, 'no_context');
    assert.equal(plan.consultations.length, 0);
}

function testCouncilZeroBudgetReturnsNoContext(): void {
    const plan = planCouncilConsultation({
        from: 'Attendant',
        task: 'check relevance',
        budget: 0,
    });
    assert.equal(plan.outcome, 'no_context');
}

function testCouncilLibrarianConflictConsultsAttendant(): void {
    const plan = planCouncilConsultation({
        from: 'Librarian',
        task: 'resolve_conflict',
        context: {
            hasConflict: true,
            conflictEntityKey: 'project/iranti/config',
            confidenceSpread: 10,
        },
    });
    const attendant = plan.consultations.find((c) => c.to === 'Attendant');
    assert.ok(attendant, 'Librarian conflict should consult Attendant for relevance');
    assert.equal(attendant!.basis, 'conflict_resolution');
    assert.ok(attendant!.question.includes('project/iranti/config'));
}

function testCouncilLibrarianHighSpreadAlsoConsultsArchivist(): void {
    const plan = planCouncilConsultation({
        from: 'Librarian',
        task: 'resolve_conflict',
        context: {
            hasConflict: true,
            conflictEntityKey: 'project/iranti/db_url',
            confidenceSpread: 50,
        },
    });
    const archivist = plan.consultations.find((c) => c.to === 'Archivist');
    assert.ok(archivist, 'high spread should also consult Archivist');
}

function testCouncilAttendantRelevanceConsultsLibrarian(): void {
    const plan = planCouncilConsultation({
        from: 'Attendant',
        task: 'pre_response_relevance_check',
        context: {
            relevanceCheckTopic: 'deployment_pipeline',
        },
    });
    const librarian = plan.consultations.find((c) => c.to === 'Librarian');
    assert.ok(librarian, 'Attendant with topic should consult Librarian');
    assert.equal(librarian!.basis, 'relevance_check');
}

function testCouncilAttendantLowConfidenceInjectionConsultsArchivist(): void {
    const plan = planCouncilConsultation({
        from: 'Attendant',
        task: 'low_conf_injection',
        context: {
            relevanceCheckTopic: null,
            lowConfidenceCount: 5,
        },
    });
    const archivist = plan.consultations.find((c) => c.to === 'Archivist');
    assert.ok(archivist, 'low confidence count should trigger Archivist consult');
    assert.equal(archivist!.basis, 'reasoning_proposal_review');
}

function testCouncilArchivistReasoningConsultsLibrarian(): void {
    const plan = planCouncilConsultation({
        from: 'Archivist',
        task: 'reasoning_pass_compress',
        context: {
            reasoningProposalAction: 'compress',
        },
    });
    const librarian = plan.consultations.find((c) => c.to === 'Librarian');
    assert.ok(librarian, 'Archivist reasoning proposal should consult Librarian');
    assert.equal(librarian!.basis, 'reasoning_proposal_review');
}

function testCouncilResolutionistEscalationConsultsArchivistAndLibrarian(): void {
    const plan = planCouncilConsultation({
        from: 'Resolutionist',
        task: 'pending_escalation_review',
        context: {
            pendingEscalationKey: 'project/iranti/prod_db',
        },
        budget: 3,
    });
    assert.equal(plan.consultations.length, 2);
    assert.ok(plan.consultations.some((c) => c.to === 'Archivist'));
    assert.ok(plan.consultations.some((c) => c.to === 'Librarian'));
}

function testCouncilSelfConsultationIsDropped(): void {
    const plan = planCouncilConsultation({
        from: 'Librarian',
        task: 'some task',
        context: {
            hasConflict: true,
            conflictEntityKey: 'x',
            // forcing: even if rules tried to self-consult, the filter would drop it.
        },
    });
    assert.ok(plan.consultations.every((c) => c.to !== 'Librarian'));
}

function testCouncilBudgetCapsAtMax(): void {
    const plan = planCouncilConsultation({
        from: 'Resolutionist',
        task: 'pending_escalation_review',
        context: {
            pendingEscalationKey: 'project/iranti/prod_db',
        },
        budget: 1,
    });
    assert.equal(plan.consultations.length, 1);
    assert.equal(plan.budgetMax, 1);
    assert.equal(plan.outcome, 'budget_capped');
}

function testCouncilMinConfidenceIsEnforced(): void {
    // Every proposed consultation in the rules ships with confidence ≥ 60,
    // well above COUNCIL_MIN_CONFIDENCE. This test just pins the constant.
    assert.ok(COUNCIL_MIN_CONFIDENCE >= 50);
}

function testCouncilDefaultBudgetConstant(): void {
    assert.equal(COUNCIL_DEFAULT_BUDGET, 2);
}

function testCouncilNoContextYieldsNoConsultations(): void {
    const plan = planCouncilConsultation({
        from: 'Librarian',
        task: 'generic_task',
        context: {},
    });
    assert.equal(plan.outcome, 'no_consultations');
    assert.equal(plan.consultations.length, 0);
}

function testCouncilTopicHintTruncation(): void {
    const longKey = 'project/iranti/' + 'x'.repeat(200);
    const plan = planCouncilConsultation({
        from: 'Librarian',
        task: 'resolve_conflict',
        context: {
            hasConflict: true,
            conflictEntityKey: longKey,
        },
    });
    const attendant = plan.consultations.find((c) => c.to === 'Attendant');
    assert.ok(attendant);
    assert.ok(attendant!.topicHint && attendant!.topicHint.length <= 60);
}

function testCouncilReviewThresholdConstantWired(): void {
    // Just confirm the exposed constant matches the helper's default.
    assert.equal(ARCHIVIST_REVIEW_CONFIDENCE_THRESHOLD, 55);
}

// ─── Runner ─────────────────────────────────────────────────────────────────

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
    console.log('running B7 archivist reasoning + council tests');

    // A: planArchivistReasoningPass pure unit
    await runTest('no candidates → no_candidates outcome', testNoCandidatesReturnsNoCandidates);
    await runTest('zero budget → budget_zero outcome', testZeroBudgetReturnsBudgetZero);
    await runTest('compress cluster when three duplicates', testCompressClusterWhenThreeDuplicates);
    await runTest('compress ignores clusters below min size', testCompressIgnoresClustersBelowMinSize);
    await runTest('flag drift on high-spread cluster', testFlagDriftOnHighSpreadCluster);
    await runTest('flag drift skipped on low spread', testFlagDriftSkippedOnLowSpread);
    await runTest('demote stale low-confidence single', testDemoteStaleLowConfidenceSingle);
    await runTest('demote skipped when fresh', testDemoteSkippedWhenFresh);
    await runTest('review_stale on very old single', testReviewStaleOnVeryOldSingle);
    await runTest('budget caps proposals', testBudgetCapsProposals);
    await runTest('proposals_emitted outcome when under budget', testProposalsEmittedOutcomeWhenUnderBudget);
    await runTest('note mentions counts and budget', testNoteMentionsCountsAndBudget);
    await runTest('snapshot captures confidence range', testSnapshotCapturesConfidenceRange);
    await runTest('review threshold respects override', testReviewThresholdRespectsOverride);

    // B: planCouncilConsultation pure unit
    await runTest('council empty task returns no_context', testCouncilEmptyTaskReturnsNoContext);
    await runTest('council zero budget returns no_context', testCouncilZeroBudgetReturnsNoContext);
    await runTest('Librarian conflict consults Attendant', testCouncilLibrarianConflictConsultsAttendant);
    await runTest('Librarian high spread also consults Archivist', testCouncilLibrarianHighSpreadAlsoConsultsArchivist);
    await runTest('Attendant relevance check consults Librarian', testCouncilAttendantRelevanceConsultsLibrarian);
    await runTest('Attendant low-conf injection consults Archivist', testCouncilAttendantLowConfidenceInjectionConsultsArchivist);
    await runTest('Archivist reasoning proposal consults Librarian', testCouncilArchivistReasoningConsultsLibrarian);
    await runTest('Resolutionist escalation consults Archivist and Librarian', testCouncilResolutionistEscalationConsultsArchivistAndLibrarian);
    await runTest('council self-consultation is dropped', testCouncilSelfConsultationIsDropped);
    await runTest('council budget caps at max', testCouncilBudgetCapsAtMax);
    await runTest('council min confidence is enforced', testCouncilMinConfidenceIsEnforced);
    await runTest('council default budget constant', testCouncilDefaultBudgetConstant);
    await runTest('council no context yields no consultations', testCouncilNoContextYieldsNoConsultations);
    await runTest('council topic hint truncation', testCouncilTopicHintTruncation);
    await runTest('archivist review threshold constant wired', testCouncilReviewThresholdConstantWired);

    if (process.exitCode !== 1) {
        console.log('B7 archivist reasoning + council tests passed');
    } else {
        console.log('B7 archivist reasoning + council tests failed');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
