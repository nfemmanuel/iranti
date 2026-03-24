#!/usr/bin/env node
import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import readline from 'readline/promises';
import { Writable } from 'stream';
import net from 'net';
import { disconnectDb, initDb } from '../src/library/client';
import { createOrRotateApiKey, formatApiKeyToken, generateApiKeySecret, listApiKeys, revokeApiKey } from '../src/security/apiKeys';
import { getEscalationPaths } from '../src/lib/escalationPaths';
import { parseDockerContainerNames, parsePublishedDockerHostPorts } from '../src/lib/dockerCliParsing';
import { loadRuntimeEnv } from '../src/lib/runtimeEnv';
import { resolveInteractive } from '../src/resolutionist';
import { startChatSession } from '../src/chat';
import { createVectorBackend, resolveVectorBackendName } from '../src/library/backends';
import { InstanceRuntimeState, isPidRunning, readRuntimeState, waitForPidExit } from '../src/lib/runtimeLifecycle';
import { Iranti } from '../src/sdk';

type Scope = 'user' | 'system';

type ParsedArgs = {
    command: string | null;
    subcommand: string | null;
    positionals: string[];
    flags: Map<string, string | boolean>;
};

type CliErrorDetails = Record<string, string | number | boolean | null | undefined>;

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

type InstanceRuntimeSummary = {
    state: InstanceRuntimeState | null;
    running: boolean;
    stale: boolean;
    classification: 'running' | 'unhealthy' | 'stale' | 'stopped' | 'missing' | 'invalid';
    detail: string;
    health: {
        checked: boolean;
        ok: boolean;
        source: 'health-url' | 'port-health' | 'none';
        detail: string;
    };
};

type InstanceConfigSummary = {
    classification: 'complete' | 'partial' | 'invalid';
    detail: string;
    metaFile: string;
    envFile: string;
    state: {
        metaPresent: boolean;
        envPresent: boolean;
        metaReadable: boolean;
        envReadable: boolean;
    };
};

type RuntimeRootSource =
    | 'flag'
    | 'env'
    | 'project-binding'
    | 'cwd-runtime'
    | 'user-install-meta'
    | 'system-install-meta'
    | 'default-user'
    | 'default-system';

type RuntimeRootResolution = {
    root: string;
    source: RuntimeRootSource;
    userRoot: string;
    systemRoot: string;
    installMetaPath: string;
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

type UninstallProjectArtifact = {
    projectPath: string;
    bindingFile?: string;
    mcpFile?: string;
    claudeSettingsFile?: string;
};

type UninstallRuntimeRoot = {
    path: string;
    source: 'active-root' | 'binding' | 'scan';
};

type UninstallProcessCandidate = {
    pid: number;
    source: 'runtime' | 'process-scan';
    label: string;
    command?: string;
};

type UninstallExecutionResult = {
    label: string;
    status: 'pass' | 'warn' | 'fail';
    detail: string;
};

type UpgradeTargetStatus = {
    target: Exclude<UpgradeTarget, 'auto'>;
    available: boolean;
    currentVersion: string | null;
    latestVersion: string | null;
    upToDate: boolean | null;
    blockedReason?: string;
};

type ProviderKeyTarget = {
    instanceName?: string;
    envFile: string;
    env: Record<string, string>;
    source: 'instance' | 'project-binding';
    bindingFile?: string;
    projectPath?: string;
};

type ClaudeScaffoldStatus = 'created' | 'updated' | 'unchanged';

type ClaudeProjectScaffoldResult = {
    mcp: ClaudeScaffoldStatus;
    settings: ClaudeScaffoldStatus;
};

type AttendantCliTarget = {
    envSource: string;
    envFile: string | null;
    projectEnvFile?: string;
    instanceEnvFile?: string;
    agentId: string;
    iranti: Iranti;
};

class CliError extends Error {
    readonly code: string;
    readonly hints: string[];
    readonly details?: CliErrorDetails;

    constructor(code: string, message: string, hints: string[] = [], details?: CliErrorDetails) {
        super(message);
        this.name = 'CliError';
        this.code = code;
        this.hints = hints;
        this.details = details;
    }
}

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

let CLI_DEBUG = process.argv.includes('--debug') || process.env.IRANTI_DEBUG === '1';
let CLI_VERBOSE = CLI_DEBUG || process.argv.includes('--verbose') || process.env.IRANTI_VERBOSE === '1';

// H-7: Cleanup/rollback stack — LIFO handlers run on SIGINT/SIGTERM to undo partial multi-step operations
const _cleanupStack: Array<() => void | Promise<void>> = [];
function pushCleanup(fn: () => void | Promise<void>): void {
    _cleanupStack.push(fn);
}
function popCleanup(): void {
    _cleanupStack.pop();
}
async function runCleanupStack(): Promise<void> {
    while (_cleanupStack.length > 0) {
        const fn = _cleanupStack.pop()!;
        try {
            await fn();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[cleanup] Error during rollback: ${msg}\n`);
        }
    }
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
        void runCleanupStack().finally(() => process.exit(130));
    });
}

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

function commandText(text: string): string {
    return paint(text, 'cyan');
}

function sectionTitle(text: string): string {
    return bold(paint(text, 'blue'));
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

function printNextSteps(steps: string[]): void {
    if (steps.length === 0) return;
    console.log('');
    console.log(sectionTitle('Next Steps'));
    for (const [index, step] of steps.entries()) {
        console.log(`  ${index + 1}. ${step}`);
    }
}

function setCliDebugFlags(args: ParsedArgs): void {
    CLI_DEBUG = CLI_DEBUG || hasFlag(args, 'debug');
    CLI_VERBOSE = CLI_VERBOSE || CLI_DEBUG || hasFlag(args, 'verbose');
}

function debugLog(message: string, details?: CliErrorDetails): void {
    if (!CLI_DEBUG) return;
    const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
    console.log(`${paint('[DEBUG]', 'gray')} ${message}${suffix}`);
}

function verboseLog(message: string, details?: CliErrorDetails): void {
    if (!CLI_VERBOSE) return;
    const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
    console.log(`${paint('[TRACE]', 'gray')} ${message}${suffix}`);
}

function cliError(code: string, message: string, hints: string[] = [], details?: CliErrorDetails): CliError {
    return new CliError(code, message, hints, details);
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
    return resolveInstallRootDetails(args, scope).root;
}

function walkAncestorPaths(startDir: string): string[] {
    const dirs: string[] = [];
    let current = path.resolve(startDir);

    while (true) {
        dirs.push(current);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return dirs;
}

function findClosestAncestorFile(startDir: string, fileName: string): string | null {
    for (const dir of walkAncestorPaths(startDir)) {
        const candidate = path.join(dir, fileName);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return null;
}

function findClosestAncestorRuntimeRoot(startDir: string): string | null {
    for (const dir of walkAncestorPaths(startDir)) {
        for (const runtimeDirName of ['.iranti-runtime', '.iranti']) {
            const candidate = path.join(dir, runtimeDirName);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                return path.resolve(candidate);
            }
        }
    }
    return null;
}

function resolveInstallRootDetails(args: ParsedArgs, scope: Scope): RuntimeRootResolution {
    const explicit = getFlag(args, 'root') ?? process.env.IRANTI_HOME;
    if (explicit) {
        return {
            root: path.resolve(explicit),
            source: getFlag(args, 'root') ? 'flag' : 'env',
            userRoot: defaultInstallRoot('user'),
            systemRoot: defaultInstallRoot('system'),
            installMetaPath: path.join(path.resolve(explicit), 'install.json'),
        };
    }

    const userRoot = defaultInstallRoot('user');
    const systemRoot = defaultInstallRoot('system');

    const userMeta = path.join(userRoot, 'install.json');
    const systemMeta = path.join(systemRoot, 'install.json');
    const cwd = process.cwd();
    const projectBindingFile = findClosestAncestorFile(cwd, '.env.iranti');
    const localRuntimeRoot = findClosestAncestorRuntimeRoot(cwd);

    if (scope === 'system') {
        return {
            root: systemRoot,
            source: 'default-system',
            userRoot,
            systemRoot,
            installMetaPath: systemMeta,
        };
    }
    if (projectBindingFile && fs.existsSync(projectBindingFile)) {
        try {
            const raw = fs.readFileSync(projectBindingFile, 'utf-8');
            const match = raw.match(/^\s*IRANTI_INSTANCE_ENV\s*=\s*(.+)\s*$/m);
            const value = match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
            const boundRoot = inferRuntimeRootFromInstanceEnv(value);
            if (boundRoot && fs.existsSync(boundRoot)) {
                return {
                    root: boundRoot,
                    source: 'project-binding',
                    userRoot,
                    systemRoot,
                    installMetaPath: path.join(boundRoot, 'install.json'),
                };
            }
        } catch {
            // Fall through to other resolution strategies.
        }
    }
    if (localRuntimeRoot) {
        return {
            root: localRuntimeRoot,
            source: 'cwd-runtime',
            userRoot,
            systemRoot,
            installMetaPath: path.join(localRuntimeRoot, 'install.json'),
        };
    }
    if (fs.existsSync(userMeta)) {
        return {
            root: userRoot,
            source: 'user-install-meta',
            userRoot,
            systemRoot,
            installMetaPath: userMeta,
        };
    }
    if (fs.existsSync(systemMeta)) {
        return {
            root: systemRoot,
            source: 'system-install-meta',
            userRoot,
            systemRoot,
            installMetaPath: systemMeta,
        };
    }
    return {
        root: userRoot,
        source: 'default-user',
        userRoot,
        systemRoot,
        installMetaPath: userMeta,
    };
}

function describeRuntimeRootSource(source: RuntimeRootSource): string {
    switch (source) {
        case 'flag':
            return '--root flag';
        case 'env':
            return 'IRANTI_HOME';
        case 'project-binding':
            return 'project binding';
        case 'cwd-runtime':
            return 'cwd runtime root';
        case 'user-install-meta':
            return 'user install metadata';
        case 'system-install-meta':
            return 'system install metadata';
        case 'default-system':
            return 'system default';
        case 'default-user':
        default:
            return 'user default';
    }
}

function inferRuntimeRootFromInstanceEnv(instanceEnvFile: string | undefined): string | null {
    if (!instanceEnvFile) return null;
    const normalized = path.resolve(instanceEnvFile);
    if (path.basename(normalized).toLowerCase() !== '.env') return null;
    const instanceDir = path.dirname(normalized);
    const instancesDir = path.dirname(instanceDir);
    if (path.basename(instancesDir).toLowerCase() !== 'instances') return null;
    return path.dirname(instancesDir);
}

async function inspectProjectBinding(projectEnvFile: string): Promise<{
    bindingFile: string;
    instanceEnvFile: string | null;
    runtimeRoot: string | null;
}> {
    try {
        const env = await readEnvFile(projectEnvFile);
        const instanceEnvFile = env.IRANTI_INSTANCE_ENV?.trim() || null;
        return {
            bindingFile: projectEnvFile,
            instanceEnvFile,
            runtimeRoot: inferRuntimeRootFromInstanceEnv(instanceEnvFile ?? undefined),
        };
    } catch {
        return {
            bindingFile: projectEnvFile,
            instanceEnvFile: null,
            runtimeRoot: null,
        };
    }
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
    if (/Could not find Prisma Schema/i.test(reason)) {
        return new Error(
            `Database bootstrap failed because Prisma could not locate prisma/schema.prisma from the active package. ` +
            `This usually means the installed CLI bundle or working-directory handoff is wrong. ` +
            `Underlying error: ${reason}`
        );
    }
    if (/extension "vector" is not available|pgvector extension is not installed|does not have the pgvector extension installed/i.test(reason)) {
        return new Error(
            `Database bootstrap failed because the target PostgreSQL server does not provide pgvector. ` +
            `Iranti currently requires pgvector-capable PostgreSQL for schema bootstrap. ` +
            `Install pgvector on that server, or rerun setup with --db-mode docker or a managed pgvector-capable database. ` +
            `Underlying error: ${reason}`
        );
    }
    return new Error(
        `Database bootstrap failed after instance configuration. ` +
        `Common causes are a non-empty database that Prisma has not baselined yet, or a PostgreSQL server without the pgvector extension installed. ` +
        `Re-run setup without --bootstrap-db, or point Iranti at a fresh pgvector-capable database. ` +
        `Underlying error: ${reason}`
    );
}

async function handoffToScript(scriptName: string, rawArgs: string[]): Promise<void> {
    const builtPath = builtScriptPath(scriptName);
    debugLog('Handing off to companion script.', { scriptName, builtPath, rawArgs: rawArgs.join(' ') });
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
        throw cliError(
            'IRANTI_SCRIPT_NOT_FOUND',
            `Unable to locate ${scriptName} implementation.`,
            ['Run from an installed Iranti package or from the Iranti repo root where scripts/ exists.'],
            { scriptName, sourcePath, builtPath }
        );
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
        const sourcePath = path.resolve(process.cwd(), 'scripts', `${scriptName}.ts`);
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Unable to locate bundled script: ${scriptName}`);
        }
        await new Promise<void>((resolve, reject) => {
            const child = spawn('npx', ['ts-node', sourcePath, ...rawArgs], {
                stdio: 'inherit',
                env: {
                    ...process.env,
                    ...extraEnv,
                },
                cwd: packageRoot(),
                shell: process.platform === 'win32',
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
        return;
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
    // Atomic write: write to temp file then rename to avoid partial writes on crash
    const tmpPath = `${filePath}.tmp${process.pid}`;
    try {
        await fsp.writeFile(tmpPath, content, { encoding: 'utf-8', flag: 'w' });
        await fsp.rename(tmpPath, filePath);
    } catch (err) {
        await fsp.unlink(tmpPath).catch(() => undefined);
        throw err;
    }
}

const MAX_ENV_FILE_BYTES = 1_048_576; // 1 MiB

async function readEnvFile(filePath: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const stat = await fsp.stat(filePath).catch(() => null);
    if (stat && stat.size > MAX_ENV_FILE_BYTES) {
        throw new Error(`Env file too large (${stat.size} bytes): ${filePath}. Maximum is ${MAX_ENV_FILE_BYTES} bytes.`);
    }
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
        .replace(/^\n+/, '') // strip leading blank lines only
        .trimEnd();          // strip trailing whitespace only — preserving internal blank line groups

    await writeText(filePath, `${finalLines}\n`);
}

function redactSecret(value: string | undefined): string {
    if (!value) return '(unset)';
    if (value.length <= 8) return '********';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function instancePaths(root: string, name: string): { instanceDir: string; envFile: string; metaFile: string; runtimeFile: string } {
    const instanceDir = path.join(root, 'instances', name);
    return {
        instanceDir,
        envFile: path.join(instanceDir, '.env'),
        metaFile: path.join(instanceDir, 'instance.json'),
        runtimeFile: path.join(instanceDir, 'runtime.json'),
    };
}

async function loadInstanceEnv(root: string, name: string): Promise<{ instanceDir: string; envFile: string; metaFile: string; runtimeFile: string; env: Record<string, string> }> {
    const paths = instancePaths(root, name);
    if (!fs.existsSync(paths.envFile)) {
        throw cliError(
            'IRANTI_INSTANCE_NOT_FOUND',
            `Instance '${name}' not found at ${paths.instanceDir}`,
            [
                'Run `iranti instance list` to see known instances.',
                `Run \`iranti setup\` or \`iranti instance create ${name}\` if this instance does not exist yet.`,
            ],
            { instance: name, root, instanceDir: paths.instanceDir }
        );
    }
    debugLog('Loaded instance env target.', { instance: name, envFile: paths.envFile });
    return {
        ...paths,
        env: await readEnvFile(paths.envFile),
    };
}

function probeHealthUrl(urlString: string, timeoutMs: number = 800): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: { ok: boolean; detail: string }) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        let parsed: URL;
        try {
            parsed = new URL(urlString);
        } catch {
            finish({ ok: false, detail: 'invalid health URL' });
            return;
        }

        const transport = parsed.protocol === 'https:' ? https : http;
        const req = transport.request(parsed, { method: 'GET', timeout: timeoutMs }, (res) => {
            res.resume();
            if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
                finish({ ok: true, detail: `health ${res.statusCode}` });
                return;
            }
            finish({ ok: false, detail: `health ${res.statusCode ?? 'unknown'}` });
        });

        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', (error) => {
            finish({ ok: false, detail: error.message });
        });
        req.end();
    });
}

async function inspectInstanceConfig(root: string, name: string): Promise<InstanceConfigSummary> {
    const { envFile, metaFile } = instancePaths(root, name);
    const metaPresent = fs.existsSync(metaFile);
    const envPresent = fs.existsSync(envFile);

    let metaReadable = false;
    let envReadable = false;

    if (metaPresent) {
        try {
            const raw = await fsp.readFile(metaFile, 'utf8');
            const parsed = JSON.parse(raw) as Partial<InstanceMeta>;
            metaReadable = typeof parsed.name === 'string' && parsed.name.trim().length > 0;
        } catch {
            metaReadable = false;
        }
    }

    if (envPresent) {
        try {
            await readEnvFile(envFile);
            envReadable = true;
        } catch {
            envReadable = false;
        }
    }

    let classification: InstanceConfigSummary['classification'];
    let detail: string;
    if (metaPresent && envPresent && metaReadable && envReadable) {
        classification = 'complete';
        detail = 'instance metadata and env are present';
    } else if ((metaPresent && !metaReadable) || (envPresent && !envReadable)) {
        classification = 'invalid';
        detail = [
            !metaReadable && metaPresent ? 'instance metadata unreadable' : null,
            !envReadable && envPresent ? 'env unreadable' : null,
        ].filter((value): value is string => Boolean(value)).join('; ');
    } else {
        classification = 'partial';
        detail = [
            !metaPresent ? 'missing instance.json' : null,
            !envPresent ? 'missing .env' : null,
        ].filter((value): value is string => Boolean(value)).join('; ') || 'instance directory incomplete';
    }

    return {
        classification,
        detail,
        metaFile,
        envFile,
        state: {
            metaPresent,
            envPresent,
            metaReadable,
            envReadable,
        },
    };
}

async function readInstanceRuntimeSummary(root: string, name: string): Promise<InstanceRuntimeSummary> {
    const { runtimeFile } = instancePaths(root, name);
    if (!fs.existsSync(runtimeFile)) {
        return {
            state: null,
            running: false,
            stale: false,
            classification: 'missing',
            detail: 'no runtime metadata',
            health: { checked: false, ok: false, source: 'none', detail: 'no runtime metadata' },
        };
    }
    const state = await readRuntimeState(runtimeFile);
    if (!state) {
        return {
            state: null,
            running: false,
            stale: false,
            classification: 'invalid',
            detail: 'runtime metadata is unreadable or incomplete',
            health: { checked: false, ok: false, source: 'none', detail: 'runtime metadata unavailable' },
        };
    }
    const processAlive = isPidRunning(state.pid);
    const stale = !processAlive && state.status !== 'stopped';
    const healthUrl = state.healthUrl?.trim() || `http://127.0.0.1:${state.port}/health`;
    const health = processAlive
        ? await probeHealthUrl(healthUrl)
        : { ok: false, detail: stale ? 'process not running' : 'runtime stopped' };
    const running = processAlive && health.ok;
    const healthSource: InstanceRuntimeSummary['health']['source'] = state.healthUrl?.trim() ? 'health-url' : 'port-health';
    const classification: InstanceRuntimeSummary['classification'] = running
        ? 'running'
        : stale
            ? 'stale'
            : processAlive
                ? 'unhealthy'
                : 'stopped';
    return {
        state,
        running,
        stale,
        classification,
        detail: running
            ? `pid=${state.pid} version=${state.version}`
            : stale
                ? `last_pid=${state.pid} version=${state.version}`
                : processAlive
                    ? `pid=${state.pid} version=${state.version} health=${health.detail}`
                    : `version=${state.version}`,
        health: {
            checked: processAlive,
            ok: running,
            source: processAlive ? healthSource : 'none',
            detail: health.detail,
        },
    };
}

function describeInstanceRuntime(summary: InstanceRuntimeSummary): string {
    switch (summary.classification) {
        case 'running':
            return `${okLabel('RUNNING')} ${summary.detail}`;
        case 'unhealthy':
            return `${failLabel('UNHEALTHY')} ${summary.detail}`;
        case 'stale':
            return `${warnLabel('STALE')} ${summary.detail}`;
        case 'stopped':
            return `${warnLabel('STOPPED')} ${summary.detail}`;
        case 'invalid':
            return `${failLabel('INVALID')} ${summary.detail}`;
        case 'missing':
        default:
            return `${warnLabel('STOPPED')} ${summary.detail}`;
    }
}

function describeInstanceConfig(summary: InstanceConfigSummary): string {
    switch (summary.classification) {
        case 'complete':
            return `${okLabel('COMPLETE')} ${summary.detail}`;
        case 'partial':
            return `${warnLabel('PARTIAL')} ${summary.detail}`;
        case 'invalid':
        default:
            return `${failLabel('INVALID')} ${summary.detail}`;
    }
}

async function startInstanceRuntime(name: string, instanceDir: string, envFile: string, runtimeFile: string): Promise<void> {
    process.env.IRANTI_INSTANCE_NAME = name;
    process.env.IRANTI_INSTANCE_DIR = instanceDir;
    process.env.IRANTI_INSTANCE_RUNTIME_FILE = runtimeFile;
    process.env.IRANTI_INSTANCE_ENV_FILE = envFile;

    console.log(`${infoLabel()} Starting Iranti instance '${name}' on port ${process.env.IRANTI_PORT ?? '3001'}...`);
    const serverEntry = path.resolve(__dirname, '..', 'src', 'api', 'server');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require(serverEntry);
}

async function stopRuntimeProcess(pid: number, timeoutMs: number): Promise<boolean> {
    if (!isPidRunning(pid)) return true;
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        if (process.platform === 'win32') {
            const proc = runCommandCapture('taskkill', ['/PID', String(pid), '/T']);
            if (proc.status !== 0) {
                return false;
            }
        } else {
            return false;
        }
    }
    if (await waitForPidExit(pid, timeoutMs)) {
        return true;
    }
    return false;
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
        throw cliError(
            'IRANTI_PROJECT_BINDING_MISSING',
            'No --instance provided and no .env.iranti found in the current project.',
            ['Run `iranti project init . --instance <name>` or pass `--instance <name>`.'],
            { projectPath, bindingFile }
        );
    }

    const binding = await readEnvFile(bindingFile);
    const envFile = binding.IRANTI_INSTANCE_ENV?.trim();
    if (!envFile) {
        throw cliError(
            'IRANTI_BINDING_INSTANCE_ENV_MISSING',
            `Project binding is missing IRANTI_INSTANCE_ENV: ${bindingFile}`,
            ['Run `iranti configure project` to refresh the binding.'],
            { bindingFile }
        );
    }
    if (!fs.existsSync(envFile)) {
        throw cliError(
            'IRANTI_BINDING_INSTANCE_ENV_NOT_FOUND',
            `Instance env referenced by project binding was not found: ${envFile}`,
            ['Run `iranti configure project` to refresh the binding or recreate the target instance.'],
            { bindingFile, envFile }
        );
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
    secretRequired: (prompt: string, currentValue?: string) => Promise<string | undefined>;
};

