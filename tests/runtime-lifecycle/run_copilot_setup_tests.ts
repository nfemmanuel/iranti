import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '..', '..');
const copilotSetupScript = path.join(repoRoot, 'scripts', 'copilot-setup.ts');
const cliSourcePath = path.join(repoRoot, 'scripts', 'iranti-cli.ts');
const tsNodeRegister = require.resolve('ts-node/register');
const tsNodeTranspileOnlyRegister = require.resolve('ts-node/register/transpile-only');

function copilotSetupArgs(args: string[]): string[] {
    return ['-r', tsNodeRegister, copilotSetupScript, ...args];
}

function buildTsNodeEnv(extraEnv: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    return {
        ...process.env,
        ...extraEnv,
        TS_NODE_PROJECT: path.join(repoRoot, 'tsconfig.json'),
        TS_NODE_TRANSPILE_ONLY: 'true',
    };
}

type CommandResult = {
    status: number | null;
    stdout: string;
    stderr: string;
};

function runCopilotSetup(args: string[], options?: { cwd?: string; env?: Record<string, string | undefined> }): CommandResult {
    const proc = spawnSync(process.execPath, copilotSetupArgs(args), {
        cwd: options?.cwd ?? repoRoot,
        env: buildTsNodeEnv(options?.env),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
        status: proc.status,
        stdout: proc.stdout ?? '',
        stderr: proc.stderr ?? '',
    };
}

function runCli(args: string[], options?: { cwd?: string; env?: Record<string, string | undefined> }): CommandResult {
    const proc = spawnSync(process.execPath, ['-r', tsNodeTranspileOnlyRegister, cliSourcePath, ...args], {
        cwd: options?.cwd ?? repoRoot,
        env: buildTsNodeEnv(options?.env),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
        status: proc.status,
        stdout: proc.stdout ?? '',
        stderr: proc.stderr ?? '',
    };
}

// ── Test: copilot-setup creates workspace files ──────────────────────

async function testCopilotSetupWritesWorkspaceFiles(root: string): Promise<void> {
    const projectDir = path.join(root, 'workspace-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const projectEnv = path.join(projectDir, '.env.iranti');
    fs.writeFileSync(projectEnv, 'IRANTI_URL=http://localhost:3500\nIRANTI_API_KEY=test\n', 'utf8');

    // Redirect home dir so global config goes to temp
    const fakeHome = path.join(root, 'fake-home');
    fs.mkdirSync(fakeHome, { recursive: true });

    const result = runCopilotSetup(['--project-env', projectEnv], {
        cwd: projectDir,
        env: {
            USERPROFILE: fakeHome,
            HOME: fakeHome,
            NO_COLOR: '1',
        },
    });

    const stdout = result.stdout;
    const stderr = result.stderr;
    assert.strictEqual(result.status, 0, `copilot-setup should succeed:\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);

    // ── Global config: ~/.copilot/mcp-config.json ──
    const globalConfig = path.join(fakeHome, '.copilot', 'mcp-config.json');
    assert.ok(fs.existsSync(globalConfig), 'copilot-setup should create ~/.copilot/mcp-config.json');
    const globalMcp = JSON.parse(fs.readFileSync(globalConfig, 'utf8')) as {
        mcpServers?: Record<string, { type?: string; command?: string; args?: string[]; env?: Record<string, string> }>;
    };
    assert.ok(globalMcp.mcpServers?.iranti, 'global config should have an iranti server entry');
    assert.strictEqual(globalMcp.mcpServers.iranti.type, 'stdio', 'global config should use stdio transport');
    // Accepts both installed ('iranti mcp') and local build ('node /path/iranti-mcp.js') forms
    const isInstalledForm = globalMcp.mcpServers.iranti.command === 'iranti' &&
        Array.isArray(globalMcp.mcpServers.iranti.args) &&
        globalMcp.mcpServers.iranti.args[0] === 'mcp';
    const isLocalBuildForm = globalMcp.mcpServers.iranti.command === 'node' &&
        Array.isArray(globalMcp.mcpServers.iranti.args) &&
        globalMcp.mcpServers.iranti.args[0]?.includes('iranti-mcp');
    assert.ok(isInstalledForm || isLocalBuildForm, `global config should use installed or local-build form, got: ${JSON.stringify(globalMcp.mcpServers.iranti)}`);
    assert.strictEqual(globalMcp.mcpServers.iranti.env?.IRANTI_MCP_DEFAULT_AGENT, 'copilot_code', 'global config should set default Copilot agent');
    assert.strictEqual(globalMcp.mcpServers.iranti.env?.IRANTI_MCP_DEFAULT_SOURCE, 'Copilot', 'global config should set default Copilot source');
    assert.strictEqual(globalMcp.mcpServers.iranti.env?.IRANTI_MCP_HOST, 'copilot_cli', 'global config should set Copilot CLI host identity');
    assert.strictEqual(globalMcp.mcpServers.iranti.env?.IRANTI_PROJECT_ENV, projectEnv, 'global config should pin project env when --project-env is used');

    // ── Workspace .mcp.json ──
    const mcpFile = path.join(projectDir, '.mcp.json');
    assert.ok(fs.existsSync(mcpFile), 'copilot-setup should create .mcp.json in the bound workspace');
    const mcpConfig = JSON.parse(fs.readFileSync(mcpFile, 'utf8')) as {
        mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
    };
    assert.ok(mcpConfig.mcpServers?.iranti, 'workspace .mcp.json should have iranti entry');
    assert.strictEqual(mcpConfig.mcpServers.iranti.command, 'iranti', 'workspace .mcp.json should use the installed iranti command');
    assert.deepStrictEqual(mcpConfig.mcpServers.iranti.args, ['mcp'], 'workspace .mcp.json should register iranti mcp');
    assert.strictEqual(mcpConfig.mcpServers.iranti.env?.IRANTI_PROJECT_ENV, projectEnv, 'workspace .mcp.json should pin the local project binding');
    assert.strictEqual(mcpConfig.mcpServers.iranti.env?.IRANTI_MCP_DEFAULT_AGENT, 'copilot_code', 'workspace .mcp.json should carry the default Copilot agent');
    assert.strictEqual(mcpConfig.mcpServers.iranti.env?.IRANTI_MCP_DEFAULT_SOURCE, 'Copilot', 'workspace .mcp.json should carry the default Copilot source label');
    assert.strictEqual(mcpConfig.mcpServers.iranti.env?.IRANTI_MCP_HOST, 'copilot_cli', 'workspace .mcp.json should label the Copilot CLI host');

    // ── Workspace .vscode/mcp.json ──
    const vscodeMcpFile = path.join(projectDir, '.vscode', 'mcp.json');
    assert.ok(fs.existsSync(vscodeMcpFile), 'copilot-setup should create .vscode/mcp.json in the bound workspace');
    const vscodeMcpConfig = JSON.parse(fs.readFileSync(vscodeMcpFile, 'utf8')) as {
        servers?: Record<string, {
            type?: string;
            command?: string;
            args?: string[];
            envFile?: string;
            env?: Record<string, string>;
        }>;
    };
    assert.ok(vscodeMcpConfig.servers?.iranti, 'workspace .vscode/mcp.json should have iranti entry');
    assert.strictEqual(vscodeMcpConfig.servers.iranti.type, 'stdio', 'workspace .vscode/mcp.json should register a stdio server');
    assert.strictEqual(vscodeMcpConfig.servers.iranti.command, 'iranti', 'workspace .vscode/mcp.json should use the installed iranti command');
    assert.deepStrictEqual(vscodeMcpConfig.servers.iranti.args, ['mcp'], 'workspace .vscode/mcp.json should register iranti mcp');
    assert.strictEqual(vscodeMcpConfig.servers.iranti.envFile, '${workspaceFolder}/.env.iranti', 'workspace .vscode/mcp.json should load the project binding through envFile');
    assert.strictEqual(vscodeMcpConfig.servers.iranti.env?.IRANTI_MCP_DEFAULT_AGENT, 'copilot_code', 'workspace .vscode/mcp.json should carry the default Copilot agent');
    assert.strictEqual(vscodeMcpConfig.servers.iranti.env?.IRANTI_MCP_DEFAULT_SOURCE, 'Copilot', 'workspace .vscode/mcp.json should carry the default Copilot source label');
    assert.strictEqual(vscodeMcpConfig.servers.iranti.env?.IRANTI_MCP_HOST, 'copilot_vscode', 'workspace .vscode/mcp.json should label the Copilot VS Code host');

    // ── .github/copilot-instructions.md ──
    const instructionsFile = path.join(projectDir, '.github', 'copilot-instructions.md');
    assert.ok(fs.existsSync(instructionsFile), 'copilot-setup should create .github/copilot-instructions.md');
    const instructionsText = fs.readFileSync(instructionsFile, 'utf8');
    assert.match(instructionsText, /<!-- iranti-rules -->/, 'copilot-instructions.md should contain iranti-rules open tag');
    assert.match(instructionsText, /<!-- \/iranti-rules -->/, 'copilot-instructions.md should contain iranti-rules close tag');
    assert.match(instructionsText, /mcp__iranti__iranti_handshake/, 'copilot-instructions.md should require handshake');
    assert.match(instructionsText, /IRANTI\.md/, 'copilot-instructions.md should point to IRANTI.md');
    assert.match(instructionsText, /attend\/write\/checkpoint protocol/i, 'copilot-instructions.md should reference the attend/write/checkpoint protocol');

    // ── IRANTI.md ──
    const irantiMdFile = path.join(projectDir, 'IRANTI.md');
    assert.ok(fs.existsSync(irantiMdFile), 'copilot-setup should create IRANTI.md');
    const irantiMdText = fs.readFileSync(irantiMdFile, 'utf8');
    assert.match(irantiMdText, /Iranti Memory Protocol/i, 'IRANTI.md should contain the protocol heading');
    assert.match(irantiMdText, /iranti_attend.*pre-response/i, 'IRANTI.md should require pre-response attend');
    assert.match(irantiMdText, /iranti_write/i, 'IRANTI.md should require durable writes');
    assert.match(irantiMdText, /iranti_checkpoint/i, 'IRANTI.md should require checkpointing');

    // ── Console output ──
    assert.match(stdout, /Global Copilot MCP config: created/i, 'copilot-setup output should report global config created');
    assert.match(stdout, /GitHub Copilot CLI is now configured/i, 'copilot-setup output should confirm Copilot CLI configuration');
    assert.match(stdout, /Required host pattern:/i, 'copilot-setup output should print the required host pattern');
    assert.match(stdout, /Run iranti_handshake at session start/i, 'copilot-setup output should mention handshake at session start');
    assert.match(stdout, /Run iranti_checkpoint at natural pauses/i, 'copilot-setup output should mention checkpointing');
    assert.match(stdout, /Workspace \.mcp\.json:/i, 'copilot-setup output should report workspace .mcp.json status');
    assert.match(stdout, /Workspace \.vscode\/mcp\.json:/i, 'copilot-setup output should report workspace .vscode/mcp.json status');
    assert.match(stdout, /Workspace \.github\/copilot-instructions\.md:/i, 'copilot-setup output should report copilot-instructions.md status');
    assert.match(stdout, /Workspace IRANTI\.md:/i, 'copilot-setup output should report IRANTI.md status');
    assert.match(stdout, /Shared memory closeout: (written|skipped|failed)/i, 'copilot-setup output should report closeout status');
}

// ── Test: copilot-instructions.md appends to existing file ───────────

async function testCopilotInstructionsAppendsToExisting(root: string): Promise<void> {
    const projectDir = path.join(root, 'existing-instructions');
    const githubDir = path.join(projectDir, '.github');
    fs.mkdirSync(githubDir, { recursive: true });
    const projectEnv = path.join(projectDir, '.env.iranti');
    fs.writeFileSync(projectEnv, 'IRANTI_URL=http://localhost:3500\nIRANTI_API_KEY=test\n', 'utf8');

    // Pre-existing copilot-instructions.md without iranti block
    const existingContent = '# Project Rules\n\nAlways write tests for new features.\n';
    fs.writeFileSync(path.join(githubDir, 'copilot-instructions.md'), existingContent, 'utf8');

    const fakeHome = path.join(root, 'fake-home-append');
    fs.mkdirSync(fakeHome, { recursive: true });

    const result = runCopilotSetup(['--project-env', projectEnv], {
        cwd: projectDir,
        env: { USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' },
    });

    assert.strictEqual(result.status, 0, `copilot-setup should succeed when appending:\n${result.stdout}\n${result.stderr}`);

    const instructionsText = fs.readFileSync(path.join(githubDir, 'copilot-instructions.md'), 'utf8');
    assert.match(instructionsText, /# Project Rules/, 'existing content should be preserved');
    assert.match(instructionsText, /Always write tests/, 'existing content should be preserved');
    assert.match(instructionsText, /<!-- iranti-rules -->/, 'iranti block should be appended');
    assert.match(instructionsText, /mcp__iranti__iranti_handshake/, 'handshake reference should be present');

    // Existing content should appear before iranti block
    const existingIdx = instructionsText.indexOf('# Project Rules');
    const irantiIdx = instructionsText.indexOf('<!-- iranti-rules -->');
    assert.ok(existingIdx < irantiIdx, 'existing content should appear before the iranti block');
}

// ── Test: copilot-instructions.md updates existing iranti block ──────

async function testCopilotInstructionsUpdatesExistingBlock(root: string): Promise<void> {
    const projectDir = path.join(root, 'update-instructions');
    const githubDir = path.join(projectDir, '.github');
    fs.mkdirSync(githubDir, { recursive: true });
    const projectEnv = path.join(projectDir, '.env.iranti');
    fs.writeFileSync(projectEnv, 'IRANTI_URL=http://localhost:3500\nIRANTI_API_KEY=test\n', 'utf8');

    // Pre-existing file with an OLD iranti block
    const oldBlock = [
        '# Project Rules',
        '',
        '<!-- iranti-rules -->',
        '# Old Iranti',
        'This is an outdated block.',
        '<!-- /iranti-rules -->',
        '',
    ].join('\n');
    fs.writeFileSync(path.join(githubDir, 'copilot-instructions.md'), oldBlock, 'utf8');

    const fakeHome = path.join(root, 'fake-home-update');
    fs.mkdirSync(fakeHome, { recursive: true });

    const result = runCopilotSetup(['--project-env', projectEnv], {
        cwd: projectDir,
        env: { USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' },
    });

    assert.strictEqual(result.status, 0, `copilot-setup should succeed when updating block:\n${result.stdout}\n${result.stderr}`);

    const instructionsText = fs.readFileSync(path.join(githubDir, 'copilot-instructions.md'), 'utf8');
    assert.match(instructionsText, /# Project Rules/, 'content outside iranti block should be preserved');
    assert.ok(!instructionsText.includes('This is an outdated block'), 'old iranti block content should be replaced');
    assert.match(instructionsText, /mcp__iranti__iranti_handshake/, 'new iranti block should contain handshake');
    assert.match(instructionsText, /IRANTI\.md/, 'new iranti block should point to IRANTI.md');

    // Only one iranti block
    const openTags = instructionsText.match(/<!-- iranti-rules -->/g) ?? [];
    assert.strictEqual(openTags.length, 1, 'there should be exactly one iranti-rules block');
}

// ── Test: copilot-instructions.md unchanged when identical ───────────

async function testCopilotInstructionsUnchangedWhenIdentical(root: string): Promise<void> {
    const projectDir = path.join(root, 'unchanged-instructions');
    const githubDir = path.join(projectDir, '.github');
    fs.mkdirSync(githubDir, { recursive: true });
    const projectEnv = path.join(projectDir, '.env.iranti');
    fs.writeFileSync(projectEnv, 'IRANTI_URL=http://localhost:3500\nIRANTI_API_KEY=test\n', 'utf8');

    const fakeHome = path.join(root, 'fake-home-unchanged');
    fs.mkdirSync(fakeHome, { recursive: true });

    // First run: create the files
    const firstResult = runCopilotSetup(['--project-env', projectEnv], {
        cwd: projectDir,
        env: { USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' },
    });
    assert.strictEqual(firstResult.status, 0, `first copilot-setup should succeed:\n${firstResult.stdout}\n${firstResult.stderr}`);
    assert.match(firstResult.stdout, /copilot-instructions\.md: created/i, 'first run should report created');

    // Second run: should report unchanged
    const secondResult = runCopilotSetup(['--project-env', projectEnv], {
        cwd: projectDir,
        env: { USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' },
    });
    assert.strictEqual(secondResult.status, 0, `second copilot-setup should succeed:\n${secondResult.stdout}\n${secondResult.stderr}`);
    assert.match(secondResult.stdout, /copilot-instructions\.md: unchanged/i, 'second run should report unchanged');
    assert.match(secondResult.stdout, /Global Copilot MCP config: unchanged/i, 'second run should report global config unchanged');
}

// ── Test: global config merges without clobbering other servers ──────

async function testGlobalConfigPreservesOtherServers(root: string): Promise<void> {
    const projectDir = path.join(root, 'merge-global');
    fs.mkdirSync(projectDir, { recursive: true });
    const projectEnv = path.join(projectDir, '.env.iranti');
    fs.writeFileSync(projectEnv, 'IRANTI_URL=http://localhost:3500\nIRANTI_API_KEY=test\n', 'utf8');

    const fakeHome = path.join(root, 'fake-home-merge');
    const copilotDir = path.join(fakeHome, '.copilot');
    fs.mkdirSync(copilotDir, { recursive: true });

    // Pre-existing global config with another server
    const existingConfig = {
        mcpServers: {
            'other-tool': {
                type: 'stdio',
                command: 'other-tool',
                args: ['serve'],
            },
        },
    };
    fs.writeFileSync(path.join(copilotDir, 'mcp-config.json'), JSON.stringify(existingConfig, null, 2), 'utf8');

    const result = runCopilotSetup(['--project-env', projectEnv], {
        cwd: projectDir,
        env: { USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' },
    });

    assert.strictEqual(result.status, 0, `copilot-setup should succeed when merging:\n${result.stdout}\n${result.stderr}`);

    const globalMcp = JSON.parse(
        fs.readFileSync(path.join(copilotDir, 'mcp-config.json'), 'utf8'),
    ) as { mcpServers?: Record<string, unknown> };

    assert.ok(globalMcp.mcpServers?.iranti, 'iranti server should be added to global config');
    assert.ok(globalMcp.mcpServers?.['other-tool'], 'existing other-tool server should be preserved');
    assert.deepStrictEqual(
        (globalMcp.mcpServers['other-tool'] as { args?: string[] }).args,
        ['serve'],
        'other-tool server args should be preserved exactly',
    );
}

// ── Test: --no-workspace-file flag ──────────────────────────────────

async function testNoWorkspaceFileFlag(root: string): Promise<void> {
    const projectDir = path.join(root, 'no-workspace');
    fs.mkdirSync(projectDir, { recursive: true });
    const projectEnv = path.join(projectDir, '.env.iranti');
    fs.writeFileSync(projectEnv, 'IRANTI_URL=http://localhost:3500\nIRANTI_API_KEY=test\n', 'utf8');

    const fakeHome = path.join(root, 'fake-home-no-ws');
    fs.mkdirSync(fakeHome, { recursive: true });

    const result = runCopilotSetup(['--project-env', projectEnv, '--no-workspace-file'], {
        cwd: projectDir,
        env: { USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' },
    });

    assert.strictEqual(result.status, 0, `copilot-setup --no-workspace-file should succeed:\n${result.stdout}\n${result.stderr}`);

    // Global config should still be written
    const globalConfig = path.join(fakeHome, '.copilot', 'mcp-config.json');
    assert.ok(fs.existsSync(globalConfig), 'global config should still be written with --no-workspace-file');

    // Workspace files should NOT be written
    assert.ok(!fs.existsSync(path.join(projectDir, '.mcp.json')), '.mcp.json should not be created with --no-workspace-file');
    assert.ok(!fs.existsSync(path.join(projectDir, '.vscode', 'mcp.json')), '.vscode/mcp.json should not be created with --no-workspace-file');
    assert.ok(!fs.existsSync(path.join(projectDir, '.github', 'copilot-instructions.md')), 'copilot-instructions.md should not be created with --no-workspace-file');
    assert.ok(!fs.existsSync(path.join(projectDir, 'IRANTI.md')), 'IRANTI.md should not be created with --no-workspace-file');
}

// ── Test: custom --agent, --source, --provider flags ─────────────────

async function testCustomAgentSourceProvider(root: string): Promise<void> {
    const projectDir = path.join(root, 'custom-flags');
    fs.mkdirSync(projectDir, { recursive: true });
    const projectEnv = path.join(projectDir, '.env.iranti');
    fs.writeFileSync(projectEnv, 'IRANTI_URL=http://localhost:3500\nIRANTI_API_KEY=test\n', 'utf8');

    const fakeHome = path.join(root, 'fake-home-custom');
    fs.mkdirSync(fakeHome, { recursive: true });

    const result = runCopilotSetup([
        '--project-env', projectEnv,
        '--agent', 'my_custom_agent',
        '--source', 'MySource',
        '--provider', 'anthropic',
    ], {
        cwd: projectDir,
        env: { USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' },
    });

    assert.strictEqual(result.status, 0, `copilot-setup with custom flags should succeed:\n${result.stdout}\n${result.stderr}`);

    // Check global config
    const globalMcp = JSON.parse(
        fs.readFileSync(path.join(fakeHome, '.copilot', 'mcp-config.json'), 'utf8'),
    ) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
    assert.strictEqual(globalMcp.mcpServers?.iranti?.env?.IRANTI_MCP_DEFAULT_AGENT, 'my_custom_agent', 'global config should use custom agent');
    assert.strictEqual(globalMcp.mcpServers?.iranti?.env?.IRANTI_MCP_DEFAULT_SOURCE, 'MySource', 'global config should use custom source');
    assert.strictEqual(globalMcp.mcpServers?.iranti?.env?.LLM_PROVIDER, 'anthropic', 'global config should set custom provider');

    // Check workspace .mcp.json
    const mcpConfig = JSON.parse(
        fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'),
    ) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
    assert.strictEqual(mcpConfig.mcpServers?.iranti?.env?.IRANTI_MCP_DEFAULT_AGENT, 'my_custom_agent', 'workspace .mcp.json should use custom agent');
    assert.strictEqual(mcpConfig.mcpServers?.iranti?.env?.IRANTI_MCP_DEFAULT_SOURCE, 'MySource', 'workspace .mcp.json should use custom source');
    assert.strictEqual(mcpConfig.mcpServers?.iranti?.env?.LLM_PROVIDER, 'anthropic', 'workspace .mcp.json should set custom provider');
}

// ── Test: workspace .mcp.json merge preserves other servers ──────────

async function testWorkspaceMcpMerge(root: string): Promise<void> {
    const projectDir = path.join(root, 'merge-workspace');
    fs.mkdirSync(projectDir, { recursive: true });
    const projectEnv = path.join(projectDir, '.env.iranti');
    fs.writeFileSync(projectEnv, 'IRANTI_URL=http://localhost:3500\nIRANTI_API_KEY=test\n', 'utf8');

    // Pre-existing .mcp.json with another server
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify({
        mcpServers: {
            'database-tool': { command: 'db', args: ['serve'] },
        },
    }, null, 2), 'utf8');

    // Pre-existing .vscode/mcp.json with another server
    const vscodeDir = path.join(projectDir, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(path.join(vscodeDir, 'mcp.json'), JSON.stringify({
        servers: {
            'lint-tool': { type: 'stdio', command: 'lint', args: ['--fix'] },
        },
    }, null, 2), 'utf8');

    const fakeHome = path.join(root, 'fake-home-ws-merge');
    fs.mkdirSync(fakeHome, { recursive: true });

    const result = runCopilotSetup(['--project-env', projectEnv], {
        cwd: projectDir,
        env: { USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' },
    });

    assert.strictEqual(result.status, 0, `copilot-setup should succeed when merging workspace files:\n${result.stdout}\n${result.stderr}`);

    const mcpConfig = JSON.parse(
        fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'),
    ) as { mcpServers?: Record<string, unknown> };
    assert.ok(mcpConfig.mcpServers?.iranti, 'iranti should be added to workspace .mcp.json');
    assert.ok(mcpConfig.mcpServers?.['database-tool'], 'existing database-tool should be preserved in .mcp.json');

    const vscodeMcpConfig = JSON.parse(
        fs.readFileSync(path.join(vscodeDir, 'mcp.json'), 'utf8'),
    ) as { servers?: Record<string, unknown> };
    assert.ok(vscodeMcpConfig.servers?.iranti, 'iranti should be added to .vscode/mcp.json');
    assert.ok(vscodeMcpConfig.servers?.['lint-tool'], 'existing lint-tool should be preserved in .vscode/mcp.json');
}

// ── Test: copilot-setup --help works ─────────────────────────────────

async function testCopilotSetupHelp(): Promise<void> {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-copilot-help-'));
    try {
        const result = runCopilotSetup(['--help'], {
            env: { USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' },
        });
        assert.strictEqual(result.status, 0, `copilot-setup --help should succeed:\n${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /Configure GitHub Copilot CLI/i, 'help output should describe Copilot CLI configuration');
        assert.match(result.stdout, /\.copilot\/mcp-config\.json/i, 'help output should mention global config path');
        assert.match(result.stdout, /copilot-instructions\.md/i, 'help output should mention copilot-instructions.md');
        assert.match(result.stdout, /--project-env/, 'help output should document --project-env flag');
        assert.match(result.stdout, /--agent/, 'help output should document --agent flag');
        assert.match(result.stdout, /--source/, 'help output should document --source flag');
        assert.match(result.stdout, /--local-script/, 'help output should document --local-script flag');
        assert.match(result.stdout, /--no-workspace-file/, 'help output should document --no-workspace-file flag');
    } finally {
        fs.rmSync(fakeHome, { recursive: true, force: true });
    }
}

// ── Test: CLI routes copilot-setup and copilot-setup --help ──────────

async function testCliCopilotSetupHelp(): Promise<void> {
    const result = runCli(['copilot-setup', '--help']);
    assert.strictEqual(result.status, 0, `iranti copilot-setup --help should succeed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Configure GitHub Copilot CLI/i, 'CLI routed copilot-setup --help should show Copilot setup help');
}

// ── Test: CLI routes integrate copilot ───────────────────────────────

async function testCliIntegrateCopilotHelp(): Promise<void> {
    const result = runCli(['integrate', 'copilot', '--help']);
    assert.strictEqual(result.status, 0, `iranti integrate copilot --help should succeed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Configure GitHub Copilot CLI/i, 'CLI routed integrate copilot --help should show Copilot setup help');
}

// ── Test: iranti help includes copilot-setup ─────────────────────────

async function testHelpIncludesCopilotSetup(): Promise<void> {
    const result = runCli(['--help']);
    assert.strictEqual(result.status, 0, `iranti --help should succeed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /copilot-setup/i, 'iranti --help should mention copilot-setup');
}

// ── Test: integrate help lists copilot ───────────────────────────────

async function testIntegrateHelpListsCopilot(): Promise<void> {
    const result = runCli(['integrate', '--help']);
    assert.strictEqual(result.status, 0, `iranti integrate --help should succeed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /copilot/i, 'iranti integrate --help should list copilot as an integration');
}

// ── Test: copilot host identity differs from codex ───────────────────

async function testCopilotHostIdentityDiffersFromCodex(root: string): Promise<void> {
    const projectDir = path.join(root, 'host-identity');
    fs.mkdirSync(projectDir, { recursive: true });
    const projectEnv = path.join(projectDir, '.env.iranti');
    fs.writeFileSync(projectEnv, 'IRANTI_URL=http://localhost:3500\nIRANTI_API_KEY=test\n', 'utf8');

    const fakeHome = path.join(root, 'fake-home-identity');
    fs.mkdirSync(fakeHome, { recursive: true });

    const result = runCopilotSetup(['--project-env', projectEnv], {
        cwd: projectDir,
        env: { USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' },
    });

    assert.strictEqual(result.status, 0, `copilot-setup should succeed:\n${result.stdout}\n${result.stderr}`);

    // Verify Copilot-specific identities
    const mcpConfig = JSON.parse(
        fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'),
    ) as { mcpServers?: Record<string, { env?: Record<string, string> }> };

    // These must NOT be codex values
    assert.notStrictEqual(mcpConfig.mcpServers?.iranti?.env?.IRANTI_MCP_HOST, 'codex_cli', 'copilot workspace should NOT use codex_cli host');
    assert.notStrictEqual(mcpConfig.mcpServers?.iranti?.env?.IRANTI_MCP_DEFAULT_AGENT, 'codex_code', 'copilot workspace should NOT use codex_code agent');
    assert.notStrictEqual(mcpConfig.mcpServers?.iranti?.env?.IRANTI_MCP_DEFAULT_SOURCE, 'Codex', 'copilot workspace should NOT use Codex source');

    // These must be copilot values
    assert.strictEqual(mcpConfig.mcpServers?.iranti?.env?.IRANTI_MCP_HOST, 'copilot_cli', 'copilot workspace must use copilot_cli host');
    assert.strictEqual(mcpConfig.mcpServers?.iranti?.env?.IRANTI_MCP_DEFAULT_AGENT, 'copilot_code', 'copilot workspace must use copilot_code agent');
    assert.strictEqual(mcpConfig.mcpServers?.iranti?.env?.IRANTI_MCP_DEFAULT_SOURCE, 'Copilot', 'copilot workspace must use Copilot source');

    // .vscode config should use copilot_vscode (not codex_vscode)
    const vscodeMcpConfig = JSON.parse(
        fs.readFileSync(path.join(projectDir, '.vscode', 'mcp.json'), 'utf8'),
    ) as { servers?: Record<string, { env?: Record<string, string> }> };
    assert.strictEqual(vscodeMcpConfig.servers?.iranti?.env?.IRANTI_MCP_HOST, 'copilot_vscode', 'vscode config must use copilot_vscode host');
}

// ── Test: unknown argument fails ─────────────────────────────────────

async function testUnknownArgumentFails(): Promise<void> {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-copilot-unk-'));
    try {
        const result = runCopilotSetup(['--banana'], {
            env: { USERPROFILE: fakeHome, HOME: fakeHome, NO_COLOR: '1' },
        });
        assert.notStrictEqual(result.status, 0, 'copilot-setup should fail on unknown arguments');
        assert.match(result.stderr, /Unknown argument.*--banana/i, 'error should mention the unknown argument');
    } finally {
        fs.rmSync(fakeHome, { recursive: true, force: true });
    }
}

// ── Test: scaffoldCloseout type union includes copilot ───────────────

async function testScaffoldCloseoutCopilotType(): Promise<void> {
    // Import the scaffoldCloseout module and verify it accepts 'copilot' as a tool.
    // We can't actually write to the database here, but we can verify the function
    // handles the 'copilot' tool without throwing a type error by calling it with
    // a missing env file (should return skipped).
    const { writeProjectScaffoldCloseout } = require('../../src/lib/scaffoldCloseout') as {
        writeProjectScaffoldCloseout: (input: {
            tool: 'claude' | 'codex' | 'copilot';
            projectPath: string;
            projectEnvFile?: string | null;
            files: Array<{ path: string; status: 'created' | 'updated' | 'unchanged' }>;
            agentId?: string;
        }) => Promise<{ status: string; detail: string; entity: string | null; key: string | null; sessionId: string | null }>;
    };

    // With no projectEnvFile, should return 'skipped' — but importantly, it should
    // accept 'copilot' as a tool value without error.
    const result = await writeProjectScaffoldCloseout({
        tool: 'copilot',
        projectPath: '/tmp/nonexistent',
        projectEnvFile: null,
        files: [],
    });

    assert.strictEqual(result.status, 'skipped', 'scaffoldCloseout should handle copilot tool type and return skipped for null env');

    // With a non-existent env file, should also return 'skipped'
    const result2 = await writeProjectScaffoldCloseout({
        tool: 'copilot',
        projectPath: '/tmp/nonexistent',
        projectEnvFile: '/tmp/definitely-not-a-file.env',
        files: [{ path: '/tmp/test.json', status: 'created' }],
    });

    assert.strictEqual(result2.status, 'skipped', 'scaffoldCloseout should skip when project env file does not exist');
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-copilot-setup-'));
    try {
        console.log('running copilot-setup tests...');

        await testCopilotSetupHelp();
        console.log('  copilot-setup --help: passed');

        await testCliCopilotSetupHelp();
        console.log('  CLI copilot-setup --help: passed');

        await testCliIntegrateCopilotHelp();
        console.log('  CLI integrate copilot --help: passed');

        await testHelpIncludesCopilotSetup();
        console.log('  iranti --help includes copilot-setup: passed');

        await testIntegrateHelpListsCopilot();
        console.log('  integrate --help lists copilot: passed');

        await testUnknownArgumentFails();
        console.log('  unknown argument fails: passed');

        await testScaffoldCloseoutCopilotType();
        console.log('  scaffoldCloseout copilot type: passed');

        await testCopilotSetupWritesWorkspaceFiles(root);
        console.log('  workspace files creation: passed');

        await testCopilotInstructionsAppendsToExisting(root);
        console.log('  copilot-instructions.md append: passed');

        await testCopilotInstructionsUpdatesExistingBlock(root);
        console.log('  copilot-instructions.md update existing block: passed');

        await testCopilotInstructionsUnchangedWhenIdentical(root);
        console.log('  copilot-instructions.md unchanged on re-run: passed');

        await testGlobalConfigPreservesOtherServers(root);
        console.log('  global config merge preserves other servers: passed');

        await testNoWorkspaceFileFlag(root);
        console.log('  --no-workspace-file flag: passed');

        await testCustomAgentSourceProvider(root);
        console.log('  custom --agent, --source, --provider: passed');

        await testWorkspaceMcpMerge(root);
        console.log('  workspace .mcp.json and .vscode/mcp.json merge: passed');

        await testCopilotHostIdentityDiffersFromCodex(root);
        console.log('  copilot host identity differs from codex: passed');

        console.log('copilot-setup tests passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
