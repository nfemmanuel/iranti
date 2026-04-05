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
  const writerAgentId = uniqueId('memory_regression_writer');
  await iranti.registerAgent({
    agentId,
    name: 'Memory Regression Agent',
    description: 'Covers slash values and explicit-hint isolation regressions.',
    capabilities: ['query', 'observe', 'attend'],
    model: 'mock',
  });
  await iranti.registerAgent({
    agentId: writerAgentId,
    name: 'Memory Regression Writer',
    description: 'Writes shared state so freshness-aware attend() can pick it up.',
    capabilities: ['write', 'checkpoint'],
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
      entityId: slashEntity.split('/')[1],
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
    assert.equal(slashObserve.usageGuidance.tool, 'observe', 'Expected observe() to return explicit usage guidance.');
    assert.match(
      slashObserve.usageGuidance.note,
      /retrieval-only/i,
      'Expected observe() usage guidance to clarify that observe() is retrieval-only.'
    );
    assert.ok(
      !(slashObserve.debug?.dropped ?? []).some((item: { name: string }) => item.name.includes('parse_error')),
      'Expected observe() hint path to avoid entity extraction parse-error noise.'
    );

    const hintlessObserveAgentId = uniqueId('hintless_observe_agent');
    await iranti.registerAgent({
      agentId: hintlessObserveAgentId,
      name: 'Hintless Observe Agent',
      description: 'Verifies observe() can recover scoped project facts without explicit entity hints.',
      capabilities: ['handshake', 'observe', 'write'],
      model: 'mock',
    });
    const hintlessObserveEntity = `project/${uniqueId('hintless_observe_project')}`;
    await iranti.write({
      entity: hintlessObserveEntity,
      key: 'next_step',
      value: { instruction: 'Fix the failing migration.' },
      summary: 'Next step is to fix the failing migration.',
      confidence: 94,
      source: 'memory_regression',
      agent: agentId,
    });
    const hintlessObserveBrief = await iranti.handshake({
      agentId: hintlessObserveAgentId,
      task: `Continue work on ${hintlessObserveEntity}.`,
      recentMessages: [`Need the next step for ${hintlessObserveEntity}.`],
    });
    assert.ok(
      hintlessObserveBrief.watchedEntities?.includes(hintlessObserveEntity),
      'Expected handshake() to seed watchedEntities from scoped task context.'
    );
    const hintlessObserve = await iranti.observe({
      agentId: hintlessObserveAgentId,
      currentContext: 'What is the next step?',
      maxFacts: 5,
    });
    assert.ok(
      hintlessObserve.facts.some((fact: { entityKey: string }) => fact.entityKey === `${hintlessObserveEntity}/next_step`),
      'Expected observe() to recover the scoped next_step fact without explicit entity hints after handshake.'
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
    assert.equal(slashAttend.usageGuidance.tool, 'attend', 'Expected attend() to return explicit usage guidance.');
    // expectedCallSequence removed from attend responses — protocol now lives in IRANTI.md.
    assert.ok(
      !slashAttend.usageGuidance.expectedCallSequence || slashAttend.usageGuidance.expectedCallSequence.length === 0,
      'Expected attend() to omit expectedCallSequence (protocol moved to IRANTI.md).'
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

    process.env.IRANTI_PERSONAL_MEMORY_ENTITY = 'user/main';

    await iranti.write({
      entity: 'person/user',
      key: 'height',
      value: `6'0"`,
      summary: `User is 6'0" tall`,
      confidence: 100,
      source: 'memory_regression_height',
      agent: agentId,
    });

    const heightQuery = await iranti.query('user/main', 'height');
    assert.equal(heightQuery.found, true, 'Expected personal height recall to fall back across legacy person/user storage.');
    assert.equal(heightQuery.resolvedEntity, 'user/main');

    const heightAttend = await iranti.attend({
      agentId,
      currentContext: '',
      latestMessage: 'How tall am I?',
      maxFacts: 5,
    });

    assert.equal(heightAttend.shouldInject, true, 'Expected “How tall am I?” to force personal memory recall.');
    assert.equal(heightAttend.decision.explanation, 'personal_height_recall_prompt');
    assert.ok(
      heightAttend.facts.some((fact: { entityKey: string }) => fact.entityKey === 'user/main/height'),
      'Expected personal height recall to surface the canonical user/main height fact.'
    );

    const handoffEntity = `project/${uniqueId('cli_chat_handoff')}`;
    await iranti.write({
      entity: handoffEntity,
      key: 'status',
      value: { from: 'cli', to: 'chat', status: 'green' },
      summary: 'CLI to chat handoff status is green.',
      confidence: 96,
      source: 'memory_regression_handoff',
      agent: agentId,
    });

    const handoffAttend = await iranti.attend({
      agentId,
      currentContext: '',
      latestMessage: `What is the status of ${handoffEntity}?`,
      maxFacts: 5,
    });

    assert.equal(
      handoffAttend.shouldInject,
      true,
      'Expected explicit entity mention without the fact value to still inject the handoff fact.'
    );
    assert.ok(
      handoffAttend.facts.some((fact: { entityKey: string }) => fact.entityKey === `${handoffEntity}/status`),
      'Expected explicit entity mention to inject the missing status fact rather than treating it as already present.'
    );

    const wrongHintAttend = await iranti.attend({
      agentId,
      currentContext: '',
      latestMessage: `What is the status of ${handoffEntity}?`,
      entityHints: [`project/iranti/${handoffEntity.split('/')[1]}`],
      forceInject: true,
      maxFacts: 5,
    });

    assert.equal(
      wrongHintAttend.shouldInject,
      true,
      'Expected exact entity mention in the latest message to override a bad host-supplied hint.'
    );
    assert.ok(
      wrongHintAttend.facts.some((fact: { entityKey: string }) => fact.entityKey === `${handoffEntity}/status`),
      'Expected attend() to recover the exact entity from the user message even when entityHints drift to a nearby project/iranti path.'
    );
    assert.ok(
      wrongHintAttend.entitiesResolved?.some((entity: { canonicalEntity: string }) => entity.canonicalEntity === handoffEntity),
      'Expected entitiesResolved to include the exact handoff entity from the latest message.'
    );

    const freshWatcherAgentId = uniqueId('fresh_state_watcher');
    const freshWriterAgentId = uniqueId('fresh_state_writer');
    await iranti.registerAgent({
      agentId: freshWatcherAgentId,
      name: 'Fresh State Watcher',
      description: 'Watches a single entity to verify watched-entity freshness refreshes.',
      capabilities: ['query', 'observe', 'attend'],
      model: 'mock',
    });
    await iranti.registerAgent({
      agentId: freshWriterAgentId,
      name: 'Fresh State Writer',
      description: 'Writes a fresh checkpoint for watched-entity refresh coverage.',
      capabilities: ['write', 'checkpoint'],
      model: 'mock',
    });

    const freshStateEntity = `project/${uniqueId('fresh_state')}`;
    await iranti.handshake({
      agentId: freshWatcherAgentId,
      task: `Track fresh shared state for ${freshStateEntity}.`,
      recentMessages: [`Watching ${freshStateEntity} for new shared breadcrumbs.`],
    });
    await iranti.attend({
      agentId: freshWatcherAgentId,
      currentContext: `Continue work on ${freshStateEntity}.`,
      latestMessage: `What is the status of ${freshStateEntity}?`,
      entityHints: [freshStateEntity],
      forceInject: true,
      maxFacts: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await iranti.checkpoint({
      agentId: freshWriterAgentId,
      task: `Record a fresh shared update for ${freshStateEntity}.`,
      recentMessages: ['Updated a shared runtime file and left a breadcrumb.'],
      checkpoint: {
        currentStep: 'updated the shared runtime file',
        nextStep: 'let another agent pick up the change',
        recentOutputs: ['saved a fresh file-change breadcrumb'],
        fileChanges: [
          {
            action: 'updated',
            path: 'src/runtimeEnv.ts',
            purpose: 'fresh state regression coverage',
          },
        ],
        entityTargets: [freshStateEntity],
      },
    });

    const freshStateAttend = await iranti.attend({
      agentId: freshWatcherAgentId,
      currentContext: 'Continue the current project work.',
      latestMessage: 'continue',
      maxFacts: 5,
    });

    assert.equal(
      freshStateAttend.shouldInject,
      true,
      'Expected attend() to refresh when relevant shared state changed after the brief was generated.'
    );
    assert.ok(
      freshStateAttend.facts.some((fact: { entityKey: string }) => fact.entityKey === `${freshStateEntity}/recent_file_changes`),
      'Expected freshness-aware attend() to surface the newly written shared file-change breadcrumb without repeating entity hints.'
    );

    const freshStateAttendRepeat = await iranti.attend({
      agentId: freshWatcherAgentId,
      currentContext: 'Continue the current project work.',
      latestMessage: 'continue',
      maxFacts: 5,
    });

    assert.equal(
      freshStateAttendRepeat.shouldInject,
      false,
      'Expected a repeated ambiguous continue turn to stop re-injecting once the watcher already observed the fresh shared state.'
    );

    const relatedWatcherAgentId = uniqueId('related_fresh_state_watcher');
    const relatedWriterAgentId = uniqueId('related_fresh_state_writer');
    await iranti.registerAgent({
      agentId: relatedWatcherAgentId,
      name: 'Related Fresh State Watcher',
      description: 'Tracks a project entity and expects related issue breadcrumbs to surface on ambiguous follow-up turns.',
      capabilities: ['query', 'observe', 'attend'],
      model: 'mock',
    });
    await iranti.registerAgent({
      agentId: relatedWriterAgentId,
      name: 'Related Fresh State Writer',
      description: 'Writes a fresh breadcrumb on a directly related issue entity.',
      capabilities: ['write', 'checkpoint'],
      model: 'mock',
    });

    const relatedProjectEntity = `project/${uniqueId('routing_project')}`;
    const relatedIssueEntity = `issue/${uniqueId('routing_issue')}`;
    await iranti.relate(
      relatedProjectEntity,
      'TRACKS',
      relatedIssueEntity,
      { createdBy: relatedWriterAgentId }
    );
    await iranti.handshake({
      agentId: relatedWatcherAgentId,
      task: `Track the status of ${relatedProjectEntity}.`,
      recentMessages: [`Watching ${relatedProjectEntity} for fresh related work.`],
    });
    await iranti.attend({
      agentId: relatedWatcherAgentId,
      currentContext: `Continue work on ${relatedProjectEntity}.`,
      latestMessage: `What is the status of ${relatedProjectEntity}?`,
      entityHints: [relatedProjectEntity],
      forceInject: true,
      maxFacts: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await iranti.checkpoint({
      agentId: relatedWriterAgentId,
      task: `Record a fresh issue update for ${relatedIssueEntity}.`,
      recentMessages: ['Found a blocking issue and left a shared checkpoint.'],
      checkpoint: {
        currentStep: 'confirmed a related issue is now blocking progress',
        nextStep: 'route the blocker back to the project owner',
        recentOutputs: ['saved a related blocker breadcrumb'],
        fileChanges: [
          {
            action: 'updated',
            path: 'src/attendant/AttendantInstance.ts',
            purpose: 'related-entity freshness regression coverage',
          },
        ],
        entityTargets: [relatedIssueEntity],
      },
    });

    const relatedFreshStateAttend = await iranti.attend({
      agentId: relatedWatcherAgentId,
      currentContext: 'Continue the current project work.',
      latestMessage: 'what changed?',
      maxFacts: 5,
    });

    assert.equal(
      relatedFreshStateAttend.shouldInject,
      true,
      'Expected attend() to refresh when a directly related entity received a fresh shared breadcrumb.'
    );
    assert.ok(
      relatedFreshStateAttend.facts.some((fact: { entityKey: string }) => fact.entityKey === `${relatedIssueEntity}/recent_file_changes`),
      'Expected freshness-aware attend() to surface the related issue breadcrumb while the watcher remains scoped to the project entity.'
    );

    // searchSuggestion: populated when memory is needed but no facts exist; absent on successful inject
    const emptyEntity = `project/${uniqueId('empty_attend_entity')}`;
    await iranti.handshake({
      agentId,
      task: 'Investigate empty entity for search suggestion regression.',
      recentMessages: ['Checking docker container startup issues.'],
    });
    const emptyAttend = await iranti.attend({
      agentId,
      currentContext: 'No prior context.',
      latestMessage: 'What is the docker container startup issue?',
      entityHints: [emptyEntity],
      forceInject: true,
      maxFacts: 5,
    });
    assert.equal(
      emptyAttend.reason,
      'memory_needed_no_facts',
      'Expected reason to be memory_needed_no_facts when entity has no written facts.'
    );
    assert.ok(
      emptyAttend.searchSuggestion,
      'Expected searchSuggestion to be populated when attend finds no facts.'
    );
    assert.ok(
      typeof emptyAttend.searchSuggestion!.hint === 'string' && emptyAttend.searchSuggestion!.hint.length > 0,
      'Expected searchSuggestion.hint to be a non-empty string.'
    );
    assert.ok(
      Array.isArray(emptyAttend.searchSuggestion!.suggestedTerms) && emptyAttend.searchSuggestion!.suggestedTerms.length > 0,
      'Expected searchSuggestion.suggestedTerms to carry tokens extracted from latestMessage.'
    );
    assert.ok(
      Array.isArray(emptyAttend.searchSuggestion!.alternativeEntities),
      'Expected searchSuggestion.alternativeEntities to be an array.'
    );
    assert.ok(
      emptyAttend.searchSuggestion!.suggestedTerms.every((t: string) => t.length >= 3),
      'Expected every suggestedTerm to be at least 3 characters (noise tokens filtered out).'
    );

    // searchSuggestion must be absent when facts are successfully injected
    const richEntity = `project/${uniqueId('rich_attend_entity')}`;
    await iranti.write({
      entity: richEntity,
      key: 'status',
      value: { state: 'active', detail: 'search suggestion regression' },
      summary: 'The entity is active — search suggestion regression fixture.',
      confidence: 90,
      source: 'memory_regression',
      agent: agentId,
    });
    const richAttend = await iranti.attend({
      agentId,
      currentContext: '',
      latestMessage: `What is the status of ${richEntity}?`,
      entityHints: [richEntity],
      forceInject: true,
      maxFacts: 5,
    });
    assert.equal(richAttend.shouldInject, true, 'Expected facts to be injected for entity with written data.');
    assert.equal(richAttend.searchSuggestion, undefined, 'Expected searchSuggestion to be absent when facts were successfully injected.');

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
