import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import net from 'net';
import { inspectRuntimeState, readInstanceRuntime } from '../../src/lib/runtimeLifecycle';
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

async function startHealthServerProcess(): Promise<{ child: ChildProcess; port: number }> {
    const script = `
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    process.exit(1);
    return;
  }
  process.stdout.write(String(address.port));
});
`;
    const child = spawn(process.execPath, ['-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const port = await new Promise<number>((resolve, reject) => {
        let stdout = '';
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for health server port.')), 5_000);

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
            const parsed = Number(stdout.trim());
            if (Number.isFinite(parsed) && parsed > 0) {
                clearTimeout(timeout);
                resolve(parsed);
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timeout);
            reject(new Error(`Health server process exited early with code ${code}.`));
        });
        child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });

    return { child, port };
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
    const cleanupCallbacks: Array<() => void> = [];
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
            runtimeRootSource: string;
            boundRuntimeRoot: string | null;
            rootMismatch: boolean;
            discovery: {
                selectedRuntimeRoot: string;
                selectionSource: string;
                boundRuntimeRoot: string | null;
                projectBindingFile: string | null;
                rootMismatch: boolean;
            };
            instances: Array<{
                name: string;
                config: {
                    classification: string;
                };
                runtime: {
                    running: boolean;
                    stale: boolean;
                    classification: string;
                    health: {
                        checked: boolean;
                        ok: boolean;
                    };
                    state: {
                        pid: number;
                        version: string;
                    } | null;
                };
            }>;
        };

        assert.strictEqual(statusPayload.runtimeRootSource, 'flag');
        assert.strictEqual(statusPayload.boundRuntimeRoot, null);
        assert.strictEqual(statusPayload.rootMismatch, false);
        assert.strictEqual(statusPayload.discovery.selectedRuntimeRoot, root);
        assert.strictEqual(statusPayload.discovery.selectionSource, 'flag');
        assert.strictEqual(statusPayload.discovery.boundRuntimeRoot, null);
        assert.strictEqual(statusPayload.discovery.projectBindingFile, null);
        assert.strictEqual(statusPayload.discovery.rootMismatch, false);
        const localStatus = statusPayload.instances.find((instance) => instance.name === 'local');
        assert.ok(localStatus, 'Expected local instance in status payload.');
        assert.strictEqual(localStatus?.config.classification, 'complete');
        assert.strictEqual(localStatus?.runtime.running, false);
        assert.strictEqual(localStatus?.runtime.stale, true);
        assert.strictEqual(localStatus?.runtime.classification, 'stale');
        assert.strictEqual(localStatus?.runtime.health.checked, false);
        assert.strictEqual(localStatus?.runtime.state?.pid, 999999);

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

        const healthyRuntime = await startHealthServerProcess();
        cleanupCallbacks.push(() => {
            if (!healthyRuntime.child.killed) {
                healthyRuntime.child.kill();
            }
        });
        const healthyDir = path.join(instancesDir, 'healthy');
        const healthyEnvFile = path.join(healthyDir, '.env');
        writeJson(path.join(healthyDir, 'instance.json'), {
            name: 'healthy',
            createdAt: now,
            port: healthyRuntime.port,
            envFile: healthyEnvFile,
            instanceDir: healthyDir,
        });
        writeText(healthyEnvFile, [
            'IRANTI_INSTANCE_NAME=healthy',
            `IRANTI_PORT=${healthyRuntime.port}`,
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_healthy',
            '',
        ].join('\n'));
        writeJson(path.join(healthyDir, 'runtime.json'), {
            instanceName: 'healthy',
            instanceDir: healthyDir,
            envFile: healthyEnvFile,
            runtimeFile: path.join(healthyDir, 'runtime.json'),
            version: '0.2.15',
            pid: process.pid,
            ppid: process.ppid ?? 0,
            port: healthyRuntime.port,
            startedAt: now,
            lastHeartbeatAt: now,
            updatedAt: now,
            status: 'running',
            healthUrl: `http://127.0.0.1:${healthyRuntime.port}/health`,
        });

        const unhealthyPortServer = await listenOnRandomPort();
        const unhealthyPort = unhealthyPortServer.port;
        await new Promise<void>((resolve) => unhealthyPortServer.server.close(() => resolve()));
        const unhealthyDir = path.join(instancesDir, 'unhealthy');
        const unhealthyEnvFile = path.join(unhealthyDir, '.env');
        writeJson(path.join(unhealthyDir, 'instance.json'), {
            name: 'unhealthy',
            createdAt: now,
            port: unhealthyPort,
            envFile: unhealthyEnvFile,
            instanceDir: unhealthyDir,
        });
        writeText(unhealthyEnvFile, [
            'IRANTI_INSTANCE_NAME=unhealthy',
            `IRANTI_PORT=${unhealthyPort}`,
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_unhealthy',
            '',
        ].join('\n'));
        writeJson(path.join(unhealthyDir, 'runtime.json'), {
            instanceName: 'unhealthy',
            instanceDir: unhealthyDir,
            envFile: unhealthyEnvFile,
            runtimeFile: path.join(unhealthyDir, 'runtime.json'),
            version: '0.2.15',
            pid: process.pid,
            ppid: process.ppid ?? 0,
            port: unhealthyPort,
            startedAt: now,
            lastHeartbeatAt: now,
            updatedAt: now,
            status: 'running',
            healthUrl: `http://127.0.0.1:${unhealthyPort}/health`,
        });

        const partialDir = path.join(instancesDir, 'partial');
        writeJson(path.join(partialDir, 'instance.json'), {
            name: 'partial',
            createdAt: now,
            port: 3090,
            envFile: path.join(partialDir, '.env'),
            instanceDir: partialDir,
        });

        const invalidDir = path.join(instancesDir, 'invalid-config');
        const invalidEnvFile = path.join(invalidDir, '.env');
        writeText(path.join(invalidDir, 'instance.json'), '{not-json');
        writeText(invalidEnvFile, [
            'IRANTI_INSTANCE_NAME=invalid-config',
            'IRANTI_PORT=3091',
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_invalid',
            '',
        ].join('\n'));

        const statusWithVariantsRun = runCli(['status', '--root', root, '--json'], repoRoot);
        assert.strictEqual(statusWithVariantsRun.status, 0, `status with variant instances failed:\n${statusWithVariantsRun.stdout}\n${statusWithVariantsRun.stderr}`);
        const statusWithVariants = JSON.parse(statusWithVariantsRun.stdout.trim()) as typeof statusPayload;
        const healthyStatus = statusWithVariants.instances.find((instance) => instance.name === 'healthy');
        const unhealthyStatus = statusWithVariants.instances.find((instance) => instance.name === 'unhealthy');
        const partialStatus = statusWithVariants.instances.find((instance) => instance.name === 'partial');
        const invalidStatus = statusWithVariants.instances.find((instance) => instance.name === 'invalid-config');
        assert.ok(healthyStatus, 'Expected healthy instance in status payload.');
        assert.ok(unhealthyStatus, 'Expected unhealthy instance in status payload.');
        assert.ok(partialStatus, 'Expected partial instance in status payload.');
        assert.ok(invalidStatus, 'Expected invalid-config instance in status payload.');
        assert.strictEqual(healthyStatus?.runtime.classification, 'running');
        assert.strictEqual(healthyStatus?.runtime.health.ok, true);
        assert.strictEqual(unhealthyStatus?.runtime.classification, 'unhealthy');
        assert.strictEqual(unhealthyStatus?.runtime.running, false);
        assert.strictEqual(unhealthyStatus?.runtime.health.checked, true);
        assert.strictEqual(unhealthyStatus?.runtime.health.ok, false);
        assert.strictEqual(partialStatus?.config.classification, 'partial');
        assert.strictEqual(invalidStatus?.config.classification, 'invalid');

        const healthyInspection = await inspectRuntimeState(path.join(healthyDir, 'runtime.json'));
        assert.strictEqual(healthyInspection.classification, 'running');
        assert.strictEqual(healthyInspection.health.checked, true);
        assert.strictEqual(healthyInspection.health.ok, true);

        const unhealthyInspection = await inspectRuntimeState(path.join(unhealthyDir, 'runtime.json'));
        assert.strictEqual(unhealthyInspection.classification, 'unhealthy');
        assert.strictEqual(unhealthyInspection.health.checked, true);
        assert.strictEqual(unhealthyInspection.health.ok, false);

        const runPartialRun = runCli(['run', '--instance', 'partial', '--root', root], repoRoot);
        assert.notStrictEqual(runPartialRun.status, 0, 'run unexpectedly accepted a partial instance');
        assert.match(
            `${runPartialRun.stdout}\n${runPartialRun.stderr}`,
            /instance 'partial' is partial/i,
            'run should reject incomplete instance configuration before reading env state'
        );

        const restartInvalidRun = runCli(['instance', 'restart', 'invalid-config', '--root', root], repoRoot);
        assert.notStrictEqual(restartInvalidRun.status, 0, 'restart unexpectedly accepted an invalid instance');
        assert.match(
            `${restartInvalidRun.stdout}\n${restartInvalidRun.stderr}`,
            /instance 'invalid-config' is invalid/i,
            'restart should reject invalid instance configuration before attempting lifecycle actions'
        );

        const repairPartialPortServer = await listenOnRandomPort();
        const repairPartialPort = repairPartialPortServer.port;
        await new Promise<void>((resolve) => repairPartialPortServer.server.close(() => resolve()));
        const repairPartialRun = runCli([
            'configure',
            'instance',
            'partial',
            '--root',
            root,
            '--port',
            String(repairPartialPort),
            '--db-url',
            'postgresql://postgres:postgres@localhost:5432/iranti_partial',
            '--api-key',
            `test_${randomBytes(16).toString('hex')}`,
        ], repoRoot);
        assert.strictEqual(repairPartialRun.status, 0, `configure instance failed to repair partial config:\n${repairPartialRun.stdout}\n${repairPartialRun.stderr}`);
        const repairedPartialStatusRun = runCli(['status', '--root', root, '--json'], repoRoot);
        assert.strictEqual(repairedPartialStatusRun.status, 0, `status after repair failed:\n${repairedPartialStatusRun.stdout}\n${repairedPartialStatusRun.stderr}`);
        const repairedPartialStatus = JSON.parse(repairedPartialStatusRun.stdout.trim()) as typeof statusPayload;
        const repairedPartial = repairedPartialStatus.instances.find((instance) => instance.name === 'partial');
        assert.strictEqual(repairedPartial?.config.classification, 'complete');

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
        const nestedProjectDir = path.join(projectDir, 'src', 'deep');
        const projectEnvFile = path.join(projectDir, '.env.iranti');
        fs.mkdirSync(nestedProjectDir, { recursive: true });
        writeText(projectEnvFile, [
            'IRANTI_URL=http://localhost:3050',
            'IRANTI_API_KEY=project_key',
            `IRANTI_INSTANCE_ENV=${envFile}`,
            '',
        ].join('\n'));

        withCleanEnv(() => {
            const runtimeEnvResult = loadRuntimeEnv({ cwd: nestedProjectDir });
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

            const runtimeEnvResult = loadRuntimeEnv({ cwd: nestedProjectDir });
            assert.strictEqual(runtimeEnvResult.projectEnvFile, projectEnvFile);
            assert.strictEqual(runtimeEnvResult.instanceEnvFile, envFile);
            assert.strictEqual(process.env.DATABASE_URL, 'postgresql://postgres:postgres@localhost:5432/iranti_local');
            assert.strictEqual(process.env.LLM_PROVIDER, 'mock');
            assert.strictEqual(process.env.IRANTI_URL, 'http://localhost:3050');
            assert.strictEqual(process.env.IRANTI_API_KEY, 'project_key');
        });

        const projectStatusRun = runCli(['status', '--json'], nestedProjectDir);
        assert.strictEqual(projectStatusRun.status, 0, `project status failed:\n${projectStatusRun.stdout}\n${projectStatusRun.stderr}`);
        const projectStatus = JSON.parse(projectStatusRun.stdout.trim()) as {
            runtimeRoot: string;
            runtimeRootSource: string;
            boundRuntimeRoot: string | null;
            rootMismatch: boolean;
            discovery: {
                selectedRuntimeRoot: string;
                selectionSource: string;
                boundRuntimeRoot: string | null;
                projectBindingFile: string | null;
                rootMismatch: boolean;
            };
        };
        assert.strictEqual(projectStatus.runtimeRoot, root);
        assert.strictEqual(projectStatus.runtimeRootSource, 'project-binding');
        assert.strictEqual(projectStatus.boundRuntimeRoot, root);
        assert.strictEqual(projectStatus.rootMismatch, false);
        assert.strictEqual(projectStatus.discovery.selectedRuntimeRoot, root);
        assert.strictEqual(projectStatus.discovery.selectionSource, 'project-binding');
        assert.strictEqual(projectStatus.discovery.boundRuntimeRoot, root);
        assert.strictEqual(projectStatus.discovery.projectBindingFile, projectEnvFile);
        assert.strictEqual(projectStatus.discovery.rootMismatch, false);

        const isolatedRoot = path.join(root, 'isolated-root');
        const isolatedInstanceDir = path.join(isolatedRoot, 'instances', 'isolated');
        const isolatedEnvFile = path.join(isolatedInstanceDir, '.env');
        writeText(projectEnvFile, [
            'IRANTI_URL=http://localhost:3999',
            'IRANTI_API_KEY=project_key',
            `IRANTI_INSTANCE_ENV=${isolatedEnvFile}`,
            '',
        ].join('\n'));
        writeText(isolatedEnvFile, [
            'IRANTI_INSTANCE_NAME=isolated',
            'IRANTI_PORT=3999',
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_isolated',
            '',
        ].join('\n'));

        const mismatchStatusRun = runCli(['status', '--root', root, '--json'], nestedProjectDir);
        assert.strictEqual(mismatchStatusRun.status, 0, `status with bound-root mismatch failed:\n${mismatchStatusRun.stdout}\n${mismatchStatusRun.stderr}`);
        const mismatchStatus = JSON.parse(mismatchStatusRun.stdout.trim()) as {
            boundRuntimeRoot: string | null;
            rootMismatch: boolean;
            otherRuntimeRoots: string[];
            discovery: {
                boundRuntimeRoot: string | null;
                rootMismatch: boolean;
                otherRuntimeRoots?: string[];
            };
        };
        assert.strictEqual(mismatchStatus.boundRuntimeRoot, isolatedRoot);
        assert.strictEqual(mismatchStatus.rootMismatch, true);
        assert.ok(mismatchStatus.otherRuntimeRoots.includes(isolatedRoot), 'Expected status JSON to report the alternate bound runtime root.');
        assert.strictEqual(mismatchStatus.discovery.boundRuntimeRoot, isolatedRoot);
        assert.strictEqual(mismatchStatus.discovery.rootMismatch, true);

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
        for (const cleanup of cleanupCallbacks) {
            try {
                cleanup();
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
