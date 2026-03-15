#!/usr/bin/env node
import fs from 'fs';
import fsp from 'fs/promises';
import https from 'https';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import readline from 'readline/promises';
import { Writable } from 'stream';
import net from 'net';
import { initDb } from '../src/library/client';
import { createOrRotateApiKey, formatApiKeyToken, generateApiKeySecret, listApiKeys, revokeApiKey } from '../src/security/apiKeys';
import { getEscalationPaths } from '../src/lib/escalationPaths';
import { resolveInteractive } from '../src/resolutionist';
import { startChatSession } from '../src/chat';
import { createVectorBackend, resolveVectorBackendName } from '../src/library/backends';

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

type StatusRow = {
    label: string;
    value: string;
};

type DoctorEnvTarget = {
    envFile: string | null;
    envSource: string;
};

type UpgradeTarget = 'auto' | 'npm-global' | 'npm-repo' | 'python';

type UpgradeCommand = {
    label: string;
    display: string;
    executable: string;
    args: string[];
    cwd?: string;
};

type UpgradeExecutionResult = {
    target: Exclude<UpgradeTarget, 'auto'>;
    steps: Array<{ label: string; command: string }>;
    verification: {
        status: 'pass' | 'warn' | 'fail';
        detail: string;
    };
};

type ProviderKeyTarget = {
    instanceName?: string;
    envFile: string;
    env: Record<string, string>;
    source: 'instance' | 'project-binding';
    bindingFile?: string;
    projectPath?: string;
};

const PROVIDER_ENV_KEYS: Record<string, string | null> = {
    mock: null,
    ollama: null,
    gemini: 'GEMINI_API_KEY',
    claude: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    groq: 'GROQ_API_KEY',
    mistral: 'MISTRAL_API_KEY',
};

const REMOTE_PROVIDER_ORDER = ['openai', 'claude', 'gemini', 'groq', 'mistral'] as const;
const LOCAL_PROVIDER_ORDER = ['mock', 'ollama'] as const;

const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
} as const;

function useColor(): boolean {
    return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

function paint(text: string, color: keyof typeof ANSI): string {
    if (!useColor()) return text;
    return `${ANSI[color]}${text}${ANSI.reset}`;
}

function bold(text: string): string {
    return useColor() ? `${ANSI.bold}${text}${ANSI.reset}` : text;
}

function okLabel(text = 'SUCCESS'): string {
    return paint(`[${text}]`, 'green');
}

function warnLabel(text = 'WARN'): string {
    return paint(`[${text}]`, 'yellow');
}

function failLabel(text = 'FAIL'): string {
    return paint(`[${text}]`, 'red');
}

function infoLabel(text = 'INFO'): string {
    return paint(`[${text}]`, 'cyan');
}

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
    const pkgPath = path.join(packageRoot(), 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const raw = fs.readFileSync(pkgPath, 'utf-8');
            const pkg = JSON.parse(raw);
            return String(pkg.version ?? '0.0.0');
        } catch {
            return '0.0.0';
        }
    }
    return '0.0.0';
}

function packageRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return process.cwd();
}

function builtScriptPath(scriptName: string): string {
    return path.resolve(__dirname, `${scriptName}.js`);
}

function formatSetupBootstrapFailure(error: unknown): Error {
    const reason = error instanceof Error ? error.message : String(error);
    return new Error(
        `Database bootstrap failed after instance configuration. ` +
        `Common causes are a non-empty database that Prisma has not baselined yet, or a PostgreSQL server without the pgvector extension installed. ` +
        `Re-run setup without --bootstrap-db, or point Iranti at a fresh pgvector-capable database. ` +
        `Underlying error: ${reason}`
    );
}

async function handoffToScript(scriptName: string, rawArgs: string[]): Promise<void> {
    const builtPath = builtScriptPath(scriptName);
    if (fs.existsSync(builtPath)) {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [builtPath, ...rawArgs], {
                stdio: 'inherit',
                env: process.env,
            });
            child.on('error', reject);
            child.on('exit', (code, signal) => {
                if (signal) {
                    reject(new Error(`${scriptName} terminated with signal ${signal}`));
                    return;
                }
                if ((code ?? 0) !== 0) {
                    process.exit(code ?? 1);
                }
                resolve();
            });
        });
        return;
    }

    const sourcePath = path.resolve(process.cwd(), 'scripts', `${scriptName}.ts`);
    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Unable to locate ${scriptName} implementation.`);
    }

    await new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['ts-node', sourcePath, ...rawArgs], {
            stdio: 'inherit',
            env: process.env,
            shell: process.platform === 'win32',
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`${scriptName} terminated with signal ${signal}`));
                return;
            }
            if ((code ?? 0) !== 0) {
                process.exit(code ?? 1);
            }
            resolve();
        });
    });
}

async function runBundledScript(scriptName: string, rawArgs: string[], extraEnv?: Record<string, string | undefined>): Promise<void> {
    const builtPath = builtScriptPath(scriptName);
    if (!fs.existsSync(builtPath)) {
        throw new Error(`Unable to locate bundled script: ${scriptName}`);
    }

    await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [builtPath, ...rawArgs], {
            stdio: 'inherit',
            env: {
                ...process.env,
                ...extraEnv,
            },
            cwd: packageRoot(),
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`${scriptName} terminated with signal ${signal}`));
                return;
            }
            if ((code ?? 0) !== 0) {
                reject(new Error(`${scriptName} exited with code ${code ?? 1}`));
                return;
            }
            resolve();
        });
    });
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

function normalizeProvider(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const normalized = raw.trim().toLowerCase();
    if (!normalized) return undefined;
    return normalized;
}

function providerKeyEnv(provider: string | undefined): string | undefined {
    const normalized = normalizeProvider(provider);
    if (!normalized) return undefined;
    const envKey = PROVIDER_ENV_KEYS[normalized];
    return envKey ?? undefined;
}

function formatEnvValue(value: string): string {
    if (value === '') return '""';
    return /[\s#"'`]/.test(value)
        ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        : value;
}

function vectorBackendUrl(name: string, env: Record<string, string>): string | null {
    if (name === 'qdrant') return env.IRANTI_QDRANT_URL ?? null;
    if (name === 'chroma') return env.IRANTI_CHROMA_URL ?? 'http://localhost:8000';
    return null;
}

async function upsertEnvFile(filePath: string, updates: Record<string, string | undefined>): Promise<void> {
    const existingRaw = fs.existsSync(filePath) ? await fsp.readFile(filePath, 'utf-8') : '';
    const lines = existingRaw.length > 0 ? existingRaw.split(/\r?\n/) : [];
    const pending = new Map<string, string | undefined>(Object.entries(updates));
    const nextLines: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            nextLines.push(line);
            continue;
        }

        const idx = line.indexOf('=');
        if (idx <= 0) {
            nextLines.push(line);
            continue;
        }

        const key = line.slice(0, idx).trim();
        if (!pending.has(key)) {
            nextLines.push(line);
            continue;
        }

        const nextValue = pending.get(key);
        pending.delete(key);
        if (nextValue === undefined) {
            continue;
        }

        nextLines.push(`${key}=${formatEnvValue(nextValue)}`);
    }

    for (const [key, value] of pending.entries()) {
        if (value === undefined) continue;
        nextLines.push(`${key}=${formatEnvValue(value)}`);
    }

    const finalLines = nextLines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '')
        .trimEnd();

    await writeText(filePath, `${finalLines}\n`);
}

function redactSecret(value: string | undefined): string {
    if (!value) return '(unset)';
    if (value.length <= 8) return '********';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function instancePaths(root: string, name: string): { instanceDir: string; envFile: string; metaFile: string } {
    const instanceDir = path.join(root, 'instances', name);
    return {
        instanceDir,
        envFile: path.join(instanceDir, '.env'),
        metaFile: path.join(instanceDir, 'instance.json'),
    };
}

async function loadInstanceEnv(root: string, name: string): Promise<{ instanceDir: string; envFile: string; metaFile: string; env: Record<string, string> }> {
    const paths = instancePaths(root, name);
    if (!fs.existsSync(paths.envFile)) {
        throw new Error(`Instance '${name}' not found at ${paths.instanceDir}`);
    }
    return {
        ...paths,
        env: await readEnvFile(paths.envFile),
    };
}

async function resolveProviderKeyTarget(args: ParsedArgs): Promise<ProviderKeyTarget> {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const explicitInstance = getFlag(args, 'instance');
    if (explicitInstance) {
        const root = resolveInstallRoot(args, scope);
        const loaded = await loadInstanceEnv(root, explicitInstance);
        return {
            instanceName: explicitInstance,
            envFile: loaded.envFile,
            env: loaded.env,
            source: 'instance',
        };
    }

    const projectPath = path.resolve(getFlag(args, 'project') ?? process.cwd());
    const bindingFile = path.join(projectPath, '.env.iranti');
    if (!fs.existsSync(bindingFile)) {
        throw new Error('No --instance provided and no .env.iranti found in the current project. Run from a bound project or pass --instance <name>.');
    }

    const binding = await readEnvFile(bindingFile);
    const envFile = binding.IRANTI_INSTANCE_ENV?.trim();
    if (!envFile) {
        throw new Error(`Project binding is missing IRANTI_INSTANCE_ENV: ${bindingFile}`);
    }
    if (!fs.existsSync(envFile)) {
        throw new Error(`Instance env referenced by project binding was not found: ${envFile}`);
    }

    return {
        instanceName: binding.IRANTI_INSTANCE?.trim() || undefined,
        envFile,
        env: await readEnvFile(envFile),
        source: 'project-binding',
        bindingFile,
        projectPath,
    };
}

function providerDisplayName(provider: string): string {
    return provider === 'claude'
        ? 'Claude'
        : provider === 'gemini'
            ? 'Gemini'
            : provider === 'groq'
                ? 'Groq'
                : provider === 'mistral'
                    ? 'Mistral'
                    : provider === 'openai'
                        ? 'OpenAI'
                        : provider === 'ollama'
                            ? 'Ollama'
                            : provider === 'mock'
                                ? 'Mock'
                                : provider;
}

function listProviderChoices(currentProvider: string | undefined, env: Record<string, string>): void {
    console.log(infoLabel('INFO'), 'Available provider API keys:');
    for (const provider of REMOTE_PROVIDER_ORDER) {
        const envKey = providerKeyEnv(provider)!;
        const stored = detectPlaceholder(env[envKey]) ? paint('missing', 'gray') : paint('stored', 'green');
        const current = currentProvider === provider ? paint(' current', 'cyan') : '';
        console.log(`  - ${provider.padEnd(8)} ${stored}${current}`);
    }
    for (const provider of LOCAL_PROVIDER_ORDER) {
        const current = currentProvider === provider ? paint(' current', 'cyan') : '';
        console.log(`  - ${provider.padEnd(8)} ${paint('no remote key required', 'gray')}${current}`);
    }
    console.log(`  - perplexity ${paint('not yet supported', 'gray')}`);
}

async function chooseProvider(args: ParsedArgs, target: ProviderKeyTarget, promptLabel: string): Promise<string> {
    const currentProvider = normalizeProvider(target.env.LLM_PROVIDER ?? 'mock');
    const provided = normalizeProvider(args.positionals[0] ?? getFlag(args, 'provider'));
    if (provided) {
        return provided;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(`Missing provider. Supported providers: ${REMOTE_PROVIDER_ORDER.join(', ')}.`);
    }

    let selected: string | undefined;
    await withPromptSession(async (prompt) => {
        listProviderChoices(currentProvider, target.env);
        selected = normalizeProvider(await prompt.line(promptLabel, currentProvider ?? 'openai'));
    });

    if (!selected) {
        throw new Error('Provider selection is required.');
    }
    return selected;
}

async function ensureProjectGitignore(projectPath: string): Promise<void> {
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
}

async function writeProjectBinding(projectPath: string, updates: Record<string, string | undefined>): Promise<string> {
    await ensureDir(projectPath);
    const outFile = path.join(projectPath, '.env.iranti');
    if (!fs.existsSync(outFile)) {
        await writeText(outFile, '# Iranti project binding\n');
    }
    await upsertEnvFile(outFile, updates);
    await ensureProjectGitignore(projectPath);
    return outFile;
}

type PromptSession = {
    line: (prompt: string, currentValue?: string) => Promise<string | undefined>;
    secret: (prompt: string, currentValue?: string) => Promise<string | undefined>;
};

type SetupProjectBinding = {
    projectPath: string;
    envFile: string;
    agentId: string;
};

type SetupProjectPlan = {
    path: string;
    agentId: string;
    memoryEntity: string;
    claudeCode?: boolean;
};

type SetupExecutionPlan = {
    mode: 'shared' | 'isolated';
    scope: Scope;
    root: string;
    instanceName: string;
    port: number;
    databaseUrl: string;
    provider: string;
    providerKeys: Record<string, string>;
    apiKey: string;
    projects: SetupProjectPlan[];
    codexAgent?: string;
    codex?: boolean;
    bootstrapDatabase?: boolean;
};

type SetupExecutionResult = {
    root: string;
    scope: Scope;
    instanceName: string;
    instanceEnvFile: string;
    port: number;
    bindings: SetupProjectBinding[];
};

async function withPromptSession<T>(run: (session: PromptSession) => Promise<T>): Promise<T> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('--interactive requires a real terminal session.');
    }

    let muted = false;
    const maskedOutput = new Writable({
        write(chunk, encoding, callback) {
            if (!muted) {
                process.stdout.write(chunk, encoding as BufferEncoding);
            }
            callback();
        },
    });

    const rl = readline.createInterface({
        input: process.stdin,
        output: maskedOutput,
    });
    const session: PromptSession = {
        line: async (prompt: string, currentValue?: string) => {
            const suffix = currentValue !== undefined ? ` [${currentValue}]` : '';
            const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
            return answer.length > 0 ? answer : currentValue;
        },
        secret: async (prompt: string, currentValue?: string) => {
            const placeholder = currentValue ? `${redactSecret(currentValue)} (enter new value to replace)` : 'leave blank to skip';
            const suffix = placeholder ? ` [${placeholder}]` : '';
            muted = true;
            const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
            muted = false;
            process.stdout.write('\n');
            if (!answer || answer === placeholder) return currentValue;
            if (answer === '__clear__') return undefined;
            return answer;
        },
    };

    try {
        return await run(session);
    } finally {
        rl.close();
    }
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

