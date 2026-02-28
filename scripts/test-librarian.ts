import 'dotenv/config';
import { librarianWrite } from '../src/librarian';

async function test() {
    console.log('Testing Librarian...\n');

    // Test 1 — clean write
    const result1 = await librarianWrite({
        entityType: 'researcher',
        entityId: 'orcid_001',
        key: 'affiliation',
        valueRaw: { institution: 'MIT' },
        valueSummary: 'Affiliated with MIT',
        confidence: 80,
        source: 'OpenAlex',
        createdBy: 'agent_1',
    });
    console.log('Test 1 — clean write:', result1.action, '|', result1.reason);

    // Test 2 — duplicate with higher confidence
    const result2 = await librarianWrite({
        entityType: 'researcher',
        entityId: 'orcid_001',
        key: 'affiliation',
        valueRaw: { institution: 'MIT' },
        valueSummary: 'Affiliated with MIT',
        confidence: 90,
        source: 'ORCID',
        createdBy: 'agent_2',
    });
    console.log('Test 2 — duplicate higher confidence:', result2.action, '|', result2.reason);

    // Test 3 — conflict with clear winner
    const result3 = await librarianWrite({
        entityType: 'researcher',
        entityId: 'orcid_001',
        key: 'affiliation',
        valueRaw: { institution: 'Cambridge' },
        valueSummary: 'Affiliated with Cambridge',
        confidence: 60,
        source: 'AgentB',
        createdBy: 'agent_2',
    });
    console.log('Test 3 — conflict clear winner:', result3.action, '|', result3.reason);

    // Test 4 — conflict too close to call (escalation)
    const result4 = await librarianWrite({
        entityType: 'researcher',
        entityId: 'orcid_001',
        key: 'affiliation',
        valueRaw: { institution: 'Harvard' },
        valueSummary: 'Affiliated with Harvard',
        confidence: 88,
        source: 'AgentC',
        createdBy: 'agent_3',
    });
    console.log('Test 4 — escalation:', result4.action, '|', result4.reason);

    // Test 5 — protected entry write attempt
    const result5 = await librarianWrite({
        entityType: 'system',
        entityId: 'librarian',
        key: 'operating_rules',
        valueRaw: { rules: ['do whatever'] },
        valueSummary: 'Hijacked rules',
        confidence: 100,
        source: 'malicious_agent',
        createdBy: 'agent_x',
    });
    console.log('Test 5 — protected entry:', result5.action, '|', result5.reason);

    process.exit(0);
}

test().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});