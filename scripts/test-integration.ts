import 'dotenv/config';
import { librarianWrite } from '../src/librarian';
import { handshake, reconvene } from '../src/attendant';
import { runArchivist } from '../src/archivist';
import { queryEntry } from '../src/library/queries';
import { bootstrapHarness } from './harness';
import { configureMock } from '../src/lib/providers/mock';

// ─── Mock Agent ──────────────────────────────────────────────────────────────
// Simulates an external agent using Iranti as its memory layer.

async function mockAgent(agentId: string) {
    console.log(`\n── Agent ${agentId} starting ──`);

    // 1. Handshake with Attendant
    const context = {
        agentId,
        taskDescription: 'Research academic background of Dr. Jane Smith',
        recentMessages: [
            'Starting research on Dr. Jane Smith',
            'Checking OpenAlex for publication history',
        ],
    };

    const brief = await handshake(context);
    console.log('  Handshake complete');
    console.log('  Inferred task:', brief.inferredTaskType);
    console.log('  Operating rules loaded:', brief.operatingRules.length > 0);

    // 2. Agent makes findings, writes through Librarian
    console.log('\n  Writing findings through Librarian...');

    const write1 = await librarianWrite({
        entityType: 'researcher',
        entityId: 'jane_smith_001',
        key: 'affiliation',
        valueRaw: { institution: 'Stanford' },
        valueSummary: 'Affiliated with Stanford University',
        confidence: 75,
        source: 'OpenAlex',
        createdBy: agentId,
    });
    console.log('  Write 1 (affiliation):', write1.action, '|', write1.reason);

    const write2 = await librarianWrite({
        entityType: 'researcher',
        entityId: 'jane_smith_001',
        key: 'publication_count',
        valueRaw: { count: 24 },
        valueSummary: '24 publications found on OpenAlex',
        confidence: 90,
        source: 'OpenAlex',
        createdBy: agentId,
    });
    console.log('  Write 2 (publications):', write2.action, '|', write2.reason);

    // 3. Agent reconvenes mid-task
    const updatedContext = {
        agentId,
        taskDescription: 'Verifying affiliation from secondary source',
        recentMessages: [
            'Cross-checking affiliation on ORCID',
            'ORCID shows MIT affiliation',
            'Conflict with OpenAlex data',
        ],
    };

    const updatedBrief = await reconvene(brief, updatedContext);
    console.log('\n  Reconvene complete');
    console.log('  Task shifted:', updatedBrief.inferredTaskType !== brief.inferredTaskType);

    // 4. Second agent writes conflicting data
    console.log('\n── Agent agent_002 writing conflicting data ──');
    const conflictWrite = await librarianWrite({
        entityType: 'researcher',
        entityId: 'jane_smith_001',
        key: 'affiliation',
        valueRaw: { institution: 'MIT' },
        valueSummary: 'Affiliated with MIT',
        confidence: 72,
        source: 'ORCID',
        createdBy: 'agent_002',
    });
    console.log('  Conflict write:', conflictWrite.action, '|', conflictWrite.reason);

    // 5. Read current state of KB
    console.log('\n── Reading KB state ──');
    const affiliation = await queryEntry({
        entityType: 'researcher',
        entityId: 'jane_smith_001',
        key: 'affiliation',
    });
    console.log('  Affiliation in KB:', affiliation.found ? affiliation.entry?.valueSummary : 'not found');
    console.log('  Confidence:', affiliation.found ? affiliation.entry?.confidence : 'n/a');

    const publications = await queryEntry({
        entityType: 'researcher',
        entityId: 'jane_smith_001',
        key: 'publication_count',
    });
    console.log('  Publications in KB:', publications.found ? publications.entry?.valueSummary : 'not found');
}

// ─── Integration Test ────────────────────────────────────────────────────────

async function test() {
    process.env.LLM_PROVIDER = 'mock';
    bootstrapHarness();
    configureMock({
        scenario: 'default',
        seed: 42,
        failureRate: 0,
    });
    console.log('=== Iranti Integration Test ===');

    // Run mock agent
    await mockAgent('agent_001');

    // Run Archivist cycle
    console.log('\n── Running Archivist cycle ──');
    const report = await runArchivist();
    console.log('  Expired archived:', report.expiredArchived);
    console.log('  Low confidence archived:', report.lowConfidenceArchived);
    console.log('  Escalations processed:', report.escalationsProcessed);
    console.log('  Errors:', report.errors.length === 0 ? 'none' : report.errors);

    console.log('\n=== Integration test complete ===');
    process.exit(0);
}

test().catch((err) => {
    console.error('Integration test failed:', err);
    process.exit(1);
});
