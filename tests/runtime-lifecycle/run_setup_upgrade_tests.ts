import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';

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

function readJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

async function reservePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('Failed to reserve a test port.');
    }
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

function readEnv(filePath: string): Record<string, string> {
    const env: Record<string, string> = {};
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const index = trimmed.indexOf('=');
        if (index <= 0) continue;
        env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
    }
    return env;
}

function parseJsonFromStdout(stdout: string): unknown {
    const trimmed = stdout.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart < 0) {
        throw new Error(`No JSON payload found in stdout:\n${stdout}`);
    }
    return JSON.parse(trimmed.slice(jsonStart));
}

function writeFakeCommand(binDir: string, name: string, toolScript: string): void {
    if (process.platform === 'win32') {
        writeText(path.join(binDir, `${name}.cmd`), `@echo off\r\nnode "${toolScript}" ${name} %*\r\n`);
        return;
    }
    const shellFile = path.join(binDir, name);
    writeText(shellFile, `#!/usr/bin/env bash\nnode "${toolScript}" ${name} "$@"\n`);
    fs.chmodSync(shellFile, 0o755);
}

async function main(): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-setup-upgrade-'));
    try {
        const installOnlyRoot = path.join(tempRoot, 'install-only-runtime');
        const installRun = runCli(['install', '--root', installOnlyRoot], repoRoot);
        assert.strictEqual(installRun.status, 0, `install failed:\n${installRun.stdout}\n${installRun.stderr}`);
        assert.ok(fs.existsSync(path.join(installOnlyRoot, 'install.json')), 'Expected install command to create install.json.');
        assert.ok(fs.existsSync(path.join(installOnlyRoot, 'instances')), 'Expected install command to create instances directory.');

        const runtimeRoot = path.join(tempRoot, 'runtime');
        const projectDir = path.join(tempRoot, 'project');
        const projectInitDir = path.join(tempRoot, 'project-init');
        const sharedRuntimeRoot = path.join(tempRoot, 'shared-runtime');
        const sharedProjectA = path.join(tempRoot, 'shared-project-a');
        const sharedProjectB = path.join(tempRoot, 'shared-project-b');
        const port = await reservePort();
        const sharedPort = await reservePort();
        const testApiKey = `test_${randomBytes(16).toString('hex')}`;
        const sharedApiKey = `test_${randomBytes(16).toString('hex')}`;

        const setupRun = runCli([
            'setup',
            '--defaults',
            '--mode',
            'isolated',
            '--root',
            runtimeRoot,
            '--instance',
            'local',
            '--port',
            String(port),
            '--db-mode',
            'managed',
            '--db-url',
            'postgresql://postgres:postgres@localhost:5432/iranti_setup_smoke',
            '--provider',
            'mock',
            '--api-key',
            testApiKey,
            '--projects',
            projectDir,
            '--auto-remember',
            '--claude-code',
        ], repoRoot);
        assert.strictEqual(setupRun.status, 0, `setup failed:\n${setupRun.stdout}\n${setupRun.stderr}`);
        assert.match(setupRun.stdout, /Dependency (preflight|check)/i, 'Expected setup to print dependency status before executing the plan.');

        const setupRepeatRun = runCli([
            'setup',
            '--defaults',
            '--mode',
            'isolated',
            '--root',
            runtimeRoot,
            '--instance',
            'local',
            '--port',
            String(port),
            '--db-mode',
            'managed',
            '--db-url',
            'postgresql://postgres:postgres@localhost:5432/iranti_setup_smoke',
            '--provider',
            'mock',
            '--api-key',
            testApiKey,
            '--projects',
            projectDir,
            '--auto-remember',
            '--claude-code',
        ], repoRoot);
        assert.strictEqual(setupRepeatRun.status, 0, `repeat setup failed:\n${setupRepeatRun.stdout}\n${setupRepeatRun.stderr}`);

        const installMetaPath = path.join(runtimeRoot, 'install.json');
        const instanceEnvPath = path.join(runtimeRoot, 'instances', 'local', '.env');
        const bindingFile = path.join(projectDir, '.env.iranti');
        const mcpFile = path.join(projectDir, '.mcp.json');
        const vscodeMcpFile = path.join(projectDir, '.vscode', 'mcp.json');
        const claudeSettingsFile = path.join(projectDir, '.claude', 'settings.local.json');

        assert.ok(fs.existsSync(installMetaPath), 'Expected setup to create install.json.');
        assert.ok(fs.existsSync(instanceEnvPath), 'Expected setup to create instance env.');
        assert.ok(fs.existsSync(bindingFile), 'Expected setup to create .env.iranti.');
        assert.ok(fs.existsSync(mcpFile), 'Expected setup to scaffold .mcp.json.');
        assert.ok(fs.existsSync(vscodeMcpFile), 'Expected setup to scaffold .vscode/mcp.json.');
        assert.ok(fs.existsSync(claudeSettingsFile), 'Expected setup to scaffold Claude settings.');

        const bindingEnv = readEnv(bindingFile);
        assert.strictEqual(bindingEnv.IRANTI_PROJECT_MODE, 'isolated');
        assert.strictEqual(bindingEnv.IRANTI_INSTANCE, 'local');
        assert.strictEqual(bindingEnv.IRANTI_INSTANCE_ENV, instanceEnvPath);
        assert.strictEqual(bindingEnv.IRANTI_API_KEY, testApiKey);
        assert.strictEqual(bindingEnv.IRANTI_PERSONAL_MEMORY_ENTITY, 'user/main');
        assert.strictEqual(bindingEnv.IRANTI_AUTO_REMEMBER, 'true');
        const mcpConfig = readJson<{
            mcpServers: {
                iranti: {
                    command: string;
                    args: string[];
                    env?: Record<string, string>;
                };
            };
        }>(mcpFile);
        assert.strictEqual(mcpConfig.mcpServers.iranti.command, 'iranti');
        assert.deepStrictEqual(mcpConfig.mcpServers.iranti.args, ['mcp']);
        assert.strictEqual(mcpConfig.mcpServers.iranti.env?.IRANTI_PROJECT_ENV, bindingFile, 'Expected scaffolded .mcp.json to pin the project binding');
        const vscodeMcpConfig = readJson<{
            servers: {
                iranti: {
                    type: string;
                    command: string;
                    args: string[];
                    envFile?: string;
                    env?: Record<string, string>;
                };
            };
        }>(vscodeMcpFile);
        assert.strictEqual(vscodeMcpConfig.servers.iranti.type, 'stdio');
        assert.strictEqual(vscodeMcpConfig.servers.iranti.command, 'iranti');
        assert.deepStrictEqual(vscodeMcpConfig.servers.iranti.args, ['mcp']);
        assert.strictEqual(vscodeMcpConfig.servers.iranti.envFile, '${workspaceFolder}/.env.iranti', 'Expected scaffolded .vscode/mcp.json to load the local binding via envFile');
        const claudeSettings = readJson<{ hooks?: Record<string, unknown>; permissions?: { allow?: string[] } }>(claudeSettingsFile);
        assert.ok(claudeSettings.hooks?.SessionStart, 'Expected scaffolded Claude settings to include SessionStart hook.');
        assert.ok(claudeSettings.hooks?.UserPromptSubmit, 'Expected scaffolded Claude settings to include UserPromptSubmit hook.');
        assert.ok(claudeSettings.hooks?.Stop, 'Expected scaffolded Claude settings to include Stop hook.');
        assert.ok(
            claudeSettings.permissions?.allow?.includes('mcp__iranti__iranti_checkpoint'),
            'Expected scaffolded Claude settings to allow iranti_checkpoint.',
        );
        assert.ok(
            claudeSettings.permissions?.allow?.includes('mcp__iranti__iranti_attend'),
            'Expected scaffolded Claude settings to allow iranti_attend.',
        );

        const localGuardRoot = path.join(tempRoot, 'local-guard-runtime');
        const localGuardPort = await reservePort();
        const localGuardRun = runCli([
            'setup',
            '--defaults',
            '--mode',
            'isolated',
            '--root',
            localGuardRoot,
            '--instance',
            'local_guard',
            '--port',
            String(localGuardPort),
            '--db-mode',
            'local',
            '--provider',
            'mock',
            '--api-key',
            `test_${randomBytes(16).toString('hex')}`,
        ], repoRoot, {
            DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/inherited_should_not_win',
        });
        assert.strictEqual(localGuardRun.status, 0, `local guard setup failed:\n${localGuardRun.stdout}\n${localGuardRun.stderr}`);
        const localGuardEnv = readEnv(path.join(localGuardRoot, 'instances', 'local_guard', '.env'));
        const expectedLocalGuardHost = process.platform === 'win32' ? '127.0.0.1' : 'localhost';
        assert.notStrictEqual(
            localGuardEnv.DATABASE_URL,
            'postgresql://postgres:postgres@localhost:5432/inherited_should_not_win',
            'Expected local setup to ignore the inherited DATABASE_URL from the parent shell.',
        );
        assert.match(
            localGuardEnv.DATABASE_URL,
            new RegExp(`^postgresql://postgres:[^@]+@${expectedLocalGuardHost.replace(/\./g, '\\.')}:5432/iranti_local_guard$`),
            'Expected local setup to generate an instance-specific DATABASE_URL with the platform-appropriate local host.',
        );

        const sharedSetupRun = runCli([
            'setup',
            '--defaults',
            '--mode',
            'shared',
            '--root',
            sharedRuntimeRoot,
            '--instance',
            'team',
            '--port',
            String(sharedPort),
            '--db-mode',
            'managed',
            '--db-url',
            'postgresql://postgres:postgres@localhost:5432/iranti_setup_shared',
            '--provider',
            'mock',
            '--api-key',
            sharedApiKey,
            '--projects',
            `${sharedProjectA},${sharedProjectB}`,
            '--claude-code',
        ], repoRoot);
        assert.strictEqual(sharedSetupRun.status, 0, `shared setup failed:\n${sharedSetupRun.stdout}\n${sharedSetupRun.stderr}`);

        const sharedInstanceEnvPath = path.join(sharedRuntimeRoot, 'instances', 'team', '.env');
        for (const projectPath of [sharedProjectA, sharedProjectB]) {
            const sharedBinding = readEnv(path.join(projectPath, '.env.iranti'));
            assert.strictEqual(sharedBinding.IRANTI_PROJECT_MODE, 'shared');
            assert.strictEqual(sharedBinding.IRANTI_INSTANCE, 'team');
            assert.strictEqual(sharedBinding.IRANTI_INSTANCE_ENV, sharedInstanceEnvPath);
            assert.strictEqual(sharedBinding.IRANTI_API_KEY, sharedApiKey);
            assert.strictEqual(sharedBinding.IRANTI_PERSONAL_MEMORY_ENTITY, 'user/main');
            assert.strictEqual(sharedBinding.IRANTI_AUTO_REMEMBER, 'false');
            assert.ok(fs.existsSync(path.join(projectPath, '.mcp.json')), 'Expected shared setup to scaffold .mcp.json for each bound project.');
            assert.ok(fs.existsSync(path.join(projectPath, '.vscode', 'mcp.json')), 'Expected shared setup to scaffold .vscode/mcp.json for each bound project.');
            assert.ok(fs.existsSync(path.join(projectPath, '.claude', 'settings.local.json')), 'Expected shared setup to scaffold Claude settings for each bound project.');
            const sharedMcp = readJson<{
                mcpServers: {
                    iranti: {
                        env?: Record<string, string>;
                    };
                };
            }>(path.join(projectPath, '.mcp.json'));
            assert.strictEqual(sharedMcp.mcpServers.iranti.env?.IRANTI_PROJECT_ENV, path.join(projectPath, '.env.iranti'), 'Expected shared scaffolding to pin each project binding in .mcp.json');
            const sharedVsCodeMcp = readJson<{
                servers: {
                    iranti: {
                        envFile?: string;
                    };
                };
            }>(path.join(projectPath, '.vscode', 'mcp.json'));
            assert.strictEqual(sharedVsCodeMcp.servers.iranti.envFile, '${workspaceFolder}/.env.iranti', 'Expected shared scaffolding to pin each project binding in .vscode/mcp.json');
            const sharedClaudeSettings = readJson<{ hooks?: Record<string, unknown>; permissions?: { allow?: string[] } }>(path.join(projectPath, '.claude', 'settings.local.json'));
            assert.ok(sharedClaudeSettings.hooks?.Stop, 'Expected shared Claude scaffolding to include Stop hook.');
            assert.ok(
                sharedClaudeSettings.permissions?.allow?.includes('mcp__iranti__iranti_checkpoint'),
                'Expected shared Claude scaffolding to allow iranti_checkpoint.',
            );
        }

        const projectInitRun = runCli([
            'project',
            'init',
            projectInitDir,
            '--instance',
            'local',
            '--root',
            runtimeRoot,
            '--scope',
            'user',
            '--auto-remember',
            'false',
        ], repoRoot);
        assert.strictEqual(projectInitRun.status, 0, `project init failed:\n${projectInitRun.stdout}\n${projectInitRun.stderr}`);
        const projectInitBinding = readEnv(path.join(projectInitDir, '.env.iranti'));
        assert.strictEqual(projectInitBinding.IRANTI_PERSONAL_MEMORY_ENTITY, 'user/main');
        assert.strictEqual(projectInitBinding.IRANTI_AUTO_REMEMBER, 'false');

        const configureProjectRun = runCli([
            'configure',
            'project',
            projectInitDir,
            '--root',
            runtimeRoot,
            '--auto-remember',
            'true',
        ], repoRoot);
        assert.strictEqual(configureProjectRun.status, 0, `configure project failed:\n${configureProjectRun.stdout}\n${configureProjectRun.stderr}`);
        const configuredProjectBinding = readEnv(path.join(projectInitDir, '.env.iranti'));
        assert.strictEqual(configuredProjectBinding.IRANTI_PERSONAL_MEMORY_ENTITY, 'user/main');
        assert.strictEqual(configuredProjectBinding.IRANTI_AUTO_REMEMBER, 'true');

        const projectsRegistryPath = path.join(runtimeRoot, 'instances', 'local', 'projects.json');
        writeJson(projectsRegistryPath, {
            projects: [
                {
                    projectPath: projectInitDir,
                    agentId: configuredProjectBinding.IRANTI_AGENT_ID,
                    memoryEntity: configuredProjectBinding.IRANTI_MEMORY_ENTITY,
                    mode: configuredProjectBinding.IRANTI_PROJECT_MODE,
                    boundAt: new Date().toISOString(),
                },
            ],
        });

        writeJson(path.join(projectInitDir, '.mcp.json'), {
            mcpServers: {
                iranti: {
                    command: 'iranti',
                    args: ['mcp'],
                },
            },
        });
        writeJson(path.join(projectInitDir, '.vscode', 'mcp.json'), {
            servers: {
                iranti: {
                    command: 'iranti',
                    envFile: '${workspaceFolder}/.env.iranti',
                },
                other: {
                    command: 'other-mcp',
                },
            },
        });
        writeJson(path.join(projectInitDir, '.claude', 'settings.local.json'), {
            hooks: {
                SessionStart: [
                    {
                        matcher: '*',
                        hooks: [
                            { type: 'command', command: 'iranti claude-hook session-start' },
                            { type: 'command', command: 'echo keep-me' },
                        ],
                    },
                ],
                Stop: [
                    {
                        hooks: [
                            { type: 'command', command: 'iranti claude-hook stop' },
                        ],
                    },
                ],
            },
        });

        const projectUnbindRun = runCli([
            'project',
            'unbind',
            projectInitDir,
            '--root',
            runtimeRoot,
            '--scope',
            'user',
            '--json',
        ], repoRoot);
        assert.strictEqual(projectUnbindRun.status, 0, `project unbind failed:\n${projectUnbindRun.stdout}\n${projectUnbindRun.stderr}`);
        const projectUnbindPayload = parseJsonFromStdout(projectUnbindRun.stdout) as {
            removedBinding: boolean;
            cleanedRegistryInstances: string[];
            keepIntegrations: boolean;
            integrationCleanup: {
                removed: string[];
                updated: string[];
            };
        };
        assert.strictEqual(projectUnbindPayload.removedBinding, true, 'Expected project unbind to remove the project binding.');
        assert.deepStrictEqual(projectUnbindPayload.cleanedRegistryInstances, ['local']);
        assert.strictEqual(projectUnbindPayload.keepIntegrations, false, 'Expected project unbind to clean local integrations by default.');
        assert.strictEqual(fs.existsSync(path.join(projectInitDir, '.env.iranti')), false, 'Expected project unbind to remove .env.iranti.');
        assert.strictEqual(fs.existsSync(path.join(projectInitDir, '.mcp.json')), false, 'Expected project unbind to remove a workspace MCP file that only referenced Iranti.');
        const vscodeMcpAfterUnbind = readJson<{ servers?: Record<string, { command?: string }> }>(path.join(projectInitDir, '.vscode', 'mcp.json'));
        assert.ok(!vscodeMcpAfterUnbind.servers?.iranti, 'Expected project unbind to remove the Iranti VS Code MCP server entry.');
        assert.strictEqual(vscodeMcpAfterUnbind.servers?.other?.command, 'other-mcp', 'Expected unrelated VS Code MCP servers to remain.');
        const claudeSettingsAfterUnbind = readJson<{ hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }>(path.join(projectInitDir, '.claude', 'settings.local.json'));
        const remainingSessionStart = claudeSettingsAfterUnbind.hooks?.SessionStart?.[0]?.hooks?.map((entry) => entry.command) ?? [];
        assert.deepStrictEqual(remainingSessionStart, ['echo keep-me'], 'Expected project unbind to remove only Iranti Claude hooks.');
        const registryAfterUnbind = readJson<{ projects: Array<{ projectPath: string }> }>(projectsRegistryPath);
        assert.deepStrictEqual(registryAfterUnbind.projects, [], 'Expected project unbind to remove the project from projects.json.');

        const statusRun = runCli(['status', '--root', runtimeRoot, '--json'], repoRoot);
        assert.strictEqual(statusRun.status, 0, `status failed after setup:\n${statusRun.stdout}\n${statusRun.stderr}`);
        const statusPayload = parseJsonFromStdout(statusRun.stdout) as {
            instances: Array<{
                name: string;
                config: { classification: string };
                runtime: { classification: string; running: boolean };
            }>;
        };
        const localInstance = statusPayload.instances.find((instance) => instance.name === 'local');
        assert.ok(localInstance, 'Expected setup-created instance in status output.');
        assert.strictEqual(localInstance?.config.classification, 'complete');
        assert.strictEqual(localInstance?.runtime.running, false);
        assert.ok(['missing', 'stopped'].includes(localInstance?.runtime.classification ?? ''), `Expected non-running setup instance, got ${localInstance?.runtime.classification}.`);

        const sharedStatusRun = runCli(['status', '--root', sharedRuntimeRoot, '--json'], repoRoot);
        assert.strictEqual(sharedStatusRun.status, 0, `status failed after shared setup:\n${sharedStatusRun.stdout}\n${sharedStatusRun.stderr}`);
        const sharedStatusPayload = parseJsonFromStdout(sharedStatusRun.stdout) as typeof statusPayload;
        const sharedInstance = sharedStatusPayload.instances.find((instance) => instance.name === 'team');
        assert.ok(sharedInstance, 'Expected shared setup-created instance in status output.');
        assert.strictEqual(sharedInstance?.config.classification, 'complete');
        assert.strictEqual(sharedInstance?.runtime.running, false);
        assert.ok(['missing', 'stopped'].includes(sharedInstance?.runtime.classification ?? ''), `Expected non-running shared setup instance, got ${sharedInstance?.runtime.classification}.`);

        const fakeStateFile = path.join(tempRoot, 'fake-upgrade-state.json');
        const fakeLogFile = path.join(tempRoot, 'fake-upgrade-log.ndjson');
        const fakeGlobalRoot = path.join(tempRoot, 'global-node');
        const fakeBinDir = path.join(tempRoot, 'bin');
        fs.mkdirSync(fakeBinDir, { recursive: true });
        writeJson(fakeStateFile, {
            globalRoot: fakeGlobalRoot,
            npmInstalled: true,
            npmVersion: '0.2.17',
            pythonInstalled: true,
            pythonVersion: '0.2.17',
            latestVersion: '0.2.25',
        });
        const fakeToolScript = path.join(fakeBinDir, 'fake-tool.js');
        writeText(fakeToolScript, `
const fs = require('fs');
const statePath = process.env.IRANTI_FAKE_STATE;
const logPath = process.env.IRANTI_FAKE_LOG;
const tool = process.argv[2];
const args = process.argv.slice(3);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
function persist() { fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n', 'utf8'); }
function log(entry) { fs.appendFileSync(logPath, JSON.stringify(entry) + '\\n', 'utf8'); }
if (tool === 'npm') {
  if (args[0] === 'root' && args[1] === '-g') { console.log(state.globalRoot); process.exit(0); }
  if (args[0] === 'list' && args[1] === '-g' && args[2] === 'iranti') {
    if (!state.npmInstalled) process.exit(1);
    console.log(JSON.stringify({ dependencies: { iranti: { version: state.npmVersion } } }));
    process.exit(0);
  }
  if (args[0] === 'install' && args[1] === '-g' && args[2] === 'iranti@latest') {
    state.npmInstalled = true; state.npmVersion = state.latestVersion; persist(); log({ tool, args }); process.exit(0);
  }
}
if (tool === 'python' || tool === 'python3' || tool === 'py') {
  if (args.join(' ') === '--version' || args.join(' ') === '-3 --version') { console.log('Python 3.14.0'); process.exit(0); }
  if (args.includes('show') && args.includes('iranti')) {
    if (!state.pythonInstalled) process.exit(1);
    console.log('Name: iranti\\nVersion: ' + state.pythonVersion);
    process.exit(0);
  }
  if (args.includes('install') && args.includes('--upgrade') && args.includes('iranti')) {
    state.pythonInstalled = true; state.pythonVersion = state.latestVersion; persist(); log({ tool, args }); process.exit(0);
  }
}
process.exit(1);
`.trim());
        for (const name of ['npm', 'python', 'python3', 'py']) {
            writeFakeCommand(fakeBinDir, name, fakeToolScript);
        }

        const upgradeEnv = {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
            IRANTI_FAKE_STATE: fakeStateFile,
            IRANTI_FAKE_LOG: fakeLogFile,
            IRANTI_TEST_TOOL_SHIM: fakeToolScript,
        };

        const upgradeRun = runCli([
            'upgrade',
            '--yes',
            '--target',
            'npm-global,python',
            '--json',
            '--root',
            runtimeRoot,
        ], repoRoot, upgradeEnv);
        assert.strictEqual(upgradeRun.status, 0, `upgrade execution failed:\n${upgradeRun.stdout}\n${upgradeRun.stderr}`);
        const upgradePayload = parseJsonFromStdout(upgradeRun.stdout) as {
            selectedTargets: string[];
            execution: Array<{ target: string; verification: { status: string } }>;
        };
        assert.deepStrictEqual(upgradePayload.selectedTargets, ['npm-global', 'python']);
        assert.strictEqual(upgradePayload.execution.length, 2, 'Expected upgrade execution results for npm-global and python.');
        assert.ok(upgradePayload.execution.every((result) => result.verification.status === 'pass'), `Expected pass verification for upgrade execution, got ${JSON.stringify(upgradePayload.execution)}.`);

        const installMeta = JSON.parse(fs.readFileSync(installMetaPath, 'utf8')) as { upgradedAt?: string };
        assert.ok(installMeta.upgradedAt, 'Expected install metadata to record upgradedAt after executable upgrade paths.');

        const inspectOnlyRestartRun = runCli([
            'upgrade',
            '--restart',
            '--instance',
            'local',
            '--json',
            '--root',
            runtimeRoot,
        ], repoRoot, upgradeEnv);
        assert.strictEqual(inspectOnlyRestartRun.status, 0, `upgrade inspect with restart failed:\n${inspectOnlyRestartRun.stdout}\n${inspectOnlyRestartRun.stderr}`);
        const inspectOnlyPayload = parseJsonFromStdout(inspectOnlyRestartRun.stdout) as {
            action: string;
            execution: Array<unknown>;
            restartSummary: unknown;
            note: string | null;
        };
        assert.strictEqual(inspectOnlyPayload.action, 'inspect');
        assert.strictEqual(inspectOnlyPayload.execution.length, 0);
        assert.strictEqual(inspectOnlyPayload.restartSummary, null);
        assert.match(inspectOnlyPayload.note ?? '', /--yes/i, 'Expected inspect-only upgrade to explain that --yes is required before restart executes.');

        const logLines = fs.readFileSync(fakeLogFile, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as { tool: string; args: string[] });
        assert.ok(logLines.some((entry) => entry.tool === 'npm' && entry.args.includes('install')), 'Expected npm global upgrade command to run.');
        assert.ok(logLines.some((entry) => (entry.tool === 'python' || entry.tool === 'python3' || entry.tool === 'py') && entry.args.includes('install')), 'Expected python upgrade command to run.');

        console.log('cli setup/upgrade smoke passed');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error('cli setup/upgrade smoke failed:', error);
    process.exit(1);
});
