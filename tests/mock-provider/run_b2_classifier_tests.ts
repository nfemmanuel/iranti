/**
 * B2.S3: tests for the mock provider's classifyPromptKind pure function and
 * the kindCounts tracker on MockProvider.
 *
 * Before S3, MockProvider.complete() scanned `lastMessage` with a chain of
 * substring checks inside one giant if/else. The refactor extracts that
 * decision into a pure `classifyPromptKind(message) -> PromptKind` function
 * plus a per-kind counter on the provider so tests can assert which branches
 * were exercised instead of guessing from fallthrough counts.
 *
 * These tests lock in:
 *   1. Every PromptKind branch returns the expected label for a representative
 *      Staff prompt.
 *   2. Unrelated prompts fall into 'unknown' (existing fallthrough machinery
 *      still handles them; behavior is preserved).
 *   3. Running `complete()` increments the correct kindCounts bucket.
 *   4. Module-level getMockKindCounts/resetMockKindCounts proxy correctly.
 *
 * Also includes B2.S4 smoke tests for the `conflict_multi_step` counter wiring:
 * importing `classifyPromptKind` with a "genuinely contradictory" prompt should
 * classify as `conflict_resolution` (the S4 code path that now gathers sibling
 * evidence before calling the LLM relies on this same classifier branch).
 */

import assert from 'node:assert/strict';
import mockProvider, {
    classifyPromptKind,
    configureMock,
    getMockKindCounts,
    resetMockKindCounts,
    type PromptKind,
} from '../../src/lib/providers/mock';

type TestFn = () => Promise<void> | void;

