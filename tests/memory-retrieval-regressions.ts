import assert from 'node:assert/strict';
import { Iranti } from '../src/sdk';

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for memory regression tests.');
  }

  process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'mock';

  const iranti = new Iranti({ connectionString, llmProvider: process.env.LLM_PROVIDER });

  const agentId = uniqueId('memory_regression_agent');
  await iranti.registerAgent({
    agentId,
    name: 'Memory Regression Agent',
    description: 'Covers slash values and explicit-hint isolation regressions.',
    capabilities: ['query', 'observe', 'attend'],
    model: 'mock',
  });

  const slashEntity = `project/${uniqueId('slash_entity')}`;
  await iranti.write({
    entity: slashEntity,
    key: 'api_endpoint',
    value: { text: '/v1/health', label: 'A/B path', ratio: '3/4' },
    summary: 'API endpoint is /v1/health for the A/B path with ratio 3/4.',
    confidence: 91,
    source: 'memory_regression',
    agent: agentId,
  });

  const slashQuery = await iranti.query(slashEntity, 'api_endpoint');
  assert.equal(slashQuery.found, true, 'Expected slash-bearing fact to be queryable.');

  const slashSearch = await iranti.search({
    query: '/v1/health A/B 3/4',
    entityType: 'project',
    limit: 5,
  });
  assert.ok(
    slashSearch.some((result: { entity: string; key: string }) => result.entity === slashEntity && result.key === 'api_endpoint'),
    'Expected slash-bearing fact to remain searchable.'
  );

  const slashObserve = await iranti.observe({
    agent: agentId,
    currentContext: `Need the API endpoint for ${slashEntity}.`,
    entityHints: [slashEntity],
    maxFacts: 5,
  });
  assert.ok(
    slashObserve.facts.some((fact: { entityKey: string }) => fact.entityKey === `${slashEntity}/api_endpoint`),
    'Expected observe() to return slash-bearing fact when explicit hint is provided.'
  );
  assert.ok(
    !(slashObserve.debug?.dropped ?? []).some((item: { name: string }) => item.name.includes('parse_error')),
    'Expected observe() hint path to avoid entity extraction parse-error noise.'
  );

  const slashAttend = await iranti.attend({
    agent: agentId,
    currentContext: `Need the API endpoint for ${slashEntity}.`,
    latestMessage: 'What is the API endpoint?',
    entityHints: [slashEntity],
    forceInject: true,
    maxFacts: 5,
  });
  assert.ok(
    slashAttend.facts.some((fact: { entityKey: string }) => fact.entityKey === `${slashEntity}/api_endpoint`),
    'Expected attend() to return slash-bearing fact when explicit hint is provided.'
  );

  await iranti.write({
    entity: 'user/main',
    key: 'favorite_city',
    value: { city: 'NoiseTown' },
    summary: 'Favorite city is NoiseTown.',
    confidence: 92,
    source: 'memory_regression_noise',
    agent: agentId,
  });

  const personalEntity = `person/${uniqueId('personal_entity')}`;
  await iranti.write({
    entity: personalEntity,
    key: 'favorite_city',
    value: { city: 'Lisbon' },
    summary: 'Favorite city is Lisbon.',
    confidence: 91,
    source: 'memory_regression',
    agent: agentId,
  });

  const isolatedAttend = await iranti.attend({
    agent: agentId,
    currentContext: 'User: hello\nAssistant:',
    latestMessage: 'What is my favorite city?',
    entityHints: [personalEntity],
    forceInject: true,
    maxFacts: 5,
  });

  assert.ok(
    isolatedAttend.facts.some((fact: { entityKey: string }) => fact.entityKey === `${personalEntity}/favorite_city`),
    'Expected explicit personal hint to return the requested personal-memory fact.'
  );
  assert.ok(
    isolatedAttend.facts.every((fact: { entityKey: string }) => !fact.entityKey.startsWith('user/main/')),
    'Expected explicit personal hint to suppress user/main noise.'
  );

  console.log('memory retrieval regressions passed');
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
