import { AttendantInstance, type WorkingMemoryBrief } from '../../src/attendant/AttendantInstance';

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

    const inspected = await attendant.inspectSession({
        task,
        recentMessages: ['Need to continue the launch checklist.'],
    });
    expect(inspected.hasCheckpoint === true, 'Expected inspectSession() to report a checkpoint.');
    expect(inspected.sessionCheckpoint?.status === 'active', 'Expected inspectSession() to reflect the persisted checkpoint state.');
    expect(inspected.sessionRecovery?.recommendation === 'resume', 'Expected inspectSession() to derive a resume recommendation.');

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
