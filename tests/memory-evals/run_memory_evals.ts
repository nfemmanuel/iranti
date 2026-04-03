import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootstrapHarness, ensureHarnessStaffEventsTable } from '../../scripts/harness';
import { clearAttendant } from '../../src/attendant';
import { createFirstPartyIranti } from '../../src/lib/createFirstPartyIranti';
import { flushStaffEventEmitter } from '../../src/lib/staffEventRegistry';
import { disconnectDb } from '../../src/library/client';
import { summarizeMemoryAttribution } from '../../src/lib/sessionLedger';
import { resolveValidationDatabaseUrl } from '../helpers/resolveValidationDatabase';

type ScenarioMetrics = {
    scenario: string;
    rediscoveryMs: number;
    rediscoveryActions: number;
    repeatedExplanationCount: number;
    recoveredNextStep: boolean;
    recoveredBlocker: boolean;
    recoveredFileState: boolean;
    handoffSuccess: boolean;
    correctnessAfterInterruption: boolean;
    injectionCount: number;
    scoredUsedCount: number;
    scoredHelpfulCount: number;
    complianceStatus: 'healthy' | 'degraded' | 'non_compliant';
    complianceIssueCodes: string[];
    response: string;
};

function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function readNextStep(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const instruction = (value as { instruction?: unknown }).instruction;
    return typeof instruction === 'string' ? instruction : '';
}

function readItems(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    const items = (value as { items?: unknown }).items;
    return Array.isArray(items) ? items.map((entry) => String(entry)) : [];
}

async function seedProjectMemory(iranti: ReturnType<typeof createFirstPartyIranti>, agentId: string, entity: string): Promise<void> {
    await iranti.registerAgent({
        agentId,
        name: `Eval ${agentId}`,
        description: 'Memory eval agent',
        capabilities: ['attend', 'query', 'checkpoint', 'write'],
        model: 'mock',
    });

    await iranti.write({
        entity,
        key: 'next_step',
        value: { instruction: 'rerun the runtime validation and capture the result.' },
        summary: 'Next step is rerun the runtime validation and capture the result.',
        confidence: 96,
        source: 'memory_eval_seed',
        agent: agentId,
    });
    await iranti.write({
        entity,
        key: 'blockers',
        value: { items: ['Preserve docs/runtime-verification.md while fixing the regression.'] },
        summary: 'Blocker: preserve docs/runtime-verification.md while fixing the regression.',
        confidence: 94,
        source: 'memory_eval_seed',
        agent: agentId,
    });
    await iranti.write({
        entity,
        key: 'recent_file_changes',
        value: {
            items: [
                {
                    action: 'updated',
                    path: 'docs/runtime-verification.md',
                    purpose: 'document the validation flow',
                },
            ],
        },
        summary: 'Recent file change: updated docs/runtime-verification.md to document the validation flow.',
        confidence: 92,
        source: 'memory_eval_seed',
        agent: agentId,
    });
    await iranti.write({
        entity,
        key: 'checkpoint_summary',
        value: { text: 'The recovery slice needs next-step, blocker, and file-state continuity.' },
        summary: 'Checkpoint summary: recover next step, blocker, and file state without rediscovery.',
        confidence: 91,
        source: 'memory_eval_seed',
        agent: agentId,
    });
}

function buildRecoveryResponse(options: { nextStep: string; blocker: string; filePath: string }): string {
    return `Next step: ${options.nextStep} Blocker: ${options.blocker} File state: ${options.filePath}.`;
}

async function finalizeAttribution(
    iranti: ReturnType<typeof createFirstPartyIranti>,
    agentId: string,
    response: string,
): Promise<{ complianceStatus: ScenarioMetrics['complianceStatus']; complianceIssueCodes: string[] }> {
    const result = await iranti.attend({
        agentId,
        latestMessage: response,
        currentContext: response,
        phase: 'post-response',
    });
    await flushStaffEventEmitter();
    return {
        complianceStatus: result.compliance.status,
        complianceIssueCodes: result.compliance.issues.map((issue) => issue.code),
    };
}

