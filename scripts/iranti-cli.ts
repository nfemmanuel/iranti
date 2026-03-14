#!/usr/bin/env node
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

type Scope = 'user' | 'system';

type ParsedArgs = {
    command: string | null;
    subcommand: string | null;
    positionals: string[];
    flags: Map<string, string | boolean>;
};

type InstallMeta = {
    version: string;
    scope: Scope;
    root: string;
    installedAt: string;
};

type InstanceMeta = {
    name: string;
    createdAt: string;
    port: number;
    envFile: string;
    instanceDir: string;
};

type DoctorStatus = 'pass' | 'warn' | 'fail';

type DoctorCheck = {
    name: string;
    status: DoctorStatus;
    detail: string;
};

function parseArgs(argv: string[]): ParsedArgs {
    const flags = new Map<string, string | boolean>();
    const positionals: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) {
                flags.set(key, true);
            } else {
                flags.set(key, next);
                i++;
            }
            continue;
        }
        positionals.push(token);
    }

    return {
        command: positionals[0] ?? null,
        subcommand: positionals[1] ?? null,
        positionals: positionals.slice(2),
        flags,
    };
}

function getFlag(args: ParsedArgs, key: string): string | undefined {
    const value = args.flags.get(key);
    return typeof value === 'string' ? value : undefined;
}

function hasFlag(args: ParsedArgs, key: string): boolean {
    return Boolean(args.flags.get(key));
}

function normalizeScope(raw: string | undefined): Scope {
    if (!raw) return 'user';
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'user' || normalized === 'system') return normalized;
    throw new Error(`Invalid scope '${raw}'. Use --scope user or --scope system.`);
}

function defaultInstallRoot(scope: Scope): string {
    const platform = process.platform;
    if (platform === 'win32') {
        if (scope === 'system') {
            const programData = process.env.ProgramData ?? 'C:\\ProgramData';
            return path.join(programData, 'Iranti');
        }
        return path.join(os.homedir(), '.iranti');
    }
    if (platform === 'darwin') {
        if (scope === 'system') return '/Library/Application Support/Iranti';
        return path.join(os.homedir(), 'Library', 'Application Support', 'iranti');
    }
    // linux and other unix-like
    if (scope === 'system') return '/var/lib/iranti';
    return path.join(os.homedir(), '.local', 'share', 'iranti');
}

function resolveInstallRoot(args: ParsedArgs, scope: Scope): string {
    const explicit = getFlag(args, 'root') ?? process.env.IRANTI_HOME;
    if (explicit) return path.resolve(explicit);

    const userRoot = defaultInstallRoot('user');
    const systemRoot = defaultInstallRoot('system');

    const userMeta = path.join(userRoot, 'install.json');
    const systemMeta = path.join(systemRoot, 'install.json');

    if (scope === 'system') return systemRoot;
    if (fs.existsSync(userMeta)) return userRoot;
    if (fs.existsSync(systemMeta)) return systemRoot;
    return userRoot;
}

