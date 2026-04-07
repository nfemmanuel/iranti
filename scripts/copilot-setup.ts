import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSyncResolved } from '../src/lib/commandInvocation';
import { writeProjectScaffoldCloseout } from '../src/lib/scaffoldCloseout';

type SetupOptions = {
    name: string;
    agent: string;
    source: string;
    provider?: string;
    projectEnv?: string;
    useLocalScript: boolean;
    writeWorkspaceFile: boolean;
};

type WorkspaceFileResult = {
    filePath: string;
    status: 'created' | 'updated' | 'unchanged';
};

type WorkspaceFilesResult = {
    mcp: WorkspaceFileResult;
    vscode: WorkspaceFileResult;
    instructions: WorkspaceFileResult;
    irantiMd: WorkspaceFileResult;
    hookScript: WorkspaceFileResult;
    hooksJson: WorkspaceFileResult;
};

function parseArgs(argv: string[]): SetupOptions {
    const options: SetupOptions = {
        name: 'iranti',
        agent: 'copilot_code',
        source: 'Copilot',
        useLocalScript: false,
        writeWorkspaceFile: true,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const next = argv[index + 1];
        switch (token) {
            case '--name':
                if (!next) throw new Error('--name requires a value.');
                options.name = next.trim();
                index += 1;
                break;
            case '--agent':
                if (!next) throw new Error('--agent requires a value.');
                options.agent = next.trim();
                index += 1;
                break;
            case '--source':
                if (!next) throw new Error('--source requires a value.');
                options.source = next.trim();
                index += 1;
                break;
            case '--provider':
                if (!next) throw new Error('--provider requires a value.');
                options.provider = next.trim();
                index += 1;
                break;
            case '--project-env':
                if (!next) throw new Error('--project-env requires a value.');
                options.projectEnv = next.trim();
                index += 1;
                break;
            case '--local-script':
                options.useLocalScript = true;
                break;
            case '--no-workspace-file':
                options.writeWorkspaceFile = false;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown argument: ${token}`);
        }
    }

    return options;
}

function printHelp(): void {
    console.log([
        'Configure GitHub Copilot CLI to use the local Iranti MCP server.',
        '',
        'Usage:',
        '  ts-node scripts/copilot-setup.ts [--name iranti] [--agent copilot_code] [--source Copilot] [--provider openai] [--project-env path] [--local-script] [--no-workspace-file]',
        '',
        'Notes:',
        '  - Writes a global Copilot MCP config entry to ~/.copilot/mcp-config.json.',
        '  - Prefers the installed CLI path: `iranti mcp`.',
        '  - When a project binding is available, also writes or merges project-local `.mcp.json` and `.vscode/mcp.json` entries pinned to that binding.',
        '  - Writes `.github/copilot-instructions.md` with a slim Iranti protocol pointer.',
        '  - By default does not pin IRANTI_PROJECT_ENV, so Copilot can resolve .env.iranti from the active project/workspace at runtime.',
        '  - Use --project-env only when you deliberately want to pin Copilot globally to one project binding.',
        '  - Use --local-script only if you need to point Copilot at this repo build directly.',
        '  - Use --no-workspace-file only if you explicitly want global registration without project-local MCP file updates.',
        '  - Does not store DATABASE_URL in Copilot config; iranti-mcp loads project/instance env at runtime.',
        '  - Merges into any existing MCP config without removing other servers.',
        '  - Expected host pattern: run iranti_handshake at session start, run iranti_attend before each reply and before/after knowledge discovery, checkpoint at natural pauses or interrupted work, and write/checkpoint confirmed findings.',
    ].join('\n'));
}

function run(command: string, args: string[], cwd: string): string {
    const result = spawnSyncResolved(command, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = typeof result.stdout === 'string'
        ? result.stdout.trim()
        : Buffer.from(result.stdout ?? []).toString('utf8').trim();
    const stderr = typeof result.stderr === 'string'
        ? result.stderr.trim()
        : Buffer.from(result.stderr ?? []).toString('utf8').trim();

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(stderr || stdout || `${command} exited with status ${result.status}`);
    }

    return stdout;
}

function findPackageRoot(startDir: string): string {
    let dir = startDir;
    for (let i = 0; i < 6; i += 1) {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(startDir, '..');
}

function resolveProjectEnv(options: SetupOptions): string | undefined {
    const explicit = options.projectEnv?.trim();
    if (explicit) {
        const resolved = path.resolve(explicit);
        if (!fs.existsSync(resolved)) {
            throw new Error(`Project env file not found: ${resolved}`);
        }
        return resolved;
    }
    return undefined;
}

function findClosestAncestorFile(startDir: string, fileName: string): string | undefined {
    let current = path.resolve(startDir);
    while (true) {
        const candidate = path.join(current, fileName);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}

function resolveWorkspaceProjectEnv(options: SetupOptions): string | undefined {
    const explicit = resolveProjectEnv(options);
    if (explicit) {
        return explicit;
    }
    return findClosestAncestorFile(process.cwd(), '.env.iranti');
}

// ── Global Copilot MCP config ──────────────────────────────────────────

function getCopilotConfigDir(): string {
    return path.join(os.homedir(), '.copilot');
}

function getCopilotMcpConfigPath(): string {
    return path.join(getCopilotConfigDir(), 'mcp-config.json');
}

function makeGlobalMcpServerEntry(options: SetupOptions, projectEnv?: string, useInstalled?: boolean, mcpScript?: string): Record<string, unknown> {
    const env: Record<string, string> = {
        IRANTI_MCP_DEFAULT_AGENT: options.agent,
        IRANTI_MCP_DEFAULT_SOURCE: options.source,
        IRANTI_MCP_HOST: 'copilot_cli',
    };
    if (projectEnv) {
        env.IRANTI_PROJECT_ENV = projectEnv;
    }
    if (options.provider) {
        env.LLM_PROVIDER = options.provider;
    }

    if (useInstalled) {
        return {
            type: 'stdio',
            command: 'iranti',
            args: ['mcp'],
            env,
        };
    }
    return {
        type: 'stdio',
        command: 'node',
        args: [mcpScript!],
        env,
    };
}

type GlobalConfigResult = {
    configPath: string;
    status: 'created' | 'updated' | 'unchanged';
};

function writeGlobalCopilotMcpConfig(
    options: SetupOptions,
    serverEntry: Record<string, unknown>,
): GlobalConfigResult {
    const configDir = getCopilotConfigDir();
    const configPath = getCopilotMcpConfigPath();

    fs.mkdirSync(configDir, { recursive: true });

    if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, `${JSON.stringify({
            mcpServers: {
                [options.name]: serverEntry,
            },
        }, null, 2)}\n`, 'utf8');
        return { configPath, status: 'created' };
    }

    let existing: Record<string, unknown>;
    try {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
        throw new Error(`Existing ~/.copilot/mcp-config.json is not valid JSON: ${configPath}`);
    }

    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        throw new Error(`Existing ~/.copilot/mcp-config.json must contain a JSON object: ${configPath}`);
    }

    const existingServers =
        existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
            ? existing.mcpServers as Record<string, unknown>
            : {};
    const currentIranti = existingServers[options.name];
    if (JSON.stringify(currentIranti) === JSON.stringify(serverEntry)) {
        return { configPath, status: 'unchanged' };
    }

    fs.writeFileSync(configPath, `${JSON.stringify({
        ...existing,
        mcpServers: {
            ...existingServers,
            [options.name]: serverEntry,
        },
    }, null, 2)}\n`, 'utf8');
    return { configPath, status: 'updated' };
}

// ── Workspace files ────────────────────────────────────────────────────

function makeWorkspaceMcpServer(options: SetupOptions, projectEnv: string): Record<string, unknown> {
    const env: Record<string, string> = {
        IRANTI_PROJECT_ENV: projectEnv,
        IRANTI_MCP_DEFAULT_AGENT: options.agent,
        IRANTI_MCP_DEFAULT_SOURCE: options.source,
        IRANTI_MCP_HOST: 'copilot_cli',
    };
    if (options.provider) {
        env.LLM_PROVIDER = options.provider;
    }
    return {
        command: 'iranti',
        args: ['mcp'],
        env,
    };
}

function makeVsCodeWorkspaceMcpServer(options: SetupOptions, projectEnv: string): Record<string, unknown> {
    const projectPath = path.dirname(projectEnv);
    const env: Record<string, string> = {
        IRANTI_MCP_DEFAULT_AGENT: options.agent,
        IRANTI_MCP_DEFAULT_SOURCE: options.source,
        IRANTI_MCP_HOST: 'copilot_vscode',
    };
    if (options.provider) {
        env.LLM_PROVIDER = options.provider;
    }
    const localBinding = path.join(projectPath, '.env.iranti');
    if (path.resolve(projectEnv) !== path.resolve(localBinding)) {
        env.IRANTI_PROJECT_ENV = projectEnv;
    }
    return {
        type: 'stdio',
        command: 'iranti',
        args: ['mcp'],
        ...(path.resolve(projectEnv) === path.resolve(localBinding)
            ? { envFile: '${workspaceFolder}/.env.iranti' }
            : {}),
        env,
    };
}

/**
 * Canonical protocol content for IRANTI.md — host-neutral, read once per session.
 * Duplicated from iranti-cli.ts because copilot-setup is a standalone script.
 */
function buildIrantiMdContent(): string {
    return [
        '# Iranti Memory Protocol',
        '',
        'Iranti is a shared working-memory layer. Follow this protocol to persist what you find, what works, what fails, what changes, and what happens next so later sessions do not have to rediscover it.',
        '',
        '## Session start',
        '- Call `mcp__iranti__iranti_handshake` with the current task before responding to the first user message.',
        '- Call `mcp__iranti__iranti_handshake` again after context compaction.',
        '',
        '## Every turn',
        '1. Call `iranti_attend(phase=\'pre-response\')` before responding to the user.',
        '2. Call `iranti_attend` before any knowledge discovery tool — Read, Grep, Glob, WebSearch, WebFetch, Bash.',
        '3. Call `iranti_write` after every Edit/Write, Bash that reveals system state, WebSearch/WebFetch with confirmed facts, and subagent completion.',
        '4. Call `iranti_attend(phase=\'post-response\')` after every response.',
        '5. If a recall-style lookup returns no facts, try at least one alternative retrieval angle before concluding absent.',
        '',
        '## Checkpointing',
        '- Call `iranti_checkpoint` at task completion, task shifts, and natural pauses.',
        '- Record actions, current step, next step, open risks, and file changes.',
        '',
        '## Write depth',
        '- Include what changed, why, and what breaks if removed.',
        '- After file edits: absolutePath, lines, before, after, verify, why.',
        '- After Bash: include the command and relevant output lines.',
        '- After WebSearch/WebFetch: record findings AND dead ends.',
        '',
    ].join('\n');
}

/**
 * Copilot-instructions.md block — includes the full per-turn protocol inline.
 * This is the Copilot equivalent of Claude Code's UserPromptSubmit hook: since
 * Copilot has no dynamic per-turn hook, the protocol must live in the static
 * instructions file that Copilot injects into every prompt.
 */
function buildCopilotInstructionsBlock(): string {
    return [
        '<!-- iranti-rules -->',
        '# Iranti',
        '',
        'This project uses Iranti for shared memory. Follow the attend/write/checkpoint protocol in `IRANTI.md`.',
        '',
        '**Session start:** Call `mcp__iranti__iranti_handshake` IMMEDIATELY on the first user message — before deciding what to respond, before asking any clarification questions, before reading any files. Do not ask the user for clarification before calling handshake and `iranti_search`. Iranti may already have the context needed to answer directly.',
        '',
        '**Every turn:**',
        '1. Call `iranti_attend(phase=\'pre-response\')` before responding.',
        '2. Call `iranti_attend` before Read / Grep / Glob / Bash / WebSearch / WebFetch.',
        '3. Call `iranti_write` after every file edit, Bash that reveals system state, WebSearch/WebFetch finding, and subagent result. Write: what changed, why, what breaks if removed.',
        '4. Call `iranti_attend(phase=\'post-response\')` after every response.',
        '',
        '**Recall:** When the user asks about prior work, status, or progress — call `iranti_search` BEFORE reading the codebase. Do not ask the user for clarification — call `iranti_search` first; Iranti likely has the answer. If `iranti_attend` returns a `searchSuggestion`, call `iranti_search` with those terms. Empty attend facts do NOT mean the data is absent; Iranti is the cross-session source of truth.',
        '',
        '**Writes:** Use a specific entity for the work area (e.g. `project/iranti_benchmarking` for benchmark findings, not the top-level project entity). If unsure of the right entity, use `iranti_search` to find where prior facts on that topic were stored.',
        '',
        '**Checkpoint** (call `iranti_checkpoint`) at task completion, task shifts, and natural pauses.',
        '<!-- /iranti-rules -->',
        '',
    ].join('\n');
}

function writeWorkspaceCopilotInstructionsFile(projectEnv: string): WorkspaceFileResult {
    const projectPath = path.dirname(projectEnv);
    const githubDir = path.join(projectPath, '.github');
    const instructionsFile = path.join(githubDir, 'copilot-instructions.md');
    const irantiBlock = buildCopilotInstructionsBlock();

    fs.mkdirSync(githubDir, { recursive: true });

    if (!fs.existsSync(instructionsFile)) {
        fs.writeFileSync(instructionsFile, irantiBlock, 'utf8');
        return { filePath: instructionsFile, status: 'created' };
    }

    const existing = fs.readFileSync(instructionsFile, 'utf8');
    if (!existing.includes('<!-- iranti-rules -->')) {
        fs.writeFileSync(instructionsFile, `${existing.trimEnd()}\n\n${irantiBlock}`, 'utf8');
        return { filePath: instructionsFile, status: 'updated' };
    }

    const replaced = existing.replace(
        /<!-- iranti-rules -->[\s\S]*?<!-- \/iranti-rules -->/,
        irantiBlock.trim(),
    );
    if (replaced === existing) {
        return { filePath: instructionsFile, status: 'unchanged' };
    }

    fs.writeFileSync(instructionsFile, replaced, 'utf8');
    return { filePath: instructionsFile, status: 'updated' };
}

function writeWorkspaceIrantiMdFile(projectEnv: string): WorkspaceFileResult {
    const projectPath = path.dirname(projectEnv);
    const irantiMdFile = path.join(projectPath, 'IRANTI.md');
    const irantiMdContent = buildIrantiMdContent();

    if (!fs.existsSync(irantiMdFile)) {
        fs.writeFileSync(irantiMdFile, irantiMdContent, 'utf8');
        return { filePath: irantiMdFile, status: 'created' };
    }

    const existing = fs.readFileSync(irantiMdFile, 'utf8');
    if (existing !== irantiMdContent) {
        fs.writeFileSync(irantiMdFile, irantiMdContent, 'utf8');
        return { filePath: irantiMdFile, status: 'updated' };
    }

    return { filePath: irantiMdFile, status: 'unchanged' };
}

function writeWorkspaceMcpFile(projectEnv: string, options: SetupOptions): WorkspaceFileResult {
    const projectPath = path.dirname(projectEnv);
    const mcpFile = path.join(projectPath, '.mcp.json');
    const nextServer = makeWorkspaceMcpServer(options, projectEnv);

    if (!fs.existsSync(mcpFile)) {
        fs.writeFileSync(mcpFile, `${JSON.stringify({
            mcpServers: {
                iranti: nextServer,
            },
        }, null, 2)}\n`, 'utf8');
        return { filePath: mcpFile, status: 'created' };
    }

    let existing: Record<string, unknown>;
    try {
        existing = JSON.parse(fs.readFileSync(mcpFile, 'utf8')) as Record<string, unknown>;
    } catch {
        throw new Error(`Existing .mcp.json is not valid JSON: ${mcpFile}`);
    }

    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        throw new Error(`Existing .mcp.json must contain a JSON object: ${mcpFile}`);
    }

    const existingServers =
        existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
            ? existing.mcpServers as Record<string, unknown>
            : {};
    const currentIranti = existingServers.iranti;
    if (JSON.stringify(currentIranti) === JSON.stringify(nextServer)) {
        return { filePath: mcpFile, status: 'unchanged' };
    }

    fs.writeFileSync(mcpFile, `${JSON.stringify({
        ...existing,
        mcpServers: {
            ...existingServers,
            iranti: nextServer,
        },
    }, null, 2)}\n`, 'utf8');
    return { filePath: mcpFile, status: 'updated' };
}

function writeWorkspaceVsCodeMcpFile(projectEnv: string, options: SetupOptions): WorkspaceFileResult {
    const projectPath = path.dirname(projectEnv);
    const vscodeDir = path.join(projectPath, '.vscode');
    const mcpFile = path.join(vscodeDir, 'mcp.json');
    const nextServer = makeVsCodeWorkspaceMcpServer(options, projectEnv);

    fs.mkdirSync(vscodeDir, { recursive: true });

    if (!fs.existsSync(mcpFile)) {
        fs.writeFileSync(mcpFile, `${JSON.stringify({
            servers: {
                iranti: nextServer,
            },
        }, null, 2)}\n`, 'utf8');
        return { filePath: mcpFile, status: 'created' };
    }

    let existing: Record<string, unknown>;
    try {
        existing = JSON.parse(fs.readFileSync(mcpFile, 'utf8')) as Record<string, unknown>;
    } catch {
        throw new Error(`Existing .vscode/mcp.json is not valid JSON: ${mcpFile}`);
    }

    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        throw new Error(`Existing .vscode/mcp.json must contain a JSON object: ${mcpFile}`);
    }

    const existingServers =
        existing.servers && typeof existing.servers === 'object' && !Array.isArray(existing.servers)
            ? existing.servers as Record<string, unknown>
            : {};
    const currentIranti = existingServers.iranti;
    if (JSON.stringify(currentIranti) === JSON.stringify(nextServer)) {
        return { filePath: mcpFile, status: 'unchanged' };
    }

    fs.writeFileSync(mcpFile, `${JSON.stringify({
        ...existing,
        servers: {
            ...existingServers,
            iranti: nextServer,
        },
    }, null, 2)}\n`, 'utf8');
    return { filePath: mcpFile, status: 'updated' };
}