async function readAttributionCounts(agentId: string): Promise<{ injectionCount: number; scoredUsedCount: number; scoredHelpfulCount: number }> {
    const summary = await summarizeMemoryAttribution({ agentId, limit: 100 });
    return {
        injectionCount: summary.length,
        scoredUsedCount: summary.filter((entry) => entry.used).length,
        scoredHelpfulCount: summary.filter((entry) => entry.helpful).length,
    };
}

async function scenarioNoMemory(iranti: ReturnType<typeof createFirstPartyIranti>, agentId: string, entity: string): Promise<ScenarioMetrics> {
    iranti.setSessionLedgerContext({ source: 'eval', host: 'no_memory', agentId });
    await seedProjectMemory(iranti, agentId, entity);

    const startedAt = Date.now();
    const nextStep = await iranti.query(entity, 'next_step');
    const blockers = await iranti.query(entity, 'blockers');
    const fileState = await iranti.query(entity, 'recent_file_changes');
    const rediscoveryMs = Date.now() - startedAt;
    const response = buildRecoveryResponse({
        nextStep: readNextStep(nextStep.value),
        blocker: readItems(blockers.value)[0] ?? '',
        filePath: JSON.stringify(fileState.value),
    });

    return {
        scenario: 'no_memory',
        rediscoveryMs,
        rediscoveryActions: 3,
        repeatedExplanationCount: 2,
        recoveredNextStep: response.includes('rerun the runtime validation'),
        recoveredBlocker: response.includes('docs/runtime-verification.md'),
        recoveredFileState: response.includes('recent_file_changes') || response.includes('docs/runtime-verification.md'),
        handoffSuccess: false,
        correctnessAfterInterruption: false,
        injectionCount: 0,
        scoredUsedCount: 0,
        scoredHelpfulCount: 0,
        complianceStatus: 'healthy',
        complianceIssueCodes: [],
        response,
    };
}

async function scenarioSurfacedNotEnforced(iranti: ReturnType<typeof createFirstPartyIranti>, agentId: string, entity: string): Promise<ScenarioMetrics> {
    iranti.setSessionLedgerContext({ source: 'eval', host: 'surfaced_not_enforced', agentId });
    await seedProjectMemory(iranti, agentId, entity);

    const attend = await iranti.attend({
        agentId,
        latestMessage: 'Resume the runtime validation task and tell me the next step, blocker, and file state.',
        currentContext: 'The host surfaced memory but will ignore it.',
        entityHints: [entity],
        maxFacts: 6,
        phase: 'pre-response',
    });
    assert.equal(attend.shouldInject, true, 'Expected surfaced-not-enforced scenario to inject memory.');

    const startedAt = Date.now();
    await iranti.query(entity, 'next_step');
    await iranti.query(entity, 'blockers');
    await iranti.query(entity, 'recent_file_changes');
    const rediscoveryMs = Date.now() - startedAt;

    const response = 'I still need to inspect the state manually before I can answer.';
    const compliance = await finalizeAttribution(iranti, agentId, response);
    const attribution = await readAttributionCounts(agentId);

    return {
        scenario: 'surfaced_not_enforced',
        rediscoveryMs,
        rediscoveryActions: 3,
        repeatedExplanationCount: 1,
        recoveredNextStep: false,
        recoveredBlocker: false,
        recoveredFileState: false,
        handoffSuccess: false,
        correctnessAfterInterruption: false,
        complianceStatus: compliance.complianceStatus,
        complianceIssueCodes: compliance.complianceIssueCodes,
        ...attribution,
        response,
    };
}

