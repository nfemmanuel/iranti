import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { ensureInstanceDependenciesHealthy, parseInstanceDependencies } from '../../src/lib/runtimeDependencies';

type CliRun = {
    status: number | null;
    stdout: string;
    stderr: string;
};

const repoRoot = path.resolve(__dirname, '..', '..');
const cliScript = path.join(repoRoot, 'scripts', 'iranti-cli.ts');
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

async function listenOnRandomPort(): Promise<{ server: net.Server; port: number }> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('Failed to allocate dependency test port.');
    }
    return { server, port: address.port };
}

async function closeServer(server: net.Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

function createFakeDockerHarness(tmpDir: string, state: Record<string, { running: boolean }>): { fakeBin: string; stateFile: string } {
    const fakeBin = path.join(tmpDir, 'fake-bin');
    const stateFile = path.join(tmpDir, 'docker-state.json');
    fs.mkdirSync(fakeBin, { recursive: true });
    writeJson(stateFile, { containers: state });

    const script = `
const fs = require('fs');
const stateFile = process.env.IRANTI_FAKE_DOCKER_STATE;
const args = process.argv.slice(2);
const load = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (state) => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

if (args[0] === '--version') {
  console.log('Docker version 26.1.0, build test');
  process.exit(0);
}
if (args[0] === 'info') {
  console.log('26.1.0');
  process.exit(0);
}
if (args[0] === 'ps' && args[1] === '-a') {
  const state = load();
  console.log(Object.keys(state.containers).join('\\n'));
  process.exit(0);
}
if (args[0] === 'inspect' && args[1] === '-f' && args[2] === '{{.State.Running}}') {
  const state = load();
  const name = args[3];
  if (!state.containers[name]) {
    console.error('No such container');
    process.exit(1);
  }
  console.log(state.containers[name].running ? 'true' : 'false');
  process.exit(0);
}
if (args[0] === 'start') {
  const state = load();
  const name = args[1];
  if (!state.containers[name]) {
    console.error('No such container');
    process.exit(1);
  }
  state.containers[name].running = true;
  save(state);
  console.log(name);
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

    return { fakeBin, stateFile };
}

async function withFakeDocker<T>(
    state: Record<string, { running: boolean }>,
    run: (fakeStateFile: string) => Promise<T>,
): Promise<T> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-fake-docker-'));
    const { fakeBin, stateFile } = createFakeDockerHarness(tmpDir, state);
    const snapshotPath = process.env.PATH;
    const snapshotState = process.env.IRANTI_FAKE_DOCKER_STATE;
    const snapshotDockerBin = process.env.IRANTI_DOCKER_BIN;
    process.env.PATH = `${fakeBin};${snapshotPath ?? ''}`;
    process.env.IRANTI_FAKE_DOCKER_STATE = stateFile;
    process.env.IRANTI_DOCKER_BIN = path.join(fakeBin, 'docker.cmd');
    try {
        return await run(stateFile);
    } finally {
        if (snapshotPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = snapshotPath;
        }
        if (snapshotState === undefined) {
            delete process.env.IRANTI_FAKE_DOCKER_STATE;
        } else {
            process.env.IRANTI_FAKE_DOCKER_STATE = snapshotState;
        }
        if (snapshotDockerBin === undefined) {
            delete process.env.IRANTI_DOCKER_BIN;
        } else {
            process.env.IRANTI_DOCKER_BIN = snapshotDockerBin;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    const parsed = parseInstanceDependencies([
        { kind: 'docker-container', name: 'iranti_dev_db', healthTcpPort: 5434 },
    ]);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.dependencies[0]?.name, 'iranti_dev_db');

    const invalid = parseInstanceDependencies([{ kind: 'docker-container', name: '', healthTcpPort: 'bad' }]);
    assert.ok(invalid.errors.length > 0, 'expected invalid dependency metadata to fail parsing');

    const { server, port } = await listenOnRandomPort();
    try {
        await withFakeDocker(
            { iranti_dev_db: { running: false } },
            async (stateFile) => {
                const result = await ensureInstanceDependenciesHealthy([
                    {
                        kind: 'docker-container',
                        name: 'iranti_dev_db',
                        healthTcpPort: port,
                    },
                ]);

                assert.deepEqual(result.started, ['iranti_dev_db']);
                assert.deepEqual(result.waitedTcpPorts, [port]);
                const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { containers: Record<string, { running: boolean }> };
                assert.equal(state.containers.iranti_dev_db.running, true, 'expected fake docker start to flip running state');
            }
        );
    } finally {
        await closeServer(server);
    }

    await withFakeDocker(
        { another_container: { running: false } },
        async () => {
            await assert.rejects(
                ensureInstanceDependenciesHealthy([{ kind: 'docker-container', name: 'missing_container' }]),
                /was not found/i,
            );
        }
    );

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-instance-config-'));
    try {
        const instanceDir = path.join(root, 'instances', 'local');
        const envFile = path.join(instanceDir, '.env');
        const metaFile = path.join(instanceDir, 'instance.json');
        writeJson(path.join(root, 'install.json'), {
            version: '0.2.43',
            scope: 'user',
            root,
            installedAt: new Date().toISOString(),
        });
        writeJson(metaFile, {
            name: 'local',
            createdAt: new Date().toISOString(),
            port: 3001,
            envFile,
            instanceDir,
        });
        writeText(envFile, [
            'IRANTI_INSTANCE_NAME=local',
            'IRANTI_PORT=3001',
            'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/iranti_local',
            'LLM_PROVIDER=mock',
            `IRANTI_ESCALATION_DIR=${path.join(instanceDir, 'escalation')}`,
            `IRANTI_REQUEST_LOG_FILE=${path.join(instanceDir, 'logs', 'api-requests.log')}`,
            'IRANTI_API_KEY=test_local',
            '',
        ].join('\n'));

        const configure = runCli(
            ['configure', 'instance', 'local', '--root', root, '--docker-container', 'iranti_dev_db', '--docker-health-port', '5434', '--db-intent', 'shared', '--json'],
            repoRoot,
        );
        assert.equal(configure.status, 0, `configure instance failed:\n${configure.stdout}\n${configure.stderr}`);

        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as {
            dependencies?: Array<{ kind: string; name: string; healthTcpPort?: number }>;
            databaseIntent?: {
                strategy: string;
                provisioning: string;
                host: string;
                port?: number;
                database: string;
                dockerContainerName?: string;
            };
        };
        assert.deepEqual(meta.dependencies, [
            {
                kind: 'docker-container',
                name: 'iranti_dev_db',
                healthTcpPort: 5434,
            },
        ]);
        assert.deepEqual(meta.databaseIntent, {
            strategy: 'shared-local',
            provisioning: 'docker',
            host: 'localhost',
            port: 5432,
            database: 'iranti_local',
            dockerContainerName: 'iranti_dev_db',
        });
        writeJson(path.join(root, 'instances', 'local', 'projects.json'), {
            projects: [
                {
                    projectPath: path.join(root, 'projects', 'control-plane'),
                    agentId: 'control_plane_main',
                    memoryEntity: 'project/iranti_control_plane',
                    mode: 'shared',
                    boundAt: new Date().toISOString(),
                },
            ],
        });

        const show = runCli(['instance', 'show', 'local', '--root', root], repoRoot);
        assert.equal(show.status, 0, `instance show failed:\n${show.stdout}\n${show.stderr}`);
        assert.match(show.stdout, /docker-container:iranti_dev_db -> tcp:5434/i);
        assert.match(show.stdout, /db strategy:\s+shared local database via docker -> localhost:5432\/iranti_local, container iranti_dev_db/i);
        assert.match(show.stdout, /projects:/i);
        assert.match(show.stdout, /control-plane/i);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    const setupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-setup-intent-'));
    try {
        const setup = runCli(
            [
                'setup',
                '--defaults',
                '--root',
                setupRoot,
                '--scope',
                'user',
                '--instance',
                'external_case',
                '--db-mode',
                'managed',
                '--db-url',
                'postgresql://postgres:postgres@db.example.com:5432/iranti_external_case',
                '--db-intent',
                'external',
                '--provider',
                'mock',
            ],
            repoRoot,
        );
        assert.equal(setup.status, 0, `setup --defaults failed:\n${setup.stdout}\n${setup.stderr}`);

        const setupMetaFile = path.join(setupRoot, 'instances', 'external_case', 'instance.json');
        const setupMeta = JSON.parse(fs.readFileSync(setupMetaFile, 'utf8')) as {
            databaseIntent?: {
                strategy: string;
                provisioning: string;
                host: string;
                port?: number;
                database: string;
            };
        };
        assert.deepEqual(setupMeta.databaseIntent, {
            strategy: 'external-existing',
            provisioning: 'managed',
            host: 'db.example.com',
            port: 5432,
            database: 'iranti_external_case',
        });
    } finally {
        fs.rmSync(setupRoot, { recursive: true, force: true });
    }

    console.log('instance dependency tests passed');
}

main().catch((error) => {
    console.error('instance dependency tests failed:', error);
    process.exit(1);
});