function sanitizeIdentifier(input: string, fallback: string): string {
    const value = input.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return value || fallback;
}

function projectAgentDefault(projectPath: string): string {
    return `${sanitizeIdentifier(path.basename(projectPath), 'project')}_main`;
}

function isSupportedProvider(provider: string | undefined): boolean {
    const normalized = normalizeProvider(provider);
    if (!normalized) return false;
    return Object.prototype.hasOwnProperty.call(PROVIDER_ENV_KEYS, normalized);
}

async function promptYesNo(session: PromptSession, prompt: string, defaultValue: boolean): Promise<boolean> {
    const defaultToken = defaultValue ? 'Y/n' : 'y/N';
    while (true) {
        const answer = (await session.line(`${prompt} (${defaultToken})`, '') ?? '').trim().toLowerCase();
        if (!answer) return defaultValue;
        if (['y', 'yes'].includes(answer)) return true;
        if (['n', 'no'].includes(answer)) return false;
        console.log(`${warnLabel()} Please answer yes or no.`);
    }
}

async function promptNonEmpty(session: PromptSession, prompt: string, currentValue?: string): Promise<string> {
    while (true) {
        const value = (await session.line(prompt, currentValue) ?? '').trim();
        if (value.length > 0) return value;
        console.log(`${warnLabel()} ${prompt} is required.`);
    }
}

async function promptRequiredSecret(session: PromptSession, prompt: string, currentValue?: string): Promise<string> {
    while (true) {
        const value = (await session.secret(prompt, currentValue) ?? '').trim();
        if (value.length > 0 && !detectPlaceholder(value)) return value;
        console.log(`${warnLabel()} A real secret is required.`);
    }
}

function makeLegacyInstanceApiKey(instanceName: string): string {
    const keyId = sanitizeIdentifier(`${instanceName}_${os.userInfo().username}`, 'iranti');
    return formatApiKeyToken(keyId, generateApiKeySecret());
}

async function ensureRuntimeInstalled(root: string, scope: Scope): Promise<void> {
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
}

async function ensureInstanceConfigured(
    root: string,
    name: string,
    config: {
        port: number;
        dbUrl: string;
        provider: string;
        providerKeys: Record<string, string>;
        apiKey: string;
    }
): Promise<{ envFile: string; instanceDir: string; created: boolean }> {
    const { instanceDir, envFile, metaFile } = instancePaths(root, name);
    const created = !fs.existsSync(envFile);

    if (created) {
        await ensureDir(instanceDir);
        await ensureDir(path.join(instanceDir, 'logs'));
        await ensureDir(path.join(instanceDir, 'escalation', 'active'));
        await ensureDir(path.join(instanceDir, 'escalation', 'resolved'));
        await ensureDir(path.join(instanceDir, 'escalation', 'archived'));
        await writeText(envFile, makeInstanceEnv(name, config.port, config.dbUrl, config.apiKey, instanceDir));
        const meta: InstanceMeta = {
            name,
            createdAt: new Date().toISOString(),
            port: config.port,
            envFile,
            instanceDir,
        };
        await writeJson(metaFile, meta);
    }

    await upsertEnvFile(envFile, {
        IRANTI_PORT: String(config.port),
        DATABASE_URL: config.dbUrl,
        IRANTI_API_KEY: config.apiKey,
        LLM_PROVIDER: config.provider,
        ...config.providerKeys,
    });

    return { envFile, instanceDir, created };
}

async function writeClaudeCodeProjectFiles(projectPath: string): Promise<void> {
    const mcpFile = path.join(projectPath, '.mcp.json');
    if (!fs.existsSync(mcpFile)) {
        await writeText(mcpFile, `${JSON.stringify({
            mcpServers: {
                iranti: {
                    command: 'iranti',
                    args: ['mcp'],
                },
            },
        }, null, 2)}\n`);
    }

    const claudeDir = path.join(projectPath, '.claude');
    await ensureDir(claudeDir);
    const settingsFile = path.join(claudeDir, 'settings.local.json');
    if (!fs.existsSync(settingsFile)) {
        await writeText(settingsFile, `${JSON.stringify({
            hooks: {
                SessionStart: [
                    {
                        command: 'iranti',
                        args: ['claude-hook', '--event', 'SessionStart'],
                    },
                ],
                UserPromptSubmit: [
                    {
                        command: 'iranti',
                        args: ['claude-hook', '--event', 'UserPromptSubmit'],
                    },
                ],
            },
        }, null, 2)}\n`);
    }
}

function hasCodexInstalled(): boolean {
    try {
        const proc = process.platform === 'win32'
            ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'codex --version'], { stdio: 'ignore' })
            : spawnSync('codex', ['--version'], { stdio: 'ignore' });
        return proc.status === 0;
    } catch {
        return false;
    }
}

function hasDockerInstalled(): boolean {
    try {
        const proc = process.platform === 'win32'
            ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'docker --version'], { stdio: 'ignore' })
            : spawnSync('docker', ['--version'], { stdio: 'ignore' });
        return proc.status === 0;
    } catch {
        return false;
    }
}

async function isPortAvailable(port: number, host: string = '127.0.0.1'): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const server = net.createServer();
        server.unref();
        server.on('error', () => resolve(false));
        server.listen(port, host, () => {
            server.close(() => resolve(true));
        });
    });
}

async function findNextAvailablePort(start: number, host: string = '127.0.0.1', maxSteps: number = 50): Promise<number> {
    for (let port = start; port < start + maxSteps; port += 1) {
        if (await isPortAvailable(port, host)) {
            return port;
        }
    }
    throw new Error(`No available port found in range ${start}-${start + maxSteps - 1}.`);
}

async function chooseAvailablePort(session: PromptSession, promptText: string, preferredPort: number, allowOccupiedCurrent: boolean = false): Promise<number> {
    let suggested = preferredPort;
    if (!allowOccupiedCurrent && !(await isPortAvailable(preferredPort))) {
        suggested = await findNextAvailablePort(preferredPort + 1);
        console.log(`${warnLabel()} Port ${preferredPort} is already in use. Suggested port: ${suggested}`);
    }

    while (true) {
        const raw = await promptNonEmpty(session, promptText, String(suggested));
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            console.log(`${warnLabel()} Port must be a positive integer.`);
            continue;
        }
        if (allowOccupiedCurrent && parsed === preferredPort) {
            return parsed;
        }
        if (await isPortAvailable(parsed)) {
            return parsed;
        }
        const next = await findNextAvailablePort(parsed + 1);
        console.log(`${warnLabel()} Port ${parsed} is already in use. Try ${next} instead.`);
        suggested = next;
    }
}

async function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ready = await new Promise<boolean>((resolve) => {
            const socket = net.connect({ host, port });
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => {
                socket.destroy();
                resolve(false);
            });
        });
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for ${host}:${port} to accept TCP connections.`);
}

async function runDockerPostgresContainer(options: {
    containerName: string;
    hostPort: number;
    password: string;
    database: string;
}): Promise<void> {
    const inspect = process.platform === 'win32'
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `docker ps -a --format "{{.Names}}"`], { encoding: 'utf8' })
        : spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' });
    const names = (inspect.stdout ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);

    if (names.includes(options.containerName)) {
        const start = process.platform === 'win32'
            ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `docker start ${options.containerName}`], { stdio: 'inherit' })
            : spawnSync('docker', ['start', options.containerName], { stdio: 'inherit' });
        if (start.status !== 0) {
            throw new Error(`Failed to start existing Docker container '${options.containerName}'.`);
        }
    } else {
        const args = [
            'run',
            '-d',
            '--name',
            options.containerName,
            '-e',
            `POSTGRES_USER=postgres`,
            '-e',
            `POSTGRES_PASSWORD=${options.password}`,
            '-e',
            `POSTGRES_DB=${options.database}`,
            '-p',
            `${options.hostPort}:5432`,
            'pgvector/pgvector:pg16',
        ];
        const result = process.platform === 'win32'
            ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', ['docker', ...args].join(' ')], { stdio: 'inherit' })
            : spawnSync('docker', args, { stdio: 'inherit' });
        if (result.status !== 0) {
            throw new Error(`Failed to start Docker PostgreSQL container '${options.containerName}'.`);
        }
    }

    await waitForTcpPort('127.0.0.1', options.hostPort, 30000);
}

async function executeSetupPlan(plan: SetupExecutionPlan): Promise<SetupExecutionResult> {
    await ensureRuntimeInstalled(plan.root, plan.scope);

    const configured = await ensureInstanceConfigured(plan.root, plan.instanceName, {
        port: plan.port,
        dbUrl: plan.databaseUrl,
        provider: plan.provider,
        providerKeys: plan.providerKeys,
        apiKey: plan.apiKey,
    });

    if (plan.bootstrapDatabase) {
        try {
            await runBundledScript('setup', [], {
                DATABASE_URL: plan.databaseUrl,
                IRANTI_ESCALATION_DIR: path.join(configured.instanceDir, 'escalation'),
            });
        } catch (error) {
            throw formatSetupBootstrapFailure(error);
        }
    }

    const bindings: SetupProjectBinding[] = [];
    for (const project of plan.projects) {
        const projectPath = path.resolve(project.path);
        const written = await writeProjectBinding(projectPath, {
            IRANTI_URL: `http://localhost:${plan.port}`,
            IRANTI_API_KEY: plan.apiKey,
            IRANTI_AGENT_ID: project.agentId,
            IRANTI_MEMORY_ENTITY: project.memoryEntity,
            IRANTI_INSTANCE: plan.instanceName,
            IRANTI_INSTANCE_ENV: configured.envFile,
        });
        bindings.push({ projectPath, envFile: written, agentId: project.agentId });
        if (project.claudeCode) {
            await writeClaudeCodeProjectFiles(projectPath);
        }
    }

    if (plan.codex && bindings.length > 0) {
        if (!hasCodexInstalled()) {
            throw new Error('Codex is not installed, so codex registration could not be completed.');
        }
        await handoffToScript('codex-setup', [
            '--agent',
            plan.codexAgent ?? bindings[0].agentId,
            '--project-env',
            bindings[0].envFile,
        ]);
    }

    return {
        root: plan.root,
        scope: plan.scope,
        instanceName: plan.instanceName,
        instanceEnvFile: configured.envFile,
        port: plan.port,
        bindings,
    };
}

