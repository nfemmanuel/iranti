import 'dotenv/config';
import { librarianIngest } from '../src/librarian';
import { bootstrapHarness } from './harness';

async function test() {
    bootstrapHarness();
    console.log('Testing Chunker + Librarian Ingest...\n');

    // Test 1 — ingest a rich text blob
    console.log('Test 1 — rich text blob:');
    const result1 = await librarianIngest({
        entityType: 'researcher',
        entityId: 'dr_chen_001',
        rawContent: 'Dr. Sarah Chen has published 31 papers and is currently affiliated with Carnegie Mellon University. She previously worked at Google DeepMind from 2019 to 2022. Her primary research focus is reinforcement learning with a secondary interest in robotics.',
        source: 'OpenAlex',
        confidence: 80,
        createdBy: 'agent_001',
    });
    console.log('  Written:', result1.written);
    console.log('  Rejected:', result1.rejected);
    console.log('  Escalated:', result1.escalated);
    console.log('  Results:');
    result1.results.forEach((r) => {
        console.log(`    [${r.key}] ${r.action} | ${r.reason}`);
    });

    // Test 2 — ingest conflicting data for same entity
    console.log('\nTest 2 — conflicting ingest:');
    const result2 = await librarianIngest({
        entityType: 'researcher',
        entityId: 'dr_chen_001',
        rawContent: 'Dr. Sarah Chen is affiliated with Stanford University and has 35 publications.',
        source: 'ORCID',
        confidence: 78,
        createdBy: 'agent_002',
    });
    console.log('  Written:', result2.written);
    console.log('  Rejected:', result2.rejected);
    console.log('  Escalated:', result2.escalated);
    console.log('  Results:');
    result2.results.forEach((r) => {
        console.log(`    [${r.key}] ${r.action} | ${r.reason}`);
    });

    process.exit(0);
}

test().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
