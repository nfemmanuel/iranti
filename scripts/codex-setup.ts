import fs from 'node:fs';
import path from 'node:path';
import { spawnSyncResolved } from '../src/lib/commandInvocation';

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
        '  - Expected host pattern: call iranti_handshake at session start (or on the first user turn if startup hooks are unavailable), then call iranti_attend before each reply.',
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

function main(): void {
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
    const workspaceFilesResult = workspaceProjectEnv
        ? {
            mcp: writeWorkspaceMcpFile(workspaceProjectEnv, options),
            vscode: writeWorkspaceVsCodeMcpFile(workspaceProjectEnv, options),
        }
        : null;

    const registered = run('codex', ['mcp', 'get', options.name], repoRoot);
    console.log(registered);
    console.log('');
    console.log('Codex is now configured to use Iranti through MCP.');
    console.log('Recommended MCP host pattern: run iranti_handshake at session start (or on the first user turn if no startup hook exists), then run iranti_attend before each reply.');
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
            console.log(`Workspace .mcp.json: ${workspaceFilesResult.mcp.status} (${workspaceFilesResult.mcp.filePath})`);
            console.log(`Workspace .vscode/mcp.json: ${workspaceFilesResult.vscode.status} (${workspaceFilesResult.vscode.filePath})`);
        } else {
            console.log('Workspace MCP files: unchanged (no project binding found from the current working directory)');
        }
    }
}

main();
