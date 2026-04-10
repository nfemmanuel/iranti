/**
 * B1.M2 + B1.M3: tool-result extraction and forced write-nudge tests.
 *
 * When the caller passes `toolResult` to iranti_attend, the attendant:
 *   1. Runs `runToolResultAutowrite` BEFORE the main attend flow so any
 *      extracted facts can drive the write-nudge check on the same turn.
 *   2. Surfaces a `toolResultExtraction` block on every return path
 *      (post-response closeout, memory-not-needed early return, and the
 *      main success return).
 *   3. Emits a forced `writeNudge` once `toolCallsSinceLastWrite` crosses
 *      `TOOL_COST_WRITE_NUDGE_THRESHOLD`, upgrading the memory decision to
 *      `needed:true` with `explanation='write_nudge_forced'` so the host
 *      cannot miss the cue on an otherwise empty turn.
 *   4. Gates extraction out on `phase='post-response'` because that phase
 *      has its own capture path (rememberAssistantResponseFacts).
 *
 * This file has two layers:
 *   - Pure unit tests for the module-level helpers (resolveAutowriteTargetEntity,
 *     parseAutowriteEntity, buildToolResultContextLabel, normalizeAutowriteFact).
 *   - Stubbed integration tests that swap out `runToolResultAutowrite` and
 *     `maybeBuildWriteNudge` on the instance and verify the attend() wiring.
 */

import assert from 'node:assert/strict';

// B1.M2: set IRANTI_MEMORY_ENTITY BEFORE importing the attendant module so
// getProjectMemoryEntity() resolves to a real project entity during the
// stubbed integration tests. Same pattern as run_tool_call_retrieval_tests.
const PRIOR_MEMORY_ENTITY = process.env.IRANTI_MEMORY_ENTITY;
process.env.IRANTI_MEMORY_ENTITY = 'project/iranti';

