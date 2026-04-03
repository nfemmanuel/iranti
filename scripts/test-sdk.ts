import 'dotenv/config';
import { Iranti } from '../src/sdk';
import { clearAttendant } from '../src/attendant/registry';
import { bootstrapHarness } from './harness';

function restoreProjectMemoryEntity(priorProjectMemoryEntity: string | undefined): void {
    if (priorProjectMemoryEntity === undefined) {
        delete process.env.IRANTI_MEMORY_ENTITY;
    } else {
        process.env.IRANTI_MEMORY_ENTITY = priorProjectMemoryEntity;
    }
}

async function test() {
    const priorProjectMemoryEntity = process.env.IRANTI_MEMORY_ENTITY;
    process.env.IRANTI_MEMORY_ENTITY = 'project/sdk_smoke_project_memory';
    try {
        bootstrapHarness({ requireDb: false });
        console.log('Testing Iranti SDK...\n');

    const iranti = new Iranti();

    // Test 1 — write
    console.log('Test 1 — write:');
    const writeResult = await iranti.write({
        entity: 'researcher/sdk_test_001',
        key: 'affiliation',
        value: { institution: 'MIT' },
        summary: 'Affiliated with MIT',
        confidence: 85,
        source: 'OpenAlex',
        agent: 'sdk_agent_001',
    });
    console.log('  ', writeResult.action, '|', writeResult.reason);

    // Test 2 — ingest
    console.log('\nTest 2 — ingest:');
    const ingestResult = await iranti.ingest({
        entity: 'researcher/sdk_test_002',
        content: 'Dr. Alex Johnson has 18 publications and is a professor at Oxford University. Research focus: computational biology.',
        source: 'OpenAlex',
        confidence: 80,
        agent: 'sdk_agent_001',
    });
    console.log('  Written:', ingestResult.written);
    console.log('  Facts:');
    ingestResult.facts.forEach((f) => console.log(`    [${f.key}] ${f.action}`));

    // Test 3 — handshake
    console.log('\nTest 3 — handshake:');
    await iranti.write({
        entity: 'project/sdk_smoke_project_memory',
        key: 'agent_worktree_cleanup_rule',
        value: { rule: 'Leave a clean worktree or emit an explicit residue report before ending the run.' },
        summary: 'Leave a clean worktree or emit an explicit residue report before ending the run.',
        confidence: 95,
        source: 'sdk_smoke',
        agent: 'sdk_agent_001',
    });
    const brief = await iranti.handshake({
        agentId: 'sdk_agent_001',
        task: 'Research publication history',
        recentMessages: ['Looking up researcher on OpenAlex'],
    });
    console.log('  Inferred task:', brief.inferredTaskType);
    console.log('  Rules loaded:', brief.operatingRules.length > 0);
    console.log('  Project policies loaded:', brief.projectPolicies?.length ?? 0);
    if (!brief.operatingRules.includes('Leave a clean worktree or emit an explicit residue report before ending the run.')) {
        throw new Error('Expected handshake() to append configured project policies into operating rules.');
    }

    // Test 4 â€” interrupted session recovery
    console.log('\nTest 4 â€” interrupted session recovery:');
    const recoveryAgent = 'sdk_recovery_agent_001';
    const recoveryTask = 'Prepare the incident response checklist';
    const checkpointBrief = await iranti.checkpoint({
        agentId: recoveryAgent,
        task: recoveryTask,
        recentMessages: [
            'Drafting the incident response checklist',
            'Waiting on the final approvals',
        ],
        checkpoint: {
            currentStep: 'drafting incident response checklist',
            nextStep: 'collect approvals',
            openRisks: ['Approval pending'],
            recentOutputs: ['Listed escalation owners'],
            entityTargets: ['project/incident_response'],
            notes: 'Interrupted before sign-off.',
        },
        heartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    clearAttendant(recoveryAgent);
    // Handshake still accepts the legacy `agent` alias for backward compatibility.
    const recoveryBrief = await iranti.handshake({
        agent: recoveryAgent,
        task: recoveryTask,
        recentMessages: ['Returning to the incident response checklist.'],
    });
    console.log('  Recovery available:', recoveryBrief.sessionRecovery?.available);
    console.log('  Recovery recommendation:', recoveryBrief.sessionRecovery?.recommendation);
    console.log('  Recovery matches task:', recoveryBrief.sessionRecovery?.matchedCurrentTask);
    console.log('  Checkpoint session:', recoveryBrief.sessionCheckpoint?.sessionId);
    if (!recoveryBrief.sessionRecovery?.available || recoveryBrief.sessionRecovery.recommendation !== 'resume') {
        throw new Error('Expected handshake() to surface interrupted-session recovery.');
    }

    const inspected = await iranti.inspectSession({ agentId: recoveryAgent });
    console.log('  Inspect has checkpoint:', inspected.hasCheckpoint);
    console.log('  Inspect session id:', inspected.sessionCheckpoint?.sessionId);
    if (!inspected.hasCheckpoint || inspected.sessionCheckpoint?.sessionId !== checkpointBrief.sessionCheckpoint?.sessionId) {
        throw new Error('Expected inspectSession() to expose the persisted checkpoint.');
    }

    const interruptedSessions = await iranti.listSessions({
        operatorState: 'interrupted',
        sort: 'operator',
    });
    console.log('  Interrupted sessions:', interruptedSessions.length);
    if (!interruptedSessions.some((session) => session.agentId === recoveryAgent && session.operatorState === 'interrupted')) {
        throw new Error('Expected listSessions() to filter interrupted sessions.');
    }

    const resumedBrief = await iranti.resumeSession({
        agentId: recoveryAgent,
        sessionId: checkpointBrief.sessionCheckpoint?.sessionId,
    });
    console.log('  Resumed status:', resumedBrief.sessionCheckpoint?.status);
    if (resumedBrief.sessionCheckpoint?.status !== 'active') {
        throw new Error('Expected resumeSession() to reactivate the checkpoint.');
    }

    const activeSessions = await iranti.listSessions({
        agentId: recoveryAgent,
        operatorState: 'active',
        sort: 'updated_desc',
        limit: 1,
    });
    if (activeSessions.length !== 1 || activeSessions[0].agentId !== recoveryAgent || activeSessions[0].operatorState !== 'active') {
        throw new Error('Expected listSessions() to filter by agentId and active operator state.');
    }

    // Session actions also keep the legacy alias temporarily for compatibility.
    await iranti.completeSession({
        agent: recoveryAgent,
        sessionId: checkpointBrief.sessionCheckpoint?.sessionId,
    });

    // Test 4 — query
    console.log('\nTest 4 — query:');
    const queryResult = await iranti.query('researcher/sdk_test_001', 'affiliation');
    console.log('  Found:', queryResult.found);
    console.log('  Value:', JSON.stringify(queryResult.value));
    console.log('  Confidence:', queryResult.confidence);

    // Test 5 — queryAll
    console.log('\nTest 5 — queryAll:');
    const allResults = await iranti.queryAll('researcher/sdk_test_002');
    console.log('  Entries found:', allResults.length);
    allResults.forEach((r) => console.log(`    [${r.key}] ${r.summary}`));

    // Test 6 — hybrid search
    console.log('\nTest 6 — hybrid search:');
    const searchResults = await iranti.search({
        query: 'Oxford professor publications',
        entityType: 'researcher',
        limit: 5,
    });
    console.log('  Matches:', searchResults.length);
    searchResults.forEach((result) => {
        console.log(`    [${result.entity}] ${result.key} score=${result.score.toFixed(3)}`);
    });

    // Test 7 — maintenance
    console.log('\nTest 7 — maintenance:');
    const maintenance = await iranti.runMaintenance();
    console.log('  Expired archived:', maintenance.expiredArchived);
    console.log('  Escalations processed:', maintenance.escalationsProcessed);
    console.log('  Errors:', maintenance.errors.length === 0 ? 'none' : maintenance.errors);

        console.log('\n=== SDK test complete ===');
    } finally {
        restoreProjectMemoryEntity(priorProjectMemoryEntity);
    }
    process.exit(0);
}

test().catch((err) => {
    console.error('SDK test failed:', err);
    process.exit(1);
});
