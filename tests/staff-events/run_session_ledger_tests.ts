import 'dotenv/config';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { memoryRoutes } from '../../src/api/routes/memory';
import { querySessionLedger, summarizeSessionLedgerLearnings } from '../../src/lib/sessionLedger';

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
        ]),
    });

    try {
        const ledger = await querySessionLedger({ agentId, sessionId, limit: 10 });
        assert.equal(ledger.length, 9, 'Expected multiple ledger events for the agent.');
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
            maxLearnings: 3,
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
            learnings.every((entry) => entry.host === 'plain_cli'),
            'Expected learning summaries to preserve host metadata.'
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

    console.log('session ledger tests passed');
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