type SetupProjectBinding = {
    projectPath: string;
    envFile: string;
    agentId: string;
    projectMode: ProjectMemoryMode;
};

type ProjectMemoryMode = 'isolated' | 'shared';

type DatabaseSetupMode = 'local' | 'managed' | 'docker';

type SetupProjectPlan = {
    path: string;
    agentId: string;
    memoryEntity: string;
    projectMode: ProjectMemoryMode;
    claudeCode?: boolean;
};

type SetupExecutionPlan = {
    mode: 'shared' | 'isolated';
    scope: Scope;
    root: string;
    instanceName: string;
    port: number;
    databaseUrl: string;
    databaseMode: DatabaseSetupMode;
    provider: string;
    providerKeys: Record<string, string>;
    apiKey: string;
    projects: SetupProjectPlan[];
    codexAgent?: string;
    codex?: boolean;
    bootstrapDatabase?: boolean;
    dockerContainerName?: string;
    databaseProvisioned?: boolean;
};

type SetupExecutionResult = {
    root: string;
    scope: Scope;
    instanceName: string;
    instanceEnvFile: string;
    port: number;
    mode: 'shared' | 'isolated';
    databaseMode: DatabaseSetupMode;
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
            const suffix = currentValue !== undefined && currentValue !== '' ? ` [${currentValue}]` : '';
            const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
            return answer.length > 0 ? answer : currentValue;
        },
        secret: async (prompt: string, currentValue?: string) => {
            const placeholder = currentValue ? `${redactSecret(currentValue)} (enter new value to replace)` : 'leave blank to skip';
            const suffix = placeholder ? ` [${placeholder}]` : '';
            process.stdout.write(`${prompt}${suffix}: `);
            muted = true;
            const answer = (await rl.question('')).trim();
            muted = false;
            process.stdout.write('\n');
            if (!answer || answer === placeholder) return currentValue;
            if (answer === '__clear__') return undefined;
            return answer;
        },
        secretRequired: async (prompt: string, currentValue?: string) => {
            const placeholder = currentValue ? `${redactSecret(currentValue)} (enter new value to replace)` : 'required';
            const suffix = placeholder ? ` [${placeholder}]` : '';
            process.stdout.write(`${prompt}${suffix}: `);
            muted = true;
            const answer = (await rl.question('')).trim();
            muted = false;
            process.stdout.write('\n');
            if (!answer || answer === placeholder) return currentValue;
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
    if (normalized.length === 0) return true;
    const exactWeakValues = new Set([
        'changeme',
        'placeholder',
        'example',
        'todo',
        'fixme',
        'none',
        'null',
        'undefined',
    ]);
    if (exactWeakValues.has(normalized)) return true;
    const weakFragments = [
        'yourpassword',
        'replace_me',
        'your_secret',
        'your_key_here',
        'your_api_key',
        'insert_key_here',
        'add_your_key',
    ];
    return weakFragments.some((p) => normalized.includes(p));
}

function quoteSqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function quoteSqlIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function parsePostgresConnectionString(databaseUrl: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(databaseUrl);
    } catch {
        throw new Error(`Invalid PostgreSQL connection string: ${databaseUrl}`);
    }
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
        throw new Error(`Unsupported database protocol '${parsed.protocol}'. Iranti setup only bootstraps PostgreSQL.`);
    }
    return parsed;
}

function postgresDatabaseName(databaseUrl: string): string {
    const parsed = parsePostgresConnectionString(databaseUrl);
    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    if (!database) {
        throw new Error('DATABASE_URL must include a database name.');
    }
    return database;
}

function isLocalPostgresHost(hostname: string): boolean {
    const normalized = hostname.trim().toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function sanitizeIdentifier(input: string, fallback: string): string {
    const value = input.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    if (!value && input.trim()) {
        verboseLog(`sanitizeIdentifier: input "${input}" normalized to empty — using fallback "${fallback}"`);
    }
    return value || fallback;
}

function projectAgentDefault(projectPath: string): string {
    return `${sanitizeIdentifier(path.basename(projectPath), 'project')}_main`;
}

function normalizeProjectMode(raw: string | undefined, fallback: ProjectMemoryMode = 'shared'): ProjectMemoryMode {
    if (!raw) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'isolated' || normalized === 'shared') {
        return normalized;
    }
    throw new Error(`Invalid project mode '${raw}'. Use isolated or shared.`);
}

function inferProjectMode(projectPath: string, instanceEnvFile?: string): ProjectMemoryMode {
    if (instanceEnvFile && isPathInside(projectPath, instanceEnvFile)) {
        return 'isolated';
    }
    return 'shared';
}

function recommendDatabaseMode(checks: DependencyCheck[]): DatabaseSetupMode {
    const reachableLocal = checks.find((check) => check.name === 'localhost:5432')?.status === 'pass';
    const docker = checks.find((check) => check.name === 'docker daemon')?.status === 'pass';
    if (reachableLocal && !docker) return 'local';
    if (docker) return 'docker';
    if (reachableLocal) return 'local';
    return 'managed';
}

function quickInstallGuidanceLines(): string[] {
    if (process.platform === 'win32') {
        return [
            'Docker: winget install Docker.DockerDesktop',
            'PostgreSQL: install PostgreSQL 17 and a pgvector-capable build or extension package.',
        ];
    }
    if (process.platform === 'darwin') {
        return [
            'Docker: brew install --cask docker',
            'PostgreSQL: brew install postgresql@17 plus pgvector for that server.',
        ];
    }
    return [
        'Docker: install Docker Engine using your distro package manager or the official Docker instructions.',
        'PostgreSQL: install PostgreSQL 16+ and the pgvector extension using your distro package manager.',
    ];
}

function printQuickInstallGuidance(): void {
    console.log(bold('Quick local database install options'));
    for (const line of quickInstallGuidanceLines()) {
        console.log(`  - ${line}`);
    }
}

function isSupportedProvider(provider: string | undefined): boolean {
    const normalized = normalizeProvider(provider);
    if (!normalized) return false;
    return Object.prototype.hasOwnProperty.call(PROVIDER_ENV_KEYS, normalized);
}

async function promptYesNo(session: PromptSession, prompt: string, defaultValue: boolean): Promise<boolean> {
    const defaultToken = defaultValue ? 'Y/n' : 'y/N';
    while (true) {
        const answer = (await session.line(`${prompt} (${defaultToken})`) ?? '').trim().toLowerCase();
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
        const value = (await session.secretRequired(prompt, currentValue) ?? '').trim();
        if (value.length > 0 && !detectPlaceholder(value)) return value;
        console.log(`${warnLabel()} ${prompt} is required.`);
    }
}

async function promptSecretWithDefault(
    session: PromptSession,
    prompt: string,
    defaultValue: string,
): Promise<string> {
    while (true) {
        const value = (await session.secret(`${prompt} (blank uses local-dev default)`, undefined) ?? '').trim();
        if (!value) {
            console.log(`${infoLabel()} Using the local development default for ${prompt}.`);
            return defaultValue;
        }
        if (!detectPlaceholder(value)) return value;
        console.log(`${warnLabel()} ${prompt} still looks like a placeholder. Enter a real value or leave it blank to use the local-dev default.`);
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

    await syncInstanceMeta(root, name, config.port);

    return { envFile, instanceDir, created };
}

function makeIrantiMcpServerConfig(): { command: string; args: string[] } {
    return {
        command: 'iranti',
        args: ['mcp'],
    };
}

function applyEnvMap(vars: Record<string, string>): void {
    for (const [key, value] of Object.entries(vars)) {
        process.env[key] = value;
    }
}

async function resolveAttendantCliTarget(args: ParsedArgs): Promise<AttendantCliTarget> {
    const explicitAgent = getFlag(args, 'agent')?.trim();
    const explicitProjectEnv = getFlag(args, 'project-env');
    const instanceName = getFlag(args, 'instance');

    let envSource = 'project';
    let envFile: string | null = null;
    let projectEnvFile: string | undefined;
    let instanceEnvFile: string | undefined;

    if (instanceName) {
        const scope = normalizeScope(getFlag(args, 'scope'));
        const root = resolveInstallRoot(args, scope);
        const loaded = await loadInstanceEnv(root, instanceName);
        applyEnvMap(loaded.env);
        envSource = `instance:${instanceName}`;
        envFile = loaded.envFile;
        instanceEnvFile = loaded.envFile;
    } else {
        const cwd = path.resolve(getFlag(args, 'project') ?? process.cwd());
        const loaded = loadRuntimeEnv({
            cwd,
            projectEnvFile: explicitProjectEnv ? path.resolve(explicitProjectEnv) : undefined,
        });
        envSource = loaded.projectEnvFile ? 'project-binding' : 'environment';
        envFile = loaded.projectEnvFile ?? loaded.instanceEnvFile ?? null;
        projectEnvFile = loaded.projectEnvFile;
        instanceEnvFile = loaded.instanceEnvFile;
    }

    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        throw new Error('DATABASE_URL is required. Run from a bound project, pass --instance <name>, or set DATABASE_URL first.');
    }

    const agentId = explicitAgent
        || process.env.IRANTI_AGENT_ID?.trim()
        || process.env.IRANTI_CLAUDE_AGENT_ID?.trim()
        || 'iranti_cli';

    return {
        envSource,
        envFile,
        projectEnvFile,
        instanceEnvFile,
        agentId,
        iranti: new Iranti({ connectionString }),
    };
}

function truncateText(value: string, limit: number): string {
    return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function resolveRecentMessages(args: ParsedArgs): string[] {
    const inline = getFlag(args, 'recent');
    const file = getFlag(args, 'recent-file');
    if (inline) {
        return inline
            .split('||')
            .map((item) => item.trim())
            .filter(Boolean);
    }
    if (file) {
        const content = fs.readFileSync(path.resolve(file), 'utf-8');
        return content
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
    }
    return [];
}

function parsePositiveInteger(raw: string | undefined, label: string): number | undefined {
    if (!raw) return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function resolveContextText(args: ParsedArgs): string {
    const inline = getFlag(args, 'context');
    if (inline) return inline;
    const file = getFlag(args, 'context-file');
    if (file) {
        return fs.readFileSync(path.resolve(file), 'utf-8');
    }
    return '';
}

function resolveAttendMessage(args: ParsedArgs): string {
    const fromFlag = getFlag(args, 'message');
    if (fromFlag?.trim()) return fromFlag.trim();
    const fromPositionals = args.positionals.join(' ').trim();
    if (fromPositionals) return fromPositionals;
    throw new Error('Missing latest message. Usage: iranti attend [message] [--message <text>] [--context <text>] [--json]');
}

function parseDelimitedList(raw: string | undefined): string[] {
    if (!raw?.trim()) return [];
    const delimiter = raw.includes('||') ? '||' : ',';
    return raw
        .split(delimiter)
        .map((item) => item.trim())
        .filter(Boolean);
}

function resolveTaskEntity(args: ParsedArgs): string {
    const entity = (args.subcommand ?? args.positionals[0] ?? getFlag(args, 'entity') ?? '').trim();
    if (!entity) {
        throw new Error('Missing task entity. Usage: iranti handoff task/<task_id> --next-step <text> [--json]');
    }
    if (!entity.includes('/')) {
        throw new Error('task entity must use entityType/entityId format.');
    }
    return entity;
}

function buildHandoffSummary(key: string, value: unknown): string {
    switch (key) {
        case 'status': {
            const state = typeof value === 'object' && value && 'state' in value ? String((value as { state: unknown }).state) : 'updated';
            return `Shared task status is ${state}.`;
        }
        case 'current_owner': {
            const agentId = typeof value === 'object' && value && 'agentId' in value ? String((value as { agentId: unknown }).agentId) : 'unassigned';
            return `Current owner is ${agentId}.`;
        }
        case 'next_step': {
            const instruction = typeof value === 'object' && value && 'instruction' in value ? String((value as { instruction: unknown }).instruction) : 'Next step updated.';
            return truncateText(`Next step: ${instruction}`, 140);
        }
        case 'blockers': {
            const count = typeof value === 'object' && value && 'items' in value && Array.isArray((value as { items: unknown[] }).items)
                ? (value as { items: unknown[] }).items.length
                : 0;
            return count === 0 ? 'No blockers recorded.' : `${count} blocker${count === 1 ? '' : 's'} recorded for the shared task.`;
        }
        case 'artifacts': {
            const count = typeof value === 'object' && value && 'files' in value && Array.isArray((value as { files: unknown[] }).files)
                ? (value as { files: unknown[] }).files.length
                : 0;
            return count === 0 ? 'No artifacts recorded.' : `${count} artifact${count === 1 ? '' : 's'} recorded for the shared task.`;
        }
        case 'notes': {
            const text = typeof value === 'object' && value && 'text' in value ? String((value as { text: unknown }).text) : 'Shared handoff notes updated.';
            return truncateText(`Notes: ${text}`, 140);
        }
        case 'active_handoff_task': {
            const taskEntity = typeof value === 'object' && value && 'taskEntity' in value ? String((value as { taskEntity: unknown }).taskEntity) : 'task';
            return `Project now points to active handoff ${taskEntity}.`;
        }
        default:
            return 'Shared handoff state updated.';
    }
}

function printHandoffResult(
    target: AttendantCliTarget,
    taskEntity: string,
    writes: Array<{ entity: string; key: string; summary: string }>,
): void {
    console.log(bold('Iranti handoff'));
    console.log(`  agent         ${target.agentId}`);
    console.log(`  env source    ${target.envSource}`);
    if (target.envFile) console.log(`  env file      ${target.envFile}`);
    console.log(`  task entity   ${taskEntity}`);
    console.log(`  writes        ${writes.length}`);
    console.log('');
    for (const write of writes) {
        console.log(`- ${write.entity} :: ${write.key} | ${write.summary}`);
    }
}

function printHandshakeResult(target: AttendantCliTarget, task: string, result: Awaited<ReturnType<Iranti['handshake']>>): void {
    console.log(bold('Iranti handshake'));
    console.log(`  agent         ${target.agentId}`);
    console.log(`  env source    ${target.envSource}`);
    if (target.envFile) console.log(`  env file      ${target.envFile}`);
    console.log(`  task          ${task}`);
    console.log(`  inferred task ${result.inferredTaskType}`);
    console.log(`  memory facts  ${result.workingMemory.length}`);
    console.log(`  generated     ${result.briefGeneratedAt}`);
    console.log('');
    console.log(`Rules: ${truncateText(result.operatingRules, 160)}`);
    if (result.workingMemory.length === 0) {
        console.log('');
        console.log('No working memory entries loaded.');
        return;
    }
    console.log('');
    for (const entry of result.workingMemory) {
        console.log(`- ${entry.entityKey} | ${entry.summary} | ${entry.confidence} | ${entry.source}`);
    }
}

function printAttendResult(
    target: AttendantCliTarget,
    latestMessage: string,
    result: Awaited<ReturnType<Iranti['attend']>>,
): void {
    console.log(bold('Iranti attend'));
    console.log(`  agent         ${target.agentId}`);
    console.log(`  env source    ${target.envSource}`);
    if (target.envFile) console.log(`  env file      ${target.envFile}`);
    console.log(`  message       ${truncateText(latestMessage, 120)}`);
    console.log(`  inject        ${result.shouldInject ? 'yes' : 'no'}`);
    console.log(`  reason        ${result.reason}`);
    console.log(`  method        ${result.decision.method}`);
    console.log(`  confidence    ${result.decision.confidence}`);
    console.log(`  explanation   ${result.decision.explanation}`);
    console.log(`  facts         ${result.facts.length}`);
    if (result.facts.length === 0) {
        console.log('');
        console.log('No facts selected for injection.');
        return;
    }
    console.log('');
    for (const fact of result.facts) {
        console.log(`- ${fact.entityKey} | ${fact.summary} | ${fact.confidence} | ${fact.source}`);
    }
}

function quoteClaudeHookArg(value: string): string {
    if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
        return value;
    }
    return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

function makeClaudeHookCommand(event: 'SessionStart' | 'UserPromptSubmit', projectEnvPath?: string): string {
    const parts = ['iranti', 'claude-hook', '--event', event];
    if (projectEnvPath) {
        parts.push('--project-env', quoteClaudeHookArg(projectEnvPath));
    }
    return parts.join(' ');
}

function makeClaudeHookEntry(event: 'SessionStart' | 'UserPromptSubmit', projectEnvPath?: string): Record<string, unknown> {
    return {
        matcher: '',
        hooks: [
            {
                type: 'command',
                command: makeClaudeHookCommand(event, projectEnvPath),
            },
        ],
    };
}

function isClaudeHooksObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLegacyIrantiClaudeHookEntry(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return entry.command === 'iranti'
        && Array.isArray(entry.args)
        && entry.args[0] === 'claude-hook';
}

function needsClaudeHookSettingsUpgrade(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const settings = value as Record<string, unknown>;
    const hooks = isClaudeHooksObject(settings.hooks) ? settings.hooks : null;
    if (!hooks) {
        return false;
    }
    for (const event of ['SessionStart', 'UserPromptSubmit'] as const) {
        const entries = hooks[event];
        if (!Array.isArray(entries) || entries.length === 0) {
            continue;
        }
        if (entries.some((entry) => isLegacyIrantiClaudeHookEntry(entry))) {
            return true;
        }
    }
    return false;
}

function makeClaudeHookSettings(projectEnvPath?: string, existing?: Record<string, unknown>): Record<string, unknown> {
    const existingHooks = existing && isClaudeHooksObject(existing.hooks)
        ? existing.hooks
        : {};

    return {
        ...(existing ?? {}),
        hooks: {
            ...existingHooks,
            SessionStart: [makeClaudeHookEntry('SessionStart', projectEnvPath)],
            UserPromptSubmit: [makeClaudeHookEntry('UserPromptSubmit', projectEnvPath)],
        },
    };
}

async function writeClaudeCodeProjectFiles(projectPath: string, projectEnvPath?: string, force: boolean = false): Promise<ClaudeProjectScaffoldResult> {
    const mcpFile = path.join(projectPath, '.mcp.json');
    let mcpStatus: ClaudeScaffoldStatus = 'unchanged';
    const irantiMcpServer = makeIrantiMcpServerConfig();
    if (!fs.existsSync(mcpFile)) {
        await writeText(mcpFile, `${JSON.stringify({
            mcpServers: {
                iranti: irantiMcpServer,
            },
        }, null, 2)}\n`);
        mcpStatus = 'created';
    } else {
        const existing = readJsonFile<Record<string, unknown>>(mcpFile);
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
            if (!force) {
                throw new Error(`Existing .mcp.json is not valid JSON. Re-run with --force to overwrite it: ${mcpFile}`);
            }
            await writeText(mcpFile, `${JSON.stringify({
                mcpServers: {
                    iranti: irantiMcpServer,
                },
            }, null, 2)}\n`);
            mcpStatus = 'updated';
        } else {
            const existingServers =
                existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
                    ? existing.mcpServers as Record<string, unknown>
                    : {};
            const hasIranti = Object.prototype.hasOwnProperty.call(existingServers, 'iranti');
            if (!hasIranti || force) {
                await writeText(mcpFile, `${JSON.stringify({
                    ...existing,
                    mcpServers: {
                        ...existingServers,
                        iranti: irantiMcpServer,
                    },
                }, null, 2)}\n`);
                mcpStatus = 'updated';
            }
        }
    }

    const claudeDir = path.join(projectPath, '.claude');
    await ensureDir(claudeDir);
    const settingsFile = path.join(claudeDir, 'settings.local.json');
    let settingsStatus: ClaudeScaffoldStatus = 'unchanged';
    if (!fs.existsSync(settingsFile)) {
        await writeText(settingsFile, `${JSON.stringify(makeClaudeHookSettings(projectEnvPath), null, 2)}\n`);
        settingsStatus = 'created';
    } else {
        const existingSettings = readJsonFile<Record<string, unknown>>(settingsFile);
        if (existingSettings && typeof existingSettings === 'object' && !Array.isArray(existingSettings)) {
            if (force || needsClaudeHookSettingsUpgrade(existingSettings)) {
                await writeText(settingsFile, `${JSON.stringify(makeClaudeHookSettings(projectEnvPath, existingSettings), null, 2)}\n`);
                settingsStatus = 'updated';
            }
        } else if (force) {
            await writeText(settingsFile, `${JSON.stringify(makeClaudeHookSettings(projectEnvPath), null, 2)}\n`);
            settingsStatus = 'updated';
        }
    }

    return {
        mcp: mcpStatus,
        settings: settingsStatus,
    };
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

function inspectDockerAvailability(): {
    installed: boolean;
    daemonReachable: boolean;
    detail: string;
} {
    if (!hasDockerInstalled()) {
        return {
            installed: false,
            daemonReachable: false,
            detail: 'Docker is not installed or not on PATH.',
        };
    }
    const proc = runCommandCapture('docker', ['info', '--format', '{{.ServerVersion}}']);
    if (proc.status === 0) {
        const version = proc.stdout.trim();
        return {
            installed: true,
            daemonReachable: true,
            detail: version
                ? `Docker daemon is reachable (server ${version}).`
                : 'Docker daemon is reachable.',
        };
    }
    const reason = (proc.stderr || proc.stdout).trim() || 'Docker daemon did not respond.';
    return {
        installed: true,
        daemonReachable: false,
        detail: `Docker CLI is installed, but the daemon is not reachable. ${reason}`,
    };
}

async function isPortAvailable(port: number, host: string = '0.0.0.0'): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const server = net.createServer();
        server.unref();
        server.on('error', () => resolve(false));
        server.listen(port, host, () => {
            server.close(() => resolve(true));
        });
    });
}

function listPublishedDockerHostPorts(): Set<number> {
    const docker = inspectDockerAvailability();
    if (!docker.daemonReachable) return new Set();

    const inspect = runCommandCapture('docker', ['ps', '--format', '{{.Ports}}']);
    if (inspect.status !== 0) return new Set();
    return parsePublishedDockerHostPorts(inspect.stdout ?? '');
}

async function isPortUsable(port: number, host: string = '0.0.0.0', dockerPublishedPorts: ReadonlySet<number> = new Set()): Promise<boolean> {
    if (dockerPublishedPorts.has(port)) return false;
    return isPortAvailable(port, host);
}

