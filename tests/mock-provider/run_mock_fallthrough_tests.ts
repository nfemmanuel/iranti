import assert from 'node:assert/strict';
import mockProvider, {
    configureMock,
    getMockFallthroughCount,
    getLastMockFallthrough,
    resetMockFallthroughTracking,
    MockFallthroughEvent,
} from '../../src/lib/providers/mock';

type TestFn = () => Promise<void>;

async function runTest(name: string, fn: TestFn): Promise<void> {
    try {
        // Reset shared singleton state between tests.
        configureMock({
            scenario: 'default',
            seed: 42,
            failureRate: 0,
            responseDelayMs: 0,
            strictFallthrough: false,
            onFallthrough: undefined,
        });
        resetMockFallthroughTracking();
        await fn();
        console.log(`  ok  ${name}`);
    } catch (error) {
        console.error(`  FAIL  ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

async function testMatchedPromptsDoNotFallthrough(): Promise<void> {
    // These prompts all hit existing branches in MockProvider.complete().
    // None of them should be counted as a fallthrough.
    const matchedPrompts: string[] = [
        'Return only valid JSON with this exact shape: { "needsMemory": boolean, "confidence": number, "reason": string }\nLatest user message: What did I say about Athens earlier?\nRecent context excerpt:',
        'Extract explicitly named entities from the text.\nText: project/iranti is working on memory compaction.',
        'Respond with the specific type of task the agent is performing.',
        'Return only the numbers of entries that are directly relevant to the task.\nAgent task: validate mock fallthrough behaviour.\nAvailable knowledge entries:\n1. Mock provider dispatches prompts via substring matching.',
        'Is this a genuinely contradictory fact, or should we keep_existing?',
        'Extract only distinct facts from the following text. Text to chunk: The team has 12 employees.',
        'Please compress this working memory summary for the current task context.',
    ];

    for (const prompt of matchedPrompts) {
        const res = await mockProvider.complete([{ role: 'user', content: prompt }]);
        assert.equal(res.provider, 'mock', 'expected provider label');
        assert.ok(typeof res.text === 'string' && res.text.length > 0, 'expected non-empty response text');
    }

    assert.equal(
        getMockFallthroughCount(),
        0,
        `expected zero fallthroughs for matched prompts, got ${getMockFallthroughCount()} (last snippet: ${getLastMockFallthrough()?.promptSnippet ?? 'none'})`,
    );
    assert.equal(getLastMockFallthrough(), null, 'expected no lastFallthrough when nothing fell through');
}

async function testUnmatchedPromptCountsAsFallthrough(): Promise<void> {
    // No branch in MockProvider.complete() matches this.
    const unmatched = 'Hello world, please tell me a joke about kangaroos.';
    const res = await mockProvider.complete([{ role: 'user', content: unmatched }]);

    // Backward-compat default: still returns the canned researcher JSON.
    assert.ok(res.text.includes('Sample Researcher'), 'expected canned researcher JSON to still be returned by default');
    assert.equal(res.provider, 'mock');

    assert.equal(getMockFallthroughCount(), 1, 'expected one recorded fallthrough');

    const last = getLastMockFallthrough();
    assert.ok(last, 'expected lastFallthrough event to be populated');
    assert.equal(last!.prompt, unmatched, 'expected full prompt captured on fallthrough event');
    assert.equal(last!.promptSnippet, unmatched, 'short prompt should not be truncated');
    assert.equal(typeof last!.callCount, 'number');
    assert.equal(typeof last!.at, 'number');
    assert.ok(last!.at > 0);
}

async function testStrictFallthroughThrows(): Promise<void> {
    configureMock({ strictFallthrough: true });
    const unmatched = 'An entirely unrelated prompt with no branch match.';

    let threw = false;
    try {
        await mockProvider.complete([{ role: 'user', content: unmatched }]);
    } catch (error) {
        threw = true;
        assert.ok(error instanceof Error, 'expected Error instance');
        assert.ok(
            (error as Error).message.startsWith('[mock] Unmatched prompt'),
            `expected strict-fallthrough error prefix, got: ${(error as Error).message}`,
        );
        assert.ok(
            (error as Error).message.includes('unrelated prompt'),
            'expected snippet of original prompt in strict-fallthrough error',
        );
    }
    assert.ok(threw, 'expected strict fallthrough to throw');

    // Even when strict mode throws, the tracking counters should still advance
    // so tests can reason about how many unmatched prompts occurred.
    assert.equal(getMockFallthroughCount(), 1, 'expected fallthrough count to increment even when strict throws');
    const last = getLastMockFallthrough();
    assert.ok(last, 'expected lastFallthrough event to be captured before strict throw');
    assert.ok(last!.prompt.includes('unrelated prompt'));
}

async function testOnFallthroughCallbackFires(): Promise<void> {
    const seen: MockFallthroughEvent[] = [];
    configureMock({
        onFallthrough: (event) => {
            seen.push(event);
        },
    });

    await mockProvider.complete([{ role: 'user', content: 'first unrelated prompt' }]);
    await mockProvider.complete([{ role: 'user', content: 'second unrelated prompt' }]);

    assert.equal(seen.length, 2, 'expected two onFallthrough invocations');
    assert.equal(seen[0].prompt, 'first unrelated prompt');
    assert.equal(seen[1].prompt, 'second unrelated prompt');
    assert.equal(getMockFallthroughCount(), 2);
}

async function testOnFallthroughCallbackErrorIsSwallowed(): Promise<void> {
    configureMock({
        onFallthrough: () => {
            throw new Error('observer boom');
        },
    });

    // The misbehaving observer should not destabilize the provider.
    const res = await mockProvider.complete([{ role: 'user', content: 'another unrelated prompt' }]);
    assert.ok(res.text.includes('Sample Researcher'));
    assert.equal(getMockFallthroughCount(), 1);
}

async function testLongPromptIsTruncatedInSnippet(): Promise<void> {
    const longPrompt = 'x'.repeat(500);
    await mockProvider.complete([{ role: 'user', content: longPrompt }]);

    const last = getLastMockFallthrough();
    assert.ok(last);
    assert.equal(last!.prompt.length, 500, 'full prompt should be preserved');
    assert.ok(last!.promptSnippet.length <= 241, `snippet should be <=241 chars, got ${last!.promptSnippet.length}`);
    assert.ok(last!.promptSnippet.endsWith('…'), 'long prompt snippet should end with ellipsis');
}

async function testResetFallthroughTrackingClearsState(): Promise<void> {
    await mockProvider.complete([{ role: 'user', content: 'unrelated one' }]);
    await mockProvider.complete([{ role: 'user', content: 'unrelated two' }]);
    assert.equal(getMockFallthroughCount(), 2);

    resetMockFallthroughTracking();

    assert.equal(getMockFallthroughCount(), 0);
    assert.equal(getLastMockFallthrough(), null);
}

async function main(): Promise<void> {
    console.log('running mock fallthrough tests');
    await runTest('matched prompts do not count as fallthrough', testMatchedPromptsDoNotFallthrough);
    await runTest('unmatched prompt counts as fallthrough', testUnmatchedPromptCountsAsFallthrough);
    await runTest('strictFallthrough throws with snippet', testStrictFallthroughThrows);
    await runTest('onFallthrough callback fires', testOnFallthroughCallbackFires);
    await runTest('onFallthrough observer error is swallowed', testOnFallthroughCallbackErrorIsSwallowed);
    await runTest('long prompt is truncated in snippet', testLongPromptIsTruncatedInSnippet);
    await runTest('resetFallthroughTracking clears state', testResetFallthroughTrackingClearsState);

    if (process.exitCode === 1) {
        console.error('mock fallthrough tests failed');
        process.exit(1);
    }
    console.log('mock fallthrough tests passed');
}

main().catch((error) => {
    console.error('mock fallthrough tests failed:', error);
    process.exit(1);
});