function parseSetupConfig(filePath: string): SetupExecutionPlan {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Setup config file not found: ${resolved}`);
    }
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as any;
    const mode = raw?.mode === 'isolated' ? 'isolated' : 'shared';
    const scope: Scope = raw?.scope === 'system' ? 'system' : 'user';
    const root = path.resolve(String(raw?.root ?? defaultInstallRoot(scope)));
    const instanceName = sanitizeIdentifier(String(raw?.instanceName ?? raw?.instance ?? 'local'), 'local');
    const port = Number.parseInt(String(raw?.port ?? 3001), 10);
    if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`Invalid setup config port: ${raw?.port}`);
    }
    const databaseUrl = String(raw?.databaseUrl ?? raw?.dbUrl ?? '').trim();
    if (!databaseUrl || detectPlaceholder(databaseUrl)) {
        throw new Error('Setup config requires a non-placeholder databaseUrl.');
    }
    const provider = normalizeProvider(String(raw?.provider ?? 'mock')) ?? 'mock';
    if (!isSupportedProvider(provider)) {
        throw new Error(`Unsupported provider in setup config: ${provider}`);
    }

    const providerKeysInput = raw?.providerKeys && typeof raw.providerKeys === 'object' ? raw.providerKeys : {};
    const providerKeys: Record<string, string> = {};
    for (const [providerName, value] of Object.entries(providerKeysInput)) {
        const normalized = normalizeProvider(providerName);
        const envKey = providerKeyEnv(normalized);
        if (!normalized || !envKey) continue;
        const secret = String(value ?? '').trim();
        if (!secret || detectPlaceholder(secret)) continue;
        providerKeys[envKey] = secret;
    }

    const apiKeyRaw = String(raw?.apiKey ?? '').trim();
    const apiKey = apiKeyRaw && !detectPlaceholder(apiKeyRaw)
        ? apiKeyRaw
        : makeLegacyInstanceApiKey(instanceName);

    const projectsInput = Array.isArray(raw?.projects) ? raw.projects : [];
    const projects: SetupProjectPlan[] = projectsInput.map((item: any) => ({
        path: path.resolve(String(item?.path ?? process.cwd())),
        agentId: sanitizeIdentifier(String(item?.agentId ?? projectAgentDefault(String(item?.path ?? process.cwd()))), 'project_main'),
        memoryEntity: String(item?.memoryEntity ?? 'user/main'),
        claudeCode: item?.claudeCode !== false,
    }));

    return {
        mode,
        scope,
        root,
        instanceName,
        port,
        databaseUrl,
        provider,
        providerKeys,
        apiKey,
        projects,
        codex: Boolean(raw?.codex),
        codexAgent: raw?.codexAgent ? sanitizeIdentifier(String(raw.codexAgent), 'codex_code') : undefined,
        bootstrapDatabase: Boolean(raw?.bootstrapDatabase),
    };
}

function defaultsSetupPlan(args: ParsedArgs): SetupExecutionPlan {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = path.resolve(getFlag(args, 'root') ?? resolveInstallRoot(args, scope));
    const instanceName = sanitizeIdentifier(getFlag(args, 'instance') ?? 'local', 'local');
    const port = Number.parseInt(getFlag(args, 'port') ?? '3001', 10);
    if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`Invalid --port '${getFlag(args, 'port')}'.`);
    }

    const databaseUrl = (getFlag(args, 'db-url') ?? process.env.DATABASE_URL ?? '').trim();
    if (!databaseUrl || detectPlaceholder(databaseUrl)) {
        throw new Error('--defaults requires a real DATABASE_URL via --db-url or the DATABASE_URL environment variable.');
    }

    const provider = normalizeProvider(getFlag(args, 'provider') ?? process.env.LLM_PROVIDER ?? 'mock') ?? 'mock';
    if (!isSupportedProvider(provider)) {
        throw new Error(`Unsupported provider '${provider}' for --defaults.`);
    }

    const providerKeys: Record<string, string> = {};
    for (const candidate of REMOTE_PROVIDER_ORDER) {
        const envKey = providerKeyEnv(candidate);
        if (!envKey) continue;
        const secret = (process.env[envKey] ?? '').trim();
        if (secret && !detectPlaceholder(secret)) {
            providerKeys[envKey] = secret;
        }
    }

    const apiKeyRaw = (getFlag(args, 'api-key') ?? process.env.IRANTI_API_KEY ?? '').trim();
    const apiKey = apiKeyRaw && !detectPlaceholder(apiKeyRaw)
        ? apiKeyRaw
        : makeLegacyInstanceApiKey(instanceName);

    const projectsFlag = (getFlag(args, 'projects') ?? '').trim();
    const projects = projectsFlag
        ? projectsFlag.split(',').map((item) => item.trim()).filter(Boolean).map((projectPath) => ({
            path: path.resolve(projectPath),
            agentId: projectAgentDefault(projectPath),
            memoryEntity: 'user/main',
            claudeCode: hasFlag(args, 'claude-code'),
        }))
        : [];

    return {
        mode: 'shared',
        scope,
        root,
        instanceName,
        port,
        databaseUrl,
        provider,
        providerKeys,
        apiKey,
        projects,
        codex: hasFlag(args, 'codex'),
        codexAgent: sanitizeIdentifier(getFlag(args, 'codex-agent') ?? 'codex_code', 'codex_code'),
        bootstrapDatabase: hasFlag(args, 'bootstrap-db'),
    };
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

function resolveDoctorEnvTarget(args: ParsedArgs): DoctorEnvTarget {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const instanceName = getFlag(args, 'instance');
    const explicitEnv = getFlag(args, 'env');
    const cwd = process.cwd();

    if (explicitEnv) {
        return {
            envFile: path.resolve(explicitEnv),
            envSource: 'explicit-env',
        };
    }

    if (instanceName) {
        const root = resolveInstallRoot(args, scope);
        return {
            envFile: path.join(root, 'instances', instanceName, '.env'),
            envSource: `instance:${instanceName}`,
        };
    }

    const repoEnv = path.join(cwd, '.env');
    const projectEnv = path.join(cwd, '.env.iranti');
    if (fs.existsSync(repoEnv)) {
        return { envFile: repoEnv, envSource: 'repo' };
    }
    if (fs.existsSync(projectEnv)) {
        return { envFile: projectEnv, envSource: 'project-binding' };
    }

    return { envFile: null, envSource: 'repo' };
}

function resolveUpgradeTarget(raw: string | undefined): UpgradeTarget {
    if (!raw) return 'auto';
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'auto' || normalized === 'npm-global' || normalized === 'npm-repo' || normalized === 'python') {
        return normalized;
    }
    throw new Error(`Invalid --target '${raw}'. Use auto, npm-global, npm-repo, or python.`);
}

function parseVersion(value: string | null | undefined): number[] {
    if (!value) return [0];
    const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!match) return [0];
    return [
        Number.parseInt(match[1] ?? '0', 10),
        Number.parseInt(match[2] ?? '0', 10),
        Number.parseInt(match[3] ?? '0', 10),
    ];
}

function compareVersions(left: string | null | undefined, right: string | null | undefined): number {
    const a = parseVersion(left);
    const b = parseVersion(right);
    const limit = Math.max(a.length, b.length, 3);
    for (let i = 0; i < limit; i++) {
        const av = a[i] ?? 0;
        const bv = b[i] ?? 0;
        if (av > bv) return 1;
        if (av < bv) return -1;
    }
    return 0;
}

function normalizePathForCompare(value: string): string {
    return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}

function isPathInside(parentDir: string, childDir: string): boolean {
    const parent = normalizePathForCompare(parentDir);
    const child = normalizePathForCompare(childDir);
    return child === parent || child.startsWith(`${parent}/`);
}

function resolveSpawnExecutable(executable: string): string {
    if (process.platform !== 'win32') return executable;
    if (executable === 'npm') return 'npm.cmd';
    if (executable === 'npx') return 'npx.cmd';
    return executable;
}

function runCommandCapture(executable: string, args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
    const proc = spawnSync(resolveSpawnExecutable(executable), args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
        status: proc.status,
        stdout: proc.stdout ?? '',
        stderr: proc.stderr ?? '',
    };
}

function runCommandInteractive(step: UpgradeCommand): number | null {
    const proc = spawnSync(resolveSpawnExecutable(step.executable), step.args, {
        cwd: step.cwd,
        stdio: 'inherit',
    });
    return proc.status;
}

function detectPythonLauncher(): UpgradeCommand | null {
    const candidates: UpgradeCommand[] = process.platform === 'win32'
        ? [
            { label: 'python', display: 'python -m pip install --upgrade iranti', executable: 'python', args: ['-m', 'pip', 'install', '--upgrade', 'iranti'] },
            { label: 'py', display: 'py -3 -m pip install --upgrade iranti', executable: 'py', args: ['-3', '-m', 'pip', 'install', '--upgrade', 'iranti'] },
        ]
        : [
            { label: 'python3', display: 'python3 -m pip install --upgrade iranti', executable: 'python3', args: ['-m', 'pip', 'install', '--upgrade', 'iranti'] },
            { label: 'python', display: 'python -m pip install --upgrade iranti', executable: 'python', args: ['-m', 'pip', 'install', '--upgrade', 'iranti'] },
        ];

    for (const candidate of candidates) {
        const probeArgs = candidate.args[0] === '-3' ? ['-3', '--version'] : ['--version'];
        const probe = runCommandCapture(candidate.executable, probeArgs);
        if (probe.status === 0) return candidate;
    }
    return null;
}

function detectGlobalNpmRoot(): string | null {
    const proc = runCommandCapture('npm', ['root', '-g']);
    if (proc.status !== 0) return null;
    const value = proc.stdout.trim();
    return value ? path.resolve(value) : null;
}

function readJsonFile<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

function httpsJson(url: string, headers: Record<string, string> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        const request = https.get(url, { headers }, (response) => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
                response.resume();
                const redirect = new URL(response.headers.location, url).toString();
                httpsJson(redirect, headers).then(resolve).catch(reject);
                return;
            }
            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                reject(new Error(`HTTP ${statusCode} from ${url}`));
                return;
            }
            let raw = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                raw += chunk;
            });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(raw));
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.setTimeout(5000, () => {
            request.destroy(new Error(`Timed out fetching ${url}`));
        });
        request.on('error', reject);
    });
}

async function fetchLatestNpmVersion(): Promise<string | null> {
    try {
        const payload = await httpsJson('https://registry.npmjs.org/iranti/latest');
        return typeof payload?.version === 'string' ? payload.version : null;
    } catch {
        return null;
    }
}

async function fetchLatestPypiVersion(): Promise<string | null> {
    try {
        const payload = await httpsJson('https://pypi.org/pypi/iranti/json');
        return typeof payload?.info?.version === 'string' ? payload.info.version : null;
    } catch {
        return null;
    }
}

function repoUpgradeCommands(root: string): UpgradeCommand[] {
    return [
        { label: 'git pull', display: 'git pull --ff-only', executable: 'git', args: ['pull', '--ff-only'], cwd: root },
        { label: 'npm install', display: 'npm install', executable: 'npm', args: ['install'], cwd: root },
        { label: 'npm build', display: 'npm run build', executable: 'npm', args: ['run', 'build'], cwd: root },
    ];
}

function repoIsDirty(root: string): boolean {
    const proc = runCommandCapture('git', ['status', '--porcelain'], root);
    return proc.status === 0 && proc.stdout.trim().length > 0;
}

function detectUpgradeContext(args: ParsedArgs): {
    packageRootPath: string;
    currentVersion: string;
    runtimeRoot: string;
    runtimeInstalled: boolean;
    repoCheckout: boolean;
    globalNpmInstall: boolean;
    globalNpmRoot: string | null;
    python: UpgradeCommand | null;
    availableTargets: Exclude<UpgradeTarget, 'auto'>[];
} {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const packageRootPath = packageRoot();
    const runtimeRoot = resolveInstallRoot(args, scope);
    const runtimeInstalled = fs.existsSync(path.join(runtimeRoot, 'install.json'));
    const repoCheckout = fs.existsSync(path.join(packageRootPath, '.git'));
    const globalNpmRoot = detectGlobalNpmRoot();
    const globalNpmInstall = globalNpmRoot !== null && isPathInside(globalNpmRoot, packageRootPath);
    const python = detectPythonLauncher();
    const availableTargets: Exclude<UpgradeTarget, 'auto'>[] = [];
    if (globalNpmInstall) availableTargets.push('npm-global');
    if (repoCheckout) availableTargets.push('npm-repo');
    if (python) availableTargets.push('python');
    return {
        packageRootPath,
        currentVersion: getPackageVersion(),
        runtimeRoot,
        runtimeInstalled,
        repoCheckout,
        globalNpmInstall,
        globalNpmRoot,
        python,
        availableTargets,
    };
}

function chooseUpgradeTarget(
    requested: UpgradeTarget,
    context: ReturnType<typeof detectUpgradeContext>
): Exclude<UpgradeTarget, 'auto'> | null {
    if (requested !== 'auto') {
        if (!context.availableTargets.includes(requested)) {
            throw new Error(`Requested target '${requested}' is not available in this environment.`);
        }
        return requested;
    }
    if (context.repoCheckout) return 'npm-repo';
    if (context.globalNpmInstall) return 'npm-global';
    if (context.python) return 'python';
    return null;
}

function commandListForTarget(
    target: Exclude<UpgradeTarget, 'auto'>,
    context: ReturnType<typeof detectUpgradeContext>
): UpgradeCommand[] {
    if (target === 'npm-repo') {
        return repoUpgradeCommands(context.packageRootPath);
    }
    if (target === 'npm-global') {
        return [{
            label: 'npm global',
            display: 'npm install -g iranti@latest',
            executable: 'npm',
            args: ['install', '-g', 'iranti@latest'],
            cwd: context.packageRootPath,
        }];
    }
    if (!context.python) {
        throw new Error('Python launcher not found for python upgrade target.');
    }
    return [context.python];
}

async function refreshInstallMetaVersion(runtimeRoot: string, version: string): Promise<void> {
    const installMetaPath = path.join(runtimeRoot, 'install.json');
    const meta = readJsonFile<InstallMeta>(installMetaPath);
    if (!meta) return;
    await writeJson(installMetaPath, {
        ...meta,
        version,
        upgradedAt: new Date().toISOString(),
    });
}

function verifyGlobalNpmInstall(): { status: 'pass' | 'warn' | 'fail'; detail: string } {
    const proc = runCommandCapture('npm', ['list', '-g', 'iranti', '--depth=0', '--json']);
    if (proc.status !== 0) {
        return {
            status: 'warn',
            detail: 'npm global upgrade finished, but `npm list -g iranti` did not return cleanly.',
        };
    }
    try {
        const payload = JSON.parse(proc.stdout);
        const version = payload?.dependencies?.iranti?.version;
        return typeof version === 'string'
            ? { status: 'pass', detail: `npm global install reports iranti@${version}.` }
            : { status: 'warn', detail: 'npm global upgrade finished, but installed version could not be confirmed.' };
    } catch {
        return {
            status: 'warn',
            detail: 'npm global upgrade finished, but version verification output was unreadable.',
        };
    }
}

function verifyPythonInstall(command: UpgradeCommand): { status: 'pass' | 'warn' | 'fail'; detail: string } {
    const args = command.executable === 'py' ? ['-3', '-m', 'pip', 'show', 'iranti'] : ['-m', 'pip', 'show', 'iranti'];
    const proc = runCommandCapture(command.executable, args);
    if (proc.status !== 0) {
        return {
            status: 'warn',
            detail: 'Python upgrade finished, but `pip show iranti` did not confirm the installed version.',
        };
    }
    const versionLine = proc.stdout.split(/\r?\n/).find((line) => line.toLowerCase().startsWith('version:'));
    return versionLine
        ? { status: 'pass', detail: `Python client ${versionLine.trim()}.` }
        : { status: 'warn', detail: 'Python upgrade finished, but installed version could not be confirmed.' };
}

async function executeUpgradeTarget(
    target: Exclude<UpgradeTarget, 'auto'>,
    context: ReturnType<typeof detectUpgradeContext>
): Promise<UpgradeExecutionResult> {
    if (target === 'npm-repo' && repoIsDirty(context.packageRootPath)) {
        throw new Error('Repository worktree is dirty. Commit or stash changes before running `iranti upgrade --target npm-repo --yes`.');
    }

    const commands = commandListForTarget(target, context);
    const steps: Array<{ label: string; command: string }> = [];
    for (const command of commands) {
        console.log(`${infoLabel()} ${command.display}`);
        const status = runCommandInteractive(command);
        steps.push({ label: command.label, command: command.display });
        if (status !== 0) {
            throw new Error(`Upgrade step failed: ${command.display}`);
        }
    }

    const verification = target === 'npm-global'
        ? verifyGlobalNpmInstall()
        : target === 'python'
            ? verifyPythonInstall(commands[0]!)
            : { status: 'pass' as const, detail: 'Repository refresh completed and build succeeded.' };

    if (context.runtimeInstalled && verification.status !== 'fail') {
        const nextVersion = target === 'python' ? context.currentVersion : (await fetchLatestNpmVersion()) ?? context.currentVersion;
        await refreshInstallMetaVersion(context.runtimeRoot, nextVersion);
    }

    return { target, steps, verification };
}

async function listProviderKeysCommand(args: ParsedArgs): Promise<void> {
    const target = await resolveProviderKeyTarget(args);
    const currentProvider = normalizeProvider(target.env.LLM_PROVIDER ?? 'mock');

    if (hasFlag(args, 'json')) {
        const providers = [
            ...REMOTE_PROVIDER_ORDER.map((provider) => {
                const envKey = providerKeyEnv(provider)!;
                return {
                    provider,
                    envKey,
                    stored: !detectPlaceholder(target.env[envKey]),
                    current: currentProvider === provider,
                    supported: true,
                };
            }),
            ...LOCAL_PROVIDER_ORDER.map((provider) => ({
                provider,
                envKey: null,
                stored: true,
                current: currentProvider === provider,
                supported: true,
            })),
            {
                provider: 'perplexity',
                envKey: 'PERPLEXITY_API_KEY',
                stored: false,
                current: false,
                supported: false,
            },
        ];
        console.log(JSON.stringify({
            target: {
                instanceName: target.instanceName ?? null,
                envFile: target.envFile,
                source: target.source,
                bindingFile: target.bindingFile ?? null,
                projectPath: target.projectPath ?? null,
                currentProvider: currentProvider ?? null,
            },
            providers,
        }, null, 2));
        return;
    }

    console.log(bold('Iranti provider keys'));
    console.log(`  target    ${target.envFile}`);
    if (target.instanceName) console.log(`  instance  ${target.instanceName}`);
    if (target.bindingFile) console.log(`  binding   ${target.bindingFile}`);
    console.log('');
    listProviderChoices(currentProvider, target.env);
}

async function upsertProviderKeyCommand(args: ParsedArgs, mode: 'add' | 'update'): Promise<void> {
    const target = await resolveProviderKeyTarget(args);
    const provider = await chooseProvider(args, target, 'Which provider would you like to store a key for?');
    const envKey = providerKeyEnv(provider);
    if (!envKey) {
        throw new Error(`Provider '${provider}' does not use a remote API key.`);
    }

    const existing = target.env[envKey];
    let key = getFlag(args, 'key') ?? getFlag(args, 'provider-key');
    const setDefault = hasFlag(args, 'set-default');

    if (!key) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new Error(`Missing --key for provider '${provider}'.`);
        }
        await withPromptSession(async (prompt) => {
            key = await prompt.secret(`Enter your ${providerDisplayName(provider)} API key`, existing);
        });
    }

    if (!key || detectPlaceholder(key)) {
        throw new Error(`A valid ${providerDisplayName(provider)} API key is required.`);
    }

    const updates: Record<string, string | undefined> = {
        [envKey]: key,
    };
    if (setDefault || !target.env.LLM_PROVIDER || target.env.LLM_PROVIDER === 'mock') {
        updates.LLM_PROVIDER = provider;
    }

    await upsertEnvFile(target.envFile, updates);

    if (hasFlag(args, 'json')) {
        console.log(JSON.stringify({
            action: mode,
            provider,
            envKey,
            envFile: target.envFile,
            instance: target.instanceName ?? null,
            wroteDefaultProvider: Boolean(updates.LLM_PROVIDER),
        }, null, 2));
        return;
    }

    console.log(okLabel(), `${providerDisplayName(provider)} API key ${mode === 'add' ? 'stored' : 'updated'}.`);
    console.log(`  provider  ${provider}`);
    console.log(`  env key   ${envKey}`);
    console.log(`  value     ${redactSecret(key)}`);
    console.log(`  target    ${target.envFile}`);
    if (updates.LLM_PROVIDER) {
        console.log(`  default   ${paint(provider, 'cyan')}`);
    }
}

async function removeProviderKeyCommand(args: ParsedArgs): Promise<void> {
    const target = await resolveProviderKeyTarget(args);
    const provider = await chooseProvider(args, target, 'Which provider key would you like to remove?');
    const envKey = providerKeyEnv(provider);
    if (!envKey) {
        throw new Error(`Provider '${provider}' does not use a remote API key.`);
    }
    if (detectPlaceholder(target.env[envKey])) {
        if (hasFlag(args, 'json')) {
            console.log(JSON.stringify({
                action: 'remove',
                provider,
                envKey,
                removed: false,
                reason: 'not_set',
                envFile: target.envFile,
            }, null, 2));
            return;
        }
        console.log(warnLabel(), `No stored ${providerDisplayName(provider)} API key was found in ${target.envFile}.`);
        return;
    }

    await upsertEnvFile(target.envFile, {
        [envKey]: undefined,
    });

    if (hasFlag(args, 'json')) {
        console.log(JSON.stringify({
            action: 'remove',
            provider,
            envKey,
            removed: true,
            envFile: target.envFile,
        }, null, 2));
        return;
    }

    console.log(okLabel(), `${providerDisplayName(provider)} API key removed.`);
    console.log(`  provider  ${provider}`);
    console.log(`  env key   ${envKey}`);
    console.log(`  target    ${target.envFile}`);
}

async function setupCommand(args: ParsedArgs): Promise<void> {
    const configPath = getFlag(args, 'config');
    const useDefaults = hasFlag(args, 'defaults');

    if (configPath && useDefaults) {
        throw new Error('Use either --config <file> or --defaults, not both.');
    }

    if (configPath || useDefaults) {
        const plan = configPath ? parseSetupConfig(configPath) : defaultsSetupPlan(args);
        const result = await executeSetupPlan(plan);

        console.log(bold('Setup complete'));
        console.log(`  runtime root   ${result.root}`);
        console.log(`  scope          ${result.scope}`);
        console.log(`  instance       ${result.instanceName}`);
        console.log(`  instance env   ${result.instanceEnvFile}`);
        console.log(`  instance url   http://localhost:${result.port}`);
        if (result.bindings.length === 0) {
            console.log(`  projects       ${paint('none bound yet', 'yellow')}`);
        } else {
            console.log('  projects');
            for (const binding of result.bindings) {
                console.log(`    - ${binding.projectPath} (${binding.agentId})`);
            }
        }
        console.log('');
        console.log(`${infoLabel()} Next steps:`);
        console.log(`  1. iranti run --instance ${result.instanceName} --root "${result.root}"`);
        console.log(`  2. iranti doctor --instance ${result.instanceName} --root "${result.root}"`);
        return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('iranti setup requires a real terminal session unless you provide --config <file> or --defaults.');
    }

    const explicitScope = getFlag(args, 'scope');
    const explicitRoot = getFlag(args, 'root');

    console.log(bold('Iranti setup'));
    console.log('This wizard will install a runtime, create or update an instance, configure provider keys, create a usable Iranti API key, and optionally bind one or more project folders.');
    console.log('');

    let result: SetupExecutionResult | null = null;

    await withPromptSession(async (prompt) => {
        let setupMode: 'shared' | 'isolated' = 'shared';
        while (true) {
            const chosen = (await prompt.line('Setup mode: shared runtime or isolated runtime folder', 'shared') ?? 'shared').trim().toLowerCase();
            if (chosen === 'shared' || chosen === 'isolated') {
                setupMode = chosen;
                break;
            }
            console.log(`${warnLabel()} Choose either "shared" or "isolated".`);
        }

        let finalScope: Scope = 'user';
        let finalRoot = '';
        if (setupMode === 'isolated') {
            finalRoot = path.resolve(await promptNonEmpty(
                prompt,
                'Runtime root folder',
                explicitRoot ?? path.join(process.cwd(), '.iranti-runtime')
            ));
            finalScope = 'user';
        } else {
            while (true) {
                const chosenScope = (await prompt.line('Install scope', explicitScope ?? 'user') ?? 'user').trim().toLowerCase();
                if (chosenScope === 'user' || chosenScope === 'system') {
                    finalScope = chosenScope;
                    break;
                }
                console.log(`${warnLabel()} Install scope must be user or system.`);
            }
            finalRoot = explicitRoot ? path.resolve(explicitRoot) : resolveInstallRoot(args, finalScope);
        }

        await ensureRuntimeInstalled(finalRoot, finalScope);
        console.log(`${okLabel()} Runtime ready at ${finalRoot}`);

        const instanceName = sanitizeIdentifier(
            await promptNonEmpty(prompt, 'Instance name', setupMode === 'isolated' ? sanitizeIdentifier(path.basename(process.cwd()), 'local') : 'local'),
            'local'
        );

        const existingInstance = fs.existsSync(instancePaths(finalRoot, instanceName).envFile)
            ? await loadInstanceEnv(finalRoot, instanceName)
            : null;

        if (existingInstance) {
            console.log(`${infoLabel()} Updating existing instance '${instanceName}'.`);
        } else {
            console.log(`${infoLabel()} Creating new instance '${instanceName}'.`);
        }

        const existingPort = Number.parseInt(existingInstance?.env.IRANTI_PORT ?? '3001', 10);
        const port = await chooseAvailablePort(prompt, 'Iranti API port', existingPort, Boolean(existingInstance));

        const dockerAvailable = hasDockerInstalled();
        let dbUrl = '';
        let bootstrapDatabase = false;
        while (true) {
            const defaultMode = dockerAvailable ? 'docker' : 'existing';
            const dbMode = (await prompt.line(
                'Database setup mode: existing, managed, or docker',
                defaultMode
            ) ?? defaultMode).trim().toLowerCase();

            if (dbMode === 'existing' || dbMode === 'managed') {
                while (true) {
                    dbUrl = await promptNonEmpty(
                        prompt,
                        'DATABASE_URL',
                        existingInstance?.env.DATABASE_URL ?? `postgresql://postgres:yourpassword@localhost:5432/iranti_${instanceName}`
                    );
                    if (!detectPlaceholder(dbUrl)) break;
                    console.log(`${warnLabel()} DATABASE_URL still looks like a placeholder. Enter a real connection string before finishing setup.`);
                }
                bootstrapDatabase = await promptYesNo(prompt, 'Run migrations and seed the database now?', true);
                break;
            }

            if (dbMode === 'docker') {
                if (!dockerAvailable) {
                    console.log(`${warnLabel()} Docker is not installed or not on PATH. Choose existing or managed instead.`);
                    continue;
                }
                const dbHostPort = await chooseAvailablePort(prompt, 'Docker PostgreSQL host port', 5432, false);
                const dbName = sanitizeIdentifier(await promptNonEmpty(prompt, 'Docker PostgreSQL database name', `iranti_${instanceName}`), `iranti_${instanceName}`);
                const dbPassword = await promptRequiredSecret(prompt, 'Docker PostgreSQL password');
                const containerName = sanitizeIdentifier(
                    await promptNonEmpty(prompt, 'Docker container name', `iranti_${instanceName}_db`),
                    `iranti_${instanceName}_db`
                );
                dbUrl = `postgresql://postgres:${dbPassword}@localhost:${dbHostPort}/${dbName}`;

                console.log(`${infoLabel()} Docker will be used only for PostgreSQL. Iranti itself does not require Docker once a PostgreSQL database is available.`);
                if (await promptYesNo(prompt, `Start or reuse Docker container '${containerName}' now?`, true)) {
                    await runDockerPostgresContainer({
                        containerName,
                        hostPort: dbHostPort,
                        password: dbPassword,
                        database: dbName,
                    });
                    console.log(`${okLabel()} Docker PostgreSQL ready at localhost:${dbHostPort}`);
                    bootstrapDatabase = true;
                } else {
                    bootstrapDatabase = await promptYesNo(prompt, 'Will you start PostgreSQL separately before first run?', false);
                }
                break;
            }

            console.log(`${warnLabel()} Choose one of: existing, managed, docker.`);
        }

        let provider = normalizeProvider(existingInstance?.env.LLM_PROVIDER ?? 'openai') ?? 'openai';
        while (true) {
            listProviderChoices(provider, existingInstance?.env ?? {});
            const chosen = normalizeProvider(await promptNonEmpty(prompt, 'Default LLM provider', provider));
            if (chosen && isSupportedProvider(chosen)) {
                provider = chosen;
                break;
            }
            console.log(`${warnLabel()} Unsupported provider. Choose one of: ${Object.keys(PROVIDER_ENV_KEYS).join(', ')}.`);
        }

        const providerKeys: Record<string, string> = {};
        const seedEnv = existingInstance?.env ?? {};
        const maybeCollectProviderKey = async (providerName: string): Promise<void> => {
            const envKey = providerKeyEnv(providerName);
            if (!envKey) return;
            const secret = await promptRequiredSecret(prompt, `Enter your ${providerDisplayName(providerName)} API key`, seedEnv[envKey] ?? providerKeys[envKey]);
            providerKeys[envKey] = secret;
        };

        if (providerKeyEnv(provider)) {
            await maybeCollectProviderKey(provider);
        }

        while (await promptYesNo(prompt, 'Add another provider API key now?', false)) {
            let extraProvider = provider;
            while (true) {
                listProviderChoices(provider, { ...seedEnv, ...providerKeys });
                const chosen = normalizeProvider(await promptNonEmpty(prompt, 'Provider to add', 'claude'));
                if (!chosen) {
                    console.log(`${warnLabel()} Provider is required.`);
                    continue;
                }
                if (chosen === 'perplexity') {
                    console.log(`${warnLabel()} Perplexity is not yet supported by Iranti.`);
                    continue;
                }
                if (!isSupportedProvider(chosen)) {
                    console.log(`${warnLabel()} Unsupported provider '${chosen}'.`);
                    continue;
                }
                if (!providerKeyEnv(chosen)) {
                    console.log(`${warnLabel()} ${providerDisplayName(chosen)} does not use a remote API key.`);
                    continue;
                }
                extraProvider = chosen;
                break;
            }
            await maybeCollectProviderKey(extraProvider);
        }

        let defaultApiKey = existingInstance?.env.IRANTI_API_KEY && !detectPlaceholder(existingInstance.env.IRANTI_API_KEY)
            ? existingInstance.env.IRANTI_API_KEY
            : makeLegacyInstanceApiKey(instanceName);

        const rotateApiKey = detectPlaceholder(existingInstance?.env.IRANTI_API_KEY)
            ? true
            : await promptYesNo(prompt, 'Generate a fresh Iranti client API key for this instance?', false);
        if (rotateApiKey) {
            defaultApiKey = makeLegacyInstanceApiKey(instanceName);
        }

        const projects: SetupProjectPlan[] = [];
        const defaultProjectPath = process.cwd();
        let shouldBindProject = await promptYesNo(prompt, 'Bind a project folder to this instance now?', true);
        while (shouldBindProject) {
            const projectPath = path.resolve(await promptNonEmpty(prompt, 'Project path', projects.length === 0 ? defaultProjectPath : process.cwd()));
            const agentId = sanitizeIdentifier(
                await promptNonEmpty(prompt, 'Agent id for this project', projectAgentDefault(projectPath)),
                'project_main'
            );
            const memoryEntity = await promptNonEmpty(prompt, 'Memory entity for this project', 'user/main');
            const claudeCode = await promptYesNo(prompt, 'Create Claude Code project files here?', true);
            projects.push({
                path: projectPath,
                agentId,
                memoryEntity,
                claudeCode,
            });
            shouldBindProject = await promptYesNo(prompt, 'Bind another project folder?', false);
        }

        const codex = projects.length > 0 && hasCodexInstalled()
            ? await promptYesNo(prompt, 'Register Codex globally for the first bound project now?', false)
            : false;

        result = await executeSetupPlan({
            mode: setupMode,
            scope: finalScope,
            root: finalRoot,
            instanceName,
            port,
            databaseUrl: dbUrl,
            provider,
            providerKeys,
            apiKey: defaultApiKey,
            projects,
            codex,
            codexAgent: projects[0]?.agentId,
            bootstrapDatabase,
        });
    });

    if (!result) {
        throw new Error('Setup did not produce a result.');
    }
    const finalResult: SetupExecutionResult = result;

    console.log('');
    console.log(bold('Setup complete'));
    console.log(`  runtime root   ${finalResult.root}`);
    console.log(`  scope          ${finalResult.scope}`);
    console.log(`  instance       ${finalResult.instanceName}`);
    console.log(`  instance env   ${finalResult.instanceEnvFile}`);
    console.log(`  instance url   http://localhost:${finalResult.port}`);
    if (finalResult.bindings.length === 0) {
            console.log(`  projects       ${paint('none bound yet', 'yellow')}`);
    } else {
        console.log('  projects');
        for (const binding of finalResult.bindings) {
            console.log(`    - ${binding.projectPath} (${binding.agentId})`);
        }
    }
    console.log('');
    console.log(`${infoLabel()} Next steps:`);
    console.log(`  1. iranti run --instance ${finalResult.instanceName} --root "${finalResult.root}"`);
    console.log(`  2. iranti doctor --instance ${finalResult.instanceName} --root "${finalResult.root}"`);
}