/**
 * Protocol reminder hook script content for Copilot userPromptSubmitted.
 * Same content as the Codex version — fires before every user prompt.
 */
function buildCopilotProtocolReminderHookScript(): string {
    return [
        '#!/usr/bin/env node',
        "'use strict';",
        '// Iranti protocol reminder hook — fires on userPromptSubmitted for any Iranti project.',
        '// Cross-platform: runs on Windows, macOS, Linux via Node.js.',
        '// Exits cleanly with no output for non-Iranti projects.',
        "const fs = require('fs');",
        "const path = require('path');",
        '',
        "const envFile = path.join(process.cwd(), '.env.iranti');",
        'if (!fs.existsSync(envFile)) process.exit(0);',
        '',
        'const content = [',
        "  'IRANTI PROTOCOL (required this turn):',",
        "  '1. If handshake not yet called: call iranti_handshake FIRST — before clarifying, before reading files.',",
        "  '2. iranti_attend(phase=pre-response) BEFORE replying',",
        "  '3. iranti_attend BEFORE each Read / Grep / Glob / Bash / WebSearch / WebFetch',",
        "  '4. iranti_write AFTER each Edit or Write:',",
        "  '   entity: project/[id]/file/[filename] -- not the broad project entity',",
        "  '   value must include: absolutePath, lines, before, after, verify, why',",
        "  '5. iranti_write AFTER each Bash that reveals system state (build, errors, ports, env)',",
        "  '6. iranti_write AFTER each WebSearch/WebFetch -- write findings AND dead ends / 404s',",
        "  '7. iranti_attend(phase=post-response) AFTER every response without exception',",
        "].join('\\n') + '\\n';",
        "require('fs').writeSync(1, content);",
        '',
    ].join('\n');
}

