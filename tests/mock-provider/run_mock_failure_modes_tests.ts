import assert from 'node:assert/strict';
import mockProvider, {
    configureMock,
    getMockFailureModeCount,
    getLastMockFailureMode,
    getMockScheduledFailuresRemaining,
    resetMockFailureModeTracking,
    resetMockFallthroughTracking,
    MockFailureEvent,
    MockFailureMode,
} from '../../src/lib/providers/mock';

type TestFn = () => Promise<void>;

// A prompt that hits the "return only the numbers of entries" branch and
// yields plain text (not JSON) so truncation and emptiness are observable
// without JSON shape assumptions. Task tokens are chosen so they share no
// words with the entries — this guarantees the clean branch returns the
// string 'none', which is what the tests assert against.
const RELEVANCE_PROMPT =
    'Return only the numbers of entries that are directly relevant to the task.\n'
    + 'Agent task: xylophone piccolo tympani.\n'
    + 'Available knowledge entries:\n'
    + '1. Albatross recipes for cold weather expeditions.\n'
    + '2. Knitting patterns for medieval tapestries.\n';

// A prompt that hits the entity-extraction branch and yields valid JSON so
// JSON-parse failure modes (malformed_json, wrong_shape) are observable.
const EXTRACT_ENTITIES_PROMPT =
    'Extract explicitly named entities from the text.\nText: project/iranti is shipping mock failure modes today.';

// A prompt that hits the memory-need classifier branch and yields a JSON
// object (not array) so wrong_shape is clearly distinguishable from the
// normal JSON shape.
const NEEDS_MEMORY_PROMPT =
    'Return only valid JSON with this exact shape: { "needsMemory": boolean, "confidence": number, "reason": string }\n'
    + 'Latest user message: Do you remember the project setup we discussed earlier?\n'
    + 'Recent context excerpt:';

