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

const repoRoot = path.resolve(__dirname, '..', '..');
const cliScript = path.join(repoRoot, 'scripts', 'iranti-cli.ts');

function runCli(args: string[], cwd: string, extraEnv: Record<string, string>): CliRun {
    const proc = spawnSync(
        process.execPath,
        ['-r', 'ts-node/register/transpile-only', cliScript, ...args],
        {
            cwd,
            encoding: 'utf8',
            env: {
                ...process.env,
                ...extraEnv,
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

function main(): void {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-uninstall-'));
    try {
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
            },
        });

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

        for (const name of ['npm', 'py', 'python', 'codex']) {
            writeFakeCommand(binDir, name, fakeToolScript);
        }

        const env = {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            IRANTI_FAKE_STATE: fakeStateFile,
            IRANTI_FAKE_LOG: fakeLogFile,
        };

        const dryRun = runCli([
            'uninstall',
            '--all',
            '--dry-run',
            '--json',
            '--root',
            runtimeRoot,
            '--scan-root',
            projectsRoot,
        ], repoRoot, env);
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
            runtimeRoot,
            '--scan-root',
            projectsRoot,
        ], repoRoot, env);
        assert.strictEqual(executeRun.status, 0, `execute failed:\n${executeRun.stdout}\n${executeRun.stderr}`);
        assert.strictEqual(fs.existsSync(runtimeRoot), false, 'runtime root should be removed');
        assert.strictEqual(fs.existsSync(bindingFile), false, 'project binding should be removed');

        const mcpPayload = JSON.parse(fs.readFileSync(mcpFile, 'utf8')) as { mcpServers?: Record<string, unknown> };
        assert.ok(mcpPayload.mcpServers?.other, 'non-Iranti MCP server should be preserved');
        assert.ok(!mcpPayload.mcpServers?.iranti, 'Iranti MCP server should be removed');

        const claudePayload = JSON.parse(fs.readFileSync(claudeSettingsFile, 'utf8')) as {
            theme?: string;
            hooks?: Record<string, unknown>;
        };
        assert.strictEqual(claudePayload.theme, 'test');
        assert.ok(!claudePayload.hooks?.UserPromptSubmit, 'Iranti-only hook block should be removed');
        const sessionStart = claudePayload.hooks?.SessionStart as Array<{ hooks?: Array<{ command?: string }> }> | undefined;
        assert.strictEqual(sessionStart?.[0]?.hooks?.length, 1);
        assert.strictEqual(sessionStart?.[0]?.hooks?.[0]?.command, 'other-hook --event SessionStart');

        const logLines = fs.readFileSync(fakeLogFile, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as { tool: string; args: string[] });
        assert.ok(logLines.some((entry) => entry.tool === 'npm' && entry.args.includes('uninstall')), 'npm uninstall should run');
        assert.ok(logLines.some((entry) => (entry.tool === 'py' || entry.tool === 'python') && entry.args.includes('uninstall')), 'python uninstall should run');
        assert.ok(logLines.some((entry) => entry.tool === 'codex' && entry.args.includes('remove')), 'codex remove should run');

        console.log('cli uninstall smoke passed');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main();
