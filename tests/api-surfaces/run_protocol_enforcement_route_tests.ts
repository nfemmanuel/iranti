import 'dotenv/config';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { bootstrapHarness } from '../../scripts/harness';
import { Iranti } from '../../src/sdk';
import { knowledgeRoutes } from '../../src/api/routes/knowledge';
import { memoryRoutes } from '../../src/api/routes/memory';
import { disconnectDb } from '../../src/library/client';
import { resolveValidationDatabaseUrl } from '../helpers/resolveValidationDatabase';

function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof createServer>; baseUrl: string }> {
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to resolve protocol-enforcement route test server address.');
    }
    return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
    };
}

async function main(): Promise<void> {
    process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'mock';
    const priorProjectMemoryEntity = process.env.IRANTI_MEMORY_ENTITY;
    const connectionString = await resolveValidationDatabaseUrl('protocol enforcement route tests');
    bootstrapHarness({
        requireDb: true,
        forceLocalEscalationDir: true,
        dbApplicationName: 'iranti:test:protocol_enforcement_routes',
    });

    const iranti = new Iranti({
        connectionString,
        llmProvider: process.env.LLM_PROVIDER,
        dbApplicationName: 'iranti:test:protocol_enforcement_routes',
        protocolEnforcement: 'strict',
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        (req as express.Request & {
            irantiAuth?: { mode: string; keyId: string; owner: string; scopes: string[]; userId: number; tokenScope: string };
        }).irantiAuth = {
            mode: 'registry',
            scopes: ['kb:read', 'kb:write', 'memory:read', 'memory:write'],
            keyId: 'protocol_route_test_key',
            owner: 'protocol route test',
            userId: 1,
            tokenScope: 'dev_cli',
        };
        next();
    });
    app.use('/kb', knowledgeRoutes(iranti));
    app.use('/memory', memoryRoutes(iranti));

    const { server, baseUrl } = await listen(app);
    const entity = `project/${uniqueId('protocol_route_project')}`;
    const agentId = uniqueId('protocol_route_agent');
    const [, entityId] = entity.split('/');
    const projectPolicyEntity = `project/${uniqueId('protocol_policy_project')}`;
    process.env.IRANTI_MEMORY_ENTITY = projectPolicyEntity;

    try {
        await iranti.write({
            entity,
            key: 'status',
            value: { phase: 'route_test' },
            summary: 'Protocol enforcement route test project status is route_test.',
            confidence: 91,
            source: 'protocol_route_test',
            agent: agentId,
        });
        await iranti.write({
            entity: projectPolicyEntity,
            key: 'agent_worktree_cleanup_rule',
            value: { rule: 'Leave a clean worktree or emit an explicit residue report before ending the run.' },
            summary: 'Leave a clean worktree or emit an explicit residue report before ending the run.',
            confidence: 95,
            source: 'protocol_route_test',
            agent: agentId,
        });

        const queryBeforeHandshake = await fetch(`${baseUrl}/kb/query/project/${entityId}/status?agentId=${encodeURIComponent(agentId)}`);
        assert.equal(queryBeforeHandshake.status, 428, `Expected /kb/query before handshake to return 428, got ${queryBeforeHandshake.status}.`);
        const queryBeforeHandshakeBody = await queryBeforeHandshake.json() as { code?: string };
        assert.equal(queryBeforeHandshakeBody.code, 'handshake_required', `Expected handshake_required before handshake, got ${JSON.stringify(queryBeforeHandshakeBody)}.`);

        const handshake = await fetch(`${baseUrl}/memory/handshake`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                agentId,
                task: 'Validate route-level protocol enforcement.',
                recentMessages: ['Starting route protocol enforcement regression coverage.'],
            }),
        });
        assert.equal(handshake.status, 200, `Expected /memory/handshake to succeed, got ${handshake.status}.`);
        const handshakeBody = await handshake.json() as { operatingRules?: string; projectPolicies?: Array<{ key?: string }> };
        assert.equal(
            handshakeBody.projectPolicies?.some((entry) => entry.key === 'agent_worktree_cleanup_rule'),
            true,
            'Expected handshake to surface project-scoped policies on the route response.',
        );
        assert.equal(
            handshakeBody.operatingRules?.includes('Leave a clean worktree or emit an explicit residue report before ending the run.'),
            true,
            'Expected handshake to append the project-scoped policy into the operating rules.',
        );

        const queryBeforeAttend = await fetch(`${baseUrl}/kb/query/project/${entityId}/status?agentId=${encodeURIComponent(agentId)}`);
        assert.equal(queryBeforeAttend.status, 428, `Expected /kb/query before attend to return 428, got ${queryBeforeAttend.status}.`);
        const queryBeforeAttendBody = await queryBeforeAttend.json() as { code?: string };
        assert.equal(queryBeforeAttendBody.code, 'attend_required', `Expected attend_required before attend, got ${JSON.stringify(queryBeforeAttendBody)}.`);

        const attend = await fetch(`${baseUrl}/memory/attend`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                agentId,
                latestMessage: 'What is the route test project status?',
                currentContext: 'We are validating route-level protocol enforcement.',
                entityHints: [entity],
                phase: 'pre-response',
            }),
        });
        assert.equal(attend.status, 200, `Expected /memory/attend to succeed, got ${attend.status}.`);

        const attendWithoutPostResponse = await fetch(`${baseUrl}/memory/attend`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                agentId,
                latestMessage: 'Start another turn without closing the last one.',
                currentContext: 'We are validating post-response lifecycle enforcement.',
                entityHints: [entity],
                phase: 'pre-response',
            }),
        });
        assert.equal(attendWithoutPostResponse.status, 428, `Expected repeated pre-response attend to return 428, got ${attendWithoutPostResponse.status}.`);
        const attendWithoutPostResponseBody = await attendWithoutPostResponse.json() as { code?: string };
        assert.equal(attendWithoutPostResponseBody.code, 'post_response_required', `Expected post_response_required before starting another turn, got ${JSON.stringify(attendWithoutPostResponseBody)}.`);

        const closePreviousTurn = await fetch(`${baseUrl}/memory/attend`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                agentId,
                latestMessage: 'Close the previous response.',
                currentContext: 'We are closing the previous response loop.',
                phase: 'post-response',
            }),
        });
        assert.equal(closePreviousTurn.status, 200, `Expected post-response attend to succeed, got ${closePreviousTurn.status}.`);

        const nextAttend = await fetch(`${baseUrl}/memory/attend`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                agentId,
                latestMessage: 'Start the next turn correctly.',
                currentContext: 'We are validating the next turn after a compliant post-response.',
                entityHints: [entity],
                phase: 'pre-response',
            }),
        });
        assert.equal(nextAttend.status, 200, `Expected pre-response attend after a post-response close to succeed, got ${nextAttend.status}.`);

        const queryAfterAttend = await fetch(`${baseUrl}/kb/query/project/${entityId}/status?agentId=${encodeURIComponent(agentId)}`);
        assert.equal(queryAfterAttend.status, 200, `Expected /kb/query after attend to succeed, got ${queryAfterAttend.status}.`);
        const queryAfterAttendBody = await queryAfterAttend.json() as { found?: boolean; value?: { phase?: string } };
        assert.equal(queryAfterAttendBody.found, true, 'Expected /kb/query after attend to return the fact.');
        assert.equal(queryAfterAttendBody.value?.phase, 'route_test', 'Expected /kb/query after attend to return the written value.');

        const searchAfterConsumedBudget = await fetch(`${baseUrl}/kb/search?query=${encodeURIComponent(entity)}&agentId=${encodeURIComponent(agentId)}`);
        assert.equal(searchAfterConsumedBudget.status, 428, `Expected /kb/search after one discovery read to return 428, got ${searchAfterConsumedBudget.status}.`);
        const searchAfterConsumedBudgetBody = await searchAfterConsumedBudget.json() as { code?: string };
        assert.equal(searchAfterConsumedBudgetBody.code, 'attend_required', `Expected attend_required after the discovery budget was consumed, got ${JSON.stringify(searchAfterConsumedBudgetBody)}.`);

        const bootstrapAgentId = uniqueId('protocol_route_bootstrap_agent');
        const bootstrapEntity = `project/${uniqueId('protocol_route_bootstrap_project')}`;
        const [, bootstrapEntityId] = bootstrapEntity.split('/');

        await iranti.write({
            entity: bootstrapEntity,
            key: 'status',
            value: { phase: 'auto_bootstrap' },
            summary: 'Protocol enforcement auto-bootstrap project status is auto_bootstrap.',
            confidence: 91,
            source: 'protocol_route_test',
            agent: bootstrapAgentId,
        });

        const autoBootstrapAttend = await fetch(`${baseUrl}/memory/attend`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                agentId: bootstrapAgentId,
                latestMessage: 'What is the auto-bootstrap project status?',
                currentContext: 'We are validating attend auto-bootstrap under strict protocol.',
                entityHints: [bootstrapEntity],
                phase: 'pre-response',
            }),
        });
        assert.equal(autoBootstrapAttend.status, 200, `Expected auto-bootstrap attend to succeed, got ${autoBootstrapAttend.status}.`);
        const autoBootstrapAttendBody = await autoBootstrapAttend.json() as { bootstrap?: { handshakePerformed?: boolean; reason?: string } };
        assert.equal(autoBootstrapAttendBody.bootstrap?.handshakePerformed, true, 'Expected attend() to auto-bootstrap a missing brief.');

        const autoBootstrapQuery = await fetch(`${baseUrl}/kb/query/project/${bootstrapEntityId}/status?agentId=${encodeURIComponent(bootstrapAgentId)}`);
        assert.equal(autoBootstrapQuery.status, 200, `Expected /kb/query after auto-bootstrap attend to succeed, got ${autoBootstrapQuery.status}.`);
        const autoBootstrapQueryBody = await autoBootstrapQuery.json() as { found?: boolean; value?: { phase?: string } };
        assert.equal(autoBootstrapQueryBody.found, true, 'Expected auto-bootstrap query to return the fact.');
        assert.equal(autoBootstrapQueryBody.value?.phase, 'auto_bootstrap', 'Expected auto-bootstrap query to return the written value.');

        const apiFallbackEntity = `project/${uniqueId('protocol_route_api_fallback_project')}`;
        const [, apiFallbackEntityId] = apiFallbackEntity.split('/');

        await iranti.write({
            entity: apiFallbackEntity,
            key: 'status',
            value: { phase: 'api_fallback' },
            summary: 'Protocol enforcement API fallback project status is api_fallback.',
            confidence: 91,
            source: 'protocol_route_test',
            agent: 'protocol_route_api_fallback_seed',
        });

        const apiFallbackHandshake = await fetch(`${baseUrl}/memory/handshake`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                task: 'Validate api-key fallback identity for protocol-gated routes.',
                recentMessages: ['Starting API fallback principal coverage.'],
            }),
        });
        assert.equal(apiFallbackHandshake.status, 200, `Expected /memory/handshake without agentId to succeed via api key fallback, got ${apiFallbackHandshake.status}.`);

        const apiFallbackAttend = await fetch(`${baseUrl}/memory/attend`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                latestMessage: 'What is the API fallback project status?',
                currentContext: 'We are validating omitted agentId still yields a stable API key principal.',
                entityHints: [apiFallbackEntity],
                phase: 'pre-response',
            }),
        });
        assert.equal(apiFallbackAttend.status, 200, `Expected /memory/attend without agentId to succeed via api key fallback, got ${apiFallbackAttend.status}.`);

        const apiFallbackQuery = await fetch(`${baseUrl}/kb/query/project/${apiFallbackEntityId}/status`);
        assert.equal(apiFallbackQuery.status, 200, `Expected /kb/query without agentId to succeed via api key fallback, got ${apiFallbackQuery.status}.`);
        const apiFallbackQueryBody = await apiFallbackQuery.json() as { found?: boolean; value?: { phase?: string } };
        assert.equal(apiFallbackQueryBody.found, true, 'Expected api fallback query to return the fact.');
        assert.equal(apiFallbackQueryBody.value?.phase, 'api_fallback', 'Expected api fallback query to return the written value.');

        const ignoredMemoryEntity = `project/${uniqueId('protocol_route_memory_enforced_project')}`;
        const [, ignoredMemoryEntityId] = ignoredMemoryEntity.split('/');
        const ignoredMemoryAgentId = uniqueId('protocol_route_memory_enforced_agent');

        await iranti.write({
            entity: ignoredMemoryEntity,
            key: 'next_step',
            value: { instruction: 'rerun the strict enforcement validation for injected memory compliance.' },
            summary: 'Next step is rerun the strict enforcement validation for injected memory compliance.',
            confidence: 94,
            source: 'protocol_route_test',
            agent: ignoredMemoryAgentId,
        });

        const ignoredMemoryHandshake = await fetch(`${baseUrl}/memory/handshake`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                agentId: ignoredMemoryAgentId,
                task: 'Validate strict enforcement when injected memory is ignored repeatedly.',
                recentMessages: ['Start ignored injected memory enforcement coverage.'],
            }),
        });
        assert.equal(ignoredMemoryHandshake.status, 200, `Expected handshake for ignored-memory scenario to succeed, got ${ignoredMemoryHandshake.status}.`);

        for (let turn = 0; turn < 2; turn++) {
            const ignoredPreAttend = await fetch(`${baseUrl}/memory/attend`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    agentId: ignoredMemoryAgentId,
                    latestMessage: 'What should I do next on this runtime validation task?',
                    currentContext: 'We surfaced memory but will ignore it instead of answering from it.',
                    entityHints: [ignoredMemoryEntity],
                    phase: 'pre-response',
                }),
            });
            assert.equal(ignoredPreAttend.status, 200, `Expected ignored-memory pre-response attend ${turn + 1} to succeed, got ${ignoredPreAttend.status}.`);

            const ignoredPostAttend = await fetch(`${baseUrl}/memory/attend`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    agentId: ignoredMemoryAgentId,
                    latestMessage: 'I will investigate manually and respond later.',
                    currentContext: 'Closing a turn where injected memory was surfaced but not used.',
                    entityHints: [ignoredMemoryEntity],
                    phase: 'post-response',
                }),
            });
            assert.equal(ignoredPostAttend.status, 200, `Expected ignored-memory post-response attend ${turn + 1} to succeed, got ${ignoredPostAttend.status}.`);
            const ignoredPostAttendBody = await ignoredPostAttend.json() as { compliance?: { status?: string; issues?: Array<{ code?: string; severity?: string }> } };
            if (turn === 0) {
                assert.equal(ignoredPostAttendBody.compliance?.status, 'degraded', 'Expected first ignored injection to degrade compliance.');
            } else {
                assert.equal(ignoredPostAttendBody.compliance?.status, 'non_compliant', 'Expected repeated ignored injections to become non-compliant.');
                assert.equal(
                    ignoredPostAttendBody.compliance?.issues?.some((issue) => issue.code === 'ignored_injected_memory' && issue.severity === 'error'),
                    true,
                    'Expected repeated ignored injections to produce an error-level ignored_injected_memory issue.',
                );
            }
        }

        const ignoredMemoryNewTurn = await fetch(`${baseUrl}/memory/attend`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                agentId: ignoredMemoryAgentId,
                latestMessage: 'Start another turn after repeatedly ignoring injected memory.',
                currentContext: 'We are beginning another turn after repeated ignored injections.',
                entityHints: [ignoredMemoryEntity],
                phase: 'pre-response',
            }),
        });
        assert.equal(ignoredMemoryNewTurn.status, 200, `Expected attend to start a new turn after ignored injections, got ${ignoredMemoryNewTurn.status}.`);

        const blockedIgnoredMemoryQuery = await fetch(`${baseUrl}/kb/query/project/${ignoredMemoryEntityId}/next_step?agentId=${encodeURIComponent(ignoredMemoryAgentId)}`);
        assert.equal(blockedIgnoredMemoryQuery.status, 428, `Expected /kb/query after repeated ignored injections to return 428, got ${blockedIgnoredMemoryQuery.status}.`);
        const blockedIgnoredMemoryQueryBody = await blockedIgnoredMemoryQuery.json() as { code?: string };
        assert.equal(
            blockedIgnoredMemoryQueryBody.code,
            'memory_use_required',
            `Expected memory_use_required after repeated ignored injections, got ${JSON.stringify(blockedIgnoredMemoryQueryBody)}.`,
        );

        const ignoredMemoryCheckpoint = await fetch(`${baseUrl}/memory/checkpoint`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                agentId: ignoredMemoryAgentId,
                task: 'Explain why injected memory was insufficient before rediscovery.',
                recentMessages: ['Injected memory was insufficient because the response needed a fresh external validation step.'],
                checkpoint: {
                    currentStep: 'documented why injected memory was insufficient',
                    nextStep: 'perform a fresh validation after acknowledging the limitation',
                    openRisks: ['Avoid redoing rediscovery without first recording why memory was insufficient.'],
                    entityTargets: [ignoredMemoryEntity],
                },
            }),
        });
        assert.equal(ignoredMemoryCheckpoint.status, 200, `Expected checkpoint to clear ignored-memory enforcement, got ${ignoredMemoryCheckpoint.status}.`);

        const ignoredMemoryClearedAttend = await fetch(`${baseUrl}/memory/attend`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                agentId: ignoredMemoryAgentId,
                latestMessage: 'Start a compliant turn after acknowledging the memory gap.',
                currentContext: 'We are resuming after checkpointing why the injected memory was insufficient.',
                entityHints: [ignoredMemoryEntity],
                phase: 'pre-response',
            }),
        });
        assert.equal(ignoredMemoryClearedAttend.status, 200, `Expected pre-response attend after checkpoint to succeed, got ${ignoredMemoryClearedAttend.status}.`);

        const ignoredMemoryRecoveredQuery = await fetch(`${baseUrl}/kb/query/project/${ignoredMemoryEntityId}/next_step?agentId=${encodeURIComponent(ignoredMemoryAgentId)}`);
        assert.equal(ignoredMemoryRecoveredQuery.status, 200, `Expected /kb/query after checkpoint acknowledgement to succeed, got ${ignoredMemoryRecoveredQuery.status}.`);
        const ignoredMemoryRecoveredQueryBody = await ignoredMemoryRecoveredQuery.json() as { found?: boolean; value?: { instruction?: string } };
        assert.equal(ignoredMemoryRecoveredQueryBody.found, true, 'Expected recovery query after checkpoint acknowledgement to return the fact.');
        // next_step is now a clean replace (no accumulation of prior steps).
        assert.equal(
            ignoredMemoryRecoveredQueryBody.value?.instruction,
            'perform a fresh validation after acknowledging the limitation',
            'Expected recovery query after checkpoint acknowledgement to return the latest next step (clean replace).',
        );

        console.log('protocol enforcement route tests passed');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await disconnectDb().catch(() => undefined);
        if (priorProjectMemoryEntity === undefined) {
            delete process.env.IRANTI_MEMORY_ENTITY;
        } else {
            process.env.IRANTI_MEMORY_ENTITY = priorProjectMemoryEntity;
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