async function runTest(name: string, fn: TestFn): Promise<void> {
    try {
        // Reset shared singleton state between tests. Critically, this also
        // wipes any scheduled failures left over from a prior test so each
        // test starts from a known-good baseline.
        configureMock({
            scenario: 'default',
            seed: 42,
            failureRate: 0,
            responseDelayMs: 0,
            responseDelayRangeMs: undefined,
            strictFallthrough: false,
            onFallthrough: undefined,
            failureMode: undefined,
            failureModeRate: 0,
            failBeforeSuccessCount: 0,
            onFailureMode: undefined,
        });
        resetMockFallthroughTracking();
        resetMockFailureModeTracking();
        await fn();
        console.log(`  ok  ${name}`);
    } catch (error) {
        console.error(`  FAIL  ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

async function testNoFailureModeByDefault(): Promise<void> {
    const res = await mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]);
    assert.equal(res.text, 'none', 'expected a clean response from the relevance branch');
    assert.equal(getMockFailureModeCount(), 0, 'expected no failure mode to fire on default config');
    assert.equal(getLastMockFailureMode(), null, 'expected lastFailureMode to be null on default config');
}

async function testEmptyFailureModeClearsText(): Promise<void> {
    configureMock({ failureMode: 'empty', failureModeRate: 1 });

    const res = await mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]);
    assert.equal(res.text, '', 'expected empty failure mode to erase the response text');
    assert.equal(res.provider, 'mock');
    assert.equal(getMockFailureModeCount(), 1, 'expected one recorded failure-mode fire');

    const last = getLastMockFailureMode();
    assert.ok(last, 'expected lastFailureMode to be populated');
    assert.equal(last!.mode, 'empty');
    assert.equal(last!.scheduled, false, 'probabilistic fires should be marked unscheduled');
    assert.ok(last!.callCount >= 1);
}

async function testTruncatedFailureModeShortensText(): Promise<void> {
    configureMock({ failureMode: 'truncated', failureModeRate: 1 });

    const res = await mockProvider.complete([{ role: 'user', content: EXTRACT_ENTITIES_PROMPT }]);

    // The original response is a JSON array; truncation should cut it in half
    // so it is strictly shorter than the original and no longer valid JSON.
    assert.ok(res.text.length > 0, 'expected truncated output to retain some bytes');
    assert.throws(() => JSON.parse(res.text), 'truncated JSON should fail to parse');
    assert.equal(getMockFailureModeCount(), 1);
    assert.equal(getLastMockFailureMode()?.mode, 'truncated');
}

async function testMalformedJsonOnJsonResponse(): Promise<void> {
    configureMock({ failureMode: 'malformed_json', failureModeRate: 1 });

    const res = await mockProvider.complete([{ role: 'user', content: NEEDS_MEMORY_PROMPT }]);

    // The clean response is a valid JSON object; malformed_json should strip
    // the closing bracket so JSON.parse throws. This is the exact shape Staff
    // JSON consumers need to handle gracefully.
    assert.ok(res.text.length > 0);
    assert.throws(() => JSON.parse(res.text), 'malformed_json output should fail to parse');
    assert.ok(res.text.endsWith(','), 'malformed_json should leave a dangling comma where the close bracket was');
    assert.equal(getLastMockFailureMode()?.mode, 'malformed_json');
}

async function testMalformedJsonOnFreeTextResponse(): Promise<void> {
    configureMock({ failureMode: 'malformed_json', failureModeRate: 1 });

    // Conflict-resolution branch returns free text, not JSON. malformed_json
    // should still produce unparseable output instead of silently passing
    // through.
    const res = await mockProvider.complete([{
        role: 'user',
        content: 'Is this a genuinely contradictory fact, or should we keep_existing?',
    }]);

    assert.ok(res.text.includes('"partial"'), 'expected malformed_json wrapper envelope for free-text responses');
    assert.throws(() => JSON.parse(res.text), 'wrapped malformed_json output must still fail to parse');
    assert.equal(getLastMockFailureMode()?.mode, 'malformed_json');
}

async function testWrongShapeReturnsValidJsonButWrongSchema(): Promise<void> {
    configureMock({ failureMode: 'wrong_shape', failureModeRate: 1 });

    const res = await mockProvider.complete([{ role: 'user', content: NEEDS_MEMORY_PROMPT }]);

    // Must be valid JSON (parses cleanly) but with a completely different
    // shape from the expected { needsMemory, confidence, reason } object.
    const parsed = JSON.parse(res.text);
    assert.equal(typeof parsed, 'object');
    assert.equal(parsed.unexpected, true, 'wrong_shape should return an object with unexpected:true');
    assert.equal('needsMemory' in parsed, false, 'wrong_shape must not satisfy the expected schema');
    assert.equal(getLastMockFailureMode()?.mode, 'wrong_shape');
}

async function testThrowFailureModeRaisesError(): Promise<void> {
    configureMock({ failureMode: 'throw', failureModeRate: 1 });

    let threw = false;
    try {
        await mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]);
    } catch (error) {
        threw = true;
        assert.ok(error instanceof Error);
        assert.ok((error as Error).message.startsWith('[mock] Simulated failure mode: throw'));
    }
    assert.ok(threw, 'throw failure mode must raise an error');
    assert.equal(getMockFailureModeCount(), 1, 'failure tracker must advance even when the call throws');
    assert.equal(getLastMockFailureMode()?.mode, 'throw');
}

async function testFailBeforeSuccessCountSchedulesRetriableFailures(): Promise<void> {
    configureMock({
        failureMode: 'throw',
        failBeforeSuccessCount: 2,
    });

    assert.equal(getMockScheduledFailuresRemaining(), 2, 'expected 2 scheduled failures before any call');

    // First call: scheduled throw.
    await assert.rejects(
        mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]),
        /Simulated failure mode: throw/,
    );
    assert.equal(getMockScheduledFailuresRemaining(), 1);
    assert.equal(getLastMockFailureMode()?.scheduled, true);

    // Second call: scheduled throw.
    await assert.rejects(
        mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]),
        /Simulated failure mode: throw/,
    );
    assert.equal(getMockScheduledFailuresRemaining(), 0);

    // Third call: schedule exhausted; failureModeRate defaults to 0 so this
    // call must succeed cleanly. This is the retry-with-backoff recovery
    // path that Staff consumers need to exercise.
    const res = await mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]);
    assert.equal(res.text, 'none', 'post-schedule calls must return the clean response');
    assert.equal(getMockFailureModeCount(), 2, 'failure count must not advance on the successful third call');
}

async function testUnreliableScenarioRotatesFailureModes(): Promise<void> {
    const seen: MockFailureMode[] = [];
    configureMock({
        scenario: 'unreliable',
        failureModeRate: 1,
        seed: 7,
        onFailureMode: (event) => {
            seen.push(event.mode);
        },
    });

    // Run enough calls to see the full rotation. We call a prompt that never
    // throws internally so the only throws come from the 'throw' rotation
    // slot. The unreliable rotation is: malformed_json, truncated,
    // wrong_shape, empty, throw.
    const totalCalls = 10;
    let throws = 0;
    for (let i = 0; i < totalCalls; i++) {
        try {
            await mockProvider.complete([{ role: 'user', content: EXTRACT_ENTITIES_PROMPT }]);
        } catch (error) {
            throws += 1;
            assert.ok((error as Error).message.includes('Simulated failure mode: throw'));
        }
    }

    // Over 10 calls we should see every failure mode at least once.
    const distinct = new Set(seen);
    assert.ok(distinct.has('malformed_json'), 'expected malformed_json in unreliable rotation');
    assert.ok(distinct.has('truncated'), 'expected truncated in unreliable rotation');
    assert.ok(distinct.has('wrong_shape'), 'expected wrong_shape in unreliable rotation');
    assert.ok(distinct.has('empty'), 'expected empty in unreliable rotation');
    assert.ok(distinct.has('throw'), 'expected throw in unreliable rotation');
    assert.equal(throws, seen.filter((m) => m === 'throw').length, 'throws must align with throw-mode fires');
    assert.equal(getMockFailureModeCount(), totalCalls, 'every call should fire a failure mode at rate=1');
}

async function testUnreliableScenarioRespectsLowerRate(): Promise<void> {
    const seen: MockFailureMode[] = [];
    configureMock({
        scenario: 'unreliable',
        failureModeRate: 0.25,
        seed: 1234,
        onFailureMode: (event) => {
            seen.push(event.mode);
        },
    });

    let calls = 0;
    let cleanResponses = 0;
    const ATTEMPTS = 40;
    for (let i = 0; i < ATTEMPTS; i++) {
        calls += 1;
        try {
            const res = await mockProvider.complete([{ role: 'user', content: EXTRACT_ENTITIES_PROMPT }]);
            // If we made it here, the call did not throw. That does not mean
            // the response was clean (could be corrupted), so we check the
            // failure counter instead.
            if (res.text === JSON.stringify([]) || res.text.startsWith('[{')) {
                cleanResponses += 1;
            }
        } catch {
            // Throw-mode fires are expected occasionally; they count toward
            // failureModeCount via recordFailureMode.
        }
    }

    assert.equal(calls, ATTEMPTS);
    // At rate=0.25 we expect roughly 10/40 fires, but the exact count is
    // seeded. All we need is that it's strictly less than ATTEMPTS and at
    // least 1 so the rotation is exercised without dominating.
    const fires = getMockFailureModeCount();
    assert.ok(fires > 0, `expected at least one failure-mode fire at rate 0.25, got ${fires}`);
    assert.ok(fires < ATTEMPTS, `expected rate 0.25 to leave some clean calls, got ${fires}/${ATTEMPTS}`);
    assert.ok(cleanResponses > 0, `expected some clean responses at rate 0.25, got ${cleanResponses}`);
}

async function testOnFailureModeObserverErrorIsSwallowed(): Promise<void> {
    configureMock({
        failureMode: 'empty',
        failureModeRate: 1,
        onFailureMode: () => {
            throw new Error('observer boom');
        },
    });

    // A misbehaving observer must not destabilize the provider itself: the
    // call should still return the corrupted (empty) response and the
    // failure counter should still advance.
    const res = await mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]);
    assert.equal(res.text, '');
    assert.equal(getMockFailureModeCount(), 1);
}

async function testResponseDelayRangeIsUsed(): Promise<void> {
    configureMock({
        responseDelayRangeMs: [15, 35],
        seed: 99,
    });

    const start = Date.now();
    await mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]);
    const elapsed = Date.now() - start;

    // Lower bound enforcement: must have slept at least the minimum. Upper
    // bound is loose to avoid CI flakiness (setTimeout is not precise).
    assert.ok(elapsed >= 15, `expected delay >= 15ms, got ${elapsed}ms`);
    assert.ok(elapsed < 500, `delay range should cap well under 500ms, got ${elapsed}ms`);
}

async function testResetFailureModeTrackingClearsState(): Promise<void> {
    configureMock({ failureMode: 'empty', failureModeRate: 1 });
    await mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]);
    await mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]);
    assert.equal(getMockFailureModeCount(), 2);
    assert.ok(getLastMockFailureMode());

    resetMockFailureModeTracking();

    assert.equal(getMockFailureModeCount(), 0);
    assert.equal(getLastMockFailureMode(), null);
    // Reset should restore the scheduled failure count from current config,
    // which has failBeforeSuccessCount=0 here.
    assert.equal(getMockScheduledFailuresRemaining(), 0);
}

async function testConfigureResetsAllStateIncludingSchedule(): Promise<void> {
    configureMock({ failureMode: 'throw', failBeforeSuccessCount: 3 });
    assert.equal(getMockScheduledFailuresRemaining(), 3);

    // Consume one scheduled failure.
    await assert.rejects(
        mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]),
        /Simulated failure mode: throw/,
    );
    assert.equal(getMockScheduledFailuresRemaining(), 2);

    // Reconfigure mid-stream: schedule must be re-seeded from the new value.
    configureMock({ failureMode: 'throw', failBeforeSuccessCount: 1 });
    assert.equal(getMockScheduledFailuresRemaining(), 1);
    assert.equal(getMockFailureModeCount(), 0, 'configure() should zero failure counters');
}

async function testFailureObserverReceivesCallCountAndTimestamp(): Promise<void> {
    const events: MockFailureEvent[] = [];
    configureMock({
        failureMode: 'empty',
        failureModeRate: 1,
        onFailureMode: (event) => {
            events.push(event);
        },
    });

    await mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]);
    await mockProvider.complete([{ role: 'user', content: RELEVANCE_PROMPT }]);

    assert.equal(events.length, 2);
    assert.equal(events[0].mode, 'empty');
    assert.equal(events[0].scheduled, false);
    assert.ok(typeof events[0].at === 'number' && events[0].at > 0);
    assert.ok(typeof events[0].callCount === 'number' && events[0].callCount >= 1);
    assert.ok(events[1].callCount > events[0].callCount, 'callCount should monotonically increase');
}

async function main(): Promise<void> {
    console.log('running mock failure mode tests');
    await runTest('default config applies no failure mode', testNoFailureModeByDefault);
    await runTest('empty failure mode clears response text', testEmptyFailureModeClearsText);
    await runTest('truncated failure mode shortens response', testTruncatedFailureModeShortensText);
    await runTest('malformed_json breaks real JSON responses', testMalformedJsonOnJsonResponse);
    await runTest('malformed_json wraps free-text responses', testMalformedJsonOnFreeTextResponse);
    await runTest('wrong_shape returns valid JSON with unexpected schema', testWrongShapeReturnsValidJsonButWrongSchema);
    await runTest('throw failure mode raises an error', testThrowFailureModeRaisesError);
    await runTest('failBeforeSuccessCount schedules retriable failures', testFailBeforeSuccessCountSchedulesRetriableFailures);
    await runTest('unreliable scenario rotates failure modes', testUnreliableScenarioRotatesFailureModes);
    await runTest('unreliable scenario respects lower rate', testUnreliableScenarioRespectsLowerRate);
    await runTest('onFailureMode observer error is swallowed', testOnFailureModeObserverErrorIsSwallowed);
    await runTest('responseDelayRangeMs is applied', testResponseDelayRangeIsUsed);
    await runTest('resetFailureModeTracking clears state', testResetFailureModeTrackingClearsState);
    await runTest('configure() resets all state including schedule', testConfigureResetsAllStateIncludingSchedule);
    await runTest('onFailureMode observer gets callCount and timestamp', testFailureObserverReceivesCallCountAndTimestamp);

    if (process.exitCode === 1) {
        console.error('mock failure mode tests failed');
        process.exit(1);
    }
    console.log('mock failure mode tests passed');
}

main().catch((error) => {
    console.error('mock failure mode tests failed:', error);
    process.exit(1);
});