async function doctorCommand(args: ParsedArgs): Promise<void> {
    const json = hasFlag(args, 'json');
    const { envFile, envSource } = resolveDoctorEnvTarget(args);

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

        try {
            const backendName = resolveVectorBackendName({
                vectorBackend: env.IRANTI_VECTOR_BACKEND,
                qdrantUrl: env.IRANTI_QDRANT_URL,
                qdrantApiKey: env.IRANTI_QDRANT_API_KEY,
                qdrantCollection: env.IRANTI_QDRANT_COLLECTION,
                chromaUrl: env.IRANTI_CHROMA_URL,
                chromaCollection: env.IRANTI_CHROMA_COLLECTION,
                chromaTenant: env.IRANTI_CHROMA_TENANT,
                chromaDatabase: env.IRANTI_CHROMA_DATABASE,
                chromaToken: env.IRANTI_CHROMA_TOKEN,
            });
            const backend = createVectorBackend({
                vectorBackend: backendName,
                qdrantUrl: env.IRANTI_QDRANT_URL,
                qdrantApiKey: env.IRANTI_QDRANT_API_KEY,
                qdrantCollection: env.IRANTI_QDRANT_COLLECTION,
                chromaUrl: env.IRANTI_CHROMA_URL,
                chromaCollection: env.IRANTI_CHROMA_COLLECTION,
                chromaTenant: env.IRANTI_CHROMA_TENANT,
                chromaDatabase: env.IRANTI_CHROMA_DATABASE,
                chromaToken: env.IRANTI_CHROMA_TOKEN,
            });
            const reachable = await backend.ping();
            const url = vectorBackendUrl(backendName, env);
            checks.push({
                name: 'vector backend',
                status: reachable ? 'pass' : 'warn',
                detail: url
                    ? `${backendName} (${url}) is ${reachable ? 'reachable' : 'unreachable'}`
                    : `${backendName} is ${reachable ? 'reachable' : 'unreachable'}`,
            });
        } catch (error) {
            checks.push({
                name: 'vector backend',
                status: 'fail',
                detail: error instanceof Error ? error.message : String(error),
            });
        }
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

    console.log(bold('Iranti doctor'));
    console.log(`  version : ${version}`);
    console.log(`  status  : ${result.status === 'pass'
        ? paint(result.status.toUpperCase(), 'green')
        : result.status === 'warn'
            ? paint(result.status.toUpperCase(), 'yellow')
            : paint(result.status.toUpperCase(), 'red')}`);
    if (envFile) console.log(`  env     : ${envFile}`);
    console.log('');
    for (const check of checks) {
        const marker = check.status === 'pass'
            ? okLabel('PASS')
            : check.status === 'warn'
                ? warnLabel('WARN')
                : failLabel('FAIL');
        console.log(`${marker} ${check.name} — ${check.detail}`);
    }

    if (result.status !== 'pass') {
        process.exitCode = 1;
    }
}

