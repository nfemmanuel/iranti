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

    const observe = await client.observe({
        agentId,
        currentContext: '',
    });
    expect(Array.isArray(observe.facts), 'Expected observe() to return a facts array.');

    const attend = await client.attend({
        agentId,
        currentContext: 'User: hello\nAssistant:',
        latestMessage: 'hello',
    });
    expect(typeof attend.shouldInject === 'boolean', 'Expected attend() to return shouldInject.');

    console.log('TypeScript client smoke test');
    console.log('---------------------------');
    console.log(`health: ok (${health.provider})`);
    console.log(`agent: ${agentId}`);
    console.log(`entity: ${entity}`);
    console.log(`write: ${write.action}`);
    console.log(`search matches: ${search.length}`);
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
