import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type SetupOptions = {
    name: string;
    agent: string;
    source: string;
    provider?: string;
};

function parseArgs(argv: string[]): SetupOptions {
    const options: SetupOptions = {
        name: 'iranti',
        agent: 'codex_code',
        source: 'Codex',
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
        '  ts-node scripts/codex-setup.ts [--name iranti] [--agent codex_code] [--source Codex] [--provider openai]',
        '',
        'Notes:',
        '  - Registers a global Codex MCP entry using `codex mcp add`.',
        '  - Does not store DATABASE_URL in Codex config; iranti-mcp loads .env from this repo at runtime.',
        '  - Replaces any existing MCP entry with the same name.',
    ].join('\n'));
}

function run(command: string, args: string[], cwd: string): string {
    const result = spawnSync(command, args, {
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

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    const repoRoot = path.resolve(__dirname, '..');
    const mcpScript = path.join(repoRoot, 'dist', 'scripts', 'iranti-mcp.js');

    if (!fs.existsSync(mcpScript)) {
        throw new Error(`Missing build artifact: ${mcpScript}. Run "npm run build" first.`);
    }

    run('codex', ['--version'], repoRoot);

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

    if (options.provider) {
        addArgs.push('--env', `LLM_PROVIDER=${options.provider}`);
    }

    addArgs.push('--', 'node', mcpScript);
    run('codex', addArgs, repoRoot);

    const registered = run('codex', ['mcp', 'get', options.name], repoRoot);
    console.log(registered);
    console.log('');
    console.log('Codex is now configured to use Iranti through MCP.');
    console.log(`Launch with: codex -C "${repoRoot}"`);
}

main();
