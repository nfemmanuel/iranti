import { AttendantInstance, type WorkingMemoryBrief } from '../../src/attendant/AttendantInstance';
import express from 'express';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { memoryRoutes } from '../../src/api/routes/memory';

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function makePersistedBrief(agentId: string, sessionId: string, task: string): WorkingMemoryBrief {
    const heartbeatAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    return {
        agentId,
        operatingRules: 'Persist checkpoints before expensive work.',
        inferredTaskType: task,
        workingMemory: [],
        sessionStarted: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        briefGeneratedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        contextCallCount: 3,
        sessionCheckpoint: {
            sessionId,
            task,
            taskFingerprint: task.toLowerCase(),
            status: 'active',
            startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
            lastHeartbeatAt: heartbeatAt,
            updatedAt: heartbeatAt,
            checkpoint: {
                currentStep: 'drafting launch checklist',
                nextStep: 'collect approvals',
                openRisks: ['Legal review pending'],
                recentOutputs: ['Outlined launch milestones'],
                entityTargets: ['project/project_atlas'],
                notes: 'Interrupted before sign-off.',
            },
        },
        sessionRecovery: null,
    };
}

async function main(): Promise<void> {
    const agentId = 'session_recovery_agent_unit_test';
    const task = 'Prepare the launch checklist for Project Atlas';
    const sessionId = 'session_recovery_unit_test';

    const attendant: any = new AttendantInstance(agentId);
    attendant.loadPersistedState = async () => makePersistedBrief(agentId, sessionId, task);
    attendant.loadOperatingRules = async () => 'Persist checkpoints before expensive work.';
    attendant.inferTask = async () => task;
    attendant.buildWorkingMemory = async () => [];
    attendant.loadSessionLedgerLearnings = async () => ([
        {
            actionType: 'host_failure',
            summary: 'codex_vscode failure: initialize timed out',
            timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            source: 'mcp',
            host: 'codex_vscode',
            sessionId,
            entityKey: null,
            reason: 'initialize_timeout',
        },
    ]);
    attendant.persistState = async () => {};

    const recoveredBrief = await attendant.handshake({
        task,
        recentMessages: ['Need to continue the launch checklist.'],
    });

    expect(recoveredBrief.sessionRecovery?.available === true, 'Expected recovery metadata to be available.');
    expect(recoveredBrief.sessionRecovery?.recommendation === 'resume', 'Expected resume recommendation.');
    expect(recoveredBrief.sessionRecovery?.matchedCurrentTask === true, 'Expected the returning task to match.');
    expect(recoveredBrief.sessionCheckpoint?.status === 'interrupted', 'Expected the stale checkpoint to be marked interrupted.');
    expect(recoveredBrief.sessionCheckpoint?.checkpoint.currentStep === 'drafting launch checklist', 'Expected checkpoint step to round-trip.');
    expect((recoveredBrief.sessionLedgerLearnings?.length ?? 0) === 1, 'Expected handshake to surface bounded session-ledger learnings.');
    expect(
        recoveredBrief.workingMemory.some((entry: { entityKey: string }) => entry.entityKey === 'system/session_ledger/recent_learning_1'),
        'Expected handshake to append a synthetic working-memory entry for recent ledger learnings.'
    );

    const inspected = await attendant.inspectSession({
        task,
        recentMessages: ['Need to continue the launch checklist.'],
    });
    expect(inspected.hasCheckpoint === true, 'Expected inspectSession() to report a checkpoint.');
    expect(inspected.sessionCheckpoint?.status === 'active', 'Expected inspectSession() to reflect the persisted checkpoint state.');
    expect(inspected.sessionRecovery?.recommendation === 'resume', 'Expected inspectSession() to derive a resume recommendation.');
    expect(inspected.summary.operatorState === 'interrupted', 'Expected inspectSession() summary to classify stale active checkpoints as interrupted.');
    expect(inspected.summary.isStale === true, 'Expected inspectSession() summary to flag the stale checkpoint.');
    expect(inspected.summary.checkpointSummary?.openRiskCount === 1, 'Expected inspectSession() summary to expose checkpoint risk counts.');

    const unscopedInspection = await attendant.inspectSession();
    expect(unscopedInspection.hasCheckpoint === true, 'Expected inspectSession() without task context to keep exposing the checkpoint.');
    expect(unscopedInspection.sessionRecovery === null, 'Expected inspectSession() without task context to omit task-match recovery advice.');
    expect(unscopedInspection.summary.operatorState === 'interrupted', 'Expected inspectSession() summary to remain operator-interrupted without task context.');

    const routeApp = express();
    routeApp.use(express.json());
    routeApp.use('/memory', memoryRoutes({
        inspectSession: async (input: { agentId: string; task?: string; recentMessages?: string[] }) => ({
            agentId: input.agentId,
            hasCheckpoint: true,
            sessionCheckpoint: {
                sessionId,
                task,
                taskFingerprint: task.toLowerCase(),
                status: 'active',
                startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
                lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                checkpoint: {
                    currentStep: 'drafting launch checklist',
                    nextStep: 'collect approvals',
                    openRisks: ['Legal review pending'],
                    recentOutputs: ['Outlined launch milestones'],
                    entityTargets: ['project/project_atlas'],
                    notes: 'Interrupted before sign-off.',
                },
            },
            sessionRecovery: input.task ? {
                available: true,
                sessionId,
                task,
                taskFingerprint: task.toLowerCase(),
                matchedCurrentTask: true,
                matchConfidence: 100,
                recommendation: 'resume',
                summary: 'Resume the launch checklist.',
                lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                interruptedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
                checkpoint: {
                    currentStep: 'drafting launch checklist',
                    nextStep: 'collect approvals',
                    openRisks: ['Legal review pending'],
                    recentOutputs: ['Outlined launch milestones'],
                    entityTargets: ['project/project_atlas'],
                    notes: 'Interrupted before sign-off.',
                },
            } : null,
            persistedBriefGeneratedAt: new Date().toISOString(),
            summary: {
                agentId: input.agentId,
                hasCheckpoint: true,
                sessionId,
                task,
                status: 'active',
                operatorState: 'interrupted',
                startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
                lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                interruptedAt: null,
                completedAt: null,
                abandonedAt: null,
                resumedAt: null,
                isStale: true,
                persistedBriefGeneratedAt: new Date().toISOString(),
                checkpointSummary: {
                    currentStep: 'drafting launch checklist',
                    nextStep: 'collect approvals',
                    openRiskCount: 1,
                    entityTargetCount: 1,
                },
            },
        }),
        listSessions: async () => [],
    } as any));

    const server = createServer(routeApp);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    try {
        const address = server.address() as AddressInfo;
        const response = await fetch(
            `http://127.0.0.1:${address.port}/memory/session/${agentId}?task=${encodeURIComponent(task)}&recentMessages=${encodeURIComponent('Need to continue the launch checklist.')}&recentMessages=${encodeURIComponent('Resume from the saved checkpoint.')}`
        );
        expect(response.ok, `Expected route inspection request to succeed, got ${response.status}.`);
        const routeInspection = await response.json() as {
            agentId: string;
            sessionRecovery: { recommendation: string } | null;
            summary: { operatorState: string };
        };
        expect(routeInspection.agentId === agentId, 'Expected route inspection to preserve the requested agentId.');
        expect(routeInspection.sessionRecovery?.recommendation === 'resume', 'Expected route inspection to forward task context into recovery recommendation building.');
        expect(routeInspection.summary.operatorState === 'interrupted', 'Expected route inspection summary to remain operator-oriented.');
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    const liveAttendant: any = new AttendantInstance(agentId);
    liveAttendant.brief = recoveredBrief;
    liveAttendant.persistState = async () => {};

    const checkpointedBrief = await liveAttendant.checkpoint({
        task,
        recentMessages: ['Continuing from the recovery point.'],
        checkpoint: {
            currentStep: 'collect approvals',
            nextStep: 'publish checklist',
            openRisks: ['Waiting on final approval'],
            recentOutputs: ['Updated the checklist draft'],
            entityTargets: ['project/project_atlas'],
        },
        sessionId,
        heartbeatAt: new Date().toISOString(),
    });

    expect(checkpointedBrief.sessionCheckpoint?.status === 'active', 'Expected checkpoint() to activate the session.');
    expect(checkpointedBrief.sessionRecovery === null, 'Expected checkpoint() to clear recovery metadata.');

    const resumedBrief = await liveAttendant.resumeSession({ sessionId });
    expect(resumedBrief.sessionCheckpoint?.status === 'active', 'Expected resumeSession() to keep the session active.');

    const completedBrief = await liveAttendant.completeSession({ sessionId });
    expect(completedBrief.sessionCheckpoint?.status === 'completed', 'Expected completeSession() to finalize the session.');

    const abandonedBrief = await liveAttendant.abandonSession({ sessionId });
    expect(abandonedBrief.sessionCheckpoint?.status === 'abandoned', 'Expected abandonSession() to preserve the checkpoint as abandoned.');

    console.log('Session recovery test complete');
    console.log('-----------------------------');
    console.log(`recovery recommendation: ${recoveredBrief.sessionRecovery?.recommendation}`);
    console.log(`checkpoint status after checkpoint(): ${checkpointedBrief.sessionCheckpoint?.status}`);
    console.log(`status after resume(): ${resumedBrief.sessionCheckpoint?.status}`);
    console.log(`status after complete(): ${completedBrief.sessionCheckpoint?.status}`);
    console.log(`status after abandon(): ${abandonedBrief.sessionCheckpoint?.status}`);
    console.log(`inspectSession recommendation: ${inspected.sessionRecovery?.recommendation}`);
}

main().catch((error: unknown) => {
    if (error instanceof Error) {
        console.error(`Session recovery test failed: ${error.message}`);
    } else {
        console.error(`Session recovery test failed: ${String(error)}`);
    }
    process.exit(1);
});
