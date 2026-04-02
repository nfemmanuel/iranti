import 'dotenv/config';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { memoryRoutes } from '../../src/api/routes/memory';
import { buildSessionLedgerLearningProfile, querySessionLedger, summarizeSessionLedgerLearnings } from '../../src/lib/sessionLedger';
import { resetStaffEventsTableBootstrap } from '../../src/lib/staffEventsTable';

const clientModule = require('../../src/library/client');

function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof createServer>; baseUrl: string }> {
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to resolve test server address.');
    }
    return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
    };
}

async function main(): Promise<void> {
    const agentId = uniqueId('ledger_agent');
    const sessionId = uniqueId('ledger_session');

    const originalGetDb = clientModule.getDb;
    clientModule.getDb = () => ({
        $queryRaw: async () => ([
            {
                event_id: 'evt-query',
                timestamp: new Date('2026-03-28T10:00:03.500Z'),
                staff_component: 'Attendant',
                action_type: 'query_executed',
                agent_id: agentId,
                source: 'cli',
                entity_type: 'user',
                entity_id: 'main',
                key: 'height',
                reason: null,
                level: 'audit',
                metadata: { sessionId, host: 'plain_cli' },
            },
            {
                event_id: 'evt-attend',
                timestamp: new Date('2026-03-28T10:00:03.000Z'),
                staff_component: 'Attendant',
                action_type: 'attend_completed',
                agent_id: agentId,
                source: 'cli',
                entity_type: 'user',
                entity_id: 'main',
                key: 'height',
                reason: 'personal_height_recall_prompt',
                level: 'audit',
                metadata: { sessionId, shouldInject: true, host: 'plain_cli' },
            },
            {
                event_id: 'evt-recall',
                timestamp: new Date('2026-03-28T10:00:02.900Z'),
                staff_component: 'Attendant',
                action_type: 'mandatory_recall_forced',
                agent_id: agentId,
                source: 'cli',
                entity_type: 'user',
                entity_id: 'main',
                key: 'height',
                reason: 'personal_height_recall_prompt',
                level: 'audit',
                metadata: { sessionId, host: 'plain_cli' },
            },
            {
                event_id: 'evt-injected',
                timestamp: new Date('2026-03-28T10:00:02.500Z'),
                staff_component: 'Attendant',
                action_type: 'memory_injected',
                agent_id: agentId,
                source: 'cli',
                entity_type: 'user',
                entity_id: 'main',
                key: 'height',
                reason: 'personal_height_recall_prompt',
                level: 'audit',
                metadata: { sessionId, shouldInject: true, factCount: 1, injectedKeys: ['user/main/height'], host: 'plain_cli' },
            },
            {
                event_id: 'evt-checkpoint',
                timestamp: new Date('2026-03-28T10:00:02.000Z'),
                staff_component: 'Attendant',
                action_type: 'checkpoint_shared_breadcrumb_failed',
                agent_id: agentId,
                source: 'cli',
                entity_type: 'project',
                entity_id: 'ledger_project',
                key: 'checkpoint_summary',
                reason: 'shared_checkpoint_breadcrumb_failed',
                level: 'debug',
                metadata: { sessionId, error: 'synthetic checkpoint failure for ledger testing', host: 'plain_cli' },
            },
            {
                event_id: 'evt-checkpoint-written',
                timestamp: new Date('2026-03-28T10:00:01.800Z'),
                staff_component: 'Attendant',
                action_type: 'checkpoint_written',
                agent_id: agentId,
                source: 'cli',
                entity_type: 'project',
                entity_id: 'ledger_project',
                key: 'checkpoint_summary',
                reason: 'checkpoint_saved',
                level: 'audit',
                metadata: { sessionId, host: 'plain_cli' },
            },
            {
                event_id: 'evt-summary',
                timestamp: new Date('2026-03-28T10:00:01.700Z'),
                staff_component: 'Librarian',
                action_type: 'summary_written',
                agent_id: agentId,
                source: 'cli',
                entity_type: 'project',
                entity_id: 'ledger_project',
                key: 'checkpoint_summary',
                reason: 'assistant_summary_persisted',
                level: 'audit',
                metadata: { sessionId, host: 'plain_cli' },
            },
            {
                event_id: 'evt-fallback',
                timestamp: new Date('2026-03-28T10:00:01.600Z'),
                staff_component: 'Attendant',
                action_type: 'provider_fallback_used',
                agent_id: agentId,
                source: 'cli',
                entity_type: null,
                entity_id: null,
                key: null,
                reason: 'gemini -> mock',
                level: 'audit',
                metadata: { sessionId, host: 'plain_cli', preferredProvider: 'gemini', providerUsed: 'mock' },
            },
            {
                event_id: 'evt-handshake',
                timestamp: new Date('2026-03-28T10:00:01.000Z'),
                staff_component: 'Attendant',
                action_type: 'handshake_completed',
                agent_id: agentId,
                source: 'cli',
                entity_type: 'agent',
                entity_id: agentId,
                key: 'attendant_state',
                reason: 'session_started',
                level: 'audit',
                metadata: { sessionId, task: 'Validate session ledger retrieval.', host: 'plain_cli' },
            },
            {
                event_id: 'evt-under-handshake',
                timestamp: new Date('2026-03-28T10:10:05.000Z'),
                staff_component: 'Attendant',
                action_type: 'handshake_completed',
                agent_id: agentId,
                source: 'cli',
                entity_type: 'agent',
                entity_id: agentId,
                key: 'attendant_state',
                reason: 'session_started',
                level: 'audit',
                metadata: { sessionId: 'under_checkpointed_session', task: 'Resume setup defect debugging.', host: 'codex_cli' },
            },
            {
                event_id: 'evt-under-query',
                timestamp: new Date('2026-03-28T10:10:04.000Z'),
                staff_component: 'Attendant',
                action_type: 'query_executed',
                agent_id: agentId,
                source: 'cli',
                entity_type: 'project',
                entity_id: 'iranti',
                key: 'status',
                reason: null,
                level: 'audit',
                metadata: { sessionId: 'under_checkpointed_session', host: 'codex_cli', taskSummary: 'Resume setup defect debugging.' },
            },
            {
                event_id: 'evt-under-search',
                timestamp: new Date('2026-03-28T10:10:03.000Z'),
                staff_component: 'Attendant',
                action_type: 'search_executed',
                agent_id: agentId,
                source: 'cli',
                entity_type: null,
                entity_id: null,
                key: null,
                reason: null,
                level: 'audit',
                metadata: { sessionId: 'under_checkpointed_session', host: 'codex_cli', taskSummary: 'Resume setup defect debugging.' },
            },
            {
                event_id: 'evt-under-attend',
                timestamp: new Date('2026-03-28T10:10:02.000Z'),
                staff_component: 'Attendant',
                action_type: 'attend_completed',
                agent_id: agentId,
                source: 'cli',
                entity_type: null,
                entity_id: null,
                key: null,
                reason: 'memory_injected',
                level: 'audit',
                metadata: { sessionId: 'under_checkpointed_session', host: 'codex_cli', shouldInject: true, taskSummary: 'Resume setup defect debugging.' },
            },
            {
                event_id: 'evt-under-memory',
                timestamp: new Date('2026-03-28T10:10:01.000Z'),
                staff_component: 'Attendant',
                action_type: 'memory_injected',
                agent_id: agentId,
                source: 'cli',
                entity_type: 'project',
                entity_id: 'iranti',
                key: 'setup_metadata_defect_status_2026_03_31',
                reason: 'memory_needed_injected',
                level: 'audit',
                metadata: {
                    sessionId: 'under_checkpointed_session',
                    host: 'codex_cli',
                    injectedKeys: ['project/iranti/setup_metadata_defect_status_2026_03_31'],
                    taskSummary: 'Resume setup defect debugging.',
                },
            },
        ]),
    });

    try {
        const ledger = await querySessionLedger({ agentId, sessionId, limit: 10 });
        assert.ok(ledger.length >= 9, 'Expected multiple ledger events for the agent.');
        assert.equal(ledger.every((event) => event.agentId === agentId), true, 'Expected agent-filtered ledger results.');
        assert.ok(
            ledger.some((event) => event.actionType === 'handshake_completed'),
            'Expected handshake_completed to appear in the ledger.'
        );
        assert.ok(
            ledger.some((event) => event.actionType === 'attend_completed'),
            'Expected attend_completed to appear in the ledger.'
        );
        assert.ok(
            ledger.some((event) => event.actionType === 'memory_injected'),
            'Expected memory_injected to appear in the ledger.'
        );

        const ledgerSessionIds = new Set(
            ledger
                .map((event) => typeof event.metadata?.sessionId === 'string' ? event.metadata.sessionId : null)
                .filter((value): value is string => Boolean(value))
        );
        assert.ok(ledgerSessionIds.has(sessionId), 'Expected the ledger to carry the requested sessionId metadata.');
        assert.ok(
            ledger.some((event) => event.metadata?.host === 'plain_cli'),
            'Expected the ledger to carry host metadata for first-party events.'
        );

        const learnings = await summarizeSessionLedgerLearnings({
            agentId,
            sessionId,
            source: 'cli',
            host: 'plain_cli',
            maxLearnings: 5,
        });
        assert.ok(learnings.length >= 1, 'Expected bounded session-ledger learnings.');
        assert.ok(
            learnings.some((entry) => entry.actionType === 'host_lesson'),
            'Expected synthesized host lessons to appear in the learning summary.'
        );
        assert.ok(
            learnings.some((entry) => entry.actionType === 'recall_lesson'),
            'Expected synthesized recall lessons to appear in the learning summary.'
        );
        assert.ok(
            learnings.some((entry) => entry.actionType === 'persistence_lesson'),
            'Expected synthesized persistence lessons to appear in the learning summary.'
        );
        assert.ok(
            learnings.some((entry) => (entry.evidenceActionTypes ?? []).includes('provider_fallback_used')),
            'Expected synthesized host lessons to preserve provider fallback evidence.'
        );
        assert.ok(
            learnings.some((entry) => entry.host === 'plain_cli'),
            'Expected learning summaries to preserve host metadata.'
        );

        const profile = await buildSessionLedgerLearningProfile({
            agentId,
            source: 'cli',
            host: 'plain_cli',
            taskType: 'Validate session ledger retrieval.',
            limit: 20,
        });
        assert.ok(profile, 'Expected an advisory learning profile.');
        assert.ok(
            profile!.preferMemoryForAmbiguousTurns,
            'Expected the advisory profile to prefer memory on ambiguous turns when recent retrieval succeeded.'
        );
        assert.ok(
            profile!.scopesUsed.includes('host'),
            'Expected the advisory profile to include host-scoped learning signals.'
        );
        assert.ok(
            profile!.scopesUsed.includes('task'),
            'Expected the advisory profile to include task-scoped learning signals.'
        );
        assert.ok(
            profile!.priorityKeys.includes('height'),
            'Expected the advisory profile to carry learned recall keys.'
        );
        assert.ok(
            profile!.priorityKeys.includes('checkpoint_summary'),
            'Expected the advisory profile to carry learned persistence keys.'
        );
        assert.ok(
            profile!.needsCheckpointReminder,
            'Expected the advisory profile to flag under-checkpointed sessions.'
        );
        assert.match(
            profile!.checkpointReminder ?? '',
            /under-logged run/i,
            'Expected the advisory profile to surface a stricter checkpoint-discipline reminder.'
        );
        assert.ok(
            profile!.missingWriteCategories.includes('findings'),
            'Expected the advisory profile to require a durable record of what was found.'
        );
        assert.ok(
            profile!.missingWriteCategories.includes('validated_results'),
            'Expected the advisory profile to require a durable record of what worked.'
        );
        assert.ok(
            profile!.missingWriteCategories.includes('risks_and_next_steps'),
            'Expected the advisory profile to require a durable record of what remains risky and what happens next.'
        );

        const app = express();
        app.use('/memory', memoryRoutes({
            listSessionLedger: querySessionLedger,
        } as never));
        const { server, baseUrl } = await listen(app);

        try {
            const res = await fetch(`${baseUrl}/memory/ledger?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}&limit=5`);
            assert.equal(res.status, 200, 'Expected /memory/ledger to succeed.');
            const body = await res.json() as { items: Array<{ agentId: string; actionType: string }>; total: number };
            assert.ok(Array.isArray(body.items), 'Expected ledger items array.');
            assert.ok(body.total >= 1, 'Expected /memory/ledger total to reflect returned items.');
            assert.equal(body.items.every((event) => event.agentId === agentId), true, 'Expected route filtering by agent.');
            assert.ok(
                body.items.some((event) => event.actionType === 'attend_completed'),
                'Expected route output to include attend_completed.'
            );
            assert.ok(
                body.items.some((event) => event.actionType === 'memory_injected'),
                'Expected route output to include memory_injected.'
            );
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    } finally {
        clientModule.getDb = originalGetDb;
    }

    // scopeSupportsAmbiguousMemory and scoreTaskSimilarity unit coverage
    // (tested via buildSessionLedgerLearningProfile which calls both internally)
    const scopeAgentId = uniqueId('scope_mem_agent');
    function makeLedgerRow(
        actionType: string,
        sessionIdVal: string,
        timestamp: string,
        extras: {
            entityType?: string | null;
            entityId?: string | null;
            key?: string | null;
            taskSummary?: string;
            injectedKeys?: string[];
        } = {},
    ) {
        return {
            event_id: `evt-${Math.random().toString(36).slice(2, 10)}`,
            timestamp: new Date(timestamp),
            staff_component: 'Attendant',
            action_type: actionType,
            agent_id: scopeAgentId,
            source: 'cli',
            entity_type: extras.entityType ?? null,
            entity_id: extras.entityId ?? null,
            key: extras.key ?? null,
            reason: null,
            level: 'audit',
            metadata: {
                sessionId: sessionIdVal,
                host: 'plain_cli',
                ...(extras.taskSummary ? { taskSummary: extras.taskSummary } : {}),
                ...(extras.injectedKeys ? { injectedKeys: extras.injectedKeys } : {}),
            },
        };
    }

    // Scenario A: retrieval-only session — no injection, no persistence → should NOT prefer memory
    const originalGetDbA = clientModule.getDb;
    clientModule.getDb = () => ({
        $queryRaw: async () => ([
            makeLedgerRow('attend_completed', 'retrieval_only', '2026-04-01T10:00:01.000Z'),
            makeLedgerRow('query_executed', 'retrieval_only', '2026-04-01T10:00:02.000Z', { entityType: 'project', entityId: 'iranti', key: 'status' }),
            makeLedgerRow('search_executed', 'retrieval_only', '2026-04-01T10:00:03.000Z'),
        ]),
    });
    const retrievalOnlyProfile = await buildSessionLedgerLearningProfile({
        agentId: scopeAgentId,
        host: 'plain_cli',
        taskType: 'query status',
        limit: 20,
    });
    assert.ok(
        retrievalOnlyProfile === null || !retrievalOnlyProfile.preferMemoryForAmbiguousTurns,
        'Expected retrieval-only session (no injection, no persistence) to not set preferMemoryForAmbiguousTurns.'
    );
    clientModule.getDb = originalGetDbA;

    // Scenario B: injection-only (no persistence) → advisory fallback → should prefer memory
    const originalGetDbB = clientModule.getDb;
    clientModule.getDb = () => ({
        $queryRaw: async () => ([
            makeLedgerRow('memory_injected', 'injection_only', '2026-04-01T10:01:01.000Z', {
                entityType: 'project', entityId: 'iranti', key: 'status',
                injectedKeys: ['project/iranti/status'],
            }),
        ]),
    });
    const injectionOnlyProfile = await buildSessionLedgerLearningProfile({
        agentId: scopeAgentId,
        host: 'plain_cli',
        taskType: 'check status',
        limit: 20,
    });
    assert.ok(injectionOnlyProfile, 'Expected injection-only profile to be non-null (advisory signal exists).');
    assert.ok(
        injectionOnlyProfile!.preferMemoryForAmbiguousTurns,
        'Expected injection-only session to set preferMemoryForAmbiguousTurns via advisory fallback.'
    );
    clientModule.getDb = originalGetDbB;

    // Scenario C: injection followed by persistence in same session → strongest signal
    const originalGetDbC = clientModule.getDb;
    clientModule.getDb = () => ({
        $queryRaw: async () => ([
            makeLedgerRow('memory_injected', 'inject_persist', '2026-04-01T10:02:01.000Z', {
                entityType: 'project', entityId: 'iranti', key: 'status',
                injectedKeys: ['project/iranti/status'],
            }),
            makeLedgerRow('checkpoint_written', 'inject_persist', '2026-04-01T10:02:02.000Z', {
                entityType: 'project', entityId: 'iranti', key: 'checkpoint_summary',
            }),
        ]),
    });
    const injectPersistProfile = await buildSessionLedgerLearningProfile({
        agentId: scopeAgentId,
        host: 'plain_cli',
        taskType: 'check status',
        limit: 20,
    });
    assert.ok(injectPersistProfile, 'Expected inject+persist profile to be non-null.');
    assert.ok(
        injectPersistProfile!.preferMemoryForAmbiguousTurns,
        'Expected injection then persistence in the same session to set preferMemoryForAmbiguousTurns via strongest signal.'
    );
    clientModule.getDb = originalGetDbC;

    // Scenario D: synonym-expanded task matching — "fixing docker errors" should match "repairing container failures"
    const originalGetDbD = clientModule.getDb;
    clientModule.getDb = () => ({
        $queryRaw: async () => ([
            makeLedgerRow('handshake_completed', 'synonym_session', '2026-04-01T10:03:01.000Z', {
                entityType: 'agent', entityId: scopeAgentId, key: 'attendant_state',
                taskSummary: 'fixing docker errors',
            }),
            makeLedgerRow('memory_injected', 'synonym_session', '2026-04-01T10:03:02.000Z', {
                entityType: 'project', entityId: 'iranti', key: 'docker_status',
                injectedKeys: ['project/iranti/docker_status'],
                taskSummary: 'fixing docker errors',
            }),
        ]),
    });
    const synonymProfile = await buildSessionLedgerLearningProfile({
        agentId: scopeAgentId,
        host: 'plain_cli',
        taskType: 'repairing container failures',
        limit: 20,
    });
    assert.ok(synonymProfile, 'Expected synonym-matched profile to be non-null.');
    assert.ok(
        synonymProfile!.scopesUsed.includes('task'),
        'Expected task scope to be used when task descriptions match via synonym expansion (fixing/repairing, docker/container, errors/failures).'
    );
    assert.strictEqual(
        synonymProfile!.matchedTaskType,
        'fixing docker errors',
        'Expected matchedTaskType to reflect the stored task summary that matched via synonym expansion.'
    );
    clientModule.getDb = originalGetDbD;

    const originalHealingGetDb = clientModule.getDb;
    let healed = false;
    let bootstrapCalls = 0;
    clientModule.getDb = () => ({
        $queryRaw: async () => {
            if (!healed) {
                throw new Error('relation "staff_events" does not exist');
            }
            return [
                {
                    event_id: 'evt-healed',
                    timestamp: new Date('2026-03-28T11:00:00.000Z'),
                    staff_component: 'Attendant',
                    action_type: 'checkpoint_written',
                    agent_id: agentId,
                    source: 'cli',
                    entity_type: 'project',
                    entity_id: 'iranti',
                    key: 'checkpoint_summary',
                    reason: 'checkpoint_saved',
                    level: 'audit',
                    metadata: { sessionId: 'healed_session', host: 'plain_cli' },
                },
            ];
        },
        $executeRawUnsafe: async () => {
            bootstrapCalls += 1;
            healed = true;
            return 1;
        },
    });
    resetStaffEventsTableBootstrap();

    try {
        const healedLedger = await querySessionLedger({ agentId, sessionId: 'healed_session', limit: 5 });
        assert.equal(healedLedger.length, 1, 'Expected missing staff_events table to self-heal and return the retried row.');
        assert.ok(bootstrapCalls > 0, 'Expected ledger query to bootstrap staff_events before retrying.');
    } finally {
        resetStaffEventsTableBootstrap();
        clientModule.getDb = originalHealingGetDb;
    }

    console.log('session ledger tests passed');
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
