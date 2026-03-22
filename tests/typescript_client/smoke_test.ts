import 'dotenv/config';
import { IrantiClient, IrantiError } from '../../clients/typescript/src';

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function main(): Promise<void> {
    const apiKey = process.env.IRANTI_API_KEY;
    if (!apiKey) {
        throw new Error('IRANTI_API_KEY is required for the TypeScript client smoke test.');
    }

    const client = new IrantiClient({
        baseUrl: process.env.IRANTI_URL ?? 'http://localhost:3001',
        apiKey,
        timeout: 30_000,
    });

    const agentId = uniqueId('ts_client_agent');
    const entity = `project/${uniqueId('ts_client_project')}`;
    const team = `team/${uniqueId('ts_client_team')}`;
    const searchNeedle = uniqueId('typescript_smoke');
    const personalEntity = `person/${uniqueId('ts_client_person')}`;

    const health = await client.health();
    expect(health.status === 'ok', `Expected health status ok, got ${health.status}`);

    const register = await client.registerAgent({
        agentId,
        name: 'TypeScript Smoke Agent',
        description: 'Agent registered by the external TypeScript client smoke test.',
        capabilities: ['write', 'query', 'memory'],
        model: 'smoke-model',
    });
    expect(register.success === true, 'Expected registerAgent() success response.');

    const agent = await client.getAgent(agentId);
    expect(agent !== null, 'Expected getAgent() to return the registered agent.');
    expect(agent?.profile.agentId === agentId, 'Expected registered agentId to round-trip.');

    const write = await client.write({
        entity,
        key: 'status',
        value: { phase: 'active', marker: searchNeedle },
        summary: `TypeScript smoke status ${searchNeedle}.`,
        confidence: 88,
        source: 'typescript_smoke',
        agent: agentId,
    });
    expect(['created', 'updated'].includes(write.action), `Expected successful write action, got ${write.action}`);

    const query = await client.query(entity, 'status');
    expect(query.found === true, 'Expected query() to find the written fact.');
    expect(query.summary?.includes(searchNeedle), 'Expected query() summary to include the smoke marker.');

    const queryAll = await client.queryAll(entity);
    expect(queryAll.some((fact) => fact.key === 'status'), 'Expected queryAll() to include the status fact.');

    const search = await client.search({
        query: searchNeedle,
        limit: 5,
        entityType: 'project',
    });
    expect(search.some((result) => result.entity === entity && result.key === 'status'), 'Expected search() to return the written fact.');

    await client.write({
        entity,
        key: 'team_size',
        value: { count: 42 },
        summary: 'Team size is 42 employees.',
        confidence: 89,
        source: 'typescript_smoke',
        agent: agentId,
    });

    const semanticSearch = await client.search({
        query: 'employee headcount',
        limit: 5,
        entityType: 'project',
    });
    expect(
        semanticSearch.some((result) => result.entity === entity && result.key === 'team_size' && result.vectorScore > 0),
        'Expected semantic search() to produce a positive vector score for the written team_size fact.'
    );

    const relate = await client.relate({
        fromEntity: entity,
        relationshipType: 'MEMBER_OF',
        toEntity: team,
        createdBy: agentId,
        properties: { marker: searchNeedle },
    });
    expect(relate.success === true, 'Expected relate() success response.');

    const related = await client.related(entity);
    expect(
        related.some((row) => row.entityType === 'team' && row.entityId === team.split('/')[1] && row.relationshipType === 'MEMBER_OF'),
        'Expected related() to return the created relationship.'
    );

    const brief = await client.handshake({
        agent: agentId,
        task: 'Validate the external TypeScript client against the live API.',
        recentMessages: [`Need current status for ${entity}.`],
    });
    expect(brief.agentId === agentId, `Expected handshake agentId ${agentId}, got ${brief.agentId}`);

    const recoveryAgent = uniqueId('ts_client_recovery_agent');
    const recoveryTask = 'Prepare the incident response checklist';
    const checkpointBrief = await client.checkpoint({
        agentId: recoveryAgent,
        task: recoveryTask,
        recentMessages: [
            'Drafting the incident response checklist',
            'Waiting on the final approvals',
        ],
        checkpoint: {
            currentStep: 'drafting incident response checklist',
            nextStep: 'collect approvals',
            openRisks: ['Approval pending'],
            recentOutputs: ['Listed escalation owners'],
            entityTargets: ['project/incident_response'],
            notes: 'Interrupted before sign-off.',
        },
        heartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    expect(Boolean(checkpointBrief.sessionCheckpoint?.sessionId), 'Expected checkpoint() to return a session id.');

    const recoveryBrief = await client.handshake({
        agent: recoveryAgent,
        task: recoveryTask,
        recentMessages: ['Returning to the incident response checklist.'],
    });
    expect(recoveryBrief.sessionRecovery?.available === true, 'Expected handshake() to surface interrupted-session recovery.');
    expect(recoveryBrief.sessionRecovery?.recommendation === 'resume', 'Expected recovery recommendation to be resume.');
    expect(
        recoveryBrief.sessionRecovery?.matchedCurrentTask === true,
        'Expected recovery handshake to match the returning task.'
    );

    const resumedBrief = await client.resumeSession({
        agentId: recoveryAgent,
        sessionId: checkpointBrief.sessionCheckpoint?.sessionId,
    });
    expect(resumedBrief.sessionCheckpoint?.status === 'active', 'Expected resumeSession() to reactivate the checkpoint.');

    await client.completeSession({
        agentId: recoveryAgent,
        sessionId: checkpointBrief.sessionCheckpoint?.sessionId,
    });

    const observe = await client.observe({
        agentId,
        currentContext: '',
    });
    expect(Array.isArray(observe.facts), 'Expected observe() to return a facts array.');

    await client.write({
        entity: personalEntity,
        key: 'favorite_city',
        value: { city: 'Lisbon' },
        summary: 'Favorite city is Lisbon.',
        confidence: 91,
        source: 'typescript_smoke',
        agent: agentId,
    });

    const attend = await client.attend({
        agentId,
        currentContext: 'User: hello\nAssistant:',
        latestMessage: 'What is my favorite city?',
        entityHints: [personalEntity],
    });
    expect(attend.shouldInject === true, 'Expected attend() to inject favorite city memory.');
    expect(attend.facts.some((fact) => fact.entityKey === `${personalEntity}/favorite_city`), 'Expected attend() facts to include the isolated personal entity favorite_city.');

    const slashEntity = `project/${uniqueId('ts_client_slash_project')}`;
    const slashValue = {
        url: 'https://example.com/a/b',
        ratio: '3/4',
        label: 'A/B test path',
    };
    await client.write({
        entity: slashEntity,
        key: 'slash_value',
        value: slashValue,
        summary: 'Slash payload A/B https://example.com/a/b 3/4',
        confidence: 90,
        source: 'typescript_smoke',
        agent: agentId,
    });
    const slashQuery = await client.query(slashEntity, 'slash_value');
    expect(slashQuery.found === true, 'Expected slash-bearing fact to remain queryable.');
    expect(
        JSON.stringify(slashQuery.value).includes('https://example.com/a/b'),
        'Expected slash-bearing query value to preserve URLs and ratios.'
    );
    const slashSearch = await client.search({
        query: 'A/B https://example.com/a/b 3/4',
        limit: 5,
        entityType: 'project',
    });
    expect(
        slashSearch.some((result) => result.entity === slashEntity && result.key === 'slash_value'),
        'Expected slash-bearing fact to remain searchable.'
    );

    console.log('TypeScript client smoke test');
    console.log('---------------------------');
    console.log(`health: ok (${health.provider})`);
    console.log(`agent: ${agentId}`);
    console.log(`entity: ${entity}`);
    console.log(`write: ${write.action}`);
    console.log(`search matches: ${search.length}`);
    console.log(`semantic search matches: ${semanticSearch.length}`);
    console.log(`slash search matches: ${slashSearch.length}`);
    console.log(`related count: ${related.length}`);
    console.log(`attend: shouldInject=${attend.shouldInject} reason=${attend.reason}`);
}

main().catch((error: unknown) => {
    if (error instanceof IrantiError) {
        console.error(`TypeScript client smoke failed: ${error.message}`);
        if (error.status !== undefined) {
            console.error(`status=${error.status}`);
        }
        if (error.body !== undefined) {
            console.error(JSON.stringify(error.body, null, 2));
        }
    } else if (error instanceof Error) {
        console.error(`TypeScript client smoke failed: ${error.message}`);
    } else {
        console.error(`TypeScript client smoke failed: ${String(error)}`);
    }
    process.exit(1);
});
