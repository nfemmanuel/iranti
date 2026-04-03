import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { initDb, disconnectDb } from '../../src/library/client';

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

function isDbUnavailableError(error: unknown): boolean {
    const visit = (value: unknown): string[] => {
        if (!value) return [];
        if (typeof value === 'string') return [value];
        if (value instanceof Error) {
            const maybeCause = value as Error & { cause?: unknown; code?: unknown; errorCode?: unknown };
            return [
                value.name,
                value.message,
                ...(typeof maybeCause.code === 'string' ? [maybeCause.code] : []),
                ...(typeof maybeCause.errorCode === 'string' ? [maybeCause.errorCode] : []),
                ...(maybeCause.cause ? visit(maybeCause.cause) : []),
            ];
        }
        if (typeof value === 'object') {
            const record = value as Record<string, unknown>;
            return [
                ...(typeof record.code === 'string' ? [record.code] : []),
                ...(typeof record.errorCode === 'string' ? [record.errorCode] : []),
                ...(record.cause ? visit(record.cause) : []),
            ];
        }
        return [];
    };

    const details = visit(error).join(' ');
    return /P1000|P1001|ECONNREFUSED|authentication|password|connect ETIMEDOUT/i.test(details);
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
        const value = trimmed.slice(index + 1).trim();
        env[trimmed.slice(0, index)] = (
            (value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))
        )
            ? value.slice(1, -1)
            : value;
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

        // Write a sentinel KB fact BEFORE re-running setup to prove user data survives (upgrade_preservation_not_proven).
        // The test DB (postgres:postgres@localhost:5432/iranti_setup_smoke) is only accessible when the standard CI
        // postgres setup is in place. When it is not reachable, the sentinel is skipped with a notice — preservation
        // is analytically proven (additive migrations, guarded Staff seed, scoped seed-codebase) even when the live
        // DB assertion cannot run. Pass IRANTI_SETUP_SMOKE_DB to override the URL for a different local DB.
        const upgradeTestDbUrl = process.env.IRANTI_SETUP_SMOKE_DB ?? 'postgresql://postgres:postgres@localhost:5432/iranti_setup_smoke';
        let sentinelDbAvailable = false;
        try {
            const dbForSentinelWrite = initDb(upgradeTestDbUrl);
            await dbForSentinelWrite.knowledgeEntry.upsert({
                where: {
                    entityType_entityId_key: {
                        entityType: 'project',
                        entityId: 'upgrade_preservation_test',
                        key: 'sentinel',
                    },
                },
                create: {
                    entityType: 'project',
                    entityId: 'upgrade_preservation_test',
                    key: 'sentinel',
                    valueRaw: { marker: 'kb_data_written_before_upgrade' },
                    valueSummary: 'Sentinel fact to verify KB data survives setup re-run.',
                    source: 'test',
                    createdBy: 'upgrade_preservation_test',
                },
                update: {
                    valueRaw: { marker: 'kb_data_written_before_upgrade' },
                    valueSummary: 'Sentinel fact to verify KB data survives setup re-run.',
                },
            });
            await disconnectDb();
            sentinelDbAvailable = true;
        } catch (dbWriteErr) {
            try { await disconnectDb(); } catch { /* ignore */ }
            if (isDbUnavailableError(dbWriteErr)) {
                console.warn('  ⚠ KB preservation sentinel skipped — test DB not accessible. Set IRANTI_SETUP_SMOKE_DB to enable.');
            } else {
                throw dbWriteErr;
            }
        }

        if (sentinelDbAvailable) {
            const dbForScaffoldQuery = initDb(upgradeTestDbUrl);
            const scaffoldCloseout = await dbForScaffoldQuery.knowledgeEntry.findUnique({
                where: {
                    entityType_entityId_key: {
                        entityType: 'user',
                        entityId: 'main',
                        key: 'claude_setup_scaffold_status',
                    },
                },
            });
            assert.ok(scaffoldCloseout, 'Expected Claude setup to write the shared scaffold closeout fact.');
            assert.strictEqual(scaffoldCloseout?.source, 'ClaudeSetupScaffold');
            assert.deepStrictEqual(
                scaffoldCloseout?.valueRaw,
                {
                    tool: 'claude-setup',
                    projectPath: projectDir,
                    projectEnvFile: path.join(projectDir, '.env.iranti'),
                    files: [
                        { path: path.join(projectDir, '.mcp.json'), status: 'created' },
                        { path: path.join(projectDir, '.vscode', 'mcp.json'), status: 'created' },
                        { path: path.join(projectDir, '.claude', 'settings.local.json'), status: 'created' },
                        { path: path.join(projectDir, 'CLAUDE.md'), status: 'created' },
                    ],
                    updatedAt: scaffoldCloseout?.valueRaw && typeof scaffoldCloseout.valueRaw === 'object'
                        ? (scaffoldCloseout.valueRaw as { updatedAt?: string }).updatedAt
                        : undefined,
                },
                'Expected Claude scaffold closeout to preserve the tool, project, binding, and file inventory.'
            );
            const scaffoldProperties = scaffoldCloseout?.properties as Record<string, unknown> | null;
            assert.strictEqual(scaffoldProperties?.durableClass, 'scaffold_status');
            assert.strictEqual(scaffoldProperties?.canonicalKey, 'claude_setup_scaffold_status');
            await disconnectDb();
        }

        const staleClaudeMdFile = path.join(projectDir, 'CLAUDE.md');
        fs.writeFileSync(staleClaudeMdFile, [
            '<!-- iranti-rules -->',
            '# Iranti Memory Protocol',
            '',
            '## Checkpointing',
            '- Old checkpoint wording that should be refreshed only by a rerun.',
            '<!-- /iranti-rules -->',
            '',
        ].join('\n'), 'utf8');

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

        // Verify the sentinel KB fact survived the setup re-run (when the test DB was accessible).
        // Proves upgrade_preservation_not_proven is resolved: additive migrations, guarded Staff seed, scoped codebase seed.
        if (sentinelDbAvailable) {
            const dbForSentinelQuery = initDb(upgradeTestDbUrl);
            const sentinelFact = await dbForSentinelQuery.knowledgeEntry.findUnique({
                where: {
                    entityType_entityId_key: {
                        entityType: 'project',
                        entityId: 'upgrade_preservation_test',
                        key: 'sentinel',
                    },
                },
            });
            assert.ok(sentinelFact, 'Expected user KB fact written before setup re-run to survive — data loss on re-setup is a hard beta blocker (upgrade_preservation_not_proven).');
            assert.deepStrictEqual(
                sentinelFact?.valueRaw,
                { marker: 'kb_data_written_before_upgrade' },
                'Expected sentinel KB fact value to be unchanged after setup re-run.'
            );
            await disconnectDb();
        }

        const installMetaPath = path.join(runtimeRoot, 'install.json');
        const instanceEnvPath = path.join(runtimeRoot, 'instances', 'local', '.env');
        const projectsRegistryPath = path.join(runtimeRoot, 'instances', 'local', 'projects.json');
        const bindingFile = path.join(projectDir, '.env.iranti');
        const mcpFile = path.join(projectDir, '.mcp.json');
        const vscodeMcpFile = path.join(projectDir, '.vscode', 'mcp.json');
        const claudeSettingsFile = path.join(projectDir, '.claude', 'settings.local.json');
        const claudeMdFile = path.join(projectDir, 'CLAUDE.md');

        assert.ok(fs.existsSync(installMetaPath), 'Expected setup to create install.json.');
        assert.ok(fs.existsSync(instanceEnvPath), 'Expected setup to create instance env.');
        assert.ok(fs.existsSync(bindingFile), 'Expected setup to create .env.iranti.');
        assert.ok(fs.existsSync(mcpFile), 'Expected setup to scaffold .mcp.json.');
        assert.ok(fs.existsSync(vscodeMcpFile), 'Expected setup to scaffold .vscode/mcp.json.');
        assert.ok(fs.existsSync(claudeSettingsFile), 'Expected setup to scaffold Claude settings.');
        assert.ok(fs.existsSync(claudeMdFile), 'Expected setup to scaffold CLAUDE.md.');
        const setupProjectsRegistry = readJson<{
            projects: Array<{
                projectPath: string;
                agentId: string;
                memoryEntity: string;
                mode: string;
                boundAt: string;
            }>;
        }>(projectsRegistryPath);
        assert.deepStrictEqual(setupProjectsRegistry.projects.map((entry) => entry.projectPath), [projectDir]);

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
        assert.strictEqual(mcpConfig.mcpServers.iranti.env?.IRANTI_MCP_HOST, 'codex_cli', 'Expected scaffolded .mcp.json to label Codex CLI host context.');
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
        assert.strictEqual(vscodeMcpConfig.servers.iranti.env?.IRANTI_MCP_HOST, 'codex_vscode', 'Expected scaffolded .vscode/mcp.json to label Codex VS Code host context.');
        const claudeSettings = readJson<{
            hooks?: Record<string, unknown>;
            permissions?: { allow?: string[] };
            mcpServers?: { iranti?: { env?: Record<string, string> } };
            enabledMcpjsonServers?: string[];
            enableAllProjectMcpServers?: boolean;
        }>(claudeSettingsFile);
        assert.ok(claudeSettings.hooks?.SessionStart, 'Expected scaffolded Claude settings to include SessionStart hook.');
        assert.ok(claudeSettings.hooks?.UserPromptSubmit, 'Expected scaffolded Claude settings to include UserPromptSubmit hook.');
        assert.ok(claudeSettings.hooks?.Stop, 'Expected scaffolded Claude settings to include Stop hook.');
        assert.strictEqual(claudeSettings.enableAllProjectMcpServers, false, 'Expected scaffolded Claude settings to disable blanket project MCP auto-loading so the explicit Claude server wins.');
        assert.strictEqual(claudeSettings.mcpServers?.iranti?.env?.IRANTI_MCP_HOST, 'claude_code', 'Expected scaffolded Claude settings to carry a truthful Claude MCP host context.');
        assert.ok(!(claudeSettings.enabledMcpjsonServers ?? []).includes('iranti'), 'Expected scaffolded Claude settings to stop inheriting the shared iranti .mcp.json server.');
        assert.ok(
            claudeSettings.permissions?.allow?.includes('mcp__iranti__iranti_checkpoint'),
            'Expected scaffolded Claude settings to allow iranti_checkpoint.',
        );
        assert.ok(
            claudeSettings.permissions?.allow?.includes('mcp__iranti__iranti_attend'),
            'Expected scaffolded Claude settings to allow iranti_attend.',
        );
        const claudeMd = fs.readFileSync(claudeMdFile, 'utf8');
        assert.match(claudeMd, /mcp__iranti__iranti_handshake/, 'Expected scaffolded CLAUDE.md to require handshake.');
        assert.match(claudeMd, /Iranti is a hive mind/i, 'Expected scaffolded CLAUDE.md to use the hive-mind acknowledgment framing.');
        assert.match(claudeMd, /iranti_handshake, iranti_attend, iranti_write, iranti_checkpoint, and iranti_remember_response/i, 'Expected scaffolded CLAUDE.md to name the core memory-duty tools in the acknowledgment.');
        assert.match(claudeMd, /before using any knowledge discovery tool/i, 'Expected scaffolded CLAUDE.md to require attend before discovery.');
        assert.match(claudeMd, /before stepping away from long or interrupted work/i, 'Expected scaffolded CLAUDE.md to require checkpointing for interrupted work.');
        assert.match(claudeMd, /checkpoint `actions` field/i, 'Expected scaffolded CLAUDE.md to tell hosts to record key actions in checkpoint actions.');
        assert.match(claudeMd, /confirmed durable findings/i, 'Expected scaffolded CLAUDE.md to require durable writes after confirmed findings.');
        assert.match(claudeMd, /what you found, what worked, what failed, what changed, and what happens next/i, 'Expected scaffolded CLAUDE.md to require structured breadcrumbs instead of only broad summaries.');
        assert.doesNotMatch(claudeMd, /Old checkpoint wording that should be refreshed only by a rerun\./, 'Expected rerunning setup to refresh an existing Iranti CLAUDE.md block without requiring --force.');

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
        const sharedProjectsRegistry = readJson<{
            projects: Array<{
                projectPath: string;
                agentId: string;
                memoryEntity: string;
                mode: string;
                boundAt: string;
            }>;
        }>(path.join(sharedRuntimeRoot, 'instances', 'team', 'projects.json'));
        assert.deepStrictEqual(
            sharedProjectsRegistry.projects.map((entry) => entry.projectPath).sort(),
            [sharedProjectA, sharedProjectB].sort(),
        );
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
            assert.ok(fs.existsSync(path.join(projectPath, 'CLAUDE.md')), 'Expected shared setup to scaffold CLAUDE.md for each bound project.');
            const sharedMcp = readJson<{
                mcpServers: {
                    iranti: {
                        env?: Record<string, string>;
                    };
                };
            }>(path.join(projectPath, '.mcp.json'));
            assert.strictEqual(sharedMcp.mcpServers.iranti.env?.IRANTI_PROJECT_ENV, path.join(projectPath, '.env.iranti'), 'Expected shared scaffolding to pin each project binding in .mcp.json');
            assert.strictEqual(sharedMcp.mcpServers.iranti.env?.IRANTI_MCP_HOST, 'codex_cli', 'Expected shared .mcp.json scaffolding to label Codex CLI host context.');
            const sharedVsCodeMcp = readJson<{
                servers: {
                    iranti: {
                        envFile?: string;
                        env?: Record<string, string>;
                    };
                };
            }>(path.join(projectPath, '.vscode', 'mcp.json'));
            assert.strictEqual(sharedVsCodeMcp.servers.iranti.envFile, '${workspaceFolder}/.env.iranti', 'Expected shared scaffolding to pin each project binding in .vscode/mcp.json');
            assert.strictEqual(sharedVsCodeMcp.servers.iranti.env?.IRANTI_MCP_HOST, 'codex_vscode', 'Expected shared .vscode/mcp.json scaffolding to label Codex VS Code host context.');
            const sharedClaudeSettings = readJson<{
                hooks?: Record<string, unknown>;
                permissions?: { allow?: string[] };
                mcpServers?: { iranti?: { env?: Record<string, string> } };
                enabledMcpjsonServers?: string[];
                enableAllProjectMcpServers?: boolean;
            }>(path.join(projectPath, '.claude', 'settings.local.json'));
            assert.ok(sharedClaudeSettings.hooks?.Stop, 'Expected shared Claude scaffolding to include Stop hook.');
            assert.strictEqual(sharedClaudeSettings.enableAllProjectMcpServers, false, 'Expected shared Claude scaffolding to disable blanket project MCP auto-loading so the explicit Claude server wins.');
            assert.strictEqual(sharedClaudeSettings.mcpServers?.iranti?.env?.IRANTI_MCP_HOST, 'claude_code', 'Expected shared Claude scaffolding to carry a truthful Claude MCP host context.');
            assert.ok(!(sharedClaudeSettings.enabledMcpjsonServers ?? []).includes('iranti'), 'Expected shared Claude scaffolding to stop inheriting the shared iranti .mcp.json server.');
            assert.ok(
                sharedClaudeSettings.permissions?.allow?.includes('mcp__iranti__iranti_checkpoint'),
                'Expected shared Claude scaffolding to allow iranti_checkpoint.',
            );
            const sharedClaudeMd = fs.readFileSync(path.join(projectPath, 'CLAUDE.md'), 'utf8');
            assert.match(sharedClaudeMd, /mcp__iranti__iranti_handshake/, 'Expected shared CLAUDE.md to require handshake.');
            assert.match(sharedClaudeMd, /Iranti is a hive mind/i, 'Expected shared CLAUDE.md to use the hive-mind acknowledgment framing.');
            assert.match(sharedClaudeMd, /iranti_handshake, iranti_attend, iranti_write, iranti_checkpoint, and iranti_remember_response/i, 'Expected shared CLAUDE.md to name the core memory-duty tools in the acknowledgment.');
            assert.match(sharedClaudeMd, /before using any knowledge discovery tool/i, 'Expected shared CLAUDE.md to require attend before discovery.');
            assert.match(sharedClaudeMd, /before stepping away from long or interrupted work/i, 'Expected shared CLAUDE.md to require checkpointing for interrupted work.');
            assert.match(sharedClaudeMd, /checkpoint `actions` field/i, 'Expected shared CLAUDE.md to tell hosts to record key actions in checkpoint actions.');
            assert.match(sharedClaudeMd, /what you found, what worked, what failed, what changed, and what happens next/i, 'Expected shared CLAUDE.md to require structured breadcrumbs instead of only broad summaries.');
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
        assert.match(projectInitBinding.IRANTI_CODEBASE_ENTITY ?? '', /^codebase\/[a-z0-9_-]+_[a-f0-9]{8}$/i, 'Expected project init to persist a derived IRANTI_CODEBASE_ENTITY.');

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
        const configuredProjectsRegistry = readJson<{
            projects: Array<{
                projectPath: string;
                agentId: string;
                memoryEntity: string;
                mode: string;
                boundAt: string;
            }>;
        }>(projectsRegistryPath);
        assert.deepStrictEqual(
            configuredProjectsRegistry.projects.map((entry) => entry.projectPath).sort(),
            [projectDir, projectInitDir].sort(),
        );
        const configuredEntry = configuredProjectsRegistry.projects.find((entry) => entry.projectPath === projectInitDir);
        assert.strictEqual(configuredEntry?.agentId, configuredProjectBinding.IRANTI_AGENT_ID);
        assert.strictEqual(configuredEntry?.memoryEntity, configuredProjectBinding.IRANTI_MEMORY_ENTITY);
        assert.strictEqual(configuredEntry?.mode, configuredProjectBinding.IRANTI_PROJECT_MODE);
        const configuredInstanceEnv = readEnv(configuredProjectBinding.IRANTI_INSTANCE_ENV);
        const codebaseEntity = configuredProjectBinding.IRANTI_CODEBASE_ENTITY;
        assert.ok(codebaseEntity, 'Expected configured project binding to retain IRANTI_CODEBASE_ENTITY.');
        try {
            const configuredDb = initDb(configuredInstanceEnv.DATABASE_URL);
            const [codebaseType, codebaseId] = String(codebaseEntity).split('/');
            const overviewFact = await configuredDb.knowledgeEntry.findUnique({
                where: {
                    entityType_entityId_key: {
                        entityType: codebaseType!,
                        entityId: codebaseId!,
                        key: 'project_overview',
                    },
                },
            });
            const bindingFact = await configuredDb.knowledgeEntry.findUnique({
                where: {
                    entityType_entityId_key: {
                        entityType: codebaseType!,
                        entityId: codebaseId!,
                        key: 'project_binding',
                    },
                },
            });
            assert.ok(overviewFact, 'Expected bind-time project learning to write project_overview.');
            assert.ok(bindingFact, 'Expected bind-time project learning to write project_binding.');
            assert.match(overviewFact?.valueSummary ?? '', /Initial project snapshot/i);
            assert.strictEqual((bindingFact?.valueRaw as { codebaseEntity?: string } | null)?.codebaseEntity, codebaseEntity);
        } catch (dbAssertErr) {
            if (isDbUnavailableError(dbAssertErr)) {
                console.warn('  ⚠ Project-learning DB assertions skipped — configured test DB not accessible from harness.');
            } else {
                throw dbAssertErr;
            }
        } finally {
            await disconnectDb().catch(() => undefined);
        }

        const reboundPort = await reservePort();
        const reboundInstanceName = 'beta';
        const reboundApiKey = `test_${randomBytes(16).toString('hex')}`;
        const reboundDbUrl = 'postgresql://postgres:postgres@localhost:5432/iranti_setup_rebind';
        const reboundInstanceRun = runCli([
            'instance',
            'create',
            reboundInstanceName,
            '--root',
            runtimeRoot,
            '--port',
            String(reboundPort),
            '--db-url',
            reboundDbUrl,
            '--provider',
            'mock',
            '--api-key',
            reboundApiKey,
        ], repoRoot);
        assert.strictEqual(reboundInstanceRun.status, 0, `rebound instance create failed:\n${reboundInstanceRun.stdout}\n${reboundInstanceRun.stderr}`);

        const rebindProjectRun = runCli([
            'configure',
            'project',
            projectInitDir,
            '--root',
            runtimeRoot,
            '--instance',
            reboundInstanceName,
            '--mode',
            'shared',
            '--auto-remember',
            'true',
        ], repoRoot);
        assert.strictEqual(rebindProjectRun.status, 0, `configure project rebind failed:\n${rebindProjectRun.stdout}\n${rebindProjectRun.stderr}`);

        const reboundProjectBinding = readEnv(path.join(projectInitDir, '.env.iranti'));
        assert.strictEqual(reboundProjectBinding.IRANTI_INSTANCE, reboundInstanceName);
        assert.strictEqual(reboundProjectBinding.IRANTI_INSTANCE_ENV, path.join(runtimeRoot, 'instances', reboundInstanceName, '.env'));
        assert.strictEqual(reboundProjectBinding.IRANTI_PROJECT_MODE, 'shared');
        assert.strictEqual(reboundProjectBinding.IRANTI_AUTO_REMEMBER, 'true');

        const rebindSourceRegistry = readJson<{ projects: Array<{ projectPath: string }> }>(projectsRegistryPath);
        assert.deepStrictEqual(
            rebindSourceRegistry.projects.map((entry) => entry.projectPath).sort(),
            [projectDir].sort(),
            'Expected rebind to remove only the rebound project from the original instance registry while preserving still-bound setup projects.',
        );

        const reboundProjectsRegistryPath = path.join(runtimeRoot, 'instances', reboundInstanceName, 'projects.json');
        const reboundProjectsRegistry = readJson<{
            projects: Array<{
                projectPath: string;
                agentId: string;
                memoryEntity: string;
                mode: string;
                boundAt: string;
            }>;
        }>(reboundProjectsRegistryPath);
        assert.deepStrictEqual(reboundProjectsRegistry.projects.map((entry) => entry.projectPath), [projectInitDir]);
        const reboundEntry = reboundProjectsRegistry.projects[0];
        assert.strictEqual(reboundEntry.agentId, reboundProjectBinding.IRANTI_AGENT_ID);
        assert.strictEqual(reboundEntry.memoryEntity, reboundProjectBinding.IRANTI_MEMORY_ENTITY);
        assert.strictEqual(reboundEntry.mode, reboundProjectBinding.IRANTI_PROJECT_MODE);
        assert.strictEqual(reboundProjectBinding.IRANTI_CODEBASE_ENTITY, codebaseEntity, 'Expected rebind to preserve the same derived codebase entity for the project path.');

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
        writeText(path.join(projectInitDir, 'AGENTS.md'), [
            '<!-- iranti-rules -->',
            '# Iranti MCP Protocol',
            '',
            'Codex scaffold block for cleanup coverage.',
            '<!-- /iranti-rules -->',
            '',
        ].join('\n'));

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
        assert.deepStrictEqual(projectUnbindPayload.cleanedRegistryInstances, [reboundInstanceName]);
        assert.strictEqual(projectUnbindPayload.keepIntegrations, false, 'Expected project unbind to clean local integrations by default.');
        assert.strictEqual(fs.existsSync(path.join(projectInitDir, '.env.iranti')), false, 'Expected project unbind to remove .env.iranti.');
        assert.strictEqual(fs.existsSync(path.join(projectInitDir, '.mcp.json')), false, 'Expected project unbind to remove a workspace MCP file that only referenced Iranti.');
        const vscodeMcpAfterUnbind = readJson<{ servers?: Record<string, { command?: string }> }>(path.join(projectInitDir, '.vscode', 'mcp.json'));
        assert.ok(!vscodeMcpAfterUnbind.servers?.iranti, 'Expected project unbind to remove the Iranti VS Code MCP server entry.');
        assert.strictEqual(vscodeMcpAfterUnbind.servers?.other?.command, 'other-mcp', 'Expected unrelated VS Code MCP servers to remain.');
        const claudeSettingsAfterUnbind = readJson<{ hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }>(path.join(projectInitDir, '.claude', 'settings.local.json'));
        const remainingSessionStart = claudeSettingsAfterUnbind.hooks?.SessionStart?.[0]?.hooks?.map((entry) => entry.command) ?? [];
        assert.deepStrictEqual(remainingSessionStart, ['echo keep-me'], 'Expected project unbind to remove only Iranti Claude hooks.');
        assert.strictEqual(fs.existsSync(path.join(projectInitDir, 'AGENTS.md')), false, 'Expected project unbind to remove the Codex AGENTS scaffold block when it is the only content.');
        const registryAfterUnbind = readJson<{ projects: Array<{ projectPath: string }> }>(reboundProjectsRegistryPath);
        const sourceRegistryAfterUnbind = readJson<{ projects: Array<{ projectPath: string }> }>(projectsRegistryPath);
        assert.deepStrictEqual(
            registryAfterUnbind.projects,
            [],
            'Expected project unbind to clear the rebound instance registry.',
        );
        assert.deepStrictEqual(
            sourceRegistryAfterUnbind.projects.map((entry) => entry.projectPath).sort(),
            [projectDir].sort(),
            'Expected project unbind to keep the still-bound setup project in projects.json.',
        );

        const statusRun = runCli(['status', '--root', runtimeRoot, '--json'], repoRoot);
        assert.strictEqual(statusRun.status, 0, `status failed after setup:\n${statusRun.stdout}\n${statusRun.stderr}`);
        const statusPayload = parseJsonFromStdout(statusRun.stdout) as {
            instances: Array<{
                name: string;
                projectCount?: number;
                boundProjects?: Array<{ projectPath: string; agentId: string; mode: string }>;
                config: { classification: string };
                runtime: { classification: string; running: boolean };
            }>;
        };
        const localInstance = statusPayload.instances.find((instance) => instance.name === 'local');
        assert.ok(localInstance, 'Expected setup-created instance in status output.');
        assert.strictEqual(localInstance?.config.classification, 'complete');
        assert.strictEqual(localInstance?.runtime.running, false);
        assert.ok(['missing', 'stopped'].includes(localInstance?.runtime.classification ?? ''), `Expected non-running setup instance, got ${localInstance?.runtime.classification}.`);
        assert.strictEqual(localInstance?.projectCount, 1, 'Expected status JSON to expose the remaining bound project count.');
        assert.strictEqual(localInstance?.boundProjects?.[0]?.projectPath, projectDir, 'Expected status JSON to expose the remaining bound project path.');

        const sharedStatusRun = runCli(['status', '--root', sharedRuntimeRoot, '--json'], repoRoot);
        assert.strictEqual(sharedStatusRun.status, 0, `status failed after shared setup:\n${sharedStatusRun.stdout}\n${sharedStatusRun.stderr}`);
        const sharedStatusPayload = parseJsonFromStdout(sharedStatusRun.stdout) as typeof statusPayload;
        const sharedInstance = sharedStatusPayload.instances.find((instance) => instance.name === 'team');
        assert.ok(sharedInstance, 'Expected shared setup-created instance in status output.');
        assert.strictEqual(sharedInstance?.config.classification, 'complete');
        assert.strictEqual(sharedInstance?.runtime.running, false);
        assert.ok(['missing', 'stopped'].includes(sharedInstance?.runtime.classification ?? ''), `Expected non-running shared setup instance, got ${sharedInstance?.runtime.classification}.`);
        assert.strictEqual(sharedInstance?.projectCount, 2, 'Expected shared status JSON to expose both bound projects.');
        assert.deepStrictEqual(
            sharedInstance?.boundProjects?.map((project) => project.projectPath).sort(),
            [sharedProjectA, sharedProjectB].sort(),
            'Expected shared status JSON to surface the shared runtime project registry.'
        );

        const mcpCleanupRun = runCli(['mcp', 'cleanup', '--dry-run', '--json'], repoRoot);
        assert.strictEqual(mcpCleanupRun.status, 0, `mcp cleanup dry-run failed:\n${mcpCleanupRun.stdout}\n${mcpCleanupRun.stderr}`);
        const mcpCleanupPayload = parseJsonFromStdout(mcpCleanupRun.stdout) as {
            platform: string;
            supported: boolean;
            dryRun: boolean;
            counts: Record<string, number>;
            safeCandidates: unknown[];
            skippedCandidates: unknown[];
            cleaned: unknown[];
            warnings: string[];
        };
        assert.strictEqual(mcpCleanupPayload.dryRun, true, 'Expected MCP cleanup JSON payload to report dryRun=true.');
        assert.ok(typeof mcpCleanupPayload.supported === 'boolean', 'Expected MCP cleanup JSON payload to include supported.');
        assert.ok(typeof mcpCleanupPayload.counts === 'object' && mcpCleanupPayload.counts !== null, 'Expected MCP cleanup JSON payload to include counts.');
        assert.ok(Array.isArray(mcpCleanupPayload.safeCandidates), 'Expected MCP cleanup JSON payload to include safeCandidates.');
        assert.ok(Array.isArray(mcpCleanupPayload.skippedCandidates), 'Expected MCP cleanup JSON payload to include skippedCandidates.');
        assert.ok(Array.isArray(mcpCleanupPayload.cleaned), 'Expected MCP cleanup JSON payload to include cleaned.');
        assert.ok(Array.isArray(mcpCleanupPayload.warnings), 'Expected MCP cleanup JSON payload to include warnings.');

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