async function findNextAvailablePort(
    start: number,
    host: string = '0.0.0.0',
    maxSteps: number = 50,
    dockerPublishedPorts: ReadonlySet<number> = new Set(),
): Promise<number> {
    for (let port = start; port < start + maxSteps; port += 1) {
        if (await isPortUsable(port, host, dockerPublishedPorts)) {
            return port;
        }
    }
    throw new Error(`No available port found in range ${start}-${start + maxSteps - 1}.`);
}

async function readAllInstancePorts(root: string): Promise<Set<number>> {
    const ports = new Set<number>();
    const instancesDir = path.join(root, 'instances');
    if (!fs.existsSync(instancesDir)) return ports;
    try {
        const entries = await fsp.readdir(instancesDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const metaPath = path.join(instancesDir, entry.name, 'instance.json');
            try {
                const raw = await fsp.readFile(metaPath, 'utf-8');
                const meta = JSON.parse(raw) as { port?: unknown };
                const port = Number(meta.port);
                if (Number.isFinite(port) && port > 0) ports.add(port);
            } catch { /* ignore unreadable meta files */ }
        }
    } catch { /* ignore unreadable instances dir */ }
    return ports;
}

async function chooseAvailablePort(session: PromptSession, promptText: string, preferredPort: number, allowOccupiedCurrent: boolean = false, reservedPorts: ReadonlySet<number> = new Set()): Promise<number> {
    const dockerPublishedPorts = listPublishedDockerHostPorts();
    const allReserved = new Set([...dockerPublishedPorts, ...reservedPorts]);
    let suggested = preferredPort;
    if (!allowOccupiedCurrent && !(await isPortUsable(preferredPort, '0.0.0.0', allReserved))) {
        suggested = await findNextAvailablePort(preferredPort + 1, '0.0.0.0', 50, allReserved);
        console.log(`${warnLabel()} Port ${preferredPort} is already in use. A good next option is ${suggested}.`);
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
        if (await isPortUsable(parsed, '0.0.0.0', allReserved)) {
            return parsed;
        }
        const next = await findNextAvailablePort(parsed + 1, '0.0.0.0', 50, allReserved);
        console.log(`${warnLabel()} Port ${parsed} is already in use. Try ${next} instead.`);
        suggested = next;
    }
}

async function syncInstanceMeta(root: string, name: string, port: number): Promise<void> {
    const { instanceDir, envFile, metaFile } = instancePaths(root, name);
    const existingCreatedAt = fs.existsSync(metaFile)
        ? await fsp.readFile(metaFile, 'utf-8')
            .then((raw) => {
                try {
                    const parsed = JSON.parse(raw) as Partial<InstanceMeta>;
                    return typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined;
                } catch {
                    return undefined;
                }
            })
        : undefined;

    const meta: InstanceMeta = {
        name,
        createdAt: existingCreatedAt ?? new Date().toISOString(),
        port,
        envFile,
        instanceDir,
    };
    await writeJson(metaFile, meta);
}

async function assertPortAssignable(root: string, port: number, currentInstanceName?: string): Promise<void> {
    const reservedPorts = await readAllInstancePorts(root);
    let allowCurrentRunningPort = false;

    if (currentInstanceName) {
        const { envFile } = instancePaths(root, currentInstanceName);
        if (fs.existsSync(envFile)) {
            try {
                const env = await readEnvFile(envFile);
                const currentPort = Number.parseInt(env.IRANTI_PORT ?? '', 10);
                if (Number.isFinite(currentPort) && currentPort > 0) {
                    reservedPorts.delete(currentPort);
                    if (currentPort === port) {
                        const runtime = await readInstanceRuntimeSummary(root, currentInstanceName);
                        allowCurrentRunningPort = runtime.running && runtime.state?.port === port;
                    }
                }
            } catch {
                // Ignore unreadable current instance env and fall back to stricter validation.
            }
        }
    }

    if (reservedPorts.has(port)) {
        throw new Error(`Port ${port} is already assigned to another Iranti instance.`);
    }

    if (!allowCurrentRunningPort && !(await isPortUsable(port, '0.0.0.0', listPublishedDockerHostPorts()))) {
        throw new Error(`Port ${port} is already in use.`);
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
    const docker = inspectDockerAvailability();
    if (!docker.installed) {
        throw new Error('Docker CLI is not installed or not on PATH. Install Docker Desktop or Docker Engine before using --db-mode docker.');
    }
    if (!docker.daemonReachable) {
        throw new Error(`Docker daemon is not reachable. Start Docker Desktop or Docker Engine, then retry. ${docker.detail}`);
    }

    const inspect = runCommandCapture('docker', ['ps', '-a', '--format', '{{.Names}}']);
    if (inspect.status !== 0) {
        throw new Error(`Failed to inspect Docker containers. ${(inspect.stderr ?? inspect.stdout ?? '').trim() || 'docker ps returned a non-zero exit code.'}`);
    }
    const names = parseDockerContainerNames(inspect.stdout ?? '');

    if (names.includes(options.containerName)) {
        const start = process.platform === 'win32'
            ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', [ 'docker', 'start', options.containerName ].map(quoteForCmd).join(' ')], { stdio: 'inherit' })
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
    if (plan.mode === 'isolated' && plan.projects.length > 1) {
        throw new Error('Isolated setup supports one bound project. Use shared mode to bind multiple projects to the same instance.');
    }

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
            if (plan.databaseMode === 'docker' && !plan.databaseProvisioned) {
                const parsed = parsePostgresConnectionString(plan.databaseUrl);
                await runDockerPostgresContainer({
                    containerName: plan.dockerContainerName
                        ? sanitizeIdentifier(plan.dockerContainerName, `iranti_${plan.instanceName}_db`)
                        : sanitizeIdentifier(`iranti_${plan.instanceName}_db`, `iranti_${plan.instanceName}_db`),
                    hostPort: Number.parseInt(parsed.port || '5432', 10),
                    password: decodeURIComponent(parsed.password || 'postgres'),
                    database: postgresDatabaseName(plan.databaseUrl),
                });
            }
            if (plan.databaseMode === 'local') {
                await ensurePostgresDatabaseExists(plan.databaseUrl);
                await ensureLocalPostgresPgvectorAvailable(plan.databaseUrl);
            }
            await runBundledScript('setup', [], {
                DATABASE_URL: plan.databaseUrl,
                IRANTI_ESCALATION_DIR: path.join(configured.instanceDir, 'escalation'),
            });
        } catch (error) {
            if (plan.databaseMode === 'docker' && error instanceof Error && /Docker daemon is not reachable|Docker CLI is not installed/i.test(error.message)) {
                throw error;
            }
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
            IRANTI_PROJECT_MODE: project.projectMode,
            IRANTI_INSTANCE: plan.instanceName,
            IRANTI_INSTANCE_ENV: configured.envFile,
        });
        bindings.push({ projectPath, envFile: written, agentId: project.agentId, projectMode: project.projectMode });
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
        mode: plan.mode,
        databaseMode: plan.databaseMode,
        bindings,
    };
}

function parseSetupConfig(filePath: string): SetupExecutionPlan {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Setup config file not found: ${resolved}`);
    }
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as any;
    const mode: 'shared' | 'isolated' = raw?.mode === 'shared' ? 'shared' : 'isolated';
    const scope: Scope = raw?.scope === 'system' ? 'system' : 'user';
    const root = path.resolve(String(raw?.root ?? defaultInstallRoot(scope)));
    const instanceName = sanitizeIdentifier(String(raw?.instanceName ?? raw?.instance ?? 'local'), 'local');
    const port = Number.parseInt(String(raw?.port ?? 3001), 10);
    if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`Invalid setup config port: ${raw?.port}`);
    }
    const databaseModeRaw = String(raw?.databaseMode ?? raw?.dbMode ?? '').trim().toLowerCase();
    const databaseMode: DatabaseSetupMode = databaseModeRaw === 'docker'
        ? 'docker'
        : databaseModeRaw === 'managed'
            ? 'managed'
            : databaseModeRaw === 'existing' || databaseModeRaw === 'local' || databaseModeRaw.length === 0
                ? 'local'
                : (() => { throw new Error(`Unsupported databaseMode in setup config: ${databaseModeRaw}`); })();
    const databaseUrl = deriveDatabaseUrlForMode(databaseMode, instanceName, String(raw?.databaseUrl ?? raw?.dbUrl ?? '').trim());
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
        projectMode: normalizeProjectMode(String(item?.projectMode ?? mode), mode),
        claudeCode: item?.claudeCode !== false,
    }));

    return {
        mode,
        scope,
        root,
        instanceName,
        port,
        databaseUrl,
        databaseMode,
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
    const mode: 'shared' | 'isolated' = getFlag(args, 'mode') === 'shared' ? 'shared' : 'isolated';
    const instanceName = sanitizeIdentifier(getFlag(args, 'instance') ?? 'local', 'local');
    const port = Number.parseInt(getFlag(args, 'port') ?? '3001', 10);
    if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`Invalid --port '${getFlag(args, 'port')}'.`);
    }

    const databaseMode = (() => {
        const explicit = getFlag(args, 'db-mode')?.trim().toLowerCase();
        if (!explicit) {
            if (hasCommandInstalled('psql')) return 'local';
            if (inspectDockerAvailability().daemonReachable) return 'docker';
            return 'managed';
        }
        if (explicit === 'existing' || explicit === 'local') return 'local';
        if (explicit === 'managed' || explicit === 'docker') return explicit;
        throw new Error(`Invalid --db-mode '${explicit}'. Use local, managed, or docker.`);
    })();
    const databaseUrl = deriveDatabaseUrlForMode(databaseMode, instanceName, (getFlag(args, 'db-url') ?? process.env.DATABASE_URL ?? '').trim());

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
            projectMode: mode,
            claudeCode: hasFlag(args, 'claude-code'),
        }))
        : [];

    if (mode === 'isolated' && projects.length > 1) {
        throw new Error('--mode isolated supports one project. Use --mode shared to bind multiple projects.');
    }

    return {
        mode,
        scope,
        root,
        instanceName,
        port,
        databaseUrl,
        databaseMode,
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

function collectDoctorRemediations(
    checks: DoctorCheck[],
    envSource: string,
    envFile: string | null
): string[] {
    const hints: string[] = [];
    const add = (hint: string) => {
        if (!hints.includes(hint)) hints.push(hint);
    };

    for (const check of checks) {
        if (check.name === 'node version' && check.status === 'fail') {
            add('Upgrade Node.js to version 18 or newer, then rerun `iranti doctor`.');
        }
        if (check.name === 'cli build artifact' && check.status !== 'pass') {
            add('If this is a repo checkout, run `npm run build`. If this is an installed CLI, reinstall it with `npm install -g iranti@latest`.');
        }
        if (check.name === 'environment file' && check.status === 'fail') {
            if (envFile) {
                add(`Fix or recreate the target env file at ${envFile}, or rerun \`iranti setup\`.`);
            } else {
                add('Run `iranti setup`, or rerun `iranti doctor` with `--instance <name>` or `--env <file>`.');
            }
        }
        if ((check.name === 'database configuration' || check.name === 'bound instance database configuration') && check.status === 'fail') {
            if (check.name === 'bound instance database configuration') {
                add('Fix the linked instance env, or rerun `iranti setup` / `iranti configure instance` for the bound instance.');
            } else {
                add(`Set a real DATABASE_URL in ${envFile ?? 'the target env file'}, or rerun \`iranti setup\` to configure the database again.`);
            }
        }
        if (check.name === 'project binding url' && check.status === 'fail') {
            add('Run `iranti configure project` to refresh the project binding, or set IRANTI_URL in `.env.iranti`.');
        }
        if (check.name === 'project api key' && check.status === 'fail') {
            add('Run `iranti configure project` or set IRANTI_API_KEY in `.env.iranti`.');
        }
        if (check.name === 'bound instance env' && check.status !== 'pass') {
            add('Run `iranti configure project` to refresh the project binding, or set IRANTI_INSTANCE_ENV in `.env.iranti` so doctor can inspect the bound local instance.');
        }
        if (check.name === 'api key' && check.status !== 'pass') {
            add(envSource === 'project-binding'
                ? 'Set IRANTI_API_KEY in the project binding, or rerun `iranti configure project`.'
                : 'Create or rotate an Iranti key with `iranti auth create-key`, then store it in the target env.');
        }
        if ((check.name === 'provider credentials' || check.name === 'bound instance provider credentials') && check.status === 'fail') {
            add('Store or refresh the upstream provider key with `iranti add api-key` or `iranti update api-key`.');
        }
        if ((check.name === 'vector backend' || check.name === 'bound instance vector backend') && check.status === 'fail') {
            add('Check the vector backend env vars, or switch back to `IRANTI_VECTOR_BACKEND=pgvector` if the external backend is not ready.');
        }
    }

    if (checks.some((check) => check.status !== 'pass')) {
        add('Use `iranti upgrade --all --dry-run` to see whether this machine has stale CLI or Python installs.');
    }

    return hints;
}

function resolveDoctorEnvTarget(args: ParsedArgs): DoctorEnvTarget {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const instanceName = getFlag(args, 'instance');
    const explicitEnv = getFlag(args, 'env');
    const cwd = process.cwd();

    if (explicitEnv) {
        debugLog('Doctor target resolved from explicit env.', { envFile: path.resolve(explicitEnv) });
        return {
            envFile: path.resolve(explicitEnv),
            envSource: 'explicit-env',
        };
    }

    if (instanceName) {
        const root = resolveInstallRoot(args, scope);
        debugLog('Doctor target resolved from instance.', { instance: instanceName, root });
        return {
            envFile: path.join(root, 'instances', instanceName, '.env'),
            envSource: `instance:${instanceName}`,
        };
    }

    const repoEnv = path.join(cwd, '.env');
    const projectEnv = path.join(cwd, '.env.iranti');
    if (fs.existsSync(repoEnv)) {
        debugLog('Doctor target resolved from repo env.', { envFile: repoEnv });
        return { envFile: repoEnv, envSource: 'repo' };
    }
    if (fs.existsSync(projectEnv)) {
        debugLog('Doctor target resolved from project binding.', { envFile: projectEnv });
        return { envFile: projectEnv, envSource: 'project-binding' };
    }

    debugLog('Doctor target resolution found no env file.', { cwd });
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

function hasCommandInstalled(command: string): boolean {
    try {
        const proc = process.platform === 'win32'
            ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `${command} --version`], { stdio: 'ignore' })
            : spawnSync(command, ['--version'], { stdio: 'ignore' });
        return proc.status === 0;
    } catch {
        return false;
    }
}

async function canConnectTcp(port: number, host: string = '127.0.0.1', timeoutMs: number = 800): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const socket = net.createConnection({ port, host });
        let settled = false;
        const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeoutMs);
        socket.on('connect', () => finish(true));
        socket.on('timeout', () => finish(false));
        socket.on('error', () => finish(false));
    });
}

type DependencyCheck = {
    name: string;
    status: 'pass' | 'warn';
    detail: string;
};

async function collectDependencyChecks(): Promise<DependencyCheck[]> {
    const docker = inspectDockerAvailability();
    const psql = hasCommandInstalled('psql');
    const pgIsReady = hasCommandInstalled('pg_isready');
    const postgresPort = await canConnectTcp(5432);

    const checks: DependencyCheck[] = [
        {
            name: 'docker',
            status: docker.installed ? 'pass' : 'warn',
            detail: docker.installed ? 'Docker CLI is installed.' : docker.detail,
        },
        {
            name: 'docker daemon',
            status: docker.daemonReachable ? 'pass' : 'warn',
            detail: docker.detail,
        },
        {
            name: 'psql',
            status: psql ? 'pass' : 'warn',
            detail: psql ? 'psql is installed.' : 'psql is not installed or not on PATH.',
        },
        {
            name: 'pg_isready',
            status: pgIsReady ? 'pass' : 'warn',
            detail: pgIsReady ? 'pg_isready is installed.' : 'pg_isready is not installed or not on PATH.',
        },
        {
            name: 'localhost:5432',
            status: postgresPort ? 'pass' : 'warn',
            detail: postgresPort ? 'A PostgreSQL listener appears reachable on localhost:5432.' : 'Nothing is reachable on localhost:5432 right now.',
        },
    ];

    return checks;
}

function printDependencyChecks(checks: DependencyCheck[]): void {
    console.log(sectionTitle('Dependency Check'));
    for (const check of checks) {
        const marker = check.status === 'pass' ? okLabel('PASS') : warnLabel('WARN');
        console.log(`${marker} ${check.name} - ${check.detail}`);
    }
    if (checks.every((check) => check.status === 'warn')) {
        console.log(`${warnLabel()} No PostgreSQL tooling or reachable local Postgres was detected. You can still continue if you plan to use managed Postgres, but local setup will be rough until you install PostgreSQL tooling or Docker.`);
    }
}

function quoteForCmd(arg: string): string {
    if (arg.length === 0) return '""';
    // Escape % to prevent CMD variable expansion (%VAR%)
    const pctEscaped = arg.replace(/%/g, '%%');
    if (!/[ \t"&()<>|^%!]/.test(arg)) return pctEscaped;
    // Use "" for inner double quotes (CMD convention, not Unix \")
    return `"${pctEscaped.replace(/"/g, '""')}"`;
}

function runCommandCapture(
    executable: string,
    args: string[],
    cwd?: string,
    extraEnv?: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string } {
    verboseLog('Running subprocess (capture).', {
        executable,
        args: args.join(' '),
        cwd: cwd ?? process.cwd(),
    });
    const proc = process.platform === 'win32'
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', [
            '/d',
            '/c',
            [executable, ...args].map(quoteForCmd).join(' '),
        ], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ...extraEnv,
            },
        })
        : spawnSync(executable, args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ...extraEnv,
            },
        });
    const result = {
        status: proc.status,
        stdout: proc.stdout ?? '',
        stderr: proc.stderr ?? '',
    };
    verboseLog('Subprocess finished (capture).', {
        executable,
        status: result.status ?? -1,
        stderr: result.stderr.trim() || null,
    });
    return result;
}

function runCommandInteractive(step: UpgradeCommand): number | null {
    verboseLog('Running subprocess (interactive).', {
        label: step.label,
        command: step.display,
        cwd: step.cwd ?? process.cwd(),
    });
    const proc = process.platform === 'win32'
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', [
            '/d',
            '/c',
            [step.executable, ...step.args].map(quoteForCmd).join(' '),
        ], {
            cwd: step.cwd,
            stdio: 'inherit',
        })
        : spawnSync(step.executable, step.args, {
            cwd: step.cwd,
            stdio: 'inherit',
        });
    verboseLog('Subprocess finished (interactive).', {
        label: step.label,
        status: proc.status ?? -1,
    });
    return proc.status;
}

function currentCliInvocation(): { executable: string; args: string[] } {
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const forwardedDebug = CLI_DEBUG ? ['--debug'] : [];
    const forwardedVerbose = !CLI_DEBUG && CLI_VERBOSE ? ['--verbose'] : [];

    if (argv1.endsWith('.ts')) {
        return {
            executable: 'npx',
            args: ['ts-node', argv1, ...forwardedDebug, ...forwardedVerbose],
        };
    }

    return {
        executable: process.execPath,
        args: argv1 ? [argv1, ...forwardedDebug, ...forwardedVerbose] : [...forwardedDebug, ...forwardedVerbose],
    };
}

function spawnDetachedCli(args: string[], cwd?: string): number {
    const invocation = currentCliInvocation();
    const child = spawn(invocation.executable, [...invocation.args, ...args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: cwd ?? process.cwd(),
        env: process.env,
    });
    child.unref();
    const pid = child.pid;
    if (!pid) {
        throw new Error(`Failed to spawn detached CLI process (executable: ${invocation.executable}). The process did not start.`);
    }
    return pid;
}

async function restartInstanceRuntime(args: ParsedArgs, instanceName: string, scope: Scope, root: string): Promise<{
    previousPid: number | null;
    newPid: number;
    runtimeBefore: InstanceRuntimeSummary;
}> {
    const runtimeBefore = await readInstanceRuntimeSummary(root, instanceName);
    if (!runtimeBefore.running || !runtimeBefore.state?.pid) {
        throw cliError(
            'IRANTI_INSTANCE_NOT_RUNNING',
            `Instance '${instanceName}' is not currently running.`,
            [`Start it with \`iranti run --instance ${instanceName}\` before requesting a restart.`],
            { instance: instanceName, root, runtimePresent: Boolean(runtimeBefore.state), pid: runtimeBefore.state?.pid ?? null }
        );
    }
    const timeoutSeconds = Number.parseInt(getFlag(args, 'graceful-timeout') ?? '20', 10);
    const timeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 20_000;
    const previousPid = runtimeBefore.state?.pid ?? null;

    if (previousPid) {
        console.log(`${infoLabel()} Stopping instance '${instanceName}' (pid ${previousPid})...`);
        const stopped = await stopRuntimeProcess(previousPid, timeoutMs);
        if (!stopped) {
            throw cliError(
                'IRANTI_INSTANCE_STOP_TIMEOUT',
                `Instance '${instanceName}' did not stop within ${timeoutSeconds}s.`,
                ['Close the process manually or rerun with a longer --graceful-timeout.'],
                { instance: instanceName, pid: previousPid, timeoutSeconds }
            );
        }
    }

    const newPid = spawnDetachedCli([
        'run',
        '--instance',
        instanceName,
        '--scope',
        scope,
        '--root',
        root,
    ], root);

    return {
        previousPid,
        newPid,
        runtimeBefore,
    };
}

function deriveDatabaseUrlForMode(
    mode: DatabaseSetupMode,
    instanceName: string,
    explicitDatabaseUrl?: string,
): string {
    if (explicitDatabaseUrl && !detectPlaceholder(explicitDatabaseUrl)) {
        return explicitDatabaseUrl.trim();
    }
    if (mode === 'managed') {
        throw new Error('--db-url is required when --db-mode managed is selected.');
    }
    const user = encodeURIComponent((process.env.POSTGRES_USER ?? 'postgres').trim() || 'postgres');
    const password = encodeURIComponent((process.env.POSTGRES_PASSWORD ?? 'postgres').trim() || 'postgres');
    if (mode === 'local') {
        return `postgresql://${user}:${password}@localhost:5432/iranti_${instanceName}`;
    }
    return `postgresql://${user}:${password}@localhost:5432/iranti_${instanceName}`;
}

