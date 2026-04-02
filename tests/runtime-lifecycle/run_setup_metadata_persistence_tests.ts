import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type CliRun = {
    status: number | null;
    stdout: string;
    stderr: string;
};

const repoRoot = path.resolve(__dirname, '..', '..');
const cliScript = path.join(repoRoot, 'scripts', 'iranti-cli.ts');
const tsNodeRegister = require.resolve('ts-node/register');

function buildTsNodeEnv(extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
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

function runCli(args: string[], cwd: string, extraEnv: Record<string, string> = {}): CliRun {
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
        },
    );

    return {
        status: proc.status,
        stdout: proc.stdout ?? '',
        stderr: proc.stderr ?? '',
    };
}

function readJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath: string, value: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value, 'utf8');
}

function createFakeDockerHarness(tmpDir: string, portsOutput: string): string {
    const fakeBin = path.join(tmpDir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });

    const script = `
const args = process.argv.slice(2);
const portsOutput = process.env.IRANTI_FAKE_DOCKER_PORTS ?? '';

if (args[0] === '--version') {
  console.log('Docker version 26.1.0, build test');
  process.exit(0);
}
if (args[0] === 'info') {
  console.log('26.1.0');
  process.exit(0);
}
if (args[0] === 'ps' && args[1] === '--format') {
  console.log(portsOutput);
  process.exit(0);
}
console.error('Unsupported fake docker args: ' + args.join(' '));
process.exit(1);
`;

    writeText(path.join(fakeBin, 'fake-docker.js'), script);
    writeText(
        path.join(fakeBin, 'docker.cmd'),
        '@echo off\r\nnode "%~dp0fake-docker.js" %*\r\n',
    );

    return fakeBin;
}

async function withFakeDockerPorts<T>(portsOutput: string, run: () => Promise<T>): Promise<T> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-fake-docker-ports-'));
    const fakeBin = createFakeDockerHarness(tmpDir, portsOutput);
    const snapshotPath = process.env.PATH;
    const snapshotDockerPorts = process.env.IRANTI_FAKE_DOCKER_PORTS;
    const snapshotDockerBin = process.env.IRANTI_DOCKER_BIN;
    process.env.PATH = `${fakeBin};${snapshotPath ?? ''}`;
    process.env.IRANTI_FAKE_DOCKER_PORTS = portsOutput;
    process.env.IRANTI_DOCKER_BIN = path.join(fakeBin, 'docker.cmd');
    try {
        return await run();
    } finally {
        if (snapshotPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = snapshotPath;
        }
        if (snapshotDockerPorts === undefined) {
            delete process.env.IRANTI_FAKE_DOCKER_PORTS;
        } else {
            process.env.IRANTI_FAKE_DOCKER_PORTS = snapshotDockerPorts;
        }
        if (snapshotDockerBin === undefined) {
            delete process.env.IRANTI_DOCKER_BIN;
        } else {
            process.env.IRANTI_DOCKER_BIN = snapshotDockerBin;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

function readEnv(filePath: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx <= 0) continue;
        env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1).replace(/^"(.*)"$/, '$1');
    }
    return env;
}

function assertPepper(env: Record<string, string>, label: string): void {
    assert.match(
        env.IRANTI_API_KEY_PEPPER ?? '',
        /^[a-f0-9]{64}$/i,
        `${label} should persist a generated 64-char hex IRANTI_API_KEY_PEPPER`,
    );
}

