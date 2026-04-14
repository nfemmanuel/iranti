import 'dotenv/config';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { bootstrapHarness } from '../../scripts/harness';
import { Iranti } from '../../src/sdk';
import { knowledgeRoutes } from '../../src/api/routes/knowledge';
import { disconnectDb } from '../../src/library/client';
import { findEntry } from '../../src/library/queries';

function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof createServer>; baseUrl: string }> {
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Unable to resolve write-properties test server address.');
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
        dbApplicationName: 'iranti:test:write_properties_route',
    });

    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        throw new Error('DATABASE_URL is required for write-properties route test.');
    }

    const dbApplicationName = 'iranti:test:write_properties_route';
    const iranti = new Iranti({
        connectionString,
        llmProvider: process.env.LLM_PROVIDER,
        dbApplicationName,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        (req as express.Request & { irantiAuth?: { scopes: string[]; userId: number; tokenScope: string } }).irantiAuth = {
            scopes: ['kb:read', 'kb:write'],
            userId: 1,
            tokenScope: 'dev_cli',
        };
        next();
    });
    app.use('/kb', knowledgeRoutes(iranti));

    const { server, baseUrl } = await listen(app);
    const entity = `project/${uniqueId('write_properties_project')}`;
    const agentId = uniqueId('write_properties_agent');

    try {
        const response = await fetch(`${baseUrl}/kb/write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                entity,
                key: 'known_issue',
                value: {
                    title: 'Session ledger availability drift',
                    status: 'open',
                },
                summary: 'Known issue is still open for session ledger availability drift.',
                confidence: 90,
                source: 'write_properties_route_test',
                agent: agentId,
                properties: {
                    issueStatus: 'open',
                    issueType: 'known_issue',
                    severity: 'medium',
                },
            }),
        });

        assert.equal(response.status, 200, `Expected /kb/write to accept properties, got ${response.status}.`);
        const payload = await response.json() as { action: string };
        assert.ok(['created', 'updated'].includes(payload.action), `Expected successful write action, got ${payload.action}.`);

        const stored = await findEntry({
            entityType: 'project',
            entityId: entity.split('/')[1]!,
            key: 'known_issue',
        });
        assert.ok(stored, 'Expected the route write to persist an entry.');
        const properties = stored.properties as Record<string, unknown>;
        assert.equal(properties.issueStatus, 'open', 'Expected issueStatus property to persist through the route.');
        assert.equal(properties.issueType, 'known_issue', 'Expected issueType property to persist through the route.');
        assert.equal(properties.severity, 'medium', 'Expected severity property to persist through the route.');

        console.log('write properties route tests passed');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await disconnectDb().catch(() => undefined);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