async function statusCommand(args: ParsedArgs): Promise<void> {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const json = hasFlag(args, 'json');
    const cwd = process.cwd();
    const repoEnv = path.join(cwd, '.env');
    const projectEnv = path.join(cwd, '.env.iranti');
    const installMetaPath = path.join(root, 'install.json');
    const instancesDir = path.join(root, 'instances');

    const rows: StatusRow[] = [];
    rows.push({ label: 'version', value: getPackageVersion() });
    rows.push({ label: 'scope', value: scope });
    rows.push({ label: 'runtime_root', value: root });
    rows.push({ label: 'repo_env', value: fs.existsSync(repoEnv) ? repoEnv : '(missing)' });
    rows.push({ label: 'project_binding', value: fs.existsSync(projectEnv) ? projectEnv : '(missing)' });
    rows.push({ label: 'install_meta', value: fs.existsSync(installMetaPath) ? installMetaPath : '(not initialized)' });

    const instances: Array<{ name: string; port: string; envFile: string }> = [];
    if (fs.existsSync(instancesDir)) {
        const entries = await fsp.readdir(instancesDir, { withFileTypes: true });
        for (const entry of entries.filter((value) => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
            const envFile = path.join(instancesDir, entry.name, '.env');
            let port = '(unknown)';
            if (fs.existsSync(envFile)) {
                try {
                    const env = await readEnvFile(envFile);
                    port = env.IRANTI_PORT ?? '(unknown)';
                } catch {
                    port = '(unreadable)';
                }
            }
            instances.push({
                name: entry.name,
                port,
                envFile: fs.existsSync(envFile) ? envFile : '(missing)',
            });
        }
    }

    if (json) {
        console.log(JSON.stringify({
            version: getPackageVersion(),
            scope,
            runtimeRoot: root,
            repoEnv: fs.existsSync(repoEnv) ? repoEnv : null,
            projectBinding: fs.existsSync(projectEnv) ? projectEnv : null,
            installMeta: fs.existsSync(installMetaPath) ? installMetaPath : null,
            instances,
        }, null, 2));
        return;
    }

    console.log(bold('Iranti status'));
    for (const row of rows) {
        console.log(`  ${row.label.padEnd(15)} ${row.value}`);
    }

    console.log('');
    if (instances.length === 0) {
        console.log('Instances: none');
    } else {
        console.log('Instances:');
        for (const instance of instances) {
            console.log(`  - ${instance.name} (port ${instance.port})`);
            console.log(`    env: ${instance.envFile}`);
        }
    }
}

async function upgradeCommand(args: ParsedArgs): Promise<void> {
    const checkOnly = hasFlag(args, 'check');
    const dryRun = hasFlag(args, 'dry-run');
    const execute = hasFlag(args, 'yes');
    const json = hasFlag(args, 'json');
    const requestedTarget = resolveUpgradeTarget(getFlag(args, 'target'));
    const context = detectUpgradeContext(args);
    const latestNpm = await fetchLatestNpmVersion();
    const latestPython = await fetchLatestPypiVersion();
    const chosenTarget = chooseUpgradeTarget(requestedTarget, context);
    const commands = {
        npmGlobal: 'npm install -g iranti@latest',
        npmRepo: 'git pull --ff-only && npm install && npm run build',
        python: context.python?.display ?? 'python -m pip install --upgrade iranti',
    };
    const updateAvailable = {
        npm: latestNpm ? compareVersions(latestNpm, context.currentVersion) > 0 : null,
        python: latestPython ? compareVersions(latestPython, context.currentVersion) > 0 : null,
    };
    const plan = chosenTarget ? commandListForTarget(chosenTarget, context) : [];

    let execution: UpgradeExecutionResult | null = null;
    let note: string | null = null;

    if (execute) {
        if (!chosenTarget) {
            throw new Error('No executable upgrade path was detected. Use --target npm-global, --target npm-repo, or --target python.');
        }
        if (dryRun || checkOnly) {
            note = 'Execution skipped because --dry-run or --check was provided.';
        } else if (chosenTarget === 'npm-global' && updateAvailable.npm === false) {
            note = 'npm global install is already at the latest published version.';
        } else if (chosenTarget === 'python' && updateAvailable.python === false) {
            note = 'Python client is already at the latest published version.';
        } else {
            execution = await executeUpgradeTarget(chosenTarget, context);
        }
    } else if (!checkOnly && !dryRun) {
        note = 'Run with --yes to execute the selected upgrade path. Use --check to inspect and --dry-run to print exact commands.';
    }

    if (json) {
        console.log(JSON.stringify({
            currentVersion: context.currentVersion,
            latest: {
                npm: latestNpm,
                python: latestPython,
            },
            install: {
                packageRoot: context.packageRootPath,
                runtimeRoot: context.runtimeRoot,
                runtimeInstalled: context.runtimeInstalled,
                repoCheckout: context.repoCheckout,
                globalNpmInstall: context.globalNpmInstall,
                globalNpmRoot: context.globalNpmRoot,
                pythonLauncher: context.python?.executable ?? null,
            },
            requestedTarget,
            selectedTarget: chosenTarget,
            availableTargets: context.availableTargets,
            updateAvailable,
            commands,
            plan: plan.map((step) => step.display),
            action: execute && !dryRun && !checkOnly ? 'upgrade' : checkOnly ? 'check' : dryRun ? 'dry-run' : 'inspect',
            execution,
            note,
        }, null, 2));
        return;
    }

    console.log(bold('Iranti upgrade'));
    console.log(`  current_version  ${context.currentVersion}`);
    console.log(`  latest_npm       ${latestNpm ?? '(unavailable)'}`);
    console.log(`  latest_python    ${latestPython ?? '(unavailable)'}`);
    console.log(`  package_root     ${context.packageRootPath}`);
    console.log(`  runtime_root     ${context.runtimeRoot}`);
    console.log(`  repo_checkout    ${context.repoCheckout ? paint('yes', 'green') : paint('no', 'gray')}`);
    console.log(`  npm_global       ${context.globalNpmInstall ? paint('yes', 'green') : paint('no', 'gray')}`);
    console.log(`  python           ${context.python?.executable ?? paint('not found', 'yellow')}`);
    console.log('');
    if (chosenTarget) {
        console.log(`  selected_target  ${paint(chosenTarget, 'cyan')}${requestedTarget === 'auto' ? paint(' (auto)', 'gray') : ''}`);
        console.log('  plan');
        for (const step of plan) {
            console.log(`    - ${step.display}`);
        }
    } else {
        console.log(`  selected_target  ${paint('none', 'yellow')}`);
        console.log('  plan             No executable upgrade path detected automatically.');
    }
    console.log('');
    console.log(`  npm global       ${commands.npmGlobal}`);
    console.log(`  npm repo         ${commands.npmRepo}`);
    console.log(`  python client    ${commands.python}`);

    if (execution) {
        const marker = execution.verification.status === 'pass'
            ? okLabel('PASS')
            : execution.verification.status === 'warn'
                ? warnLabel('WARN')
                : failLabel('FAIL');
        console.log('');
        console.log(`${okLabel()} Upgrade completed for ${execution.target}.`);
        console.log(`${marker} ${execution.verification.detail}`);
        const { envFile } = resolveDoctorEnvTarget(args);
        if (envFile) {
            console.log(`${infoLabel()} Run \`iranti doctor\` to verify the active environment after the package upgrade.`);
        }
        return;
    }

    if (note) {
        console.log('');
        console.log(`${infoLabel()} ${note}`);
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

    console.log(`${okLabel()} Iranti runtime initialized`);
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
    const provider = normalizeProvider(getFlag(args, 'provider')) ?? 'mock';
    const providerKey = getFlag(args, 'provider-key');
    const providerKeyName = providerKeyEnv(provider);
    if (providerKey && !providerKeyName) {
        throw new Error(`Provider '${provider}' does not use a remote API key.`);
    }

    const { instanceDir, envFile, metaFile } = instancePaths(root, name);
    if (fs.existsSync(instanceDir) && !hasFlag(args, 'force')) {
        throw new Error(`Instance '${name}' already exists at ${instanceDir}. Use --force to overwrite.`);
    }

    await ensureDir(instanceDir);
    await ensureDir(path.join(instanceDir, 'logs'));
    await ensureDir(path.join(instanceDir, 'escalation', 'active'));
    await ensureDir(path.join(instanceDir, 'escalation', 'resolved'));
    await ensureDir(path.join(instanceDir, 'escalation', 'archived'));

    await writeText(envFile, makeInstanceEnv(name, port, dbUrl, apiKey, instanceDir));
    await upsertEnvFile(envFile, {
        LLM_PROVIDER: provider,
        ...(providerKey && providerKeyName ? { [providerKeyName]: providerKey } : {}),
    });
    const meta: InstanceMeta = {
        name,
        createdAt: new Date().toISOString(),
        port,
        envFile,
        instanceDir,
    };
    await writeJson(metaFile, meta);

    console.log(`${okLabel()} Instance created: ${name}`);
    console.log(`  dir : ${instanceDir}`);
    console.log(`  env : ${envFile}`);
    console.log(`  port: ${port}`);
    console.log(`  provider: ${provider}`);
    if (providerKey && providerKeyName) {
        console.log(`  ${providerKeyName}: ${redactSecret(providerKey)}`);
    }
    console.log(`Next: iranti instance show ${name}`);
}

async function listInstancesCommand(args: ParsedArgs): Promise<void> {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const instancesDir = path.join(root, 'instances');
    if (!fs.existsSync(instancesDir)) {
        console.log(`${warnLabel()} No install found at ${root}. Run: iranti install`);
        return;
    }
    const entries = await fsp.readdir(instancesDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    if (dirs.length === 0) {
        console.log(`${warnLabel()} No instances found under ${instancesDir}`);
        return;
    }
    console.log(bold(`Instances (${instancesDir}):`));
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
    console.log(bold(`Instance: ${name}`));
    console.log(`  dir : ${instanceDir}`);
    console.log(`  env : ${envFile}`);
    console.log(`  port: ${env.IRANTI_PORT ?? '3001'}`);
    console.log(`  db  : ${env.DATABASE_URL ?? '(missing)'}`);
    console.log(`  esc : ${env.IRANTI_ESCALATION_DIR ?? '(missing)'}`);
    console.log(`${infoLabel()} Run with: iranti run --instance ${name}`);
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

    console.log(`${infoLabel()} Starting Iranti instance '${name}' on port ${process.env.IRANTI_PORT ?? '3001'}...`);
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
    const { envFile, env: instanceEnv } = await loadInstanceEnv(root, instanceName);
    const port = instanceEnv.IRANTI_PORT ?? '3001';
    const apiKey = getFlag(args, 'api-key') ?? instanceEnv.IRANTI_API_KEY ?? 'replace_me_with_api_key';
    const agentId = getFlag(args, 'agent-id') ?? 'my_agent';

    const outFile = path.join(projectPath, '.env.iranti');
    if (fs.existsSync(outFile) && !hasFlag(args, 'force')) {
        throw new Error(`${outFile} already exists. Use --force to overwrite.`);
    }

    await writeProjectBinding(projectPath, {
        IRANTI_URL: `http://localhost:${port}`,
        IRANTI_API_KEY: apiKey,
        IRANTI_AGENT_ID: agentId,
        IRANTI_MEMORY_ENTITY: 'user/main',
        IRANTI_INSTANCE: instanceName,
        IRANTI_INSTANCE_ENV: envFile,
    });

    console.log(`${okLabel()} Project initialized at ${projectPath}`);
    console.log(`  wrote ${outFile}`);
    console.log(`Use with Python client/middleware by loading .env.iranti`);
}

async function configureInstanceCommand(args: ParsedArgs): Promise<void> {
    const name = args.positionals[0];
    if (!name) {
        throw new Error('Missing instance name. Usage: iranti configure instance <name> [--provider openai] [--provider-key <token>]');
    }

    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const { envFile, env } = await loadInstanceEnv(root, name);
    const updates: Record<string, string | undefined> = {};

    let portRaw = getFlag(args, 'port');
    let dbUrl = getFlag(args, 'db-url');
    let apiKey = getFlag(args, 'api-key');
    let providerInput = getFlag(args, 'provider');
    let providerKey = getFlag(args, 'provider-key');
    let clearProviderKey = hasFlag(args, 'clear-provider-key');

    if (hasFlag(args, 'interactive')) {
        await withPromptSession(async (prompt) => {
            portRaw = await prompt.line('IRANTI_PORT', portRaw ?? env.IRANTI_PORT);
            dbUrl = await prompt.line('DATABASE_URL', dbUrl ?? env.DATABASE_URL);
            providerInput = await prompt.line('LLM_PROVIDER', providerInput ?? env.LLM_PROVIDER ?? 'mock');
            const interactiveProvider = normalizeProvider(providerInput ?? env.LLM_PROVIDER ?? 'mock');
            if (providerKeyEnv(interactiveProvider)) {
                providerKey = await prompt.secret(`${providerKeyEnv(interactiveProvider)}`, providerKey ?? env[providerKeyEnv(interactiveProvider)!]);
            }
            apiKey = await prompt.secret('IRANTI_API_KEY', apiKey ?? env.IRANTI_API_KEY);
        });
        clearProviderKey = false;
    }

    if (portRaw) {
        const port = Number.parseInt(portRaw, 10);
        if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid --port '${portRaw}'.`);
        updates.IRANTI_PORT = String(port);
    }

    if (dbUrl) updates.DATABASE_URL = dbUrl;

    if (apiKey) updates.IRANTI_API_KEY = apiKey;

    const provider = normalizeProvider(providerInput ?? env.LLM_PROVIDER ?? 'mock');
    if (providerInput) updates.LLM_PROVIDER = provider ?? 'mock';

    if (providerKey) {
        const envKey = providerKeyEnv(provider);
        if (!envKey) {
            throw new Error(`Provider '${provider ?? 'unknown'}' does not use a remote API key.`);
        }
        updates[envKey] = providerKey;
    }

    if (clearProviderKey) {
        const envKey = providerKeyEnv(provider);
        if (!envKey) {
            throw new Error(`Provider '${provider ?? 'unknown'}' does not use a remote API key.`);
        }
        updates[envKey] = undefined;
    }

    if (Object.keys(updates).length === 0) {
        throw new Error('No changes provided. Use flags like --provider, --provider-key, --api-key, --db-url, or --port.');
    }

    await upsertEnvFile(envFile, updates);

    const json = hasFlag(args, 'json');
    const result = {
        instance: name,
        envFile,
        updatedKeys: Object.keys(updates).sort(),
        provider: updates.LLM_PROVIDER ?? env.LLM_PROVIDER ?? 'mock',
        apiKeyChanged: Boolean(apiKey),
        providerKeyChanged: Boolean(providerKey) || hasFlag(args, 'clear-provider-key'),
    };

    if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log(`${okLabel()} Instance updated: ${name}`);
    console.log(`  env      ${envFile}`);
    console.log(`  keys     ${result.updatedKeys.join(', ')}`);
    if (apiKey) {
        console.log(`  api key  ${redactSecret(apiKey)}`);
    }
    if (providerKey) {
        console.log(`  provider ${result.provider}`);
    }
}

async function configureProjectCommand(args: ParsedArgs): Promise<void> {
    const projectPath = path.resolve(args.positionals[0] ?? process.cwd());
    const outFile = path.join(projectPath, '.env.iranti');
    const existing = fs.existsSync(outFile) ? await readEnvFile(outFile) : {};

    const scope = normalizeScope(getFlag(args, 'scope'));
    let instanceName: string | undefined = getFlag(args, 'instance') ?? existing.IRANTI_INSTANCE;
    let explicitUrl: string | undefined = getFlag(args, 'url');
    let explicitApiKey: string | undefined = getFlag(args, 'api-key');
    let explicitAgentId: string | undefined = getFlag(args, 'agent-id');
    let explicitMemoryEntity: string | undefined = getFlag(args, 'memory-entity');

    if (hasFlag(args, 'interactive')) {
        await withPromptSession(async (prompt) => {
            instanceName = await prompt.line('IRANTI_INSTANCE', instanceName);
            explicitUrl = await prompt.line('IRANTI_URL', explicitUrl ?? existing.IRANTI_URL);
            explicitApiKey = await prompt.secret('IRANTI_API_KEY', explicitApiKey ?? existing.IRANTI_API_KEY);
            explicitAgentId = await prompt.line('IRANTI_AGENT_ID', explicitAgentId ?? existing.IRANTI_AGENT_ID ?? 'my_agent');
            explicitMemoryEntity = await prompt.line('IRANTI_MEMORY_ENTITY', explicitMemoryEntity ?? existing.IRANTI_MEMORY_ENTITY ?? 'user/main');
        });
    }

    let instanceEnvFile = existing.IRANTI_INSTANCE_ENV;
    let derivedUrl = existing.IRANTI_URL;
    let derivedApiKey = existing.IRANTI_API_KEY;

    if (instanceName) {
        const root = resolveInstallRoot(args, scope);
        const { envFile, env } = await loadInstanceEnv(root, instanceName);
        instanceEnvFile = envFile;
        derivedUrl = `http://localhost:${env.IRANTI_PORT ?? '3001'}`;
        derivedApiKey = env.IRANTI_API_KEY ?? derivedApiKey;
    }

    const updates: Record<string, string | undefined> = {
        IRANTI_URL: explicitUrl ?? derivedUrl,
        IRANTI_API_KEY: explicitApiKey ?? derivedApiKey,
        IRANTI_AGENT_ID: explicitAgentId ?? existing.IRANTI_AGENT_ID ?? 'my_agent',
        IRANTI_MEMORY_ENTITY: explicitMemoryEntity ?? existing.IRANTI_MEMORY_ENTITY ?? 'user/main',
        IRANTI_INSTANCE: instanceName,
        IRANTI_INSTANCE_ENV: instanceEnvFile,
    };

    if (!updates.IRANTI_URL) {
        throw new Error('Unable to determine IRANTI_URL. Provide --instance <name> or --url <http://host:port>.');
    }
    if (!updates.IRANTI_API_KEY) {
        throw new Error('Unable to determine IRANTI_API_KEY. Provide --api-key <token> or configure the instance first.');
    }

    const written = await writeProjectBinding(projectPath, updates);
    const json = hasFlag(args, 'json');
    const result = {
        projectPath,
        envFile: written,
        url: updates.IRANTI_URL,
        agentId: updates.IRANTI_AGENT_ID,
        instance: updates.IRANTI_INSTANCE ?? null,
    };

    if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log(`${okLabel()} Project binding updated`);
    console.log(`  path     ${projectPath}`);
    console.log(`  env      ${written}`);
    console.log(`  url      ${updates.IRANTI_URL}`);
    console.log(`  agent    ${updates.IRANTI_AGENT_ID}`);
    if (updates.IRANTI_INSTANCE) {
        console.log(`  instance ${updates.IRANTI_INSTANCE}`);
    }
}

async function authCreateKeyCommand(args: ParsedArgs): Promise<void> {
    const instanceName = getFlag(args, 'instance');
    const keyId = getFlag(args, 'key-id');
    const owner = getFlag(args, 'owner');
    const scopesRaw = getFlag(args, 'scopes') ?? '';
    const description = getFlag(args, 'description');
    const projectPath = getFlag(args, 'project');
    const agentId = getFlag(args, 'agent-id');
    const writeInstance = hasFlag(args, 'write-instance');

    if (!instanceName) throw new Error('Missing --instance <name>. Usage: iranti auth create-key --instance <name> --key-id <id> --owner <owner>');
    if (!keyId || !owner) throw new Error('Missing --key-id or --owner.');

    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const { envFile, env } = await loadInstanceEnv(root, instanceName);
    if (detectPlaceholder(env.DATABASE_URL)) {
        throw new Error(`Instance '${instanceName}' still has a placeholder DATABASE_URL. Update ${envFile} first.`);
    }

    const scopes = scopesRaw.split(',').map((value) => value.trim()).filter(Boolean);

    initDb(env.DATABASE_URL);
    const created = await createOrRotateApiKey({
        keyId,
        owner,
        scopes,
        description,
    });

    if (writeInstance) {
        await upsertEnvFile(envFile, { IRANTI_API_KEY: created.token });
    }

    if (projectPath) {
        const resolvedProjectPath = path.resolve(projectPath);
        const existingBindingFile = path.join(resolvedProjectPath, '.env.iranti');
        const existingBinding = fs.existsSync(existingBindingFile) ? await readEnvFile(existingBindingFile) : {};
        await writeProjectBinding(resolvedProjectPath, {
            IRANTI_URL: `http://localhost:${env.IRANTI_PORT ?? '3001'}`,
            IRANTI_API_KEY: created.token,
            IRANTI_AGENT_ID: agentId ?? existingBinding.IRANTI_AGENT_ID ?? 'my_agent',
            IRANTI_MEMORY_ENTITY: existingBinding.IRANTI_MEMORY_ENTITY ?? 'user/main',
            IRANTI_INSTANCE: instanceName,
            IRANTI_INSTANCE_ENV: envFile,
        });
    }

    if (hasFlag(args, 'json')) {
        console.log(JSON.stringify({
            keyId: created.record.keyId,
            owner: created.record.owner,
            scopes: created.record.scopes,
            token: created.token,
            instance: instanceName,
            wroteInstanceEnv: writeInstance,
            wroteProjectPath: projectPath ? path.resolve(projectPath) : null,
        }, null, 2));
        process.exit(0);
    }

    console.log(`${okLabel()} API key created (or rotated):`);
    console.log(`  keyId   ${created.record.keyId}`);
    console.log(`  owner   ${created.record.owner}`);
    console.log(`  scopes  ${created.record.scopes.join(',') || '(none)'}`);
    console.log(`  token   ${created.token}`);
    if (writeInstance) {
        console.log(`  synced  ${envFile}`);
    }
    if (projectPath) {
        console.log(`  project ${path.resolve(projectPath)}`);
    }
    process.exit(0);
}

async function authListKeysCommand(args: ParsedArgs): Promise<void> {
    const instanceName = getFlag(args, 'instance');
    if (!instanceName) throw new Error('Missing --instance <name>. Usage: iranti auth list-keys --instance <name>');

    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const { envFile, env } = await loadInstanceEnv(root, instanceName);
    if (detectPlaceholder(env.DATABASE_URL)) {
        throw new Error(`Instance '${instanceName}' still has a placeholder DATABASE_URL. Update ${envFile} first.`);
    }

    initDb(env.DATABASE_URL);
    const keys = await listApiKeys();
    if (hasFlag(args, 'json')) {
        console.log(JSON.stringify({ instance: instanceName, keys }, null, 2));
        process.exit(0);
    }

    if (keys.length === 0) {
        console.log(`${warnLabel()} No registry API keys found.`);
        process.exit(0);
    }

    console.log(bold(`Registry API keys for ${instanceName}:`));
    for (const key of keys) {
        console.log(`  - ${key.keyId} owner=${key.owner} active=${key.isActive} scopes=${key.scopes.join(',') || '(none)'}`);
    }
    process.exit(0);
}

async function authRevokeKeyCommand(args: ParsedArgs): Promise<void> {
    const instanceName = getFlag(args, 'instance');
    const keyId = getFlag(args, 'key-id');
    if (!instanceName || !keyId) {
        throw new Error('Missing --instance <name> or --key-id <id>. Usage: iranti auth revoke-key --instance <name> --key-id <id>');
    }

    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const { envFile, env } = await loadInstanceEnv(root, instanceName);
    if (detectPlaceholder(env.DATABASE_URL)) {
        throw new Error(`Instance '${instanceName}' still has a placeholder DATABASE_URL. Update ${envFile} first.`);
    }

    initDb(env.DATABASE_URL);
    const revoked = await revokeApiKey(keyId);
    if (!revoked) {
        throw new Error(`API key not found: ${keyId}`);
    }

    if (hasFlag(args, 'json')) {
        console.log(JSON.stringify({ instance: instanceName, keyId, revoked: true }, null, 2));
        process.exit(0);
    }

    console.log(`${okLabel()} Revoked API key '${keyId}' for instance '${instanceName}'.`);
    process.exit(0);
}

async function resolveCommand(args: ParsedArgs): Promise<void> {
    const explicitDir = getFlag(args, 'dir');
    const escalationDir = explicitDir ? path.resolve(explicitDir) : getEscalationPaths().root;
    await resolveInteractive(escalationDir);
}

async function chatCommand(args: ParsedArgs): Promise<void> {
    const provider = normalizeProvider(getFlag(args, 'provider'));
    if (provider && !isSupportedProvider(provider)) {
        throw new Error(`Unsupported provider '${provider}'.`);
    }

    await startChatSession({
        agentId: getFlag(args, 'agent') ?? 'iranti_chat',
        provider,
        model: getFlag(args, 'model'),
        cwd: process.cwd(),
    });
}

function printHelp(): void {
    console.log(`Iranti CLI

Machine-level:
  iranti install [--scope user|system] [--root <path>]
  iranti setup [--scope user|system] [--root <path>] [--config <file> | --defaults] [--db-url <url>] [--bootstrap-db]

Instance-level:
  iranti instance create <name> [--port 3001] [--db-url <url>] [--api-key <token>] [--provider <name>] [--provider-key <token>] [--scope user|system]
  iranti instance list [--scope user|system]
  iranti instance show <name> [--scope user|system]
  iranti run --instance <name> [--scope user|system]

Configuration:
  iranti configure instance <name> [--interactive] [--db-url <url>] [--port <n>] [--api-key <token>] [--provider <name>] [--provider-key <token>] [--clear-provider-key]
  iranti configure project [path] [--interactive] [--instance <name>] [--url <http://host:port>] [--api-key <token>] [--agent-id <id>] [--memory-entity <entity>]

  Auth:
    iranti auth create-key --instance <name> --key-id <id> --owner <owner> [--scopes kb:read,kb:write:project/*] [--description <text>] [--write-instance] [--project <path>] [--agent-id <id>]
    iranti auth list-keys --instance <name>
    iranti auth revoke-key --instance <name> --key-id <id>

  Provider Keys:
    iranti list api-keys [--instance <name>] [--project <path>] [--json]
    iranti add api-key [provider] [--instance <name>] [--project <path>] [--key <token>] [--set-default]
    iranti update api-key [provider] [--instance <name>] [--project <path>] [--key <token>] [--set-default]
    iranti remove api-key [provider] [--instance <name>] [--project <path>]

Project-level:
  iranti project init [path] --instance <name> [--api-key <token>] [--agent-id <id>] [--force]

  Diagnostics:
    iranti doctor [--instance <name>] [--scope user|system] [--env <file>] [--json]
    iranti status [--scope user|system] [--json]
    iranti upgrade [--check] [--dry-run] [--yes] [--target auto|npm-global|npm-repo|python] [--json]
    iranti chat [--agent <agent-id>] [--provider <provider>] [--model <model>]
    iranti resolve [--dir <escalation-dir>]

Integrations:
  iranti mcp [--help]
  iranti claude-hook --event SessionStart|UserPromptSubmit [--project-env <path>] [--instance-env <path>] [--env-file <path>]
  iranti codex-setup [--name iranti] [--agent codex_code] [--source Codex] [--provider openai] [--project-env <path>] [--local-script]
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

    if (args.command === 'setup') {
        await setupCommand(args);
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

    if (args.command === 'configure') {
        if (args.subcommand === 'instance') {
            await configureInstanceCommand(args);
            return;
        }
        if (args.subcommand === 'project') {
            await configureProjectCommand(args);
            return;
        }
        throw new Error(`Unknown configure subcommand '${args.subcommand ?? ''}'.`);
    }

    if (args.command === 'auth') {
        if (args.subcommand === 'create-key') {
            await authCreateKeyCommand(args);
            return;
        }
        if (args.subcommand === 'list-keys') {
            await authListKeysCommand(args);
            return;
        }
        if (args.subcommand === 'revoke-key') {
            await authRevokeKeyCommand(args);
            return;
        }
        throw new Error(`Unknown auth subcommand '${args.subcommand ?? ''}'.`);
    }

    if (args.command === 'list' && args.subcommand === 'api-keys') {
        await listProviderKeysCommand(args);
        return;
    }

    if (args.command === 'add' && args.subcommand === 'api-key') {
        await upsertProviderKeyCommand(args, 'add');
        return;
    }

    if (args.command === 'update' && args.subcommand === 'api-key') {
        await upsertProviderKeyCommand(args, 'update');
        return;
    }

    if (args.command === 'remove' && args.subcommand === 'api-key') {
        await removeProviderKeyCommand(args);
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

    if (args.command === 'status') {
        await statusCommand(args);
        return;
    }

    if (args.command === 'upgrade') {
        await upgradeCommand(args);
        return;
    }

    if (args.command === 'chat') {
        await chatCommand(args);
        return;
    }

    if (args.command === 'resolve') {
        await resolveCommand(args);
        return;
    }

    if (args.command === 'mcp') {
        await handoffToScript('iranti-mcp', process.argv.slice(3));
        return;
    }

    if (args.command === 'claude-hook') {
        await handoffToScript('claude-code-memory-hook', process.argv.slice(3));
        return;
    }

    if (args.command === 'codex-setup') {
        await handoffToScript('codex-setup', process.argv.slice(3));
        return;
    }

    throw new Error(`Unknown command '${args.command}'. Run: iranti help`);
}

main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${failLabel('ERROR')} ${message}`);
    process.exit(1);
});