async function ensurePostgresDatabaseExists(databaseUrl: string): Promise<void> {
    const parsed = parsePostgresConnectionString(databaseUrl);
    if (!isLocalPostgresHost(parsed.hostname)) {
        return;
    }
    if (!hasCommandInstalled('psql')) {
        return;
    }

    const databaseName = postgresDatabaseName(databaseUrl);
    const adminDatabase = parsed.searchParams.get('admin_db')?.trim() || 'postgres';
    const host = parsed.hostname;
    const port = parsed.port || '5432';
    const user = decodeURIComponent(parsed.username || 'postgres');
    const password = decodeURIComponent(parsed.password || '');
    const extraEnv = password ? { PGPASSWORD: password } : undefined;
    const runPsql = (args: string[]) => spawnSync('psql', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            ...extraEnv,
        },
    });

    const lookup = runPsql([
        '-h',
        host,
        '-p',
        port,
        '-U',
        user,
        '-d',
        adminDatabase,
        '-tAc',
        `SELECT 1 FROM pg_database WHERE datname = ${quoteSqlLiteral(databaseName)};`,
    ]);

    if (lookup.status !== 0) {
        throw new Error(`Failed to inspect local PostgreSQL for database '${databaseName}'. ${lookup.stderr?.trim() || lookup.stdout?.trim() || 'psql returned a non-zero exit code.'}`);
    }

    if ((lookup.stdout ?? '').trim() === '1') {
        return;
    }

    const create = runPsql([
        '-h',
        host,
        '-p',
        port,
        '-U',
        user,
        '-d',
        adminDatabase,
        '-c',
        `CREATE DATABASE ${quoteSqlIdentifier(databaseName)};`,
    ]);

    if (create.status !== 0) {
        const combined = `${create.stderr ?? ''}\n${create.stdout ?? ''}`.toLowerCase();
        if (combined.includes('already exists')) {
            return;
        }
        throw new Error(`Failed to create local PostgreSQL database '${databaseName}'. ${create.stderr?.trim() || create.stdout?.trim() || 'psql returned a non-zero exit code.'}`);
    }
}

async function ensureLocalPostgresPgvectorAvailable(databaseUrl: string): Promise<void> {
    const parsed = parsePostgresConnectionString(databaseUrl);
    if (!isLocalPostgresHost(parsed.hostname)) {
        return;
    }
    if (!hasCommandInstalled('psql')) {
        return;
    }

    const adminDatabase = parsed.searchParams.get('admin_db')?.trim() || 'postgres';
    const host = parsed.hostname;
    const port = parsed.port || '5432';
    const user = decodeURIComponent(parsed.username || 'postgres');
    const password = decodeURIComponent(parsed.password || '');
    const extraEnv = password ? { PGPASSWORD: password } : undefined;
    const probe = spawnSync('psql', [
        '-h',
        host,
        '-p',
        port,
        '-U',
        user,
        '-d',
        adminDatabase,
        '-tAc',
        "SELECT 1 FROM pg_available_extensions WHERE name = 'vector';",
    ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            ...extraEnv,
        },
    });

    if (probe.status !== 0) {
        throw new Error(`Failed to inspect local PostgreSQL for pgvector availability. ${probe.stderr?.trim() || probe.stdout?.trim() || 'psql returned a non-zero exit code.'}`);
    }
    if ((probe.stdout ?? '').trim() !== '1') {
        throw new Error('Local PostgreSQL server does not have the pgvector extension installed.');
    }
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

function detectGlobalNpmInstalledVersion(): string | null {
    const proc = runCommandCapture('npm', ['list', '-g', 'iranti', '--depth=0', '--json']);
    if (proc.status !== 0) return null;
    try {
        const payload = JSON.parse(proc.stdout);
        return typeof payload?.dependencies?.iranti?.version === 'string'
            ? payload.dependencies.iranti.version
            : null;
    } catch {
        return null;
    }
}

function detectPythonInstalledVersion(command: UpgradeCommand | null): string | null {
    if (!command) return null;
    const args = command.executable === 'py' ? ['-3', '-m', 'pip', 'show', 'iranti'] : ['-m', 'pip', 'show', 'iranti'];
    const proc = runCommandCapture(command.executable, args);
    if (proc.status !== 0) return null;
    const versionLine = proc.stdout.split(/\r?\n/).find((line) => line.toLowerCase().startsWith('version:'));
    if (!versionLine) return null;
    return versionLine.split(':').slice(1).join(':').trim() || null;
}

function readJsonFile<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

