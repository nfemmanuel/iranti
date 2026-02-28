import 'dotenv/config';
import { handshake, reconvene } from '../src/attendant';

async function test() {
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
    const brief = await handshake(context);
    console.log('  Agent ID:', brief.agentId);
    console.log('  Inferred task:', brief.inferredTaskType);
    console.log('  Relevant knowledge entries:', brief.relevantKnowledge.length);
    console.log('  Operating rules loaded:', brief.operatingRules.length > 0);
    console.log('  Generated at:', brief.briefGeneratedAt);

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

    process.exit(0);
}

test().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});