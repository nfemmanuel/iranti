import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import net from 'net';
import { readInstanceRuntime } from '../../src/lib/runtimeLifecycle';
import { parseDockerContainerNames, parsePublishedDockerHostPorts } from '../../src/lib/dockerCliParsing';
import { loadRuntimeEnv } from '../../src/lib/runtimeEnv';

type CliRun = {
    status: number | null;
    stdout: string;
    stderr: string;
};

const repoRoot = path.resolve(__dirname, '..', '..');
const cliScript = path.join(repoRoot, 'scripts', 'iranti-cli.ts');

function runCli(args: string[], cwd: string): CliRun {
    const proc = spawnSync(
        process.execPath,
        ['-r', 'ts-node/register/transpile-only', cliScript, ...args],
        {
            cwd,
            encoding: 'utf8',
            env: {
                ...process.env,
                NO_COLOR: '1',
            },
        }
    );

    return {
        status: proc.status,
        stdout: proc.stdout ?? '',
        stderr: proc.stderr ?? '',
    };
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath: string, value: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value, 'utf8');
}

async function listenOnRandomPort(): Promise<{ server: net.Server; port: number }> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '0.0.0.0', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('Failed to allocate test port.');
    }
    return { server, port: address.port };
}

function withCleanEnv<T>(fn: () => T): T {
    const snapshot = { ...process.env };
    try {
        return fn();
    } finally {
        for (const key of Object.keys(process.env)) {
            if (!(key in snapshot)) delete process.env[key];
        }
        for (const [key, value] of Object.entries(snapshot)) {
            if (typeof value === 'undefined') {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

async function main(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-runtime-lifecycle-'));
    const openServers: net.Server[] = [];
    try {
        const instancesDir = path.join(root, 'instances');
        const instanceDir = path.join(instancesDir, 'local');
        const envFile = path.join(instanceDir, '.env');
        const runtimeFile = path.join(instanceDir, 'runtime.json');
        const now = new Date().toISOString();

        writeJson(path.join(root, 'install.json'), {
            version: '0.2.15',
            scope: 'user',
            root,
            installedAt: now,
        });
        writeJson(path.join(instanceDir, 'instance.json'), {
            name: 'local',
            createdAt: now,
            port: 3050,
            envFile,
            instanceDir,
        });
        writeText(envFile, [
            'IRANTI_INSTANCE_NAME=local',
            'IRANTI_PORT=3050',
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_local',
            'LLM_PROVIDER=mock',
            `IRANTI_ESCALATION_DIR=${path.join(instanceDir, 'escalation')}`,
            `IRANTI_REQUEST_LOG_FILE=${path.join(instanceDir, 'logs', 'api-requests.log')}`,
            'IRANTI_ARCHIVIST_WATCH=true',
            'IRANTI_ARCHIVIST_DEBOUNCE_MS=60000',
            'IRANTI_ARCHIVIST_INTERVAL_MS=0',
            `IRANTI_API_KEY=test_${randomBytes(16).toString('hex')}`,
            '',
        ].join('\n'));
        writeJson(runtimeFile, {
            instanceName: 'local',
            instanceDir,
            envFile,
            runtimeFile,
            version: '0.2.15',
            pid: 999999,
            ppid: process.pid,
            port: 3050,
            startedAt: now,
            lastHeartbeatAt: now,
            updatedAt: now,
            status: 'running',
            healthUrl: 'http://localhost:3050/health',
            requestLogFile: path.join(instanceDir, 'logs', 'api-requests.log'),
            packageRoot: repoRoot,
        });

        const statusRun = runCli(['status', '--root', root, '--json'], repoRoot);
        assert.strictEqual(statusRun.status, 0, `status failed:\n${statusRun.stdout}\n${statusRun.stderr}`);

        const statusPayload = JSON.parse(statusRun.stdout.trim()) as {
            instances: Array<{
                name: string;
                runtime: {
                    running: boolean;
                    stale: boolean;
                    state: {
                        pid: number;
                        version: string;
                    } | null;
                };
            }>;
        };

        assert.strictEqual(statusPayload.instances.length, 1);
        assert.strictEqual(statusPayload.instances[0]?.name, 'local');
        assert.strictEqual(statusPayload.instances[0]?.runtime.running, false);
        assert.strictEqual(statusPayload.instances[0]?.runtime.stale, true);
        assert.strictEqual(statusPayload.instances[0]?.runtime.state?.pid, 999999);

        const upgradeRun = runCli(['upgrade', '--check', '--json', '--root', root], repoRoot);
        assert.strictEqual(upgradeRun.status, 0, `upgrade failed:\n${upgradeRun.stdout}\n${upgradeRun.stderr}`);

        const upgradePayload = JSON.parse(upgradeRun.stdout.trim()) as {
            runtimeInstances: Array<{ name: string; runtime: { running: boolean } }>;
            runningRuntimeInstances: Array<unknown>;
            restartRequiredInstances: Array<unknown>;
        };

        assert.strictEqual(upgradePayload.runtimeInstances.length, 1);
        assert.strictEqual(upgradePayload.runningRuntimeInstances.length, 0);
        assert.strictEqual(upgradePayload.restartRequiredInstances.length, 0);

        const legacyRuntimeFile = path.join(instanceDir, 'legacy-runtime.json');
        writeJson(legacyRuntimeFile, {
            instanceName: 'legacy-local',
            version: '0.2.14',
            pid: 424242,
            port: 3050,
            startedAt: now,
        });

        const legacyRuntime = readInstanceRuntime(legacyRuntimeFile);
        assert.ok(legacyRuntime, 'legacy runtime metadata should still parse');
        assert.strictEqual(legacyRuntime?.instanceDir, instanceDir);
        assert.strictEqual(legacyRuntime?.envFile, envFile);
        assert.strictEqual(legacyRuntime?.runtimeFile, legacyRuntimeFile);
        assert.strictEqual(legacyRuntime?.ppid, 0);
        assert.strictEqual(legacyRuntime?.lastHeartbeatAt, now);
        assert.strictEqual(legacyRuntime?.updatedAt, now);
        assert.strictEqual(legacyRuntime?.status, 'running');

        const projectDir = path.join(root, 'project');
        const projectEnvFile = path.join(projectDir, '.env.iranti');
        writeText(projectEnvFile, [
            'IRANTI_URL=http://localhost:3050',
            'IRANTI_API_KEY=project_key',
            `IRANTI_INSTANCE_ENV=${envFile}`,
            '',
        ].join('\n'));

        withCleanEnv(() => {
            const runtimeEnvResult = loadRuntimeEnv({ cwd: projectDir });
            assert.strictEqual(runtimeEnvResult.projectEnvFile, projectEnvFile);
            assert.strictEqual(runtimeEnvResult.instanceEnvFile, envFile);
            assert.ok(runtimeEnvResult.loadedFiles.includes(projectEnvFile));
            assert.ok(runtimeEnvResult.loadedFiles.includes(envFile));
            assert.strictEqual(process.env.IRANTI_URL, 'http://localhost:3050');
            assert.strictEqual(process.env.IRANTI_API_KEY, 'project_key');
            assert.strictEqual(process.env.DATABASE_URL, 'postgresql://postgres:postgres@localhost:5432/iranti_local');
            assert.strictEqual(process.env.LLM_PROVIDER, 'mock');
        });

        withCleanEnv(() => {
            // Simulate dotenv/config or a parent shell preloading the wrong database before runtime env resolution.
            process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/wrong_db';
            process.env.LLM_PROVIDER = 'gemini';
            process.env.IRANTI_URL = 'http://localhost:9999';
            process.env.IRANTI_API_KEY = 'stale_key';

            const runtimeEnvResult = loadRuntimeEnv({ cwd: projectDir });
            assert.strictEqual(runtimeEnvResult.projectEnvFile, projectEnvFile);
            assert.strictEqual(runtimeEnvResult.instanceEnvFile, envFile);
            assert.strictEqual(process.env.DATABASE_URL, 'postgresql://postgres:postgres@localhost:5432/iranti_local');
            assert.strictEqual(process.env.LLM_PROVIDER, 'mock');
            assert.strictEqual(process.env.IRANTI_URL, 'http://localhost:3050');
            assert.strictEqual(process.env.IRANTI_API_KEY, 'project_key');
        });

        const publishedPorts = parsePublishedDockerHostPorts([
            '0.0.0.0:5435->5432/tcp, [::]:5435->5432/tcp',
            '127.0.0.1:5434->5432/tcp',
            '5432/tcp',
            'localhost:5440->5432/tcp',
        ].join('\n'));
        assert.deepStrictEqual(Array.from(publishedPorts).sort((a, b) => a - b), [5434, 5435, 5440]);

        const containerNames = parseDockerContainerNames('alpha\r\nbeta\n\n gamma \n');
        assert.deepStrictEqual(containerNames, ['alpha', 'beta', 'gamma']);

        const restartRun = runCli(['instance', 'restart', 'local', '--root', root], repoRoot);
        assert.notStrictEqual(restartRun.status, 0, 'restart unexpectedly succeeded');
        assert.match(
            `${restartRun.stdout}\n${restartRun.stderr}`,
            /not currently running/i,
            'restart should refuse to operate on a stopped/stale instance'
        );

        const createConflict = await listenOnRandomPort();
        openServers.push(createConflict.server);
        const createConflictRun = runCli(['instance', 'create', 'busy', '--port', String(createConflict.port), '--root', root], repoRoot);
        assert.notStrictEqual(createConflictRun.status, 0, 'instance create unexpectedly accepted an occupied port');
        assert.match(
            `${createConflictRun.stdout}\n${createConflictRun.stderr}`,
            /port .* already in use/i,
            'instance create should fail cleanly when the requested port is occupied'
        );
        assert.ok(!fs.existsSync(path.join(root, 'instances', 'busy', '.env')), 'failed create should not leave an instance env behind');

        const configDir = path.join(instancesDir, 'config-check');
        const configEnvFile = path.join(configDir, '.env');
        writeJson(path.join(configDir, 'instance.json'), {
            name: 'config-check',
            createdAt: now,
            port: 3060,
            envFile: configEnvFile,
            instanceDir: configDir,
        });
        writeText(configEnvFile, [
            'IRANTI_INSTANCE_NAME=config-check',
            'IRANTI_PORT=3060',
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_config_check',
            'LLM_PROVIDER=mock',
            `IRANTI_ESCALATION_DIR=${path.join(configDir, 'escalation')}`,
            `IRANTI_REQUEST_LOG_FILE=${path.join(configDir, 'logs', 'api-requests.log')}`,
            'IRANTI_ARCHIVIST_WATCH=true',
            'IRANTI_ARCHIVIST_DEBOUNCE_MS=60000',
            'IRANTI_ARCHIVIST_INTERVAL_MS=0',
            `IRANTI_API_KEY=test_${randomBytes(16).toString('hex')}`,
            '',
        ].join('\n'));

        const configConflict = await listenOnRandomPort();
        openServers.push(configConflict.server);
        const configureConflictRun = runCli(['configure', 'instance', 'config-check', '--port', String(configConflict.port), '--root', root], repoRoot);
        assert.notStrictEqual(configureConflictRun.status, 0, 'configure instance unexpectedly accepted an occupied port');
        assert.match(
            `${configureConflictRun.stdout}\n${configureConflictRun.stderr}`,
            /port .* already in use/i,
            'configure instance should fail cleanly when the requested port is occupied'
        );

        const freePortServer = await listenOnRandomPort();
        const freePort = freePortServer.port;
        await new Promise<void>((resolve) => freePortServer.server.close(() => resolve()));
        const configureOkRun = runCli(['configure', 'instance', 'config-check', '--port', String(freePort), '--root', root], repoRoot);
        assert.strictEqual(configureOkRun.status, 0, `configure instance failed:\n${configureOkRun.stdout}\n${configureOkRun.stderr}`);
        const configuredMeta = JSON.parse(fs.readFileSync(path.join(configDir, 'instance.json'), 'utf8')) as { port: number };
        assert.strictEqual(configuredMeta.port, freePort, 'instance.json should stay in sync with configured ports');

        const runConflictDir = path.join(instancesDir, 'run-conflict');
        const runConflictEnvFile = path.join(runConflictDir, '.env');
        const runConflict = await listenOnRandomPort();
        openServers.push(runConflict.server);
        writeJson(path.join(runConflictDir, 'instance.json'), {
            name: 'run-conflict',
            createdAt: now,
            port: runConflict.port,
            envFile: runConflictEnvFile,
            instanceDir: runConflictDir,
        });
        writeText(runConflictEnvFile, [
            'IRANTI_INSTANCE_NAME=run-conflict',
            `IRANTI_PORT=${runConflict.port}`,
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_run_conflict',
            'LLM_PROVIDER=mock',
            `IRANTI_ESCALATION_DIR=${path.join(runConflictDir, 'escalation')}`,
            `IRANTI_REQUEST_LOG_FILE=${path.join(runConflictDir, 'logs', 'api-requests.log')}`,
            'IRANTI_ARCHIVIST_WATCH=true',
            'IRANTI_ARCHIVIST_DEBOUNCE_MS=60000',
            'IRANTI_ARCHIVIST_INTERVAL_MS=0',
            `IRANTI_API_KEY=test_${randomBytes(16).toString('hex')}`,
            '',
        ].join('\n'));
        const runConflictRun = runCli(['run', '--instance', 'run-conflict', '--root', root], repoRoot);
        assert.notStrictEqual(runConflictRun.status, 0, 'run unexpectedly started on an occupied port');
        assert.match(
            `${runConflictRun.stdout}\n${runConflictRun.stderr}`,
            /port .* already in use/i,
            'run should fail cleanly before app.listen when the configured port is occupied'
        );

        console.log('runtime lifecycle CLI smoke passed');
    } finally {
        for (const server of openServers) {
            try {
                server.close();
            } catch {
                // ignore test cleanup failures
            }
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