function httpsJson(url: string, headers: Record<string, string> = {}, _redirectDepth: number = 0): Promise<any> {
    const MAX_REDIRECTS = 5;
    const REQUEST_TIMEOUT_MS = 10_000;
    return new Promise((resolve, reject) => {
        const request = https.get(url, { headers }, (response) => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
                response.resume();
                if (_redirectDepth >= MAX_REDIRECTS) {
                    reject(new Error(`Too many redirects fetching ${url}`));
                    return;
                }
                const redirect = new URL(response.headers.location, url).toString();
                httpsJson(redirect, headers, _redirectDepth + 1).then(resolve).catch(reject);
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
        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
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
    repoDirty: boolean;
    globalNpmInstall: boolean;
    globalNpmRoot: string | null;
    globalNpmVersion: string | null;
    runningFromGlobalNpmInstall: boolean;
    python: UpgradeCommand | null;
    pythonVersion: string | null;
    availableTargets: Exclude<UpgradeTarget, 'auto'>[];
} {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const packageRootPath = packageRoot();
    const runtimeRoot = resolveInstallRoot(args, scope);
    const runtimeInstalled = fs.existsSync(path.join(runtimeRoot, 'install.json'));
    const repoCheckout = fs.existsSync(path.join(packageRootPath, '.git'));
    const repoDirty = repoCheckout ? repoIsDirty(packageRootPath) : false;
    const globalNpmRoot = detectGlobalNpmRoot();
    const globalNpmVersion = detectGlobalNpmInstalledVersion();
    const globalNpmInstall = globalNpmVersion !== null;
    const runningFromGlobalNpmInstall = Boolean(globalNpmRoot && isPathInside(globalNpmRoot, packageRootPath));
    const python = detectPythonLauncher();
    const pythonVersion = detectPythonInstalledVersion(python);
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
        repoDirty,
        globalNpmInstall,
        globalNpmRoot,
        globalNpmVersion,
        runningFromGlobalNpmInstall,
        python,
        pythonVersion,
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

function resolveRequestedUpgradeTargets(
    raw: string | undefined,
    all: boolean
): UpgradeTarget[] {
    if (all) {
        return ['npm-global', 'npm-repo', 'python'];
    }
    if (!raw) {
        return ['auto'];
    }
    return raw
        .split(',')
        .map((value) => resolveUpgradeTarget(value))
        .filter((value, index, array) => array.indexOf(value) === index);
}

function buildUpgradeTargetStatuses(
    context: ReturnType<typeof detectUpgradeContext>,
    latestNpm: string | null,
    latestPython: string | null
): UpgradeTargetStatus[] {
    return [
        {
            target: 'npm-global',
            available: context.globalNpmInstall,
            currentVersion: context.globalNpmVersion,
            latestVersion: latestNpm,
            upToDate: context.globalNpmVersion && latestNpm ? compareVersions(context.globalNpmVersion, latestNpm) >= 0 : null,
            blockedReason: context.globalNpmInstall ? undefined : 'No global npm install detected on PATH.',
        },
        {
            target: 'npm-repo',
            available: context.repoCheckout,
            currentVersion: context.currentVersion,
            latestVersion: latestNpm,
            upToDate: null,
            blockedReason: !context.repoCheckout
                ? 'Current package root is not a git checkout.'
                : context.repoDirty
                    ? 'Repository worktree is dirty.'
                    : undefined,
        },
        {
            target: 'python',
            available: context.python !== null,
            currentVersion: context.pythonVersion,
            latestVersion: latestPython,
            upToDate: context.pythonVersion && latestPython ? compareVersions(context.pythonVersion, latestPython) >= 0 : null,
            blockedReason: context.python ? undefined : 'Python launcher not found.',
        },
    ];
}

function describeUpgradeTarget(target: UpgradeTargetStatus): string {
    const current = target.currentVersion ?? 'not installed';
    const latest = target.latestVersion ?? 'unknown';
    if (target.target === 'npm-repo') {
        return target.blockedReason
            ? `repo checkout (${current}) - ${target.blockedReason}`
            : `repo checkout (${current}) - refresh local checkout and rebuild`;
    }
    if (target.upToDate === true) {
        return `${target.target} (${current}) - already at latest ${latest}`;
    }
    if (target.blockedReason) {
        return `${target.target} (${current}) - ${target.blockedReason}`;
    }
    return `${target.target} (${current}) - latest ${latest}`;
}

async function chooseInteractiveUpgradeTargets(
    statuses: UpgradeTargetStatus[]
): Promise<Exclude<UpgradeTarget, 'auto'>[]> {
    const selected: Exclude<UpgradeTarget, 'auto'>[] = [];
    await withPromptSession(async (prompt) => {
        for (const status of statuses) {
            if (!status.available) {
                console.log(`${warnLabel()} ${describeUpgradeTarget(status)}`);
                continue;
            }
            if (status.target === 'npm-repo' && status.blockedReason) {
                console.log(`${warnLabel()} ${describeUpgradeTarget(status)}`);
                continue;
            }
            const defaultChoice = status.target === 'npm-repo'
                ? false
                : status.upToDate === false;
            const question = status.target === 'npm-global'
                ? `Upgrade global npm install now? (${describeUpgradeTarget(status)})`
                : status.target === 'python'
                    ? `Upgrade Python client now? (${describeUpgradeTarget(status)})`
                    : `Refresh local repo checkout now? (${describeUpgradeTarget(status)})`;
            if (await promptYesNo(prompt, question, defaultChoice)) {
                selected.push(status.target);
            }
        }
    });
    return selected;
}

async function executeUpgradeTargets(
    targets: Exclude<UpgradeTarget, 'auto'>[],
    context: ReturnType<typeof detectUpgradeContext>,
    options: { detachedPostCommand?: string } = {},
): Promise<UpgradeExecutionResult[]> {
    const results: UpgradeExecutionResult[] = [];
    for (const target of targets) {
        const result = await executeUpgradeTarget(target, context, options);
        results.push(result);
    }
    return results;
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

function canScheduleWindowsGlobalNpmSelfUpgrade(context: ReturnType<typeof detectUpgradeContext>): boolean {
    return process.platform === 'win32' && context.runningFromGlobalNpmInstall;
}

function escapeForSingleQuotedPowerShell(value: string): string {
    return value.replace(/'/g, "''");
}

function resolveWindowsDetachedExecutable(executable: string): string {
    // H-5: Validate executable name — reject empty strings or strings with shell metacharacters
    if (!executable || /[;&|<>\n\r`$(){}[\]\\/"']/.test(executable)) {
        throw new Error(`Invalid executable name: "${executable}"`);
    }
    if (path.isAbsolute(executable)) {
        return executable;
    }
    const candidates = executable.toLowerCase().endsWith('.cmd') || executable.toLowerCase().endsWith('.exe')
        ? [executable]
        : [`${executable}.cmd`, `${executable}.exe`, executable];
    for (const candidate of candidates) {
        const probe = spawnSync('where', [candidate], { encoding: 'utf8' });
        if (probe.status === 0) {
            const resolved = (probe.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
            if (resolved) {
                if (!path.extname(resolved)) {
                    const cmdVariant = `${resolved}.cmd`;
                    const exeVariant = `${resolved}.exe`;
                    if (fs.existsSync(cmdVariant)) return cmdVariant;
                    if (fs.existsSync(exeVariant)) return exeVariant;
                }
                return resolved;
            }
        }
    }
    return executable;
}

function resolveDetachedUpgradeCwd(command: UpgradeCommand): string {
    const desired = command.cwd?.trim();
    if (!desired) {
        return os.homedir();
    }
    const normalized = path.resolve(desired);
    const lower = normalized.toLowerCase();
    const globalNpmRoot = detectGlobalNpmRoot()?.toLowerCase();
    if (globalNpmRoot && (lower === globalNpmRoot || lower.startsWith(`${globalNpmRoot}${path.sep}`))) {
        return os.homedir();
    }
    return normalized;
}

function launchDetachedWindowsPowerShellFile(scriptPath: string, cwd: string): void {
    const command = [
        'Start-Process',
        '-WindowStyle Hidden',
        `-WorkingDirectory '${escapeForSingleQuotedPowerShell(cwd)}'`,
        "-FilePath 'powershell.exe'",
        `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${escapeForSingleQuotedPowerShell(scriptPath)}')`,
    ].join(' ');
    const proc = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        encoding: 'utf8',
        cwd,
        env: process.env,
        windowsHide: true,
    });
    if (proc.status !== 0) {
        throw new Error(`Failed to schedule detached PowerShell handoff. ${(proc.stderr || proc.stdout).trim() || 'powershell returned a non-zero exit code.'}`);
    }
}

// C-5: postCommand must be a pre-escaped PowerShell snippet produced internally (never from raw user input).
// Validate it against a strict allowlist pattern to prevent future injection if the call site changes.
function validateDetachedPostCommand(postCommand: string): void {
    // Allow only: alphanumeric, spaces, single-quotes, hyphens, underscores, dots, slashes,
    // backslashes, colons, and & for PS call operator.
    if (!/^[a-zA-Z0-9 '&_\-./:\\]+$/.test(postCommand)) {
        throw new Error(`Unsafe characters in detached post-command. Only pre-escaped PowerShell call expressions are permitted.`);
    }
}

function scheduleDetachedWindowsGlobalNpmUpgrade(command: UpgradeCommand, postCommand?: string): void {
    if (postCommand !== undefined) {
        validateDetachedPostCommand(postCommand);
    }
    const neutralCwd = resolveDetachedUpgradeCwd(command);
    const parentPid = process.pid;
    const escapedCwd = escapeForSingleQuotedPowerShell(neutralCwd);
    const detachedExecutable = resolveWindowsDetachedExecutable(command.executable);
    const escapedExecutable = escapeForSingleQuotedPowerShell(detachedExecutable);
    const escapedArgs = command.args.map((arg) => `'${escapeForSingleQuotedPowerShell(arg)}'`).join(', ');
    const script = [
        `$parentPid = ${parentPid}`,
        'while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }',
        `Set-Location -LiteralPath '${escapedCwd}'`,
        `& '${escapedExecutable}' @(${escapedArgs})`,
        ...(postCommand ? [`if ($LASTEXITCODE -eq 0) { ${postCommand} }`] : []),
        'exit $LASTEXITCODE',
    ].join(';\r\n');
    const scriptPath = writeDetachedWindowsScript('iranti-upgrade', `${script};\r\n`);
    launchDetachedWindowsPowerShellFile(scriptPath, neutralCwd);
}

function verifyPythonInstall(command: UpgradeCommand): { status: 'pass' | 'warn' | 'fail'; detail: string } {
    const version = detectPythonInstalledVersion(command);
    return version
        ? { status: 'pass', detail: `Python client Version: ${version}.` }
        : { status: 'warn', detail: 'Python upgrade finished, but installed version could not be confirmed.' };
}

async function executeUpgradeTarget(
    target: Exclude<UpgradeTarget, 'auto'>,
    context: ReturnType<typeof detectUpgradeContext>,
    options: { detachedPostCommand?: string } = {},
): Promise<UpgradeExecutionResult> {
    if (target === 'npm-repo' && repoIsDirty(context.packageRootPath)) {
        throw new Error('Repository worktree is dirty. Commit or stash changes before running `iranti upgrade --target npm-repo --yes`.');
    }

    const commands = commandListForTarget(target, context);
    const steps: Array<{ label: string; command: string }> = [];
    if (target === 'npm-global' && canScheduleWindowsGlobalNpmSelfUpgrade(context)) {
        const command = commands[0]!;
        console.log(`${infoLabel()} ${command.display} (scheduled in a detached updater because the current Windows CLI cannot replace its own live global install)`);
        scheduleDetachedWindowsGlobalNpmUpgrade(command, options.detachedPostCommand);
        steps.push({ label: `${command.label} (detached)`, command: command.display });
        return {
            target,
            steps,
            verification: {
                status: 'warn',
                detail: 'Scheduled detached npm global upgrade. Wait a few seconds, then open a new shell or rerun `iranti upgrade --check` to confirm the new global CLI is active.',
            },
        };
    }

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

function resolveUninstallScanRoots(args: ParsedArgs): string[] {
    const explicit = getFlag(args, 'scan-root');
    const candidates = explicit
        ? explicit.split(',').map((value) => path.resolve(value.trim())).filter(Boolean)
        : [
            process.cwd(),
            path.join(os.homedir(), 'Documents', 'Projects'),
        ].filter((value, index, array) => array.indexOf(value) === index);
    return candidates.filter((candidate, index, array) =>
        candidate.length > 0
        && fs.existsSync(candidate)
        && array.indexOf(candidate) === index
    );
}

function runtimeRootFromInstanceEnv(envFile: string): string | null {
    const normalized = path.resolve(envFile);
    const parts = normalized.split(path.sep);
    const instancesIndex = parts.lastIndexOf('instances');
    if (instancesIndex <= 0) return null;
    return parts.slice(0, instancesIndex).join(path.sep);
}

async function discoverRuntimeRoots(root: string, projectArtifacts: UninstallProjectArtifact[], scanRoots: string[]): Promise<UninstallRuntimeRoot[]> {
    const discovered = new Map<string, UninstallRuntimeRoot>();
    const add = (candidate: string | null | undefined, source: UninstallRuntimeRoot['source']) => {
        if (!candidate) return;
        const resolved = path.resolve(candidate);
        if (!fs.existsSync(resolved)) return;
        if (!discovered.has(resolved)) {
            discovered.set(resolved, { path: resolved, source });
        }
    };

    add(root, 'active-root');

    for (const artifact of projectArtifacts) {
        if (!artifact.bindingFile || !fs.existsSync(artifact.bindingFile)) continue;
        try {
            const binding = await readEnvFile(artifact.bindingFile);
            add(runtimeRootFromInstanceEnv(binding.IRANTI_INSTANCE_ENV ?? ''), 'binding');
        } catch {
            continue;
        }
    }

    for (const scanRoot of scanRoots) {
        const queue: string[] = [scanRoot];
        while (queue.length > 0) {
            const current = queue.shift()!;
            let entries: fs.Dirent[] = [];
            try {
                entries = await fsp.readdir(current, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (shouldSkipUninstallScanDir(entry.name)) continue;
                const candidate = path.join(current, entry.name);
                if ((entry.name === '.iranti' || entry.name === '.iranti-runtime')
                    && (fs.existsSync(path.join(candidate, 'install.json')) || fs.existsSync(path.join(candidate, 'instances')))) {
                    add(candidate, 'scan');
                    continue;
                }
                queue.push(candidate);
            }
        }
    }

    return Array.from(discovered.values()).sort((a, b) => a.path.localeCompare(b.path));
}

async function collectUninstallProcesses(runtimeRoots: UninstallRuntimeRoot[], context: ReturnType<typeof detectUpgradeContext>): Promise<UninstallProcessCandidate[]> {
    const processes = new Map<number, UninstallProcessCandidate>();
    for (const runtimeRoot of runtimeRoots) {
        const instances = await collectRuntimeInstanceSummaries(runtimeRoot.path);
        for (const instance of instances) {
            const pid = instance.runtime.state?.pid;
            if (!instance.runtime.running || !pid || pid === process.pid) continue;
            processes.set(pid, {
                pid,
                source: 'runtime',
                label: `instance:${instance.name}`,
                command: instance.runtime.state?.healthUrl,
            });
        }
    }

    const probe = process.platform === 'win32'
        ? runCommandCapture('powershell', [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress',
        ])
        : runCommandCapture('ps', ['-ax', '-o', 'pid=', '-o', 'command=']);

    if (probe.status === 0) {
        if (process.platform === 'win32') {
            try {
                const payload = JSON.parse(probe.stdout) as Array<{ ProcessId?: number; CommandLine?: string }> | { ProcessId?: number; CommandLine?: string };
                const rows = Array.isArray(payload) ? payload : [payload];
                const needles = [
                    context.packageRootPath.toLowerCase(),
                    context.globalNpmRoot?.toLowerCase(),
                    'iranti mcp',
                    'iranti run',
                    'iranti-cli',
                    'iranti-mcp',
                    'claude-code-memory-hook',
                ].filter((value): value is string => Boolean(value));
                for (const row of rows) {
                    const pid = row.ProcessId;
                    const command = row.CommandLine ?? '';
                    if (!pid || pid === process.pid || !command) continue;
                    const lower = command.toLowerCase();
                    if (!needles.some((needle) => lower.includes(needle))) continue;
                    processes.set(pid, {
                        pid,
                        source: 'process-scan',
                        label: 'iranti-process',
                        command,
                    });
                }
            } catch {
                // best effort only
            }
        } else {
            const needles = [
                context.packageRootPath.toLowerCase(),
                context.globalNpmRoot?.toLowerCase(),
                'iranti mcp',
                'iranti run',
                'iranti-cli',
                'iranti-mcp',
                'claude-code-memory-hook',
            ].filter((value): value is string => Boolean(value));
            for (const line of probe.stdout.split(/\r?\n/)) {
                const match = line.trim().match(/^(\d+)\s+(.*)$/);
                if (!match) continue;
                const pid = Number.parseInt(match[1] ?? '', 10);
                const command = match[2] ?? '';
                if (!pid || pid === process.pid) continue;
                const lower = command.toLowerCase();
                if (!needles.some((needle) => lower.includes(needle))) continue;
                processes.set(pid, {
                    pid,
                    source: 'process-scan',
                    label: 'iranti-process',
                    command,
                });
            }
        }
    }

    return Array.from(processes.values()).sort((a, b) => a.pid - b.pid);
}

function detectCodexRegistration(name: string = 'iranti'): boolean {
    if (!hasCodexInstalled()) return false;
    const proc = runCommandCapture('codex', ['mcp', 'get', name, '--json']);
    return proc.status === 0;
}

function removeIrantiMcpServerFromValue(value: Record<string, unknown>): Record<string, unknown> | null {
    const mcpServers = value.mcpServers;
    if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) return value;
    const nextServers = { ...(mcpServers as Record<string, unknown>) };
    delete nextServers.iranti;
    if (Object.keys(nextServers).length === 0) {
        const next = { ...value };
        delete next.mcpServers;
        return Object.keys(next).length === 0 ? null : next;
    }
    return {
        ...value,
        mcpServers: nextServers,
    };
}

function removeIrantiClaudeHooksFromValue(value: Record<string, unknown>): Record<string, unknown> | null {
    const hooks = isClaudeHooksObject(value.hooks) ? value.hooks : null;
    if (!hooks) return value;

    const nextHooks: Record<string, unknown> = { ...hooks };
    for (const event of ['SessionStart', 'UserPromptSubmit'] as const) {
        const entries = hooks[event];
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
            if (isLegacyIrantiClaudeHookEntry(entry)) return false;
            const structured = entry as Record<string, unknown>;
            const nestedHooks = Array.isArray(structured.hooks) ? structured.hooks : [];
            const remainingNested = nestedHooks.filter((hook) => {
                if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return true;
                const command = typeof (hook as Record<string, unknown>).command === 'string'
                    ? String((hook as Record<string, unknown>).command)
                    : '';
                return !command.includes('iranti claude-hook');
            });
            if (remainingNested.length !== nestedHooks.length) {
                if (remainingNested.length === 0) {
                    return false;
                }
                structured.hooks = remainingNested;
            }
            return true;
        });
        if (filtered.length === 0) {
            delete nextHooks[event];
        } else {
            nextHooks[event] = filtered;
        }
    }

    const next = { ...value };
    if (Object.keys(nextHooks).length === 0) {
        delete next.hooks;
    } else {
        next.hooks = nextHooks;
    }
    return Object.keys(next).length === 0 ? null : next;
}

async function cleanupProjectArtifacts(artifacts: UninstallProjectArtifact[]): Promise<UninstallExecutionResult[]> {
    const results: UninstallExecutionResult[] = [];
    for (const artifact of artifacts) {
        if (artifact.bindingFile && fs.existsSync(artifact.bindingFile)) {
            await fsp.rm(artifact.bindingFile, { force: true });
            results.push({
                label: 'project-binding',
                status: 'pass',
                detail: `Removed ${artifact.bindingFile}`,
            });
        }

        if (artifact.mcpFile && fs.existsSync(artifact.mcpFile)) {
            const parsed = readJsonFile<Record<string, unknown>>(artifact.mcpFile);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const next = removeIrantiMcpServerFromValue(parsed);
                if (!next) {
                    await fsp.rm(artifact.mcpFile, { force: true });
                    results.push({
                        label: 'project-mcp',
                        status: 'pass',
                        detail: `Removed ${artifact.mcpFile}`,
                    });
                } else {
                    await writeText(artifact.mcpFile, `${JSON.stringify(next, null, 2)}\n`);
                    results.push({
                        label: 'project-mcp',
                        status: 'pass',
                        detail: `Removed Iranti MCP entry from ${artifact.mcpFile}`,
                    });
                }
            } else {
                results.push({
                    label: 'project-mcp',
                    status: 'warn',
                    detail: `Skipped unreadable JSON file ${artifact.mcpFile}`,
                });
            }
        }

        if (artifact.claudeSettingsFile && fs.existsSync(artifact.claudeSettingsFile)) {
            const parsed = readJsonFile<Record<string, unknown>>(artifact.claudeSettingsFile);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const next = removeIrantiClaudeHooksFromValue(parsed);
                if (!next) {
                    await fsp.rm(artifact.claudeSettingsFile, { force: true });
                    results.push({
                        label: 'project-claude',
                        status: 'pass',
                        detail: `Removed ${artifact.claudeSettingsFile}`,
                    });
                } else {
                    await writeText(artifact.claudeSettingsFile, `${JSON.stringify(next, null, 2)}\n`);
                    results.push({
                        label: 'project-claude',
                        status: 'pass',
                        detail: `Removed Iranti Claude hooks from ${artifact.claudeSettingsFile}`,
                    });
                }
            } else {
                results.push({
                    label: 'project-claude',
                    status: 'warn',
                    detail: `Skipped unreadable JSON file ${artifact.claudeSettingsFile}`,
                });
            }
        }
    }
    return results;
}

async function runUninstallCommand(step: UpgradeCommand): Promise<UninstallExecutionResult> {
    const proc = runCommandCapture(step.executable, step.args, step.cwd);
    if (proc.status === 0) {
        return {
            label: step.label,
            status: 'pass',
            detail: `${step.display} completed successfully.`,
        };
    }
    return {
        label: step.label,
        status: 'warn',
        detail: `${step.display} exited with status ${proc.status ?? -1}: ${(proc.stderr || proc.stdout).trim() || 'unknown error'}`,
    };
}

async function stopUninstallProcesses(processes: UninstallProcessCandidate[]): Promise<UninstallExecutionResult[]> {
    const results: UninstallExecutionResult[] = [];
    for (const candidate of processes) {
        const stopped = await stopRuntimeProcess(candidate.pid, 5000);
        results.push({
            label: 'stop-process',
            status: stopped ? 'pass' : 'warn',
            detail: `${stopped ? 'Stopped' : 'Could not stop'} pid=${candidate.pid} (${candidate.label})`,
        });
    }
    return results;
}

function buildDetachedWindowsUninstallScript(options: {
    parentPid: number;
    stopPids: number[];
    removeCodex: boolean;
    python?: UpgradeCommand | null;
    removeGlobalNpm: boolean;
    npmExecutable?: string;
    codexExecutable?: string;
    runtimeRoots: string[];
    artifactFiles: string[];
}): string {
    const lines = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `$parentPid = ${options.parentPid}`,
        'while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }',
    ];

    for (const pid of options.stopPids) {
        lines.push(`taskkill /PID ${pid} /T /F > $null 2>&1`);
    }
    if (options.removeCodex) {
        const codexExecutable = escapeForSingleQuotedPowerShell(options.codexExecutable ?? resolveWindowsDetachedExecutable('codex'));
        lines.push(`$codexExe = '${codexExecutable}'`);
        lines.push("if (Test-Path -LiteralPath $codexExe) { & $codexExe mcp get iranti --json > $null 2>&1; if ($LASTEXITCODE -eq 0) { & $codexExe mcp remove iranti > $null 2>&1 } }");
    }
    if (options.removeGlobalNpm) {
        const npmExecutable = escapeForSingleQuotedPowerShell(options.npmExecutable ?? resolveWindowsDetachedExecutable('npm'));
        lines.push(`$npmExe = '${npmExecutable}'`);
        lines.push("if (Test-Path -LiteralPath $npmExe) { & $npmExe uninstall -g iranti > $null 2>&1 }");
    }
    if (options.python) {
        const args = options.python.args.map((arg) => `'${escapeForSingleQuotedPowerShell(arg)}'`).join(', ');
        const pythonExecutable = escapeForSingleQuotedPowerShell(resolveWindowsDetachedExecutable(options.python.executable));
        lines.push(`$pythonExe = '${pythonExecutable}'`);
        lines.push(`if (Test-Path -LiteralPath $pythonExe) { & $pythonExe @(${args}) > $null 2>&1 }`);
    }
    for (const filePath of options.artifactFiles) {
        lines.push(`if (Test-Path -LiteralPath '${escapeForSingleQuotedPowerShell(filePath)}') { Remove-Item -LiteralPath '${escapeForSingleQuotedPowerShell(filePath)}' -Force }`);
    }
    for (const dirPath of options.runtimeRoots) {
        lines.push(`if (Test-Path -LiteralPath '${escapeForSingleQuotedPowerShell(dirPath)}') { Remove-Item -LiteralPath '${escapeForSingleQuotedPowerShell(dirPath)}' -Recurse -Force }`);
    }
    lines.push('exit 0');
    return `${lines.join(';\r\n')};\r\n`;
}

function writeDetachedWindowsScript(prefix: string, scriptContents: string): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    const scriptPath = path.join(tempDir, `${prefix}.ps1`);
    fs.writeFileSync(scriptPath, scriptContents, 'utf8');
    return scriptPath;
}

async function uninstallCommand(args: ParsedArgs): Promise<void> {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const json = hasFlag(args, 'json');
    const dryRun = hasFlag(args, 'dry-run');
    const executeFlag = hasFlag(args, 'yes');
    const removeAll = hasFlag(args, 'all');
    const keepData = hasFlag(args, 'keep-data');
    const keepProjectBindings = hasFlag(args, 'keep-project-bindings');
    const scanRoots = resolveUninstallScanRoots(args);
    const context = detectUpgradeContext(args);
    const projectArtifacts = removeAll && !keepProjectBindings
        ? await discoverProjectArtifacts(scanRoots)
        : [];
    const runtimeRoots = await discoverRuntimeRoots(root, projectArtifacts, scanRoots);
    const processes = await collectUninstallProcesses(runtimeRoots, context);
    const codexRegistration = removeAll && !keepProjectBindings && detectCodexRegistration('iranti');
    const pythonCommand = context.python
        ? {
            ...context.python,
            label: 'python uninstall',
            display: `${context.python.executable}${context.python.args[0] === '-3' ? ' -3' : ''} -m pip uninstall -y iranti`,
            args: (context.python.args[0] === '-3' ? ['-3', '-m', 'pip'] : ['-m', 'pip']).concat(['uninstall', '-y', 'iranti']),
        }
        : null;
    const actions = {
        stopProcesses: processes.length > 0,
        removeGlobalNpm: context.globalNpmInstall,
        removePython: context.pythonVersion !== null && pythonCommand !== null,
        removeRuntimeRoots: removeAll && !keepData && runtimeRoots.length > 0,
        removeProjectBindings: removeAll && !keepProjectBindings && projectArtifacts.length > 0,
        removeCodexRegistration: codexRegistration,
    };

    let execute = executeFlag;
    let note: string | null = null;
    if (!execute && !dryRun && !json && process.stdin.isTTY && process.stdout.isTTY) {
        await withPromptSession(async (prompt) => {
            execute = await promptYesNo(prompt, 'Proceed with uninstall using the plan below?', false);
        });
        if (!execute) {
            note = 'Uninstall cancelled.';
        }
    } else if (!execute && !dryRun) {
        note = 'Run with --yes to execute the uninstall, or use --dry-run to inspect the plan safely.';
    }

    const plannedSteps: string[] = [];
    if (actions.stopProcesses) plannedSteps.push(`Stop ${processes.length} live Iranti process(es)`);
    if (actions.removeGlobalNpm) plannedSteps.push('Remove global npm install');
    if (actions.removePython) plannedSteps.push('Remove Python client');
    if (actions.removeCodexRegistration) plannedSteps.push('Remove Codex MCP registration');
    if (actions.removeProjectBindings) plannedSteps.push(`Clean ${projectArtifacts.length} project binding/integration surface(s)`);
    if (actions.removeRuntimeRoots) plannedSteps.push(`Delete ${runtimeRoots.length} runtime root(s)`);

    const actionLabel = execute ? 'uninstall' : dryRun ? 'dry-run' : 'inspect';
    const execution: UninstallExecutionResult[] = [];

    const requiresDetachedWindowsSelfUninstall = process.platform === 'win32'
        && actions.removeGlobalNpm
        && context.runningFromGlobalNpmInstall
        && execute
        && !dryRun;

    if (execute && !dryRun) {
        if (requiresDetachedWindowsSelfUninstall) {
            const artifactFiles = projectArtifacts.flatMap((artifact) =>
                [artifact.bindingFile, artifact.mcpFile, artifact.claudeSettingsFile]
                    .filter((value): value is string => Boolean(value))
            );
            const script = buildDetachedWindowsUninstallScript({
                parentPid: process.pid,
                stopPids: processes.map((candidate) => candidate.pid),
                removeCodex: actions.removeCodexRegistration,
                python: actions.removePython ? pythonCommand : null,
                removeGlobalNpm: actions.removeGlobalNpm,
                npmExecutable: resolveWindowsDetachedExecutable('npm'),
                codexExecutable: resolveWindowsDetachedExecutable('codex'),
                runtimeRoots: actions.removeRuntimeRoots ? runtimeRoots.map((entry) => entry.path) : [],
                artifactFiles,
            });
            const scriptPath = writeDetachedWindowsScript('iranti-uninstall', script);
            launchDetachedWindowsPowerShellFile(scriptPath, os.homedir());
            execution.push({
                label: 'detached-uninstall',
                status: 'warn',
                detail: 'Scheduled detached uninstall because the current Windows CLI cannot remove its own live global npm install in place.',
            });
            note = 'Wait a few seconds, then open a new shell and verify `iranti` is gone from PATH.';
        } else {
            if (actions.stopProcesses) {
                execution.push(...await stopUninstallProcesses(processes));
            }
            if (actions.removeCodexRegistration) {
                const proc = runCommandCapture('codex', ['mcp', 'remove', 'iranti']);
                execution.push({
                    label: 'codex-mcp',
                    status: proc.status === 0 ? 'pass' : 'warn',
                    detail: proc.status === 0
                        ? 'Removed Codex MCP registration.'
                        : `Could not remove Codex MCP registration: ${(proc.stderr || proc.stdout).trim() || 'unknown error'}`,
                });
            }
            if (actions.removeGlobalNpm) {
                execution.push(await runUninstallCommand({
                    label: 'npm uninstall',
                    display: 'npm uninstall -g iranti',
                    executable: 'npm',
                    args: ['uninstall', '-g', 'iranti'],
                    cwd: context.packageRootPath,
                }));
            }
            if (actions.removePython && pythonCommand) {
                execution.push(await runUninstallCommand(pythonCommand));
            }
            if (actions.removeProjectBindings) {
                execution.push(...await cleanupProjectArtifacts(projectArtifacts));
            }
            if (actions.removeRuntimeRoots) {
                for (const runtimeRoot of runtimeRoots) {
                    await fsp.rm(runtimeRoot.path, { recursive: true, force: true });
                    execution.push({
                        label: 'runtime-root',
                        status: 'pass',
                        detail: `Removed ${runtimeRoot.path}`,
                    });
                }
            }
        }
    }

    if (json) {
        console.log(JSON.stringify({
            currentVersion: context.currentVersion,
            runtimeRoot: root,
            scanRoots,
            removeAll,
            keepData,
            keepProjectBindings,
            install: {
                globalNpmVersion: context.globalNpmVersion,
                pythonVersion: context.pythonVersion,
                runningFromGlobalNpmInstall: context.runningFromGlobalNpmInstall,
                codexRegistration,
            },
            runtimeRoots,
            projectArtifacts,
            processes,
            actions,
            plan: plannedSteps,
            action: actionLabel,
            execution,
            note,
        }, null, 2));
        return;
    }

    console.log(sectionTitle('Iranti Uninstall'));
    console.log(`  current_version       ${context.currentVersion}`);
    console.log(`  runtime_root          ${root}`);
    console.log(`  npm_global            ${context.globalNpmVersion ?? paint('not installed', 'gray')}`);
    console.log(`  python                ${context.pythonVersion ?? paint('not installed', 'gray')}`);
    console.log(`  codex_registration    ${codexRegistration ? paint('yes', 'green') : paint('no', 'gray')}`);
    console.log(`  remove_all            ${removeAll ? paint('yes', 'yellow') : paint('no', 'gray')}`);
    console.log(`  keep_data             ${keepData ? paint('yes', 'yellow') : paint('no', 'gray')}`);
    console.log(`  keep_project_bindings ${keepProjectBindings ? paint('yes', 'yellow') : paint('no', 'gray')}`);
    console.log('');
    console.log(`  scan_roots            ${scanRoots.length > 0 ? scanRoots.join(', ') : '(none)'}`);
    console.log(`  live_processes        ${processes.length}`);
    console.log(`  project_artifacts     ${projectArtifacts.length}`);
    console.log(`  runtime_roots         ${runtimeRoots.length}`);
    console.log('');
    if (plannedSteps.length > 0) {
        console.log('  plan');
        for (const step of plannedSteps) {
            console.log(`    - ${step}`);
        }
    } else {
        console.log('  plan');
        console.log('    - Nothing to remove.');
    }
    if (processes.length > 0) {
        console.log('');
        console.log('  processes');
        for (const candidate of processes) {
            console.log(`    - pid=${candidate.pid} ${candidate.label}${candidate.command ? ` :: ${truncateText(candidate.command, 120)}` : ''}`);
        }
    }
    if (projectArtifacts.length > 0) {
        console.log('');
        console.log('  project_artifacts');
        for (const artifact of projectArtifacts) {
            console.log(`    - ${artifact.projectPath}`);
            if (artifact.bindingFile) console.log(`      binding  ${artifact.bindingFile}`);
            if (artifact.mcpFile) console.log(`      mcp      ${artifact.mcpFile}`);
            if (artifact.claudeSettingsFile) console.log(`      claude   ${artifact.claudeSettingsFile}`);
        }
    }
    if (runtimeRoots.length > 0) {
        console.log('');
        console.log('  runtime_roots');
        for (const runtimeRoot of runtimeRoots) {
            console.log(`    - ${runtimeRoot.path} (${runtimeRoot.source})`);
        }
    }

    if (execution.length > 0) {
        console.log('');
        for (const result of execution) {
            const marker = result.status === 'pass'
                ? okLabel('PASS')
                : result.status === 'warn'
                    ? warnLabel('WARN')
                    : failLabel('FAIL');
            console.log(`${marker} ${result.detail}`);
        }
    }

    if (note) {
        console.log('');
        console.log(`${infoLabel()} ${note}`);
    }
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

    console.log(sectionTitle('Provider Keys'));
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

    console.log(`${okLabel()} ${providerDisplayName(provider)} API key ${mode === 'add' ? 'stored' : 'updated'}.`);
    console.log(`  provider  ${provider}`);
    console.log(`  env key   ${envKey}`);
    console.log(`  value     ${redactSecret(key)}`);
    console.log(`  target    ${target.envFile}`);
    if (updates.LLM_PROVIDER) {
        console.log(`  default   ${paint(provider, 'cyan')}`);
    }
    printNextSteps([
        `iranti list api-keys${target.instanceName ? ` --instance ${target.instanceName}` : target.projectPath ? ` --project "${target.projectPath}"` : ''}`,
    ]);
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

    console.log(`${okLabel()} ${providerDisplayName(provider)} API key removed.`);
    console.log(`  provider  ${provider}`);
    console.log(`  env key   ${envKey}`);
    console.log(`  target    ${target.envFile}`);
    printNextSteps([
        `iranti list api-keys${target.instanceName ? ` --instance ${target.instanceName}` : target.projectPath ? ` --project "${target.projectPath}"` : ''}`,
    ]);
}

async function setupCommand(args: ParsedArgs): Promise<void> {
    const configPath = getFlag(args, 'config');
    const useDefaults = hasFlag(args, 'defaults');

    if (configPath && useDefaults) {
        throw new Error('Use either --config <file> or --defaults, not both.');
    }

    if (configPath || useDefaults) {
        const dependencyChecks = await collectDependencyChecks();
        printDependencyChecks(dependencyChecks);
        console.log('');
        const plan = configPath ? parseSetupConfig(configPath) : defaultsSetupPlan(args);
        const result = await executeSetupPlan(plan);

        console.log(sectionTitle('Setup Complete'));
        console.log(`  runtime root   ${result.root}`);
        console.log(`  scope          ${result.scope}`);
        console.log(`  instance       ${result.instanceName}`);
        console.log(`  instance env   ${result.instanceEnvFile}`);
        console.log(`  instance url   http://localhost:${result.port}`);
        console.log(`  memory mode    ${result.mode}`);
        console.log(`  database mode  ${result.databaseMode}`);
        if (result.bindings.length === 0) {
            console.log(`  projects       ${paint('none bound yet', 'yellow')}`);
        } else {
            console.log('  projects');
            for (const binding of result.bindings) {
                console.log(`    - ${binding.projectPath} (${binding.agentId}, ${binding.projectMode})`);
            }
        }
        printNextSteps([
            `iranti run --instance ${result.instanceName} --root "${result.root}"`,
            `iranti doctor --instance ${result.instanceName} --root "${result.root}"`,
        ]);
        return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('iranti setup requires a real terminal session unless you provide --config <file> or --defaults.');
    }

    const explicitScope = getFlag(args, 'scope');
    const explicitRoot = getFlag(args, 'root');

    console.log(sectionTitle('Iranti Setup'));
    console.log('This wizard will get Iranti set up: install a runtime, create or update an instance, connect provider keys, create a usable Iranti API key, and optionally bind one or more project folders.');
    console.log('');
    const dependencyChecks = await collectDependencyChecks();
    printDependencyChecks(dependencyChecks);
    const recommendedDatabaseMode = recommendDatabaseMode(dependencyChecks);
    console.log(`${infoLabel()} Recommended database path: ${recommendedDatabaseMode === 'local' ? 'local PostgreSQL (pgvector required)' : recommendedDatabaseMode === 'docker' ? 'Docker-hosted PostgreSQL' : 'managed PostgreSQL'}`);
    if (recommendedDatabaseMode === 'managed' && dependencyChecks.every((check) => check.status === 'warn')) {
        printQuickInstallGuidance();
    }
    console.log('');

    let result: SetupExecutionResult | null = null;

    await withPromptSession(async (prompt) => {
        let setupMode: 'shared' | 'isolated' = 'isolated';
        while (true) {
            const chosen = (await prompt.line('Runtime mode (isolated or shared)', 'isolated') ?? 'isolated').trim().toLowerCase();
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
                'Isolated runtime path',
                explicitRoot ?? path.join(process.cwd(), '.iranti-runtime')
            ));
            finalScope = 'user';
        } else {
            while (true) {
                const chosenScope = (await prompt.line('Install scope (user or system)', explicitScope ?? 'user') ?? 'user').trim().toLowerCase();
                if (chosenScope === 'user' || chosenScope === 'system') {
                    finalScope = chosenScope;
                    break;
                }
                console.log(`${warnLabel()} Please choose either user or system.`);
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
            console.log(`${infoLabel()} Found existing instance '${instanceName}'. Updating it.`);
        } else {
            console.log(`${infoLabel()} Creating new instance '${instanceName}'.`);
        }

        const existingPort = Number.parseInt(existingInstance?.env.IRANTI_PORT ?? '3001', 10);
        const existingInstancePorts = await readAllInstancePorts(finalRoot);
        // Exclude the current instance's own port from the reserved set when updating
        if (existingInstance) existingInstancePorts.delete(existingPort);
        const port = await chooseAvailablePort(prompt, 'API port', existingPort, Boolean(existingInstance), existingInstancePorts);

        const dockerStatus = inspectDockerAvailability();
        const dockerAvailable = dockerStatus.daemonReachable;
        const psqlAvailable = hasCommandInstalled('psql');
        let dbUrl = '';
        let bootstrapDatabase = false;
        let databaseProvisioned = false;
        let dockerContainerName: string | undefined;
        let databaseMode: DatabaseSetupMode = recommendedDatabaseMode;
        while (true) {
            const defaultMode = recommendedDatabaseMode;
            const dbMode = (await prompt.line(
                'Database mode (local, managed, or docker)',
                defaultMode
            ) ?? defaultMode).trim().toLowerCase();

            if (dbMode === 'existing' || dbMode === 'local' || dbMode === 'managed') {
                databaseMode = dbMode === 'existing' ? 'local' : dbMode;
                const defaultDatabaseUrl = databaseMode === 'local'
                    ? existingInstance?.env.DATABASE_URL ?? deriveDatabaseUrlForMode('local', instanceName)
                    : existingInstance?.env.DATABASE_URL ?? '';
                while (true) {
                    dbUrl = await promptNonEmpty(
                        prompt,
                        'DATABASE_URL',
                        defaultDatabaseUrl
                    );
                    if (!detectPlaceholder(dbUrl)) break;
                    console.log(`${warnLabel()} DATABASE_URL still looks like a placeholder. Enter a real connection string before finishing setup.`);
                }
                if (databaseMode === 'local') {
                    if (!psqlAvailable) {
                        console.log(`${warnLabel()} psql is not installed, so Iranti can only self-create the local database if it already exists. Install PostgreSQL tools if you want setup to create the database for you.`);
                    } else {
                        console.log(`${infoLabel()} Iranti will create the local database automatically if it does not already exist.`);
                    }
                }
                bootstrapDatabase = await promptYesNo(prompt, 'Run migrations and seed the database now?', true);
                break;
            }

            if (dbMode === 'docker') {
                databaseMode = 'docker';
                if (!dockerAvailable) {
                    console.log(`${warnLabel()} ${dockerStatus.detail}`);
                    continue;
                }
                const dbHostPort = await chooseAvailablePort(prompt, 'Docker PostgreSQL host port', 5432, false);
                const dbName = sanitizeIdentifier(await promptNonEmpty(prompt, 'Docker PostgreSQL database name', `iranti_${instanceName}`), `iranti_${instanceName}`);
                const dbPassword = await promptSecretWithDefault(prompt, 'Docker PostgreSQL password', 'postgres');
                const containerName = sanitizeIdentifier(
                    await promptNonEmpty(prompt, 'Docker container name', `iranti_${instanceName}_db`),
                    `iranti_${instanceName}_db`
                );
                dockerContainerName = containerName;
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
                    databaseProvisioned = true;
                }
                bootstrapDatabase = await promptYesNo(prompt, 'Run migrations and seed the database now?', true);
                break;
            }

            console.log(`${warnLabel()} Choose one of: local, managed, docker.`);
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
                const chosen = normalizeProvider(await promptNonEmpty(prompt, 'Additional provider', 'claude'));
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
            const projectPath = path.resolve(await promptNonEmpty(prompt, 'Project path to bind', projects.length === 0 ? defaultProjectPath : process.cwd()));
            const agentId = sanitizeIdentifier(
                await promptNonEmpty(prompt, 'Project agent ID', projectAgentDefault(projectPath)),
                'project_main'
            );
            const memoryEntity = await promptNonEmpty(prompt, 'Project memory entity', 'user/main');
            const claudeCode = await promptYesNo(prompt, 'Create Claude Code project files here now?', true);
            projects.push({
                path: projectPath,
                agentId,
                memoryEntity,
                projectMode: setupMode,
                claudeCode,
            });
            if (setupMode === 'shared') {
                shouldBindProject = await promptYesNo(prompt, 'Bind another project folder?', false);
            } else {
                shouldBindProject = false;
            }
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
            databaseMode,
            provider,
            providerKeys,
            apiKey: defaultApiKey,
            projects,
            codex,
            codexAgent: projects[0]?.agentId,
            bootstrapDatabase,
            dockerContainerName,
            databaseProvisioned,
        });
    });

    if (!result) {
        throw new Error('Setup did not produce a result.');
    }
    const finalResult: SetupExecutionResult = result;

    console.log('');
    console.log(sectionTitle('Setup Complete'));
    console.log(`  runtime root   ${finalResult.root}`);
    console.log(`  scope          ${finalResult.scope}`);
    console.log(`  instance       ${finalResult.instanceName}`);
    console.log(`  instance env   ${finalResult.instanceEnvFile}`);
    console.log(`  instance url   http://localhost:${finalResult.port}`);
    console.log(`  memory mode    ${finalResult.mode}`);
    console.log(`  database mode  ${finalResult.databaseMode}`);
    if (finalResult.bindings.length === 0) {
            console.log(`  projects       ${paint('none bound yet', 'yellow')}`);
    } else {
        console.log('  projects');
        for (const binding of finalResult.bindings) {
            console.log(`    - ${binding.projectPath} (${binding.agentId}, ${binding.projectMode})`);
        }
    }
    const nextSteps = [
        `iranti run --instance ${finalResult.instanceName} --root "${finalResult.root}"`,
        `iranti doctor --instance ${finalResult.instanceName} --root "${finalResult.root}"`,
    ];
    if (finalResult.bindings.length > 0) {
        nextSteps.push(`cd "${finalResult.bindings[0]!.projectPath}"`);
        nextSteps.push('iranti chat');
    }
    printNextSteps(nextSteps);
}