async function main(): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-setup-meta-'));
    try {
        const setupRoot = path.join(tempRoot, 'setup-runtime');
        const projectDir = path.join(tempRoot, 'project');
        fs.mkdirSync(projectDir, { recursive: true });

        const setupRun = runCli([
            'setup',
            '--defaults',
            '--mode',
            'isolated',
            '--root',
            setupRoot,
            '--instance',
            'cofactor',
            '--port',
            '3550',
            '--db-mode',
            'managed',
            '--db-url',
            'postgresql://postgres:postgres@localhost:5432/iranti_cofactor',
            '--provider',
            'mock',
            '--api-key',
            'test_setup_key',
            '--projects',
            projectDir,
        ], repoRoot);
        assert.equal(setupRun.status, 0, `setup failed:\n${setupRun.stdout}\n${setupRun.stderr}`);

        const setupMeta = readJson<{
            port: number;
            databaseIntent?: {
                provisioning: string;
                port?: number;
            };
        }>(path.join(setupRoot, 'instances', 'cofactor', 'instance.json'));
        const setupEnv = readEnv(path.join(setupRoot, 'instances', 'cofactor', '.env'));
        assert.equal(setupMeta.port, 3550, 'setup should persist the actual runtime port into instance.json');
        assert.equal(setupEnv.IRANTI_PORT, '3550', 'setup should persist the actual runtime port into .env');
        assertPepper(setupEnv, 'setup');

        const dockerConfigRoot = path.join(tempRoot, 'docker-config-runtime');
        const dockerConfigPath = path.join(tempRoot, 'docker-config.json');
        writeText(dockerConfigPath, JSON.stringify({
            scope: 'user',
            root: dockerConfigRoot,
            instanceName: 'docker_case',
            port: 3660,
            databaseMode: 'docker',
            databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5440/iranti_docker_case',
            dockerContainerName: 'iranti_docker_case_db',
            provider: 'mock',
            apiKey: 'test_docker_key',
        }, null, 2));

        const dockerConfigRun = runCli(['setup', '--config', dockerConfigPath], repoRoot);
        assert.equal(dockerConfigRun.status, 0, `docker config setup failed:\n${dockerConfigRun.stdout}\n${dockerConfigRun.stderr}`);

        const dockerMeta = readJson<{
            port: number;
            databaseIntent?: {
                provisioning: string;
                port?: number;
                dockerContainerName?: string;
            };
            dependencies?: Array<{ kind: string; name: string; healthTcpPort?: number }>;
        }>(path.join(dockerConfigRoot, 'instances', 'docker_case', 'instance.json'));
        const dockerEnv = readEnv(path.join(dockerConfigRoot, 'instances', 'docker_case', '.env'));
        assert.equal(dockerMeta.port, 3660, 'docker setup should persist the actual runtime port into instance.json');
        assert.equal(dockerMeta.databaseIntent?.provisioning, 'docker', 'docker setup should persist provisioning=docker');
        assert.equal(dockerMeta.databaseIntent?.port, 5440, 'docker setup should persist the actual Docker host port');
        assert.equal(dockerMeta.databaseIntent?.dockerContainerName, 'iranti_docker_case_db', 'docker setup should persist the Docker container name');
        assert.deepEqual(dockerMeta.dependencies, [{
            kind: 'docker-container',
            name: 'iranti_docker_case_db',
            healthTcpPort: 5440,
        }], 'docker setup should persist the Docker dependency host port');
        assert.equal(dockerEnv.IRANTI_PORT, '3660', 'docker setup should persist the actual runtime port into .env');
        assertPepper(dockerEnv, 'docker setup');

        const dockerDefaultsRoot = path.join(tempRoot, 'docker-defaults-runtime');
        await withFakeDockerPorts('0.0.0.0:5432->5432/tcp', async () => {
            const dockerDefaultsRun = runCli([
                'setup',
                '--defaults',
                '--root',
                dockerDefaultsRoot,
                '--instance',
                'docker_defaults',
                '--port',
                '3665',
                '--db-mode',
                'docker',
                '--provider',
                'mock',
                '--api-key',
                'test_docker_defaults_key',
            ], repoRoot);
            assert.equal(dockerDefaultsRun.status, 0, `docker defaults setup failed:\n${dockerDefaultsRun.stdout}\n${dockerDefaultsRun.stderr}`);
        });

        const dockerDefaultsMeta = readJson<{
            databaseIntent?: {
                provisioning: string;
                port?: number;
            };
            dependencies?: Array<{ kind: string; name: string; healthTcpPort?: number }>;
        }>(path.join(dockerDefaultsRoot, 'instances', 'docker_defaults', 'instance.json'));
        const dockerDefaultsEnv = readEnv(path.join(dockerDefaultsRoot, 'instances', 'docker_defaults', '.env'));
        assert.equal(dockerDefaultsMeta.databaseIntent?.provisioning, 'docker', 'docker defaults setup should persist provisioning=docker');
        assert.notEqual(dockerDefaultsMeta.databaseIntent?.port, 5432, 'docker defaults setup should not bake in an occupied host port');
        assert.equal(
            dockerDefaultsMeta.dependencies?.[0]?.healthTcpPort,
            dockerDefaultsMeta.databaseIntent?.port,
            'docker defaults setup should align dependency and database host ports',
        );
        assert.match(
            dockerDefaultsEnv.DATABASE_URL ?? '',
            new RegExp(`:${dockerDefaultsMeta.databaseIntent?.port ?? 0}/iranti_docker_defaults$`),
            'docker defaults setup should persist the selected Docker host port into DATABASE_URL',
        );
        assertPepper(dockerDefaultsEnv, 'docker defaults setup');

        const createRoot = path.join(tempRoot, 'create-runtime');
        const installRun = runCli(['install', '--root', createRoot], repoRoot);
        assert.equal(installRun.status, 0, `install failed:\n${installRun.stdout}\n${installRun.stderr}`);

        const createRun = runCli([
            'instance',
            'create',
            'scout',
            '--root',
            createRoot,
            '--port',
            '3770',
            '--db-url',
            'postgresql://postgres:postgres@127.0.0.1:5441/iranti_scout',
            '--api-key',
            'test_create_key',
        ], repoRoot);
        assert.equal(createRun.status, 0, `instance create failed:\n${createRun.stdout}\n${createRun.stderr}`);

        const createMeta = readJson<{ port: number }>(path.join(createRoot, 'instances', 'scout', 'instance.json'));
        const createEnv = readEnv(path.join(createRoot, 'instances', 'scout', '.env'));
        assert.equal(createMeta.port, 3770, 'instance create should persist the actual runtime port into instance.json');
        assert.equal(createEnv.IRANTI_PORT, '3770', 'instance create should persist the actual runtime port into .env');
        assertPepper(createEnv, 'instance create');

        const repairRoot = path.join(tempRoot, 'repair-runtime');
        const repairInstanceDir = path.join(repairRoot, 'instances', 'legacy');
        const repairEnvFile = path.join(repairInstanceDir, '.env');
        writeJson(path.join(repairRoot, 'install.json'), {
            version: '0.2.51',
            scope: 'user',
            root: repairRoot,
            installedAt: new Date().toISOString(),
        });
        writeJson(path.join(repairInstanceDir, 'instance.json'), {
            name: 'legacy',
            createdAt: new Date().toISOString(),
            port: 3880,
            envFile: repairEnvFile,
            instanceDir: repairInstanceDir,
        });
        writeText(repairEnvFile, [
            'IRANTI_INSTANCE_NAME=legacy',
            'IRANTI_PORT=3880',
            'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5442/iranti_legacy',
            'LLM_PROVIDER=mock',
            'IRANTI_API_KEY=test_legacy_key',
            '',
        ].join('\n'));

        const repairRun = runCli([
            'configure',
            'instance',
            'legacy',
            '--root',
            repairRoot,
            '--port',
            '3880',
            '--json',
        ], repoRoot);
        assert.equal(repairRun.status, 0, `configure instance repair failed:\n${repairRun.stdout}\n${repairRun.stderr}`);
        assertPepper(readEnv(repairEnvFile), 'configure instance repair');

        console.log('setup metadata persistence tests passed');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error('setup metadata persistence tests failed:', error);
    process.exit(1);
});