async function runTest(name: string, fn: TestFn): Promise<void> {
    try {
        // Reset shared singleton state between tests so kindCounts starts at
        // all-zeros. configureMock() already resets via resetKindCounts(),
        // but we also call the module-level reset to cover the direct path.
        configureMock({
            scenario: 'default',
            seed: 42,
            failureRate: 0,
            responseDelayMs: 0,
            strictFallthrough: false,
            onFallthrough: undefined,
        });
        resetMockKindCounts();
        await fn();
        console.log(`  ok  ${name}`);
    } catch (error) {
        console.error(`  FAIL  ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

// ─── Pure classifier unit tests ─────────────────────────────────────────────

function testClassifyMemoryNeed(): void {
    const prompt = [
        'Return only valid JSON with this exact shape:',
        '{ "needsMemory": boolean, "confidence": number, "reason": string }',
        'Latest user message: What did I say about Athens earlier?',
    ].join('\n');
    assert.equal(classifyPromptKind(prompt), 'memory_need');
}

function testClassifyEntityExtraction(): void {
    const prompt = 'Extract explicitly named entities from the text.\nText: project/iranti uses Prisma.';
    assert.equal(classifyPromptKind(prompt), 'entity_extraction');
}

function testClassifyTaskInference(): void {
    const prompt = 'Respond with the specific type of task the agent is performing.';
    assert.equal(classifyPromptKind(prompt), 'task_inference');
}

function testClassifyRelevanceFilter(): void {
    const prompt = [
        'Return only the numbers of entries that are directly relevant to the task.',
        'Agent task: ship v0.3.25.',
        'Available knowledge entries:',
        '1. B2 refactor notes',
    ].join('\n');
    assert.equal(classifyPromptKind(prompt), 'relevance_filter');
}

function testClassifyConflictResolutionByContradictory(): void {
    const prompt = 'Are these values genuinely contradictory, or measuring different things?';
    assert.equal(classifyPromptKind(prompt), 'conflict_resolution');
}

function testClassifyConflictResolutionByKeepExisting(): void {
    // The dispatch also matches on KEEP_EXISTING literally because the
    // Librarian prompt template ends with "KEEP_EXISTING: <reason>" etc.
    const prompt = 'Respond with exactly one of: KEEP_EXISTING | KEEP_INCOMING | ESCALATE.';
    assert.equal(classifyPromptKind(prompt), 'conflict_resolution');
}

function testClassifyFactExtraction(): void {
    const prompt = 'Extract only distinct facts from the following text. Text: the team has 12 employees.';
    assert.equal(classifyPromptKind(prompt), 'fact_extraction');
}

function testClassifyFactExtractionAtomic(): void {
    const prompt = 'Extract every distinct atomic fact from the excerpt below.';
    assert.equal(classifyPromptKind(prompt), 'fact_extraction');
}

function testClassifyCompression(): void {
    const prompt = 'Please compress this working memory summary.';
    assert.equal(classifyPromptKind(prompt), 'compression');
}

function testClassifyCompressionSummarize(): void {
    const prompt = 'Summarize the turn for downstream recall.';
    assert.equal(classifyPromptKind(prompt), 'compression');
}

function testClassifyUnknownForUnrelatedText(): void {
    const prompt = 'Hello mock provider, please write a haiku about Tufacle.';
    assert.equal(classifyPromptKind(prompt), 'unknown');
}

function testClassifyUnknownForEmptyString(): void {
    assert.equal(classifyPromptKind(''), 'unknown');
}

// ─── Classifier determinism + case insensitivity ────────────────────────────

function testClassifierIsCaseInsensitive(): void {
    // All dispatch rules use message.toLowerCase(); uppercase input should
    // still classify correctly.
    const prompt = 'EXTRACT EXPLICITLY NAMED ENTITIES FROM THE TEXT. Text: alpha.';
    assert.equal(classifyPromptKind(prompt), 'entity_extraction');
}

function testClassifierPureNoSideEffectsOnCounts(): void {
    // Calling the pure function should NOT touch the mock provider's
    // kindCounts — it's the complete() call that increments, not the
    // classifier itself.
    classifyPromptKind('Extract explicitly named entities from the text. Text: alpha.');
    classifyPromptKind('Summarize the turn.');
    const counts = getMockKindCounts();
    for (const kind of Object.keys(counts) as PromptKind[]) {
        assert.equal(counts[kind], 0, `expected no count for ${kind}, got ${counts[kind]}`);
    }
}

// ─── kindCounts tracker tests (via complete()) ──────────────────────────────

async function testCompleteIncrementsEntityExtractionCount(): Promise<void> {
    await mockProvider.complete([
        { role: 'user', content: 'Extract explicitly named entities from the text.\nText: alpha beta.' },
    ]);
    const counts = getMockKindCounts();
    assert.equal(counts.entity_extraction, 1);
    assert.equal(counts.memory_need, 0);
    assert.equal(counts.unknown, 0);
}

async function testCompleteIncrementsMultipleKindsIndependently(): Promise<void> {
    await mockProvider.complete([
        { role: 'user', content: 'Extract explicitly named entities from the text.\nText: x.' },
    ]);
    await mockProvider.complete([
        { role: 'user', content: 'Extract explicitly named entities from the text.\nText: y.' },
    ]);
    await mockProvider.complete([
        { role: 'user', content: 'Respond with the specific type of task the agent is performing.' },
    ]);
    const counts = getMockKindCounts();
    assert.equal(counts.entity_extraction, 2);
    assert.equal(counts.task_inference, 1);
    assert.equal(counts.memory_need, 0);
    assert.equal(counts.unknown, 0);
}

async function testCompleteIncrementsUnknownForUnmatchedPrompt(): Promise<void> {
    await mockProvider.complete([
        { role: 'user', content: 'entirely-unrelated-text-with-no-keywords' },
    ]);
    const counts = getMockKindCounts();
    assert.equal(counts.unknown, 1);
    // And all the others should still be zero.
    assert.equal(counts.entity_extraction, 0);
    assert.equal(counts.memory_need, 0);
    assert.equal(counts.task_inference, 0);
    assert.equal(counts.relevance_filter, 0);
    assert.equal(counts.conflict_resolution, 0);
    assert.equal(counts.fact_extraction, 0);
    assert.equal(counts.compression, 0);
}

async function testCompleteIncrementsConflictResolutionForLibrarianPrompt(): Promise<void> {
    // Mirror the literal Librarian conflict prompt shape so this test also
    // functions as a smoke test that the S4 gatherConflictEvidence-enhanced
    // resolveWithReasoning path will still dispatch through the same classifier
    // branch and therefore still be exercised by the mock during integration
    // tests.
    const prompt = [
        'You are resolving a knowledge conflict between two AI agents.',
        'Consider: Are these values genuinely contradictory?',
        'Respond with exactly one of these decisions: KEEP_EXISTING | KEEP_INCOMING | ESCALATE.',
    ].join('\n');
    await mockProvider.complete([{ role: 'user', content: prompt }]);
    const counts = getMockKindCounts();
    assert.equal(counts.conflict_resolution, 1);
}

async function testResetMockKindCountsClearsAllKinds(): Promise<void> {
    await mockProvider.complete([
        { role: 'user', content: 'Extract explicitly named entities from the text.\nText: x.' },
    ]);
    let counts = getMockKindCounts();
    assert.equal(counts.entity_extraction, 1);

    resetMockKindCounts();
    counts = getMockKindCounts();
    for (const kind of Object.keys(counts) as PromptKind[]) {
        assert.equal(counts[kind], 0, `expected zero after reset for ${kind}, got ${counts[kind]}`);
    }
}

async function testConfigureMockAlsoResetsKindCounts(): Promise<void> {
    await mockProvider.complete([
        { role: 'user', content: 'Extract explicitly named entities from the text.\nText: x.' },
    ]);
    let counts = getMockKindCounts();
    assert.equal(counts.entity_extraction, 1);

    // configure() must clear kindCounts too (via resetKindCounts()).
    configureMock({ scenario: 'default', seed: 42 });
    counts = getMockKindCounts();
    for (const kind of Object.keys(counts) as PromptKind[]) {
        assert.equal(counts[kind], 0, `expected zero after configure for ${kind}, got ${counts[kind]}`);
    }
}

function testGetMockKindCountsReturnsSnapshotCopy(): void {
    // getMockKindCounts must return a defensive copy so callers can't mutate
    // the internal state of the singleton.
    const snapshot = getMockKindCounts();
    snapshot.memory_need = 9999;
    const fresh = getMockKindCounts();
    assert.equal(fresh.memory_need, 0);
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('running B2 mock classifier tests');

    // Pure classifier unit tests
    await runTest('classifyPromptKind -> memory_need', testClassifyMemoryNeed);
    await runTest('classifyPromptKind -> entity_extraction', testClassifyEntityExtraction);
    await runTest('classifyPromptKind -> task_inference', testClassifyTaskInference);
    await runTest('classifyPromptKind -> relevance_filter', testClassifyRelevanceFilter);
    await runTest('classifyPromptKind -> conflict_resolution (contradictory)', testClassifyConflictResolutionByContradictory);
    await runTest('classifyPromptKind -> conflict_resolution (KEEP_EXISTING marker)', testClassifyConflictResolutionByKeepExisting);
    await runTest('classifyPromptKind -> fact_extraction (distinct facts)', testClassifyFactExtraction);
    await runTest('classifyPromptKind -> fact_extraction (atomic)', testClassifyFactExtractionAtomic);
    await runTest('classifyPromptKind -> compression (compress verb)', testClassifyCompression);
    await runTest('classifyPromptKind -> compression (summarize verb)', testClassifyCompressionSummarize);
    await runTest('classifyPromptKind -> unknown for unrelated text', testClassifyUnknownForUnrelatedText);
    await runTest('classifyPromptKind -> unknown for empty string', testClassifyUnknownForEmptyString);
    await runTest('classifyPromptKind is case-insensitive', testClassifierIsCaseInsensitive);
    await runTest('classifyPromptKind is pure (no kindCounts side effects)', testClassifierPureNoSideEffectsOnCounts);

    // kindCounts tracker tests
    await runTest('complete() increments entity_extraction count', testCompleteIncrementsEntityExtractionCount);
    await runTest('complete() increments multiple kinds independently', testCompleteIncrementsMultipleKindsIndependently);
    await runTest('complete() increments unknown for unmatched prompt', testCompleteIncrementsUnknownForUnmatchedPrompt);
    await runTest('complete() increments conflict_resolution for Librarian prompt (S4 smoke)', testCompleteIncrementsConflictResolutionForLibrarianPrompt);
    await runTest('resetMockKindCounts clears all kinds', testResetMockKindCountsClearsAllKinds);
    await runTest('configureMock also resets kindCounts', testConfigureMockAlsoResetsKindCounts);
    await runTest('getMockKindCounts returns a defensive copy', testGetMockKindCountsReturnsSnapshotCopy);

    if (process.exitCode && process.exitCode !== 0) {
        console.error('B2 mock classifier tests FAILED');
    } else {
        console.log('B2 mock classifier tests passed');
    }
}

main().catch((error) => {
    console.error('test harness crashed', error);
    process.exitCode = 1;
});