function getPackageVersion(): string {
    let dir = __dirname;
    for (let i = 0; i < 5; i++) {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const raw = fs.readFileSync(pkgPath, 'utf-8');
                const pkg = JSON.parse(raw);
                return String(pkg.version ?? '0.0.0');
            } catch {
                return '0.0.0';
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return '0.0.0';
}

async function ensureDir(dir: string): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeText(filePath: string, content: string): Promise<void> {
    await fsp.writeFile(filePath, content, 'utf-8');
}

async function readEnvFile(filePath: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const raw = await fsp.readFile(filePath, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        const valueRaw = trimmed.slice(idx + 1).trim();
        const value =
            (valueRaw.startsWith('"') && valueRaw.endsWith('"')) ||
            (valueRaw.startsWith("'") && valueRaw.endsWith("'"))
                ? valueRaw.slice(1, -1)
                : valueRaw;
        out[key] = value;
    }
    return out;
}

function makeInstanceEnv(name: string, port: number, dbUrl: string, apiKey: string | undefined, instanceDir: string): string {
    const lines = [
        '# Iranti instance env',
        `IRANTI_INSTANCE_NAME=${name}`,
        `IRANTI_PORT=${port}`,
        `DATABASE_URL=${dbUrl}`,
        'LLM_PROVIDER=mock',
        `IRANTI_ESCALATION_DIR=${path.join(instanceDir, 'escalation')}`,
        `IRANTI_REQUEST_LOG_FILE=${path.join(instanceDir, 'logs', 'api-requests.log')}`,
        'IRANTI_ARCHIVIST_WATCH=true',
        'IRANTI_ARCHIVIST_DEBOUNCE_MS=60000',
        'IRANTI_ARCHIVIST_INTERVAL_MS=0',
        `IRANTI_API_KEY=${apiKey ?? 'replace_me_with_api_key'}`,
        '',
    ];
    return lines.join('\n');
}

function detectPlaceholder(value: string | undefined): boolean {
    if (!value) return true;
    const normalized = value.trim().toLowerCase();
    return normalized.length === 0
        || normalized.includes('yourpassword')
        || normalized.includes('replace_me')
        || normalized.includes('your_secret')
        || normalized.includes('your_key_here')
        || normalized.includes('your_api_key')
        || normalized === 'changeme';
}

function detectProviderKey(provider: string | undefined, env: Record<string, string>): DoctorCheck {
    const normalized = (provider ?? 'mock').trim().toLowerCase();
    if (normalized === 'mock' || normalized === 'ollama') {
        return {
            name: 'provider credentials',
            status: 'pass',
            detail: `${normalized} does not require a remote API key for local diagnostics.`,
        };
    }

    const keyMap: Record<string, string> = {
        gemini: 'GEMINI_API_KEY',
        claude: 'ANTHROPIC_API_KEY',
        openai: 'OPENAI_API_KEY',
        groq: 'GROQ_API_KEY',
        mistral: 'MISTRAL_API_KEY',
    };

    const envKey = keyMap[normalized];
    if (!envKey) {
        return {
            name: 'provider credentials',
            status: 'warn',
            detail: `Unknown provider '${normalized}'. Doctor cannot verify its API key requirement.`,
        };
    }

    return detectPlaceholder(env[envKey])
        ? {
            name: 'provider credentials',
            status: 'fail',
            detail: `${envKey} is missing or still uses a placeholder value for provider '${normalized}'.`,
        }
        : {
            name: 'provider credentials',
            status: 'pass',
            detail: `${envKey} is set for provider '${normalized}'.`,
        };
}

function summarizeStatus(checks: DoctorCheck[]): DoctorStatus {
    if (checks.some((check) => check.status === 'fail')) return 'fail';
    if (checks.some((check) => check.status === 'warn')) return 'warn';
    return 'pass';
}

async function doctorCommand(args: ParsedArgs): Promise<void> {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const instanceName = getFlag(args, 'instance');
    const explicitEnv = getFlag(args, 'env');
    const json = hasFlag(args, 'json');
    const cwd = process.cwd();

    let envFile: string | null = null;
    let envSource = 'repo';

    if (explicitEnv) {
        envFile = path.resolve(explicitEnv);
        envSource = 'explicit-env';
    } else if (instanceName) {
        const root = resolveInstallRoot(args, scope);
        envFile = path.join(root, 'instances', instanceName, '.env');
        envSource = `instance:${instanceName}`;
    } else {
        const repoEnv = path.join(cwd, '.env');
        const projectEnv = path.join(cwd, '.env.iranti');
        if (fs.existsSync(repoEnv)) {
            envFile = repoEnv;
            envSource = 'repo';
        } else if (fs.existsSync(projectEnv)) {
            envFile = projectEnv;
            envSource = 'project-binding';
        }
    }

    const checks: DoctorCheck[] = [];
    const version = getPackageVersion();

    checks.push({
        name: 'node version',
        status: Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 18 ? 'pass' : 'fail',
        detail: `Node ${process.versions.node}`,
    });

    const distCli = path.resolve(__dirname, 'iranti-cli.js');
    checks.push({
        name: 'cli build artifact',
        status: fs.existsSync(distCli) ? 'pass' : 'warn',
        detail: fs.existsSync(distCli)
            ? `Found built CLI at ${distCli}`
            : 'Built CLI artifact not found. This is acceptable in ts-node/dev mode but packaged installs should include dist.',
    });

    if (!envFile) {
        checks.push({
            name: 'environment file',
            status: 'fail',
            detail: 'No .env, .env.iranti, or --env/--instance target found from the current working directory.',
        });
    } else if (!fs.existsSync(envFile)) {
        checks.push({
            name: 'environment file',
            status: 'fail',
            detail: `Expected env file not found: ${envFile}`,
        });
    } else {
        const env = await readEnvFile(envFile);
        checks.push({
            name: 'environment file',
            status: 'pass',
            detail: `${envSource} env loaded from ${envFile}`,
        });

        const databaseUrl = env.DATABASE_URL;
        checks.push(detectPlaceholder(databaseUrl)
            ? {
                name: 'database configuration',
                status: 'fail',
                detail: 'DATABASE_URL is missing or still uses a placeholder value.',
            }
            : {
                name: 'database configuration',
                status: 'pass',
                detail: 'DATABASE_URL is present and non-placeholder.',
            });

        if (envSource === 'project-binding') {
            checks.push(detectPlaceholder(env.IRANTI_URL)
                ? {
                    name: 'project binding url',
                    status: 'fail',
                    detail: 'IRANTI_URL is missing or placeholder in .env.iranti.',
                }
                : {
                    name: 'project binding url',
                    status: 'pass',
                    detail: `IRANTI_URL=${env.IRANTI_URL}`,
                });
        }

        if (envSource === 'project-binding') {
            checks.push(detectPlaceholder(env.IRANTI_API_KEY)
                ? {
                    name: 'project api key',
                    status: 'fail',
                    detail: 'IRANTI_API_KEY is missing or placeholder in .env.iranti.',
                }
                : {
                    name: 'project api key',
                    status: 'pass',
                    detail: 'IRANTI_API_KEY is present in .env.iranti.',
                });
        } else {
            checks.push(detectPlaceholder(env.IRANTI_API_KEY)
                ? {
                    name: 'api key',
                    status: 'warn',
                    detail: 'IRANTI_API_KEY is missing or placeholder. Public health works, but protected routes and project bindings will fail.',
                }
                : {
                    name: 'api key',
                    status: 'pass',
                    detail: 'IRANTI_API_KEY is present.',
                });
        }

        const provider = env.LLM_PROVIDER ?? 'mock';
        checks.push({
            name: 'llm provider',
            status: 'pass',
            detail: `LLM_PROVIDER=${provider}`,
        });
        checks.push(detectProviderKey(provider, env));
    }

    const result = {
        version,
        envSource,
        envFile,
        status: summarizeStatus(checks),
        checks,
    };

    if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log(`Iranti doctor`);
    console.log(`  version : ${version}`);
    console.log(`  status  : ${result.status.toUpperCase()}`);
    if (envFile) console.log(`  env     : ${envFile}`);
    console.log('');
    for (const check of checks) {
        const marker = check.status === 'pass' ? '[PASS]' : check.status === 'warn' ? '[WARN]' : '[FAIL]';
        console.log(`${marker} ${check.name} — ${check.detail}`);
    }

    if (result.status !== 'pass') {
        process.exitCode = 1;
    }
}

async function installCommand(args: ParsedArgs): Promise<void> {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);

    await ensureDir(root);
    await ensureDir(path.join(root, 'instances'));
    await ensureDir(path.join(root, 'logs'));
    await ensureDir(path.join(root, 'tmp'));

    const meta: InstallMeta = {
        version: getPackageVersion(),
        scope,
        root,
        installedAt: new Date().toISOString(),
    };
    await writeJson(path.join(root, 'install.json'), meta);

    console.log(`Iranti runtime initialized`);
    console.log(`  scope: ${scope}`);
    console.log(`  root : ${root}`);
    console.log(`Next: iranti instance create local --port 3001`);
}