async function doctorCommand(args: ParsedArgs): Promise<void> {
    const json = hasFlag(args, 'json');
    const { envFile, envSource } = resolveDoctorEnvTarget(args);

    const checks: DoctorCheck[] = [];
    const version = getPackageVersion();
    const pushEnvironmentChecks = async (env: Record<string, string>, prefix = ''): Promise<void> => {
        const databaseUrl = env.DATABASE_URL;
        let databaseInitializedForDoctor = false;
        checks.push(detectPlaceholder(databaseUrl)
            ? {
                name: `${prefix}database configuration`,
                status: 'fail',
                detail: 'DATABASE_URL is missing or still uses a placeholder value.',
            }
            : {
                name: `${prefix}database configuration`,
                status: 'pass',
                detail: 'DATABASE_URL is present and non-placeholder.',
            });

        const provider = env.LLM_PROVIDER ?? 'mock';
        checks.push({
            name: `${prefix}llm provider`,
            status: 'pass',
            detail: `LLM_PROVIDER=${provider}`,
        });

        const providerKeyCheck = detectProviderKey(provider, env);
        checks.push({
            ...providerKeyCheck,
            name: `${prefix}${providerKeyCheck.name}`,
        });

        try {
            if (!detectPlaceholder(databaseUrl)) {
                initDb(databaseUrl);
                databaseInitializedForDoctor = true;
            }
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
                name: `${prefix}vector backend`,
                status: reachable ? 'pass' : 'warn',
                detail: url
                    ? `${backendName} (${url}) is ${reachable ? 'reachable' : 'unreachable'}`
                    : `${backendName} is ${reachable ? 'reachable' : 'unreachable'}`,
            });
        } catch (error) {
            checks.push({
                name: `${prefix}vector backend`,
                status: 'fail',
                detail: error instanceof Error ? error.message : String(error),
            });
        } finally {
            if (databaseInitializedForDoctor) {
                await disconnectDb();
            }
        }
    };

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
        const treatAsProjectBinding = envSource === 'project-binding'
            || path.basename(envFile).toLowerCase() === '.env.iranti'
            || (Boolean(env.IRANTI_URL?.trim()) && detectPlaceholder(env.DATABASE_URL));
        checks.push({
            name: 'environment file',
            status: 'pass',
            detail: `${envSource} env loaded from ${envFile}`,
        });

        if (treatAsProjectBinding) {
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

        if (treatAsProjectBinding) {
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
            const linkedInstanceEnv = env.IRANTI_INSTANCE_ENV?.trim();
            if (!linkedInstanceEnv) {
                checks.push({
                    name: 'bound instance env',
                    status: 'warn',
                    detail: 'IRANTI_INSTANCE_ENV is not set in .env.iranti. Skipping database and provider checks for the bound instance.',
                });
            } else if (!fs.existsSync(linkedInstanceEnv)) {
                checks.push({
                    name: 'bound instance env',
                    status: 'warn',
                    detail: `Linked instance env not found: ${linkedInstanceEnv}. Skipping database and provider checks for the bound instance.`,
                });
            } else {
                checks.push({
                    name: 'bound instance env',
                    status: 'pass',
                    detail: `Using ${linkedInstanceEnv} for bound instance diagnostics.`,
                });
                const linkedEnv = await readEnvFile(linkedInstanceEnv);
                await pushEnvironmentChecks(linkedEnv, 'bound instance ');
            }
        } else {
            await pushEnvironmentChecks(env);
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
    }

    const result = {
        version,
        envSource,
        envFile,
        status: summarizeStatus(checks),
        checks,
        remediations: collectDoctorRemediations(checks, envSource, envFile),
    };

    if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log(sectionTitle('Iranti Doctor'));
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
        console.log(`${marker} ${check.name} - ${check.detail}`);
    }

    if (result.remediations.length > 0) {
        console.log('');
        console.log('Suggested fixes:');
        for (const remediation of result.remediations) {
            console.log(`  - ${remediation}`);
        }
    }

    if (result.status !== 'pass') {
        process.exitCode = 1;
    }
}

async function statusCommand(args: ParsedArgs): Promise<void> {
    const scope = normalizeScope(getFlag(args, 'scope'));
    const resolution = resolveInstallRootDetails(args, scope);
    const root = resolution.root;
    const json = hasFlag(args, 'json');
    const cwd = process.cwd();
    const repoEnv = findClosestAncestorFile(cwd, '.env');
    const projectEnv = findClosestAncestorFile(cwd, '.env.iranti');
    const localRuntimeRoot = findClosestAncestorRuntimeRoot(cwd);
    const installMetaPath = resolution.installMetaPath;
    const binding = projectEnv && fs.existsSync(projectEnv) ? await inspectProjectBinding(projectEnv) : null;
    const boundRuntimeRoot = binding?.runtimeRoot ?? null;
    const boundInstanceEnv = binding?.instanceEnvFile ?? null;
    const rootMismatch = Boolean(boundRuntimeRoot && path.resolve(boundRuntimeRoot) !== path.resolve(root));
    const otherRuntimeRoots = Array.from(new Set(
        [boundRuntimeRoot, localRuntimeRoot]
            .filter((candidate): candidate is string => Boolean(candidate))
            .map((candidate) => path.resolve(candidate))
            .filter((candidate) => candidate !== path.resolve(root) && fs.existsSync(candidate))
    ));

    const rows: StatusRow[] = [];
    rows.push({ label: 'version', value: getPackageVersion() });
    rows.push({ label: 'scope', value: scope });
    rows.push({ label: 'runtime_root', value: root });
    rows.push({ label: 'root_source', value: describeRuntimeRootSource(resolution.source) });
    if (boundRuntimeRoot) rows.push({ label: 'bound_root', value: boundRuntimeRoot });
    rows.push({ label: 'repo_env', value: repoEnv && fs.existsSync(repoEnv) ? repoEnv : '(missing)' });
    rows.push({ label: 'project_binding', value: projectEnv && fs.existsSync(projectEnv) ? projectEnv : '(missing)' });
    rows.push({ label: 'install_meta', value: fs.existsSync(installMetaPath) ? installMetaPath : '(not initialized)' });
    if (rootMismatch) rows.push({ label: 'root_mismatch', value: 'project binding points at a different runtime root' });

    const instances = await collectRuntimeInstanceSummaries(root);

    if (json) {
        console.log(JSON.stringify({
            version: getPackageVersion(),
            scope,
            runtimeRoot: root,
            runtimeRootSource: resolution.source,
            boundRuntimeRoot,
            boundInstanceEnv,
            rootMismatch,
            otherRuntimeRoots,
            repoEnv: repoEnv && fs.existsSync(repoEnv) ? repoEnv : null,
            projectBinding: projectEnv && fs.existsSync(projectEnv) ? projectEnv : null,
            installMeta: fs.existsSync(installMetaPath) ? installMetaPath : null,
            instances,
        }, null, 2));
        return;
    }

    console.log(sectionTitle('Iranti Status'));
    for (const row of rows) {
        console.log(`  ${row.label.padEnd(15)} ${row.value}`);
    }
    if (otherRuntimeRoots.length > 0) {
        console.log('  other_roots');
        for (const runtimeRoot of otherRuntimeRoots) {
            console.log(`    - ${runtimeRoot}`);
        }
    }

    console.log('');
    if (instances.length === 0) {
        console.log('Instances: none');
    } else {
        console.log('Instances:');
        for (const instance of instances) {
            console.log(`  - ${instance.name} (port ${instance.port})`);
            console.log(`    env: ${instance.envFile}`);
            console.log(`    meta: ${instance.metaFile}`);
            console.log(`    config: ${describeInstanceConfig(instance.config)}`);
            console.log(`    runtime: ${describeInstanceRuntime(instance.runtime)}`);
            if (instance.runtime.state?.healthUrl) {
                console.log(`    health: ${instance.runtime.state.healthUrl}`);
            }
        }
    }
}

async function collectRuntimeInstanceSummaries(root: string): Promise<Array<{
    name: string;
    port: string;
    envFile: string;
    metaFile: string;
    config: InstanceConfigSummary;
    runtime: InstanceRuntimeSummary;
}>> {
    const instancesDir = path.join(root, 'instances');
    const instances: Array<{
        name: string;
        port: string;
        envFile: string;
        metaFile: string;
        config: InstanceConfigSummary;
        runtime: InstanceRuntimeSummary;
    }> = [];
    if (!fs.existsSync(instancesDir)) {
        return instances;
    }

    const entries = await fsp.readdir(instancesDir, { withFileTypes: true });
    for (const entry of entries.filter((value) => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const { envFile, metaFile } = instancePaths(root, entry.name);
        const config = await inspectInstanceConfig(root, entry.name);
        let port = '(unknown)';
        if (config.state.envPresent && config.state.envReadable) {
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
            envFile: config.state.envPresent ? envFile : '(missing)',
            metaFile: config.state.metaPresent ? metaFile : '(missing)',
            config,
            runtime: await readInstanceRuntimeSummary(root, entry.name),
        });
    }
    return instances;
}

