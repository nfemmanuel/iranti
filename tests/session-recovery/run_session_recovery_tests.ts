import { AttendantInstance, type WorkingMemoryBrief } from '../../src/attendant/AttendantInstance';
import express from 'express';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { memoryRoutes } from '../../src/api/routes/memory';
import { bootstrapHarness } from '../../scripts/harness';

bootstrapHarness();

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
    attendant.loadSessionLedgerSignals = async () => ({
        learnings: [
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
        ],
        profile: null,
    });
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

    const advisoryAttendant: any = new AttendantInstance(agentId);
    advisoryAttendant.loadPersistedState = async () => null;
    advisoryAttendant.loadOperatingRules = async () => 'Persist checkpoints before expensive work.';
    advisoryAttendant.inferTask = async () => 'Continue the launch checklist and recover the next step.';
    advisoryAttendant.buildWorkingMemory = async () => [];
    advisoryAttendant.loadSessionLedgerSignals = async () => ({
        learnings: [
            {
                actionType: 'persistence_lesson',
                summary: 'Recent persistence lesson: project/project_atlas/next_step is being handed off through shared checkpoints.',
                timestamp: new Date(Date.now() - 60 * 1000).toISOString(),
                source: 'cli',
                host: 'plain_cli',
                sessionId,
                entityKey: 'project/project_atlas/next_step',
                reason: null,
                category: 'persistence',
                evidenceActionTypes: ['checkpoint_written'],
            },
        ],
        profile: {
            scopesUsed: ['task', 'global'],
            preferMemoryForAmbiguousTurns: true,
            priorityKeys: ['next_step', 'open_risks'],
            summaries: ['Recent persistence lesson: project/project_atlas/next_step is being handed off through shared checkpoints.'],
            matchedTaskType: 'Continue the launch checklist and recover the next step.',
            needsCheckpointReminder: true,
            checkpointReminder: 'Recent compliance lesson: plain_cli left an under-logged run after substantial retrieval work without a checkpoint or durable write. This is non-compliant for Iranti; before the next pause, write what you found, what worked, and what remains risky and what happens next and checkpoint shared progress.',
            missingWriteCategories: ['findings', 'validated_results', 'risks_and_next_steps'],
        },
    });
    advisoryAttendant.persistState = async () => {};

    let advisoryObservePriorityKeys: string[] = [];
    advisoryAttendant.observe = async (input: { priorityKeys?: string[] }) => {
        advisoryObservePriorityKeys = input.priorityKeys ?? [];
        return {
            facts: [
                {
                    entityKey: 'project/project_atlas/next_step',
                    summary: 'next step is collect approvals',
                    value: { instruction: 'collect approvals' },
                    confidence: 95,
                    source: 'AttendantCheckpoint',
                },
            ],
            entitiesDetected: ['project/project_atlas'],
            alreadyPresent: 0,
            totalFound: 1,
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
    };

    await advisoryAttendant.handshake({
        task: 'Continue the launch checklist and recover the next step.',
        recentMessages: ['We need to keep the launch moving.'],
    });
    expect(
        advisoryAttendant.getBrief()?.operatingRules.includes('under-logged run'),
        'Expected handshake() to append a stricter checkpoint-discipline reminder to the operating rules when the advisory profile calls for it.'
    );
    expect(
        advisoryAttendant.getBrief()?.operatingRules.includes('what you found, what worked, and what remains risky and what happens next'),
        'Expected handshake() to spell out the missing write categories for the under-logged run.'
    );

    const advisoryAttend = await advisoryAttendant.attend({
        latestMessage: 'Checklist?',
        currentContext: '',
        entityHints: ['project/project_atlas'],
        suppressEvents: true,
    });
    expect(
        advisoryAttend.usageGuidance.tool === 'attend',
        'Expected attend() to return explicit usage guidance.'
    );
    // expectedCallSequence was removed from attend responses — protocol now lives in IRANTI.md.
    // Verify the field is absent or empty (backward compat: older servers may still send it).
    expect(
        !advisoryAttend.usageGuidance.expectedCallSequence || advisoryAttend.usageGuidance.expectedCallSequence.length === 0,
        'Expected attend() to omit expectedCallSequence (protocol moved to IRANTI.md).'
    );
    expect(advisoryAttend.decision.method === 'advisory', 'Expected advisory learning to trigger the memory decision for an ambiguous prompt.');
    expect(advisoryAttend.shouldInject === true, 'Expected advisory-guided attend() to inject the learned checkpoint fact.');
    expect(advisoryAttend.facts[0]?.factId === 'F1', 'Expected advisory-guided attend() to assign stable fact IDs.');
    expect(
        advisoryObservePriorityKeys.includes('next_step'),
        'Expected advisory learning to add learned priority keys to observe().'
    );

    const policyAttendant: any = new AttendantInstance(agentId);
    policyAttendant.loadPersistedState = async () => null;
    policyAttendant.loadOperatingRules = async () => 'Persist checkpoints before expensive work.';
    policyAttendant.inferTask = async () => 'Implement project cleanup policy support.';
    policyAttendant.buildWorkingMemory = async () => [];
    policyAttendant.loadSessionLedgerSignals = async () => ({ learnings: [], profile: null });
    policyAttendant.loadProjectPolicies = async () => ([
        {
            entityKey: 'project/iranti/agent_worktree_cleanup_rule',
            key: 'agent_worktree_cleanup_rule',
            summary: 'Agents working on iranti should clean up the worktree when they are finished working.',
            source: 'user_direct',
            lastUpdated: new Date().toISOString(),
            rules: ['Agents working on iranti should clean up the worktree when they are finished working.'],
        },
    ]);
    policyAttendant.persistState = async () => {};

    const policyBrief = await policyAttendant.handshake({
        task: 'Implement project cleanup policy support.',
        recentMessages: ['Need to make the cleanup rule a real project-scoped policy.'],
    });
    expect(
        policyBrief.projectPolicies?.length === 1,
        'Expected handshake() to surface configured project policies on the brief.'
    );
    expect(
        policyBrief.operatingRules.includes('PROJECT POLICY (agent_worktree_cleanup_rule): Agents working on iranti should clean up the worktree when they are finished working.'),
        'Expected handshake() to append configured project policies into the operating rules.'
    );
    expect(
        policyBrief.workingMemory.some((entry: { entityKey: string; summary: string }) =>
            entry.entityKey === 'project/iranti/agent_worktree_cleanup_rule'
            && entry.summary.includes('Project policy:')
        ),
        'Expected handshake() to surface project policies as working-memory entries.'
    );

    const heuristicAttendant: any = new AttendantInstance(agentId);
    heuristicAttendant.loadPersistedState = async () => null;
    heuristicAttendant.loadOperatingRules = async () => 'Use memory before answering project recall questions.';
    heuristicAttendant.inferTask = async () => 'Review the remaining launch issues and next step.';
    heuristicAttendant.buildWorkingMemory = async () => [];
    heuristicAttendant.loadSessionLedgerSignals = async () => ({ learnings: [], profile: null });
    heuristicAttendant.persistState = async () => {};
    heuristicAttendant.observe = async () => ({
        facts: [
            {
                entityKey: 'project/project_atlas/next_step',
                summary: 'next step is collect approvals',
                value: { instruction: 'collect approvals' },
                confidence: 95,
                source: 'AttendantCheckpoint',
            },
            {
                entityKey: 'project/project_atlas/open_issues',
                summary: 'Remaining launch issues are legal review and sign-off tracking',
                value: ['Legal review pending', 'Sign-off tracking incomplete'],
                confidence: 93,
                source: 'AttendantCheckpoint',
            },
        ],
        entitiesDetected: ['project/project_atlas'],
        alreadyPresent: 0,
        totalFound: 2,
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
    });

    const shortRecallAttend = await heuristicAttendant.attend({
        latestMessage: 'What bugs are left?',
        currentContext: '',
        entityHints: ['project/project_atlas'],
        suppressEvents: true,
    });
    expect(shortRecallAttend.decision.method === 'heuristic', 'Expected short remaining-issues recall prompts to be handled heuristically.');
    expect(shortRecallAttend.decision.explanation === 'memory_reference_detected', 'Expected the remaining-issues prompt to trigger the positive memory heuristic.');
    expect(shortRecallAttend.shouldInject === true, 'Expected the remaining-issues prompt to inject project memory.');

    const nextStepAttend = await heuristicAttendant.attend({
        latestMessage: 'Next step?',
        currentContext: '',
        entityHints: ['project/project_atlas'],
        suppressEvents: true,
    });
    expect(nextStepAttend.decision.method === 'heuristic', 'Expected compact next-step prompts to be handled heuristically.');
    expect(nextStepAttend.decision.explanation === 'memory_reference_detected', 'Expected the next-step prompt to trigger the positive memory heuristic.');
    expect(nextStepAttend.shouldInject === true, 'Expected the next-step prompt to inject project memory.');

    const recapAttend = await heuristicAttendant.attend({
        latestMessage: 'Bring me up to speed.',
        currentContext: '',
        entityHints: ['project/project_atlas'],
        suppressEvents: true,
    });
    expect(
        recapAttend.usageGuidance.reminder.includes('Iranti is a hive mind'),
        'Expected attend() usage guidance to reinforce the hive-mind reminder.'
    );
    expect(recapAttend.decision.method === 'heuristic', 'Expected recap-style prompts to be handled heuristically.');
    expect(recapAttend.decision.explanation === 'memory_reference_detected', 'Expected the recap-style prompt to trigger the positive memory heuristic.');
    expect(recapAttend.shouldInject === true, 'Expected the recap-style prompt to inject project memory.');

    const learningsAttend = await heuristicAttendant.attend({
        latestMessage: 'What did we learn?',
        currentContext: '',
        entityHints: ['project/project_atlas'],
        suppressEvents: true,
    });
    expect(learningsAttend.decision.method === 'heuristic', 'Expected learning-recall prompts to be handled heuristically.');
    expect(learningsAttend.decision.explanation === 'memory_reference_detected', 'Expected the learning-recall prompt to trigger the positive memory heuristic.');
    expect(learningsAttend.shouldInject === true, 'Expected the learning-recall prompt to inject project memory.');

    const statusAttend = await heuristicAttendant.attend({
        latestMessage: 'Can you summarize the current status and progress?',
        currentContext: '',
        entityHints: ['project/project_atlas'],
        suppressEvents: true,
    });
    expect(statusAttend.decision.method === 'heuristic', 'Expected status/progress prompts to be handled heuristically.');
    expect(statusAttend.decision.explanation === 'memory_reference_detected', 'Expected the status/progress prompt to trigger the positive memory heuristic.');
    expect(statusAttend.shouldInject === true, 'Expected the status/progress prompt to inject project memory.');

    const decisionAttend = await heuristicAttendant.attend({
        latestMessage: 'What did we decide about the rollout?',
        currentContext: '',
        entityHints: ['project/project_atlas'],
        suppressEvents: true,
    });
    expect(decisionAttend.decision.method === 'heuristic', 'Expected decision-recall prompts to be handled heuristically.');
    expect(['memory_reference_detected', 'project_decision_recall'].includes(decisionAttend.decision.explanation), `Expected the decision-recall prompt to stay on a positive memory path, got ${decisionAttend.decision.explanation}.`);
    expect(decisionAttend.shouldInject === true, 'Expected the decision-recall prompt to inject project memory.');

    const parseFailureScopedFallback = (heuristicAttendant as any).buildParseFailureFallbackDecision({
        latestMessage: 'Can you recap the open issues?',
        currentContext: 'User asked to continue the launch checklist.',
        entityHintCount: 1,
    });
    expect(parseFailureScopedFallback.needed === true, 'Expected substantive parse-failure prompts with scope hints to default to memory.');
    expect(
        ['classification_parse_failed_default_true', 'classification_parse_failed_heuristic_true'].includes(parseFailureScopedFallback.explanation),
        'Expected the scoped parse-failure fallback to explain the memory-default behavior.'
    );

    const parseFailureProjectCueFallback = (heuristicAttendant as any).buildParseFailureFallbackDecision({
        latestMessage: 'Can you summarize the current status and open blockers?',
        currentContext: '',
        entityHintCount: 0,
    });
    expect(parseFailureProjectCueFallback.needed === true, 'Expected substantive parse-failure prompts with project-state cues to default to memory even without explicit scope hints.');
    expect(
        ['classification_parse_failed_default_true', 'classification_parse_failed_heuristic_true'].includes(parseFailureProjectCueFallback.explanation),
        'Expected the project-state parse-failure fallback to explain the memory-default behavior.'
    );

    const parseFailureUnscopedFallback = (heuristicAttendant as any).buildParseFailureFallbackDecision({
        latestMessage: 'hi',
        currentContext: '',
        entityHintCount: 0,
    });
    expect(parseFailureUnscopedFallback.needed === false, 'Expected non-substantive parse-failure prompts to remain false.');
    expect(parseFailureUnscopedFallback.explanation === 'classification_parse_failed_default_false', 'Expected the unscoped parse-failure fallback to remain false.');

    const parseFailureShortWorkFallback = (heuristicAttendant as any).buildParseFailureFallbackDecision({
        latestMessage: 'help',
        currentContext: '',
        entityHintCount: 0,
    });
    expect(parseFailureShortWorkFallback.needed === true, 'Expected terse non-greeting work prompts to safe-default to memory after classifier parse failure.');
    expect(parseFailureShortWorkFallback.explanation === 'classification_parse_failed_safe_default_true', 'Expected terse non-greeting work prompts to use the safe-default memory explanation.');

    const complianceAttendant: any = new AttendantInstance(`${agentId}_compliance`);
    complianceAttendant.loadPersistedState = async () => null;
    complianceAttendant.loadOperatingRules = async () => 'Always close turns with post-response attend.';
    complianceAttendant.inferTask = async () => 'Validate session compliance tracking.';
    complianceAttendant.buildWorkingMemory = async () => [];
    complianceAttendant.loadSessionLedgerSignals = async () => ({ learnings: [], profile: null });
    complianceAttendant.persistState = async () => {};
    complianceAttendant.observe = async () => ({
        facts: [],
        entitiesDetected: ['project/project_atlas'],
        alreadyPresent: 0,
        totalFound: 0,
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
    });
    await complianceAttendant.attend({
        latestMessage: 'Start the first turn.',
        currentContext: '',
        entityHints: ['project/project_atlas'],
        suppressEvents: true,
        phase: 'pre-response',
    });
    const repeatedPreResponse = await complianceAttendant.attend({
        latestMessage: 'Start the next turn without closing the first.',
        currentContext: '',
        entityHints: ['project/project_atlas'],
        suppressEvents: true,
        phase: 'pre-response',
    });
    expect(repeatedPreResponse.compliance.status === 'non_compliant', 'Expected repeated pre-response attends to produce a non-compliant compliance state.');
    expect(
        repeatedPreResponse.compliance.issues.some((issue: { code: string }) => issue.code === 'missing_post_response_attend'),
        'Expected repeated pre-response attends to flag the missing post-response issue.'
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
    expect(inspected.compliance.status === 'healthy', 'Expected inspectSession() to return a healthy compliance state when no violations were persisted.');

    const unscopedInspection = await attendant.inspectSession();
    expect(unscopedInspection.hasCheckpoint === true, 'Expected inspectSession() without task context to keep exposing the checkpoint.');
    expect(unscopedInspection.sessionRecovery === null, 'Expected inspectSession() without task context to omit task-match recovery advice.');
    expect(unscopedInspection.summary.operatorState === 'interrupted', 'Expected inspectSession() summary to remain operator-interrupted without task context.');

    const routeApp = express();
    routeApp.use(express.json());
    routeApp.use('/memory', memoryRoutes({
        setSessionLedgerContext: () => {},
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
            compliance: {
                status: 'healthy',
                summary: 'Lifecycle is currently compliant.',
                issues: [],
                lastUpdated: new Date().toISOString(),
                counters: {
                    attendsWithoutPersist: 0,
                    consecutivePreResponseWithoutPost: 0,
                    consecutiveUnusedMemoryInjections: 0,
                    pendingPostResponse: false,
                    lastAttendPhase: null,
                },
            },
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
            compliance: { status: string };
            summary: { operatorState: string };
        };
        expect(routeInspection.agentId === agentId, 'Expected route inspection to preserve the requested agentId.');
        expect(routeInspection.sessionRecovery?.recommendation === 'resume', 'Expected route inspection to forward task context into recovery recommendation building.');
        expect(routeInspection.compliance.status === 'healthy', 'Expected route inspection to expose compliance state.');
        expect(routeInspection.summary.operatorState === 'interrupted', 'Expected route inspection summary to remain operator-oriented.');
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    const liveAttendant: any = new AttendantInstance(agentId);
    liveAttendant.brief = recoveredBrief;
    liveAttendant.persistState = async () => {};
    liveAttendant.verifyCheckpointAvailability = async () => {};

    const checkpointedBrief = await liveAttendant.checkpoint({
        task,
        recentMessages: ['Continuing from the recovery point.'],
        checkpoint: {
            currentStep: 'collect approvals',
            nextStep: 'publish checklist',
            openRisks: ['Waiting on final approval'],
            recentOutputs: ['Updated the checklist draft'],
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