async function createInstanceCommand(args: ParsedArgs): Promise<void> {
    const name = args.positionals[0];
    if (!name) {
        throw new Error('Missing instance name. Usage: iranti instance create <name> [--port 3001]');
    }
    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const portRaw = getFlag(args, 'port') ?? '3001';
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid --port '${portRaw}'.`);

    const dbUrl =
        getFlag(args, 'db-url') ??
        `postgresql://postgres:yourpassword@localhost:5432/iranti_${name}`;
    const apiKey = getFlag(args, 'api-key');

    const instanceDir = path.join(root, 'instances', name);
    const envFile = path.join(instanceDir, '.env');
    if (fs.existsSync(instanceDir) && !hasFlag(args, 'force')) {
        throw new Error(`Instance '${name}' already exists at ${instanceDir}. Use --force to overwrite.`);
    }

    await ensureDir(instanceDir);
    await ensureDir(path.join(instanceDir, 'logs'));
    await ensureDir(path.join(instanceDir, 'escalation', 'active'));
    await ensureDir(path.join(instanceDir, 'escalation', 'resolved'));
    await ensureDir(path.join(instanceDir, 'escalation', 'archived'));

    await writeText(envFile, makeInstanceEnv(name, port, dbUrl, apiKey, instanceDir));
    const meta: InstanceMeta = {
        name,
        createdAt: new Date().toISOString(),
        port,
        envFile,
        instanceDir,
    };
    await writeJson(path.join(instanceDir, 'instance.json'), meta);

    console.log(`Instance created: ${name}`);
    console.log(`  dir : ${instanceDir}`);
    console.log(`  env : ${envFile}`);
    console.log(`  port: ${port}`);
    console.log(`Next: iranti instance show ${name}`);
}