async function upgradeCommand(args: ParsedArgs): Promise<void> {
    const runAll = hasFlag(args, 'all');
    const checkOnly = hasFlag(args, 'check');
    const dryRun = hasFlag(args, 'dry-run');
    const execute = hasFlag(args, 'yes');
    const json = hasFlag(args, 'json');
    const requestedTargets = resolveRequestedUpgradeTargets(getFlag(args, 'target'), runAll);
    const context = detectUpgradeContext(args);
    const latestNpm = await fetchLatestNpmVersion();
    const latestPython = await fetchLatestPypiVersion();
    const statuses = buildUpgradeTargetStatuses(context, latestNpm, latestPython);
    const statusByTarget = new Map(statuses.map((status) => [status.target, status] as const));
    const autoSelected = requestedTargets.includes('auto')
        ? chooseUpgradeTarget('auto', context)
        : null;
    const explicitTargets = requestedTargets
        .filter((target): target is Exclude<UpgradeTarget, 'auto'> => target !== 'auto');
    for (const target of explicitTargets) {
        const status = statusByTarget.get(target);
        if (!runAll && !status?.available) {
            throw new Error(`Requested target '${target}' is not available in this environment.`);
        }
    }
    const selectedTargets = requestedTargets.includes('auto')
        ? (autoSelected ? [autoSelected] : [])
        : explicitTargets.filter((target) => {
            const status = statusByTarget.get(target);
            if (!status?.available) return false;
            if (runAll && status.blockedReason) return false;
            return true;
        });
    const commands = {
        npmGlobal: 'npm install -g iranti@latest',
        npmRepo: 'git pull --ff-only && npm install && npm run build',
        python: context.python?.display ?? 'python -m pip install --upgrade iranti',
    };
    const updateAvailable = {
        npm: context.globalNpmVersion && latestNpm ? compareVersions(latestNpm, context.globalNpmVersion) > 0 : null,
        python: context.pythonVersion && latestPython ? compareVersions(latestPython, context.pythonVersion) > 0 : null,
    };
    const plan = selectedTargets.flatMap((target) => commandListForTarget(target, context).map((step) => step.display));
    const runtimeInstances = await collectRuntimeInstanceSummaries(context.runtimeRoot);
    const runningRuntimeInstances = runtimeInstances.filter((instance) => instance.runtime.running);
    const restartRequiredInstances = runningRuntimeInstances.filter((instance) => {
        const version = instance.runtime.state?.version;
        return Boolean(version && version !== context.currentVersion);
    });
    const detachedRestartCommand = hasFlag(args, 'restart') && getFlag(args, 'instance')
        ? `& 'iranti' instance restart '${escapeForSingleQuotedPowerShell(getFlag(args, 'instance')!)}' --scope '${normalizeScope(getFlag(args, 'scope'))}' --root '${escapeForSingleQuotedPowerShell(resolveInstallRoot(args, normalizeScope(getFlag(args, 'scope'))))}'`
        : undefined;

    let execution: UpgradeExecutionResult[] = [];
    let note: string | null = null;
    let restartSummary: { instanceName: string; newPid: number; previousPid: number | null } | null = null;

    if (execute) {
        if (selectedTargets.length === 0) {
            throw new Error('No executable upgrade path was detected. Use --target npm-global, --target npm-repo, --target python, or --all.');
        }
        if (dryRun || checkOnly) {
            note = 'Execution skipped because --dry-run or --check was provided.';
        } else {
            execution = await executeUpgradeTargets(selectedTargets, context, {
                detachedPostCommand: detachedRestartCommand,
            });
            if (hasFlag(args, 'restart')) {
                const instanceName = getFlag(args, 'instance');
                if (!instanceName) {
                    throw cliError(
                        'IRANTI_INSTANCE_NAME_REQUIRED',
                        'Missing --instance <name>. Usage: iranti upgrade --yes --restart --instance <name>',
                        ['Pass the running instance name you want restarted after upgrade.']
                    );
                }
                const scope = normalizeScope(getFlag(args, 'scope'));
                const root = resolveInstallRoot(args, scope);
                const detachedHandled = execution.some((result) =>
                    result.target === 'npm-global'
                    && result.verification.status === 'warn'
                    && result.verification.detail.includes('Scheduled detached npm global upgrade')
                );
                if (!detachedHandled) {
                    const restarted = await restartInstanceRuntime(args, instanceName, scope, root);
                    restartSummary = {
                        instanceName,
                        newPid: restarted.newPid,
                        previousPid: restarted.previousPid,
                    };
                } else {
                    restartSummary = {
                        instanceName,
                        newPid: 0,
                        previousPid: null,
                    };
                }
            }
        }
    } else if (!checkOnly && !dryRun && !json && process.stdin.isTTY && process.stdout.isTTY) {
        const interactiveTargets = await chooseInteractiveUpgradeTargets(statuses);
        if (interactiveTargets.length === 0) {
            note = 'No upgrade targets selected.';
        } else {
            execution = await executeUpgradeTargets(interactiveTargets, context);
        }
    } else if (!checkOnly && !dryRun) {
        note = 'Run with --yes to execute the selected upgrade path, or run plain `iranti upgrade` in a TTY to choose interactively.';
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
                repoDirty: context.repoDirty,
                globalNpmInstall: context.globalNpmInstall,
                globalNpmRoot: context.globalNpmRoot,
                globalNpmVersion: context.globalNpmVersion,
                runningFromGlobalNpmInstall: context.runningFromGlobalNpmInstall,
                pythonLauncher: context.python?.executable ?? null,
                pythonVersion: context.pythonVersion,
            },
            runtimeInstances,
            runningRuntimeInstances,
            restartRequiredInstances,
            requestedTargets,
            selectedTargets,
            availableTargets: context.availableTargets,
            targets: statuses,
            updateAvailable,
            commands,
            plan,
            action: execution.length > 0 ? 'upgrade' : checkOnly ? 'check' : dryRun ? 'dry-run' : 'inspect',
            execution,
            restartSummary,
            note,
        }, null, 2));
        return;
    }

    console.log(sectionTitle('Iranti Upgrade'));
    console.log(`  current_version  ${context.currentVersion}`);
    console.log(`  latest_npm       ${latestNpm ?? '(unavailable)'}`);
    console.log(`  latest_python    ${latestPython ?? '(unavailable)'}`);
    console.log(`  package_root     ${context.packageRootPath}`);
    console.log(`  runtime_root     ${context.runtimeRoot}`);
    console.log(`  repo_checkout    ${context.repoCheckout ? paint('yes', 'green') : paint('no', 'gray')}${context.repoDirty ? paint(' (dirty)', 'yellow') : ''}`);
    console.log(`  npm_global       ${context.globalNpmInstall ? paint('yes', 'green') : paint('no', 'gray')}${context.globalNpmVersion ? ` (${context.globalNpmVersion})` : ''}`);
    if (context.runningFromGlobalNpmInstall) {
        console.log(`  npm_global_mode  ${paint('self-update requires detached handoff on Windows', 'yellow')}`);
    }
    console.log(`  python           ${context.python?.executable ?? paint('not found', 'yellow')}${context.pythonVersion ? ` (${context.pythonVersion})` : ''}`);
    console.log('');
    if (runningRuntimeInstances.length > 0) {
        console.log('  running_instances');
        for (const instance of runningRuntimeInstances) {
            const state = instance.runtime.state!;
            const versionLabel = state.version === context.currentVersion
                ? paint(state.version, 'green')
                : paint(`${state.version} != ${context.currentVersion}`, 'yellow');
            console.log(`    - ${instance.name} pid=${state.pid} port=${instance.port} version=${versionLabel}`);
        }
        if (restartRequiredInstances.length > 0) {
            console.log(`  restart_required ${paint(restartRequiredInstances.map((instance) => instance.name).join(', '), 'yellow')}`);
        }
        console.log('');
    }
    if (selectedTargets.length > 0) {
        console.log(`  selected_target${selectedTargets.length > 1 ? 's' : ''} ${paint(selectedTargets.join(', '), 'cyan')}${requestedTargets.includes('auto') ? paint(' (auto)', 'gray') : ''}`);
        console.log('  plan');
        for (const step of plan) {
            console.log(`    - ${step}`);
        }
    } else {
        console.log(`  selected_targets ${paint('none', 'yellow')}`);
        console.log('  plan             No executable upgrade path detected automatically.');
    }
    console.log('');
    console.log(`  npm global       ${commands.npmGlobal}`);
    console.log(`  npm repo         ${commands.npmRepo}`);
    console.log(`  python client    ${commands.python}`);

    if (execution.length > 0) {
        console.log('');
        for (const result of execution) {
            const marker = result.verification.status === 'pass'
                ? okLabel('PASS')
                : result.verification.status === 'warn'
                    ? warnLabel('WARN')
                    : failLabel('FAIL');
            console.log(`${okLabel()} Upgrade completed for ${result.target}.`);
            console.log(`${marker} ${result.verification.detail}`);
        }
        if (restartSummary) {
            console.log(`${okLabel()} Restart scheduled for instance '${restartSummary.instanceName}'.`);
            console.log(`${infoLabel()} previous_pid=${restartSummary.previousPid ?? 'none'} new_pid=${restartSummary.newPid || '(unknown)'}`);
        }
        const { envFile } = resolveDoctorEnvTarget(args);
        if (envFile) {
            console.log(`${infoLabel()} Run \`iranti doctor\` to verify the active environment after the package upgrade.`);
        }
        if (execution.some((result) => result.target === 'npm-global')) {
            console.log(`${infoLabel()} If this shell started on an older global CLI, open a new terminal or rerun \`iranti upgrade --check\` to confirm the new binary is active.`);
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
    const dependencyChecks = await collectDependencyChecks();

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
    console.log('');
    printDependencyChecks(dependencyChecks);
    printNextSteps(['iranti setup']);
    if (dependencyChecks.every((check) => check.status === 'warn')) {
        console.log('');
        printQuickInstallGuidance();
    }
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
    const instanceAlreadyExisted = fs.existsSync(instanceDir);
    if (instanceAlreadyExisted && !hasFlag(args, 'force')) {
        throw new Error(`Instance '${name}' already exists at ${instanceDir}. Use --force to overwrite.`);
    }
    await assertPortAssignable(root, port, instanceAlreadyExisted ? name : undefined);

    // H-7: Register rollback if the instance dir is new (so SIGINT cleans up partial state)
    if (!instanceAlreadyExisted) {
        pushCleanup(async () => {
            try { await fsp.rm(instanceDir, { recursive: true, force: true }); } catch {}
        });
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

    // Instance fully created — pop the rollback so it doesn't run on normal exit
    if (!instanceAlreadyExisted) popCleanup();

    console.log(sectionTitle('Instance Created'));
    console.log(`  status  ${okLabel()}`);
    console.log(`  dir : ${instanceDir}`);
    console.log(`  env : ${envFile}`);
    console.log(`  port: ${port}`);
    console.log(`  provider: ${provider}`);
    if (providerKey && providerKeyName) {
        console.log(`  ${providerKeyName}: ${redactSecret(providerKey)}`);
    }
    printNextSteps([
        `iranti instance show ${name}`,
        `iranti run --instance ${name}`,
    ]);
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
        const runtime = await readInstanceRuntimeSummary(root, name);
        if (fs.existsSync(metaPath)) {
            try {
                const raw = await fsp.readFile(metaPath, 'utf-8');
                const meta = JSON.parse(raw) as InstanceMeta;
                console.log(`  - ${name} (port ${meta.port})`);
                console.log(`    runtime: ${describeInstanceRuntime(runtime)}`);
                continue;
            } catch {
                // fall through
            }
        }
        console.log(`  - ${name}`);
        console.log(`    runtime: ${describeInstanceRuntime(runtime)}`);
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
    const runtime = await readInstanceRuntimeSummary(root, name);
    console.log(bold(`Instance: ${name}`));
    console.log(`  dir : ${instanceDir}`);
    console.log(`  env : ${envFile}`);
    console.log(`  port: ${env.IRANTI_PORT ?? '3001'}`);
    console.log(`  db  : ${env.DATABASE_URL ?? '(missing)'}`);
    console.log(`  esc : ${env.IRANTI_ESCALATION_DIR ?? '(missing)'}`);
    console.log(`  runtime: ${describeInstanceRuntime(runtime)}`);
    if (runtime.state?.healthUrl) {
        console.log(`  health: ${runtime.state.healthUrl}`);
    }
    console.log(`${infoLabel()} Run with: iranti run --instance ${name}`);
}

async function runInstanceCommand(args: ParsedArgs): Promise<void> {
    const name = getFlag(args, 'instance') ?? args.positionals[0] ?? args.subcommand;
    if (!name) {
        throw cliError(
            'IRANTI_INSTANCE_NAME_REQUIRED',
            'Missing instance name. Usage: iranti run --instance <name>',
            ['Run `iranti instance list` to see configured instances.']
        );
    }
    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const { instanceDir, envFile, runtimeFile } = instancePaths(root, name);
    if (!fs.existsSync(envFile)) {
        throw cliError(
            'IRANTI_INSTANCE_NOT_FOUND',
            `Instance '${name}' not found. Create it first.`,
            [`Run \`iranti setup\` or \`iranti instance create ${name}\` first.`],
            { instance: name, envFile }
        );
    }

    const env = await readEnvFile(envFile);
    const runtime = await readInstanceRuntimeSummary(root, name);
    if (runtime.running) {
        throw cliError(
            'IRANTI_INSTANCE_ALREADY_RUNNING',
            `Instance '${name}' is already running on pid ${runtime.state?.pid ?? '(unknown)'}.`,
            [`Run \`iranti instance restart ${name}\` to restart the live process, or stop the existing process first.`],
            { instance: name, pid: runtime.state?.pid ?? null, runtimeFile }
        );
    }
    if (runtime.stale) {
        console.log(`${warnLabel()} Found stale runtime metadata for '${name}' at ${runtimeFile}; starting a fresh process.`);
    }
    for (const [k, v] of Object.entries(env)) {
        process.env[k] = v;
    }
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('yourpassword')) {
        throw cliError(
            'IRANTI_INSTANCE_DATABASE_PLACEHOLDER',
            `Instance '${name}' has placeholder DATABASE_URL. Edit ${envFile} first.`,
            ['Run `iranti configure instance <name> --interactive` or rerun `iranti setup`.'],
            { instance: name, envFile }
        );
    }
    const port = Number.parseInt(env.IRANTI_PORT ?? '3001', 10);
    if (!Number.isFinite(port) || port <= 0) {
        throw cliError(
            'IRANTI_INSTANCE_PORT_INVALID',
            `Instance '${name}' has invalid IRANTI_PORT in ${envFile}.`,
            ['Run `iranti configure instance <name> --port <n>` to repair it.'],
            { instance: name, envFile, port: env.IRANTI_PORT ?? null }
        );
    }
    if (!(await isPortUsable(port, '0.0.0.0', listPublishedDockerHostPorts()))) {
        throw cliError(
            'IRANTI_INSTANCE_PORT_IN_USE',
            `Cannot start instance '${name}' because port ${port} is already in use.`,
            ['Run `iranti configure instance <name> --port <n>` or free the port before retrying.'],
            { instance: name, envFile, port }
        );
    }
    await startInstanceRuntime(name, instanceDir, envFile, runtimeFile);
}

async function restartInstanceCommand(args: ParsedArgs): Promise<void> {
    const name = getFlag(args, 'instance') ?? args.positionals[0] ?? args.subcommand;
    if (!name) {
        throw cliError(
            'IRANTI_INSTANCE_NAME_REQUIRED',
            'Missing instance name. Usage: iranti instance restart <name>',
            ['Run `iranti instance list` to see configured instances.']
        );
    }

    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const { envFile } = await loadInstanceEnv(root, name);
    const restarted = await restartInstanceRuntime(args, name, scope, root);

    console.log(sectionTitle('Instance Restart Scheduled'));
    console.log(`  status    ${okLabel()}`);
    console.log(`  instance  ${name}`);
    console.log(`  env       ${envFile}`);
    if (restarted.previousPid) {
        console.log(`  previous  ${restarted.previousPid}`);
    }
    console.log(`  new_pid   ${restarted.newPid || '(unknown)'}`);
    console.log(`  runtime   ${restarted.runtimeBefore.running ? 'was running' : restarted.runtimeBefore.state ? 'was stale/stopped' : 'no prior runtime metadata'}`);
    printNextSteps([
        `iranti status --scope ${scope}${root ? ` --root "${root}"` : ''}`,
        `iranti doctor --instance ${name}${root ? ` --root "${root}"` : ''}`,
    ]);
}

async function projectInitCommand(args: ParsedArgs): Promise<void> {
    const projectPath = path.resolve(args.positionals[0] ?? process.cwd());
    const instanceName = getFlag(args, 'instance');
    if (!instanceName) {
        throw cliError(
            'IRANTI_INSTANCE_NAME_REQUIRED',
            'Missing --instance <name>. Usage: iranti project init [path] --instance <name>',
            ['Run `iranti instance list` to see available instances.']
        );
    }
    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const { envFile, env: instanceEnv } = await loadInstanceEnv(root, instanceName);
    const port = instanceEnv.IRANTI_PORT ?? '3001';
    const apiKey = getFlag(args, 'api-key') ?? instanceEnv.IRANTI_API_KEY ?? 'replace_me_with_api_key';
    const agentId = getFlag(args, 'agent-id') ?? projectAgentDefault(projectPath);
    const projectMode = normalizeProjectMode(getFlag(args, 'mode'), 'isolated');

    const outFile = path.join(projectPath, '.env.iranti');
    if (fs.existsSync(outFile) && !hasFlag(args, 'force')) {
        throw cliError(
            'IRANTI_PROJECT_BINDING_EXISTS',
            `${outFile} already exists. Use --force to overwrite.`,
            ['Use `iranti configure project` if you want to refresh the existing binding instead.'],
            { outFile }
        );
    }

    await writeProjectBinding(projectPath, {
        IRANTI_URL: `http://localhost:${port}`,
        IRANTI_API_KEY: apiKey,
        IRANTI_AGENT_ID: agentId,
        IRANTI_MEMORY_ENTITY: 'user/main',
        IRANTI_PROJECT_MODE: projectMode,
        IRANTI_INSTANCE: instanceName,
        IRANTI_INSTANCE_ENV: envFile,
    });

    console.log(sectionTitle('Project Initialized'));
    console.log(`  status ${okLabel()}`);
    console.log(`  wrote ${outFile}`);
    console.log(`  mode  ${projectMode}`);
    printNextSteps([
        `iranti doctor --instance ${instanceName}`,
        'iranti chat',
    ]);
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
            portRaw = await prompt.line('API port', portRaw ?? env.IRANTI_PORT);
            dbUrl = await prompt.line('DATABASE_URL', dbUrl ?? env.DATABASE_URL);
            providerInput = await prompt.line('LLM provider', providerInput ?? env.LLM_PROVIDER ?? 'mock');
            const interactiveProvider = normalizeProvider(providerInput ?? env.LLM_PROVIDER ?? 'mock');
            const interactiveProviderEnvKey = providerKeyEnv(interactiveProvider);
            if (interactiveProvider && interactiveProviderEnvKey) {
                providerKey = await prompt.secret(`${providerDisplayName(interactiveProvider)} API key`, providerKey ?? env[interactiveProviderEnvKey]);
            }
            apiKey = await prompt.secret('Iranti API key', apiKey ?? env.IRANTI_API_KEY);
        });
        clearProviderKey = false;
    }

    if (portRaw) {
        const port = Number.parseInt(portRaw, 10);
        if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid --port '${portRaw}'.`);
        await assertPortAssignable(root, port, name);
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
    if (updates.IRANTI_PORT) {
        await syncInstanceMeta(root, name, Number.parseInt(updates.IRANTI_PORT, 10));
    }

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

    console.log(sectionTitle('Instance Updated'));
    console.log(`  status   ${okLabel()}`);
    console.log(`  env      ${envFile}`);
    console.log(`  keys     ${result.updatedKeys.join(', ')}`);
    if (apiKey) {
        console.log(`  api key  ${redactSecret(apiKey)}`);
    }
    if (providerKey) {
        console.log(`  provider ${result.provider}`);
    }
    printNextSteps([
        `iranti doctor --instance ${name}${scope ? ` --scope ${scope}` : ''}`,
    ]);
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
    let explicitProjectMode: string | undefined = getFlag(args, 'mode');

    if (hasFlag(args, 'interactive')) {
        await withPromptSession(async (prompt) => {
            instanceName = await prompt.line('Instance name', instanceName);
            explicitUrl = await prompt.line('Iranti URL', explicitUrl ?? existing.IRANTI_URL);
            explicitApiKey = await prompt.secret('Project API key', explicitApiKey ?? existing.IRANTI_API_KEY);
            explicitAgentId = await prompt.line('Project agent ID', explicitAgentId ?? existing.IRANTI_AGENT_ID ?? projectAgentDefault(projectPath));
            explicitMemoryEntity = await prompt.line('Project memory entity', explicitMemoryEntity ?? existing.IRANTI_MEMORY_ENTITY ?? 'user/main');
            explicitProjectMode = await prompt.line('Project mode (isolated or shared)', explicitProjectMode ?? existing.IRANTI_PROJECT_MODE ?? inferProjectMode(projectPath, existing.IRANTI_INSTANCE_ENV));
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
        IRANTI_AGENT_ID: explicitAgentId ?? existing.IRANTI_AGENT_ID ?? projectAgentDefault(projectPath),
        IRANTI_MEMORY_ENTITY: explicitMemoryEntity ?? existing.IRANTI_MEMORY_ENTITY ?? 'user/main',
        IRANTI_PROJECT_MODE: normalizeProjectMode(explicitProjectMode, normalizeProjectMode(existing.IRANTI_PROJECT_MODE, inferProjectMode(projectPath, instanceEnvFile))),
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
        projectMode: updates.IRANTI_PROJECT_MODE,
        instance: updates.IRANTI_INSTANCE ?? null,
    };

    if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log(sectionTitle('Project Binding Updated'));
    console.log(`  status   ${okLabel()}`);
    console.log(`  path     ${projectPath}`);
    console.log(`  env      ${written}`);
    console.log(`  url      ${updates.IRANTI_URL}`);
    console.log(`  agent    ${updates.IRANTI_AGENT_ID}`);
    console.log(`  mode     ${updates.IRANTI_PROJECT_MODE}`);
    if (updates.IRANTI_INSTANCE) {
        console.log(`  instance ${updates.IRANTI_INSTANCE}`);
    }
    printNextSteps([
        `iranti doctor${updates.IRANTI_INSTANCE ? ` --instance ${updates.IRANTI_INSTANCE}` : ''}`,
    ]);
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

    console.log(sectionTitle('API Key Ready'));
    console.log(`  status  ${okLabel()}`);
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
    printNextSteps([
        `iranti doctor --instance ${instanceName}`,
    ]);
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

    console.log(sectionTitle(`Registry API Keys For ${instanceName}`));
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

    console.log(sectionTitle('API Key Revoked'));
    console.log(`  status   ${okLabel()}`);
    console.log(`  keyId    ${keyId}`);
    console.log(`  instance ${instanceName}`);
    process.exit(0);
}

async function resolveCommand(args: ParsedArgs): Promise<void> {
    const explicitDir = getFlag(args, 'dir');
    const escalationDir = explicitDir ? path.resolve(explicitDir) : getEscalationPaths().root;
    await resolveInteractive(escalationDir);
}

async function handshakeCommand(args: ParsedArgs): Promise<void> {
    const json = hasFlag(args, 'json');
    const target = await resolveAttendantCliTarget(args);
    const task = getFlag(args, 'task')?.trim() || 'CLI handshake';
    const recentMessages = resolveRecentMessages(args);
    const result = await target.iranti.handshake({
        agent: target.agentId,
        task,
        recentMessages,
    });

    if (json) {
        console.log(JSON.stringify({
            agent: target.agentId,
            envSource: target.envSource,
            envFile: target.envFile,
            task,
            recentMessages,
            result,
        }, null, 2));
        return;
    }

    printHandshakeResult(target, task, result);
    console.log('');
    console.log(`${infoLabel()} This is a manual Attendant inspection tool. Claude Code should still use hooks + MCP in normal operation.`);
}

async function attendCommand(args: ParsedArgs): Promise<void> {
    const json = hasFlag(args, 'json');
    const target = await resolveAttendantCliTarget(args);
    const latestMessage = resolveAttendMessage(args);
    const currentContext = resolveContextText(args);
    const maxFacts = parsePositiveInteger(getFlag(args, 'max-facts'), 'max-facts');
    const entityHint = getFlag(args, 'entity-hint')?.trim();
    if (entityHint && !entityHint.includes('/')) {
        throw new Error('entity-hint must use entityType/entityId format.');
    }

    const result = await target.iranti.attend({
        agent: target.agentId,
        currentContext,
        latestMessage,
        forceInject: hasFlag(args, 'force'),
        maxFacts,
        entityHints: entityHint ? [entityHint] : undefined,
    });

    if (json) {
        console.log(JSON.stringify({
            agent: target.agentId,
            envSource: target.envSource,
            envFile: target.envFile,
            latestMessage,
            currentContext,
            maxFacts: maxFacts ?? null,
            entityHints: entityHint ? [entityHint] : [],
            forceInject: hasFlag(args, 'force'),
            result,
        }, null, 2));
        return;
    }

    printAttendResult(target, latestMessage, result);
    console.log('');
    console.log(`${infoLabel()} This is a manual Attendant inspection tool. Claude Code should still use hooks + MCP in normal operation.`);
}

async function handoffCommand(args: ParsedArgs): Promise<void> {
    const json = hasFlag(args, 'json');
    const target = await resolveAttendantCliTarget(args);
    const taskEntity = resolveTaskEntity(args);
    const projectEntity = getFlag(args, 'project-entity')?.trim();
    if (projectEntity && !projectEntity.includes('/')) {
        throw new Error('project-entity must use entityType/entityId format.');
    }

    const nextStep = getFlag(args, 'next-step')?.trim();
    if (!nextStep) {
        throw new Error('Missing --next-step. A standardized handoff must record the receiver action.');
    }

    const status = getFlag(args, 'status')?.trim() || 'ready_for_handoff';
    const owner = getFlag(args, 'owner')?.trim();
    const blockers = parseDelimitedList(getFlag(args, 'blockers'));
    const artifacts = parseDelimitedList(getFlag(args, 'artifacts'));
    const notes = getFlag(args, 'notes')?.trim();
    const source = getFlag(args, 'source')?.trim() || 'CLIHandoff';
    const confidence = parsePositiveInteger(getFlag(args, 'confidence'), 'confidence') ?? 95;
    if (confidence > 100) {
        throw new Error('confidence must be <= 100.');
    }

    const writes: Array<{ entity: string; key: string; value: unknown; summary: string }> = [];
    writes.push({
        entity: taskEntity,
        key: 'status',
        value: { state: status },
        summary: buildHandoffSummary('status', { state: status }),
    });
    writes.push({
        entity: taskEntity,
        key: 'next_step',
        value: { instruction: nextStep },
        summary: buildHandoffSummary('next_step', { instruction: nextStep }),
    });
    if (owner) {
        writes.push({
            entity: taskEntity,
            key: 'current_owner',
            value: { agentId: owner },
            summary: buildHandoffSummary('current_owner', { agentId: owner }),
        });
    }
    if (blockers.length > 0) {
        writes.push({
            entity: taskEntity,
            key: 'blockers',
            value: { items: blockers },
            summary: buildHandoffSummary('blockers', { items: blockers }),
        });
    }
    if (artifacts.length > 0) {
        writes.push({
            entity: taskEntity,
            key: 'artifacts',
            value: { files: artifacts },
            summary: buildHandoffSummary('artifacts', { files: artifacts }),
        });
    }
    if (notes) {
        writes.push({
            entity: taskEntity,
            key: 'notes',
            value: { text: notes },
            summary: buildHandoffSummary('notes', { text: notes }),
        });
    }
    if (projectEntity) {
        writes.push({
            entity: projectEntity,
            key: 'active_handoff_task',
            value: {
                taskEntity,
                owner: owner ?? null,
                status,
                updatedBy: target.agentId,
            },
            summary: buildHandoffSummary('active_handoff_task', { taskEntity }),
        });
    }

    for (const write of writes) {
        await target.iranti.write({
            entity: write.entity,
            key: write.key,
            value: write.value,
            summary: write.summary,
            confidence,
            source,
            agent: target.agentId,
        });
    }

    if (json) {
        console.log(JSON.stringify({
            agent: target.agentId,
            envSource: target.envSource,
            envFile: target.envFile,
            source,
            confidence,
            writes,
        }, null, 2));
        process.exit(0);
    }

    printHandoffResult(target, taskEntity, writes);
    console.log('');
    console.log(`${infoLabel()} Handoffs are shared-memory facts. Pair this with checkpoint() if the sender also needs agent-local recovery.`);
    process.exit(0);
}

function printClaudeSetupHelp(): void {
    console.log([
        'Scaffold Claude Code MCP and hook files for the current project.',
        '',
        'Usage:',
        '  iranti claude-setup [path] [--project-env <path>] [--force]',
        '  iranti claude-setup --scan <dir> [--recursive] [--force]',
        '  iranti integrate claude [path] [--project-env <path>] [--force]',
        '  iranti integrate claude --scan <dir> [--recursive] [--force]',
        '',
        'Notes:',
        '  - Expects a project binding at .env.iranti unless --project-env is supplied.',
        '  - Writes .mcp.json and .claude/settings.local.json.',
        '  - Adds the Iranti MCP server to existing .mcp.json files without removing other servers.',
        '  - Leaves existing Claude hook files untouched unless --force is supplied.',
        '',
        'Scan mode (--scan):',
        '  - Scans immediate subdirectories of the given dir by default.',
        '  - Add --recursive to scan nested project trees too.',
        '  - Only scaffolds projects that already have a .claude subfolder.',
        '  - No .env.iranti required - skips the per-project binding check.',
        '  - Scan mode adds or merges .mcp.json and only creates hook settings when missing.',
    ].join('\n'));
}

function shouldSkipRecursiveClaudeScanDir(name: string): boolean {
    if (name.startsWith('.')) return true;
    return [
        'node_modules',
        'dist',
        'build',
        'out',
        'coverage',
        '.next',
        '.turbo',
        '.cache',
    ].includes(name);
}

function findClaudeProjects(scanDir: string, recursive: boolean): string[] {
    if (!recursive) {
        return fs.readdirSync(scanDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(scanDir, entry.name))
            .filter((candidate) => fs.existsSync(path.join(candidate, '.claude')));
    }

    const found = new Set<string>();
    const queue: string[] = [scanDir];
    while (queue.length > 0) {
        const current = queue.shift()!;
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        if (fs.existsSync(path.join(current, '.claude'))) {
            found.add(current);
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (shouldSkipRecursiveClaudeScanDir(entry.name)) continue;
            queue.push(path.join(current, entry.name));
        }
    }

    found.delete(scanDir);
    return Array.from(found).sort((a, b) => a.localeCompare(b));
}

function shouldSkipUninstallScanDir(name: string): boolean {
    if (name.startsWith('.git')) return true;
    return shouldSkipRecursiveClaudeScanDir(name) || [
        '.venv',
        'venv',
    ].includes(name);
}

function hasIrantiMcpServerConfig(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const mcpServers = record.mcpServers;
    if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) return false;
    return Object.prototype.hasOwnProperty.call(mcpServers, 'iranti');
}

function hasIrantiClaudeHookSettings(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const hooks = isClaudeHooksObject(record.hooks) ? record.hooks : null;
    if (!hooks) return false;
    for (const event of ['SessionStart', 'UserPromptSubmit'] as const) {
        const entries = hooks[event];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            if (isLegacyIrantiClaudeHookEntry(entry)) return true;
            const structured = entry as Record<string, unknown>;
            const nestedHooks = Array.isArray(structured.hooks) ? structured.hooks : [];
            if (nestedHooks.some((hook) => {
                if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return false;
                const command = typeof (hook as Record<string, unknown>).command === 'string'
                    ? String((hook as Record<string, unknown>).command)
                    : '';
                return command.includes('iranti claude-hook');
            })) {
                return true;
            }
        }
    }
    return false;
}

async function discoverProjectArtifacts(scanRoots: string[]): Promise<UninstallProjectArtifact[]> {
    const projects = new Map<string, UninstallProjectArtifact>();
    for (const scanRoot of scanRoots) {
        if (!fs.existsSync(scanRoot)) continue;
        const queue: string[] = [scanRoot];
        while (queue.length > 0) {
            const current = queue.shift()!;
            let entries: fs.Dirent[] = [];
            try {
                entries = await fsp.readdir(current, { withFileTypes: true });
            } catch {
                continue;
            }

            const bindingFile = path.join(current, '.env.iranti');
            const mcpFile = path.join(current, '.mcp.json');
            const claudeSettingsFile = path.join(current, '.claude', 'settings.local.json');

            const artifact: UninstallProjectArtifact = { projectPath: current };
            if (fs.existsSync(bindingFile)) artifact.bindingFile = bindingFile;
            if (fs.existsSync(mcpFile) && hasIrantiMcpServerConfig(readJsonFile<Record<string, unknown>>(mcpFile))) {
                artifact.mcpFile = mcpFile;
            }
            if (fs.existsSync(claudeSettingsFile) && hasIrantiClaudeHookSettings(readJsonFile<Record<string, unknown>>(claudeSettingsFile))) {
                artifact.claudeSettingsFile = claudeSettingsFile;
            }

            if (artifact.bindingFile || artifact.mcpFile || artifact.claudeSettingsFile) {
                projects.set(current, artifact);
            }

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (shouldSkipUninstallScanDir(entry.name)) continue;
                queue.push(path.join(current, entry.name));
            }
        }
    }

    return Array.from(projects.values()).sort((a, b) => a.projectPath.localeCompare(b.projectPath));
}

async function claudeSetupCommand(args: ParsedArgs): Promise<void> {
    if (hasFlag(args, 'help')) {
        printClaudeSetupHelp();
        return;
    }

    const force = hasFlag(args, 'force');

    if (args.flags.has('scan')) {
        const recursive = hasFlag(args, 'recursive');
        const dirArg = getFlag(args, 'scan')
            ?? args.positionals[0]
            ?? (args.command === 'claude-setup' ? args.subcommand ?? undefined : undefined);
        const scanDir = path.resolve(dirArg ?? process.cwd());

        if (!fs.existsSync(scanDir)) {
            throw cliError('IRANTI_SCAN_PATH_NOT_FOUND', `Scan directory not found: ${scanDir}`);
        }

        const candidates = findClaudeProjects(scanDir, recursive);

        if (candidates.length === 0) {
            console.log(`${infoLabel()} No ${recursive ? 'nested project directories' : 'subdirectories'} with a .claude folder found in ${scanDir}`);
            return;
        }

        console.log(`${okLabel()} Scanning ${scanDir} - found ${candidates.length} project(s) with .claude${recursive ? ' (recursive)' : ''}`);
        let createdMcp = 0;
        let updatedMcp = 0;
        let createdSettings = 0;
        let updatedSettings = 0;
        let unchanged = 0;
        for (const projectPath of candidates) {
            const result = await writeClaudeCodeProjectFiles(projectPath, undefined, force);
            if (result.mcp === 'created') createdMcp += 1;
            if (result.mcp === 'updated') updatedMcp += 1;
            if (result.settings === 'created') createdSettings += 1;
            if (result.settings === 'updated') updatedSettings += 1;
            if (result.mcp === 'unchanged' && result.settings === 'unchanged') unchanged += 1;
            console.log(`  ${projectPath}`);
            console.log(`    mcp       ${result.mcp}`);
            console.log(`    settings  ${result.settings}`);
        }
        console.log('');
        console.log('Summary:');
        console.log(`  projects          ${candidates.length}`);
        console.log(`  mcp created       ${createdMcp}`);
        console.log(`  mcp updated       ${updatedMcp}`);
        console.log(`  settings created  ${createdSettings}`);
        console.log(`  settings updated  ${updatedSettings}`);
        console.log(`  unchanged         ${unchanged}`);
        console.log(`${infoLabel()} Done. Open each project in Claude Code to verify Iranti tools are available.`);
        return;
    }

    const projectArg = args.positionals[0] ?? (args.command === 'claude-setup' ? args.subcommand ?? undefined : undefined);
    const projectPath = path.resolve(projectArg ?? process.cwd());
    const explicitProjectEnv = getFlag(args, 'project-env');
    const projectEnvPath = explicitProjectEnv
        ? path.resolve(explicitProjectEnv)
        : path.join(projectPath, '.env.iranti');

    if (!fs.existsSync(projectPath)) {
        throw cliError('IRANTI_PROJECT_PATH_NOT_FOUND', `Project path not found: ${projectPath}`);
    }
    if (!fs.existsSync(projectEnvPath)) {
        throw cliError(
            'IRANTI_PROJECT_BINDING_MISSING',
            `Project binding not found at ${projectEnvPath}. Run \`iranti project init\` or \`iranti configure project\` first.`,
            ['Run `iranti project init . --instance <name>` before `iranti claude-setup`.'],
            { projectEnvPath }
        );
    }

    const result = await writeClaudeCodeProjectFiles(projectPath, projectEnvPath, force);

    console.log(`${okLabel()} Claude Code integration scaffolded`);
    console.log(`  project   ${projectPath}`);
    console.log(`  binding   ${projectEnvPath}`);
    console.log(`  mcp       ${path.join(projectPath, '.mcp.json')}`);
    console.log(`  settings  ${path.join(projectPath, '.claude', 'settings.local.json')}`);
    console.log(`  mcp status      ${result.mcp}`);
    console.log(`  settings status ${result.settings}`);
    console.log(`${infoLabel()} Next: open Claude Code in this project and verify Iranti tools are available.`);
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
    const rows: Array<[string, string]> = [
        ['iranti setup', 'Guided first-run setup. Best place to start.'],
        ['iranti run --instance local', 'Start a configured instance and record runtime metadata.'],
        ['iranti doctor', 'Check env, database, provider keys, and runtime health.'],
        ['iranti chat', 'Open the local Iranti chat shell.'],
    ];

    const printRows = (title: string, entries: Array<[string, string]>) => {
        console.log(sectionTitle(title));
        for (const [command, description] of entries) {
            console.log(`  ${commandText(command)}`);
            console.log(`    ${description}`);
        }
        console.log('');
    };

      console.log(sectionTitle('Iranti CLI'));
      console.log('Memory infrastructure for multi-agent systems.');
      console.log('Most instance-aware commands also accept --root <path> in addition to --scope.');
      console.log('Global debugging flags: --debug for extra diagnostics, --verbose for subprocess trace output.');
      console.log('');

    printRows('Start Here', rows);

    printRows('Setup And Runtime', [
        ['iranti install [--scope user|system] [--root <path>]', 'Initialize the machine-level runtime folders.'],
        ['iranti setup [--scope user|system] [--root <path>] [--mode isolated|shared] [--instance <name>] [--port <n>] [--config <file> | --defaults] [--db-mode local|managed|docker] [--db-url <url>] [--provider <name>] [--api-key <token>] [--projects <path1,path2>] [--claude-code] [--bootstrap-db]', 'Guided setup for runtime, database, instance, keys, and project binding. Run iranti setup --help for the non-interactive flow.'],
        ['iranti instance create <name> [--port 3001] [--db-url <url>] [--api-key <token>] [--provider <name>] [--provider-key <token>] [--scope user|system]', 'Create an instance directly if you want low-level control.'],
        ['iranti instance list [--scope user|system]', 'List configured instances.'],
        ['iranti instance show <name> [--scope user|system]', 'Show one instance env, port, database target, and runtime state.'],
        ['iranti instance restart <name> [--scope user|system] [--graceful-timeout <seconds>]', 'Restart a running instance using its runtime metadata.'],
        ['iranti run --instance <name> [--scope user|system]', 'Start an instance and write runtime metadata.'],
    ]);

    printRows('Configuration', [
        ['iranti configure instance <name> [--interactive] [--db-url <url>] [--port <n>] [--api-key <token>] [--provider <name>] [--provider-key <token>] [--clear-provider-key] [--json]', 'Update an instance without editing env files manually.'],
        ['iranti project init [path] --instance <name> [--api-key <token>] [--agent-id <id>] [--mode isolated|shared] [--force]', 'Create a new .env.iranti binding for one project.'],
        ['iranti configure project [path] [--interactive] [--instance <name>] [--url <http://host:port>] [--api-key <token>] [--agent-id <id>] [--memory-entity <entity>] [--mode isolated|shared] [--json]', 'Refresh or retarget an existing project binding.'],
    ]);

    printRows('Keys', [
        ['iranti auth create-key --instance <name> --key-id <id> --owner <owner> [--scopes kb:read,kb:write:project/*] [--description <text>] [--write-instance] [--project <path>] [--agent-id <id>] [--json]', 'Create or rotate an Iranti client key.'],
        ['iranti auth list-keys --instance <name> [--json]', 'List registry-backed Iranti client keys.'],
        ['iranti auth revoke-key --instance <name> --key-id <id> [--json]', 'Revoke an Iranti client key.'],
        ['iranti list api-keys [--instance <name>] [--project <path>] [--json]', 'Show stored upstream provider keys.'],
        ['iranti add api-key [provider] [--instance <name>] [--project <path>] [--key <token>] [--set-default] [--json]', 'Store a provider key and optionally make it the default.'],
        ['iranti update api-key [provider] [--instance <name>] [--project <path>] [--key <token>] [--set-default] [--json]', 'Replace a stored provider key.'],
        ['iranti remove api-key [provider] [--instance <name>] [--project <path>] [--json]', 'Remove a stored provider key.'],
    ]);

    printRows('Diagnostics And Operator Tools', [
        ['iranti version', 'Print the installed CLI version and exit.'],
        ['iranti doctor [--instance <name>] [--scope user|system] [--env <file>] [--json] [--debug]', 'Run environment and runtime diagnostics.'],
        ['iranti status [--scope user|system] [--json]', 'Show runtime roots, bindings, and known instances.'],
        ['iranti upgrade [--check] [--dry-run] [--yes] [--all] [--target auto|npm-global|npm-repo|python[,python]] [--json]', 'Check or run CLI/runtime/package upgrades.'],
        ['iranti uninstall [--dry-run] [--yes] [--all] [--keep-data] [--keep-project-bindings] [--scan-root <dir[,dir2]>] [--json]', 'Remove Iranti packages and, with --all, runtime data and project integrations.'],
        ['iranti handshake [--instance <name> | --project-env <file>] [--agent <id>] [--task <text>] [--recent <msg1||msg2>] [--recent-file <path>] [--json]', 'Manually inspect Attendant handshake output.'],
        ['iranti attend [message] [--instance <name> | --project-env <file>] [--agent <id>] [--context <text> | --context-file <path>] [--entity-hint <entity>] [--force] [--max-facts <n>] [--json]', 'Manually inspect turn-level memory injection decisions.'],
        ['iranti handoff task/<task_id> [--instance <name> | --project-env <file>] [--agent <id>] --next-step <text> [--status <state>] [--owner <agent-id>] [--blockers <a||b>] [--artifacts <path1||path2>] [--project-entity <entity>] [--notes <text>] [--source <label>] [--confidence <n>] [--json]', 'Write a standardized shared-memory handoff for Claude/Codex collaboration.'],
        ['iranti chat [--agent <agent-id>] [--provider <provider>] [--model <model>]', 'Open the local interactive chat shell.'],
        ['iranti resolve [--dir <escalation-dir>]', 'Walk through pending escalation files.'],
    ]);

    printRows('Integrations', [
        ['iranti mcp [--help]', 'Start the stdio MCP server.'],
        ['iranti claude-setup [path] [--project-env <path>] [--force]', 'Scaffold Claude Code files for one project.'],
        ['iranti claude-setup --scan <dir> [--recursive] [--force]', 'Find Claude-enabled projects and scaffold them in batch.'],
        ['iranti claude-hook --event SessionStart|UserPromptSubmit [--project-env <path>] [--instance-env <path>] [--env-file <path>]', 'Run the Claude Code hook helper directly.'],
        ['iranti codex-setup [--name iranti] [--agent codex_code] [--source Codex] [--provider openai] [--project-env <path>] [--local-script]', 'Register Iranti with the Codex CLI.'],
        ['iranti integrate claude [path] [--project-env <path>] [--force]', 'Alias for Claude setup.'],
        ['iranti integrate claude --scan <dir> [--recursive] [--force]', 'Alias for batch Claude setup.'],
        ['iranti integrate codex [--name iranti] [--agent codex_code] [--source Codex] [--provider openai] [--project-env <path>] [--local-script]', 'Alias for Codex setup.'],
    ]);

    console.log(sectionTitle('Common Flows'));
    console.log(`  ${commandText('First install')}`);
    console.log(`    ${commandText('iranti setup')}`);
    console.log(`    ${commandText('iranti run --instance local')}`);
    console.log(`    ${commandText('iranti doctor --instance local')}`);
    console.log('');
    console.log(`  ${commandText('Bind a project')}`);
    console.log(`    ${commandText('iranti project init . --instance local')}`);
    console.log(`    ${commandText('iranti claude-setup .')}`);
    console.log('');
    console.log(`  ${commandText('Work with keys')}`);
    console.log(`    ${commandText('iranti auth create-key --instance local --key-id app_main --owner \"App Main\" --scopes \"kb:read,kb:write,memory:read,memory:write\"')}`);
    console.log(`    ${commandText('iranti add api-key openai --instance local --set-default')}`);
}

