import 'dotenv/config';
import { librarianWrite } from '../src/librarian';
import { getReliabilityScores, weightedConfidence } from '../src/librarian/source-reliability';
import { bootstrapHarness } from './harness';

async function test() {
    bootstrapHarness();
    console.log('Testing Source Reliability Learning...\n');

    const entityType = 'researcher';
    const entityId = `reliability_test_${Date.now()}`;

    // Round 1 — OpenAlex wins (higher confidence)
    console.log('Round 1 — OpenAlex vs Wikipedia, OpenAlex wins:');
    await librarianWrite({
        entityType,
        entityId,
        key: 'affiliation',
        valueRaw: { institution: 'MIT' },
        valueSummary: 'Affiliated with MIT',
        confidence: 85,
        source: 'OpenAlex',
        createdBy: 'agent_001',
    });
    await librarianWrite({
        entityType,
        entityId,
        key: 'affiliation',
        valueRaw: { institution: 'Harvard' },
        valueSummary: 'Affiliated with Harvard',
        confidence: 60,
        source: 'Wikipedia',
        createdBy: 'agent_002',
    });

    let scores = await getReliabilityScores();
    console.log('  OpenAlex score:', scores['OpenAlex'] ?? 0.5);
    console.log('  Wikipedia score:', scores['Wikipedia'] ?? 0.5);

    // Round 2 — ORCID wins over OpenAlex
    console.log('\nRound 2 — ORCID vs OpenAlex, ORCID wins:');
    const entityId2 = `reliability_test_${Date.now() + 1}`;
    await librarianWrite({
        entityType,
        entityId: entityId2,
        key: 'affiliation',
        valueRaw: { institution: 'Stanford' },
        valueSummary: 'Affiliated with Stanford',
        confidence: 70,
        source: 'OpenAlex',
        createdBy: 'agent_001',
    });
    await librarianWrite({
        entityType,
        entityId: entityId2,
        key: 'affiliation',
        valueRaw: { institution: 'Carnegie Mellon' },
        valueSummary: 'Affiliated with Carnegie Mellon',
        confidence: 88,
        source: 'ORCID',
        createdBy: 'agent_002',
    });

    scores = await getReliabilityScores();
    console.log('  OpenAlex score:', scores['OpenAlex'] ?? 0.5);
    console.log('  ORCID score:', scores['ORCID'] ?? 0.5);
    console.log('  Wikipedia score:', scores['Wikipedia'] ?? 0.5);

    // Show weighted confidence effect
    console.log('\nWeighted confidence demo:');
    console.log('  Raw confidence 75 from OpenAlex →', weightedConfidence(75, 'OpenAlex', scores));
    console.log('  Raw confidence 75 from Wikipedia →', weightedConfidence(75, 'Wikipedia', scores));
    console.log('  Raw confidence 75 from ORCID →', weightedConfidence(75, 'ORCID', scores));
    console.log('  Raw confidence 75 from unknown source →', weightedConfidence(75, 'Unknown', scores));

    process.exit(0);
}

test().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
