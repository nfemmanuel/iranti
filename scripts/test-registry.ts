import 'dotenv/config';
import { Iranti } from '../src/sdk';
import { bootstrapHarness } from './harness';

async function test() {
    bootstrapHarness({ requireDb: false });
    console.log('Testing Agent Registry...\n');

    const iranti = new Iranti();
    const ts = Date.now();

    // Test 1 — register agents
    console.log('Test 1 — register agents:');
    await iranti.registerAgent({
        agentId: `scraper_${ts}`,
        name: 'Web Scraper',
        description: 'Scrapes academic databases for researcher profiles',
        capabilities: ['web_scraping', 'data_extraction'],
        model: 'gemini-2.0-flash-001',
    });
    await iranti.registerAgent({
        agentId: `analyst_${ts}`,
        name: 'Data Analyst',
        description: 'Analyzes and cross-references research findings',
        capabilities: ['data_analysis', 'conflict_detection'],
        model: 'gemini-2.5-pro',
    });
    console.log('  Registered: Web Scraper, Data Analyst');

    // Test 2 — write findings through each agent
    console.log('\nTest 2 — agents write findings:');
    const entity = `researcher/target_${ts}`;

    await iranti.write({
        entity,
        key: 'affiliation',
        value: { institution: 'Oxford' },
        summary: 'Affiliated with Oxford University',
        confidence: 82,
        source: 'OpenAlex',
        agent: `scraper_${ts}`,
    });

    await iranti.write({
        entity,
        key: 'publication_count',
        value: { count: 17 },
        summary: 'Has 17 publications',
        confidence: 88,
        source: 'Semantic Scholar',
        agent: `analyst_${ts}`,
    });

    await iranti.write({
        entity,
        key: 'h_index',
        value: { score: 9 },
        summary: 'H-index of 9',
        confidence: 75,
        source: 'Semantic Scholar',
        agent: `analyst_${ts}`,
    });
    console.log('  3 findings written');

    // Test 3 — get agent stats
    console.log('\nTest 3 — agent stats:');
    const scraper = await iranti.getAgent(`scraper_${ts}`);
    const analyst = await iranti.getAgent(`analyst_${ts}`);
    console.log('  Scraper writes:', scraper?.stats.totalWrites);
    console.log('  Scraper avg confidence:', scraper?.stats.avgConfidence);
    console.log('  Analyst writes:', analyst?.stats.totalWrites);
    console.log('  Analyst avg confidence:', analyst?.stats.avgConfidence);

    // Test 4 — whoKnows
    console.log('\nTest 4 — whoKnows:');
    const knowers = await iranti.whoKnows(entity);
    knowers.forEach((k) => {
        console.log(`  ${k.agentId}: ${k.keys.join(', ')} (${k.totalContributions} contributions)`);
    });

    // Test 5 — list agents
    console.log('\nTest 5 — listAgents:');
    const agents = await iranti.listAgents();
    console.log('  Total registered agents:', agents.length);

    // Test 6 — team assignment
    console.log('\nTest 6 — team assignment:');
    await iranti.assignToTeam(`scraper_${ts}`, `research_team_${ts}`);
    await iranti.assignToTeam(`analyst_${ts}`, `research_team_${ts}`);
    const teamRelated = await iranti.getRelated(`agent/scraper_${ts}`);
    console.log('  Scraper relationships:', teamRelated.map((r) => `${r.relationshipType} → ${r.entityType}/${r.entityId}`).join(', '));

    console.log('\n=== Registry test complete ===');
    process.exit(0);
}

test().catch((err) => {
    console.error('Registry test failed:', err);
    process.exit(1);
});