function printSetupHelp(): void {
    console.log(sectionTitle('Setup Command'));
    console.log(`  ${commandText('iranti setup [--scope user|system] [--root <path>] [--mode isolated|shared] [--instance <name>] [--port <n>] [--config <file> | --defaults] [--db-mode local|managed|docker] [--db-url <url>] [--provider <name>] [--api-key <token>] [--projects <path1,path2>] [--claude-code] [--bootstrap-db]')}`);
    console.log('');
    console.log('  Interactive mode walks through runtime, database, provider keys, API keys, and project binding.');
    console.log('  Use `--defaults` to build a plan from flags and environment variables without prompts.');
    console.log('  Use `--config <file>` to execute a saved setup plan.');
    console.log('  `--projects` and `--claude-code` apply to the non-interactive defaults flow.');
}

function printUninstallHelp(): void {
    console.log(sectionTitle('Uninstall Command'));
    console.log(`  ${commandText('iranti uninstall [--scope user|system] [--root <path>] [--dry-run] [--yes] [--all] [--keep-data] [--keep-project-bindings] [--scan-root <dir[,dir2]>] [--json]')}`);
    console.log('');
    console.log('  Default mode removes installed packages and stops live Iranti processes, but keeps runtime data and project bindings.');
    console.log('  Add `--all` to also remove discovered runtime roots, `.env.iranti`, `.mcp.json` Iranti entries, and Claude hook settings.');
    console.log('  Use `--scan-root` to control where project bindings and isolated runtime roots are discovered.');
}

function printInstanceHelp(): void {
    console.log(sectionTitle('Instance Commands'));
    console.log(`  ${commandText('iranti instance create <name> [--port 3001] [--db-url <url>] [--api-key <token>] [--provider <name>] [--provider-key <token>] [--scope user|system] [--root <path>]')}`);
    console.log(`  ${commandText('iranti instance list [--scope user|system] [--root <path>]')}`);
    console.log(`  ${commandText('iranti instance show <name> [--scope user|system] [--root <path>]')}`);
    console.log(`  ${commandText('iranti instance restart <name> [--scope user|system] [--root <path>] [--graceful-timeout <seconds>]')}`);
}

function printConfigureHelp(): void {
    console.log(sectionTitle('Configure Commands'));
    console.log(`  ${commandText('iranti configure instance <name> [--interactive] [--db-url <url>] [--port <n>] [--api-key <token>] [--provider <name>] [--provider-key <token>] [--clear-provider-key] [--scope user|system] [--root <path>] [--json]')}`);
    console.log(`  ${commandText('iranti configure project [path] [--interactive] [--instance <name>] [--url <http://host:port>] [--api-key <token>] [--agent-id <id>] [--memory-entity <entity>] [--mode isolated|shared] [--scope user|system] [--root <path>] [--json]')}`);
}

function printAuthHelp(): void {
    console.log(sectionTitle('Auth Commands'));
    console.log(`  ${commandText('iranti auth create-key --instance <name> --key-id <id> --owner <owner> [--scopes ...] [--description <text>] [--write-instance] [--project <path>] [--agent-id <id>] [--scope user|system] [--root <path>] [--json]')}`);
    console.log(`  ${commandText('iranti auth list-keys --instance <name> [--scope user|system] [--root <path>] [--json]')}`);
    console.log(`  ${commandText('iranti auth revoke-key --instance <name> --key-id <id> [--scope user|system] [--root <path>] [--json]')}`);
}

function printIntegrateHelp(): void {
    console.log(sectionTitle('Integrations'));
    console.log(`  ${commandText('iranti integrate claude [path] [--project-env <path>] [--force]')}`);
    console.log(`  ${commandText('iranti integrate claude --scan <dir> [--recursive] [--force]')}`);
    console.log(`  ${commandText('iranti integrate codex [--name iranti] [--agent codex_code] [--source Codex] [--provider openai] [--project-env <path>] [--local-script]')}`);
}

function printProviderKeyHelp(): void {
    console.log(sectionTitle('Provider Key Commands'));
    console.log(`  ${commandText('iranti list api-keys [--instance <name>] [--project <path>] [--json]')}`);
    console.log(`  ${commandText('iranti add api-key [provider] [--instance <name>] [--project <path>] [--key <token>] [--set-default] [--json]')}`);
    console.log(`  ${commandText('iranti update api-key [provider] [--instance <name>] [--project <path>] [--key <token>] [--set-default] [--json]')}`);
    console.log(`  ${commandText('iranti remove api-key [provider] [--instance <name>] [--project <path>] [--json]')}`);
    console.log('');
    console.log('  Target either an instance env or a project binding. If neither is supplied, the CLI will try the current project first.');
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    setCliDebugFlags(args);
    debugLog('CLI invocation started.', {
        command: args.command,
        subcommand: args.subcommand,
        cwd: process.cwd(),
    });
    if (args.command === '--version' || args.command === 'version' || hasFlag(args, 'version')) {
        console.log(getPackageVersion());
        return;
    }

    if (!args.command || args.command === 'help' || args.command === '--help') {
        printHelp();
        return;
    }

    if (args.command === 'install') {
        await installCommand(args);
        return;
    }

    if (args.command === 'setup') {
        if (hasFlag(args, 'help')) {
            printSetupHelp();
            return;
        }
        await setupCommand(args);
        return;
    }

    if (args.command === 'instance') {
        if (!args.subcommand || args.subcommand === 'help' || args.subcommand === '--help') {
            printInstanceHelp();
            return;
        }
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
        if (args.subcommand === 'restart') {
            await restartInstanceCommand(args);
            return;
        }
        throw new Error(`Unknown instance subcommand '${args.subcommand ?? ''}'.`);
    }

    if (args.command === 'run') {
        await runInstanceCommand(args);
        return;
    }

    if (args.command === 'configure') {
        if (!args.subcommand || args.subcommand === 'help' || args.subcommand === '--help') {
            printConfigureHelp();
            return;
        }
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
        if (!args.subcommand || args.subcommand === 'help' || args.subcommand === '--help') {
            printAuthHelp();
            return;
        }
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
        if (hasFlag(args, 'help')) {
            printProviderKeyHelp();
            return;
        }
        await listProviderKeysCommand(args);
        return;
    }

    if (args.command === 'add' && args.subcommand === 'api-key') {
        if (hasFlag(args, 'help')) {
            printProviderKeyHelp();
            return;
        }
        await upsertProviderKeyCommand(args, 'add');
        return;
    }

    if (args.command === 'update' && args.subcommand === 'api-key') {
        if (hasFlag(args, 'help')) {
            printProviderKeyHelp();
            return;
        }
        await upsertProviderKeyCommand(args, 'update');
        return;
    }

    if (args.command === 'remove' && args.subcommand === 'api-key') {
        if (hasFlag(args, 'help')) {
            printProviderKeyHelp();
            return;
        }
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

    if (args.command === 'uninstall') {
        if (hasFlag(args, 'help')) {
            printUninstallHelp();
            return;
        }
        await uninstallCommand(args);
        return;
    }

    if (args.command === 'handshake') {
        await handshakeCommand(args);
        return;
    }

    if (args.command === 'attend') {
        await attendCommand(args);
        return;
    }

    if (args.command === 'handoff') {
        await handoffCommand(args);
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

    if (args.command === 'claude-setup') {
        await claudeSetupCommand(args);
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

    if (args.command === 'integrate') {
        if (!args.subcommand || args.subcommand === 'help' || args.subcommand === '--help') {
            printIntegrateHelp();
            return;
        }
        if (args.subcommand === 'claude') {
            await claudeSetupCommand(args);
            return;
        }
        if (args.subcommand === 'codex') {
            await handoffToScript('codex-setup', process.argv.slice(4));
            return;
        }
        throw new Error(`Unknown integrate target '${args.subcommand ?? ''}'. Use 'claude' or 'codex'.`);
    }

    throw cliError(
        'IRANTI_UNKNOWN_COMMAND',
        `Unknown command '${args.command}'. Run: iranti help`,
        ['Use `iranti help` to see the current command surface.'],
        { command: args.command }
    );
}

main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof CliError ? err.code : null;
    console.error(`${failLabel('ERROR')}${code ? ` [${code}]` : ''} ${message}`);
    if (err instanceof CliError && err.hints.length > 0) {
        console.error('');
        console.error('Possible fixes:');
        for (const hint of err.hints) {
            console.error(`  - ${hint}`);
        }
    }
    if (CLI_DEBUG && err instanceof CliError && err.details && Object.keys(err.details).length > 0) {
        console.error('');
        console.error(`${paint('[DEBUG]', 'gray')} ${JSON.stringify(err.details, null, 2)}`);
    }
    if (CLI_DEBUG && err instanceof Error && err.stack) {
        console.error('');
        console.error(err.stack);
    }
    process.exit(1);
});
