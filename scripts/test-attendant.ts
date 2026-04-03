import 'dotenv/config';
import { handshake, reconvene, getAttendant } from '../src/attendant';
import { clearAttendant } from '../src/attendant/registry';
import { bootstrapHarness } from './harness';
import { configureMock } from '../src/lib/providers/mock';
import { librarianWrite } from '../src/librarian';

function restoreProjectMemoryEntity(priorProjectMemoryEntity: string | undefined): void {
    if (priorProjectMemoryEntity === undefined) {
        delete process.env.IRANTI_MEMORY_ENTITY;
    } else {
        process.env.IRANTI_MEMORY_ENTITY = priorProjectMemoryEntity;
    }
}

async function test() {
    process.env.LLM_PROVIDER = 'mock';
    const priorProjectMemoryEntity = process.env.IRANTI_MEMORY_ENTITY;
    process.env.IRANTI_MEMORY_ENTITY = 'project/attendant_smoke_memory';
    try {
        bootstrapHarness({ dbApplicationName: 'iranti:attendant:legacy_api' });
        configureMock({
            scenario: 'default',
            seed: 42,
            failureRate: 0,
        });
        console.log('Testing Attendant...\n');

    // Test 1 — handshake with a fresh agent
    const context = {
        agentId: 'research_agent_001',
        taskDescription: 'Find publication history for a researcher',
        recentMessages: [
            'Looking up Dr. Jane Smith on OpenAlex',
            'Found 12 publications, checking affiliations',
            'Affiliation listed as MIT in 3 sources',
        ],
    };

    console.log('Test 1 — handshake:');
    await librarianWrite({
        entityType: 'project',
        entityId: 'attendant_smoke_memory',
        key: 'agent_worktree_cleanup_rule',
        valueRaw: { rule: 'Leave a clean worktree or emit an explicit residue report before ending the run.' },
        valueSummary: 'Leave a clean worktree or emit an explicit residue report before ending the run.',
        confidence: 95,
        source: 'attendant_test',
        createdBy: context.agentId,
    });
    const brief = await handshake(context);
    console.log('  Agent ID:', brief.agentId);
    console.log('  Inferred task:', brief.inferredTaskType);
    console.log('  Relevant knowledge entries:', brief.workingMemory.length);
    console.log('  Operating rules loaded:', brief.operatingRules.length > 0);
    console.log('  Project policies loaded:', brief.projectPolicies?.length ?? 0);
    console.log('  Generated at:', brief.briefGeneratedAt);
    if (!brief.operatingRules.includes('Leave a clean worktree or emit an explicit residue report before ending the run.')) {
        throw new Error('Expected handshake() smoke to append the configured project policy into operating rules.');
    }

    // Test 2 — reconvene with same task (should not regenerate)
    console.log('\nTest 2 — reconvene same task:');
    const reconvenedBrief = await reconvene(brief, context);
    console.log('  Task changed:', reconvenedBrief.inferredTaskType !== brief.inferredTaskType);
    console.log('  Inferred task:', reconvenedBrief.inferredTaskType);

    // Test 3 — reconvene with shifted task
    console.log('\nTest 3 — reconvene shifted task:');
    const shiftedContext = {
        agentId: 'research_agent_001',
        taskDescription: 'Writing summary report',
        recentMessages: [
            'Compiling all findings into final report',
            'Formatting citations',
            'Preparing executive summary',
        ],
    };
    const shiftedBrief = await reconvene(brief, shiftedContext);
    console.log('  Task changed:', shiftedBrief.inferredTaskType !== brief.inferredTaskType);
    console.log('  New inferred task:', shiftedBrief.inferredTaskType);

    // Test 4 — attend (inject only when memory is needed)
    console.log('\nTest 4 — attend memory decision:');
    const attendant = getAttendant(context.agentId);
    const attendResult = await attendant.attend({
        latestMessage: 'What is my favorite snack?',
        currentContext: 'User: What is my favorite snack?\nAssistant:',
        entityHints: ['user/main'],
        maxFacts: 3,
    });
    console.log('  shouldInject:', attendResult.shouldInject);
    console.log('  reason:', attendResult.reason);
    console.log('  decision:', `${attendResult.decision.method} / ${attendResult.decision.confidence}`);
    console.log('  facts returned:', attendResult.facts.length);

    // Test 5 — observe auto-detects bare technical slug ids
    console.log('\nTest 5 — observe slug autodetection:');
    await librarianWrite({
        entityType: 'project',
        entityId: 'lunar_api_v3',
        key: 'database_engine',
        valueRaw: { engine: 'PostgreSQL 16' },
        valueSummary: 'Database engine is PostgreSQL 16.',
        confidence: 95,
        source: 'attendant_test',
        createdBy: 'research_agent_001',
    });
    const observeResult = await attendant.observe({
        currentContext: 'We are planning the lunar_api_v3 deployment and need to remember the database choice.',
        maxFacts: 3,
    });
    console.log('  detected candidates:', observeResult.debug?.detectedCandidates ?? 0);
    console.log('  entities detected:', observeResult.entitiesDetected.join(', ') || '(none)');
    console.log('  facts returned:', observeResult.facts.length);

    // Test 6 â€” recovery handshake after an interrupted session checkpoint
    console.log('\nTest 6 â€” checkpoint recovery after restart:');
    const recoveryAgentId = 'research_agent_recovery_001';
    const recoveryTask = 'Prepare the launch checklist for Project Atlas';
    const recoveryCheckpoint = await getAttendant(recoveryAgentId).checkpoint({
        task: recoveryTask,
        recentMessages: [
            'Drafting the launch checklist',
            'Waiting on approvals and open risks',
        ],
        checkpoint: {
            currentStep: 'drafting launch checklist',
            nextStep: 'collect final approvals',
            openRisks: ['Legal review pending'],
            recentOutputs: ['Outlined launch milestones'],
            entityTargets: ['project/project_atlas'],
            notes: 'Stopped before approvals were gathered.',
        },
        heartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    clearAttendant(recoveryAgentId);

    const recoveryBrief = await handshake({
        agentId: recoveryAgentId,
        taskDescription: recoveryTask,
        recentMessages: [
            'Need to continue the launch checklist',
            'Resuming after the interruption',
        ],
    });
    console.log('  recovery available:', recoveryBrief.sessionRecovery?.available === true);
    console.log('  recovery recommendation:', recoveryBrief.sessionRecovery?.recommendation);
    console.log('  recovery matches task:', recoveryBrief.sessionRecovery?.matchedCurrentTask);
    console.log('  checkpoint session:', recoveryBrief.sessionCheckpoint?.sessionId);

    if (!recoveryBrief.sessionRecovery?.available || recoveryBrief.sessionRecovery.recommendation !== 'resume') {
        throw new Error('Expected interrupted-session recovery to recommend resume.');
    }

    const resumedBrief = await getAttendant(recoveryAgentId).resumeSession({
        sessionId: recoveryCheckpoint.sessionCheckpoint?.sessionId,
    });
    console.log('  resumed status:', resumedBrief.sessionCheckpoint?.status);

    if (resumedBrief.sessionCheckpoint?.status !== 'active') {
        throw new Error('Expected resumeSession() to reactivate the checkpoint.');
    }

    await getAttendant(recoveryAgentId).completeSession({
        sessionId: recoveryCheckpoint.sessionCheckpoint?.sessionId,
    });

    } finally {
        restoreProjectMemoryEntity(priorProjectMemoryEntity);
    }
    process.exit(0);
}

test().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
