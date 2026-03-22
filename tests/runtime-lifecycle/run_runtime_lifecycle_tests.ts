import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { readInstanceRuntime } from '../../src/lib/runtimeLifecycle';
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

function main(): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-runtime-lifecycle-'));
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
            'IRANTI_API_KEY=test_api_key',
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

        const restartRun = runCli(['instance', 'restart', 'local', '--root', root], repoRoot);
        assert.notStrictEqual(restartRun.status, 0, 'restart unexpectedly succeeded');
        assert.match(
            `${restartRun.stdout}\n${restartRun.stderr}`,
            /not currently running/i,
            'restart should refuse to operate on a stopped/stale instance'
        );

        console.log('runtime lifecycle CLI smoke passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main();
