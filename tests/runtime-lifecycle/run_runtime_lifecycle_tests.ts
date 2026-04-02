import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import net from 'net';
import { inspectRuntimeState, readInstanceRuntime, resolveRuntimeAuthorityFromEnv } from '../../src/lib/runtimeLifecycle';
import { parseDockerContainerNames, parsePublishedDockerHostPorts } from '../../src/lib/dockerCliParsing';
import { resolvePackageRoot } from '../../src/lib/packageRoot';
import { loadRuntimeEnv } from '../../src/lib/runtimeEnv';

type CliRun = {
    status: number | null;
    stdout: string;
    stderr: string;
};

const repoRoot = path.resolve(__dirname, '..', '..');
const cliScript = path.join(repoRoot, 'scripts', 'iranti-cli.ts');
const serverScript = path.join(repoRoot, 'src', 'api', 'server.ts');
const tsNodeRegister = require.resolve('ts-node/register');

function buildTsNodeEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        ...process.env,
        ...extraEnv,
        TS_NODE_PROJECT: path.join(repoRoot, 'tsconfig.json'),
        TS_NODE_TRANSPILE_ONLY: 'true',
    };
}

function cliEntrypointArgs(args: string[]): string[] {
    return ['-r', tsNodeRegister, cliScript, ...args];
}

function serverEntrypointArgs(): string[] {
    return ['-r', tsNodeRegister, serverScript];
}

function runCli(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): CliRun {
    const proc = spawnSync(
        process.execPath,
        cliEntrypointArgs(args),
        {
            cwd,
            encoding: 'utf8',
            env: {
                ...buildTsNodeEnv(extraEnv),
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

async function closeServer(server: net.Server): Promise<void> {
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
}

async function terminateChildProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 2_000);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        try {
            child.kill();
        } catch {
            clearTimeout(timer);
            resolve();
        }
    });
}

async function removeDirWithRetry(dirPath: string, attempts: number = 5): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if ((code !== 'EPERM' && code !== 'ENOTEMPTY') || attempt === attempts) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
}