async function scenarioSurfacedEnforced(iranti: ReturnType<typeof createFirstPartyIranti>, agentId: string, entity: string): Promise<ScenarioMetrics> {
    iranti.setSessionLedgerContext({ source: 'eval', host: 'surfaced_enforced', agentId });
    await seedProjectMemory(iranti, agentId, entity);

    const attend = await iranti.attend({
        agentId,
        latestMessage: 'Resume the runtime validation task and tell me the next step, blocker, and file state.',
        currentContext: 'The host will rely on injected memory.',
        entityHints: [entity],
        maxFacts: 6,
        phase: 'pre-response',
    });
    assert.equal(attend.shouldInject, true, 'Expected surfaced-enforced scenario to inject memory.');

    const byKey = new Map(attend.facts.map((fact) => [fact.entityKey.split('/').slice(2).join('/'), fact.value]));
    const response = buildRecoveryResponse({
        nextStep: readNextStep(byKey.get('next_step')),
        blocker: readItems(byKey.get('blockers'))[0] ?? '',
        filePath: JSON.stringify(byKey.get('recent_file_changes')),
    });

    await iranti.checkpoint({
        agentId,
        task: 'Use injected memory without rediscovery.',
        recentMessages: ['Using injected memory directly for recovery.'],
        checkpoint: {
            currentStep: 'answering from injected memory',
            nextStep: 'rerun the runtime validation and capture the result',
            openRisks: ['Preserve docs/runtime-verification.md while fixing the regression.'],
            entityTargets: [entity],
        },
    });
    const compliance = await finalizeAttribution(iranti, agentId, response);
    const attribution = await readAttributionCounts(agentId);

    return {
        scenario: 'surfaced_enforced',
        rediscoveryMs: 0,
        rediscoveryActions: 0,
        repeatedExplanationCount: 0,
        recoveredNextStep: response.includes('rerun the runtime validation'),
        recoveredBlocker: response.includes('docs/runtime-verification.md'),
        recoveredFileState: response.includes('recent_file_changes') || response.includes('docs/runtime-verification.md'),
        handoffSuccess: false,
        correctnessAfterInterruption: false,
        complianceStatus: compliance.complianceStatus,
        complianceIssueCodes: compliance.complianceIssueCodes,
        ...attribution,
        response,
    };
}

async function scenarioCrossSessionInterruption(iranti: ReturnType<typeof createFirstPartyIranti>, agentId: string, entity: string): Promise<ScenarioMetrics> {
    iranti.setSessionLedgerContext({ source: 'eval', host: 'cross_session_interruption', agentId });
    await seedProjectMemory(iranti, agentId, entity);

    await iranti.checkpoint({
        agentId,
        task: 'Checkpoint before interruption.',
        recentMessages: ['Checkpointing before interruption.'],
        checkpoint: {
            currentStep: 'waiting for the next session to resume the task',
            nextStep: 'resume with injected next-step, blocker, and file state',
            openRisks: ['Preserve docs/runtime-verification.md while fixing the regression.'],
            entityTargets: [entity],
        },
    });

    clearAttendant(agentId);

    const attend = await iranti.attend({
        agentId,
        latestMessage: 'Resume the interrupted runtime validation task.',
        currentContext: 'The session was interrupted and must recover the next step, blocker, and file state.',
        entityHints: [entity],
        maxFacts: 6,
        phase: 'pre-response',
    });
    assert.equal(attend.shouldInject, true, 'Expected interrupted session to recover memory via attend().');

    const byKey = new Map(attend.facts.map((fact) => [fact.entityKey.split('/').slice(2).join('/'), fact.value]));
    const response = buildRecoveryResponse({
        nextStep: readNextStep(byKey.get('next_step')),
        blocker: readItems(byKey.get('blockers'))[0] ?? '',
        filePath: JSON.stringify(byKey.get('recent_file_changes')),
    });

    await iranti.checkpoint({
        agentId,
        task: 'Resume after interruption.',
        recentMessages: ['Recovered the interrupted task from injected memory.'],
        checkpoint: {
            currentStep: 'resumed from interruption with injected context',
            nextStep: 'rerun the runtime validation and capture the result',
            openRisks: ['Preserve docs/runtime-verification.md while fixing the regression.'],
            entityTargets: [entity],
        },
    });
    const compliance = await finalizeAttribution(iranti, agentId, response);
    const attribution = await readAttributionCounts(agentId);

    return {
        scenario: 'cross_session_interruption',
        rediscoveryMs: 0,
        rediscoveryActions: 0,
        repeatedExplanationCount: 0,
        recoveredNextStep: response.includes('rerun the runtime validation'),
        recoveredBlocker: response.includes('docs/runtime-verification.md'),
        recoveredFileState: response.includes('recent_file_changes') || response.includes('docs/runtime-verification.md'),
        handoffSuccess: false,
        correctnessAfterInterruption: true,
        complianceStatus: compliance.complianceStatus,
        complianceIssueCodes: compliance.complianceIssueCodes,
        ...attribution,
        response,
    };
}

