import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Prisma } from '../../src/generated/prisma/client';
import * as client from '../../src/library/client';
import { DbStaffEventEmitter } from '../../src/lib/dbStaffEventEmitter';
import { getStaffEventEmitter, resetStaffEventEmitter } from '../../src/lib/staffEventRegistry';
import { Iranti } from '../../src/sdk';

async function flushAsync(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function testEmitterWritesStaffEvents(): Promise<void> {
    const calls: unknown[][] = [];
    const originalGetDb = client.getDb;

    const fakeDb = {
        $executeRaw: async (...args: unknown[]) => {
            calls.push(args);
            return 1;
        },
    };

    (client as typeof client & { getDb: typeof client.getDb }).getDb = (() => fakeDb as any) as typeof client.getDb;

    try {
        const emitter = new DbStaffEventEmitter();
        emitter.emit({
            staffComponent: 'Librarian',
            actionType: 'write_created',
            agentId: 'tester',
            source: 'api',
            entityType: 'user',
            entityId: 'main',
            key: 'favorite_snack',
            reason: 'unit test',
            level: 'audit',
            metadata: { ok: true },
        });

        await flushAsync();

        assert.equal(calls.length, 1, 'expected one INSERT into staff_events');
        const [query] = calls[0]!;
        assert.ok(query instanceof Prisma.Sql, 'expected Prisma.sql query');
        const sql = (query as InstanceType<typeof Prisma.Sql>).sql;
        assert.match(sql, /INSERT INTO staff_events/i);
    } finally {
        (client as typeof client & { getDb: typeof client.getDb }).getDb = originalGetDb;
    }
}

async function testMissingTableWarnsOnce(): Promise<void> {
    const originalGetDb = client.getDb;
    const originalWarn = console.warn;
    const warnings: string[] = [];

    const fakeDb = {
        $executeRaw: async () => {
            throw new Error('relation "staff_events" does not exist');
        },
    };

    (client as typeof client & { getDb: typeof client.getDb }).getDb = (() => fakeDb as any) as typeof client.getDb;
    console.warn = (message?: unknown) => {
        warnings.push(String(message ?? ''));
    };

    try {
        const emitter = new DbStaffEventEmitter();
        emitter.emit({
            staffComponent: 'Librarian',
            actionType: 'write_created',
            agentId: 'tester',
            source: 'api',
            level: 'audit',
        });
        emitter.emit({
            staffComponent: 'Librarian',
            actionType: 'write_updated',
            agentId: 'tester',
            source: 'api',
            level: 'audit',
        });

        await flushAsync();
        await flushAsync();

        assert.equal(warnings.length, 1, 'expected a single missing-table warning');
        assert.match(warnings[0]!, /staff_events table is missing/i);
    } finally {
        console.warn = originalWarn;
        (client as typeof client & { getDb: typeof client.getDb }).getDb = originalGetDb;
    }
}

async function testServerRegistersDbEmitter(): Promise<void> {
    const serverSource = await fs.readFile('src/api/server.ts', 'utf8');
    assert.match(serverSource, /staffEventEmitter:\s*new DbStaffEventEmitter\(\)/);
}

async function testSdkDoesNotDowngradeConcreteEmitter(): Promise<void> {
    const originalInitDb = client.initDb;
    (client as typeof client & { initDb: typeof client.initDb }).initDb = (() => ({}) as any) as typeof client.initDb;
    resetStaffEventEmitter();

    try {
        const emitter = new DbStaffEventEmitter();
        new Iranti({ connectionString: 'postgresql://example/test', staffEventEmitter: emitter });
        assert.equal(getStaffEventEmitter(), emitter, 'expected concrete emitter to be installed');

        new Iranti({ connectionString: 'postgresql://example/test' });
        assert.equal(getStaffEventEmitter(), emitter, 'expected later SDK construction without emitter to preserve the concrete emitter');
    } finally {
        resetStaffEventEmitter();
        (client as typeof client & { initDb: typeof client.initDb }).initDb = originalInitDb;
    }
}

async function main(): Promise<void> {
    await testEmitterWritesStaffEvents();
    await testMissingTableWarnsOnce();
    await testServerRegistersDbEmitter();
    await testSdkDoesNotDowngradeConcreteEmitter();
    console.log('db staff event emitter tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
