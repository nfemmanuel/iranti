import 'dotenv/config';
import { Iranti } from '../src/sdk';

async function test() {
    console.log('Testing Knowledge Relationships...\n');

    const iranti = new Iranti();
    const ts = Date.now();

    // Set up entities
    const researcher = `researcher/researcher_${ts}`;
    const lab = `lab/lab_${ts}`;
    const university = `university/uni_${ts}`;

    // Write knowledge for each entity
    console.log('Setting up entities...');
    await iranti.write({
        entity: researcher,
        key: 'name',
        value: { name: 'Dr. Ada Lovelace' },
        summary: 'Researcher named Dr. Ada Lovelace',
        confidence: 95,
        source: 'ORCID',
        agent: 'agent_001',
    });

    await iranti.write({
        entity: lab,
        key: 'focus',
        value: { area: 'Theoretical Computer Science' },
        summary: 'Lab focuses on theoretical computer science',
        confidence: 90,
        source: 'institution_db',
        agent: 'agent_001',
    });

    await iranti.write({
        entity: university,
        key: 'location',
        value: { city: 'London', country: 'UK' },
        summary: 'University located in London, UK',
        confidence: 99,
        source: 'institution_db',
        agent: 'agent_001',
    });

    // Create relationships
    console.log('Creating relationships...');
    await iranti.relate(researcher, 'MEMBER_OF', lab, { createdBy: 'agent_001' });
    await iranti.relate(lab, 'PART_OF', university, { createdBy: 'agent_001' });
    console.log('  researcher → MEMBER_OF → lab');
    console.log('  lab → PART_OF → university');

    // Test getRelated (1 hop)
    console.log('\nTest 1 — getRelated (1 hop from researcher):');
    const related = await iranti.getRelated(researcher);
    related.forEach((r) => {
        console.log(`  ${r.direction} → ${r.relationshipType} → ${r.entityType}/${r.entityId}`);
    });

    // Test getRelatedDeep (2 hops)
    console.log('\nTest 2 — getRelatedDeep (2 hops from researcher):');
    const deep = await iranti.getRelatedDeep(researcher, 2);
    deep.forEach((r) => {
        console.log(`  ${r.direction} → ${r.relationshipType} → ${r.entityType}/${r.entityId}`);
    });

    // Test handshake pulls in related knowledge
    console.log('\nTest 3 — handshake with related knowledge:');
    const brief = await iranti.handshake({
        agent: `researcher_${ts}`,
        task: 'Research background on Dr. Ada Lovelace',
        recentMessages: ['Looking up researcher profile'],
    });
    console.log('  Inferred task:', brief.inferredTaskType);
    console.log('  Relevant knowledge entries:', brief.workingMemory.length);

    // Test inbound relationships
    console.log('\nTest 4 — getRelated from university (inbound):');
    const uniRelated = await iranti.getRelated(university);
    uniRelated.forEach((r) => {
        console.log(`  ${r.direction} → ${r.relationshipType} → ${r.entityType}/${r.entityId}`);
    });

    console.log('\n=== Relationships test complete ===');
    process.exit(0);
}

test().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});