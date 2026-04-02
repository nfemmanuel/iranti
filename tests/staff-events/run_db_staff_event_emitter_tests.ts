import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Prisma } from '../../src/generated/prisma/client';
import * as client from '../../src/library/client';
import { DbStaffEventEmitter } from '../../src/lib/dbStaffEventEmitter';
import { resetStaffEventsTableBootstrap } from '../../src/lib/staffEventsTable';
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

async function testMissingTableSelfHeals(): Promise<void> {
    const originalGetDb = client.getDb;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    const steps: string[] = [];
    let tableReady = false;

    const fakeDb = {
        $executeRaw: async () => {
            steps.push('insert');
            if (!tableReady) {
                throw new Error('relation "staff_events" does not exist');
            }
            return 1;
        },
        $executeRawUnsafe: async (sql: string) => {
            steps.push(sql.includes('CREATE TABLE') ? 'bootstrap_table' : 'bootstrap_index');
            tableReady = true;
            return 1;
        },
    };

    (client as typeof client & { getDb: typeof client.getDb }).getDb = (() => fakeDb as any) as typeof client.getDb;
    console.warn = (message?: unknown) => {
        warnings.push(String(message ?? ''));
    };
    resetStaffEventsTableBootstrap();

    try {
        const emitter = new DbStaffEventEmitter();
        emitter.emit({
            staffComponent: 'Librarian',
            actionType: 'write_created',
            agentId: 'tester',
            source: 'api',
            level: 'audit',
        });

        await flushAsync();
        await flushAsync();

        assert.equal(warnings.length, 0, `expected self-healing bootstrap to avoid warnings, got ${warnings.join('\n')}`);
        assert.equal(steps.filter((step) => step === 'insert').length, 2, `expected one failed insert and one retry, got ${JSON.stringify(steps)}`);
        assert.ok(steps.includes('bootstrap_table'), `expected bootstrap to create staff_events, got ${JSON.stringify(steps)}`);
    } finally {
        console.warn = originalWarn;
        resetStaffEventsTableBootstrap();
        (client as typeof client & { getDb: typeof client.getDb }).getDb = originalGetDb;
    }
}

async function testServerRegistersDbEmitter(): Promise<void> {
    const serverSource = await fs.readFile('src/api/server.ts', 'utf8');
    assert.match(serverSource, /createFirstPartyIranti\(/);
}

async function testFirstPartyHostsUseConcreteEmitterHelper(): Promise<void> {
    const files = [
        'scripts/iranti-cli.ts',
        'scripts/iranti-mcp.ts',
        'scripts/claude-code-memory-hook.ts',
    ];

    for (const file of files) {
        const source = await fs.readFile(file, 'utf8');
        assert.match(source, /createFirstPartyIranti\(/, `expected ${file} to construct Iranti through the first-party helper`);
    }
}

async function testEmitterFlushWaitsForPendingWrites(): Promise<void> {
    const originalGetDb = client.getDb;
    let release: (() => void) | null = null;
    let writes = 0;

    const fakeDb = {
        $executeRaw: async () => {
            writes += 1;
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return 1;
        },
    };

    (client as typeof client & { getDb: typeof client.getDb }).getDb = (() => fakeDb as any) as typeof client.getDb;

    try {
        const emitter = new DbStaffEventEmitter();
        emitter.emit({
            staffComponent: 'Attendant',
            actionType: 'attend_completed',
            agentId: 'flush_tester',
            source: 'cli',
            level: 'debug',
        });

        assert.equal(writes, 1, 'expected one pending DB write before flush');
        const flushPromise = emitter.flush();
        const resolvePending = release as (() => void) | null;
        assert.ok(resolvePending, 'expected flush test to hold a pending write');
        (resolvePending as () => void)();
        await flushPromise;
    } finally {
        (client as typeof client & { getDb: typeof client.getDb }).getDb = originalGetDb;
    }
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

async function testStaffEventsSchemaAndMigrationExist(): Promise<void> {
    const schema = await fs.readFile('prisma/schema.prisma', 'utf8');
    assert.match(schema, /model StaffEvent\s*\{/, 'expected prisma/schema.prisma to declare StaffEvent');
    assert.match(schema, /@@map\("staff_events"\)/, 'expected StaffEvent model to map to staff_events');

    const migration = await fs.readFile('prisma/migrations/20260331101500_add_staff_events_ledger/migration.sql', 'utf8');
    assert.match(migration, /CREATE TABLE IF NOT EXISTS "staff_events"/i, 'expected staff_events migration to create the table idempotently');
    assert.match(migration, /staff_events_session_id_idx/i, 'expected staff_events migration to index metadata sessionId');
    assert.match(migration, /staff_events_host_idx/i, 'expected staff_events migration to index metadata host');
    assert.match(migration, /CREATE INDEX IF NOT EXISTS "staff_events_timestamp_idx"/i, 'expected staff_events migration indexes to be idempotent for preexisting tables');
}

async function main(): Promise<void> {
    await testEmitterWritesStaffEvents();
    await testMissingTableSelfHeals();
    await testEmitterFlushWaitsForPendingWrites();
    await testServerRegistersDbEmitter();
    await testFirstPartyHostsUseConcreteEmitterHelper();
    await testSdkDoesNotDowngradeConcreteEmitter();
    await testStaffEventsSchemaAndMigrationExist();
    console.log('db staff event emitter tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
