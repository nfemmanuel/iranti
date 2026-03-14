import 'dotenv/config';
import express from 'express';
import type { Server } from 'http';
import { bootstrapHarness } from '../../scripts/harness';
import { Iranti } from '../../src/sdk';
import { authenticate } from '../../src/api/middleware/auth';
import { requireAnyScope, requireScopeFamilyByMethod } from '../../src/api/middleware/authorization';
import { knowledgeRoutes } from '../../src/api/routes/knowledge';
import { batchRouter } from '../../src/api/routes/batch';
import { createOrRotateApiKey } from '../../src/security/apiKeys';

type CaseResult = {
    name: string;
    passed: boolean;
    details?: string;
};

let counter = 0;

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function uniqueEntity(base: string): string {
    counter += 1;
    return `project/${base}_${Date.now()}_${counter}`;
}

function uniqueKeyId(base: string): string {
    counter += 1;
    return `${base}_${Date.now()}_${counter}`;
}

async function prepareSuite(): Promise<{
    baseUrl: string;
    server: Server;
    iranti: Iranti;
    adminToken: string;
}> {
    process.env.LLM_PROVIDER = 'mock';
    bootstrapHarness({ requireDb: true, forceLocalEscalationDir: true });

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL is required to run access-control tests.');
    }

    const iranti = new Iranti({
        connectionString,
        llmProvider: 'mock',
    });

    const app = express();
    app.use(express.json());
    app.use('/kb/batchQuery', authenticate, requireAnyScope(['kb:read']), batchRouter);
    app.use('/kb', authenticate, requireScopeFamilyByMethod('kb:read', 'kb:write'), knowledgeRoutes(iranti));

    const server = await new Promise<Server>((resolve) => {
        const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to determine access-control test server address.');
    }

    const admin = await createOrRotateApiKey({
        keyId: uniqueKeyId('access_admin'),
        owner: 'access test admin',
        scopes: ['kb:read', 'kb:write'],
        description: 'Admin key for access-control test seeding',
    });

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        server,
        iranti,
        adminToken: admin.token,
    };
}

async function requestJson(baseUrl: string, token: string, path: string, init: RequestInit = {}): Promise<{
    status: number;
    body: any;
}> {
    const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            'X-Iranti-Key': token,
            ...(init.headers ?? {}),
        },
    });

    const text = await response.text();
    return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
    };
}

async function createScopedKey(scopes: string[]): Promise<string> {
    const created = await createOrRotateApiKey({
        keyId: uniqueKeyId('access_key'),
        owner: 'access control test client',
        scopes,
        description: 'Access control test key',
    });
    return created.token;
}

async function runCase(name: string, run: () => Promise<void>): Promise<CaseResult> {
    try {
        await run();
        return { name, passed: true };
    } catch (error) {
        return {
            name,
            passed: false,
            details: error instanceof Error ? error.message : String(error),
        };
    }
}