async function listInstancesCommand(args: ParsedArgs): Promise<void> {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const instancesDir = path.join(root, 'instances');
    if (!fs.existsSync(instancesDir)) {
        console.log(`No install found at ${root}. Run: iranti install`);
        return;
    }
    const entries = await fsp.readdir(instancesDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    if (dirs.length === 0) {
        console.log(`No instances found under ${instancesDir}`);
        return;
    }
    console.log(`Instances (${instancesDir}):`);
    for (const name of dirs) {
        const metaPath = path.join(instancesDir, name, 'instance.json');
        if (fs.existsSync(metaPath)) {
            try {
                const raw = await fsp.readFile(metaPath, 'utf-8');
                const meta = JSON.parse(raw) as InstanceMeta;
                console.log(`  - ${name} (port ${meta.port})`);
                continue;
            } catch {
                // fall through
            }
        }
        console.log(`  - ${name}`);
    }
}

async function showInstanceCommand(args: ParsedArgs): Promise<void> {
    const name = args.positionals[0];
    if (!name) throw new Error('Missing instance name. Usage: iranti instance show <name>');
    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const instanceDir = path.join(root, 'instances', name);
    const envFile = path.join(instanceDir, '.env');
    if (!fs.existsSync(envFile)) throw new Error(`Instance '${name}' not found at ${instanceDir}`);

    const env = await readEnvFile(envFile);
    console.log(`Instance: ${name}`);
    console.log(`  dir : ${instanceDir}`);
    console.log(`  env : ${envFile}`);
    console.log(`  port: ${env.IRANTI_PORT ?? '3001'}`);
    console.log(`  db  : ${env.DATABASE_URL ?? '(missing)'}`);
    console.log(`  esc : ${env.IRANTI_ESCALATION_DIR ?? '(missing)'}`);
    console.log(`Run with: iranti run --instance ${name}`);
}

async function runInstanceCommand(args: ParsedArgs): Promise<void> {
    const name = getFlag(args, 'instance') ?? args.positionals[0] ?? args.subcommand;
    if (!name) throw new Error('Missing instance name. Usage: iranti run --instance <name>');
    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const envFile = path.join(root, 'instances', name, '.env');
    if (!fs.existsSync(envFile)) throw new Error(`Instance '${name}' not found. Create it first.`);

    const env = await readEnvFile(envFile);
    for (const [k, v] of Object.entries(env)) {
        process.env[k] = v;
    }

    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('yourpassword')) {
        throw new Error(`Instance '${name}' has placeholder DATABASE_URL. Edit ${envFile} first.`);
    }

    console.log(`Starting Iranti instance '${name}' on port ${process.env.IRANTI_PORT ?? '3001'}...`);
    const serverEntry = path.resolve(__dirname, '..', 'src', 'api', 'server');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require(serverEntry);
}