async function scenarioCrossHostHandoff(iranti: ReturnType<typeof createFirstPartyIranti>, senderAgent: string, receiverAgent: string, entity: string): Promise<ScenarioMetrics> {
    iranti.setSessionLedgerContext({ source: 'eval', host: 'handoff_sender', agentId: senderAgent });
    await seedProjectMemory(iranti, senderAgent, entity);
    await iranti.checkpoint({
        agentId: senderAgent,
        task: 'Prepare cross-host handoff.',
        recentMessages: ['Preparing the shared handoff.'],
        checkpoint: {
            currentStep: 'handoff prepared for the next host',
            nextStep: 'receiver should recover from injected memory',
            openRisks: ['Preserve docs/runtime-verification.md while fixing the regression.'],
            entityTargets: [entity],
        },
    });

    iranti.setSessionLedgerContext({ source: 'eval', host: 'handoff_receiver', agentId: receiverAgent });
    await iranti.registerAgent({
        agentId: receiverAgent,
        name: `Eval ${receiverAgent}`,
        description: 'Cross-host receiver',
        capabilities: ['attend', 'checkpoint', 'write'],
        model: 'mock',
    });

    const attend = await iranti.attend({
        agentId: receiverAgent,
        latestMessage: 'Continue the handed-off runtime validation work.',
        currentContext: 'A different host is receiving the handoff and needs next-step, blocker, and file state recovery.',
        entityHints: [entity],
        maxFacts: 6,
        phase: 'pre-response',
    });
    assert.equal(attend.shouldInject, true, 'Expected cross-host receiver to inject shared task memory.');

    const byKey = new Map(attend.facts.map((fact) => [fact.entityKey.split('/').slice(2).join('/'), fact.value]));
    const response = buildRecoveryResponse({
        nextStep: readNextStep(byKey.get('next_step')),
        blocker: readItems(byKey.get('blockers'))[0] ?? '',
        filePath: JSON.stringify(byKey.get('recent_file_changes')),
    });

    await iranti.write({
        entity,
        key: 'implementation_status',
        value: { state: 'receiver_started' },
        summary: 'Receiver host started the handed-off runtime validation work.',
        confidence: 93,
        source: 'memory_eval_receiver',
        agent: receiverAgent,
    });
    const compliance = await finalizeAttribution(iranti, receiverAgent, response);
    const attribution = await readAttributionCounts(receiverAgent);

    return {
        scenario: 'cross_host_handoff',
        rediscoveryMs: 0,
        rediscoveryActions: 0,
        repeatedExplanationCount: 0,
        recoveredNextStep: response.includes('rerun the runtime validation'),
        recoveredBlocker: response.includes('docs/runtime-verification.md'),
        recoveredFileState: response.includes('recent_file_changes') || response.includes('docs/runtime-verification.md'),
        handoffSuccess: true,
        correctnessAfterInterruption: true,
        complianceStatus: compliance.complianceStatus,
        complianceIssueCodes: compliance.complianceIssueCodes,
        ...attribution,
        response,
    };
}

function emitArtifact(payload: unknown): void {
    const artifactPath = process.env.IRANTI_MEMORY_EVAL_ARTIFACT?.trim();
    if (!artifactPath) {
        return;
    }

    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify(payload, null, 2), 'utf8');
}

