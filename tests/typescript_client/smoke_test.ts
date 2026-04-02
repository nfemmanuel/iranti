import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { IrantiClient, IrantiError } from '../../clients/typescript/src';
import { disconnectDb, initDb } from '../../src/library/client';
import { findEntry } from '../../src/library/queries';

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function readEnvFile(filePath: string): Record<string, string> {
    const out: Record<string, string> = {};
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx <= 0) continue;
        out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
    return out;
}

function ensureBoundInstanceEnvLoaded(): void {
    const bindingPath = path.resolve('.env.iranti');
    if (!fs.existsSync(bindingPath)) return;
    const binding = readEnvFile(bindingPath);
    for (const [key, value] of Object.entries(binding)) {
        if (key.startsWith('IRANTI_')) {
            process.env[key] = value;
        } else if (!process.env[key]) {
            process.env[key] = value;
        }
    }
    const instanceEnvPath = binding.IRANTI_INSTANCE_ENV?.trim();
    if (!instanceEnvPath || !fs.existsSync(instanceEnvPath)) return;
    const instanceEnv = readEnvFile(instanceEnvPath);
    for (const [key, value] of Object.entries(instanceEnv)) {
        process.env[key] = value;
    }
}

async function main(): Promise<void> {
    ensureBoundInstanceEnvLoaded();
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL is required for the TypeScript client smoke test raw-entry assertions.');
    }
    await initDb(connectionString);
    try {
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
        properties: {
            issueStatus: 'open',
            issueType: 'smoke_test',
            marker: searchNeedle,
        },
    });
    expect(['created', 'updated'].includes(write.action), `Expected successful write action, got ${write.action}`);

    const storedStatusEntry = await findEntry({
        entityType: 'project',
        entityId: entity.split('/')[1]!,
        key: 'status',
    });
    expect(Boolean(storedStatusEntry), 'Expected the TypeScript client write to persist a raw knowledge entry.');
    const statusProperties = storedStatusEntry?.properties as Record<string, unknown>;
    expect(statusProperties.issueStatus === 'open', 'Expected write properties to round-trip through the HTTP write surface.');
    expect(statusProperties.issueType === 'smoke_test', 'Expected issue metadata to persist through the TypeScript client write.');

    const query = await client.query(entity, 'status');
    expect(query.found === true, 'Expected query() to find the written fact.');
    expect(query.summary?.includes(searchNeedle), 'Expected query() summary to include the smoke marker.');

    const issueWrite = await client.writeIssue({
        entity,
        issueId: 'open_issue_lifecycle',
        title: 'Open issue lifecycle missing',
        status: 'open',
        summary: 'Open issue lifecycle is not yet first-class.',
        confidence: 92,
        source: 'typescript_smoke',
        agent: agentId,
        severity: 'high',
        tags: ['issue-lifecycle', 'tracking'],
        details: { note: 'Need a stable key that can later resolve.' },
    });
    expect(['created', 'updated'].includes(issueWrite.action), `Expected writeIssue() to succeed, got ${issueWrite.action}`);

    const resolvedIssueWrite = await client.writeIssue({
        entity,
        issueId: 'open_issue_lifecycle',
        title: 'Open issue lifecycle missing',
        status: 'resolved',
        summary: 'Open issue lifecycle is now first-class.',
        confidence: 95,
        source: 'typescript_smoke',
        agent: agentId,
        severity: 'high',
        resolution: 'Added stable issue helpers for the SDK and clients.',
        resolvedAt: new Date().toISOString(),
        tags: ['issue-lifecycle', 'tracking'],
    });
    expect(['created', 'updated'].includes(resolvedIssueWrite.action), `Expected resolved writeIssue() to succeed, got ${resolvedIssueWrite.action}`);

    const issueQuery = await client.query(entity, 'issue_open_issue_lifecycle');
    expect(issueQuery.found === true, 'Expected issue fact to be queryable on its stable issue key.');
    const issueValue = issueQuery.value as Record<string, unknown>;
    expect(issueValue.status === 'resolved', 'Expected the stable issue key to hold the resolved status after update.');

    const issueHistory = await client.history(entity, 'issue_open_issue_lifecycle');
    expect(issueHistory.length >= 2, 'Expected issue history to retain both open and resolved states.');

    const storedIssueEntry = await findEntry({
        entityType: 'project',
        entityId: entity.split('/')[1]!,
        key: 'issue_open_issue_lifecycle',
    });
    expect(Boolean(storedIssueEntry), 'Expected the TypeScript client writeIssue() helper to persist a raw knowledge entry.');
    const issueProperties = storedIssueEntry?.properties as Record<string, unknown>;
    expect(issueProperties.issueStatus === 'resolved', 'Expected issue properties to reflect the latest resolved state.');
    expect(issueProperties.durableClass === 'issue_status', 'Expected issue helper writes to tag durableClass=issue_status.');

    const queryAll = await client.queryAll(entity);
    expect(queryAll.some((fact) => fact.key === 'status'), 'Expected queryAll() to include the status fact.');
    expect(queryAll.some((fact) => fact.key === 'issue_open_issue_lifecycle'), 'Expected queryAll() to include the stable issue fact.');

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
        agentId,
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
        agentId: recoveryAgent,
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

    const inspectedSession = await client.inspectSession({ agentId: recoveryAgent });
    expect(inspectedSession.hasCheckpoint === true, 'Expected inspectSession() to report the persisted session.');
    expect(inspectedSession.sessionCheckpoint?.sessionId === checkpointBrief.sessionCheckpoint?.sessionId, 'Expected inspectSession() to return the active checkpoint session id.');
    expect(inspectedSession.summary.operatorState === 'active', 'Expected inspectSession() summary to expose operator-facing active state.');

    const listedSessions = await client.listSessions({ operatorState: 'active', sort: 'updated_desc' });
    expect(
        listedSessions.some((session) => session.agentId === recoveryAgent && session.sessionId === checkpointBrief.sessionCheckpoint?.sessionId),
        'Expected listSessions() to include the recovery checkpoint.'
    );

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
    } finally {
        await disconnectDb();
    }
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