async function main() {
    const { baseUrl, server, adminToken } = await prepareSuite();
    const results: CaseResult[] = [];

    try {
        results.push(await runCase('Global scope still works', async () => {
            const token = await createScopedKey(['kb:read', 'kb:write']);
            const entity = uniqueEntity('access_global');
            const response = await requestJson(baseUrl, token, '/kb/write', {
                method: 'POST',
                body: JSON.stringify({
                    entity,
                    key: 'status',
                    value: { state: 'green' },
                    summary: 'Status is green.',
                    confidence: 85,
                    source: 'access_suite',
                    agent: 'access_global_agent',
                }),
            });

            expect(response.status === 200, `Expected 200 for global key write, got ${response.status}.`);
            expect(response.body?.action === 'created', `Expected created action, got ${JSON.stringify(response.body)}.`);
        }));

        results.push(await runCase('Wildcard namespace allow', async () => {
            const token = await createScopedKey(['kb:write:project/*']);
            const entity = uniqueEntity('access_wildcard');
            const response = await requestJson(baseUrl, token, '/kb/write', {
                method: 'POST',
                body: JSON.stringify({
                    entity,
                    key: 'budget',
                    value: { amount: 72000 },
                    summary: 'Budget is 72K.',
                    confidence: 83,
                    source: 'access_suite',
                    agent: 'access_wildcard_agent',
                }),
            });

            expect(response.status === 200, `Expected 200 for wildcard namespace write, got ${response.status}.`);
            expect(response.body?.action === 'created', `Expected created action, got ${JSON.stringify(response.body)}.`);
        }));

        results.push(await runCase('Exact namespace allow', async () => {
            const entity = 'project/access_exact_target';
            await requestJson(baseUrl, adminToken, '/kb/write', {
                method: 'POST',
                body: JSON.stringify({
                    entity,
                    key: 'owner',
                    value: { name: 'Rian' },
                    summary: 'Owner is Rian.',
                    confidence: 88,
                    source: 'access_suite',
                    agent: 'access_admin_agent',
                }),
            });

            const token = await createScopedKey(['kb:read:project/access_exact_target']);
            const response = await requestJson(baseUrl, token, '/kb/query/project/access_exact_target/owner');
            expect(response.status === 200, `Expected 200 for exact namespace query, got ${response.status}.`);
            expect(response.body?.found === true, `Expected found=true, got ${JSON.stringify(response.body)}.`);
        }));

        results.push(await runCase('Exact deny overrides allow', async () => {
            const token = await createScopedKey(['kb:write:project/*', 'kb:deny:project/rival']);
            const response = await requestJson(baseUrl, token, '/kb/write', {
                method: 'POST',
                body: JSON.stringify({
                    entity: 'project/rival',
                    key: 'status',
                    value: { state: 'blocked' },
                    summary: 'Status is blocked.',
                    confidence: 80,
                    source: 'access_suite',
                    agent: 'access_deny_agent',
                }),
            });

            expect(response.status === 403, `Expected 403 for exact deny, got ${response.status}.`);
            expect(
                response.body?.reason === 'Explicit deny rule matches entity project/rival',
                `Expected explicit deny reason, got ${JSON.stringify(response.body)}.`
            );
        }));

        results.push(await runCase('Wildcard deny overrides allow', async () => {
            const token = await createScopedKey(['kb:write:project/*', 'kb:deny:project/*']);
            const entity = uniqueEntity('access_wild_deny');
            const response = await requestJson(baseUrl, token, '/kb/write', {
                method: 'POST',
                body: JSON.stringify({
                    entity,
                    key: 'status',
                    value: { state: 'blocked' },
                    summary: 'Status is blocked.',
                    confidence: 79,
                    source: 'access_suite',
                    agent: 'access_wild_deny_agent',
                }),
            });

            expect(response.status === 403, `Expected 403 for wildcard deny, got ${response.status}.`);
            expect(
                response.body?.reason === `Explicit deny rule matches entity ${entity}`,
                `Expected wildcard deny reason, got ${JSON.stringify(response.body)}.`
            );
        }));

        results.push(await runCase('Missing namespace access returns 403 with reason', async () => {
            const entity = 'project/access_denied_target';
            await requestJson(baseUrl, adminToken, '/kb/write', {
                method: 'POST',
                body: JSON.stringify({
                    entity,
                    key: 'status',
                    value: { state: 'ready' },
                    summary: 'Status is ready.',
                    confidence: 84,
                    source: 'access_suite',
                    agent: 'access_admin_agent',
                }),
            });

            const token = await createScopedKey(['kb:read:project/access_allowed_target']);
            const response = await requestJson(baseUrl, token, '/kb/query/project/access_denied_target/status');
            expect(response.status === 403, `Expected 403 for missing namespace access, got ${response.status}.`);
            expect(
                response.body?.reason === 'Key does not have access to entity namespace project/access_denied_target',
                `Expected namespace-mismatch reason, got ${JSON.stringify(response.body)}.`
            );
        }));

        results.push(await runCase('Malformed scope rejected at key creation', async () => {
            let failed = false;
            try {
                await createOrRotateApiKey({
                    keyId: uniqueKeyId('bad_scope'),
                    owner: 'bad scope test',
                    scopes: ['kb:read:*/acme'],
                });
            } catch (error) {
                failed = /wildcard entitytype/i.test(error instanceof Error ? error.message : String(error));
            }

            expect(failed, 'Expected malformed namespaced scope to be rejected at key creation time.');
        }));

        results.push(await runCase('Relate requires access to both entities', async () => {
            const token = await createScopedKey(['kb:write:project/access_relate_from']);
            const response = await requestJson(baseUrl, token, '/kb/relate', {
                method: 'POST',
                body: JSON.stringify({
                    fromEntity: 'project/access_relate_from',
                    relationshipType: 'PART_OF',
                    toEntity: 'project/access_relate_to',
                    createdBy: 'access_relate_agent',
                    properties: {},
                }),
            });

            expect(response.status === 403, `Expected 403 when relate access covers only one side, got ${response.status}.`);
            expect(
                response.body?.reason === 'Key does not have access to entity namespace project/access_relate_to',
                `Expected missing-target namespace reason, got ${JSON.stringify(response.body)}.`
            );
        }));
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }

    printSummary(results);
    process.exit(results.every((result) => result.passed) ? 0 : 1);
}

function printSummary(results: CaseResult[]): void {
    console.log('Access-control test suite');
    console.log('-------------------------');
    for (const result of results) {
        if (result.passed) {
            console.log(`PASS  ${result.name}`);
        } else {
            console.log(`FAIL  ${result.name} - ${result.details}`);
        }
    }
    console.log('-------------------------');
    console.log(`Total: ${results.filter((result) => result.passed).length}/${results.length}`);
}

main().catch((error) => {
    console.error('Access-control tests failed:', error);
    process.exit(1);
});
