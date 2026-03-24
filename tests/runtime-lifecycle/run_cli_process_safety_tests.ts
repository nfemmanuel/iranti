import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSyncResolved } from '../../src/lib/commandInvocation';
import { ensureFileContainsLinesLocked, writeTextFileLocked } from '../../src/lib/fileMutation';

async function testLiteralArgumentDelivery(root: string): Promise<void> {
    const scriptDir = path.join(root, 'script dir');
    fs.mkdirSync(scriptDir, { recursive: true });
    const echoScript = path.join(scriptDir, 'echo-argv.js');
    fs.writeFileSync(
        echoScript,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
        'utf8',
    );

    const specialArgs = [
        'plain',
        'value with spaces',
        '"quoted"',
        '%TEMP%',
        '!VAR!',
        '^',
        '&',
        'C:\\Program Files\\Iranti Test\\folder',
    ];

    const proc = spawnSyncResolved(process.execPath, [echoScript, ...specialArgs], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = typeof proc.stdout === 'string' ? proc.stdout : Buffer.from(proc.stdout ?? []).toString('utf8');
    const stderr = typeof proc.stderr === 'string' ? proc.stderr : Buffer.from(proc.stderr ?? []).toString('utf8');
    assert.strictEqual(proc.status, 0, `spawnSyncResolved failed:\n${stdout}\n${stderr}`);
    assert.deepStrictEqual(JSON.parse(stdout || '[]'), specialArgs, 'arguments should arrive literally without shell expansion');
}

async function testConcurrentLockedWrites(root: string): Promise<void> {
    const filePath = path.join(root, 'config.env');
    fs.writeFileSync(filePath, 'BASE=1\n', 'utf8');

    await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
            writeTextFileLocked(filePath, async (existing) => {
                await new Promise((resolve) => setTimeout(resolve, (index % 4) * 10));
                return `${existing}ENTRY_${index}=ok\n`;
            }),
        ),
    );

    const finalText = fs.readFileSync(filePath, 'utf8');
    for (let index = 0; index < 12; index += 1) {
        assert.match(finalText, new RegExp(`^ENTRY_${index}=ok$`, 'm'), `missing concurrent update ENTRY_${index}`);
    }
}

async function testStaleLockRecovery(root: string): Promise<void> {
    const filePath = path.join(root, 'stale.env');
    const lockPath = `${filePath}.lock`;
    fs.writeFileSync(filePath, 'INITIAL=1\n', 'utf8');
    fs.writeFileSync(lockPath, JSON.stringify({
        pid: 999999,
        hostname: 'stale-host',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
    }), 'utf8');
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    await writeTextFileLocked(filePath, (existing) => `${existing}RECOVERED=1\n`, {
        timeoutMs: 500,
        staleMs: 100,
    });

    const finalText = fs.readFileSync(filePath, 'utf8');
    assert.match(finalText, /^RECOVERED=1$/m, 'stale lock recovery should permit the write');
    assert.ok(!fs.existsSync(lockPath), 'stale lock should be removed after recovery');
}

async function testFailedWritePreservesOriginal(root: string): Promise<void> {
    const filePath = path.join(root, 'failure.env');
    fs.writeFileSync(filePath, 'SAFE=1\n', 'utf8');

    await assert.rejects(
        () => writeTextFileLocked(filePath, () => {
            throw new Error('simulated failure');
        }),
        /simulated failure/,
    );

    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'SAFE=1\n', 'failed writes should preserve the original content');
    const leftovers = fs.readdirSync(root).filter((entry) => entry.startsWith('failure.env.tmp-'));
    assert.deepStrictEqual(leftovers, [], 'failed writes should not leave temp files behind');
    assert.ok(!fs.existsSync(`${filePath}.lock`), 'failed writes should release the lock');
}

async function testEnsureFileContainsLinesLocked(root: string): Promise<void> {
    const filePath = path.join(root, 'project.gitignore');
    fs.writeFileSync(filePath, 'node_modules\n', 'utf8');

    await Promise.all([
        ensureFileContainsLinesLocked(filePath, ['.env.iranti', '.env.iranti.local']),
        ensureFileContainsLinesLocked(filePath, ['.env.iranti.local', '.env.iranti']),
        ensureFileContainsLinesLocked(filePath, ['.env.iranti']),
    ]);

    const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
    assert.ok(lines.includes('.env.iranti'), 'project ignore should include .env.iranti');
    assert.ok(lines.includes('.env.iranti.local'), 'project ignore should include .env.iranti.local');
    assert.strictEqual(lines.filter((line) => line === '.env.iranti').length, 1, 'project ignore should not duplicate .env.iranti');
    assert.strictEqual(lines.filter((line) => line === '.env.iranti.local').length, 1, 'project ignore should not duplicate .env.iranti.local');
}

async function main(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-cli-hardening-'));
    try {
        await testLiteralArgumentDelivery(root);
        await testConcurrentLockedWrites(root);
        await testStaleLockRecovery(root);
        await testFailedWritePreservesOriginal(root);
        await testEnsureFileContainsLinesLocked(root);
        console.log('cli process safety tests passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
