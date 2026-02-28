import 'dotenv/config';
import { Iranti } from '../src/sdk';

async function test() {
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

    // Test 6 — maintenance
    console.log('\nTest 6 — maintenance:');
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