import {
    AttendantInstance,
    resolveAutowriteTargetEntity,
    parseAutowriteEntity,
    buildToolResultContextLabel,
    normalizeAutowriteFact,
    type AttendInput,
    type ObserveResult,
    type FactInjection,
    type ToolResultPayload,
    type ToolResultExtractionOutcome,
    type WriteNudge,
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

const AGENT_ID = 'm2_tool_result_test_agent';
const PROJECT_ENTITY = 'project/iranti';

// ─── Pure unit tests for the module-level helpers ────────────────────────────

function testResolveTargetEntityForRead(): void {
    const target = resolveAutowriteTargetEntity(
        {
            toolName: 'Read',
            status: 'success',
            content: 'file contents',
            metadata: { path: 'src/api/server.ts' },
        },
        PROJECT_ENTITY,
    );
    assert.equal(target, 'project/iranti/file/server');
}

function testResolveTargetEntityForGrepFallsBackToProject(): void {
    const target = resolveAutowriteTargetEntity(
        {
            toolName: 'Grep',
            status: 'success',
            content: '',
            // no metadata.path → fall back to project entity
        },
        PROJECT_ENTITY,
    );
    assert.equal(target, PROJECT_ENTITY);
}

function testResolveTargetEntityForBashScansCommand(): void {
    const target = resolveAutowriteTargetEntity(
        {
            toolName: 'Bash',
            status: 'success',
            content: 'ok',
            metadata: { command: 'cat scripts/iranti-mcp.ts' },
        },
        PROJECT_ENTITY,
    );
    assert.equal(target, 'project/iranti/file/iranti_mcp');
}

function testResolveTargetEntityForWebFetch(): void {
    const target = resolveAutowriteTargetEntity(
        {
            toolName: 'WebFetch',
            status: 'success',
            content: 'page body',
            metadata: { url: 'https://vercel.com/docs/fluid-compute' },
        },
        PROJECT_ENTITY,
    );
    assert.equal(target, 'web/vercel_com');
}

function testResolveTargetEntityForWebSearch(): void {
    const target = resolveAutowriteTargetEntity(
        {
            toolName: 'WebSearch',
            status: 'success',
            content: 'results',
            metadata: { query: 'fluid compute pricing' },
        },
        PROJECT_ENTITY,
    );
    assert.ok(
        target.startsWith('web/search_'),
        `expected web/search_ prefix, got ${target}`,
    );
    assert.ok(target.includes('fluid'), `expected fluid in target, got ${target}`);
}

function testResolveTargetEntityFallsBackToSystemWhenNoProject(): void {
    const target = resolveAutowriteTargetEntity(
        {
            toolName: 'Read',
            status: 'success',
            content: '',
        },
        null,
    );
    assert.equal(target, 'system/tool_result_autowrite');
}

function testParseAutowriteEntityWellFormed(): void {
    const parsed = parseAutowriteEntity('project/iranti/file/foo');
    assert.equal(parsed.entityType, 'project');
    assert.equal(parsed.entityId, 'iranti/file/foo');
}

function testParseAutowriteEntityBareTypeFallback(): void {
    // Contract: a bare string with no slash is treated as a system-bucket
    // entityId. The literal default 'tool_result_autowrite' only fires when
    // the trimmed input is empty.
    const parsed = parseAutowriteEntity('widget');
    assert.equal(parsed.entityType, 'system');
    assert.equal(parsed.entityId, 'widget');
}

function testParseAutowriteEntityEmptyStringFallback(): void {
    const parsed = parseAutowriteEntity('');
    assert.equal(parsed.entityType, 'system');
    assert.equal(parsed.entityId, 'tool_result_autowrite');
}

function testBuildContextLabelWithAllFields(): void {
    const label = buildToolResultContextLabel({
        toolName: 'Bash',
        status: 'success',
        content: '',
        metadata: {
            path: 'src/foo.ts',
            command: 'cat src/foo.ts',
            durationMs: 120,
        },
    });
    assert.ok(label.includes('Path: src/foo.ts'));
    assert.ok(label.includes('Command: cat src/foo.ts'));
    assert.ok(label.includes('Duration: 120ms'));
}

function testBuildContextLabelNoMetadata(): void {
    const label = buildToolResultContextLabel({
        toolName: 'Read',
        status: 'success',
        content: '',
    });
    assert.equal(label, 'No metadata provided.');
}

function testNormalizeAutowriteFactAcceptsValidShape(): void {
    const normalized = normalizeAutowriteFact({
        key: 'valid_key',
        value: { nested: 'data' },
        summary: 'a useful summary',
        confidence: 88,
    });
    assert.ok(normalized);
    assert.equal(normalized!.key, 'valid_key');
    assert.equal(normalized!.summary, 'a useful summary');
    assert.equal(normalized!.confidence, 88);
    assert.deepEqual(normalized!.value, { nested: 'data' });
}

function testNormalizeAutowriteFactRejectsInvalidKey(): void {
    assert.equal(normalizeAutowriteFact({ key: 'has spaces', value: 1, summary: 's' }), null);
    assert.equal(normalizeAutowriteFact({ key: '', value: 1, summary: 's' }), null);
    assert.equal(normalizeAutowriteFact({ key: 'has/slash', value: 1, summary: 's' }), null);
}

function testNormalizeAutowriteFactRejectsMissingValue(): void {
    assert.equal(normalizeAutowriteFact({ key: 'k', summary: 's' }), null);
}

function testNormalizeAutowriteFactRejectsMissingSummary(): void {
    assert.equal(normalizeAutowriteFact({ key: 'k', value: 1, summary: '' }), null);
    assert.equal(normalizeAutowriteFact({ key: 'k', value: 1 }), null);
}

function testNormalizeAutowriteFactClampsConfidence(): void {
    const low = normalizeAutowriteFact({ key: 'k', value: 1, summary: 's', confidence: -10 });
    assert.equal(low!.confidence, 0);
    const high = normalizeAutowriteFact({ key: 'k', value: 1, summary: 's', confidence: 500 });
    assert.equal(high!.confidence, 100);
    const nan = normalizeAutowriteFact({ key: 'k', value: 1, summary: 's', confidence: Number.NaN });
    // NaN → default
    assert.equal(nan!.confidence, 70);
}

function testNormalizeAutowriteFactRejectsLongKey(): void {
    const longKey = 'a'.repeat(101);
    assert.equal(normalizeAutowriteFact({ key: longKey, value: 1, summary: 's' }), null);
}

// ─── Stubbed integration tests ───────────────────────────────────────────────

interface StubbedAttendant extends AttendantInstance {
    runToolResultAutowriteCallCount: number;
    lastAutowritePayload: ToolResultPayload | null;
    lastAutowriteBatchId: string | null;
    nextExtractionOutcome: ToolResultExtractionOutcome | null;
    nextWriteNudge: WriteNudge | null;
    maybeBuildWriteNudgeCallCount: number;
    observeCallCount: number;
    nextObserveFacts: FactInjection[];
}

function makeStubFacts(entityKeys: string[]): FactInjection[] {
    return entityKeys.map((key, i) => ({
        knowledgeEntryId: 3000 + i,
        entityKey: key,
        summary: `stub fact for ${key}`,
        value: { data: key },
        confidence: 85,
        source: 'test_stub',
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

function makeExtractionOutcome(overrides: Partial<ToolResultExtractionOutcome> = {}): ToolResultExtractionOutcome {
    return {
        toolName: 'Read',
        autowriteBatchId: 'test_batch_1',
        factsExtracted: 2,
        factsWritten: 2,
        skipped: [],
        writtenEntries: [
            { entity: 'project/iranti/file/server', key: 'auto_fact_1', summary: 'stub auto fact 1' },
            { entity: 'project/iranti/file/server', key: 'auto_fact_2', summary: 'stub auto fact 2' },
        ],
        targetEntity: 'project/iranti/file/server',
        durationMs: 12,
        ...overrides,
    };
}

function makeWriteNudge(overrides: Partial<WriteNudge> = {}): WriteNudge {
    return {
        reason: 'tool_cost_threshold',
        toolCallsSinceLastWrite: 5,
        threshold: 5,
        draftFacts: [
            {
                entity: 'project/iranti/file/server',
                key: 'auto_fact_1',
                summary: 'stub auto fact 1',
                fromTool: 'Read',
                autowriteBatchId: 'test_batch_1',
            },
        ],
        message: 'COMPLIANCE NUDGE: threshold crossed',
        ...overrides,
    };
}

async function makeAttendant(): Promise<StubbedAttendant> {
    const attendant = new AttendantInstance(AGENT_ID) as unknown as StubbedAttendant;
    const anyAttendant = attendant as any;

    attendant.runToolResultAutowriteCallCount = 0;
    attendant.lastAutowritePayload = null;
    attendant.lastAutowriteBatchId = null;
    attendant.nextExtractionOutcome = null;
    attendant.nextWriteNudge = null;
    attendant.maybeBuildWriteNudgeCallCount = 0;
    attendant.observeCallCount = 0;
    attendant.nextObserveFacts = [];

    anyAttendant.loadPersistedState = async () => null;
    anyAttendant.loadOperatingRules = async () => 'test operating rules';
    anyAttendant.inferTask = async () => 'M2 tool-result extraction testing';
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

    // Stub runToolResultAutowrite: record the call, return the preset outcome.
    anyAttendant.runToolResultAutowrite = async (
        payload: ToolResultPayload,
        batchId: string,
    ): Promise<ToolResultExtractionOutcome> => {
        attendant.runToolResultAutowriteCallCount++;
        attendant.lastAutowritePayload = payload;
        attendant.lastAutowriteBatchId = batchId;
        return attendant.nextExtractionOutcome ?? makeExtractionOutcome();
    };

    // Stub maybeBuildWriteNudge: count calls and return the preset nudge.
    anyAttendant.maybeBuildWriteNudge = (): WriteNudge | null => {
        attendant.maybeBuildWriteNudgeCallCount++;
        return attendant.nextWriteNudge;
    };

    await anyAttendant.handshake({
        task: 'M2 tool-result extraction testing',
        recentMessages: ['starting M2 tests'],
    });

    return attendant;
}

function makeAttendInput(overrides: Partial<AttendInput> = {}): AttendInput {
    return {
        latestMessage: 'test message',
        currentContext: 'test context',
        entityHints: [PROJECT_ENTITY],
        suppressEvents: true,
        phase: 'pre-response',
        ...overrides,
    };
}

function makeToolResult(overrides: Partial<ToolResultPayload> = {}): ToolResultPayload {
    return {
        toolName: 'Read',
        status: 'success',
        content: 'file contents for extraction',
        metadata: { path: 'src/api/server.ts' },
        ...overrides,
    };
}

// ─── Integration: runToolResultAutowrite invocation wiring ──────────────────

async function testToolResultTriggersAutowrite(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextExtractionOutcome = makeExtractionOutcome({ factsWritten: 3 });

    const result = await attendant.attend(makeAttendInput({
        toolResult: makeToolResult(),
    }));

    assert.equal(attendant.runToolResultAutowriteCallCount, 1, 'runToolResultAutowrite should be called exactly once');
    assert.ok(attendant.lastAutowritePayload, 'payload should be captured');
    assert.equal(attendant.lastAutowritePayload!.toolName, 'Read');
    assert.ok(attendant.lastAutowriteBatchId && attendant.lastAutowriteBatchId.length > 0, 'batch id should be assigned');

    assert.ok(result.toolResultExtraction, 'toolResultExtraction should be present on result');
    assert.equal(result.toolResultExtraction!.factsWritten, 3);
    assert.equal(result.toolResultExtraction!.toolName, 'Read');
}

async function testNoToolResultLeavesExtractionUndefined(): Promise<void> {
    const attendant = await makeAttendant();

    const result = await attendant.attend(makeAttendInput());

    assert.equal(attendant.runToolResultAutowriteCallCount, 0, 'runToolResultAutowrite should NOT be called without toolResult');
    assert.equal(result.toolResultExtraction, undefined);
}

async function testToolResultOnPostResponseIsSkipped(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextExtractionOutcome = makeExtractionOutcome();

    const result = await attendant.attend(makeAttendInput({
        toolResult: makeToolResult(),
        phase: 'post-response',
    }));

    // post-response gate: extractor must NOT run even if toolResult is supplied.
    assert.equal(attendant.runToolResultAutowriteCallCount, 0);
    // The post-response return path still includes the (undefined) field.
    assert.equal(result.toolResultExtraction, undefined);
}

async function testToolResultOnMidTurnRunsExtraction(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextExtractionOutcome = makeExtractionOutcome();

    await attendant.attend(makeAttendInput({
        toolResult: makeToolResult(),
        phase: 'mid-turn',
    }));

    assert.equal(attendant.runToolResultAutowriteCallCount, 1, 'mid-turn phase should still run extraction');
}

async function testToolResultExtractionSurfacesOnMainSuccessReturn(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextExtractionOutcome = makeExtractionOutcome({
        factsExtracted: 4,
        factsWritten: 4,
    });
    attendant.nextObserveFacts = makeStubFacts(['project/iranti/file/server/prior_fact']);

    const result = await attendant.attend(makeAttendInput({
        toolResult: makeToolResult(),
    }));

    assert.ok(result.toolResultExtraction, 'main success path should include extraction');
    assert.equal(result.toolResultExtraction!.factsWritten, 4);
    assert.equal(result.facts.length, 1, 'observe facts should still surface alongside extraction');
}

// ─── Integration: writeNudge threading + forced decision upgrade ────────────

async function testWriteNudgeThreadedOnMainSuccessPath(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextWriteNudge = makeWriteNudge();
    attendant.nextObserveFacts = makeStubFacts(['project/iranti/file/server/prior_fact']);

    const result = await attendant.attend(makeAttendInput());

    assert.ok(result.writeNudge, 'writeNudge should be present on main success path');
    assert.equal(result.writeNudge!.reason, 'tool_cost_threshold');
    assert.equal(result.writeNudge!.draftFacts.length, 1);
}

async function testWriteNudgeCalledOncePerAttend(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextWriteNudge = makeWriteNudge();
    attendant.nextObserveFacts = makeStubFacts(['project/iranti/file/server/prior_fact']);

    await attendant.attend(makeAttendInput());

    // The centralization is the point of M3: compute the nudge ONCE near the
    // top of attend() and reuse it across return paths. Multiple calls per
    // attend would double-trip the once-per-turn guard.
    assert.equal(
        attendant.maybeBuildWriteNudgeCallCount,
        1,
        `maybeBuildWriteNudge should be called exactly once per attend, got ${attendant.maybeBuildWriteNudgeCallCount}`,
    );
}

async function testWriteNudgeUndefinedWhenNoPressure(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextWriteNudge = null;
    attendant.nextObserveFacts = makeStubFacts(['project/iranti/file/server/prior_fact']);

    const result = await attendant.attend(makeAttendInput());

    assert.equal(result.writeNudge, undefined, 'writeNudge should be undefined when helper returns null');
}

async function testWriteNudgeForcesDecisionAndReason(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextWriteNudge = makeWriteNudge();
    attendant.nextObserveFacts = []; // no facts → normally reason=memory_checked_no_match

    // Also override decideMemoryNeed to "not needed" so we can see the nudge
    // upgrade the decision.
    const anyAttendant = attendant as any;
    anyAttendant.decideMemoryNeed = async () => ({
        needed: false,
        confidence: 0.1,
        method: 'heuristic',
        explanation: 'no_memory_reference_detected',
    });

    const result = await attendant.attend(makeAttendInput());

    assert.equal(
        result.decision.needed,
        true,
        'decision should be force-upgraded to needed:true when a nudge is present',
    );
    assert.equal(
        result.decision.explanation,
        'write_nudge_forced',
        'decision explanation should identify the nudge as the forcing reason',
    );
    assert.equal(
        result.reason,
        'forced',
        'reason should be forced on nudge-only injection with no observed facts',
    );
    assert.equal(
        result.shouldInject,
        true,
        'shouldInject must be true so the host surfaces the nudge',
    );
    assert.ok(result.writeNudge, 'writeNudge should be present on the forced path');
}

async function testWriteNudgeWithFactsStillMarksInjection(): Promise<void> {
    const attendant = await makeAttendant();
    attendant.nextWriteNudge = makeWriteNudge();
    attendant.nextObserveFacts = makeStubFacts(['project/iranti/file/server/prior_fact']);

    const result = await attendant.attend(makeAttendInput());

    assert.equal(result.shouldInject, true);
    assert.ok(result.facts.length > 0, 'observe facts still flow');
    assert.ok(result.writeNudge, 'nudge still threaded');
    // Reason should stay memory_needed_injected since we have real facts;
    // only the nudge-only branch switches to 'forced'.
    assert.equal(result.reason, 'memory_needed_injected');
}

// ─── Integration: extraction runs before decideMemoryNeed ───────────────────

async function testExtractionRunsBeforeDecideMemoryNeed(): Promise<void> {
    const attendant = await makeAttendant();
    const callOrder: string[] = [];

    const anyAttendant = attendant as any;
    const origRunToolResultAutowrite = anyAttendant.runToolResultAutowrite;
    anyAttendant.runToolResultAutowrite = async (...args: unknown[]) => {
        callOrder.push('runToolResultAutowrite');
        return origRunToolResultAutowrite(...args);
    };
    anyAttendant.decideMemoryNeed = async () => {
        callOrder.push('decideMemoryNeed');
        return {
            needed: true,
            confidence: 1,
            method: 'forced',
            explanation: 'test_forced_need',
        };
    };

    await attendant.attend(makeAttendInput({
        toolResult: makeToolResult(),
    }));

    const autowriteIdx = callOrder.indexOf('runToolResultAutowrite');
    const decideIdx = callOrder.indexOf('decideMemoryNeed');
    assert.notEqual(autowriteIdx, -1, 'runToolResultAutowrite should be called');
    assert.notEqual(decideIdx, -1, 'decideMemoryNeed should be called');
    assert.ok(
        autowriteIdx < decideIdx,
        `autowrite must run BEFORE decideMemoryNeed so counters influence the decision; got order: ${callOrder.join(' -> ')}`,
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
    console.log('running M2 tool-result autowrite tests');

    // Pure unit tests for module helpers
    await runTest('resolveAutowriteTargetEntity derives file entity for Read', testResolveTargetEntityForRead);
    await runTest('resolveAutowriteTargetEntity falls back to project for Grep without path', testResolveTargetEntityForGrepFallsBackToProject);
    await runTest('resolveAutowriteTargetEntity scans Bash command for path', testResolveTargetEntityForBashScansCommand);
    await runTest('resolveAutowriteTargetEntity derives web host for WebFetch', testResolveTargetEntityForWebFetch);
    await runTest('resolveAutowriteTargetEntity derives web/search entity for WebSearch', testResolveTargetEntityForWebSearch);
    await runTest('resolveAutowriteTargetEntity falls back to system bucket without project', testResolveTargetEntityFallsBackToSystemWhenNoProject);
    await runTest('parseAutowriteEntity handles well-formed entity strings', testParseAutowriteEntityWellFormed);
    await runTest('parseAutowriteEntity falls back on bare type', testParseAutowriteEntityBareTypeFallback);
    await runTest('parseAutowriteEntity falls back on empty string', testParseAutowriteEntityEmptyStringFallback);
    await runTest('buildToolResultContextLabel renders all metadata fields', testBuildContextLabelWithAllFields);
    await runTest('buildToolResultContextLabel reports when no metadata provided', testBuildContextLabelNoMetadata);
    await runTest('normalizeAutowriteFact accepts valid shape', testNormalizeAutowriteFactAcceptsValidShape);
    await runTest('normalizeAutowriteFact rejects invalid keys', testNormalizeAutowriteFactRejectsInvalidKey);
    await runTest('normalizeAutowriteFact rejects missing value', testNormalizeAutowriteFactRejectsMissingValue);
    await runTest('normalizeAutowriteFact rejects missing summary', testNormalizeAutowriteFactRejectsMissingSummary);
    await runTest('normalizeAutowriteFact clamps confidence to [0,100]', testNormalizeAutowriteFactClampsConfidence);
    await runTest('normalizeAutowriteFact rejects overly long key', testNormalizeAutowriteFactRejectsLongKey);

    // Integration tests: extraction wiring
    await runTest('toolResult triggers runToolResultAutowrite', testToolResultTriggersAutowrite);
    await runTest('no toolResult leaves toolResultExtraction undefined', testNoToolResultLeavesExtractionUndefined);
    await runTest('post-response phase skips extraction', testToolResultOnPostResponseIsSkipped);
    await runTest('mid-turn phase runs extraction', testToolResultOnMidTurnRunsExtraction);
    await runTest('toolResultExtraction surfaces on main success return', testToolResultExtractionSurfacesOnMainSuccessReturn);

    // Integration tests: write nudge + forced decision
    await runTest('writeNudge threads through main success return', testWriteNudgeThreadedOnMainSuccessPath);
    await runTest('maybeBuildWriteNudge called exactly once per attend', testWriteNudgeCalledOncePerAttend);
    await runTest('writeNudge undefined when helper returns null', testWriteNudgeUndefinedWhenNoPressure);
    await runTest('writeNudge forces decision and reason on nudge-only injection', testWriteNudgeForcesDecisionAndReason);
    await runTest('writeNudge coexists with observed facts (reason stays memory_needed_injected)', testWriteNudgeWithFactsStillMarksInjection);

    // Integration: ordering
    await runTest('extraction runs before decideMemoryNeed', testExtractionRunsBeforeDecideMemoryNeed);

    if (process.exitCode && process.exitCode !== 0) {
        console.error('M2 tool-result autowrite tests FAILED');
    } else {
        console.log('M2 tool-result autowrite tests passed');
    }
}

main().catch((error) => {
    console.error('test harness crashed', error);
    process.exitCode = 1;
});
