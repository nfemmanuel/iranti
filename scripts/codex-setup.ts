import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type SetupOptions = {
    name: string;
    agent: string;
    source: string;
    provider?: string;
    projectEnv?: string;
    useLocalScript: boolean;
};

function parseArgs(argv: string[]): SetupOptions {
    const options: SetupOptions = {
        name: 'iranti',
        agent: 'codex_code',
        source: 'Codex',
        useLocalScript: false,
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
        '  ts-node scripts/codex-setup.ts [--name iranti] [--agent codex_code] [--source Codex] [--provider openai] [--project-env path] [--local-script]',
        '',
        'Notes:',
        '  - Registers a global Codex MCP entry using `codex mcp add`.',
        '  - Prefers the installed CLI path: `iranti mcp`.',
        '  - Auto-detects .env.iranti from the current working directory and stores it as IRANTI_PROJECT_ENV.',
        '  - Use --local-script only if you need to point Codex at this repo build directly.',
        '  - Does not store DATABASE_URL in Codex config; iranti-mcp loads project/instance env at runtime.',
        '  - Replaces any existing MCP entry with the same name.',
    ].join('\n'));
}

function quoteForCmd(arg: string): string {
    if (arg.length === 0) return '""';
    if (!/[ \t"&()<>|^]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '\\"')}"`;
}

function run(command: string, args: string[], cwd: string): string {
    const result = process.platform === 'win32'
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', [
            '/d',
            '/c',
            [command, ...args].map(quoteForCmd).join(' '),
        ], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        : spawnSync(command, args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const stderr = (result.stderr || '').trim();
        const stdout = (result.stdout || '').trim();
        throw new Error(stderr || stdout || `${command} exited with status ${result.status}`);
    }

    return (result.stdout || '').trim();
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

    const candidate = path.resolve(process.cwd(), '.env.iranti');
    return fs.existsSync(candidate) ? candidate : undefined;
}

function canUseInstalledIranti(repoRoot: string): boolean {
    try {
        run('iranti', ['mcp', '--help'], repoRoot);
        return true;
    } catch {
        return false;
    }
}

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    const repoRoot = findPackageRoot(__dirname);
    const mcpScript = path.join(repoRoot, 'dist', 'scripts', 'iranti-mcp.js');

    run('codex', ['--version'], repoRoot);

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

    const registered = run('codex', ['mcp', 'get', options.name], repoRoot);
    console.log(registered);
    console.log('');
    console.log('Codex is now configured to use Iranti through MCP.');
    if (useInstalled) {
        console.log('Registration target: installed CLI (`iranti mcp`)');
        if (projectEnv) {
            console.log(`Project binding: ${projectEnv}`);
        }
        console.log('Launch Codex in the project you want to bind to Iranti, for example:');
        console.log('  codex -C C:\\path\\to\\your\\project');
    } else {
        console.log(`Registration target: repo build (${mcpScript})`);
        if (projectEnv) {
            console.log(`Project binding: ${projectEnv}`);
        }
        console.log(`Launch with: codex -C "${repoRoot}"`);
    }
}

main();