async function terminateManagedRuntimeProcesses(root: string): Promise<void> {
    const instancesDir = path.join(root, 'instances');
    if (!fs.existsSync(instancesDir)) return;
    const entries = fs.readdirSync(instancesDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runtimeFile = path.join(instancesDir, entry.name, 'runtime.json');
        if (!fs.existsSync(runtimeFile)) continue;
        try {
            const raw = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')) as { pid?: unknown };
            const pid = typeof raw.pid === 'number' ? raw.pid : null;
            if (!pid || pid === process.pid) continue;
            try {
                process.kill(pid, 0);
            } catch {
                continue;
            }
            try {
                process.kill(pid);
            } catch {
                // ignore kill failures during test cleanup
            }
        } catch {
            // ignore unreadable runtime metadata during cleanup
        }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
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
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
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
    const ambientFreeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-runtime-cwd-'));
    const openServers: net.Server[] = [];
    const cleanupCallbacks: Array<() => Promise<void> | void> = [];
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
        writeJson(path.join(instanceDir, 'projects.json'), {
            projects: [
                {
                    projectPath: path.join(root, 'demo-project'),
                    agentId: 'status_demo_agent',
                    memoryEntity: 'project/status_demo',
                    mode: 'shared',
                    boundAt: now,
                },
            ],
        });

        const statusRun = runCli(['status', '--root', root, '--json'], ambientFreeCwd);
        assert.strictEqual(statusRun.status, 0, `status failed:\n${statusRun.stdout}\n${statusRun.stderr}`);

        const quotedRootStatusRun = runCli(['status', '--root', `'${root}'`, '--json'], ambientFreeCwd);
        assert.strictEqual(
            quotedRootStatusRun.status,
            0,
            `status with single-quoted root failed:\n${quotedRootStatusRun.stdout}\n${quotedRootStatusRun.stderr}`
        );
        const quotedRootStatusPayload = JSON.parse(quotedRootStatusRun.stdout.trim()) as {
            runtimeRoot: string;
            runtimeRootSource: string;
        };
        assert.strictEqual(quotedRootStatusPayload.runtimeRoot, root);
        assert.strictEqual(quotedRootStatusPayload.runtimeRootSource, 'flag');

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
            recommendedActions: string[];
            instances: Array<{
                name: string;
                projectCount?: number;
                boundProjects?: Array<{
                    projectPath: string;
                    agentId: string;
                    memoryEntity: string;
                    mode: string;
                    boundAt: string | null;
                }>;
                repairHints?: string[];
                config: {
                    classification: string;
                };
                runtime: {
                    running: boolean;
                    stale: boolean;
                    classification: string;
                    detail: string;
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
        assert.ok(statusPayload.recommendedActions.some((hint) => hint.includes('instance restart local')), 'Expected stale local instance repair hint in initial status payload.');
        const localStatus = statusPayload.instances.find((instance) => instance.name === 'local');
        assert.ok(localStatus, 'Expected local instance in status payload.');
        assert.strictEqual(localStatus?.config.classification, 'complete');
        assert.strictEqual(localStatus?.runtime.running, false);
        assert.strictEqual(localStatus?.runtime.stale, true);
        assert.strictEqual(localStatus?.runtime.classification, 'stale');
        assert.strictEqual(localStatus?.runtime.health.checked, false);
        assert.strictEqual(localStatus?.runtime.state?.pid, 999999);
        assert.strictEqual(localStatus?.projectCount, 1);
        assert.strictEqual(localStatus?.boundProjects?.[0]?.projectPath, path.join(root, 'demo-project'));
        assert.strictEqual(localStatus?.boundProjects?.[0]?.agentId, 'status_demo_agent');

        const upgradeRun = runCli(['upgrade', '--check', '--json', '--root', root], ambientFreeCwd);
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
        cleanupCallbacks.push(() => terminateChildProcess(healthyRuntime.child));
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

        const misownedConfigDir = path.join(instancesDir, 'misowned-config');
        const misownedConfigEnvFile = path.join(misownedConfigDir, '.env');
        writeJson(path.join(misownedConfigDir, 'instance.json'), {
            name: 'foreign-config',
            createdAt: now,
            port: 3092,
            envFile: path.join(root, 'elsewhere', '.env'),
            instanceDir: path.join(root, 'elsewhere'),
        });
        writeText(misownedConfigEnvFile, [
            'IRANTI_INSTANCE_NAME=misowned-config',
            'IRANTI_PORT=3092',
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_misowned_config',
            '',
        ].join('\n'));

        const misownedRuntimeDir = path.join(instancesDir, 'misowned-runtime');
        const misownedRuntimeEnvFile = path.join(misownedRuntimeDir, '.env');
        writeJson(path.join(misownedRuntimeDir, 'instance.json'), {
            name: 'misowned-runtime',
            createdAt: now,
            port: healthyRuntime.port,
            envFile: misownedRuntimeEnvFile,
            instanceDir: misownedRuntimeDir,
        });
        writeText(misownedRuntimeEnvFile, [
            'IRANTI_INSTANCE_NAME=misowned-runtime',
            `IRANTI_PORT=${healthyRuntime.port}`,
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_misowned_runtime',
            '',
        ].join('\n'));
        writeJson(path.join(misownedRuntimeDir, 'runtime.json'), {
            instanceName: 'foreign-runtime',
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

        const stoppedButAliveDir = path.join(instancesDir, 'stopped-but-alive');
        const stoppedButAliveEnvFile = path.join(stoppedButAliveDir, '.env');
        writeJson(path.join(stoppedButAliveDir, 'instance.json'), {
            name: 'stopped-but-alive',
            createdAt: now,
            port: healthyRuntime.port,
            envFile: stoppedButAliveEnvFile,
            instanceDir: stoppedButAliveDir,
        });
        writeText(stoppedButAliveEnvFile, [
            'IRANTI_INSTANCE_NAME=stopped-but-alive',
            `IRANTI_PORT=${healthyRuntime.port}`,
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_stopped_but_alive',
            '',
        ].join('\n'));
        writeJson(path.join(stoppedButAliveDir, 'runtime.json'), {
            instanceName: 'stopped-but-alive',
            instanceDir: stoppedButAliveDir,
            envFile: stoppedButAliveEnvFile,
            runtimeFile: path.join(stoppedButAliveDir, 'runtime.json'),
            version: '0.2.15',
            pid: process.pid,
            ppid: process.ppid ?? 0,
            port: healthyRuntime.port,
            startedAt: now,
            lastHeartbeatAt: now,
            updatedAt: now,
            status: 'stopped',
            healthUrl: `http://127.0.0.1:${healthyRuntime.port}/health`,
        });

        const repairedConfigDir = path.join(instancesDir, 'repaired-config');
        const repairedConfigEnvFile = path.join(repairedConfigDir, '.env');
        writeJson(path.join(repairedConfigDir, 'instance.json'), {
            name: 'repaired-config',
            createdAt: now,
            port: 3093,
            envFile: path.join(root, 'old-root', 'instances', 'repaired-config', '.env'),
            instanceDir: path.join(root, 'old-root', 'instances', 'repaired-config'),
        });
        writeText(repairedConfigEnvFile, [
            'IRANTI_INSTANCE_NAME=repaired-config',
            'IRANTI_PORT=3093',
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_repaired_config',
            '',
        ].join('\n'));

        const invalidRuntimeFileDir = path.join(instancesDir, 'invalid-runtime-file');
        const invalidRuntimeEnvFile = path.join(invalidRuntimeFileDir, '.env');
        writeJson(path.join(invalidRuntimeFileDir, 'instance.json'), {
            name: 'invalid-runtime-file',
            createdAt: now,
            port: 3094,
            envFile: invalidRuntimeEnvFile,
            instanceDir: invalidRuntimeFileDir,
        });
        writeText(invalidRuntimeEnvFile, [
            'IRANTI_INSTANCE_NAME=invalid-runtime-file',
            'IRANTI_PORT=3094',
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_invalid_runtime_file',
            '',
        ].join('\n'));
        fs.writeFileSync(path.join(invalidRuntimeFileDir, 'runtime.json'), Buffer.alloc(64));

        const statusWithVariantsRun = runCli(['status', '--root', root, '--json'], ambientFreeCwd);
        assert.strictEqual(statusWithVariantsRun.status, 0, `status with variant instances failed:\n${statusWithVariantsRun.stdout}\n${statusWithVariantsRun.stderr}`);
        const statusWithVariants = JSON.parse(statusWithVariantsRun.stdout.trim()) as typeof statusPayload;
        const healthyStatus = statusWithVariants.instances.find((instance) => instance.name === 'healthy');
        const unhealthyStatus = statusWithVariants.instances.find((instance) => instance.name === 'unhealthy');
        const partialStatus = statusWithVariants.instances.find((instance) => instance.name === 'partial');
        const invalidStatus = statusWithVariants.instances.find((instance) => instance.name === 'invalid-config');
        const misownedConfigStatus = statusWithVariants.instances.find((instance) => instance.name === 'misowned-config');
        const misownedRuntimeStatus = statusWithVariants.instances.find((instance) => instance.name === 'misowned-runtime');
        const stoppedButAliveStatus = statusWithVariants.instances.find((instance) => instance.name === 'stopped-but-alive');
        const repairedConfigStatus = statusWithVariants.instances.find((instance) => instance.name === 'repaired-config');
        const invalidRuntimeFileStatus = statusWithVariants.instances.find((instance) => instance.name === 'invalid-runtime-file');
        assert.ok(healthyStatus, 'Expected healthy instance in status payload.');
        assert.ok(unhealthyStatus, 'Expected unhealthy instance in status payload.');
        assert.ok(partialStatus, 'Expected partial instance in status payload.');
        assert.ok(invalidStatus, 'Expected invalid-config instance in status payload.');
        assert.ok(misownedConfigStatus, 'Expected misowned-config instance in status payload.');
        assert.ok(misownedRuntimeStatus, 'Expected misowned-runtime instance in status payload.');
        assert.ok(stoppedButAliveStatus, 'Expected stopped-but-alive instance in status payload.');
        assert.ok(repairedConfigStatus, 'Expected repaired-config instance in status payload.');
        assert.ok(invalidRuntimeFileStatus, 'Expected invalid-runtime-file instance in status payload.');
        assert.strictEqual(healthyStatus?.runtime.classification, 'running');
        assert.strictEqual(healthyStatus?.runtime.health.ok, true);
        assert.strictEqual(unhealthyStatus?.runtime.classification, 'unhealthy');
        assert.strictEqual(unhealthyStatus?.runtime.running, false);
        assert.strictEqual(unhealthyStatus?.runtime.health.checked, true);
        assert.strictEqual(unhealthyStatus?.runtime.health.ok, false);
        assert.strictEqual(stoppedButAliveStatus?.runtime.classification, 'invalid');
        assert.match(stoppedButAliveStatus?.runtime.detail ?? '', /metadata says stopped but pid=.*alive/i);
        assert.strictEqual(partialStatus?.config.classification, 'partial');
        assert.strictEqual(invalidStatus?.config.classification, 'invalid');
        assert.strictEqual(misownedConfigStatus?.config.classification, 'invalid');
        assert.strictEqual(misownedRuntimeStatus?.runtime.classification, 'invalid');
        const repairedConfigSummary = repairedConfigStatus?.config as { classification?: string; detail?: string } | undefined;
        assert.strictEqual(repairedConfigSummary?.classification, 'complete');
        assert.match(repairedConfigSummary?.detail ?? '', /repaired/i);
        assert.strictEqual(invalidRuntimeFileStatus?.runtime.classification, 'missing');
        assert.ok((partialStatus?.repairHints ?? []).some((hint) => hint.includes('configure instance partial')), 'Expected partial instance repair hint.');
        assert.ok((unhealthyStatus?.repairHints ?? []).some((hint) => hint.includes('doctor --instance unhealthy')), 'Expected unhealthy instance repair hint.');
        assert.ok((misownedRuntimeStatus?.repairHints ?? []).some((hint) => hint.includes('runtime.json')), 'Expected invalid runtime repair hint.');
        assert.ok(statusWithVariants.recommendedActions.length >= 3, 'Expected aggregated recommended actions in status JSON.');

        const repairedConfigMeta = JSON.parse(fs.readFileSync(path.join(repairedConfigDir, 'instance.json'), 'utf8')) as { instanceDir: string; envFile: string };
        assert.strictEqual(repairedConfigMeta.instanceDir, repairedConfigDir);
        assert.strictEqual(repairedConfigMeta.envFile, repairedConfigEnvFile);

        const healthyInspection = await inspectRuntimeState(path.join(healthyDir, 'runtime.json'));
        assert.strictEqual(healthyInspection.classification, 'running');
        assert.strictEqual(healthyInspection.health.checked, true);
        assert.strictEqual(healthyInspection.health.ok, true);

        const unhealthyInspection = await inspectRuntimeState(path.join(unhealthyDir, 'runtime.json'));
        assert.strictEqual(unhealthyInspection.classification, 'unhealthy');
        assert.strictEqual(unhealthyInspection.health.checked, true);
        assert.strictEqual(unhealthyInspection.health.ok, false);

        const misownedInspection = await inspectRuntimeState(path.join(misownedRuntimeDir, 'runtime.json'));
        assert.strictEqual(misownedInspection.classification, 'invalid');
        assert.strictEqual(misownedInspection.health.checked, false);

        const invalidRuntimeInspection = await inspectRuntimeState(path.join(invalidRuntimeFileDir, 'runtime.json'));
        assert.strictEqual(invalidRuntimeInspection.classification, 'missing');
        assert.strictEqual(fs.existsSync(path.join(invalidRuntimeFileDir, 'runtime.json')), false);

        const runPartialRun = runCli(['run', '--instance', 'partial', '--root', root], ambientFreeCwd);
        assert.notStrictEqual(runPartialRun.status, 0, 'run unexpectedly accepted a partial instance');
        assert.match(
            `${runPartialRun.stdout}\n${runPartialRun.stderr}`,
            /instance 'partial' is partial/i,
            'run should reject incomplete instance configuration before reading env state'
        );

        const restartInvalidRun = runCli(['instance', 'restart', 'invalid-config', '--root', root], ambientFreeCwd);
        assert.notStrictEqual(restartInvalidRun.status, 0, 'restart unexpectedly accepted an invalid instance');
        assert.match(
            `${restartInvalidRun.stdout}\n${restartInvalidRun.stderr}`,
            /instance 'invalid-config' is invalid/i,
            'restart should reject invalid instance configuration before attempting lifecycle actions'
        );

        const runMisownedRun = runCli(['run', '--instance', 'misowned-config', '--root', root], ambientFreeCwd);
        assert.notStrictEqual(runMisownedRun.status, 0, 'run unexpectedly accepted a misowned instance');
        assert.match(
            `${runMisownedRun.stdout}\n${runMisownedRun.stderr}`,
            /instance 'misowned-config' is invalid/i,
            'run should reject misowned instance metadata before starting a process'
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
        ], ambientFreeCwd);
        assert.strictEqual(repairPartialRun.status, 0, `configure instance failed to repair partial config:\n${repairPartialRun.stdout}\n${repairPartialRun.stderr}`);
        const repairedPartialStatusRun = runCli(['status', '--root', root, '--json'], ambientFreeCwd);
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
            assert.strictEqual(runtimeEnvResult.authorityMode, 'instance-authoritative');
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
            assert.strictEqual(runtimeEnvResult.authorityMode, 'instance-authoritative');
            assert.strictEqual(process.env.DATABASE_URL, 'postgresql://postgres:postgres@localhost:5432/iranti_local');
            assert.strictEqual(process.env.LLM_PROVIDER, 'mock');
            assert.strictEqual(process.env.IRANTI_URL, 'http://localhost:3050');
            assert.strictEqual(process.env.IRANTI_API_KEY, 'project_key');
        });

        writeText(projectEnvFile, [
            'IRANTI_URL=http://localhost:3050',
            'IRANTI_API_KEY=project_key',
            `IRANTI_INSTANCE_ENV=${envFile}`,
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/project_override_should_not_win',
            'LLM_PROVIDER=openai',
            '',
        ].join('\n'));
        withCleanEnv(() => {
            const runtimeEnvResult = loadRuntimeEnv({ cwd: nestedProjectDir });
            assert.strictEqual(runtimeEnvResult.authorityMode, 'instance-authoritative');
            assert.strictEqual(process.env.DATABASE_URL, 'postgresql://postgres:postgres@localhost:5432/iranti_local');
            assert.strictEqual(process.env.LLM_PROVIDER, 'mock');
            assert.strictEqual(process.env.IRANTI_URL, 'http://localhost:3050');
        });

        const isolatedCwd = path.join(root, 'unbound_child');
        fs.mkdirSync(isolatedCwd, { recursive: true });
        withCleanEnv(() => {
            process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/environment_only_db';
            const runtimeEnvResult = loadRuntimeEnv({ cwd: isolatedCwd });
            assert.strictEqual(runtimeEnvResult.projectEnvFile, undefined, 'explicit cwd should not fall back to the ambient repo binding');
            assert.strictEqual(runtimeEnvResult.authorityMode, 'environment-only');
            assert.strictEqual(process.env.DATABASE_URL, 'postgresql://postgres:postgres@localhost:5432/environment_only_db');
        });

        // --project-env fix: explicit path that does not exist must throw, not silently fall back
        withCleanEnv(() => {
            const missingPath = path.join(root, 'nonexistent', '.env.iranti');
            assert.throws(
                () => loadRuntimeEnv({ projectEnvFile: missingPath }),
                (err: unknown) => err instanceof Error && err.message.includes('Project env file not found'),
                'Expected loadRuntimeEnv to throw when projectEnvFile option points to a missing file rather than silently falling back to ancestor discovery.'
            );
        });
        withCleanEnv(() => {
            process.env.IRANTI_PROJECT_ENV = path.join(root, 'nonexistent', '.env.iranti');
            assert.throws(
                () => loadRuntimeEnv({}),
                (err: unknown) => err instanceof Error && err.message.includes('Project env file not found'),
                'Expected loadRuntimeEnv to throw when IRANTI_PROJECT_ENV env var points to a missing file.'
            );
        });
        // Regression: no explicit path given → ambient ancestor discovery still proceeds without throwing
        withCleanEnv(() => {
            process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/no_explicit_env_db';
            const ambientResult = loadRuntimeEnv({ cwd: isolatedCwd });
            assert.strictEqual(ambientResult.projectEnvFile, undefined, 'Absent explicit path should still resolve without throwing.');
            assert.strictEqual(ambientResult.authorityMode, 'environment-only', 'Absent explicit path should still resolve without throwing — ambient discovery is the fallback.');
        });

        const explicitAuthority = resolveRuntimeAuthorityFromEnv({
            IRANTI_INSTANCE_DIR: instanceDir,
            IRANTI_INSTANCE_RUNTIME_FILE: runtimeFile,
        });
        assert.strictEqual(explicitAuthority.managed, true);
        assert.strictEqual(explicitAuthority.source, 'explicit');
        assert.strictEqual(explicitAuthority.instanceDir, instanceDir);
        assert.strictEqual(explicitAuthority.runtimeFile, runtimeFile);

        const derivedAuthority = resolveRuntimeAuthorityFromEnv({
            IRANTI_ESCALATION_DIR: path.join(instanceDir, 'escalation'),
        });
        assert.strictEqual(derivedAuthority.managed, true);
        assert.strictEqual(derivedAuthority.source, 'derived');
        assert.strictEqual(derivedAuthority.instanceDir, instanceDir);
        assert.strictEqual(derivedAuthority.runtimeFile, runtimeFile);

        const invalidAuthority = resolveRuntimeAuthorityFromEnv({
            IRANTI_INSTANCE_DIR: instanceDir,
            IRANTI_INSTANCE_RUNTIME_FILE: path.join(root, 'foreign', 'runtime.json'),
        });
        assert.strictEqual(invalidAuthority.managed, false);
        assert.strictEqual(invalidAuthority.source, 'invalid');

        const looseDerivedAuthority = resolveRuntimeAuthorityFromEnv({
            IRANTI_ESCALATION_DIR: path.join(instanceDir, 'not-escalation'),
            IRANTI_REQUEST_LOG_FILE: path.join(instanceDir, 'not-logs', 'api-requests.log'),
        });
        assert.strictEqual(looseDerivedAuthority.managed, false);
        assert.strictEqual(looseDerivedAuthority.source, 'adhoc');

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
            authority: {
                activeAuthority: string;
                activeBindingSource: string | null;
                activeBoundInstanceEnv: string | null;
                activeDatabaseUrl: string | null;
                activeDatabaseTarget: string | null;
                repoDatabaseUrl: string | null;
                repoDatabaseTarget: string | null;
                repoDatabaseDiffers: boolean;
            };
            discovery: {
                boundRuntimeRoot: string | null;
                rootMismatch: boolean;
                otherRuntimeRoots?: string[];
            };
        };
        assert.strictEqual(mismatchStatus.boundRuntimeRoot, isolatedRoot);
        assert.strictEqual(mismatchStatus.rootMismatch, true);
        assert.strictEqual(mismatchStatus.authority.activeAuthority, 'project binding -> bound instance env');
        assert.strictEqual(mismatchStatus.authority.activeBindingSource, projectEnvFile);
        assert.strictEqual(mismatchStatus.authority.activeBoundInstanceEnv, isolatedEnvFile);
        assert.strictEqual(mismatchStatus.authority.activeDatabaseUrl, 'postgresql://postgres:postgres@localhost:5432/iranti_isolated');
        assert.strictEqual(mismatchStatus.authority.activeDatabaseTarget, 'localhost:5432/iranti_isolated');
        assert.strictEqual(mismatchStatus.authority.repoDatabaseDiffers, false);
        assert.ok(mismatchStatus.otherRuntimeRoots.includes(isolatedRoot), 'Expected status JSON to report the alternate bound runtime root.');
        assert.strictEqual(mismatchStatus.discovery.boundRuntimeRoot, isolatedRoot);
        assert.strictEqual(mismatchStatus.discovery.rootMismatch, true);

        const mismatchDoctorRun = runCli(['doctor', '--root', root, '--json'], nestedProjectDir);
        assert.strictEqual(mismatchDoctorRun.status, 1, `doctor with bound-root mismatch should warn:\n${mismatchDoctorRun.stdout}\n${mismatchDoctorRun.stderr}`);
        const mismatchDoctor = JSON.parse(mismatchDoctorRun.stdout.trim()) as {
            selectedRuntimeRoot: string | null;
            selectedRuntimeRootSource: string | null;
            boundRuntimeRoot: string | null;
            boundInstanceEnv: string | null;
            rootMismatch: boolean;
            otherRuntimeRoots: string[];
            remediations: string[];
            checks: Array<{ name: string; status: string; detail: string }>;
            authority: {
                activeAuthority: string;
                activeBindingSource: string | null;
                activeBoundInstanceEnv: string | null;
                activeDatabaseUrl: string | null;
                activeDatabaseTarget: string | null;
                repoDatabaseUrl: string | null;
                repoDatabaseTarget: string | null;
                repoDatabaseDiffers: boolean;
            };
            discovery: {
                selectedRuntimeRoot: string | null;
                selectionSource: string | null;
                boundRuntimeRoot: string | null;
                projectBindingFile: string | null;
                projectBindingSource: string | null;
                rootMismatch: boolean;
                otherRuntimeRoots: string[];
            };
        };
        assert.strictEqual(mismatchDoctor.selectedRuntimeRoot, root);
        assert.strictEqual(mismatchDoctor.selectedRuntimeRootSource, 'flag');
        assert.strictEqual(mismatchDoctor.boundRuntimeRoot, isolatedRoot);
        assert.strictEqual(mismatchDoctor.boundInstanceEnv, isolatedEnvFile);
        assert.strictEqual(mismatchDoctor.rootMismatch, true);
        assert.strictEqual(mismatchDoctor.authority.activeAuthority, 'project binding -> bound instance env');
        assert.strictEqual(mismatchDoctor.authority.activeBindingSource, projectEnvFile);
        assert.strictEqual(mismatchDoctor.authority.activeBoundInstanceEnv, isolatedEnvFile);
        assert.strictEqual(mismatchDoctor.authority.activeDatabaseUrl, 'postgresql://postgres:postgres@localhost:5432/iranti_isolated');
        assert.strictEqual(mismatchDoctor.authority.activeDatabaseTarget, 'localhost:5432/iranti_isolated');
        assert.strictEqual(mismatchDoctor.authority.repoDatabaseDiffers, false);
        assert.ok(mismatchDoctor.otherRuntimeRoots.includes(isolatedRoot), 'Expected doctor JSON to report the alternate bound runtime root.');
        assert.strictEqual(mismatchDoctor.discovery.selectedRuntimeRoot, root);
        assert.strictEqual(mismatchDoctor.discovery.selectionSource, 'flag');
        assert.strictEqual(mismatchDoctor.discovery.boundRuntimeRoot, isolatedRoot);
        assert.strictEqual(mismatchDoctor.discovery.projectBindingFile, projectEnvFile);
        assert.strictEqual(mismatchDoctor.discovery.projectBindingSource, 'doctor-target');
        assert.strictEqual(mismatchDoctor.discovery.rootMismatch, true);
        const runtimeRootSelectionCheck = mismatchDoctor.checks.find((check) => check.name === 'runtime root selection');
        assert.ok(runtimeRootSelectionCheck, 'Expected doctor to emit a runtime root selection check for project bindings.');
        assert.strictEqual(runtimeRootSelectionCheck?.status, 'warn');
        assert.ok(runtimeRootSelectionCheck?.detail.includes(root), 'Expected doctor mismatch detail to mention the selected runtime root.');
        assert.ok(runtimeRootSelectionCheck?.detail.includes(isolatedRoot), 'Expected doctor mismatch detail to mention the bound runtime root.');
        assert.ok(
            mismatchDoctor.remediations.some((hint) => hint.includes('`iranti doctor` with `--root <runtime-root>`') || hint.includes('`iranti configure project`')),
            `Expected doctor remediations to explain how to resolve the runtime-root mismatch, got ${JSON.stringify(mismatchDoctor.remediations)}.`
        );

        const outerRepoEnvFile = path.join(root, '.env');
        writeText(outerRepoEnvFile, [
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_outer_repo_should_not_win',
            'LLM_PROVIDER=mock',
            'IRANTI_API_KEY=outer_repo_key',
            '',
        ].join('\n'));
        const statusAuthorityRun = runCli(['status', '--root', root, '--json'], nestedProjectDir);
        assert.strictEqual(statusAuthorityRun.status, 0, `status authority regression failed:\n${statusAuthorityRun.stdout}\n${statusAuthorityRun.stderr}`);
        const statusAuthority = JSON.parse(statusAuthorityRun.stdout.trim()) as {
            authority: {
                activeAuthority: string;
                activeBindingSource: string | null;
                activeBoundInstanceEnv: string | null;
                activeDatabaseUrl: string | null;
                activeDatabaseTarget: string | null;
                repoDatabaseUrl: string | null;
                repoDatabaseTarget: string | null;
                repoDatabaseDiffers: boolean;
            };
        };
        assert.strictEqual(statusAuthority.authority.activeAuthority, 'project binding -> bound instance env');
        assert.strictEqual(statusAuthority.authority.activeBindingSource, projectEnvFile);
        assert.strictEqual(statusAuthority.authority.activeBoundInstanceEnv, isolatedEnvFile);
        assert.strictEqual(statusAuthority.authority.activeDatabaseUrl, 'postgresql://postgres:postgres@localhost:5432/iranti_isolated');
        assert.strictEqual(statusAuthority.authority.activeDatabaseTarget, 'localhost:5432/iranti_isolated');
        assert.strictEqual(statusAuthority.authority.repoDatabaseUrl, 'postgresql://postgres:postgres@localhost:5432/iranti_outer_repo_should_not_win');
        assert.strictEqual(statusAuthority.authority.repoDatabaseTarget, 'localhost:5432/iranti_outer_repo_should_not_win');
        assert.strictEqual(statusAuthority.authority.repoDatabaseDiffers, true);

        const statusAuthorityTextRun = runCli(['status', '--root', root], nestedProjectDir);
        assert.strictEqual(statusAuthorityTextRun.status, 0, `status authority text regression failed:\n${statusAuthorityTextRun.stdout}\n${statusAuthorityTextRun.stderr}`);
        assert.ok(statusAuthorityTextRun.stdout.includes('authority'), 'Expected status text output to include the authority summary row.');
        assert.ok(statusAuthorityTextRun.stdout.includes('project binding -> bound instance env'), 'Expected status text output to show the binding authority chain.');
        assert.ok(statusAuthorityTextRun.stdout.includes('active_db_target'), 'Expected status text output to show the active database target row.');
        assert.ok(statusAuthorityTextRun.stdout.includes('localhost:5432/iranti_isolated'), 'Expected status text output to show the active bound database target.');
        assert.ok(statusAuthorityTextRun.stdout.includes('repo_db_target'), 'Expected status text output to show the differing repo database target row.');
        assert.ok(statusAuthorityTextRun.stdout.includes('localhost:5432/iranti_outer_repo_should_not_win'), 'Expected status text output to show the differing repo database target.');

        const nearestDoctorRun = runCli(['doctor', '--json'], nestedProjectDir);
        assert.strictEqual(nearestDoctorRun.status, 1, `doctor nearest-target regression failed:\n${nearestDoctorRun.stdout}\n${nearestDoctorRun.stderr}`);
        const nearestDoctor = JSON.parse(nearestDoctorRun.stdout.trim()) as {
            envSource: string;
            envFile: string | null;
            boundRuntimeRoot: string | null;
            authority: {
                activeAuthority: string;
                activeBindingSource: string | null;
                activeBoundInstanceEnv: string | null;
                activeDatabaseUrl: string | null;
                activeDatabaseTarget: string | null;
                repoDatabaseUrl: string | null;
                repoDatabaseTarget: string | null;
                repoDatabaseDiffers: boolean;
            };
            discovery: {
                projectBindingFile: string | null;
            };
        };
        assert.strictEqual(nearestDoctor.envSource, 'project-binding', 'Expected doctor to prefer the closer project binding over a farther repo env.');
        assert.strictEqual(nearestDoctor.envFile, projectEnvFile, 'Expected doctor to target the closer .env.iranti file.');
        assert.strictEqual(nearestDoctor.boundRuntimeRoot, isolatedRoot, 'Expected doctor to keep binding discovery when a farther repo env exists.');
        assert.strictEqual(nearestDoctor.authority.activeAuthority, 'project binding -> bound instance env');
        assert.strictEqual(nearestDoctor.authority.activeBindingSource, projectEnvFile);
        assert.strictEqual(nearestDoctor.authority.activeBoundInstanceEnv, isolatedEnvFile);
        assert.strictEqual(nearestDoctor.authority.activeDatabaseUrl, 'postgresql://postgres:postgres@localhost:5432/iranti_isolated');
        assert.strictEqual(nearestDoctor.authority.activeDatabaseTarget, 'localhost:5432/iranti_isolated');
        assert.strictEqual(nearestDoctor.authority.repoDatabaseUrl, 'postgresql://postgres:postgres@localhost:5432/iranti_outer_repo_should_not_win');
        assert.strictEqual(nearestDoctor.authority.repoDatabaseTarget, 'localhost:5432/iranti_outer_repo_should_not_win');
        assert.strictEqual(nearestDoctor.authority.repoDatabaseDiffers, true);
        assert.strictEqual(nearestDoctor.discovery.projectBindingFile, projectEnvFile);

        const siblingRepoEnvFile = path.join(projectDir, '.env');
        writeText(siblingRepoEnvFile, [
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/project_repo_doctor_target',
            'LLM_PROVIDER=mock',
            'IRANTI_API_KEY=project_repo_doctor_key',
            '',
        ].join('\n'));
        const siblingDoctorRun = runCli(['doctor', '--json', '--root', root], nestedProjectDir);
        assert.strictEqual(siblingDoctorRun.status, 1, `doctor sibling repo-env authority regression failed:\n${siblingDoctorRun.stdout}\n${siblingDoctorRun.stderr}`);
        const siblingDoctor = JSON.parse(siblingDoctorRun.stdout.trim()) as {
            envSource: string;
            envFile: string | null;
            authority: {
                activeAuthority: string;
                activeDatabaseUrl: string | null;
                activeDatabaseTarget: string | null;
                nearbyBindingSource: string | null;
                nearbyBoundInstanceEnv: string | null;
                nearbyBindingDatabaseUrl: string | null;
                nearbyBindingDatabaseTarget: string | null;
                nearbyBindingDiffers: boolean;
            };
            checks: Array<{ name: string; status: string; detail: string }>;
        };
        assert.strictEqual(siblingDoctor.envSource, 'repo', 'Expected sibling repo .env to win doctor target selection when both files exist in one directory.');
        assert.strictEqual(siblingDoctor.envFile, siblingRepoEnvFile);
        assert.strictEqual(siblingDoctor.authority.activeAuthority, 'repo env');
        assert.strictEqual(siblingDoctor.authority.activeDatabaseUrl, 'postgresql://postgres:postgres@localhost:5432/project_repo_doctor_target');
        assert.strictEqual(siblingDoctor.authority.activeDatabaseTarget, 'localhost:5432/project_repo_doctor_target');
        assert.strictEqual(siblingDoctor.authority.nearbyBindingSource, projectEnvFile);
        assert.strictEqual(siblingDoctor.authority.nearbyBoundInstanceEnv, isolatedEnvFile);
        assert.strictEqual(siblingDoctor.authority.nearbyBindingDatabaseUrl, 'postgresql://postgres:postgres@localhost:5432/iranti_isolated');
        assert.strictEqual(siblingDoctor.authority.nearbyBindingDatabaseTarget, 'localhost:5432/iranti_isolated');
        assert.strictEqual(siblingDoctor.authority.nearbyBindingDiffers, true);
        const nearbyBindingCheck = siblingDoctor.checks.find((check) => check.name === 'nearby project binding authority');
        assert.strictEqual(nearbyBindingCheck?.status, 'warn');
        assert.match(nearbyBindingCheck?.detail ?? '', /direct DB checks against repo \.env may miss facts stored in the bound instance DB/i);

        const doctorAuthorityTextRun = runCli(['doctor', '--root', root], nestedProjectDir);
        assert.strictEqual(doctorAuthorityTextRun.status, 1, `doctor authority text regression failed:\n${doctorAuthorityTextRun.stdout}\n${doctorAuthorityTextRun.stderr}`);
        assert.ok(doctorAuthorityTextRun.stdout.includes('authority : repo env'), 'Expected doctor text output to show repo env as the active authority when sibling .env wins selection.');
        assert.ok(doctorAuthorityTextRun.stdout.includes('active db : localhost:5432/project_repo_doctor_target'), 'Expected doctor text output to show the active repo database target.');
        assert.ok(doctorAuthorityTextRun.stdout.includes(`nearby binding : ${projectEnvFile}`), 'Expected doctor text output to surface the nearby project binding path.');
        assert.ok(doctorAuthorityTextRun.stdout.includes(`nearby bound env: ${isolatedEnvFile}`), 'Expected doctor text output to surface the nearby bound instance env.');
        assert.ok(doctorAuthorityTextRun.stdout.includes('nearby db : localhost:5432/iranti_isolated (binding differs)'), 'Expected doctor text output to show the nearby bound database target.');

        const prodMissingPepper = spawnSync(
            process.execPath,
            serverEntrypointArgs(),
            {
                cwd: ambientFreeCwd,
                encoding: 'utf8',
                env: buildTsNodeEnv({
                    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/iranti_runtime_guard',
                    NODE_ENV: 'production',
                    IRANTI_PORT: '3007',
                    NO_COLOR: '1',
                    IRANTI_API_KEY_PEPPER: '',
                    IRANTI_ALLOW_INSECURE_STARTUP: '',
                }),
            }
        );
        assert.notStrictEqual(prodMissingPepper.status, 0, 'server unexpectedly started in production without IRANTI_API_KEY_PEPPER');
        assert.match(
            `${prodMissingPepper.stdout}\n${prodMissingPepper.stderr}`,
            /IRANTI_API_KEY_PEPPER.*Refusing to start in production/i,
            'server should fail fast in production when API key pepper is missing'
        );

        const prodInvalidAuthority = spawnSync(
            process.execPath,
            serverEntrypointArgs(),
            {
                cwd: ambientFreeCwd,
                encoding: 'utf8',
                env: buildTsNodeEnv({
                    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/iranti_runtime_guard',
                    NODE_ENV: 'production',
                    IRANTI_PORT: '3008',
                    NO_COLOR: '1',
                    IRANTI_API_KEY_PEPPER: 'x'.repeat(32),
                    IRANTI_INSTANCE_DIR: instanceDir,
                    IRANTI_INSTANCE_RUNTIME_FILE: path.join(root, 'foreign', 'runtime.json'),
                }),
            }
        );
        assert.notStrictEqual(prodInvalidAuthority.status, 0, 'server unexpectedly started with invalid managed runtime authority');
        assert.match(
            `${prodInvalidAuthority.stdout}\n${prodInvalidAuthority.stderr}`,
            /managed runtime authority is invalid/i,
            'server should fail fast when managed runtime authority is invalid'
        );

        const doctorProdEnvFile = path.join(root, 'doctor-production.env');
        writeText(doctorProdEnvFile, [
            'NODE_ENV=production',
            'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:1/iranti_doctor_guard',
            'LLM_PROVIDER=mock',
            'IRANTI_API_KEY_PEPPER=',
            `IRANTI_INSTANCE_DIR=${instanceDir}`,
            `IRANTI_INSTANCE_RUNTIME_FILE=${path.join(root, 'foreign', 'runtime.json')}`,
            '',
        ].join('\n'));
        const doctorProdRun = runCli(['doctor', '--env', doctorProdEnvFile, '--json'], ambientFreeCwd);
        assert.notStrictEqual(doctorProdRun.status, 0, 'doctor should fail for production env with missing pepper and invalid runtime authority');
        const doctorProdPayload = JSON.parse(doctorProdRun.stdout.trim()) as {
            checks: Array<{ name: string; status: string; detail: string }>;
        };
        const startupSecurityCheck = doctorProdPayload.checks.find((check) => check.name === 'startup security');
        const runtimeAuthorityCheck = doctorProdPayload.checks.find((check) => check.name === 'runtime authority');
        assert.strictEqual(startupSecurityCheck?.status, 'fail');
        assert.match(startupSecurityCheck?.detail ?? '', /refuse to boot/i);
        assert.strictEqual(runtimeAuthorityCheck?.status, 'fail');
        assert.match(runtimeAuthorityCheck?.detail ?? '', /does not match/i);
        assert.strictEqual(
            resolvePackageRoot(path.join(repoRoot, 'src', 'api')),
            repoRoot,
            'Expected package root helper to resolve the repo root from the server source directory.'
        );
        assert.strictEqual(
            resolvePackageRoot(path.join(root, 'no-package-root', 'nested')),
            null,
            'Expected package root helper to return null when no package.json exists in range.'
        );
        const serverSource = fs.readFileSync(serverScript, 'utf8');
        assert.match(
            serverSource,
            /packageRoot:\s*resolvePackageRoot\(__dirname\)\s*\?\?\s*process\.cwd\(\)/,
            'Expected runtime metadata to record the serving package root instead of the detached process cwd.'
        );

        const publishedPorts = parsePublishedDockerHostPorts([
            '0.0.0.0:5435->5432/tcp, [::]:5435->5432/tcp',
            '127.0.0.1:5434->5432/tcp',
            '5432/tcp',
            'localhost:5440->5432/tcp',
        ].join('\n'));
        assert.deepStrictEqual(Array.from(publishedPorts).sort((a, b) => a - b), [5434, 5435, 5440]);

        const containerNames = parseDockerContainerNames('alpha\r\nbeta\n\n gamma \n');
        assert.deepStrictEqual(containerNames, ['alpha', 'beta', 'gamma']);

        const restartRun = runCli(['instance', 'restart', 'local', '--root', root], ambientFreeCwd);
        assert.notStrictEqual(restartRun.status, 0, 'restart unexpectedly succeeded');
        assert.match(
            `${restartRun.stdout}\n${restartRun.stderr}`,
            /not currently running/i,
            'restart should refuse to operate on a stopped/stale instance'
        );

        const createConflict = await listenOnRandomPort();
        openServers.push(createConflict.server);
        const createConflictRun = runCli(['instance', 'create', 'busy', '--port', String(createConflict.port), '--root', root], ambientFreeCwd);
        assert.notStrictEqual(createConflictRun.status, 0, 'instance create unexpectedly accepted an occupied port');
        assert.match(
            `${createConflictRun.stdout}\n${createConflictRun.stderr}`,
            /port .* already in use/i,
            'instance create should fail cleanly when the requested port is occupied'
        );
        assert.ok(!fs.existsSync(path.join(root, 'instances', 'busy', '.env')), 'failed create should not leave an instance env behind');

        const siblingDir = path.join(instancesDir, 'mini_app_olis');
        fs.mkdirSync(siblingDir, { recursive: true });
        const siblingCollisionRun = runCli(['instance', 'create', 'mini-app-olis', '--root', root], ambientFreeCwd);
        assert.notStrictEqual(siblingCollisionRun.status, 0, 'instance create unexpectedly accepted a sibling name collision');
        assert.match(
            `${siblingCollisionRun.stdout}\n${siblingCollisionRun.stderr}`,
            /too close to existing instance 'mini_app_olis'/i,
            'instance create should explain normalized sibling collisions'
        );
        assert.ok(
            !fs.existsSync(path.join(root, 'instances', 'mini-app-olis', '.env')),
            'sibling collision should not leave an instance env behind'
        );

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
        const configureConflictRun = runCli(['configure', 'instance', 'config-check', '--port', String(configConflict.port), '--root', root], ambientFreeCwd);
        assert.notStrictEqual(configureConflictRun.status, 0, 'configure instance unexpectedly accepted an occupied port');
        assert.match(
            `${configureConflictRun.stdout}\n${configureConflictRun.stderr}`,
            /port .* already in use/i,
            'configure instance should fail cleanly when the requested port is occupied'
        );

        const freePortServer = await listenOnRandomPort();
        const freePort = freePortServer.port;
        await new Promise<void>((resolve) => freePortServer.server.close(() => resolve()));
        const configureOkRun = runCli(['configure', 'instance', 'config-check', '--port', String(freePort), '--root', root], ambientFreeCwd);
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
        const runConflictRun = runCli(['run', '--instance', 'run-conflict', '--root', root], ambientFreeCwd);
        assert.notStrictEqual(runConflictRun.status, 0, 'run unexpectedly started on an occupied port');
        assert.match(
            `${runConflictRun.stdout}\n${runConflictRun.stderr}`,
            /port .* already in use/i,
            'run should fail cleanly before app.listen when the configured port is occupied'
        );

        const restartFailureRuntime = await startHealthServerProcess();
        cleanupCallbacks.push(() => terminateChildProcess(restartFailureRuntime.child));
        const restartFailureDir = path.join(instancesDir, 'restart-failure');
        const restartFailureEnvFile = path.join(restartFailureDir, '.env');
        const restartFailureRuntimeFile = path.join(restartFailureDir, 'runtime.json');
        writeJson(path.join(restartFailureDir, 'instance.json'), {
            name: 'restart-failure',
            createdAt: now,
            port: restartFailureRuntime.port,
            envFile: restartFailureEnvFile,
            instanceDir: restartFailureDir,
        });
        writeText(restartFailureEnvFile, [
            'IRANTI_INSTANCE_NAME=restart-failure',
            `IRANTI_PORT=${restartFailureRuntime.port}`,
            'LLM_PROVIDER=mock',
            `IRANTI_ESCALATION_DIR=${path.join(restartFailureDir, 'escalation')}`,
            `IRANTI_REQUEST_LOG_FILE=${path.join(restartFailureDir, 'logs', 'api-requests.log')}`,
            `IRANTI_API_KEY=test_${randomBytes(16).toString('hex')}`,
            '',
        ].join('\n'));
        writeJson(restartFailureRuntimeFile, {
            instanceName: 'restart-failure',
            instanceDir: restartFailureDir,
            envFile: restartFailureEnvFile,
            runtimeFile: restartFailureRuntimeFile,
            version: '0.2.15',
            pid: restartFailureRuntime.child.pid,
            ppid: process.pid,
            port: restartFailureRuntime.port,
            startedAt: now,
            lastHeartbeatAt: now,
            updatedAt: now,
            status: 'running',
            healthUrl: `http://127.0.0.1:${restartFailureRuntime.port}/health`,
        });
        const restartFailureRun = runCli(
            ['instance', 'restart', 'restart-failure', '--root', root],
            root,
            {
                DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/ambient_should_not_override_instance_env',
            },
        );
        assert.notStrictEqual(restartFailureRun.status, 0, 'restart unexpectedly reported success when the replacement runtime could not start');
        assert.match(
            `${restartFailureRun.stdout}\n${restartFailureRun.stderr}`,
            /did not become healthy|DATABASE_URL is missing|placeholder DATABASE_URL/i,
            'restart should surface replacement-startup failure instead of pretending it succeeded'
        );

        console.log('runtime lifecycle CLI smoke passed');
    } finally {
        for (const server of openServers) {
            try {
                await closeServer(server);
            } catch {
                // ignore test cleanup failures
            }
        }
        for (const cleanup of cleanupCallbacks) {
            try {
                await cleanup();
            } catch {
                // ignore test cleanup failures
            }
        }
        await terminateManagedRuntimeProcesses(root);
        await removeDirWithRetry(root);
        await removeDirWithRetry(ambientFreeCwd);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
