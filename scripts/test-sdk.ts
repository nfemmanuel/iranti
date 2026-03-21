import 'dotenv/config';
import { Iranti } from '../src/sdk';
import { clearAttendant } from '../src/attendant/registry';
import { bootstrapHarness } from './harness';

async function test() {
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
    const brief = await iranti.handshake({
        agent: 'sdk_agent_001',
        task: 'Research publication history',
        recentMessages: ['Looking up researcher on OpenAlex'],
    });
    console.log('  Inferred task:', brief.inferredTaskType);
    console.log('  Rules loaded:', brief.operatingRules.length > 0);

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

    const resumedBrief = await iranti.resumeSession({
        agentId: recoveryAgent,
        sessionId: checkpointBrief.sessionCheckpoint?.sessionId,
    });
    console.log('  Resumed status:', resumedBrief.sessionCheckpoint?.status);
    if (resumedBrief.sessionCheckpoint?.status !== 'active') {
        throw new Error('Expected resumeSession() to reactivate the checkpoint.');
    }

    await iranti.completeSession({
        agentId: recoveryAgent,
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
    process.exit(0);
}

test().catch((err) => {
    console.error('SDK test failed:', err);
    process.exit(1);
});
