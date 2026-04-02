import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';

type CliRun = {
    status: number | null;
    stdout: string;
    stderr: string;
};

type Fixture = {
    tempRoot: string;
    runtimeRoot: string;
    projectsRoot: string;
    bindingFile: string;
    mcpFile: string;
    claudeSettingsFile: string;
    agentsFile: string;
    fakeStateFile: string;
    fakeLogFile: string;
    env: Record<string, string>;
};

const repoRoot = path.resolve(__dirname, '..', '..');
const cliScript = path.join(repoRoot, 'scripts', 'iranti-cli.ts');
const tsNodeRegister = require.resolve('ts-node/register');

function buildTsNodeEnv(extraEnv: Record<string, string>): NodeJS.ProcessEnv {
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

function runCli(args: string[], cwd: string, extraEnv: Record<string, string>): CliRun {
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

function writeFakeCommand(binDir: string, name: string, toolScript: string): void {
    if (process.platform === 'win32') {
        const cmdFile = path.join(binDir, `${name}.cmd`);
        writeText(cmdFile, `@echo off\r\nnode "${toolScript}" ${name} %*\r\n`);
        return;
    }
    const shellFile = path.join(binDir, name);
    writeText(shellFile, `#!/usr/bin/env bash\nnode "${toolScript}" ${name} "$@"\n`);
    fs.chmodSync(shellFile, 0o755);
}

function buildFixture(): Fixture {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-uninstall-'));
    const runtimeRoot = path.join(tempRoot, 'runtime');
    const instanceDir = path.join(runtimeRoot, 'instances', 'local');
    const envFile = path.join(instanceDir, '.env');
    const now = new Date().toISOString();
    const testApiKey = `test_${randomBytes(16).toString('hex')}`;

    writeJson(path.join(runtimeRoot, 'install.json'), {
        version: '0.2.17',
        scope: 'user',
        root: runtimeRoot,
        installedAt: now,
    });
    writeJson(path.join(instanceDir, 'instance.json'), {
        name: 'local',
        createdAt: now,
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
        `IRANTI_API_KEY=${testApiKey}`,
        '',
    ].join('\n'));

    const projectsRoot = path.join(tempRoot, 'projects');
    const projectDir = path.join(projectsRoot, 'demo');
    const bindingFile = path.join(projectDir, '.env.iranti');
    const mcpFile = path.join(projectDir, '.mcp.json');
    const claudeSettingsFile = path.join(projectDir, '.claude', 'settings.local.json');
    const agentsFile = path.join(projectDir, 'AGENTS.md');

    writeText(bindingFile, [
        'IRANTI_URL=http://localhost:3001',
        `IRANTI_API_KEY=${testApiKey}`,
        'IRANTI_AGENT_ID=test_agent',
        `IRANTI_INSTANCE_ENV=${envFile}`,
        '',
    ].join('\n'));
    writeJson(mcpFile, {
        mcpServers: {
            iranti: { command: 'iranti', args: ['mcp'] },
            other: { command: 'other', args: ['mcp'] },
        },
    });
    writeJson(claudeSettingsFile, {
        theme: 'test',
        hooks: {
            SessionStart: [
                {
                    matcher: '',
                    hooks: [
                        { type: 'command', command: 'iranti claude-hook --event SessionStart' },
                        { type: 'command', command: 'other-hook --event SessionStart' },
                    ],
                },
            ],
            UserPromptSubmit: [
                {
                    matcher: '',
                    hooks: [
                        { type: 'command', command: 'iranti claude-hook --event UserPromptSubmit' },
                    ],
                },
            ],
            Stop: [
                {
                    matcher: '',
                    hooks: [
                        { type: 'command', command: 'iranti claude-hook --event Stop' },
                    ],
                },
            ],
        },
    });
    writeText(agentsFile, [
        '<!-- iranti-rules -->',
        '# Iranti MCP Protocol',
        '',
        'Codex scaffold block for uninstall coverage.',
        '<!-- /iranti-rules -->',
        '',
    ].join('\n'));

    const binDir = path.join(tempRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakeStateFile = path.join(tempRoot, 'fake-state.json');
    const fakeLogFile = path.join(tempRoot, 'fake-log.ndjson');
    const fakeGlobalRoot = path.join(tempRoot, 'global-node');
    writeJson(fakeStateFile, {
        globalRoot: fakeGlobalRoot,
        npmInstalled: true,
        npmVersion: '0.2.17',
        pythonInstalled: true,
        pythonVersion: '0.2.17',
        codexRegistered: true,
    });
    const fakeToolScript = path.join(binDir, 'fake-tool.js');
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
  if (args[0] === 'uninstall' && args[1] === '-g' && args[2] === 'iranti') {
    state.npmInstalled = false; persist(); log({ tool, args }); process.exit(0);
  }
}
if (tool === 'py' || tool === 'python' || tool === 'python3') {
  if (args.join(' ') === '--version' || args.join(' ') === '-3 --version') {
    console.log('Python 3.14.0');
    process.exit(0);
  }
  if (args.join(' ') === '-3 -m pip --version' || args.join(' ') === '-m pip --version') {
    console.log('pip 26.0 from fake');
    process.exit(0);
  }
  if (args.includes('show') && args.includes('iranti')) {
    if (!state.pythonInstalled) process.exit(1);
    console.log('Name: iranti\\nVersion: ' + state.pythonVersion);
    process.exit(0);
  }
  if (args.includes('uninstall') && args.includes('iranti')) {
    state.pythonInstalled = false; persist(); log({ tool, args }); process.exit(0);
  }
}
if (tool === 'codex') {
  if (args[0] === '--version') { console.log('codex 1.0.0'); process.exit(0); }
  if (args[0] === 'mcp' && args[1] === 'get' && args[2] === 'iranti') {
    if (!state.codexRegistered) process.exit(1);
    console.log(JSON.stringify({ name: 'iranti' }));
    process.exit(0);
  }
  if (args[0] === 'mcp' && args[1] === 'remove' && args[2] === 'iranti') {
    state.codexRegistered = false; persist(); log({ tool, args }); process.exit(0);
  }
}
process.exit(1);
`.trim());

    for (const name of ['npm', 'py', 'python', 'python3', 'codex']) {
        writeFakeCommand(binDir, name, fakeToolScript);
    }

    return {
        tempRoot,
        runtimeRoot,
        projectsRoot,
        bindingFile,
        mcpFile,
        claudeSettingsFile,
        agentsFile,
        fakeStateFile,
        fakeLogFile,
        env: {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            IRANTI_FAKE_STATE: fakeStateFile,
            IRANTI_FAKE_LOG: fakeLogFile,
            IRANTI_TEST_TOOL_SHIM: fakeToolScript,
        },
    };
}

function readLogLines(logFile: string): Array<{ tool: string; args: string[] }> {
    const raw = fs.readFileSync(logFile, 'utf8').trim();
    if (!raw) return [];
    return raw.split(/\r?\n/).map((line) => JSON.parse(line) as { tool: string; args: string[] });
}

function testConservativeUninstall(): void {
    const fixture = buildFixture();
    try {
        const executeRun = runCli([
            'uninstall',
            '--yes',
            '--json',
            '--root',
            fixture.runtimeRoot,
            '--scan-root',
            fixture.projectsRoot,
        ], repoRoot, fixture.env);
        assert.strictEqual(executeRun.status, 0, `conservative uninstall failed:\n${executeRun.stdout}\n${executeRun.stderr}`);
        const payload = JSON.parse(executeRun.stdout.trim()) as {
            actions: {
                removeGlobalNpm: boolean;
                removePython: boolean;
                removeProjectBindings: boolean;
                removeRuntimeRoots: boolean;
                removeCodexRegistration: boolean;
            };
            execution: Array<{ label: string; status: string }>;
        };
        assert.strictEqual(payload.actions.removeGlobalNpm, true);
        assert.strictEqual(payload.actions.removePython, true);
        assert.strictEqual(payload.actions.removeProjectBindings, false);
        assert.strictEqual(payload.actions.removeRuntimeRoots, false);
        assert.strictEqual(payload.actions.removeCodexRegistration, false);
        assert.ok(payload.execution.some((entry) => entry.label === 'npm uninstall' && entry.status === 'pass'));
        assert.ok(payload.execution.some((entry) => entry.label === 'python uninstall' && entry.status === 'pass'));

        assert.ok(fs.existsSync(fixture.runtimeRoot), 'runtime root should remain when --all is not used');
        assert.ok(fs.existsSync(fixture.bindingFile), 'project binding should remain when --all is not used');
        assert.ok(fs.existsSync(fixture.mcpFile), '.mcp.json should remain when --all is not used');
        assert.ok(fs.existsSync(fixture.claudeSettingsFile), 'Claude settings should remain when --all is not used');
        assert.ok(fs.existsSync(fixture.agentsFile), 'AGENTS.md should remain when --all is not used');

        const mcpPayload = JSON.parse(fs.readFileSync(fixture.mcpFile, 'utf8')) as { mcpServers?: Record<string, unknown> };
        assert.ok(mcpPayload.mcpServers?.iranti, 'Iranti MCP server should remain during conservative uninstall');
        const claudePayload = JSON.parse(fs.readFileSync(fixture.claudeSettingsFile, 'utf8')) as { hooks?: Record<string, unknown> };
        assert.ok(claudePayload.hooks?.UserPromptSubmit, 'Iranti Claude hooks should remain during conservative uninstall');
        assert.ok(claudePayload.hooks?.Stop, 'Iranti Claude Stop hook should remain during conservative uninstall');
        assert.match(fs.readFileSync(fixture.agentsFile, 'utf8'), /Codex scaffold block for uninstall coverage\./, 'AGENTS.md should remain during conservative uninstall.');

        const logLines = readLogLines(fixture.fakeLogFile);
        assert.ok(logLines.some((entry) => entry.tool === 'npm' && entry.args.includes('uninstall')), 'npm uninstall should run during conservative uninstall');
        assert.ok(logLines.some((entry) => (entry.tool === 'py' || entry.tool === 'python' || entry.tool === 'python3') && entry.args.includes('uninstall')), 'python uninstall should run during conservative uninstall');
        assert.ok(!logLines.some((entry) => entry.tool === 'codex' && entry.args.includes('remove')), 'codex registration should not be removed during conservative uninstall');
    } finally {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
}

function testFullUninstall(): void {
    const fixture = buildFixture();
    try {
        const dryRun = runCli([
            'uninstall',
            '--all',
            '--dry-run',
            '--json',
            '--root',
            fixture.runtimeRoot,
            '--scan-root',
            fixture.projectsRoot,
        ], repoRoot, fixture.env);
        assert.strictEqual(dryRun.status, 0, `dry-run failed:\n${dryRun.stdout}\n${dryRun.stderr}`);
        const dryPayload = JSON.parse(dryRun.stdout.trim()) as {
            actions: {
                removeGlobalNpm: boolean;
                removePython: boolean;
                removeProjectBindings: boolean;
                removeRuntimeRoots: boolean;
                removeCodexRegistration: boolean;
            };
            projectArtifacts: Array<unknown>;
            runtimeRoots: Array<unknown>;
        };
        assert.strictEqual(dryPayload.actions.removeGlobalNpm, true);
        assert.strictEqual(dryPayload.actions.removePython, true);
        assert.strictEqual(dryPayload.actions.removeProjectBindings, true);
        assert.strictEqual(dryPayload.actions.removeRuntimeRoots, true);
        assert.strictEqual(dryPayload.actions.removeCodexRegistration, true);
        assert.strictEqual(dryPayload.projectArtifacts.length, 1);
        assert.ok(dryPayload.runtimeRoots.length >= 1);

        const executeRun = runCli([
            'uninstall',
            '--all',
            '--yes',
            '--json',
            '--root',
            fixture.runtimeRoot,
            '--scan-root',
            fixture.projectsRoot,
        ], repoRoot, fixture.env);
        assert.strictEqual(executeRun.status, 0, `execute failed:\n${executeRun.stdout}\n${executeRun.stderr}`);
        assert.strictEqual(fs.existsSync(fixture.runtimeRoot), false, 'runtime root should be removed');
        assert.strictEqual(fs.existsSync(fixture.bindingFile), false, 'project binding should be removed');
        assert.strictEqual(fs.existsSync(fixture.agentsFile), false, 'AGENTS.md should be removed during full uninstall.');

        const mcpPayload = JSON.parse(fs.readFileSync(fixture.mcpFile, 'utf8')) as { mcpServers?: Record<string, unknown> };
        assert.ok(mcpPayload.mcpServers?.other, 'non-Iranti MCP server should be preserved');
        assert.ok(!mcpPayload.mcpServers?.iranti, 'Iranti MCP server should be removed');

        const claudePayload = JSON.parse(fs.readFileSync(fixture.claudeSettingsFile, 'utf8')) as {
            theme?: string;
            hooks?: Record<string, unknown>;
        };
        assert.strictEqual(claudePayload.theme, 'test');
        assert.ok(!claudePayload.hooks?.UserPromptSubmit, 'Iranti-only hook block should be removed');
        assert.ok(!claudePayload.hooks?.Stop, 'Iranti Stop hook block should be removed');
        const sessionStart = claudePayload.hooks?.SessionStart as Array<{ hooks?: Array<{ command?: string }> }> | undefined;
        assert.strictEqual(sessionStart?.[0]?.hooks?.length, 1);
        assert.strictEqual(sessionStart?.[0]?.hooks?.[0]?.command, 'other-hook --event SessionStart');

        const logLines = readLogLines(fixture.fakeLogFile);
        assert.ok(logLines.some((entry) => entry.tool === 'npm' && entry.args.includes('uninstall')), 'npm uninstall should run');
        assert.ok(logLines.some((entry) => (entry.tool === 'py' || entry.tool === 'python' || entry.tool === 'python3') && entry.args.includes('uninstall')), 'python uninstall should run');
        assert.ok(logLines.some((entry) => entry.tool === 'codex' && entry.args.includes('remove')), 'codex remove should run');
    } finally {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
}

function main(): void {
    testConservativeUninstall();
    testFullUninstall();
    console.log('cli uninstall smoke passed');
}

main();
