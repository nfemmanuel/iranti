import 'dotenv/config';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { bootstrapHarness } from '../../scripts/harness';
import { Iranti } from '../../src/sdk';
import { memoryRoutes } from '../../src/api/routes/memory';
import { disconnectDb } from '../../src/library/client';

function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof createServer>; baseUrl: string }> {
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to resolve observe validation test server address.');
    }
    return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
    };
}

async function main(): Promise<void> {
    process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'mock';
    bootstrapHarness({
        requireDb: true,
        forceLocalEscalationDir: true,
        dbApplicationName: 'iranti:test:observe_validation',
    });

    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        throw new Error('DATABASE_URL is required for observe validation test.');
    }

    const iranti = new Iranti({
        connectionString,
        llmProvider: process.env.LLM_PROVIDER,
        dbApplicationName: 'iranti:test:observe_validation',
        protocolEnforcement: 'off',
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        (req as express.Request & {
            irantiAuth?: { mode: string; keyId: string; owner: string; scopes: string[] };
        }).irantiAuth = {
            mode: 'registry',
            scopes: ['kb:read', 'kb:write', 'memory:read', 'memory:write'],
            keyId: 'observe_validation_key',
            owner: 'observe validation test',
        };
        next();
    });
    app.use('/memory', memoryRoutes(iranti));

    const { server, baseUrl } = await listen(app);
    const entity = `project/${uniqueId('observe_validation_project')}`;
    const agentId = uniqueId('observe_validation_agent');

    try {
        await iranti.write({
            entity,
            key: 'next_step',
            value: { text: 'Validate entityHints-only observe requests.' },
            summary: 'Observe validation route regression project next step.',
            confidence: 90,
            source: 'observe_validation_test',
            agent: agentId,
        });

        const hintsOnly = await fetch(`${baseUrl}/memory/observe`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                agentId,
                entityHints: [entity],
            }),
        });
        assert.equal(hintsOnly.status, 200, `Expected entityHints-only /memory/observe to succeed, got ${hintsOnly.status}.`);
        const hintsOnlyBody = await hintsOnly.json() as { facts?: Array<{ entityKey?: string }> };
        assert.ok(Array.isArray(hintsOnlyBody.facts), 'Expected entityHints-only observe response to include facts.');
        assert.ok(
            hintsOnlyBody.facts?.some((fact) => fact.entityKey === `${entity}/next_step`),
            'Expected entityHints-only observe to surface the written project fact.'
        );

        const empty = await fetch(`${baseUrl}/memory/observe`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                agentId,
            }),
        });
        assert.equal(empty.status, 400, `Expected empty /memory/observe to be rejected, got ${empty.status}.`);
        const emptyBody = await empty.json() as { code?: string; field?: string; error?: string };
        assert.equal(emptyBody.code, 'VALIDATION_ERROR', `Expected validation error for empty observe request, got ${JSON.stringify(emptyBody)}.`);
        assert.equal(emptyBody.field, 'currentContext', `Expected currentContext to be reported for empty observe request, got ${JSON.stringify(emptyBody)}.`);
        assert.ok(
            typeof emptyBody.error === 'string' && emptyBody.error.includes('currentContext or entityHints is required for observe.'),
            `Expected empty observe error to mention currentContext or entityHints, got ${JSON.stringify(emptyBody)}.`
        );

        console.log('observe validation tests passed');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await disconnectDb().catch(() => undefined);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
