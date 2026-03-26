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
  const priorMemoryEntity = process.env.IRANTI_MEMORY_ENTITY;
  const priorPersonalMemoryEntity = process.env.IRANTI_PERSONAL_MEMORY_ENTITY;

  const agentId = uniqueId('memory_regression_agent');
  await iranti.registerAgent({
    agentId,
    name: 'Memory Regression Agent',
    description: 'Covers slash values and explicit-hint isolation regressions.',
    capabilities: ['query', 'observe', 'attend'],
    model: 'mock',
  });

  try {
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
      agentId,
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
      agentId,
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
      agentId,
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

    const projectEntity = `project/${uniqueId('project_memory')}`;
    const personalMemoryEntity = `user/${uniqueId('personal_memory')}`;
    process.env.IRANTI_MEMORY_ENTITY = projectEntity;
    process.env.IRANTI_PERSONAL_MEMORY_ENTITY = personalMemoryEntity;

    await iranti.write({
      entity: personalMemoryEntity,
      key: 'favorite_book',
      value: { text: 'The Left Hand of Darkness' },
      summary: 'favorite book is The Left Hand of Darkness',
      confidence: 94,
      source: 'memory_regression_personal',
      agent: agentId,
    });

    await iranti.write({
      entity: projectEntity,
      key: 'favorite_book',
      value: { text: 'Contaminated project favorite book' },
      summary: 'favorite book is Contaminated project favorite book',
      confidence: 80,
      source: 'memory_regression_project',
      agent: agentId,
    });

    const personalAttend = await iranti.attend({
      agentId,
      currentContext: '',
      latestMessage: 'What is my favorite book?',
      forceInject: true,
      maxFacts: 5,
    });
    assert.ok(
      personalAttend.facts.some((fact: { entityKey: string }) => fact.entityKey === `${personalMemoryEntity}/favorite_book`),
      'Expected personal recall prompts to prefer IRANTI_PERSONAL_MEMORY_ENTITY.'
    );
    assert.ok(
      personalAttend.facts.every((fact: { entityKey: string }) => !fact.entityKey.startsWith(`${projectEntity}/favorite_book`)),
      'Expected personal recall prompts to suppress project favorite_book contamination.'
    );

    console.log('memory retrieval regressions passed');
  } finally {
    if (priorMemoryEntity === undefined) {
      delete process.env.IRANTI_MEMORY_ENTITY;
    } else {
      process.env.IRANTI_MEMORY_ENTITY = priorMemoryEntity;
    }

    if (priorPersonalMemoryEntity === undefined) {
      delete process.env.IRANTI_PERSONAL_MEMORY_ENTITY;
    } else {
      process.env.IRANTI_PERSONAL_MEMORY_ENTITY = priorPersonalMemoryEntity;
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
