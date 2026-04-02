import assert from 'node:assert/strict';
import { bootstrapHarness } from '../../scripts/harness';
import { Iranti } from '../../src/sdk';

bootstrapHarness();

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for hybrid multihop search tests.');
  }

  process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'mock';

  const iranti = new Iranti({ connectionString, llmProvider: process.env.LLM_PROVIDER });
  const agentId = uniqueId('hybrid_multihop_search_agent');
  await iranti.registerAgent({
    agentId,
    name: 'Hybrid Multihop Search Agent',
    description: 'Validates graph-aware semantic bridge search for filtered project queries.',
    capabilities: ['write', 'relate', 'search'],
    model: 'mock',
  });

  const project = `project/${uniqueId('multihop_project')}`;
  const issue = `issue/${uniqueId('multihop_issue')}`;
  const incident = `incident/${uniqueId('multihop_incident')}`;
  const incidentPhrase = `${uniqueId('cerulean_lattice_outage')} checkout degradation cascade`;

  await iranti.write({
    entity: project,
    key: 'status',
    value: { state: 'blocked' },
    summary: 'Launch readiness is blocked.',
    confidence: 94,
    source: 'hybrid_multihop_search',
    agent: agentId,
  });
  await iranti.write({
    entity: issue,
    key: 'status',
    value: { state: 'open' },
    summary: 'Checkout reliability issue remains open.',
    confidence: 91,
    source: 'hybrid_multihop_search',
    agent: agentId,
  });
  await iranti.write({
    entity: incident,
    key: 'summary',
    value: { text: `${incidentPhrase} is blocking customer transactions.` },
    summary: `${incidentPhrase} is blocking customer transactions.`,
    confidence: 97,
    source: 'hybrid_multihop_search',
    agent: agentId,
  });

  await iranti.relate(project, 'TRACKS', issue, { createdBy: agentId });
  await iranti.relate(issue, 'CAUSED_BY', incident, { createdBy: agentId });

  const results = await iranti.search({
    query: incidentPhrase,
    entityType: 'project',
    limit: 5,
  });

  assert.ok(results.length > 0, 'Expected filtered project search to return results for a related two-hop incident query.');
  assert.equal(results[0]?.entity, project, 'Expected the top filtered project result to be the project linked to the matching incident.');
  assert.equal(results[0]?.key, 'status', 'Expected graph bridge search to surface the project status entry first.');
  assert.ok((results[0]?.vectorScore ?? 0) > 0, 'Expected bridged project result to carry a positive vector score.');

  const addressedProject = `project/${uniqueId('search_addressed_project')}`;
  await iranti.write({
    entity: addressedProject,
    key: 'status',
    value: { phase: 'smoke_test' },
    summary: `Search addressed project ${addressedProject} status is smoke_test.`,
    confidence: 93,
    source: 'hybrid_multihop_search',
    agent: agentId,
  });

  const addressedResults = await iranti.search({
    query: `${addressedProject} smoke_test`,
    limit: 5,
  });

  assert.ok(addressedResults.length > 0, 'Expected addressed hybrid search to return at least one result.');
  assert.equal(addressedResults[0]?.entity, addressedProject, 'Expected addressed search to surface the exact written project entity first.');
  assert.equal(addressedResults[0]?.key, 'status', 'Expected addressed search to surface the written status fact.');

  console.log('hybrid multihop search tests passed');
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