/**
 * Write the protocol-reminder hook script into the project's .github/hooks/ directory.
 */
function writeCopilotProtocolReminderHook(projectEnv: string): WorkspaceFileResult {
    const projectPath = path.dirname(projectEnv);
    const hooksDir = path.join(projectPath, '.github', 'hooks');
    const hookFile = path.join(hooksDir, 'iranti-protocol-hook.js');
    const hookContent = buildCopilotProtocolReminderHookScript();

    fs.mkdirSync(hooksDir, { recursive: true });

    if (!fs.existsSync(hookFile)) {
        fs.writeFileSync(hookFile, hookContent, 'utf8');
        return { filePath: hookFile, status: 'created' };
    }

    const existing = fs.readFileSync(hookFile, 'utf8');
    if (existing !== hookContent) {
        fs.writeFileSync(hookFile, hookContent, 'utf8');
        return { filePath: hookFile, status: 'updated' };
    }

    return { filePath: hookFile, status: 'unchanged' };
}

/**
 * Write a .github/hooks/hooks.json referencing the protocol-reminder hook.
 * This fires on userPromptSubmitted — the Copilot CLI per-turn injection point.
 */
function writeCopilotHooksConfig(projectEnv: string): WorkspaceFileResult {
    const projectPath = path.dirname(projectEnv);
    const hooksDir = path.join(projectPath, '.github', 'hooks');
    const hooksConfigFile = path.join(hooksDir, 'hooks.json');

    const hooksConfig = {
        version: 1,
        hooks: {
            userPromptSubmitted: [
                {
                    type: 'command',
                    command: 'node .github/hooks/iranti-protocol-hook.js',
                },
            ],
        },
    };

    fs.mkdirSync(hooksDir, { recursive: true });

    const nextContent = `${JSON.stringify(hooksConfig, null, 2)}\n`;

    if (!fs.existsSync(hooksConfigFile)) {
        fs.writeFileSync(hooksConfigFile, nextContent, 'utf8');
        return { filePath: hooksConfigFile, status: 'created' };
    }

    const existing = fs.readFileSync(hooksConfigFile, 'utf8');
    if (existing === nextContent) {
        return { filePath: hooksConfigFile, status: 'unchanged' };
    }

    // Merge: keep existing hooks, add/replace userPromptSubmitted from iranti.
    try {
        const parsed = JSON.parse(existing) as Record<string, unknown>;
        const existingHooks = parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)
            ? parsed.hooks as Record<string, unknown>
            : {};
        const merged = {
            ...parsed,
            version: hooksConfig.version,
            hooks: {
                ...existingHooks,
                userPromptSubmitted: hooksConfig.hooks.userPromptSubmitted,
            },
        };
        const mergedContent = `${JSON.stringify(merged, null, 2)}\n`;
        if (mergedContent === existing) {
            return { filePath: hooksConfigFile, status: 'unchanged' };
        }
        fs.writeFileSync(hooksConfigFile, mergedContent, 'utf8');
        return { filePath: hooksConfigFile, status: 'updated' };
    } catch {
        fs.writeFileSync(hooksConfigFile, nextContent, 'utf8');
        return { filePath: hooksConfigFile, status: 'updated' };
    }
}

