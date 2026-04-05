import fs from 'node:fs';
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
    agents: WorkspaceFileResult;
    irantiMd: WorkspaceFileResult;
};

function parseArgs(argv: string[]): SetupOptions {
    const options: SetupOptions = {
        name: 'iranti',
        agent: 'codex_code',
        source: 'Codex',
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
        'Configure Codex to use the local Iranti MCP server.',
        '',
        'Usage:',
        '  ts-node scripts/codex-setup.ts [--name iranti] [--agent codex_code] [--source Codex] [--provider openai] [--project-env path] [--local-script] [--no-workspace-file]',
        '',
        'Notes:',
        '  - Registers a global Codex MCP entry using `codex mcp add`.',
        '  - Prefers the installed CLI path: `iranti mcp`.',
        '  - When a project binding is available, also writes or merges project-local `.mcp.json` and `.vscode/mcp.json` entries pinned to that binding.',
        '  - By default does not pin IRANTI_PROJECT_ENV, so Codex can resolve .env.iranti from the active project/workspace at runtime.',
        '  - Use --project-env only when you deliberately want to pin Codex globally to one project binding.',
        '  - Use --local-script only if you need to point Codex at this repo build directly.',
        '  - Use --no-workspace-file only if you explicitly want global registration without project-local MCP file updates.',
        '  - Does not store DATABASE_URL in Codex config; iranti-mcp loads project/instance env at runtime.',
        '  - Replaces any existing MCP entry with the same name.',
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

function tryRun(command: string, args: string[], cwd: string): string | null {
    try {
        return run(command, args, cwd);
    } catch {
        return null;
    }
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

function makeWorkspaceMcpServer(options: SetupOptions, projectEnv: string): Record<string, unknown> {
    const env: Record<string, string> = {
        IRANTI_PROJECT_ENV: projectEnv,
        IRANTI_MCP_DEFAULT_AGENT: options.agent,
        IRANTI_MCP_DEFAULT_SOURCE: options.source,
        IRANTI_MCP_HOST: 'codex_cli',
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
        IRANTI_MCP_HOST: 'codex_vscode',
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
 * Duplicated from iranti-cli.ts because codex-setup is a standalone script.
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
 * Slim AGENTS.md block — just points to IRANTI.md and triggers handshake.
 * This content lives in the system prompt on every turn, so keep it minimal.
 */
function buildCodexAgentsBlock(): string {
    return [
        '<!-- iranti-rules -->',
        '# Iranti',
        '',
        'This project uses Iranti for shared memory. Read `IRANTI.md` for the full protocol.',
        '',
        '- Call `mcp__iranti__iranti_handshake` before responding to the first user message.',
        '- If startup hooks are unavailable, do this on the first safe user turn.',
        '- Follow the attend/write/checkpoint protocol in IRANTI.md.',
        '<!-- /iranti-rules -->',
        '',
    ].join('\n');
}

function writeWorkspaceAgentsFile(projectEnv: string): WorkspaceFileResult {
    const projectPath = path.dirname(projectEnv);
    const agentsFile = path.join(projectPath, 'AGENTS.md');
    const irantiBlock = buildCodexAgentsBlock();

    if (!fs.existsSync(agentsFile)) {
        fs.writeFileSync(agentsFile, irantiBlock, 'utf8');
        return { filePath: agentsFile, status: 'created' };
    }

    const existing = fs.readFileSync(agentsFile, 'utf8');
    if (!existing.includes('<!-- iranti-rules -->')) {
        fs.writeFileSync(agentsFile, `${existing.trimEnd()}\n\n${irantiBlock}`, 'utf8');
        return { filePath: agentsFile, status: 'updated' };
    }

    const replaced = existing.replace(
        /<!-- iranti-rules -->[\s\S]*?<!-- \/iranti-rules -->/,
        irantiBlock.trim(),
    );
    if (replaced === existing) {
        return { filePath: agentsFile, status: 'unchanged' };
    }

    fs.writeFileSync(agentsFile, replaced, 'utf8');
    return { filePath: agentsFile, status: 'updated' };
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

function canUseInstalledIranti(repoRoot: string): boolean {
    try {
        run('iranti', ['mcp', '--help'], repoRoot);
        return true;
    } catch {
        return false;
    }
}

function ensureCodexInstalled(repoRoot: string): void {
    try {
        run('codex', ['--version'], repoRoot);
    } catch {
        throw new Error('Codex CLI is not installed or not on PATH. Install Codex first, confirm `codex --version` works, then rerun `iranti codex-setup`.');
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const repoRoot = findPackageRoot(__dirname);
    const mcpScript = path.join(repoRoot, 'dist', 'scripts', 'iranti-mcp.js');

    ensureCodexInstalled(repoRoot);

    const useInstalled = !options.useLocalScript && canUseInstalledIranti(repoRoot);
    if (!useInstalled && !fs.existsSync(mcpScript)) {
        throw new Error(`Missing build artifact: ${mcpScript}. Run "npm run build" first, or install iranti globally and rerun without --local-script.`);
    }

    const existing = tryRun('codex', ['mcp', 'get', options.name, '--json'], repoRoot);
    if (existing !== null) {
        run('codex', ['mcp', 'remove', options.name], repoRoot);
    }

    const addArgs = [
        'mcp',
        'add',
        options.name,
        '--env',
        `IRANTI_MCP_DEFAULT_AGENT=${options.agent}`,
        '--env',
        `IRANTI_MCP_DEFAULT_SOURCE=${options.source}`,
        '--env',
        'IRANTI_MCP_HOST=codex_cli',
    ];

    const projectEnv = resolveProjectEnv(options);
    if (projectEnv) {
        addArgs.push('--env', `IRANTI_PROJECT_ENV=${projectEnv}`);
    }

    if (options.provider) {
        addArgs.push('--env', `LLM_PROVIDER=${options.provider}`);
    }

    if (useInstalled) {
        addArgs.push('--', 'iranti', 'mcp');
    } else {
        addArgs.push('--', 'node', mcpScript);
    }
    run('codex', addArgs, repoRoot);

    const workspaceProjectEnv = options.writeWorkspaceFile
        ? resolveWorkspaceProjectEnv(options)
        : undefined;
    const workspaceFilesResult: WorkspaceFilesResult | null = workspaceProjectEnv
        ? {
            mcp: writeWorkspaceMcpFile(workspaceProjectEnv, options),
            vscode: writeWorkspaceVsCodeMcpFile(workspaceProjectEnv, options),
            agents: writeWorkspaceAgentsFile(workspaceProjectEnv),
            irantiMd: writeWorkspaceIrantiMdFile(workspaceProjectEnv),
        }
        : null;

    const registered = run('codex', ['mcp', 'get', options.name], repoRoot);
    console.log(registered);
    console.log('');
    console.log('Codex is now configured to use Iranti through MCP.');
    console.log('Required host pattern:');
    console.log('  1. Run iranti_handshake at session start (or on the first safe user turn if startup hooks are unavailable).');
    console.log('  2. Run iranti_attend before each reply and before/after knowledge discovery.');
    console.log('  3. Run iranti_checkpoint at natural pauses, during interrupted work, and when completing a useful slice.');
    console.log('  4. Include key commands, tests, validations, and decisions in checkpoint actions when they matter to later recovery.');
    console.log('  5. Run iranti_write for confirmed durable findings, and pair ongoing work with iranti_checkpoint.');
    if (useInstalled) {
        console.log('Registration target: installed CLI (`iranti mcp`)');
        if (projectEnv) {
            console.log(`Pinned project binding: ${projectEnv}`);
        } else {
            console.log('Project binding: not pinned; `iranti mcp` will resolve `.env.iranti` from the active project/workspace at runtime.');
        }
        console.log('Launch Codex in the project you want to bind to Iranti, for example:');
        console.log('  codex -C C:\\path\\to\\your\\project');
    } else {
        console.log(`Registration target: repo build (${mcpScript})`);
        if (projectEnv) {
            console.log(`Pinned project binding: ${projectEnv}`);
        } else {
            console.log('Project binding: not pinned; `iranti mcp` will resolve `.env.iranti` from the active project/workspace at runtime.');
        }
        console.log(`Launch with: codex -C "${repoRoot}"`);
    }
    if (options.writeWorkspaceFile) {
        if (workspaceFilesResult) {
            const boundProjectEnv = workspaceProjectEnv!;
            console.log(`Workspace .mcp.json: ${workspaceFilesResult.mcp.status} (${workspaceFilesResult.mcp.filePath})`);
            console.log(`Workspace .vscode/mcp.json: ${workspaceFilesResult.vscode.status} (${workspaceFilesResult.vscode.filePath})`);
            console.log(`Workspace AGENTS.md: ${workspaceFilesResult.agents.status} (${workspaceFilesResult.agents.filePath})`);
            console.log(`Workspace IRANTI.md: ${workspaceFilesResult.irantiMd.status} (${workspaceFilesResult.irantiMd.filePath})`);
            const closeout = await writeProjectScaffoldCloseout({
                tool: 'codex',
                projectPath: path.dirname(boundProjectEnv),
                projectEnvFile: boundProjectEnv,
                files: [
                    { path: workspaceFilesResult.mcp.filePath, status: workspaceFilesResult.mcp.status },
                    { path: workspaceFilesResult.vscode.filePath, status: workspaceFilesResult.vscode.status },
                    { path: workspaceFilesResult.agents.filePath, status: workspaceFilesResult.agents.status },
                    { path: workspaceFilesResult.irantiMd.filePath, status: workspaceFilesResult.irantiMd.status },
                ],
                agentId: options.agent || 'codex_code',
            });
            console.log(`Shared memory closeout: ${closeout.status} (${closeout.detail})`);
        } else {
            console.log('Workspace MCP files: unchanged (no project binding found from the current working directory)');
            console.log('Shared memory closeout: skipped (no bound workspace project was found)');
        }
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