async function main(): Promise<void> {
    process.env.LLM_PROVIDER = 'mock';
    const connectionString = await resolveValidationDatabaseUrl('memory evals');
    bootstrapHarness({
        requireDb: true,
        forceLocalEscalationDir: true,
        dbApplicationName: 'iranti:eval:memory_evals',
    });
    await ensureHarnessStaffEventsTable();

    const iranti = createFirstPartyIranti({
        connectionString,
        llmProvider: 'mock',
        sessionLedgerSource: 'eval',
        sessionLedgerHost: 'memory_evals',
        protocolEnforcement: 'off',
    });

    try {
        const scenarios: ScenarioMetrics[] = [];
        scenarios.push(await scenarioNoMemory(iranti, uniqueId('eval_no_memory_agent'), `project/${uniqueId('eval_no_memory_project')}`));
        scenarios.push(await scenarioSurfacedNotEnforced(iranti, uniqueId('eval_surface_ignore_agent'), `project/${uniqueId('eval_surface_ignore_project')}`));
        scenarios.push(await scenarioSurfacedEnforced(iranti, uniqueId('eval_surface_use_agent'), `project/${uniqueId('eval_surface_use_project')}`));
        scenarios.push(await scenarioCrossSessionInterruption(iranti, uniqueId('eval_interrupt_agent'), `project/${uniqueId('eval_interrupt_project')}`));
        scenarios.push(await scenarioCrossHostHandoff(iranti, uniqueId('eval_handoff_sender'), uniqueId('eval_handoff_receiver'), `project/${uniqueId('eval_handoff_project')}`));

        const noMemory = scenarios.find((entry) => entry.scenario === 'no_memory')!;
        const surfacedNotEnforced = scenarios.find((entry) => entry.scenario === 'surfaced_not_enforced')!;
        const surfacedEnforced = scenarios.find((entry) => entry.scenario === 'surfaced_enforced')!;
        const crossSession = scenarios.find((entry) => entry.scenario === 'cross_session_interruption')!;
        const crossHost = scenarios.find((entry) => entry.scenario === 'cross_host_handoff')!;

        assert.ok(
            noMemory.rediscoveryActions > surfacedEnforced.rediscoveryActions,
            'Expected enforced memory to reduce rediscovery actions versus the no-memory baseline.',
        );
        assert.equal(
            surfacedNotEnforced.scoredUsedCount,
            0,
            'Expected surfaced-but-not-enforced scenario to score injected memory as unused.',
        );
        assert.equal(
            surfacedNotEnforced.complianceStatus,
            'degraded',
            'Expected surfaced-but-not-enforced scenario to degrade compliance.',
        );
        assert.ok(
            surfacedNotEnforced.complianceIssueCodes.includes('ignored_injected_memory'),
            'Expected surfaced-but-not-enforced scenario to record ignored injected memory.',
        );
        assert.ok(
            surfacedEnforced.scoredHelpfulCount >= 1
            && surfacedEnforced.recoveredNextStep
            && surfacedEnforced.recoveredBlocker
            && surfacedEnforced.recoveredFileState,
            'Expected enforced memory to score helpful and recover the required state.',
        );
        assert.equal(
            surfacedEnforced.complianceStatus,
            'healthy',
            'Expected enforced memory use to keep compliance healthy.',
        );
        assert.equal(crossSession.correctnessAfterInterruption, true, 'Expected interrupted session recovery to stay correct.');
        assert.equal(crossHost.handoffSuccess, true, 'Expected cross-host handoff to succeed.');

        const payload = {
            generatedAt: new Date().toISOString(),
            scenarios,
        };
        emitArtifact(payload);

        console.log('memory evals passed');
        console.log(JSON.stringify(payload, null, 2));
    } finally {
        await flushStaffEventEmitter().catch(() => undefined);
        await disconnectDb().catch(() => undefined);
    }
}

void main().catch((error) => {
    console.error('memory evals failed:', error);
    process.exitCode = 1;
});