function canUseInstalledIranti(repoRoot: string): boolean {
    try {
        run('iranti', ['mcp', '--help'], repoRoot);
        return true;
    } catch {
        return false;
    }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const repoRoot = findPackageRoot(__dirname);
    const mcpScript = path.join(repoRoot, 'dist', 'scripts', 'iranti-mcp.js');

    const useInstalled = !options.useLocalScript && canUseInstalledIranti(repoRoot);
    if (!useInstalled && !fs.existsSync(mcpScript)) {
        throw new Error(`Missing build artifact: ${mcpScript}. Run "npm run build" first, or install iranti globally and rerun without --local-script.`);
    }

    const projectEnv = resolveProjectEnv(options);

    // ── Global registration: write ~/.copilot/mcp-config.json ──────────
    const globalServerEntry = makeGlobalMcpServerEntry(options, projectEnv, useInstalled, mcpScript);
    const globalResult = writeGlobalCopilotMcpConfig(options, globalServerEntry);

    console.log(`Global Copilot MCP config: ${globalResult.status} (${globalResult.configPath})`);
    console.log('');
    console.log('GitHub Copilot CLI is now configured to use Iranti through MCP.');
    console.log('Required host pattern:');
    console.log('  1. Run iranti_handshake at session start (or on the first safe user turn if startup hooks are unavailable).');
    console.log('  2. Run iranti_attend before each reply and before/after knowledge discovery.');
    console.log('  3. Run iranti_checkpoint at natural pauses, during interrupted work, and when completing a useful slice.');
    console.log('  4. Include key commands, tests, validations, and decisions in checkpoint actions when they matter to later recovery.');
    console.log('  5. Run iranti_write for confirmed durable findings, and pair ongoing work with iranti_checkpoint.');
    if (useInstalled) {
        console.log('Registration target: installed CLI (`iranti mcp`)');
    } else {
        console.log(`Registration target: repo build (${mcpScript})`);
    }
    if (projectEnv) {
        console.log(`Pinned project binding: ${projectEnv}`);
    } else {
        console.log('Project binding: not pinned; `iranti mcp` will resolve `.env.iranti` from the active project/workspace at runtime.');
    }

    // ── Workspace files ────────────────────────────────────────────────
    const workspaceProjectEnv = options.writeWorkspaceFile
        ? resolveWorkspaceProjectEnv(options)
        : undefined;
    const workspaceFilesResult: WorkspaceFilesResult | null = workspaceProjectEnv
        ? {
            mcp: writeWorkspaceMcpFile(workspaceProjectEnv, options),
            vscode: writeWorkspaceVsCodeMcpFile(workspaceProjectEnv, options),
            instructions: writeWorkspaceCopilotInstructionsFile(workspaceProjectEnv),
            irantiMd: writeWorkspaceIrantiMdFile(workspaceProjectEnv),
            hookScript: writeCopilotProtocolReminderHook(workspaceProjectEnv),
            hooksJson: writeCopilotHooksConfig(workspaceProjectEnv),
        }
        : null;

    if (options.writeWorkspaceFile) {
        if (workspaceFilesResult) {
            const boundProjectEnv = workspaceProjectEnv!;
            console.log(`Workspace .mcp.json: ${workspaceFilesResult.mcp.status} (${workspaceFilesResult.mcp.filePath})`);
            console.log(`Workspace .vscode/mcp.json: ${workspaceFilesResult.vscode.status} (${workspaceFilesResult.vscode.filePath})`);
            console.log(`Workspace .github/copilot-instructions.md: ${workspaceFilesResult.instructions.status} (${workspaceFilesResult.instructions.filePath})`);
            console.log(`Workspace IRANTI.md: ${workspaceFilesResult.irantiMd.status} (${workspaceFilesResult.irantiMd.filePath})`);
            console.log(`Workspace .github/hooks/iranti-protocol-hook.js: ${workspaceFilesResult.hookScript.status} (${workspaceFilesResult.hookScript.filePath})`);
            console.log(`Workspace .github/hooks/hooks.json: ${workspaceFilesResult.hooksJson.status} (${workspaceFilesResult.hooksJson.filePath})`);
            const closeout = await writeProjectScaffoldCloseout({
                tool: 'copilot',
                projectPath: path.dirname(boundProjectEnv),
                projectEnvFile: boundProjectEnv,
                files: [
                    { path: workspaceFilesResult.mcp.filePath, status: workspaceFilesResult.mcp.status },
                    { path: workspaceFilesResult.vscode.filePath, status: workspaceFilesResult.vscode.status },
                    { path: workspaceFilesResult.instructions.filePath, status: workspaceFilesResult.instructions.status },
                    { path: workspaceFilesResult.irantiMd.filePath, status: workspaceFilesResult.irantiMd.status },
                    { path: workspaceFilesResult.hookScript.filePath, status: workspaceFilesResult.hookScript.status },
                    { path: workspaceFilesResult.hooksJson.filePath, status: workspaceFilesResult.hooksJson.status },
                ],
                agentId: options.agent || 'copilot_code',
            });
            console.log(`Shared memory closeout: ${closeout.status} (${closeout.detail})`);
        } else {
            console.log('Workspace files: unchanged (no project binding found from the current working directory)');
            console.log('Shared memory closeout: skipped (no bound workspace project was found)');
        }
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