async function projectInitCommand(args: ParsedArgs): Promise<void> {
    const projectPath = path.resolve(args.positionals[0] ?? process.cwd());
    const instanceName = getFlag(args, 'instance');
    if (!instanceName) {
        throw new Error('Missing --instance <name>. Usage: iranti project init [path] --instance <name>');
    }
    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const envFile = path.join(root, 'instances', instanceName, '.env');
    if (!fs.existsSync(envFile)) throw new Error(`Instance '${instanceName}' not found. Create it first.`);

    const instanceEnv = await readEnvFile(envFile);
    const port = instanceEnv.IRANTI_PORT ?? '3001';
    const apiKey = getFlag(args, 'api-key') ?? instanceEnv.IRANTI_API_KEY ?? 'replace_me_with_api_key';
    const agentId = getFlag(args, 'agent-id') ?? 'my_agent';

    await ensureDir(projectPath);
    const outFile = path.join(projectPath, '.env.iranti');
    if (fs.existsSync(outFile) && !hasFlag(args, 'force')) {
        throw new Error(`${outFile} already exists. Use --force to overwrite.`);
    }

    const content = [
        '# Iranti project binding',
        `IRANTI_URL=http://localhost:${port}`,
        `IRANTI_API_KEY=${apiKey}`,
        `IRANTI_AGENT_ID=${agentId}`,
        'IRANTI_MEMORY_ENTITY=user/main',
        `IRANTI_INSTANCE=${instanceName}`,
        `IRANTI_INSTANCE_ENV=${envFile}`,
        '',
    ].join('\n');
    await writeText(outFile, content);

    const gitignorePath = path.join(projectPath, '.gitignore');
    const requiredLines = ['.env.iranti', '.env.iranti.local'];
    if (fs.existsSync(gitignorePath)) {
        const raw = await fsp.readFile(gitignorePath, 'utf-8');
        const existing = new Set(raw.split(/\r?\n/));
        const missing = requiredLines.filter((line) => !existing.has(line));
        if (missing.length > 0) {
            await fsp.writeFile(gitignorePath, `${raw.trimEnd()}\n${missing.join('\n')}\n`, 'utf-8');
        }
    } else {
        await writeText(gitignorePath, `${requiredLines.join('\n')}\n`);
    }

    console.log(`Project initialized at ${projectPath}`);
    console.log(`  wrote ${outFile}`);
    console.log(`Use with Python client/middleware by loading .env.iranti`);
}

function printHelp(): void {
    console.log(`Iranti CLI

Machine-level:
  iranti install [--scope user|system] [--root <path>]

Instance-level:
  iranti instance create <name> [--port 3001] [--db-url <url>] [--api-key <token>] [--scope user|system]
  iranti instance list [--scope user|system]
  iranti instance show <name> [--scope user|system]
  iranti run --instance <name> [--scope user|system]

Project-level:
  iranti project init [path] --instance <name> [--api-key <token>] [--agent-id <id>] [--force]

Diagnostics:
  iranti doctor [--instance <name>] [--scope user|system] [--env <file>] [--json]
`);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (!args.command || args.command === 'help' || args.command === '--help') {
        printHelp();
        return;
    }

    if (args.command === 'install') {
        await installCommand(args);
        return;
    }

    if (args.command === 'instance') {
        if (args.subcommand === 'create') {
            await createInstanceCommand(args);
            return;
        }
        if (args.subcommand === 'list') {
            await listInstancesCommand(args);
            return;
        }
        if (args.subcommand === 'show') {
            await showInstanceCommand(args);
            return;
        }
        throw new Error(`Unknown instance subcommand '${args.subcommand ?? ''}'.`);
    }

    if (args.command === 'run') {
        await runInstanceCommand(args);
        return;
    }

    if (args.command === 'project' && args.subcommand === 'init') {
        await projectInitCommand(args);
        return;
    }

    if (args.command === 'doctor') {
        await doctorCommand(args);
        return;
    }

    throw new Error(`Unknown command '${args.command}'. Run: iranti help`);
}

main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
});
