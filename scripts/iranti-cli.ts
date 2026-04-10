#!/usr/bin/env node
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import https from 'https';
import readline from 'readline/promises';
import { Writable } from 'stream';
import net from 'net';
import { randomBytes } from 'crypto';
import { disconnectDb, initDb } from '../src/library/client';
import { createOrRotateApiKey, formatApiKeyToken, generateApiKeySecret, listApiKeys, revokeApiKey } from '../src/security/apiKeys';
import {
    printAuthHelp as renderAuthHelp,
    printAuthCreateKeyHelp as renderAuthCreateKeyHelp,
    printAuthListKeysHelp as renderAuthListKeysHelp,
    printAuthRevokeKeyHelp as renderAuthRevokeKeyHelp,
    printAttendHelp as renderAttendHelp,
    printChatHelp as renderChatHelp,
    printChoiceGuide as renderChoiceGuide,
    printConfigureHelp as renderConfigureHelp,
    printConfigureInstanceHelp as renderConfigureInstanceHelp,
    printConfigureProjectHelp as renderConfigureProjectHelp,
    printDoctorHelp as renderDoctorHelp,
    printHandshakeHelp as renderHandshakeHelp,
    printHandoffHelp as renderHandoffHelp,
    printInstallHelp as renderInstallHelp,
    printInstanceHelp as renderInstanceHelp,
    printIssuesHelp as renderIssuesHelp,
    printIntegrateHelp as renderIntegrateHelp,
    printMainHelp as renderMainHelp,
    printProjectInitHelp as renderProjectInitHelp,
    printProjectUnbindHelp as renderProjectUnbindHelp,
    printProviderKeyHelp as renderProviderKeyHelp,
    printResolveHelp as renderResolveHelp,
    printRunHelp as renderRunHelp,
    printSetupHelp as renderSetupHelp,
    printStatusHelp as renderStatusHelp,
    printUninstallHelp as renderUninstallHelp,
    printUpgradeHelp as renderUpgradeHelp,
    printWizardNotes as renderWizardNotes,
} from '../src/lib/cliHelpRenderer';
import { getEscalationPaths } from '../src/lib/escalationPaths';
import { parseDockerContainerNames, parsePublishedDockerHostPorts } from '../src/lib/dockerCliParsing';
import { rewriteCommandError, type RewrittenCommandError } from '../src/lib/commandErrors';
import { resolveCommandInvocation, spawnResolved, spawnSyncResolved } from '../src/lib/commandInvocation';
import { loadRuntimeEnv } from '../src/lib/runtimeEnv';
import { ensureFileContainsLinesLocked, writeTextFileLocked } from '../src/lib/fileMutation';
import { describeInstanceDependency, ensureInstanceDependenciesHealthy, InstanceDependency, parseInstanceDependencies } from '../src/lib/runtimeDependencies';
import { createFirstPartyIranti } from '../src/lib/createFirstPartyIranti';
import { resolveInteractive } from '../src/resolutionist';
import { startChatSession } from '../src/chat';
import { createVectorBackend, resolveVectorBackendName } from '../src/library/backends';
import { InstanceRuntimeState, RuntimeInspection, inspectRuntimeState, isPidRunning, resolveRuntimeAuthorityFromEnv, waitForPidExit } from '../src/lib/runtimeLifecycle';
import type { Iranti } from '../src/sdk';
import { auditVectorIndexConsistency, findEntriesByEntityType, deleteEntryById, findEntriesBySourceAndWindow, deleteEntriesBySourceAndWindow } from '../src/library/queries';
import { backfillChatHistory, parseBackfillChatTranscript } from '../src/lib/autoRemember';
import { buildSemanticFactTags } from '../src/lib/semanticFactTags';
import { flushStaffEventEmitter } from '../src/lib/staffEventRegistry';
import { writeProjectScaffoldCloseout, type ScaffoldCloseoutStatus } from '../src/lib/scaffoldCloseout';
import { deriveProjectCodebaseEntity, writeProjectLearningSnapshot, type ProjectLearningStatus } from '../src/lib/projectLearning';

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

type DatabaseIntentStrategy = 'dedicated-local' | 'shared-local' | 'external-existing';

type InstanceDatabaseIntent = {
    strategy: DatabaseIntentStrategy;
    provisioning: DatabaseSetupMode;
    host: string;
    port?: number;
    database: string;
    dockerContainerName?: string;
};

type InstanceMeta = {
    name: string;
    createdAt: string;
    port: number;
    envFile: string;
    instanceDir: string;
    databaseIntent?: InstanceDatabaseIntent;
    dependencies?: InstanceDependency[];
};

type InstanceProjectBindingSummary = {
    projectPath: string;
    agentId: string;
    memoryEntity: string;
    mode: string;
    boundAt: string | null;
};

type InstanceRuntimeSummary = RuntimeInspection;

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

type OperatorAuthoritySummary = {
    activeAuthority: string;
    activeBindingSource: string | null;
    activeBoundInstanceEnv: string | null;
    activeDatabaseUrl: string | null;
    activeDatabaseTarget: string | null;
    repoDatabaseUrl: string | null;
    repoDatabaseTarget: string | null;
    repoDatabaseDiffers: boolean;
    nearbyBindingSource: string | null;
    nearbyBoundInstanceEnv: string | null;
    nearbyBindingDatabaseUrl: string | null;
    nearbyBindingDatabaseTarget: string | null;
    nearbyBindingDiffers: boolean;
};

type DoctorDiscovery = {
    selectedRuntimeRoot: string | null;
    selectionSource: RuntimeRootSource | null;
    selectionReason: string | null;
    boundRuntimeRoot: string | null;
    boundInstanceEnv: string | null;
    projectBindingFile: string | null;
    projectBindingSource: 'doctor-target' | null;
    rootMismatch: boolean;
    otherRuntimeRoots: string[];
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

type DetachedRestartPlan = {
    instanceName: string;
    scope: Scope;
    root: string;
};

type UninstallProjectArtifact = {
    projectPath: string;
    bindingFile?: string;
    mcpFile?: string;
    claudeSettingsFile?: string;
    agentsFile?: string;
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
    vscodeMcp: ClaudeScaffoldStatus;
    settings: ClaudeScaffoldStatus;
    claudeMd: ClaudeScaffoldStatus;
    irantiMd: ClaudeScaffoldStatus;
    writeGuardHook: ClaudeScaffoldStatus;
    editTrackerHook: ClaudeScaffoldStatus;
    protocolReminderHook: ClaudeScaffoldStatus;
    closeout: ScaffoldCloseoutStatus;
};

type ProcessSnapshotRow = {
    pid: number;
    parentPid: number | null;
    name: string;
    commandLine: string;
};

type McpCleanupCandidateStatus =
    | 'stale_no_host_ancestor'
    | 'stale_shell_no_host'
    | 'stale_child_parent_missing'
    | 'stale_launcher_only'
    | 'attached_claude'
    | 'attached_codex'
    | 'attached_or_uncertain';

type McpCleanupCandidate = {
    status: McpCleanupCandidateStatus;
    launcherPid?: number;
    childPid?: number;
    host?: 'claude' | 'codex';
    reason: string;
};

type McpCleanupReport = {
    platform: string;
    supported: boolean;
    dryRun: boolean;
    counts: Record<McpCleanupCandidateStatus, number>;
    safeCandidates: McpCleanupCandidate[];
    skippedCandidates: McpCleanupCandidate[];
    cleaned: Array<{ pid: number; role: 'launcher' | 'child' }>;
    warnings: string[];
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
let ACTIVE_PARSED_ARGS: ParsedArgs | null = null;

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

function wantsJsonErrorEnvelope(args: ParsedArgs | null): boolean {
    return Boolean(args && hasFlag(args, 'json'));
}

function normalizeCliFailure(err: unknown): CliError | RewrittenCommandError {
    if (err instanceof CliError) {
        return err;
    }
    return rewriteCommandError('iranti', err);
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

function stripWrappingQuotes(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' || first === "'") && last === first) {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}

function hasFlag(args: ParsedArgs, key: string): boolean {
    return Boolean(args.flags.get(key));
}

function parseBooleanInput(raw: string, label: string): boolean {
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    throw new Error(`${label} must be true/false, yes/no, on/off, or 1/0.`);
}

function resolveOptionalBooleanFlag(args: ParsedArgs, key: string): boolean | undefined {
    const value = args.flags.get(key);
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return true;
    return parseBooleanInput(value, `--${key}`);
}

function parseOptionalBooleanValue(value: unknown, label: string): boolean | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return parseBooleanInput(value, label);
    throw new Error(`${label} must be a boolean or boolean-like string.`);
}

function envFlagEnabled(raw: string | undefined): boolean {
    if (!raw?.trim()) return false;
    return parseBooleanInput(raw, 'environment value');
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

function findClosestDoctorEnvTarget(startDir: string): DoctorEnvTarget {
    for (const dir of walkAncestorPaths(startDir)) {
        const repoEnv = path.join(dir, '.env');
        if (fs.existsSync(repoEnv) && fs.statSync(repoEnv).isFile()) {
            return {
                envFile: repoEnv,
                envSource: 'repo',
            };
        }
        const projectEnv = path.join(dir, '.env.iranti');
        if (fs.existsSync(projectEnv) && fs.statSync(projectEnv).isFile()) {
            return {
                envFile: projectEnv,
                envSource: 'project-binding',
            };
        }
    }
    return { envFile: null, envSource: 'repo' };
}

function resolveInstallRootDetails(args: ParsedArgs, scope: Scope): RuntimeRootResolution {
    const explicitFlag = getFlag(args, 'root');
    const explicit = explicitFlag ? stripWrappingQuotes(explicitFlag) : (process.env.IRANTI_HOME ? stripWrappingQuotes(process.env.IRANTI_HOME) : undefined);
    if (explicit) {
        return {
            root: path.resolve(explicit),
            source: explicitFlag ? 'flag' : 'env',
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

function getTypescriptClientVersion(): string {
    const fallback = getPackageVersion();
    const packageJsonPath = path.join(packageRoot(), 'clients', 'typescript', 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        return fallback;
    }
    try {
        const raw = fs.readFileSync(packageJsonPath, 'utf-8');
        const pkg = JSON.parse(raw) as { version?: string };
        return String(pkg.version ?? fallback);
    } catch {
        return fallback;
    }
}

function getPythonClientVersion(): string {
    const fallback = getPackageVersion();
    const pyprojectPath = path.join(packageRoot(), 'clients', 'python', 'pyproject.toml');
    if (!fs.existsSync(pyprojectPath)) {
        return fallback;
    }
    try {
        const raw = fs.readFileSync(pyprojectPath, 'utf-8');
        const match = raw.match(/^\s*version\s*=\s*"([^"]+)"/m);
        return match?.[1] ?? fallback;
    } catch {
        return fallback;
    }
}

function printVersion(): void {
    const irantiVersion = getPackageVersion();
    if (!process.stdout.isTTY) {
        console.log(irantiVersion);
        return;
    }

    console.log(sectionTitle('Iranti Versions'));
    console.log(`  iranti cli            ${irantiVersion}`);
    console.log(`  node package          ${getTypescriptClientVersion()} (@iranti/sdk)`);
    console.log(`  python package        ${getPythonClientVersion()} (iranti)`);
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
    const shouldProxyStdin = !process.stdin.isTTY;

    const wireChildStdin = (child: import('child_process').ChildProcess): (() => void) => {
        if (!shouldProxyStdin || !child.stdin) {
            return () => {};
        }

        const forwardChunk = (chunk: Buffer | string) => {
            if (!child.stdin || child.stdin.destroyed) return;
            child.stdin.write(chunk);
        };
        const endChildStdin = () => {
            if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
            child.stdin.end();
        };
        const destroyChildStdin = () => {
            if (!child.stdin || child.stdin.destroyed) return;
            child.stdin.destroy();
        };

        process.stdin.on('data', forwardChunk);
        process.stdin.once('end', endChildStdin);
        process.stdin.once('close', endChildStdin);
        process.stdin.once('error', destroyChildStdin);
        process.stdin.resume();

        return () => {
            process.stdin.off('data', forwardChunk);
            process.stdin.off('end', endChildStdin);
            process.stdin.off('close', endChildStdin);
            process.stdin.off('error', destroyChildStdin);
        };
    };

    if (fs.existsSync(builtPath)) {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, [builtPath, ...rawArgs], {
                stdio: shouldProxyStdin ? ['pipe', 'inherit', 'inherit'] : 'inherit',
                env: process.env,
            });
            const cleanupStdinProxy = wireChildStdin(child);
            child.on('error', reject);
            child.on('exit', (code, signal) => {
                cleanupStdinProxy();
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

    try {
        await new Promise<void>((resolve, reject) => {
            const invocation = resolveCommandInvocation('npx', ['ts-node', sourcePath, ...rawArgs]);
            const child = spawn(invocation.executable, invocation.args, {
                stdio: shouldProxyStdin ? ['pipe', 'inherit', 'inherit'] : 'inherit',
                env: process.env,
                shell: false,
            });
            const cleanupStdinProxy = wireChildStdin(child);
            child.on('error', (error) => {
                cleanupStdinProxy();
                reject(error);
            });
            child.on('exit', (code, signal) => {
                cleanupStdinProxy();
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
    } catch (error) {
        if (error instanceof Error && /exited with code/.test(error.message)) {
            const match = error.message.match(/code (\d+)/);
            process.exit(match ? Number.parseInt(match[1]!, 10) : 1);
        }
        throw error;
    }
}

async function runBundledScript(scriptName: string, rawArgs: string[], extraEnv?: Record<string, string | undefined>): Promise<void> {
    const builtPath = builtScriptPath(scriptName);
    if (!fs.existsSync(builtPath)) {
        const sourcePath = path.resolve(process.cwd(), 'scripts', `${scriptName}.ts`);
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Unable to locate bundled script: ${scriptName}`);
        }
        await spawnResolved('npx', ['ts-node', sourcePath, ...rawArgs], {
            stdio: 'inherit',
            env: {
                ...process.env,
                ...extraEnv,
            },
            cwd: packageRoot(),
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
    await writeTextFileLocked(filePath, () => `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath: string, content: string): Promise<void> {
    await writeTextFileLocked(filePath, () => content);
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

async function readEnvFileIfExists(filePath: string | null | undefined): Promise<Record<string, string> | null> {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        return await readEnvFile(filePath);
    } catch {
        return null;
    }
}

async function readInstanceMetaFile(metaFile: string): Promise<Partial<InstanceMeta> | null> {
    if (!fs.existsSync(metaFile)) return null;
    try {
        const raw = await fsp.readFile(metaFile, 'utf8');
        return JSON.parse(raw) as Partial<InstanceMeta>;
    } catch {
        return null;
    }
}

function resolveInstanceApiKeyPepper(existingPepper?: string): string {
    const trimmed = existingPepper?.trim() ?? '';
    return trimmed || randomBytes(32).toString('hex');
}

function makeInstanceEnv(
    name: string,
    port: number,
    dbUrl: string,
    apiKey: string | undefined,
    instanceDir: string,
    apiKeyPepper: string,
): string {
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
        `IRANTI_API_KEY_PEPPER=${apiKeyPepper}`,
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
    await writeTextFileLocked(filePath, (existingRaw) => {
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
            .replace(/^\n+/, '')
            .trimEnd();

        return `${finalLines}\n`;
    });
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

function instanceRepairNextSteps(name: string): string[] {
    return [
        `Run \`iranti configure instance ${name} --interactive\` to repair the instance files.`,
        'Run `iranti status --json` to inspect the current config classification.',
    ];
}

async function loadInstanceEnv(
    root: string,
    name: string,
    options: { allowRepair?: boolean } = {},
): Promise<{
    instanceDir: string;
    envFile: string;
    metaFile: string;
    runtimeFile: string;
    env: Record<string, string>;
    config: InstanceConfigSummary;
}> {
    const paths = instancePaths(root, name);
    const config = await inspectInstanceConfig(root, name);
    if (!config.state.metaPresent && !config.state.envPresent) {
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
    if (!options.allowRepair && config.classification !== 'complete') {
        throw cliError(
            config.classification === 'partial' ? 'IRANTI_INSTANCE_INCOMPLETE' : 'IRANTI_INSTANCE_INVALID',
            `Instance '${name}' is ${config.classification}: ${config.detail}.`,
            instanceRepairNextSteps(name),
            {
                instance: name,
                root,
                instanceDir: paths.instanceDir,
                config: config.classification,
                metaFile: paths.metaFile,
                envFile: paths.envFile,
            }
        );
    }
    let env: Record<string, string> = {};
    if (config.state.envPresent && config.state.envReadable) {
        env = await readEnvFile(paths.envFile);
    } else if (!options.allowRepair) {
        throw cliError(
            'IRANTI_INSTANCE_ENV_UNREADABLE',
            `Instance '${name}' env file is missing or unreadable: ${paths.envFile}`,
            instanceRepairNextSteps(name),
            { instance: name, root, envFile: paths.envFile, config: config.classification }
        );
    }
    debugLog('Loaded instance env target.', { instance: name, envFile: paths.envFile });
    return {
        ...paths,
        env,
        config,
    };
}

async function inspectInstanceConfig(root: string, name: string): Promise<InstanceConfigSummary> {
    const { instanceDir, envFile, metaFile } = instancePaths(root, name);
    const metaPresent = fs.existsSync(metaFile);
    const envPresent = fs.existsSync(envFile);

    let metaReadable = false;
    let envReadable = false;
    const ownershipIssues: string[] = [];
    let rewrittenMeta = false;

    if (metaPresent) {
        try {
            const raw = await fsp.readFile(metaFile, 'utf8');
            const parsed = JSON.parse(raw) as Partial<InstanceMeta>;
            metaReadable = typeof parsed.name === 'string' && parsed.name.trim().length > 0;
            if (metaReadable) {
                const shouldRewriteOwnership =
                    parsed.name?.trim() === name
                    && (
                        (typeof parsed.instanceDir === 'string' && path.resolve(parsed.instanceDir) !== path.resolve(instanceDir))
                        || (typeof parsed.envFile === 'string' && path.resolve(parsed.envFile) !== path.resolve(envFile))
                    );
                if (shouldRewriteOwnership) {
                    const nextMeta = {
                        ...parsed,
                        name,
                        instanceDir,
                        envFile,
                    };
                    await writeText(metaFile, `${JSON.stringify(nextMeta, null, 2)}\n`);
                    rewrittenMeta = true;
                    parsed.instanceDir = instanceDir;
                    parsed.envFile = envFile;
                }
                if (parsed.name?.trim() !== name) {
                    ownershipIssues.push(`instance.json name is ${parsed.name}`);
                }
                if (typeof parsed.instanceDir === 'string' && path.resolve(parsed.instanceDir) !== path.resolve(instanceDir)) {
                    ownershipIssues.push(`instance.json points to ${parsed.instanceDir}`);
                }
                if (typeof parsed.envFile === 'string' && path.resolve(parsed.envFile) !== path.resolve(envFile)) {
                    ownershipIssues.push(`instance.json envFile points to ${parsed.envFile}`);
                }
                const databaseIntentValidation = parseInstanceDatabaseIntent(parsed.databaseIntent);
                if (databaseIntentValidation.errors.length > 0) {
                    ownershipIssues.push(`instance.json databaseIntent invalid: ${databaseIntentValidation.errors.join(', ')}`);
                }
                const dependencyValidation = parseInstanceDependencies(parsed.dependencies);
                if (dependencyValidation.errors.length > 0) {
                    ownershipIssues.push(`instance.json dependencies invalid: ${dependencyValidation.errors.join(', ')}`);
                }
            }
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
    if (ownershipIssues.length > 0) {
        classification = 'invalid';
        detail = ownershipIssues.join('; ');
    } else if (metaPresent && envPresent && metaReadable && envReadable) {
        classification = 'complete';
        detail = rewrittenMeta
            ? 'instance metadata was repaired and env is present'
            : 'instance metadata and env are present';
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
    return inspectRuntimeState(runtimeFile);
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

function buildInstanceRepairHints(name: string, config: InstanceConfigSummary, runtime: InstanceRuntimeSummary): string[] {
    const hints: string[] = [];

    if (config.classification === 'partial') {
        hints.push(`Run \`iranti configure instance ${name} --interactive\` to finish the missing instance files.`);
    }
    if (config.classification === 'invalid') {
        hints.push(`Run \`iranti configure instance ${name} --interactive\` to repair invalid instance metadata or env values.`);
    }

    if (runtime.classification === 'stale') {
        hints.push(`Run \`iranti instance restart ${name}\` if this instance should still be running.`);
    }
    if (runtime.classification === 'unhealthy') {
        hints.push(`Run \`iranti doctor --instance ${name}\` and inspect ${runtime.state?.healthUrl ?? `http://localhost:${runtime.state?.port ?? 3001}/health`} before restarting.`);
    }
    if (runtime.classification === 'invalid') {
        hints.push(`Inspect ${runtime.state?.runtimeFile ?? `instances/${name}/runtime.json`} for copied or foreign runtime metadata.`);
    }

    return Array.from(new Set(hints));
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
        await ensureFileContainsLinesLocked(gitignorePath, requiredLines);
    } else {
        await writeText(gitignorePath, `${requiredLines.join('\n')}\n`);
    }
}

async function writeProjectBinding(projectPath: string, updates: Record<string, string | undefined>): Promise<string> {
    await ensureDir(projectPath);
    const outFile = path.join(projectPath, '.env.iranti');
    const previousBinding = fs.existsSync(outFile)
        ? await readEnvFile(outFile).catch(() => ({} as Record<string, string>))
        : {};
    const normalizedUpdates = {
        ...updates,
        IRANTI_CODEBASE_ENTITY: updates.IRANTI_CODEBASE_ENTITY ?? previousBinding.IRANTI_CODEBASE_ENTITY ?? deriveProjectCodebaseEntity(projectPath),
    };
    if (!fs.existsSync(outFile)) {
        await writeText(outFile, '# Iranti project binding\n');
    }
    await upsertEnvFile(outFile, normalizedUpdates);
    await ensureProjectGitignore(projectPath);
    const writtenBinding = await readEnvFile(outFile).catch(() => ({} as Record<string, string>));
    await syncProjectBindingRegistry(projectPath, writtenBinding, previousBinding);
    return outFile;
}

function normalizeProjectRegistryPath(projectPath: string): string {
    const normalized = path.resolve(projectPath);
    return process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized;
}

async function removeProjectPathFromRegistry(runtimeRoot: string, instanceName: string, projectPath: string): Promise<boolean> {
    const registryPath = path.join(runtimeRoot, 'instances', instanceName, 'projects.json');
    if (!fs.existsSync(registryPath)) return false;
    const parsed = readJsonFile<{ projects?: Array<Record<string, unknown>> }>(registryPath);
    if (!parsed || !Array.isArray(parsed.projects)) return false;
    const expectedProjectPath = normalizeProjectRegistryPath(projectPath);
    const nextProjects = parsed.projects.filter((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        return normalizeProjectRegistryPath(String((entry as Record<string, unknown>).projectPath ?? '')) !== expectedProjectPath;
    });
    if (nextProjects.length === parsed.projects.length) return false;
    await writeText(registryPath, `${JSON.stringify({ projects: nextProjects }, null, 2)}\n`);
    return true;
}

async function syncProjectBindingRegistry(
    projectPath: string,
    binding: Record<string, string>,
    previousBinding: Record<string, string> = {},
): Promise<void> {
    const nextRuntimeRoot = runtimeRootFromInstanceEnv(binding.IRANTI_INSTANCE_ENV ?? '');
    const nextInstanceName = binding.IRANTI_INSTANCE?.trim() || null;
    const previousRuntimeRoot = runtimeRootFromInstanceEnv(previousBinding.IRANTI_INSTANCE_ENV ?? '');
    const previousInstanceName = previousBinding.IRANTI_INSTANCE?.trim() || null;

    if (previousRuntimeRoot && previousInstanceName && (
        previousRuntimeRoot !== nextRuntimeRoot
        || previousInstanceName !== nextInstanceName
    )) {
        await removeProjectPathFromRegistry(previousRuntimeRoot, previousInstanceName, projectPath);
    }

    if (!nextRuntimeRoot || !nextInstanceName) return;

    const registryPath = path.join(nextRuntimeRoot, 'instances', nextInstanceName, 'projects.json');
    const existingRegistry = fs.existsSync(registryPath)
        ? readJsonFile<{ projects?: Array<Record<string, unknown>> } | null>(registryPath)
        : null;
    const existingProjects = Array.isArray(existingRegistry?.projects) ? existingRegistry.projects : [];
    const normalizedProjectPath = normalizeProjectRegistryPath(projectPath);
    const previousEntry = existingProjects.find((entry) =>
        entry
        && typeof entry === 'object'
        && normalizeProjectRegistryPath(String(entry.projectPath ?? '')) === normalizedProjectPath
    );
    const boundAt = typeof previousEntry?.boundAt === 'string' && previousEntry.boundAt.trim().length > 0
        ? previousEntry.boundAt
        : new Date().toISOString();

    const nextProjects = existingProjects
        .filter((entry) =>
            !entry
            || typeof entry !== 'object'
            || normalizeProjectRegistryPath(String(entry.projectPath ?? '')) !== normalizedProjectPath
        )
        .concat({
            projectPath,
            agentId: binding.IRANTI_AGENT_ID?.trim() || 'project_main',
            memoryEntity: binding.IRANTI_MEMORY_ENTITY?.trim() || 'user/main',
            mode: binding.IRANTI_PROJECT_MODE?.trim() || 'isolated',
            boundAt,
        })
        .sort((a, b) => String(a.projectPath ?? '').localeCompare(String(b.projectPath ?? '')));

    await writeText(registryPath, `${JSON.stringify({ projects: nextProjects }, null, 2)}\n`);
}

async function cleanupProjectBindingRegistry(projectPath: string, binding: Record<string, string>): Promise<string[]> {
    const removedFrom: string[] = [];
    const runtimeRoot = runtimeRootFromInstanceEnv(binding.IRANTI_INSTANCE_ENV ?? '');
    const instanceName = binding.IRANTI_INSTANCE?.trim() || null;
    if (runtimeRoot && instanceName) {
        if (await removeProjectPathFromRegistry(runtimeRoot, instanceName, projectPath)) {
            removedFrom.push(instanceName);
        }
    }
    return removedFrom;
}

function readInstanceProjectRegistry(root: string, instanceName: string): InstanceProjectBindingSummary[] {
    const registryPath = path.join(root, 'instances', instanceName, 'projects.json');
    if (!fs.existsSync(registryPath)) return [];
    const parsed = readJsonFile<{ projects?: Array<Record<string, unknown>> } | null>(registryPath);
    if (!parsed || !Array.isArray(parsed.projects)) return [];
    return parsed.projects
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.projectPath === 'string' && entry.projectPath.trim().length > 0)
        .map((entry) => ({
            projectPath: String(entry.projectPath),
            agentId: typeof entry.agentId === 'string' && entry.agentId.trim().length > 0 ? entry.agentId : 'project_main',
            memoryEntity: typeof entry.memoryEntity === 'string' && entry.memoryEntity.trim().length > 0 ? entry.memoryEntity : 'user/main',
            mode: typeof entry.mode === 'string' && entry.mode.trim().length > 0 ? entry.mode : 'isolated',
            boundAt: typeof entry.boundAt === 'string' && entry.boundAt.trim().length > 0 ? entry.boundAt : null,
        }))
        .sort((a, b) => a.projectPath.localeCompare(b.projectPath));
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
    autoRemember: boolean;
    codebaseEntity: string;
    learningStatus: ProjectLearningStatus;
};

type ProjectMemoryMode = 'isolated' | 'shared';

type DatabaseSetupMode = 'local' | 'managed' | 'docker';

type SetupProjectPlan = {
    path: string;
    agentId: string;
    memoryEntity: string;
    personalMemoryEntity: string;
    projectMode: ProjectMemoryMode;
    autoRemember: boolean;
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
    databaseIntent: InstanceDatabaseIntent;
    provider: string;
    providerKeys: Record<string, string>;
    apiKey: string;
    projects: SetupProjectPlan[];
    codexAgent?: string;
    codex?: boolean;
    bootstrapDatabase?: boolean;
    dockerContainerName?: string;
    databaseProvisioned?: boolean;
    dependencies?: InstanceDependency[];
};

type SetupExecutionResult = {
    root: string;
    scope: Scope;
    instanceName: string;
    instanceEnvFile: string;
    port: number;
    mode: 'shared' | 'isolated';
    databaseMode: DatabaseSetupMode;
    databaseIntent: InstanceDatabaseIntent;
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

function summarizeDatabaseTarget(databaseUrl: string | null | undefined): string | null {
    const trimmed = databaseUrl?.trim() ?? '';
    if (!trimmed || detectPlaceholder(trimmed)) return null;
    try {
        const parsed = parsePostgresConnectionString(trimmed);
        const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
        if (!database) return parsed.host || trimmed;
        return `${parsed.host}/${database}`;
    } catch {
        return trimmed;
    }
}

function summarizeActiveAuthority(envSource: string, bindingFile: string | null, boundInstanceEnvFile: string | null): string {
    if (bindingFile && boundInstanceEnvFile) return 'project binding -> bound instance env';
    if (bindingFile) return 'project binding';
    if (envSource.startsWith('instance:')) return 'named instance env';
    if (envSource === 'explicit-env') return 'explicit env';
    if (envSource === 'repo') return 'repo env';
    if (envSource === 'environment') return 'environment';
    return envSource;
}

async function buildOperatorAuthoritySummary(options: {
    envSource: string;
    envFile: string | null;
    env: Record<string, string> | null;
    bindingFile?: string | null;
    boundInstanceEnvFile?: string | null;
    boundInstanceEnv?: Record<string, string> | null;
    repoEnvFile?: string | null;
    nearbyBindingFile?: string | null;
    nearbyBoundInstanceEnvFile?: string | null;
    nearbyBoundInstanceEnv?: Record<string, string> | null;
}): Promise<OperatorAuthoritySummary> {
    const repoEnv = await readEnvFileIfExists(options.repoEnvFile ?? null);
    const boundDatabaseUrl = options.boundInstanceEnv?.DATABASE_URL?.trim() || null;
    const nearbyBoundDatabaseUrl = options.nearbyBoundInstanceEnv?.DATABASE_URL?.trim() || null;
    const selectedDatabaseUrl = options.env?.DATABASE_URL?.trim() || null;
    const activeDatabaseUrl = boundDatabaseUrl || selectedDatabaseUrl;
    const repoDatabaseUrl = repoEnv?.DATABASE_URL?.trim() || null;

    return {
        activeAuthority: summarizeActiveAuthority(
            options.envSource,
            options.bindingFile ?? null,
            options.boundInstanceEnvFile ?? null,
        ),
        activeBindingSource: options.bindingFile ?? null,
        activeBoundInstanceEnv: options.boundInstanceEnvFile ?? null,
        activeDatabaseUrl,
        activeDatabaseTarget: summarizeDatabaseTarget(activeDatabaseUrl),
        repoDatabaseUrl,
        repoDatabaseTarget: summarizeDatabaseTarget(repoDatabaseUrl),
        repoDatabaseDiffers: Boolean(repoDatabaseUrl && activeDatabaseUrl && repoDatabaseUrl !== activeDatabaseUrl),
        nearbyBindingSource: options.nearbyBindingFile ?? null,
        nearbyBoundInstanceEnv: options.nearbyBoundInstanceEnvFile ?? null,
        nearbyBindingDatabaseUrl: nearbyBoundDatabaseUrl,
        nearbyBindingDatabaseTarget: summarizeDatabaseTarget(nearbyBoundDatabaseUrl),
        nearbyBindingDiffers: Boolean(nearbyBoundDatabaseUrl && activeDatabaseUrl && nearbyBoundDatabaseUrl !== activeDatabaseUrl),
    };
}

function isLocalPostgresHost(hostname: string): boolean {
    const normalized = hostname.trim().toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function parseDatabaseIntentStrategy(raw: string | undefined | null): DatabaseIntentStrategy | null {
    const normalized = raw?.trim().toLowerCase() ?? '';
    if (!normalized) return null;
    if (normalized === 'dedicated' || normalized === 'dedicated-local') return 'dedicated-local';
    if (normalized === 'shared' || normalized === 'shared-local') return 'shared-local';
    if (normalized === 'external' || normalized === 'managed' || normalized === 'external-existing') return 'external-existing';
    return null;
}

function parseDatabaseIntentStrategyFlag(raw: string | undefined | null, label: string): DatabaseIntentStrategy | null {
    const trimmed = raw?.trim() ?? '';
    if (!trimmed) return null;
    const parsed = parseDatabaseIntentStrategy(trimmed);
    if (!parsed) {
        throw new Error(`Invalid ${label} '${raw}'. Use dedicated, shared, or external.`);
    }
    return parsed;
}

function databaseIntentPromptValue(strategy: DatabaseIntentStrategy | undefined): string {
    if (strategy === 'dedicated-local') return 'dedicated';
    if (strategy === 'shared-local') return 'shared';
    return 'external';
}

function describeDatabaseIntentStrategy(strategy: DatabaseIntentStrategy): string {
    switch (strategy) {
        case 'dedicated-local':
            return 'dedicated local database';
        case 'shared-local':
            return 'shared local database';
        case 'external-existing':
        default:
            return 'external existing database';
    }
}

function inferDatabaseProvisioning(
    databaseUrl: string,
    dependencies: InstanceDependency[] = [],
): DatabaseSetupMode {
    if (dependencies.some((dependency) => dependency.kind === 'docker-container')) {
        return 'docker';
    }
    const parsed = parsePostgresConnectionString(databaseUrl);
    return isLocalPostgresHost(parsed.hostname) ? 'local' : 'managed';
}

function inferDatabaseIntentStrategy(options: {
    instanceName: string;
    databaseMode: DatabaseSetupMode;
    databaseUrl: string;
}): DatabaseIntentStrategy {
    const databaseName = postgresDatabaseName(options.databaseUrl);
    if (options.databaseMode === 'managed') {
        return 'external-existing';
    }
    return databaseName === `iranti_${options.instanceName}`
        ? 'dedicated-local'
        : 'shared-local';
}

function buildInstanceDatabaseIntent(options: {
    instanceName: string;
    databaseMode: DatabaseSetupMode;
    databaseUrl: string;
    strategy?: DatabaseIntentStrategy | null;
    dockerContainerName?: string;
}): InstanceDatabaseIntent {
    const parsed = parsePostgresConnectionString(options.databaseUrl);
    const strategy = options.strategy ?? inferDatabaseIntentStrategy({
        instanceName: options.instanceName,
        databaseMode: options.databaseMode,
        databaseUrl: options.databaseUrl,
    });
    const port = Number.parseInt(parsed.port || '5432', 10);
    return {
        strategy,
        provisioning: options.databaseMode,
        host: parsed.hostname,
        ...(Number.isFinite(port) && port > 0 ? { port } : {}),
        database: postgresDatabaseName(options.databaseUrl),
        ...(options.dockerContainerName ? { dockerContainerName: options.dockerContainerName } : {}),
    };
}

function parseInstanceDatabaseIntent(raw: unknown): { intent: InstanceDatabaseIntent | null; errors: string[] } {
    if (raw === undefined || raw === null) {
        return { intent: null, errors: [] };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { intent: null, errors: ['databaseIntent must be an object'] };
    }

    const record = raw as Record<string, unknown>;
    const strategy = parseDatabaseIntentStrategy(typeof record.strategy === 'string' ? record.strategy : undefined);
    const provisioningRaw = typeof record.provisioning === 'string' ? record.provisioning.trim().toLowerCase() : '';
    const provisioning = provisioningRaw === 'local' || provisioningRaw === 'managed' || provisioningRaw === 'docker'
        ? provisioningRaw
        : null;
    const host = typeof record.host === 'string' ? record.host.trim() : '';
    const database = typeof record.database === 'string' ? record.database.trim() : '';
    const portRaw = typeof record.port === 'number'
        ? record.port
        : typeof record.port === 'string'
            ? Number.parseInt(record.port, 10)
            : undefined;
    const dockerContainerName = typeof record.dockerContainerName === 'string'
        ? record.dockerContainerName.trim()
        : undefined;

    const errors: string[] = [];
    if (!strategy) {
        errors.push('databaseIntent.strategy must be dedicated-local, shared-local, or external-existing');
    }
    if (!provisioning) {
        errors.push('databaseIntent.provisioning must be local, managed, or docker');
    }
    if (!host) {
        errors.push('databaseIntent.host is required');
    }
    if (!database) {
        errors.push('databaseIntent.database is required');
    }
    if (portRaw !== undefined && (!Number.isFinite(portRaw) || portRaw <= 0)) {
        errors.push('databaseIntent.port must be a positive integer');
    }

    if (errors.length > 0 || !strategy || !provisioning || !host || !database) {
        return { intent: null, errors };
    }

    return {
        intent: {
            strategy,
            provisioning,
            host,
            ...(portRaw !== undefined ? { port: portRaw } : {}),
            database,
            ...(dockerContainerName ? { dockerContainerName } : {}),
        },
        errors: [],
    };
}

function resolveInstanceDatabaseIntent(options: {
    instanceName: string;
    env: Record<string, string>;
    meta: Partial<InstanceMeta> | null;
    dependencies: InstanceDependency[];
}): { intent: InstanceDatabaseIntent | null; source: 'meta' | 'inferred' | 'none'; errors: string[] } {
    const parsedMeta = parseInstanceDatabaseIntent(options.meta?.databaseIntent);
    if (parsedMeta.intent) {
        return { intent: parsedMeta.intent, source: 'meta', errors: parsedMeta.errors };
    }

    const dbUrl = options.env.DATABASE_URL?.trim();
    if (!dbUrl || detectPlaceholder(dbUrl)) {
        return { intent: null, source: 'none', errors: parsedMeta.errors };
    }

    const dockerDependency = options.dependencies.find((dependency) => dependency.kind === 'docker-container');
    return {
        intent: buildInstanceDatabaseIntent({
            instanceName: options.instanceName,
            databaseMode: inferDatabaseProvisioning(dbUrl, options.dependencies),
            databaseUrl: dbUrl,
            dockerContainerName: dockerDependency?.name,
        }),
        source: 'inferred',
        errors: parsedMeta.errors,
    };
}

function describeInstanceDatabaseIntent(intent: InstanceDatabaseIntent, source: 'meta' | 'inferred' | 'none' = 'meta'): string {
    const target = `${intent.host}${intent.port ? `:${intent.port}` : ''}/${intent.database}`;
    const sourceSuffix = source === 'inferred' ? ' (inferred)' : '';
    const dockerSuffix = intent.dockerContainerName ? `, container ${intent.dockerContainerName}` : '';
    return `${describeDatabaseIntentStrategy(intent.strategy)} via ${intent.provisioning} -> ${target}${dockerSuffix}${sourceSuffix}`;
}

function sanitizeIdentifier(input: string, fallback: string): string {
    const value = input.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    if (!value && input.trim()) {
        verboseLog(`sanitizeIdentifier: input "${input}" normalized to empty — using fallback "${fallback}"`);
    }
    return value || fallback;
}

function normalizedInstanceCollisionKey(input: string): string {
    return sanitizeIdentifier(input, 'instance').replace(/[-_]+/g, '_');
}

function findSiblingInstanceCollision(root: string, desiredName: string): { name: string; dir: string } | null {
    const instancesDir = path.join(root, 'instances');
    if (!fs.existsSync(instancesDir)) return null;

    const desiredKey = normalizedInstanceCollisionKey(desiredName);
    for (const entry of fs.readdirSync(instancesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === desiredName) continue;
        if (normalizedInstanceCollisionKey(entry.name) !== desiredKey) continue;
        return {
            name: entry.name,
            dir: path.join(instancesDir, entry.name),
        };
    }

    return null;
}

function normalizeDockerContainerName(input: string | undefined, fallback: string): string {
    const trimmed = input?.trim() ?? '';
    return trimmed || fallback;
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
        databaseIntent: InstanceDatabaseIntent;
        provider: string;
        providerKeys: Record<string, string>;
        apiKey: string;
        dependencies?: InstanceDependency[];
    }
): Promise<{ envFile: string; instanceDir: string; created: boolean }> {
    const { instanceDir, envFile, metaFile } = instancePaths(root, name);
    const created = !fs.existsSync(envFile);
    const existingEnv = fs.existsSync(envFile)
        ? await readEnvFile(envFile).catch(() => ({} as Record<string, string>))
        : {};
    const apiKeyPepper = resolveInstanceApiKeyPepper(existingEnv.IRANTI_API_KEY_PEPPER);

    if (created) {
        await ensureDir(instanceDir);
        await ensureDir(path.join(instanceDir, 'logs'));
        await ensureDir(path.join(instanceDir, 'escalation', 'active'));
        await ensureDir(path.join(instanceDir, 'escalation', 'resolved'));
        await ensureDir(path.join(instanceDir, 'escalation', 'archived'));
        await writeText(envFile, makeInstanceEnv(name, config.port, config.dbUrl, config.apiKey, instanceDir, apiKeyPepper));
        const meta: InstanceMeta = {
            name,
            createdAt: new Date().toISOString(),
            port: config.port,
            envFile,
            instanceDir,
            databaseIntent: config.databaseIntent,
            ...(config.dependencies && config.dependencies.length > 0 ? { dependencies: config.dependencies } : {}),
        };
        await writeJson(metaFile, meta);
    }

    await upsertEnvFile(envFile, {
        IRANTI_PORT: String(config.port),
        DATABASE_URL: config.dbUrl,
        IRANTI_API_KEY: config.apiKey,
        IRANTI_API_KEY_PEPPER: apiKeyPepper,
        LLM_PROVIDER: config.provider,
        ...config.providerKeys,
    });

    await syncInstanceMeta(root, name, config.port, {
        databaseIntent: config.databaseIntent,
        ...(config.dependencies !== undefined ? { dependencies: config.dependencies } : {}),
    });

    return { envFile, instanceDir, created };
}

function makeIrantiMcpServerConfig(projectEnvPath?: string): { command: string; args: string[]; env?: Record<string, string> } {
    const env: Record<string, string> = {
        IRANTI_MCP_HOST: 'codex_cli',
    };
    if (projectEnvPath) {
        env.IRANTI_PROJECT_ENV = projectEnvPath;
    }
    return {
        command: 'iranti',
        args: ['mcp'],
        env,
    };
}

function makeClaudeLocalMcpServerConfig(projectEnvPath?: string): { command: string; args: string[]; env?: Record<string, string> } {
    const env: Record<string, string> = {
        IRANTI_MCP_HOST: 'claude_code',
    };
    if (projectEnvPath) {
        env.IRANTI_PROJECT_ENV = projectEnvPath;
    }
    return {
        command: 'iranti',
        args: ['mcp'],
        env,
    };
}

function makeVsCodeIrantiMcpServerConfig(projectPath: string, projectEnvPath?: string): {
    type: 'stdio';
    command: string;
    args: string[];
    envFile?: string;
    env?: Record<string, string>;
} {
    const resolvedProjectEnvPath = projectEnvPath ? path.resolve(projectEnvPath) : undefined;
    const localProjectEnvPath = path.join(projectPath, '.env.iranti');
    const env: Record<string, string> = {
        IRANTI_MCP_HOST: 'codex_vscode',
    };
    if (resolvedProjectEnvPath && path.resolve(localProjectEnvPath) !== resolvedProjectEnvPath) {
        env.IRANTI_PROJECT_ENV = resolvedProjectEnvPath;
    }
    return {
        type: 'stdio',
        command: 'iranti',
        args: ['mcp'],
        ...(resolvedProjectEnvPath && path.resolve(localProjectEnvPath) === resolvedProjectEnvPath
            ? { envFile: '${workspaceFolder}/.env.iranti' }
            : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
    };
}

function applyEnvMap(vars: Record<string, string>): void {
    for (const [key, value] of Object.entries(vars)) {
        process.env[key] = value;
    }
}

const MANAGED_INSTANCE_ENV_KEYS = [
    'DATABASE_URL',
    'IRANTI_PORT',
    'IRANTI_API_KEY',
    'IRANTI_API_KEY_PEPPER',
    'IRANTI_ALLOW_INSECURE_STARTUP',
    'LLM_PROVIDER',
    ...Object.values(PROVIDER_ENV_KEYS).filter((value): value is string => Boolean(value)),
] as const;

function applyManagedInstanceEnv(vars: Record<string, string>): void {
    for (const key of MANAGED_INSTANCE_ENV_KEYS) {
        if (!(key in vars)) {
            delete process.env[key];
        }
    }
    applyEnvMap(vars);
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
        debugLog('Attendant CLI runtime env resolved.', {
            cwd,
            authorityMode: loaded.authorityMode,
            projectEnvFile: loaded.projectEnvFile ?? null,
            instanceEnvFile: loaded.instanceEnvFile ?? null,
            loadedFiles: loaded.loadedFiles.join(' | ') || '(none)',
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
        iranti: createFirstPartyIranti({
            connectionString,
            sessionLedgerSource: 'cli',
            sessionLedgerHost: 'plain_cli',
        }),
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

function resolveBackfillFile(args: ParsedArgs): string | null {
    const backfill = getFlag(args, 'backfill')?.trim();
    return backfill ? path.resolve(backfill) : null;
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

type IssueListStatus = 'open' | 'resolved';

type IssueListItem = {
    key: string;
    issueId: string;
    title: string;
    status: IssueListStatus;
    severity: string;
    summary: string;
    confidence: number;
    source: string;
    discoveredAt: string | null;
    resolvedAt: string | null;
    resolution: string | null;
    tags: string[];
};

type InvalidIssueFact = {
    key: string;
    summary: string;
    confidence: number;
    source: string;
    reason: string;
};

function resolveIssueEntity(args: ParsedArgs): string {
    const explicit = getFlag(args, 'entity')?.trim();
    if (explicit) {
        if (!explicit.includes('/')) {
            throw new Error('issue entity must use entityType/entityId format.');
        }
        return explicit;
    }

    const fromEnv = process.env.IRANTI_MEMORY_ENTITY?.trim();
    if (fromEnv?.includes('/')) {
        return fromEnv;
    }

    throw new Error('Missing issue entity. Pass --entity <entityType/entityId> or run from a bound project with IRANTI_MEMORY_ENTITY.');
}

function resolveIssueStatusFilter(args: ParsedArgs): IssueListStatus | null {
    const raw = getFlag(args, 'status')?.trim().toLowerCase();
    if (!raw) return null;
    if (raw === 'open' || raw === 'resolved') {
        return raw;
    }
    throw new Error(`Invalid --status '${raw}'. Use open or resolved.`);
}

function parseIssueListFact(entry: { key: string; value: unknown; summary: string; confidence: number; source: string; }): { item: IssueListItem | null; invalid: InvalidIssueFact | null } {
    if (!entry.key.startsWith('issue_')) {
        return { item: null, invalid: null };
    }
    const value = typeof entry.value === 'object' && entry.value ? entry.value as Record<string, unknown> : null;
    if (!value) {
        return {
            item: null,
            invalid: {
                key: entry.key,
                summary: entry.summary,
                confidence: entry.confidence,
                source: entry.source,
                reason: 'issue_* fact value is not an object',
            },
        };
    }
    const rawStatus = typeof value?.status === 'string' ? value.status.toLowerCase() : '';
    if (rawStatus !== 'open' && rawStatus !== 'resolved') {
        return {
            item: null,
            invalid: {
                key: entry.key,
                summary: entry.summary,
                confidence: entry.confidence,
                source: entry.source,
                reason: 'issue_* fact is missing canonical open/resolved status',
            },
        };
    }
    return {
        item: {
            key: entry.key,
            issueId: typeof value?.issueId === 'string' && value.issueId.trim() ? value.issueId.trim() : entry.key.replace(/^issue_/, ''),
            title: typeof value?.title === 'string' && value.title.trim() ? value.title.trim() : entry.summary,
            status: rawStatus,
            severity: typeof value?.severity === 'string' && value.severity.trim() ? value.severity.trim() : 'medium',
            summary: entry.summary,
            confidence: entry.confidence,
            source: entry.source,
            discoveredAt: typeof value?.discoveredAt === 'string' && value.discoveredAt.trim() ? value.discoveredAt.trim() : null,
            resolvedAt: typeof value?.resolvedAt === 'string' && value.resolvedAt.trim() ? value.resolvedAt.trim() : null,
            resolution: typeof value?.resolution === 'string' && value.resolution.trim() ? value.resolution.trim() : null,
            tags: Array.isArray(value?.tags)
                ? value.tags.map((tag) => String(tag).trim()).filter(Boolean)
                : [],
        },
        invalid: null,
    };
}

function compareIssueListItems(a: IssueListItem, b: IssueListItem): number {
    if (a.status !== b.status) {
        return a.status === 'open' ? -1 : 1;
    }
    const severityRank = new Map<string, number>([
        ['critical', 0],
        ['high', 1],
        ['medium', 2],
        ['low', 3],
    ]);
    const severityDelta = (severityRank.get(a.severity) ?? 99) - (severityRank.get(b.severity) ?? 99);
    if (severityDelta !== 0) return severityDelta;
    return a.issueId.localeCompare(b.issueId);
}

function printIssuesResult(
    entity: string,
    items: IssueListItem[],
    statusFilter: IssueListStatus | null,
    inventoryCounts: { open: number; resolved: number; invalid: number; canonicalTotal: number; issueLikeTotal: number; },
    invalidFacts: InvalidIssueFact[],
): void {
    console.log(sectionTitle('Issues Command'));
    console.log(`Entity: ${entity}`);
    console.log(`Filter: ${statusFilter ?? 'all'}`);
    console.log(`Total: ${items.length}`);
    console.log(`Canonical inventory: ${inventoryCounts.canonicalTotal} (${inventoryCounts.open} open, ${inventoryCounts.resolved} resolved)`);
    console.log(`Invalid issue_* facts: ${inventoryCounts.invalid}`);
    console.log('');
    if (invalidFacts.length > 0) {
        console.log('Warnings:');
        for (const invalid of invalidFacts) {
            console.log(`  - ${invalid.key}: ${invalid.reason} [source=${invalid.source}, confidence=${invalid.confidence}]`);
        }
        console.log('');
    }
    if (items.length === 0) {
        console.log('No issue facts found.');
        return;
    }

    for (const item of items) {
        const header = `[${item.status.toUpperCase()}] ${item.issueId} (${item.severity})`;
        console.log(header);
        console.log(`  Title: ${item.title}`);
        console.log(`  Summary: ${item.summary}`);
        console.log(`  Source: ${item.source}`);
        console.log(`  Confidence: ${item.confidence}`);
        if (item.discoveredAt) {
            console.log(`  Discovered: ${item.discoveredAt}`);
        }
        if (item.resolvedAt) {
            console.log(`  Resolved: ${item.resolvedAt}`);
        }
        if (item.resolution) {
            console.log(`  Resolution: ${item.resolution}`);
        }
        if (item.tags.length > 0) {
            console.log(`  Tags: ${item.tags.join(', ')}`);
        }
        console.log('');
    }
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
    console.log('Rules:');
    for (const line of result.operatingRules.split(/\r?\n/)) {
        console.log(line.trim().length > 0 ? `  ${line}` : '');
    }
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
    if (result.bootstrap?.handshakePerformed) {
        console.log(`  bootstrap     handshake auto-ran (${result.bootstrap.task})`);
    }
    console.log(`  method        ${result.decision.method}`);
    console.log(`  confidence    ${result.decision.confidence}`);
    console.log(`  explanation   ${result.decision.explanation}`);
    console.log(`  facts         ${result.facts.length}`);
    if ((result.memoryAttributions?.length ?? 0) > 0) {
        const firstAttribution = result.memoryAttributions![0];
        console.log(`  injection id  ${firstAttribution.injectionId}`);
        console.log(`  attribution   ${firstAttribution.status} surfaced=${firstAttribution.surfaced} used=${firstAttribution.used} helpful=${firstAttribution.helpful}`);
    }
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

function makeClaudeHookCommand(event: 'SessionStart' | 'UserPromptSubmit' | 'Stop', projectEnvPath?: string): string {
    const parts = ['iranti', 'claude-hook', '--event', event];
    if (projectEnvPath) {
        parts.push('--project-env', quoteClaudeHookArg(projectEnvPath));
    }
    return parts.join(' ');
}

function makeClaudeHookEntry(event: 'SessionStart' | 'UserPromptSubmit' | 'Stop', projectEnvPath?: string): Record<string, unknown> {
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

function makeClaudeWriteGuardHookEntry(hookScriptDir: string): Record<string, unknown> {
    return {
        matcher: 'Edit|Write',
        hooks: [
            {
                type: 'command',
                command: `node ${quoteClaudeHookArg(path.join(hookScriptDir, 'iranti-write-guard-hook.js'))}`,
            },
        ],
    };
}

function makeClaudeEditTrackerHookEntry(hookScriptDir: string): Record<string, unknown> {
    return {
        matcher: 'Edit|Write',
        hooks: [
            {
                type: 'command',
                command: `node ${quoteClaudeHookArg(path.join(hookScriptDir, 'iranti-edit-tracker-hook.js'))}`,
            },
        ],
    };
}

/**
 * Embedded JS content for the write-guard hook (PreToolUse).
 * Blocks Edit/Write if the agent has pending unwritten edits in .iranti-write-debt.
 */
function buildWriteGuardHookScript(): string {
    return `#!/usr/bin/env node
'use strict';
// Iranti write-guard hook — fires on PreToolUse for Edit/Write.
// Checks whether the agent has pending unwritten edits by querying the
// .iranti-write-debt signal file. If the agent edited files without calling
// iranti_write, this hook DENIES the next edit and injects a reminder.
//
// Falls through silently (allows) for non-Iranti projects or if check fails.
const fs = require('fs');
const path = require('path');

const envFile = path.join(process.cwd(), '.env.iranti');
if (!fs.existsSync(envFile)) {
    process.exit(0);
}

let input = '';
try {
    input = fs.readFileSync(0, 'utf8');
} catch {
    process.exit(0);
}

let hookData;
try {
    hookData = JSON.parse(input);
} catch {
    process.exit(0);
}

const toolName = hookData.tool_name || hookData.toolName || '';
if (toolName !== 'Edit' && toolName !== 'Write') {
    process.exit(0);
}

const signalFile = path.join(process.cwd(), '.iranti-write-debt');
if (!fs.existsSync(signalFile)) {
    process.exit(0);
}

let debt;
try {
    debt = JSON.parse(fs.readFileSync(signalFile, 'utf8'));
} catch {
    process.exit(0);
}

const pendingEdits = debt.pendingEdits || 0;
const lastEditAt = debt.lastEditAt || null;

if (pendingEdits < 1) {
    process.exit(0);
}

const output = JSON.stringify({
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: \`Iranti write-guard: \${pendingEdits} file edit(s) since last iranti_write (last edit: \${lastEditAt || 'unknown'}). Call iranti_write for each pending edit before making new changes.\`,
    additionalContext: [
        'IRANTI WRITE-GUARD BLOCKED THIS EDIT.',
        \`You have \${pendingEdits} pending file edit(s) that have not been written to Iranti shared memory.\`,
        'Before making any more edits, you MUST call iranti_write for each pending edit.',
        'Include: entity (project/[id]/file/[filename]), absolutePath, lines changed, what changed and why.',
        'After writing all pending edits, this guard will allow new edits.',
    ].join('\\n'),
});

require('fs').writeSync(1, output);
`;
}

/**
 * Embedded JS content for the edit-tracker hook (PostToolUse).
 * Increments the .iranti-write-debt counter after each Edit/Write.
 */
function buildEditTrackerHookScript(): string {
    return `#!/usr/bin/env node
'use strict';
// Iranti edit-tracker hook — fires on PostToolUse for Edit/Write.
// Increments the write-debt counter so the PreToolUse write-guard knows
// the agent has pending unwritten edits.
//
// The write-debt file (.iranti-write-debt) is cleared by the MCP server
// when iranti_write is called, completing the enforcement loop.
//
// Falls through silently for non-Iranti projects.
const fs = require('fs');
const path = require('path');

const envFile = path.join(process.cwd(), '.env.iranti');
if (!fs.existsSync(envFile)) {
    process.exit(0);
}

let input = '';
try {
    input = fs.readFileSync(0, 'utf8');
} catch {
    process.exit(0);
}

let hookData;
try {
    hookData = JSON.parse(input);
} catch {
    process.exit(0);
}

const toolName = hookData.tool_name || hookData.toolName || '';
if (toolName !== 'Edit' && toolName !== 'Write') {
    process.exit(0);
}

const signalFile = path.join(process.cwd(), '.iranti-write-debt');
let debt = { pendingEdits: 0, edits: [] };

try {
    if (fs.existsSync(signalFile)) {
        debt = JSON.parse(fs.readFileSync(signalFile, 'utf8'));
    }
} catch {
    debt = { pendingEdits: 0, edits: [] };
}

const editedFile = hookData.tool_input?.file_path
    || hookData.input?.file_path
    || hookData.tool_input?.filePath
    || hookData.input?.filePath
    || 'unknown';

debt.pendingEdits = (debt.pendingEdits || 0) + 1;
debt.lastEditAt = new Date().toISOString();
debt.edits = debt.edits || [];
debt.edits.push({
    file: editedFile,
    at: debt.lastEditAt,
});

if (debt.edits.length > 20) {
    debt.edits = debt.edits.slice(-20);
}

try {
    fs.writeFileSync(signalFile, JSON.stringify(debt, null, 2), 'utf8');
} catch {
    // Can't write signal — that's okay, guard just won't fire
}

const output = JSON.stringify({
    hookEventName: 'PostToolUse',
    additionalContext: \`Iranti: file edited (\${path.basename(editedFile)}). \${debt.pendingEdits} pending edit(s) awaiting iranti_write. Write before making more edits.\`,
});

require('fs').writeSync(1, output);
`;
}

/**
 * Embedded JS content for the Codex/generic protocol reminder hook (UserPromptSubmit).
 * Injects a protocol reminder before every user prompt in Codex sessions.
 */
function buildProtocolReminderHookScript(): string {
    return `#!/usr/bin/env node
'use strict';
// Iranti protocol reminder hook — fires on UserPromptSubmit for any Iranti project.
// Cross-platform: runs on Windows, macOS, Linux via Node.js.
// Exits cleanly with no output for non-Iranti projects.
const fs = require('fs');
const path = require('path');

const envFile = path.join(process.cwd(), '.env.iranti');
if (!fs.existsSync(envFile)) process.exit(0);

const content = [
  'IRANTI PROTOCOL (required this turn):',
  '1. iranti_attend(phase=pre-response) BEFORE replying',
  '2. iranti_attend BEFORE each Read / Grep / Glob / Bash / WebSearch / WebFetch',
  '3. iranti_write AFTER each Edit or Write:',
  '   entity: project/[id]/file/[filename] -- not the broad project entity',
  '   value must include: absolutePath, lines, before, after, verify, why',
  '4. iranti_write AFTER each Bash that reveals system state (build, errors, ports, env)',
  '5. iranti_write AFTER each WebSearch/WebFetch -- write findings AND dead ends / 404s',
  '6. iranti_attend(phase=post-response) AFTER every response without exception',
].join('\\n') + '\\n';
require('fs').writeSync(1, content);
`;
}

const IRANTI_CLAUDE_ALLOWED_TOOLS = [
    'mcp__iranti__iranti_handshake',
    'mcp__iranti__iranti_attend',
    'mcp__iranti__iranti_observe',
    'mcp__iranti__iranti_checkpoint',
    'mcp__iranti__iranti_query',
    'mcp__iranti__iranti_search',
    'mcp__iranti__iranti_write',
    'mcp__iranti__iranti_remember_response',
    'mcp__iranti__iranti_ingest',
    'mcp__iranti__iranti_relate',
    'mcp__iranti__iranti_related',
    'mcp__iranti__iranti_related_deep',
    'mcp__iranti__iranti_who_knows',
] as const;

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
    // Legacy hook format detection — upgrade needed if old-style entries exist.
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop'] as const) {
        const entries = hooks[event];
        if (!Array.isArray(entries) || entries.length === 0) {
            continue;
        }
        if (entries.some((entry) => isLegacyIrantiClaudeHookEntry(entry))) {
            return true;
        }
    }
    // Write-guard hooks missing — upgrade needed to add PreToolUse/PostToolUse.
    if (!Array.isArray(hooks.PreToolUse) || hooks.PreToolUse.length === 0) {
        return true;
    }
    if (!Array.isArray(hooks.PostToolUse) || hooks.PostToolUse.length === 0) {
        return true;
    }
    return false;
}

function mergeClaudePermissionAllowList(existing?: Record<string, unknown>): Record<string, unknown> {
    const currentPermissions = existing && typeof existing.permissions === 'object' && existing.permissions !== null && !Array.isArray(existing.permissions)
        ? { ...(existing.permissions as Record<string, unknown>) }
        : {};

    const allow = Array.isArray(currentPermissions.allow)
        ? [...currentPermissions.allow.map((value) => String(value))]
        : [];

    for (const toolName of IRANTI_CLAUDE_ALLOWED_TOOLS) {
        if (!allow.includes(toolName)) {
            allow.push(toolName);
        }
    }

    return {
        ...currentPermissions,
        allow,
    };
}

function makeClaudeHookSettings(projectEnvPath?: string, existing?: Record<string, unknown>, hookScriptDir?: string): Record<string, unknown> {
    const existingHooks = existing && isClaudeHooksObject(existing.hooks)
        ? existing.hooks
        : {};
    const existingMcpServers =
        existing && existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
            ? existing.mcpServers as Record<string, unknown>
            : {};
    const existingEnabledMcpjsonServers = Array.isArray(existing?.enabledMcpjsonServers)
        ? existing.enabledMcpjsonServers
            .map((value) => String(value))
            .filter((value) => value !== 'iranti')
        : undefined;

    const hooks: Record<string, unknown> = {
        ...existingHooks,
        SessionStart: [makeClaudeHookEntry('SessionStart', projectEnvPath)],
        UserPromptSubmit: [makeClaudeHookEntry('UserPromptSubmit', projectEnvPath)],
        Stop: [makeClaudeHookEntry('Stop', projectEnvPath)],
    };

    // Write-guard hooks: block edits until prior edits are written to Iranti.
    if (hookScriptDir) {
        hooks.PreToolUse = [makeClaudeWriteGuardHookEntry(hookScriptDir)];
        hooks.PostToolUse = [makeClaudeEditTrackerHookEntry(hookScriptDir)];
    }

    return {
        ...(existing ?? {}),
        enableAllProjectMcpServers: false,
        permissions: mergeClaudePermissionAllowList(existing),
        mcpServers: {
            ...existingMcpServers,
            iranti: makeClaudeLocalMcpServerConfig(projectEnvPath),
        },
        ...(existingEnabledMcpjsonServers
            ? { enabledMcpjsonServers: existingEnabledMcpjsonServers }
            : {}),
        hooks,
    };
}

async function writeClaudeCodeProjectFiles(projectPath: string, projectEnvPath?: string, force: boolean = false): Promise<ClaudeProjectScaffoldResult> {
    const mcpFile = path.join(projectPath, '.mcp.json');
    let mcpStatus: ClaudeScaffoldStatus = 'unchanged';
    const resolvedProjectEnvPath = projectEnvPath && fs.existsSync(projectEnvPath)
        ? projectEnvPath
        : (fs.existsSync(path.join(projectPath, '.env.iranti')) ? path.join(projectPath, '.env.iranti') : undefined);
    const irantiMcpServer = makeIrantiMcpServerConfig(resolvedProjectEnvPath);
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

    const vscodeDir = path.join(projectPath, '.vscode');
    const vscodeMcpFile = path.join(vscodeDir, 'mcp.json');
    let vscodeMcpStatus: ClaudeScaffoldStatus = 'unchanged';
    const vscodeMcpServer = makeVsCodeIrantiMcpServerConfig(projectPath, resolvedProjectEnvPath);
    await ensureDir(vscodeDir);
    if (!fs.existsSync(vscodeMcpFile)) {
        await writeText(vscodeMcpFile, `${JSON.stringify({
            servers: {
                iranti: vscodeMcpServer,
            },
        }, null, 2)}\n`);
        vscodeMcpStatus = 'created';
    } else {
        const existing = readJsonFile<Record<string, unknown>>(vscodeMcpFile);
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
            if (!force) {
                throw new Error(`Existing .vscode/mcp.json is not valid JSON. Re-run with --force to overwrite it: ${vscodeMcpFile}`);
            }
            await writeText(vscodeMcpFile, `${JSON.stringify({
                servers: {
                    iranti: vscodeMcpServer,
                },
            }, null, 2)}\n`);
            vscodeMcpStatus = 'updated';
        } else {
            const existingServers =
                existing.servers && typeof existing.servers === 'object' && !Array.isArray(existing.servers)
                    ? existing.servers as Record<string, unknown>
                    : {};
            const hasIranti = Object.prototype.hasOwnProperty.call(existingServers, 'iranti');
            if (!hasIranti || force) {
                await writeText(vscodeMcpFile, `${JSON.stringify({
                    ...existing,
                    servers: {
                        ...existingServers,
                        iranti: vscodeMcpServer,
                    },
                }, null, 2)}\n`);
                vscodeMcpStatus = 'updated';
            }
        }
    }

    const claudeDir = path.join(projectPath, '.claude');
    await ensureDir(claudeDir);

    // Write hook scripts into .claude/ directory.
    const writeGuardHookFile = path.join(claudeDir, 'iranti-write-guard-hook.js');
    let writeGuardHookStatus: ClaudeScaffoldStatus = 'unchanged';
    const writeGuardContent = buildWriteGuardHookScript();
    if (!fs.existsSync(writeGuardHookFile)) {
        await writeText(writeGuardHookFile, writeGuardContent);
        writeGuardHookStatus = 'created';
    } else {
        const existing = fs.readFileSync(writeGuardHookFile, 'utf8');
        if (existing !== writeGuardContent) {
            await writeText(writeGuardHookFile, writeGuardContent);
            writeGuardHookStatus = 'updated';
        }
    }

    const editTrackerHookFile = path.join(claudeDir, 'iranti-edit-tracker-hook.js');
    let editTrackerHookStatus: ClaudeScaffoldStatus = 'unchanged';
    const editTrackerContent = buildEditTrackerHookScript();
    if (!fs.existsSync(editTrackerHookFile)) {
        await writeText(editTrackerHookFile, editTrackerContent);
        editTrackerHookStatus = 'created';
    } else {
        const existing = fs.readFileSync(editTrackerHookFile, 'utf8');
        if (existing !== editTrackerContent) {
            await writeText(editTrackerHookFile, editTrackerContent);
            editTrackerHookStatus = 'updated';
        }
    }

    const protocolReminderHookFile = path.join(claudeDir, 'iranti-protocol-hook.js');
    let protocolReminderHookStatus: ClaudeScaffoldStatus = 'unchanged';
    const protocolReminderContent = buildProtocolReminderHookScript();
    if (!fs.existsSync(protocolReminderHookFile)) {
        await writeText(protocolReminderHookFile, protocolReminderContent);
        protocolReminderHookStatus = 'created';
    } else {
        const existing = fs.readFileSync(protocolReminderHookFile, 'utf8');
        if (existing !== protocolReminderContent) {
            await writeText(protocolReminderHookFile, protocolReminderContent);
            protocolReminderHookStatus = 'updated';
        }
    }

    const settingsFile = path.join(claudeDir, 'settings.local.json');
    let settingsStatus: ClaudeScaffoldStatus = 'unchanged';
    if (!fs.existsSync(settingsFile)) {
        await writeText(settingsFile, `${JSON.stringify(makeClaudeHookSettings(projectEnvPath, undefined, claudeDir), null, 2)}\n`);
        settingsStatus = 'created';
    } else {
        const existingSettings = readJsonFile<Record<string, unknown>>(settingsFile);
        if (existingSettings && typeof existingSettings === 'object' && !Array.isArray(existingSettings)) {
            if (force || needsClaudeHookSettingsUpgrade(existingSettings)) {
                await writeText(settingsFile, `${JSON.stringify(makeClaudeHookSettings(projectEnvPath, existingSettings, claudeDir), null, 2)}\n`);
                settingsStatus = 'updated';
            }
        } else if (force) {
            await writeText(settingsFile, `${JSON.stringify(makeClaudeHookSettings(projectEnvPath, undefined, claudeDir), null, 2)}\n`);
            settingsStatus = 'updated';
        }
    }

    const claudeMdFile = path.join(projectPath, 'CLAUDE.md');
    let claudeMdStatus: ClaudeScaffoldStatus = 'unchanged';
    const irantiMdBlock = buildIrantiClaudeMdBlock();
    if (!fs.existsSync(claudeMdFile)) {
        await writeText(claudeMdFile, irantiMdBlock);
        claudeMdStatus = 'created';
    } else {
        const existing = fs.readFileSync(claudeMdFile, 'utf8');
        if (!existing.includes('<!-- iranti-rules -->')) {
            await writeText(claudeMdFile, `${existing.trimEnd()}\n\n${irantiMdBlock}`);
            claudeMdStatus = 'updated';
        } else {
            const replaced = existing.replace(
                /<!-- iranti-rules -->[\s\S]*?<!-- \/iranti-rules -->/,
                irantiMdBlock.trim()
            );
            if (replaced !== existing) {
                await writeText(claudeMdFile, replaced);
                claudeMdStatus = 'updated';
            }
        }
    }

    // Write IRANTI.md — the canonical host-neutral protocol file.
    const irantiMdFile = path.join(projectPath, 'IRANTI.md');
    let irantiMdStatus: ClaudeScaffoldStatus = 'unchanged';
    const irantiMdContent = buildIrantiMdContent();
    if (!fs.existsSync(irantiMdFile)) {
        await writeText(irantiMdFile, irantiMdContent);
        irantiMdStatus = 'created';
    } else {
        const existing = fs.readFileSync(irantiMdFile, 'utf8');
        if (existing !== irantiMdContent) {
            await writeText(irantiMdFile, irantiMdContent);
            irantiMdStatus = 'updated';
        }
    }

    const closeout = await writeProjectScaffoldCloseout({
        tool: 'claude',
        projectPath,
        projectEnvFile: resolvedProjectEnvPath ?? projectEnvPath ?? null,
        files: [
            { path: mcpFile, status: mcpStatus },
            { path: vscodeMcpFile, status: vscodeMcpStatus },
            { path: writeGuardHookFile, status: writeGuardHookStatus },
            { path: editTrackerHookFile, status: editTrackerHookStatus },
            { path: protocolReminderHookFile, status: protocolReminderHookStatus },
            { path: settingsFile, status: settingsStatus },
            { path: claudeMdFile, status: claudeMdStatus },
            { path: irantiMdFile, status: irantiMdStatus },
        ],
        agentId: 'iranti_cli_scaffold',
    });

    return {
        mcp: mcpStatus,
        vscodeMcp: vscodeMcpStatus,
        settings: settingsStatus,
        claudeMd: claudeMdStatus,
        irantiMd: irantiMdStatus,
        writeGuardHook: writeGuardHookStatus,
        editTrackerHook: editTrackerHookStatus,
        protocolReminderHook: protocolReminderHookStatus,
        closeout,
    };
}

/**
 * Canonical protocol content for IRANTI.md — host-neutral, read once per session.
 * This is the single source of truth for the Iranti operating protocol.
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
 * Slim CLAUDE.md block — just points to IRANTI.md and triggers handshake.
 * This content lives in the system prompt on every turn, so keep it minimal.
 */
function buildIrantiClaudeMdBlock(): string {
    return [
        '<!-- iranti-rules -->',
        '# Iranti',
        '',
        'This project uses Iranti for shared memory. Read `IRANTI.md` for the full protocol.',
        '',
        '- Call `mcp__iranti__iranti_handshake` before responding to the first user message.',
        '- Call `mcp__iranti__iranti_handshake` after context compaction.',
        '- Follow the attend/write/checkpoint protocol in IRANTI.md.',
        '<!-- /iranti-rules -->',
        '',
    ].join('\n');
}

function hasCodexInstalled(): boolean {
    try {
        const proc = spawnSyncResolved('codex', ['--version'], { stdio: 'ignore' });
        return proc.status === 0;
    } catch {
        return false;
    }
}

function hasDockerInstalled(): boolean {
    try {
        const proc = spawnSyncResolved('docker', ['--version'], { stdio: 'ignore' });
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
    const injected = process.env.IRANTI_FAKE_DOCKER_PORTS?.trim();
    if (injected) {
        return parsePublishedDockerHostPorts(injected);
    }

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

async function syncInstanceMeta(
    root: string,
    name: string,
    port: number,
    options: { dependencies?: InstanceDependency[]; databaseIntent?: InstanceDatabaseIntent } = {},
): Promise<void> {
    const { instanceDir, envFile, metaFile } = instancePaths(root, name);
    const existing = await readInstanceMetaFile(metaFile);
    const existingCreatedAt = typeof existing?.createdAt === 'string' ? existing.createdAt : undefined;
    const existingDependencies = parseInstanceDependencies(existing?.dependencies).dependencies;
    const currentDependencies = options.dependencies ?? existingDependencies;
    const env = fs.existsSync(envFile)
        ? await readEnvFile(envFile).catch(() => ({} as Record<string, string>))
        : {};
    const resolvedDatabaseIntent = options.databaseIntent
        ?? resolveInstanceDatabaseIntent({
            instanceName: name,
            env,
            meta: existing,
            dependencies: currentDependencies,
        }).intent;

    const meta: InstanceMeta = {
        name,
        createdAt: existingCreatedAt ?? new Date().toISOString(),
        port,
        envFile,
        instanceDir,
        ...(resolvedDatabaseIntent ? { databaseIntent: resolvedDatabaseIntent } : {}),
        ...(options.dependencies !== undefined
            ? { dependencies: options.dependencies }
            : existingDependencies.length > 0
                ? { dependencies: existingDependencies }
                : {}),
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
        const start = spawnSyncResolved('docker', ['start', options.containerName], { stdio: 'inherit' });
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
        const result = spawnSyncResolved('docker', args, { stdio: 'inherit' });
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
        databaseIntent: plan.databaseIntent,
        provider: plan.provider,
        providerKeys: plan.providerKeys,
        apiKey: plan.apiKey,
        dependencies: plan.dependencies,
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
            IRANTI_PERSONAL_MEMORY_ENTITY: project.personalMemoryEntity,
            IRANTI_AUTO_REMEMBER: String(project.autoRemember),
            IRANTI_PROJECT_MODE: project.projectMode,
            IRANTI_INSTANCE: plan.instanceName,
            IRANTI_INSTANCE_ENV: configured.envFile,
        });
        const bindingEnv = await readEnvFile(written);
        const learningStatus = await writeProjectLearningSnapshot({
            projectPath,
            projectEnvFile: written,
            binding: bindingEnv,
            agentId: project.agentId,
        });
        bindings.push({
            projectPath,
            envFile: written,
            agentId: project.agentId,
            projectMode: project.projectMode,
            autoRemember: project.autoRemember,
            codebaseEntity: bindingEnv.IRANTI_CODEBASE_ENTITY ?? deriveProjectCodebaseEntity(projectPath),
            learningStatus,
        });
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
        databaseIntent: plan.databaseIntent,
        bindings,
    };
}

async function parseSetupConfig(filePath: string): Promise<SetupExecutionPlan> {
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
    const databaseUrl = await resolveSetupDatabaseUrl(
        databaseMode,
        instanceName,
        String(raw?.databaseUrl ?? raw?.dbUrl ?? '').trim(),
    );
    const databaseIntentStrategy = parseDatabaseIntentStrategyFlag(String(raw?.databaseIntent ?? raw?.dbIntent ?? '').trim(), 'databaseIntent');
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
        personalMemoryEntity: String(item?.personalMemoryEntity ?? 'user/main'),
        projectMode: normalizeProjectMode(String(item?.projectMode ?? mode), mode),
        autoRemember: parseOptionalBooleanValue(item?.autoRemember, 'projects[].autoRemember') ?? false,
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
        databaseIntent: buildInstanceDatabaseIntent({
            instanceName,
            databaseMode,
            databaseUrl,
            strategy: databaseIntentStrategy,
            dockerContainerName: typeof raw?.dockerContainerName === 'string' ? raw.dockerContainerName : undefined,
        }),
        provider,
        providerKeys,
        apiKey,
        projects,
        codex: Boolean(raw?.codex),
        codexAgent: raw?.codexAgent ? sanitizeIdentifier(String(raw.codexAgent), 'codex_code') : undefined,
        bootstrapDatabase: Boolean(raw?.bootstrapDatabase),
        dependencies: inferSetupDependencies({
            databaseMode,
            databaseUrl,
            dockerContainerName: typeof raw?.dockerContainerName === 'string' ? raw.dockerContainerName : undefined,
            instanceName,
        }),
    };
}

async function defaultsSetupPlan(args: ParsedArgs): Promise<SetupExecutionPlan> {
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
    const explicitDatabaseUrl = (
        getFlag(args, 'db-url')
        ?? (databaseMode === 'managed' ? process.env.DATABASE_URL : '')
        ?? ''
    ).trim();
    const databaseUrl = await resolveSetupDatabaseUrl(databaseMode, instanceName, explicitDatabaseUrl);
    const databaseIntentStrategy = parseDatabaseIntentStrategyFlag(getFlag(args, 'db-intent'), '--db-intent');

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

    const explicitProviderKey = (getFlag(args, 'provider-key') ?? '').trim();
    const apiKeyFlag = (getFlag(args, 'api-key') ?? '').trim();
    const providerEnvKey = providerKeyEnv(provider);
    const isRemoteProvider = Boolean(providerEnvKey);

    if (explicitProviderKey && !detectPlaceholder(explicitProviderKey) && providerEnvKey) {
        providerKeys[providerEnvKey] = explicitProviderKey;
    } else if (apiKeyFlag && !detectPlaceholder(apiKeyFlag) && isRemoteProvider && providerEnvKey && !providerKeys[providerEnvKey]) {
        providerKeys[providerEnvKey] = apiKeyFlag;
    }

    const irantiKeyRaw = isRemoteProvider
        ? (process.env.IRANTI_API_KEY ?? '').trim()
        : apiKeyFlag || (process.env.IRANTI_API_KEY ?? '').trim();
    const apiKey = irantiKeyRaw && !detectPlaceholder(irantiKeyRaw)
        ? irantiKeyRaw
        : makeLegacyInstanceApiKey(instanceName);

    const projectsFlag = (getFlag(args, 'projects') ?? '').trim();
    const projects = projectsFlag
        ? projectsFlag.split(',').map((item) => item.trim()).filter(Boolean).map((projectPath) => ({
            path: path.resolve(projectPath),
            agentId: projectAgentDefault(projectPath),
            memoryEntity: 'user/main',
            personalMemoryEntity: 'user/main',
            projectMode: mode,
            autoRemember: resolveOptionalBooleanFlag(args, 'auto-remember') ?? false,
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
        databaseIntent: buildInstanceDatabaseIntent({
            instanceName,
            databaseMode,
            databaseUrl,
            strategy: databaseIntentStrategy,
            dockerContainerName: getFlag(args, 'docker-container-name'),
        }),
        provider,
        providerKeys,
        apiKey,
        projects,
        codex: hasFlag(args, 'codex'),
        codexAgent: sanitizeIdentifier(getFlag(args, 'codex-agent') ?? 'codex_code', 'codex_code'),
        bootstrapDatabase: hasFlag(args, 'bootstrap-db'),
        dependencies: inferSetupDependencies({
            databaseMode,
            databaseUrl,
            dockerContainerName: getFlag(args, 'docker-container-name'),
            instanceName,
        }),
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

function detectStartupSecurityPosture(env: Record<string, string>, prefix = ''): DoctorCheck {
    const productionLike = (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
    const allowInsecure = (env.IRANTI_ALLOW_INSECURE_STARTUP ?? '').trim().toLowerCase() === 'true';
    const pepper = (env.IRANTI_API_KEY_PEPPER ?? '').trim();

    if (!pepper) {
        return {
            name: `${prefix}startup security`,
            status: productionLike && !allowInsecure ? 'fail' : 'warn',
            detail: productionLike && !allowInsecure
                ? 'IRANTI_API_KEY_PEPPER is missing. Production startup will refuse to boot.'
                : 'IRANTI_API_KEY_PEPPER is missing. Local startup is allowed, but production startup will refuse to boot without an override.',
        };
    }

    if (pepper.length < 32) {
        return {
            name: `${prefix}startup security`,
            status: productionLike && !allowInsecure ? 'fail' : 'warn',
            detail: productionLike && !allowInsecure
                ? `IRANTI_API_KEY_PEPPER is too short (${pepper.length}). Production startup will refuse to boot.`
                : `IRANTI_API_KEY_PEPPER is too short (${pepper.length}). Operator trust is degraded even though startup may continue locally.`,
        };
    }

    if (productionLike && allowInsecure) {
        return {
            name: `${prefix}startup security`,
            status: 'warn',
            detail: 'Production startup is explicitly allowing insecure startup via IRANTI_ALLOW_INSECURE_STARTUP=true.',
        };
    }

    return {
        name: `${prefix}startup security`,
        status: 'pass',
        detail: 'Startup security invariants are satisfied.',
    };
}

function detectRuntimeAuthorityCheck(env: Record<string, string>, prefix = ''): DoctorCheck | null {
    const hasRuntimeSignals = [
        env.IRANTI_INSTANCE_DIR,
        env.IRANTI_INSTANCE_RUNTIME_FILE,
        env.IRANTI_ESCALATION_DIR,
        env.IRANTI_REQUEST_LOG_FILE,
    ].some((value) => typeof value === 'string' && value.trim().length > 0);
    if (!hasRuntimeSignals) return null;

    const authority = resolveRuntimeAuthorityFromEnv(env);
    return {
        name: `${prefix}runtime authority`,
        status: authority.source === 'invalid' ? 'fail' : authority.managed ? 'pass' : 'warn',
        detail: authority.detail,
    };
}

function summarizeStatus(checks: DoctorCheck[]): DoctorStatus {
    if (checks.some((check) => check.status === 'fail')) return 'fail';
    if (checks.some((check) => check.status === 'warn')) return 'warn';
    return 'pass';
}

type DatabaseAuthorityInfo = {
    repoEnvFile: string | null;
    repoEnvDatabaseUrl: string | null;
    boundInstanceDatabaseUrl: string | null;
    mismatch: boolean;
};

async function resolveDatabaseAuthorityInfo(
    repoEnvFile: string | null | undefined,
    boundInstanceEnvFile: string | null | undefined,
): Promise<DatabaseAuthorityInfo> {
    const normalizedRepoEnvFile = repoEnvFile && fs.existsSync(repoEnvFile) ? repoEnvFile : null;
    const normalizedBoundEnvFile = boundInstanceEnvFile && fs.existsSync(boundInstanceEnvFile) ? boundInstanceEnvFile : null;
    const repoEnv = normalizedRepoEnvFile ? await readEnvFile(normalizedRepoEnvFile) : null;
    const boundEnv = normalizedBoundEnvFile ? await readEnvFile(normalizedBoundEnvFile) : null;
    const repoEnvDatabaseUrl = repoEnv?.DATABASE_URL?.trim() || null;
    const boundInstanceDatabaseUrl = boundEnv?.DATABASE_URL?.trim() || null;
    return {
        repoEnvFile: normalizedRepoEnvFile,
        repoEnvDatabaseUrl,
        boundInstanceDatabaseUrl,
        mismatch: Boolean(
            repoEnvDatabaseUrl
            && boundInstanceDatabaseUrl
            && repoEnvDatabaseUrl !== boundInstanceDatabaseUrl
        ),
    };
}

function detectVsCodeMcpWorkspaceCheck(projectEnvPath: string): DoctorCheck {
    const vscodeMcpPath = path.join(path.dirname(projectEnvPath), '.vscode', 'mcp.json');
    if (!fs.existsSync(vscodeMcpPath)) {
        return {
            name: 'vscode mcp workspace',
            status: 'warn',
            detail: `VS Code MCP workspace file is missing: ${vscodeMcpPath}. Codex VS Code sessions may not expose Iranti tools even when Codex CLI works.`,
        };
    }

    const parsed = readJsonFile<Record<string, unknown>>(vscodeMcpPath);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            name: 'vscode mcp workspace',
            status: 'warn',
            detail: `.vscode/mcp.json is not valid JSON: ${vscodeMcpPath}`,
        };
    }

    const servers =
        parsed.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers)
            ? parsed.servers as Record<string, unknown>
            : {};
    if (!Object.prototype.hasOwnProperty.call(servers, 'iranti')) {
        return {
            name: 'vscode mcp workspace',
            status: 'warn',
            detail: `.vscode/mcp.json exists but does not expose an \`iranti\` server: ${vscodeMcpPath}`,
        };
    }

    return {
        name: 'vscode mcp workspace',
        status: 'pass',
        detail: `VS Code MCP workspace file is present and exposes \`iranti\`: ${vscodeMcpPath}`,
    };
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
        if (check.name === 'runtime root selection' && check.status !== 'pass') {
            add('Rerun `iranti doctor` with `--root <runtime-root>` that matches the bound project instance, or refresh `.env.iranti` with `iranti configure project` if the binding is stale.');
        }
        if (check.name === 'vscode mcp workspace' && check.status !== 'pass') {
            add('Run `iranti codex-setup` from the project root to scaffold `.vscode/mcp.json`, or add an `iranti` server entry there manually for VS Code MCP clients.');
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
        if ((check.name === 'vector index consistency' || check.name === 'bound instance vector index consistency') && check.status !== 'pass') {
            add('Vector index drift was detected. Reconcile it with `repairVectorIndexConsistency()` or re-ingest the affected facts; see `docs/guides/vector-backends.md`.');
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

    const discovered = findClosestDoctorEnvTarget(cwd);
    if (discovered.envFile && discovered.envSource === 'repo') {
        debugLog('Doctor target resolved from repo env.', { envFile: discovered.envFile });
        return discovered;
    }
    if (discovered.envFile && discovered.envSource === 'project-binding') {
        debugLog('Doctor target resolved from project binding.', { envFile: discovered.envFile });
        return discovered;
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
        const proc = spawnSyncResolved(command, ['--version'], { stdio: 'ignore' });
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
    const proc = spawnSyncResolved(executable, args, {
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
        stdout: typeof proc.stdout === 'string' ? proc.stdout : Buffer.from(proc.stdout ?? []).toString('utf8'),
        stderr: typeof proc.stderr === 'string' ? proc.stderr : Buffer.from(proc.stderr ?? []).toString('utf8'),
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
    const proc = spawnSyncResolved(step.executable, step.args, {
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

async function spawnDetachedCli(args: string[], cwd?: string): Promise<number> {
    const current = currentCliInvocation();
    const invocation = resolveCommandInvocation(current.executable, [...current.args, ...args]);
    const child = spawn(invocation.executable, invocation.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: cwd ?? process.cwd(),
        env: process.env,
    });
    const pid = child.pid;
    if (!pid) {
        throw new Error(`Failed to spawn detached CLI process (executable: ${invocation.executable}). The process did not start.`);
    }
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, 750);
        const cleanup = () => {
            clearTimeout(timer);
            child.removeAllListeners('error');
            child.removeAllListeners('exit');
        };
        child.once('error', (error) => {
            cleanup();
            reject(error);
        });
        child.once('exit', (code, signal) => {
            cleanup();
            reject(new Error(
                `Detached CLI process exited before startup verification completed (pid ${pid}, code ${code ?? 'null'}, signal ${signal ?? 'null'}).`
            ));
        });
    });
    child.unref();
    return pid;
}

function isFreshRestartState(
    inspection: RuntimeInspection,
    previousPid: number | null,
    previousStartedAt?: string | null,
): boolean {
    if (!inspection.running || !inspection.state) return false;

    if (inspection.state.pid && inspection.state.pid !== previousPid) {
        return true;
    }

    if (!previousStartedAt) {
        return false;
    }

    const previousStartedMs = Date.parse(previousStartedAt);
    const currentStartedMs = Date.parse(inspection.state.startedAt);
    if (!Number.isFinite(previousStartedMs) || !Number.isFinite(currentStartedMs)) {
        return false;
    }

    return currentStartedMs > previousStartedMs;
}

async function waitForRestartedRuntime(
    runtimeFile: string,
    previousPid: number | null,
    previousStartedAt: string | null,
    timeoutMs: number,
): Promise<RuntimeInspection> {
    const startedAt = Date.now();
    let lastInspection = await inspectRuntimeState(runtimeFile);
    while (Date.now() - startedAt < timeoutMs) {
        lastInspection = await inspectRuntimeState(runtimeFile);
        if (isFreshRestartState(lastInspection, previousPid, previousStartedAt)) {
            return lastInspection;
        }
        if (lastInspection.classification === 'invalid') {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Restarted runtime did not become healthy within ${Math.ceil(timeoutMs / 1000)}s. Last observed state: ${lastInspection.classification} (${lastInspection.detail}).`);
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

    const runtimeFile = instancePaths(root, instanceName).runtimeFile;
    const startupTimeoutMs = Math.max(timeoutMs, 30_000);
    const newPid = await spawnDetachedCli([
        'run',
        '--instance',
        instanceName,
        '--scope',
        scope,
        '--root',
        root,
    ], root);
    await waitForRestartedRuntime(runtimeFile, previousPid, runtimeBefore.state?.startedAt ?? null, startupTimeoutMs);

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
    const localDatabaseHost = preferredLocalDatabaseHost();
    if (mode === 'local') {
        return `postgresql://${user}:${password}@${localDatabaseHost}:5432/iranti_${instanceName}`;
    }
    return `postgresql://${user}:${password}@${localDatabaseHost}:5432/iranti_${instanceName}`;
}

async function resolveSetupDatabaseUrl(
    mode: DatabaseSetupMode,
    instanceName: string,
    explicitDatabaseUrl?: string,
): Promise<string> {
    if (mode !== 'docker') {
        return deriveDatabaseUrlForMode(mode, instanceName, explicitDatabaseUrl);
    }

    const explicit = explicitDatabaseUrl?.trim() ?? '';
    if (explicit && !detectPlaceholder(explicit)) {
        return explicit;
    }

    const preferredPort = 5432;
    const dockerPublishedPorts = listPublishedDockerHostPorts();
    const selectedPort = await isPortUsable(preferredPort, '0.0.0.0', dockerPublishedPorts)
        ? preferredPort
        : await findNextAvailablePort(preferredPort + 1, '0.0.0.0', 50, dockerPublishedPorts);
    const user = encodeURIComponent((process.env.POSTGRES_USER ?? 'postgres').trim() || 'postgres');
    const password = encodeURIComponent((process.env.POSTGRES_PASSWORD ?? 'postgres').trim() || 'postgres');
    return `postgresql://${user}:${password}@${preferredLocalDatabaseHost()}:${selectedPort}/iranti_${instanceName}`;
}

function preferredLocalDatabaseHost(): string {
    return process.platform === 'win32' ? '127.0.0.1' : 'localhost';
}

function inferSetupDependencies(plan: {
    databaseMode: DatabaseSetupMode;
    databaseUrl: string;
    dockerContainerName?: string;
    instanceName: string;
}): InstanceDependency[] {
    if (plan.databaseMode !== 'docker') {
        return [];
    }

    const parsed = parsePostgresConnectionString(plan.databaseUrl);
    const hostPort = Number.parseInt(parsed.port || '5432', 10);
    const containerName = normalizeDockerContainerName(
        plan.dockerContainerName,
        `iranti_${plan.instanceName}_db`
    );

    return [{
        kind: 'docker-container',
        name: containerName,
        ...(Number.isFinite(hostPort) && hostPort > 0 ? { healthTcpPort: hostPort } : {}),
    }];
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
    options: { detachedRestart?: DetachedRestartPlan } = {},
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

function windowsDetachedExecutableCandidates(executable: string): string[] {
    const normalized = executable.trim();
    const lower = normalized.toLowerCase();
    const names = lower.endsWith('.cmd') || lower.endsWith('.exe')
        ? [normalized]
        : [`${normalized}.cmd`, `${normalized}.exe`, normalized];
    const candidates = new Set<string>();

    const addDirVariants = (dirPath: string | null | undefined) => {
        if (!dirPath) return;
        for (const name of names) {
            candidates.add(path.join(dirPath, name));
        }
    };

    addDirVariants(process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null);
    addDirVariants(detectGlobalNpmRoot() ? path.dirname(detectGlobalNpmRoot() as string) : null);
    addDirVariants(path.dirname(process.execPath));

    return Array.from(candidates);
}

function resolveWindowsDetachedExecutable(executable: string): string {
    if (!executable || /[;&|<>\n\r`$(){}[\]\\/"']/.test(executable)) {
        throw new Error(`Invalid executable name: "${executable}"`);
    }
    if (path.isAbsolute(executable)) {
        if (!fs.existsSync(executable)) {
            throw new Error(`Detached executable does not exist: ${executable}`);
        }
        return executable;
    }

    for (const candidate of windowsDetachedExecutableCandidates(executable)) {
        if (fs.existsSync(candidate)) {
            return path.resolve(candidate);
        }
    }

    const fallbackCandidates = executable.toLowerCase().endsWith('.cmd') || executable.toLowerCase().endsWith('.exe')
        ? [executable]
        : [`${executable}.cmd`, `${executable}.exe`, executable];
    for (const candidate of fallbackCandidates) {
        const probe = spawnSync('where', [candidate], { encoding: 'utf8' });
        if (probe.status === 0) {
            const resolved = (probe.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
            if (resolved && path.isAbsolute(resolved) && fs.existsSync(resolved)) {
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

    throw new Error(`Unable to resolve detached executable '${executable}' on Windows.`);
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

function buildDetachedRestartCommand(plan: DetachedRestartPlan): string {
    const irantiExecutable = escapeForSingleQuotedPowerShell(resolveWindowsDetachedExecutable('iranti'));
    const instanceName = escapeForSingleQuotedPowerShell(plan.instanceName);
    const scope = escapeForSingleQuotedPowerShell(plan.scope);
    const root = escapeForSingleQuotedPowerShell(plan.root);
    return [
        `$irantiExe = '${irantiExecutable}'`,
        "if (!(Test-Path -LiteralPath $irantiExe)) { throw 'Unable to resolve detached iranti executable for restart.' }",
        `& $irantiExe instance restart '${instanceName}' --scope '${scope}' --root '${root}'`,
        'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    ].join(';\r\n');
}

function scheduleDetachedWindowsGlobalNpmUpgrade(command: UpgradeCommand, detachedRestart?: DetachedRestartPlan): void {
    const neutralCwd = resolveDetachedUpgradeCwd(command);
    const parentPid = process.pid;
    const escapedCwd = escapeForSingleQuotedPowerShell(neutralCwd);
    const detachedExecutable = resolveWindowsDetachedExecutable(command.executable);
    const escapedExecutable = escapeForSingleQuotedPowerShell(detachedExecutable);
    const escapedArgs = command.args.map((arg) => `'${escapeForSingleQuotedPowerShell(arg)}'`).join(', ');
    const restartScript = detachedRestart ? buildDetachedRestartCommand(detachedRestart) : null;
    const script = [
        `$parentPid = ${parentPid}`,
        'while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }',
        `Set-Location -LiteralPath '${escapedCwd}'`,
        `& '${escapedExecutable}' @(${escapedArgs})`,
        ...(restartScript ? [`if ($LASTEXITCODE -eq 0) { ${restartScript} }`] : []),
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
    options: { detachedRestart?: DetachedRestartPlan } = {},
): Promise<UpgradeExecutionResult> {
    if (target === 'npm-repo' && repoIsDirty(context.packageRootPath)) {
        throw new Error('Repository worktree is dirty. Commit or stash changes before running `iranti upgrade --target npm-repo --yes`.');
    }

    const commands = commandListForTarget(target, context);
    const steps: Array<{ label: string; command: string }> = [];
    if (target === 'npm-global' && canScheduleWindowsGlobalNpmSelfUpgrade(context)) {
        const command = commands[0]!;
        console.log(`${infoLabel()} ${command.display} (scheduled in a detached updater because the current Windows CLI cannot replace its own live global install)`);
        scheduleDetachedWindowsGlobalNpmUpgrade(command, options.detachedRestart);
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

function parentPidFor(pid: number): number | null {
    if (!pid || pid <= 1) return null;

    if (process.platform === 'win32') {
        const probe = runCommandCapture('powershell', [
            '-NoProfile',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
        ]);
        if (probe.status !== 0) return null;
        const parsed = Number.parseInt(probe.stdout.trim(), 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    const probe = runCommandCapture('ps', ['-o', 'ppid=', '-p', String(pid)]);
    if (probe.status !== 0) return null;
    const parsed = Number.parseInt(probe.stdout.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function currentProcessFamilyPids(): Set<number> {
    const protectedPids = new Set<number>([process.pid]);
    let current = process.ppid;

    while (current && current > 1 && !protectedPids.has(current)) {
        protectedPids.add(current);
        current = parentPidFor(current) ?? 0;
    }

    return protectedPids;
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
    const protectedPids = currentProcessFamilyPids();
    for (const runtimeRoot of runtimeRoots) {
        const instances = await collectRuntimeInstanceSummaries(runtimeRoot.path);
        for (const instance of instances) {
            const pid = instance.runtime.state?.pid;
            if (!instance.runtime.running || !pid || protectedPids.has(pid)) continue;
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
                    if (!pid || protectedPids.has(pid) || !command) continue;
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
                if (!pid || protectedPids.has(pid)) continue;
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
    let next: Record<string, unknown> = { ...value };
    let changed = false;

    const stripServerMap = (field: 'mcpServers' | 'servers'): void => {
        const current = next[field];
        if (!current || typeof current !== 'object' || Array.isArray(current)) return;
        const nextServers = { ...(current as Record<string, unknown>) };
        if (!Object.prototype.hasOwnProperty.call(nextServers, 'iranti')) return;
        delete nextServers.iranti;
        changed = true;
        if (Object.keys(nextServers).length === 0) {
            delete next[field];
        } else {
            next[field] = nextServers;
        }
    };

    stripServerMap('mcpServers');
    stripServerMap('servers');

    if (!changed) return value;
    return Object.keys(next).length === 0 ? null : next;
}

function removeIrantiClaudeHooksFromValue(value: Record<string, unknown>): Record<string, unknown> | null {
    const hooks = isClaudeHooksObject(value.hooks) ? value.hooks : null;
    if (!hooks) return value;

    const nextHooks: Record<string, unknown> = { ...hooks };
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop'] as const) {
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

function removeIrantiAgentsBlockFromText(value: string): string | null {
    if (!value.includes('<!-- iranti-rules -->')) return value;

    const next = value
        .replace(/<!-- iranti-rules -->[\s\S]*?<!-- \/iranti-rules -->/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return next.length === 0 ? null : `${next}\n`;
}

type ProjectUnbindCleanupResult = {
    removed: string[];
    updated: string[];
    warnings: string[];
};

async function cleanupProjectBindingIntegrations(projectPath: string): Promise<ProjectUnbindCleanupResult> {
    const result: ProjectUnbindCleanupResult = { removed: [], updated: [], warnings: [] };
    const candidates = [
        path.join(projectPath, '.mcp.json'),
        path.join(projectPath, '.vscode', 'mcp.json'),
    ];

    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        const parsed = readJsonFile<Record<string, unknown>>(candidate);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            result.warnings.push(`Skipped unreadable MCP file ${candidate}`);
            continue;
        }
        const next = removeIrantiMcpServerFromValue(parsed);
        if (next === parsed) continue;
        if (!next) {
            await fsp.rm(candidate, { force: true });
            result.removed.push(candidate);
        } else {
            await writeText(candidate, `${JSON.stringify(next, null, 2)}\n`);
            result.updated.push(candidate);
        }
    }

    const claudeSettingsFile = path.join(projectPath, '.claude', 'settings.local.json');
    if (fs.existsSync(claudeSettingsFile)) {
        const parsed = readJsonFile<Record<string, unknown>>(claudeSettingsFile);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            result.warnings.push(`Skipped unreadable Claude settings file ${claudeSettingsFile}`);
        } else {
            const next = removeIrantiClaudeHooksFromValue(parsed);
            if (next !== parsed) {
                if (!next) {
                    await fsp.rm(claudeSettingsFile, { force: true });
                    result.removed.push(claudeSettingsFile);
                } else {
                    await writeText(claudeSettingsFile, `${JSON.stringify(next, null, 2)}\n`);
                    result.updated.push(claudeSettingsFile);
                }
            }
        }
    }

    const agentsFile = path.join(projectPath, 'AGENTS.md');
    if (fs.existsSync(agentsFile)) {
        try {
            const existing = await fsp.readFile(agentsFile, 'utf8');
            const next = removeIrantiAgentsBlockFromText(existing);
            if (next !== existing) {
                if (!next) {
                    await fsp.rm(agentsFile, { force: true });
                    result.removed.push(agentsFile);
                } else {
                    await writeText(agentsFile, next);
                    result.updated.push(agentsFile);
                }
            }
        } catch {
            result.warnings.push(`Skipped unreadable Codex agents file ${agentsFile}`);
        }
    }

    return result;
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

        if (artifact.agentsFile && fs.existsSync(artifact.agentsFile)) {
            try {
                const existing = await fsp.readFile(artifact.agentsFile, 'utf8');
                const next = removeIrantiAgentsBlockFromText(existing);
                if (next !== existing) {
                    if (!next) {
                        await fsp.rm(artifact.agentsFile, { force: true });
                        results.push({
                            label: 'project-agents',
                            status: 'pass',
                            detail: `Removed ${artifact.agentsFile}`,
                        });
                    } else {
                        await writeText(artifact.agentsFile, next);
                        results.push({
                            label: 'project-agents',
                            status: 'pass',
                            detail: `Removed Iranti Codex block from ${artifact.agentsFile}`,
                        });
                    }
                }
            } catch {
                results.push({
                    label: 'project-agents',
                    status: 'warn',
                    detail: `Skipped unreadable text file ${artifact.agentsFile}`,
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
                [artifact.bindingFile, artifact.mcpFile, artifact.claudeSettingsFile, artifact.agentsFile]
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
        const plan = configPath ? await parseSetupConfig(configPath) : await defaultsSetupPlan(args);
        const result = await executeSetupPlan(plan);

        console.log(sectionTitle('Setup Complete'));
        console.log(`  runtime root   ${result.root}`);
        console.log(`  scope          ${result.scope}`);
        console.log(`  instance       ${result.instanceName}`);
        console.log(`  instance env   ${result.instanceEnvFile}`);
        console.log(`  instance url   http://localhost:${result.port}`);
        console.log(`  memory mode    ${result.mode}`);
        console.log(`  database mode  ${result.databaseMode}`);
        console.log(`  db strategy    ${describeInstanceDatabaseIntent(result.databaseIntent)}`);
        if (result.bindings.length === 0) {
            console.log(`  projects       ${paint('none bound yet', 'yellow')}`);
        } else {
            console.log('  projects');
            for (const binding of result.bindings) {
                const learningSuffix = binding.learningStatus.status === 'written'
                    ? `, learned=${binding.codebaseEntity}`
                    : `, project-learning=${binding.learningStatus.status}`;
                console.log(`    - ${binding.projectPath} (${binding.agentId}, ${binding.projectMode}${learningSuffix})`);
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
        printChoiceGuide('Runtime Mode Choices', [
            {
                choice: 'isolated',
                meaning: 'one project gets its own runtime root and usually its own instance boundary',
                useWhen: 'one repo should stay self-contained and you do not want other repos sharing its memory/runtime by default.',
            },
            {
                choice: 'shared',
                meaning: 'multiple projects can bind to the same runtime root and instances under it',
                useWhen: 'several repos should intentionally share one Iranti instance and memory space.',
            },
        ]);
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
            printWizardNotes('Isolated Runtime Path', [
                'This folder becomes the runtime root for this isolated setup.',
                'Iranti stores instance env files, runtime metadata, logs, and install metadata under this root.',
                'Use a project-local path like `<repo>/.iranti-runtime` when one repo should own its own runtime.',
            ]);
            finalRoot = path.resolve(await promptNonEmpty(
                prompt,
                'Isolated runtime path',
                explicitRoot ?? path.join(process.cwd(), '.iranti-runtime')
            ));
            finalScope = 'user';
        } else {
            printWizardNotes('Shared Runtime Scope', [
                'Shared mode uses one runtime root that can hold multiple named instances.',
                'Choose `user` for a per-user machine install. Choose `system` only when you deliberately want a machine-wide shared location.',
                'Use `--root` instead when you need an exact custom shared runtime path.',
            ]);
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
        const existingInstanceMeta = fs.existsSync(instancePaths(finalRoot, instanceName).metaFile)
            ? await readInstanceMetaFile(instancePaths(finalRoot, instanceName).metaFile)
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
        let databaseIntentStrategy: DatabaseIntentStrategy | null = null;
        printChoiceGuide('Database Mode Choices', [
            {
                choice: 'local',
                meaning: 'use PostgreSQL already running on this machine',
                useWhen: 'you already have local Postgres with pgvector, or want Iranti to reuse a local developer database.',
            },
            {
                choice: 'docker',
                meaning: 'start or reuse a local PostgreSQL container just for the database',
                useWhen: 'you want a reliable local pgvector path without managing a direct host Postgres install.',
            },
            {
                choice: 'managed',
                meaning: 'use a remote PostgreSQL connection string you already control',
                useWhen: 'your database lives on Railway, Supabase, Neon, or another hosted PostgreSQL service.',
            },
        ]);
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
                databaseIntentStrategy = parseDatabaseIntentStrategyFlag(
                    await prompt.line(
                        'Database intent (dedicated, shared, external)',
                        databaseIntentPromptValue(
                            resolveInstanceDatabaseIntent({
                                instanceName,
                                env: existingInstance?.env ?? { DATABASE_URL: dbUrl },
                                meta: existingInstanceMeta,
                                dependencies: parseInstanceDependencies(existingInstanceMeta?.dependencies).dependencies,
                            }).intent?.strategy
                            ?? inferDatabaseIntentStrategy({ instanceName, databaseMode, databaseUrl: dbUrl })
                        )
                    ),
                    'database intent'
                );
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
                dbUrl = `postgresql://postgres:${dbPassword}@${preferredLocalDatabaseHost()}:${dbHostPort}/${dbName}`;
                databaseIntentStrategy = parseDatabaseIntentStrategyFlag(
                    await prompt.line(
                        'Database intent (dedicated, shared, external)',
                        databaseIntentPromptValue(
                            resolveInstanceDatabaseIntent({
                                instanceName,
                                env: existingInstance?.env ?? { DATABASE_URL: dbUrl },
                                meta: existingInstanceMeta,
                                dependencies: dockerContainerName
                                    ? [{ kind: 'docker-container', name: dockerContainerName, ...(dbHostPort > 0 ? { healthTcpPort: dbHostPort } : {}) }]
                                    : parseInstanceDependencies(existingInstanceMeta?.dependencies).dependencies,
                            }).intent?.strategy
                            ?? inferDatabaseIntentStrategy({ instanceName, databaseMode, databaseUrl: dbUrl })
                        )
                    ),
                    'database intent'
                );

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
        printChoiceGuide('Provider Choices', [
            {
                choice: 'mock',
                meaning: 'local development provider with no remote API key requirement',
                useWhen: 'you want to validate setup and runtime behavior before spending money on a remote model provider.',
            },
            {
                choice: 'openai / claude / gemini / groq / mistral',
                meaning: 'remote hosted model providers that need an upstream API key',
                useWhen: 'you want real model-backed Iranti behavior and already have a provider key.',
            },
            {
                choice: 'ollama',
                meaning: 'local Ollama runtime instead of a hosted provider',
                useWhen: 'you want local model execution and already run Ollama on the machine.',
            },
        ]);
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
        printWizardNotes('Project Binding', [
            'Binding a project writes `.env.iranti` into one specific repo or app folder.',
            'Use the project root that should contain the binding file, not a broad parent folder like your whole `Projects` directory.',
            'In shared mode you can bind multiple repos to the same instance. In isolated mode you normally bind one repo.',
        ]);
        let shouldBindProject = await promptYesNo(prompt, 'Bind a project folder to this instance now?', true);
        while (shouldBindProject) {
            const projectPath = path.resolve(await promptNonEmpty(prompt, 'Project path to bind', projects.length === 0 ? defaultProjectPath : process.cwd()));
            const agentId = sanitizeIdentifier(
                await promptNonEmpty(prompt, 'Project agent ID', projectAgentDefault(projectPath)),
                'project_main'
            );
            printWizardNotes('Project Memory Entity', [
                'This is the durable memory namespace the project will use by default.',
                'Use a stable entity like `project/my_repo` when the repo should have its own long-lived shared memory identity.',
                'Use a narrower entity only when you intentionally want this project bound to some other memory namespace.',
            ]);
            const memoryEntity = await promptNonEmpty(prompt, 'Project memory entity', 'user/main');
            const personalMemoryEntity = await promptNonEmpty(prompt, 'Personal memory entity', 'user/main');
            const autoRemember = await promptYesNo(prompt, 'Enable strict auto-remember for this project binding?', false);
            const claudeCode = await promptYesNo(prompt, 'Create Claude Code project files here now?', true);
            projects.push({
                path: projectPath,
                agentId,
                memoryEntity,
                personalMemoryEntity,
                projectMode: setupMode,
                autoRemember,
                claudeCode,
            });
            if (setupMode === 'shared') {
                shouldBindProject = await promptYesNo(prompt, 'Bind another project folder?', false);
            } else {
                shouldBindProject = false;
            }
        }

        if (projects.length > 0 && hasCodexInstalled()) {
            printWizardNotes('Codex Registration', [
                'This registers Iranti with the global Codex CLI MCP config.',
                'Say yes when this machine should let Codex call Iranti tools from bound projects.',
                'Say no if you are not using Codex yet or do not want to touch the global Codex config right now.',
            ]);
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
            databaseIntent: buildInstanceDatabaseIntent({
                instanceName,
                databaseMode,
                databaseUrl: dbUrl,
                strategy: databaseIntentStrategy,
                dockerContainerName,
            }),
            provider,
            providerKeys,
            apiKey: defaultApiKey,
            projects,
            codex,
            codexAgent: projects[0]?.agentId,
            bootstrapDatabase,
            dockerContainerName,
            databaseProvisioned,
            dependencies: inferSetupDependencies({
                databaseMode,
                databaseUrl: dbUrl,
                dockerContainerName,
                instanceName,
            }),
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
    console.log(`  db strategy    ${describeInstanceDatabaseIntent(finalResult.databaseIntent)}`);
    if (finalResult.bindings.length === 0) {
            console.log(`  projects       ${paint('none bound yet', 'yellow')}`);
    } else {
        console.log('  projects');
        for (const binding of finalResult.bindings) {
            const learningSuffix = binding.learningStatus.status === 'written'
                ? `, codebase=${binding.codebaseEntity}`
                : `, project-learning=${binding.learningStatus.status}`;
            console.log(`    - ${binding.projectPath} (${binding.agentId}, ${binding.projectMode}, auto-remember=${binding.autoRemember ? 'true' : 'false'}${learningSuffix})`);
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
    const scope = normalizeScope(getFlag(args, 'scope'));
    const { envFile, envSource } = resolveDoctorEnvTarget(args);
    const repoEnvFile = findClosestAncestorFile(process.cwd(), '.env');
    const resolution = resolveInstallRootDetails(args, scope);
    const discovery: DoctorDiscovery = {
        selectedRuntimeRoot: resolution.root,
        selectionSource: resolution.source,
        selectionReason: describeRuntimeRootSource(resolution.source),
        boundRuntimeRoot: null,
        boundInstanceEnv: null,
        projectBindingFile: null,
        projectBindingSource: null,
        rootMismatch: false,
        otherRuntimeRoots: [],
    };

    const checks: DoctorCheck[] = [];
    let authority: OperatorAuthoritySummary = {
        activeAuthority: summarizeActiveAuthority(envSource, null, null),
        activeBindingSource: null,
        activeBoundInstanceEnv: null,
        activeDatabaseUrl: null,
        activeDatabaseTarget: null,
        repoDatabaseUrl: null,
        repoDatabaseTarget: null,
        repoDatabaseDiffers: false,
        nearbyBindingSource: null,
        nearbyBoundInstanceEnv: null,
        nearbyBindingDatabaseUrl: null,
        nearbyBindingDatabaseTarget: null,
        nearbyBindingDiffers: false,
    };
    const version = getPackageVersion();
    const pushEnvironmentChecks = async (env: Record<string, string>, prefix = ''): Promise<void> => {
        const databaseUrl = env.DATABASE_URL;
        let databaseInitializedForDoctor = false;
        checks.push(detectStartupSecurityPosture(env, prefix));
        const runtimeAuthorityCheck = detectRuntimeAuthorityCheck(env, prefix);
        if (runtimeAuthorityCheck) checks.push(runtimeAuthorityCheck);
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
                initDb(databaseUrl, { applicationName: 'iranti:cli:doctor' });
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
                status: reachable ? 'pass' : 'fail',
                detail: url
                    ? `${backendName} (${url}) is ${reachable ? 'reachable' : 'unreachable'}`
                    : `${backendName} is ${reachable ? 'reachable' : 'unreachable'}`,
            });
            if (reachable) {
                const consistency = await auditVectorIndexConsistency(undefined);
                checks.push({
                    name: `${prefix}vector index consistency`,
                    status: consistency.consistent ? 'pass' : 'warn',
                    detail: consistency.consistent
                        ? `${backendName} index matches ${consistency.expectedCount} expected KB entries.`
                        : `${backendName} drift detected: ${consistency.missingEntryIds.length} missing embeddings, ${consistency.orphanedVectorIds.length} orphaned vectors.`,
                });
            }
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
        let linkedInstanceEnvFile: string | null = null;
        let linkedEnv: Record<string, string> | null = null;
        checks.push({
            name: 'environment file',
            status: 'pass',
            detail: `${envSource} env loaded from ${envFile}`,
        });

        if (treatAsProjectBinding) {
            const binding = await inspectProjectBinding(envFile);
            const boundRuntimeRoot = binding.runtimeRoot ? path.resolve(binding.runtimeRoot) : null;
            const selectedRuntimeRoot = path.resolve(resolution.root);
            const otherRuntimeRoots = Array.from(new Set(
                [boundRuntimeRoot]
                    .filter((candidate): candidate is string => Boolean(candidate))
                    .filter((candidate) => candidate !== selectedRuntimeRoot && fs.existsSync(candidate))
            ));
            discovery.boundRuntimeRoot = boundRuntimeRoot;
            discovery.boundInstanceEnv = binding.instanceEnvFile;
            discovery.projectBindingFile = binding.bindingFile;
            discovery.projectBindingSource = 'doctor-target';
            discovery.rootMismatch = Boolean(boundRuntimeRoot && boundRuntimeRoot !== selectedRuntimeRoot);
            discovery.otherRuntimeRoots = otherRuntimeRoots;
            checks.push({
                name: 'runtime root selection',
                status: discovery.rootMismatch ? 'warn' : 'pass',
                detail: discovery.rootMismatch
                    ? `Doctor selected runtime root ${selectedRuntimeRoot} (${describeRuntimeRootSource(resolution.source)}), but the project binding points at ${boundRuntimeRoot}.`
                    : `Doctor selected runtime root ${selectedRuntimeRoot} (${describeRuntimeRootSource(resolution.source)}).`,
            });
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
            checks.push(detectVsCodeMcpWorkspaceCheck(envFile));
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
            linkedInstanceEnvFile = env.IRANTI_INSTANCE_ENV?.trim() || null;
            if (!linkedInstanceEnvFile) {
                checks.push({
                    name: 'bound instance env',
                    status: 'warn',
                    detail: 'IRANTI_INSTANCE_ENV is not set in .env.iranti. Skipping database and provider checks for the bound instance.',
                });
            } else if (!fs.existsSync(linkedInstanceEnvFile)) {
                checks.push({
                    name: 'bound instance env',
                    status: 'warn',
                    detail: `Linked instance env not found: ${linkedInstanceEnvFile}. Skipping database and provider checks for the bound instance.`,
                });
            } else {
                checks.push({
                    name: 'bound instance env',
                    status: 'pass',
                    detail: `Using ${linkedInstanceEnvFile} for bound instance diagnostics.`,
                });
                linkedEnv = await readEnvFile(linkedInstanceEnvFile);
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

        const nearbyProjectBindingFile = treatAsProjectBinding
            ? null
            : findClosestAncestorFile(path.dirname(envFile), '.env.iranti');
        const nearbyBindingEnv = await readEnvFileIfExists(nearbyProjectBindingFile);
        const nearbyBoundInstanceEnvFile = nearbyBindingEnv?.IRANTI_INSTANCE_ENV?.trim() || null;
        const nearbyBoundInstanceEnv = await readEnvFileIfExists(nearbyBoundInstanceEnvFile);

        authority = await buildOperatorAuthoritySummary({
            envSource,
            envFile,
            env,
            bindingFile: treatAsProjectBinding ? envFile : null,
            boundInstanceEnvFile: linkedInstanceEnvFile,
            boundInstanceEnv: linkedEnv,
            repoEnvFile,
            nearbyBindingFile: nearbyProjectBindingFile,
            nearbyBoundInstanceEnvFile,
            nearbyBoundInstanceEnv,
        });
        if (!treatAsProjectBinding && authority.nearbyBindingSource && authority.nearbyBindingDiffers) {
            checks.push({
                name: 'nearby project binding authority',
                status: 'warn',
                detail: `Repo env is the active doctor target, but nearby project binding ${authority.nearbyBindingSource} points at ${authority.nearbyBindingDatabaseTarget ?? 'an unknown database target'} via ${authority.nearbyBoundInstanceEnv ?? 'an unknown bound env'}. Direct DB checks against repo .env may miss facts stored in the bound instance DB.`,
            });
        }
    }

    debugLog('Doctor authority summary resolved.', {
        activeAuthority: authority.activeAuthority,
        activeBindingSource: authority.activeBindingSource ?? null,
        activeBoundInstanceEnv: authority.activeBoundInstanceEnv ?? null,
        activeDatabaseTarget: authority.activeDatabaseTarget ?? null,
        repoDatabaseTarget: authority.repoDatabaseTarget ?? null,
        repoDatabaseDiffers: authority.repoDatabaseDiffers,
        nearbyBindingSource: authority.nearbyBindingSource ?? null,
        nearbyBindingDatabaseTarget: authority.nearbyBindingDatabaseTarget ?? null,
        nearbyBindingDiffers: authority.nearbyBindingDiffers,
    });

    const result = {
        version,
        envSource,
        envFile,
        authority,
        selectedRuntimeRoot: discovery.selectedRuntimeRoot,
        selectedRuntimeRootSource: discovery.selectionSource,
        boundRuntimeRoot: discovery.boundRuntimeRoot,
        boundInstanceEnv: discovery.boundInstanceEnv,
        rootMismatch: discovery.rootMismatch,
        otherRuntimeRoots: discovery.otherRuntimeRoots,
        discovery,
        status: summarizeStatus(checks),
        checks,
        remediations: collectDoctorRemediations(checks, envSource, envFile),
    };

    if (json) {
        if (result.status !== 'pass') {
            process.exitCode = 1;
        }
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
    console.log(`  authority : ${authority.activeAuthority}`);
    if (authority.activeBindingSource) console.log(`  binding   : ${authority.activeBindingSource}`);
    if (authority.activeBoundInstanceEnv) console.log(`  bound env : ${authority.activeBoundInstanceEnv}`);
    if (authority.activeDatabaseTarget) console.log(`  active db : ${authority.activeDatabaseTarget}`);
    if (authority.activeDatabaseUrl) console.log(`  active url: ${authority.activeDatabaseUrl}`);
    if (authority.repoDatabaseDiffers && authority.repoDatabaseTarget) {
        console.log(`  repo db   : ${authority.repoDatabaseTarget} (repo .env differs)`);
    }
    if (authority.nearbyBindingDiffers) {
        if (authority.nearbyBindingSource) console.log(`  nearby binding : ${authority.nearbyBindingSource}`);
        if (authority.nearbyBoundInstanceEnv) console.log(`  nearby bound env: ${authority.nearbyBoundInstanceEnv}`);
        if (authority.nearbyBindingDatabaseTarget) console.log(`  nearby db : ${authority.nearbyBindingDatabaseTarget} (binding differs)`);
    }
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
    const projectBindingEnv = await readEnvFileIfExists(projectEnv);
    const boundInstanceEnvMap = await readEnvFileIfExists(boundInstanceEnv);
    const activeStatusEnv = projectEnv && fs.existsSync(projectEnv)
        ? projectBindingEnv
        : await readEnvFileIfExists(repoEnv);
    const authority = await buildOperatorAuthoritySummary({
        envSource: projectEnv && fs.existsSync(projectEnv) ? 'project-binding' : repoEnv && fs.existsSync(repoEnv) ? 'repo' : 'environment',
        envFile: projectEnv && fs.existsSync(projectEnv)
            ? projectEnv
            : repoEnv && fs.existsSync(repoEnv)
                ? repoEnv
                : null,
        env: activeStatusEnv,
        bindingFile: projectEnv && fs.existsSync(projectEnv) ? projectEnv : null,
        boundInstanceEnvFile: boundInstanceEnv,
        boundInstanceEnv: boundInstanceEnvMap,
        repoEnvFile: repoEnv,
    });
    const rootMismatch = Boolean(boundRuntimeRoot && path.resolve(boundRuntimeRoot) !== path.resolve(root));
    const userInstallRuntimeRoot = fs.existsSync(path.join(resolution.userRoot, 'install.json')) ? resolution.userRoot : null;
    const systemInstallRuntimeRoot = fs.existsSync(path.join(resolution.systemRoot, 'install.json')) ? resolution.systemRoot : null;
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
    rows.push({ label: 'authority', value: authority.activeAuthority });
    if (authority.activeBindingSource) rows.push({ label: 'binding_source', value: authority.activeBindingSource });
    if (authority.activeBoundInstanceEnv) rows.push({ label: 'bound_instance_env', value: authority.activeBoundInstanceEnv });
    if (authority.activeDatabaseTarget) rows.push({ label: 'active_db_target', value: authority.activeDatabaseTarget });
    if (authority.activeDatabaseUrl) rows.push({ label: 'active_db_url', value: authority.activeDatabaseUrl });
    if (authority.repoDatabaseDiffers && authority.repoDatabaseTarget) {
        rows.push({ label: 'repo_db_target', value: `${authority.repoDatabaseTarget} (repo .env differs)` });
    }
    if (boundRuntimeRoot) rows.push({ label: 'bound_root', value: boundRuntimeRoot });
    rows.push({ label: 'repo_env', value: repoEnv && fs.existsSync(repoEnv) ? repoEnv : '(missing)' });
    rows.push({ label: 'project_binding', value: projectEnv && fs.existsSync(projectEnv) ? projectEnv : '(missing)' });
    rows.push({ label: 'install_meta', value: fs.existsSync(installMetaPath) ? installMetaPath : '(not initialized)' });
    if (rootMismatch) rows.push({ label: 'root_mismatch', value: 'project binding points at a different runtime root' });

    const instances = await collectRuntimeInstanceSummaries(root);
    const recommendedActions = Array.from(new Set(instances.flatMap((instance) => instance.repairHints)));

    debugLog('Status authority summary resolved.', {
        activeAuthority: authority.activeAuthority,
        activeBindingSource: authority.activeBindingSource ?? null,
        activeBoundInstanceEnv: authority.activeBoundInstanceEnv ?? null,
        activeDatabaseTarget: authority.activeDatabaseTarget ?? null,
        repoDatabaseTarget: authority.repoDatabaseTarget ?? null,
        repoDatabaseDiffers: authority.repoDatabaseDiffers,
    });

    if (json) {
        console.log(JSON.stringify({
            version: getPackageVersion(),
            scope,
            runtimeRoot: root,
            runtimeRootSource: resolution.source,
            authority,
            discovery: {
                selectedRuntimeRoot: root,
                selectionSource: resolution.source,
                selectionReason: describeRuntimeRootSource(resolution.source),
                boundRuntimeRoot,
                boundInstanceEnv,
                ancestorRuntimeRoot: localRuntimeRoot,
                userInstallRuntimeRoot,
                systemInstallRuntimeRoot,
                projectBindingFile: projectEnv && fs.existsSync(projectEnv) ? projectEnv : null,
                projectBindingSource: projectEnv && fs.existsSync(projectEnv) ? 'ancestor-project-binding' : null,
                repoEnvFile: repoEnv && fs.existsSync(repoEnv) ? repoEnv : null,
                rootMismatch,
                otherRuntimeRoots,
            },
            boundRuntimeRoot,
            boundInstanceEnv,
            rootMismatch,
            otherRuntimeRoots,
            repoEnv: repoEnv && fs.existsSync(repoEnv) ? repoEnv : null,
            projectBinding: projectEnv && fs.existsSync(projectEnv) ? projectEnv : null,
            installMeta: fs.existsSync(installMetaPath) ? installMetaPath : null,
            recommendedActions,
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
            if (instance.projectCount === 0) {
                console.log('    projects: none bound');
            } else {
                console.log(`    projects: ${instance.projectCount}`);
                for (const project of instance.boundProjects) {
                    console.log(`      - ${project.projectPath} (${project.agentId}, ${project.mode})`);
                }
            }
            if (instance.repairHints.length > 0) {
                console.log('    hints:');
                for (const hint of instance.repairHints) {
                    console.log(`      - ${hint}`);
                }
            }
            if (instance.runtime.state?.healthUrl) {
                console.log(`    health: ${instance.runtime.state.healthUrl}`);
            }
        }

        if (recommendedActions.length > 0) {
            console.log('');
            console.log('Suggested fixes:');
            for (const action of recommendedActions) {
                console.log(`  - ${action}`);
            }
        }
    }
}

function handoffWriteProperties(key: string): Record<string, unknown> {
    switch (key) {
        case 'status':
            return {
                memoryScope: 'project',
                capturePhase: 'manual',
                durableClass: 'handoff_status',
                canonicalKey: 'status',
                mergeStrategy: 'replace',
                ...buildSemanticFactTags({
                    memoryScope: 'project',
                    durableClass: 'handoff_status',
                    mergeStrategy: 'replace',
                    extraTags: ['handoff', 'task_memory'],
                }),
            };
        case 'next_step':
            return {
                memoryScope: 'project',
                capturePhase: 'manual',
                durableClass: 'next_step',
                canonicalKey: 'next_step',
                mergeStrategy: 'replace',
                ...buildSemanticFactTags({
                    memoryScope: 'project',
                    durableClass: 'next_step',
                    mergeStrategy: 'replace',
                    extraTags: ['handoff', 'task_memory'],
                }),
            };
        case 'current_owner':
            return {
                memoryScope: 'project',
                capturePhase: 'manual',
                durableClass: 'owner',
                canonicalKey: 'current_owner',
                mergeStrategy: 'replace',
                ...buildSemanticFactTags({
                    memoryScope: 'project',
                    durableClass: 'owner',
                    mergeStrategy: 'replace',
                    extraTags: ['handoff', 'task_memory'],
                }),
            };
        case 'blockers':
            return {
                memoryScope: 'project',
                capturePhase: 'manual',
                durableClass: 'open_risks',
                canonicalKey: 'blockers',
                mergeStrategy: 'replace',
                ...buildSemanticFactTags({
                    memoryScope: 'project',
                    durableClass: 'open_risks',
                    mergeStrategy: 'replace',
                    extraTags: ['handoff', 'task_memory', 'blockers'],
                }),
            };
        case 'artifacts':
            return {
                memoryScope: 'project',
                capturePhase: 'manual',
                durableClass: 'artifact',
                canonicalKey: 'artifacts',
                mergeStrategy: 'replace',
                ...buildSemanticFactTags({
                    memoryScope: 'project',
                    durableClass: 'artifact',
                    mergeStrategy: 'replace',
                    extraTags: ['handoff', 'task_memory'],
                }),
            };
        case 'active_handoff_task':
            return {
                memoryScope: 'project',
                capturePhase: 'manual',
                durableClass: 'handoff_task',
                canonicalKey: 'active_handoff_task',
                mergeStrategy: 'replace',
                ...buildSemanticFactTags({
                    memoryScope: 'project',
                    durableClass: 'handoff_task',
                    mergeStrategy: 'replace',
                    extraTags: ['handoff', 'project_memory'],
                }),
            };
        default:
            return {
                memoryScope: 'project',
                capturePhase: 'manual',
                durableClass: 'decision',
                canonicalKey: key,
                mergeStrategy: 'replace',
                ...buildSemanticFactTags({
                    memoryScope: 'project',
                    durableClass: 'decision',
                    mergeStrategy: 'replace',
                    extraTags: ['handoff', 'task_memory'],
                }),
            };
    }
}

async function collectRuntimeInstanceSummaries(root: string): Promise<Array<{
    name: string;
    port: string;
    envFile: string;
    metaFile: string;
    boundProjects: InstanceProjectBindingSummary[];
    projectCount: number;
    config: InstanceConfigSummary;
    runtime: InstanceRuntimeSummary;
    repairHints: string[];
}>> {
    const instancesDir = path.join(root, 'instances');
    const instances: Array<{
        name: string;
        port: string;
        envFile: string;
        metaFile: string;
        boundProjects: InstanceProjectBindingSummary[];
        projectCount: number;
        config: InstanceConfigSummary;
        runtime: InstanceRuntimeSummary;
        repairHints: string[];
    }> = [];
    if (!fs.existsSync(instancesDir)) {
        return instances;
    }

    const entries = await fsp.readdir(instancesDir, { withFileTypes: true });
    for (const entry of entries.filter((value) => value.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const { envFile, metaFile } = instancePaths(root, entry.name);
        const config = await inspectInstanceConfig(root, entry.name);
        const boundProjects = readInstanceProjectRegistry(root, entry.name);
        let port = '(unknown)';
        if (config.state.envPresent && config.state.envReadable) {
            try {
                const env = await readEnvFile(envFile);
                port = env.IRANTI_PORT ?? '(unknown)';
            } catch {
                port = '(unreadable)';
            }
        }
          const runtime = await readInstanceRuntimeSummary(root, entry.name);
          instances.push({
              name: entry.name,
              port,
              envFile: config.state.envPresent ? envFile : '(missing)',
              metaFile: config.state.metaPresent ? metaFile : '(missing)',
              boundProjects,
              projectCount: boundProjects.length,
              config,
              runtime,
              repairHints: buildInstanceRepairHints(entry.name, config, runtime),
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
    const detachedRestart = hasFlag(args, 'restart') && getFlag(args, 'instance')
        ? {
            instanceName: getFlag(args, 'instance')!,
            scope: normalizeScope(getFlag(args, 'scope')),
            root: resolveInstallRoot(args, normalizeScope(getFlag(args, 'scope'))),
        }
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
                detachedRestart,
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
        `postgresql://postgres:yourpassword@${preferredLocalDatabaseHost()}:5432/iranti_${name}`;
    const apiKey = getFlag(args, 'api-key');
    const provider = normalizeProvider(getFlag(args, 'provider')) ?? 'mock';
    const providerKey = getFlag(args, 'provider-key');
    const providerKeyName = providerKeyEnv(provider);
    if (providerKey && !providerKeyName) {
        throw new Error(`Provider '${provider}' does not use a remote API key.`);
    }

    const { instanceDir, envFile, metaFile } = instancePaths(root, name);
    const instanceAlreadyExisted = fs.existsSync(instanceDir);
    const existingEnv = fs.existsSync(envFile)
        ? await readEnvFile(envFile).catch(() => ({} as Record<string, string>))
        : {};
    const apiKeyPepper = resolveInstanceApiKeyPepper(existingEnv.IRANTI_API_KEY_PEPPER);
    if (instanceAlreadyExisted && !hasFlag(args, 'force')) {
        throw new Error(`Instance '${name}' already exists at ${instanceDir}. Use --force to overwrite.`);
    }
    const siblingCollision = findSiblingInstanceCollision(root, name);
    if (siblingCollision && !hasFlag(args, 'force')) {
        throw new Error(
            `Instance '${name}' is too close to existing instance '${siblingCollision.name}' at ${siblingCollision.dir}. ` +
            'For safety, Iranti treats hyphens and underscores as the same identity when creating instances. ' +
            'Choose a more distinct name.'
        );
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

    await writeText(envFile, makeInstanceEnv(name, port, dbUrl, apiKey, instanceDir, apiKeyPepper));
    await upsertEnvFile(envFile, {
        IRANTI_API_KEY_PEPPER: apiKeyPepper,
        LLM_PROVIDER: provider,
        ...(providerKey && providerKeyName ? { [providerKeyName]: providerKey } : {}),
    });
    const resolvedDatabaseIntent = resolveInstanceDatabaseIntent({
        instanceName: name,
        env: { DATABASE_URL: dbUrl },
        meta: null,
        dependencies: [],
    }).intent;
    const meta: InstanceMeta = {
        name,
        createdAt: new Date().toISOString(),
        port,
        envFile,
        instanceDir,
        ...(resolvedDatabaseIntent ? { databaseIntent: resolvedDatabaseIntent } : {}),
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
    const { instanceDir, envFile } = instancePaths(root, name);
    const config = await inspectInstanceConfig(root, name);
    if (!config.state.metaPresent && !config.state.envPresent) throw new Error(`Instance '${name}' not found at ${instanceDir}`);

    const env = config.state.envPresent && config.state.envReadable
        ? await readEnvFile(envFile)
        : {};
    const meta = await readInstanceMetaFile(instancePaths(root, name).metaFile);
    const dependencies = parseInstanceDependencies(meta?.dependencies).dependencies;
    const boundProjects = readInstanceProjectRegistry(root, name);
    const databaseIntent = resolveInstanceDatabaseIntent({
        instanceName: name,
        env,
        meta,
        dependencies,
    });
    const runtime = await readInstanceRuntimeSummary(root, name);
    console.log(bold(`Instance: ${name}`));
    console.log(`  dir : ${instanceDir}`);
    console.log(`  env : ${envFile}`);
    console.log(`  config: ${describeInstanceConfig(config)}`);
    console.log(`  port: ${env.IRANTI_PORT ?? '3001'}`);
    console.log(`  db  : ${env.DATABASE_URL ?? '(missing)'}`);
    if (databaseIntent.intent) {
        console.log(`  db strategy: ${describeInstanceDatabaseIntent(databaseIntent.intent, databaseIntent.source)}`);
    }
    console.log(`  esc : ${env.IRANTI_ESCALATION_DIR ?? '(missing)'}`);
    if (dependencies.length > 0) {
        console.log(`  deps: ${dependencies.map((dependency) => describeInstanceDependency(dependency)).join(', ')}`);
    }
    if (boundProjects.length > 0) {
        console.log('  projects:');
        for (const project of boundProjects) {
            console.log(`    - ${project.projectPath} (${project.agentId}, ${project.mode})`);
        }
    }
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
    const { instanceDir, envFile, runtimeFile, env } = await loadInstanceEnv(root, name);
    const meta = await readInstanceMetaFile(instancePaths(root, name).metaFile);
    const dependencies = parseInstanceDependencies(meta?.dependencies).dependencies;
    const runtime = await readInstanceRuntimeSummary(root, name);
    if (runtime.running) {
        throw cliError(
            'IRANTI_INSTANCE_ALREADY_RUNNING',
            `Instance '${name}' is already running on pid ${runtime.state?.pid ?? '(unknown)'}.`,
            [`Run \`iranti instance restart ${name}\` to restart the live process, or stop the existing process first.`],
            { instance: name, pid: runtime.state?.pid ?? null, runtimeFile }
        );
    }
    if (runtime.classification === 'invalid') {
        throw cliError(
            'IRANTI_INSTANCE_RUNTIME_INVALID',
            `Instance '${name}' has invalid runtime metadata at ${runtimeFile}: ${runtime.detail}.`,
            [
                `Inspect ${runtimeFile} and remove foreign or malformed runtime metadata before retrying.`,
                `Run \`iranti status --json --root ${root}\` to confirm the instance classification.`,
            ],
            { instance: name, runtimeFile, detail: runtime.detail }
        );
    }
    if (runtime.stale) {
        console.log(`${warnLabel()} Found stale runtime metadata for '${name}' at ${runtimeFile}; starting a fresh process.`);
    }
    applyManagedInstanceEnv(env);
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
    if (dependencies.length > 0) {
        console.log(`${infoLabel()} Ensuring instance dependencies are ready...`);
        const ensured = await ensureInstanceDependenciesHealthy(dependencies, { cwd: instanceDir });
        if (ensured.started.length > 0) {
            console.log(`${okLabel()} Started dependency containers: ${ensured.started.join(', ')}`);
        }
        if (ensured.alreadyRunning.length > 0) {
            console.log(`${infoLabel()} Dependency containers already running: ${ensured.alreadyRunning.join(', ')}`);
        }
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

    console.log(sectionTitle('Instance Restarted'));
    console.log(`  status    ${okLabel()}`);
    console.log(`  instance  ${name}`);
    console.log(`  env       ${envFile}`);
    if (restarted.previousPid) {
        console.log(`  previous  ${restarted.previousPid}`);
    }
    console.log(`  new_pid   ${restarted.newPid || '(unknown)'}`);
    console.log(`  runtime   ${restarted.runtimeBefore.running ? 'was running' : restarted.runtimeBefore.state ? 'was stale/stopped' : 'no prior runtime metadata'}`);
    console.log(`  health    verified`);
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
    const autoRemember = resolveOptionalBooleanFlag(args, 'auto-remember') ?? false;

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
        IRANTI_PERSONAL_MEMORY_ENTITY: getFlag(args, 'personal-memory-entity') ?? 'user/main',
        IRANTI_AUTO_REMEMBER: String(autoRemember),
        IRANTI_PROJECT_MODE: projectMode,
        IRANTI_INSTANCE: instanceName,
        IRANTI_INSTANCE_ENV: envFile,
    });
    const writtenBinding = await readEnvFile(outFile);
    const learningStatus = await writeProjectLearningSnapshot({
        projectPath,
        projectEnvFile: outFile,
        binding: writtenBinding,
        agentId,
    });

    console.log(sectionTitle('Project Initialized'));
    console.log(`  status ${okLabel()}`);
    console.log(`  wrote ${outFile}`);
    console.log(`  mode  ${projectMode}`);
    console.log(`  codebase ${writtenBinding.IRANTI_CODEBASE_ENTITY ?? deriveProjectCodebaseEntity(projectPath)}`);
    if (learningStatus.status !== 'written') {
        console.log(`  learn ${paint(learningStatus.status, learningStatus.status === 'failed' ? 'red' : 'yellow')} (${learningStatus.detail})`);
    }
    printNextSteps([
        `iranti doctor --instance ${instanceName}`,
        'iranti chat',
    ]);
}

async function projectUnbindCommand(args: ParsedArgs): Promise<void> {
    const projectPath = path.resolve(args.positionals[0] ?? process.cwd());
    const bindingFile = path.join(projectPath, '.env.iranti');
    if (!fs.existsSync(bindingFile)) {
        throw cliError(
            'IRANTI_PROJECT_BINDING_NOT_FOUND',
            `Project binding not found at ${bindingFile}.`,
            ['Run `iranti project init . --instance <name>` first, or point `iranti project unbind` at a bound repo root.'],
            { projectPath, bindingFile }
        );
    }

    const binding = await readEnvFile(bindingFile);
    const keepIntegrations = hasFlag(args, 'keep-integrations');
    const registryInstances = await cleanupProjectBindingRegistry(projectPath, binding);
    await fsp.rm(bindingFile, { force: true });

    const integrationCleanup = keepIntegrations
        ? { removed: [] as string[], updated: [] as string[], warnings: [] as string[] }
        : await cleanupProjectBindingIntegrations(projectPath);

    const json = hasFlag(args, 'json');
    const result = {
        projectPath,
        bindingFile,
        removedBinding: true,
        cleanedRegistryInstances: registryInstances,
        keepIntegrations,
        integrationCleanup,
    };

    if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log(sectionTitle('Project Unbound'));
    console.log(`  status     ${okLabel()}`);
    console.log(`  project    ${projectPath}`);
    console.log(`  binding    removed`);
    console.log(`  registry   ${registryInstances.length > 0 ? registryInstances.join(', ') : 'no registry entry found'}`);
    console.log(`  cleanup    ${keepIntegrations ? 'kept local integration files' : 'cleaned local integration files'}`);
    for (const filePath of integrationCleanup.removed) {
        console.log(`  removed    ${filePath}`);
    }
    for (const filePath of integrationCleanup.updated) {
        console.log(`  updated    ${filePath}`);
    }
    for (const warning of integrationCleanup.warnings) {
        console.log(`  warning    ${warning}`);
    }
    printNextSteps([
        'Rebind later with `iranti project init . --instance <name>` if this repo should reconnect to Iranti.',
    ]);
}

async function configureInstanceCommand(args: ParsedArgs): Promise<void> {
    const name = args.positionals[0];
    if (!name) {
        throw new Error('Missing instance name. Usage: iranti configure instance <name> [--provider openai] [--provider-key <token>]');
    }

    const scope = normalizeScope(getFlag(args, 'scope'));
    const root = resolveInstallRoot(args, scope);
    const { instanceDir, envFile, env, config } = await loadInstanceEnv(root, name, { allowRepair: true });
    const currentMeta = await readInstanceMetaFile(instancePaths(root, name).metaFile);
    const currentDependencies = parseInstanceDependencies(currentMeta?.dependencies).dependencies;
    const currentDatabaseIntent = resolveInstanceDatabaseIntent({
        instanceName: name,
        env,
        meta: currentMeta,
        dependencies: currentDependencies,
    });
    const updates: Record<string, string | undefined> = {};

    let portRaw = getFlag(args, 'port');
    let dbUrl = getFlag(args, 'db-url');
    let apiKey = getFlag(args, 'api-key');
    let providerInput = getFlag(args, 'provider');
    let providerKey = getFlag(args, 'provider-key');
    let clearProviderKey = hasFlag(args, 'clear-provider-key');
    let dockerContainerName = getFlag(args, 'docker-container');
    let dockerHealthPortRaw = getFlag(args, 'docker-health-port');
    let dbIntentRaw = getFlag(args, 'db-intent');
    const clearDockerContainer = hasFlag(args, 'clear-docker-container');

    if (hasFlag(args, 'interactive')) {
        await withPromptSession(async (prompt) => {
            printWizardNotes('Interactive Instance Configuration', [
                'This updates one existing instance in place.',
                'API port controls where the Iranti API listens.',
                'DATABASE_URL points at the PostgreSQL database for this instance.',
                'Database intent tells Iranti whether this should be treated as a dedicated local DB, a shared local DB, or an external existing DB.',
                'LLM provider and provider key control which model backend Iranti uses.',
                'Iranti API key is the client credential other tools and project bindings use to authenticate.',
                'Optional Docker dependency settings let `iranti run --instance` start a recorded backing container before the API boots.',
            ]);
            portRaw = await prompt.line('API port', portRaw ?? env.IRANTI_PORT);
            dbUrl = await prompt.line('DATABASE_URL', dbUrl ?? env.DATABASE_URL);
            dbIntentRaw = await prompt.line('Database intent (dedicated, shared, external)', dbIntentRaw ?? databaseIntentPromptValue(currentDatabaseIntent.intent?.strategy));
            providerInput = await prompt.line('LLM provider', providerInput ?? env.LLM_PROVIDER ?? 'mock');
            const interactiveProvider = normalizeProvider(providerInput ?? env.LLM_PROVIDER ?? 'mock');
            const interactiveProviderEnvKey = providerKeyEnv(interactiveProvider);
            if (interactiveProvider && interactiveProviderEnvKey) {
                providerKey = await prompt.secret(`${providerDisplayName(interactiveProvider)} API key`, providerKey ?? env[interactiveProviderEnvKey]);
            }
            apiKey = await prompt.secret('Iranti API key', apiKey ?? env.IRANTI_API_KEY);
            const currentDockerDependency = currentDependencies.find((dependency) => dependency.kind === 'docker-container');
            dockerContainerName = await prompt.line('Docker dependency container (optional)', dockerContainerName ?? currentDockerDependency?.name);
            dockerHealthPortRaw = await prompt.line('Docker dependency health TCP port (optional)', dockerHealthPortRaw ?? (currentDockerDependency?.healthTcpPort ? String(currentDockerDependency.healthTcpPort) : ''));
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
    const requestedDatabaseIntent = parseDatabaseIntentStrategyFlag(dbIntentRaw, '--db-intent');

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

    if (!env.IRANTI_API_KEY_PEPPER?.trim()) {
        updates.IRANTI_API_KEY_PEPPER = resolveInstanceApiKeyPepper();
    }

    let nextDependencies = currentDependencies;
    if (clearDockerContainer) {
        nextDependencies = currentDependencies.filter((dependency) => dependency.kind !== 'docker-container');
    }

    if (dockerHealthPortRaw && !dockerContainerName) {
        throw new Error('--docker-health-port requires --docker-container <name>.');
    }

    if (dockerContainerName) {
        const normalizedName = normalizeDockerContainerName(dockerContainerName, 'iranti_db');
        const dockerHealthPortCandidate = dockerHealthPortRaw
            ? Number.parseInt(dockerHealthPortRaw, 10)
            : undefined;
        if (
            dockerHealthPortRaw
            && (
                dockerHealthPortCandidate === undefined
                || !Number.isFinite(dockerHealthPortCandidate)
                || dockerHealthPortCandidate <= 0
            )
        ) {
            throw new Error(`Invalid --docker-health-port '${dockerHealthPortRaw}'.`);
        }
        const dockerHealthPort = typeof dockerHealthPortCandidate === 'number' && dockerHealthPortCandidate > 0
            ? dockerHealthPortCandidate
            : undefined;
        const withoutDocker = currentDependencies.filter((dependency) => dependency.kind !== 'docker-container');
        nextDependencies = [
            ...withoutDocker,
            {
                kind: 'docker-container',
                name: normalizedName,
                ...(dockerHealthPort ? { healthTcpPort: dockerHealthPort } : {}),
            },
        ];
    }

    if (Object.keys(updates).length === 0) {
        const dependenciesUnchanged = JSON.stringify(nextDependencies) === JSON.stringify(currentDependencies);
        const databaseIntentUnchanged = requestedDatabaseIntent === null;
        if (dependenciesUnchanged && databaseIntentUnchanged) {
            throw new Error('No changes provided. Use flags like --provider, --provider-key, --api-key, --db-url, --db-intent, --port, or the Docker dependency flags.');
        }
    }

    const nextEnv: Record<string, string> = { ...env };
    for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) {
            delete nextEnv[key];
        } else {
            nextEnv[key] = value;
        }
    }

    const nextPortRaw = nextEnv.IRANTI_PORT?.trim();
    const nextPort = Number.parseInt(nextPortRaw ?? '', 10);
    if (!Number.isFinite(nextPort) || nextPort <= 0) {
        throw cliError(
            'IRANTI_INSTANCE_PORT_REQUIRED',
            `Instance '${name}' still needs a valid IRANTI_PORT before it can be considered repaired.`,
            ['Pass `--port <n>` or rerun `iranti configure instance <name> --interactive`.'],
            { instance: name, envFile, port: nextPortRaw ?? null, config: config.classification }
        );
    }
    if (!nextEnv.DATABASE_URL?.trim()) {
        throw cliError(
            'IRANTI_INSTANCE_DATABASE_REQUIRED',
            `Instance '${name}' still needs DATABASE_URL before it can be considered repaired.`,
            ['Pass `--db-url <postgresql://...>` or rerun `iranti configure instance <name> --interactive`.'],
            { instance: name, envFile, config: config.classification }
        );
    }

    const nextDatabaseIntent = buildInstanceDatabaseIntent({
        instanceName: name,
        databaseMode: inferDatabaseProvisioning(nextEnv.DATABASE_URL, nextDependencies),
        databaseUrl: nextEnv.DATABASE_URL,
        strategy: requestedDatabaseIntent ?? currentDatabaseIntent.intent?.strategy,
        dockerContainerName: nextDependencies.find((dependency) => dependency.kind === 'docker-container')?.name,
    });

    await ensureDir(instanceDir);
    await upsertEnvFile(envFile, updates);
    await syncInstanceMeta(root, name, nextPort, {
        dependencies: nextDependencies,
        databaseIntent: nextDatabaseIntent,
    });

    const json = hasFlag(args, 'json');
    const result = {
        instance: name,
        envFile,
        updatedKeys: Object.keys(updates).sort(),
        provider: updates.LLM_PROVIDER ?? env.LLM_PROVIDER ?? 'mock',
        apiKeyChanged: Boolean(apiKey),
        providerKeyChanged: Boolean(providerKey) || hasFlag(args, 'clear-provider-key'),
        databaseIntent: nextDatabaseIntent.strategy,
        dependencies: nextDependencies.map((dependency) => describeInstanceDependency(dependency)),
    };

    if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log(sectionTitle('Instance Updated'));
    console.log(`  status   ${okLabel()}`);
    console.log(`  env      ${envFile}`);
    console.log(`  keys     ${result.updatedKeys.join(', ')}`);
    console.log(`  db       ${describeInstanceDatabaseIntent(nextDatabaseIntent)}`);
    if (result.dependencies.length > 0) {
        console.log(`  deps     ${result.dependencies.join(', ')}`);
    }
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
    let explicitPersonalMemoryEntity: string | undefined = getFlag(args, 'personal-memory-entity');
    let explicitProjectMode: string | undefined = getFlag(args, 'mode');
    let explicitAutoRemember: boolean | undefined = resolveOptionalBooleanFlag(args, 'auto-remember');

    if (hasFlag(args, 'interactive')) {
        await withPromptSession(async (prompt) => {
            printWizardNotes('Interactive Project Configuration', [
                'This updates the `.env.iranti` binding inside one project folder.',
                'Instance name retargets the binding to a named local instance and derives URL/env metadata from it.',
                'Iranti URL and Project API key are the direct connection details the project will use.',
                'Project agent ID is the default agent identity for tools running from this repo.',
                'Project memory entity is the durable namespace the project will use for shared memory.',
                'Project mode should stay `isolated` for repo-local memory or `shared` only when this repo should intentionally share one instance with other repos.',
            ]);
            instanceName = await prompt.line('Instance name', instanceName);
            explicitUrl = await prompt.line('Iranti URL', explicitUrl ?? existing.IRANTI_URL);
            explicitApiKey = await prompt.secret('Project API key', explicitApiKey ?? existing.IRANTI_API_KEY);
            explicitAgentId = await prompt.line('Project agent ID', explicitAgentId ?? existing.IRANTI_AGENT_ID ?? projectAgentDefault(projectPath));
            explicitMemoryEntity = await prompt.line('Project memory entity', explicitMemoryEntity ?? existing.IRANTI_MEMORY_ENTITY ?? 'user/main');
            explicitPersonalMemoryEntity = await prompt.line('Personal memory entity', explicitPersonalMemoryEntity ?? existing.IRANTI_PERSONAL_MEMORY_ENTITY ?? 'user/main');
            explicitAutoRemember = await promptYesNo(prompt, 'Enable strict auto-remember?', explicitAutoRemember ?? envFlagEnabled(existing.IRANTI_AUTO_REMEMBER));
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
        IRANTI_PERSONAL_MEMORY_ENTITY: explicitPersonalMemoryEntity ?? existing.IRANTI_PERSONAL_MEMORY_ENTITY ?? 'user/main',
        IRANTI_AUTO_REMEMBER: String(explicitAutoRemember ?? envFlagEnabled(existing.IRANTI_AUTO_REMEMBER)),
        IRANTI_PROJECT_MODE: normalizeProjectMode(explicitProjectMode, normalizeProjectMode(existing.IRANTI_PROJECT_MODE, inferProjectMode(projectPath, instanceEnvFile))),
        IRANTI_INSTANCE: instanceName ?? existing.IRANTI_INSTANCE,
        IRANTI_INSTANCE_ENV: instanceEnvFile,
    };

    if (!updates.IRANTI_URL) {
        throw new Error('Unable to determine IRANTI_URL. Provide --instance <name> or --url <http://host:port>.');
    }
    if (!updates.IRANTI_API_KEY) {
        throw new Error('Unable to determine IRANTI_API_KEY. Provide --api-key <token> or configure the instance first.');
    }

    const written = await writeProjectBinding(projectPath, updates);
    const writtenBinding = await readEnvFile(written);
    const learningStatus = await writeProjectLearningSnapshot({
        projectPath,
        projectEnvFile: written,
        binding: writtenBinding,
        agentId: updates.IRANTI_AGENT_ID,
    });
    const json = hasFlag(args, 'json');
    const result = {
        projectPath,
        envFile: written,
        url: updates.IRANTI_URL,
        agentId: updates.IRANTI_AGENT_ID,
        autoRemember: updates.IRANTI_AUTO_REMEMBER === 'true',
        projectMode: updates.IRANTI_PROJECT_MODE,
        instance: updates.IRANTI_INSTANCE ?? null,
        codebaseEntity: writtenBinding.IRANTI_CODEBASE_ENTITY ?? deriveProjectCodebaseEntity(projectPath),
        projectLearning: learningStatus,
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
    console.log(`  remember ${updates.IRANTI_AUTO_REMEMBER}`);
    console.log(`  mode     ${updates.IRANTI_PROJECT_MODE}`);
    console.log(`  codebase ${writtenBinding.IRANTI_CODEBASE_ENTITY ?? deriveProjectCodebaseEntity(projectPath)}`);
    if (updates.IRANTI_INSTANCE) {
        console.log(`  instance ${updates.IRANTI_INSTANCE}`);
    }
    if (learningStatus.status !== 'written') {
        console.log(`  learn    ${paint(learningStatus.status, learningStatus.status === 'failed' ? 'red' : 'yellow')} (${learningStatus.detail})`);
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

    initDb(env.DATABASE_URL, { applicationName: 'iranti:cli:auth_create' });
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
        const written = await writeProjectBinding(resolvedProjectPath, {
            IRANTI_URL: `http://localhost:${env.IRANTI_PORT ?? '3001'}`,
            IRANTI_API_KEY: created.token,
            IRANTI_AGENT_ID: agentId ?? existingBinding.IRANTI_AGENT_ID ?? 'my_agent',
            IRANTI_MEMORY_ENTITY: existingBinding.IRANTI_MEMORY_ENTITY ?? 'user/main',
            IRANTI_PERSONAL_MEMORY_ENTITY: existingBinding.IRANTI_PERSONAL_MEMORY_ENTITY ?? 'user/main',
            IRANTI_AUTO_REMEMBER: existingBinding.IRANTI_AUTO_REMEMBER ?? 'false',
            IRANTI_INSTANCE: instanceName,
            IRANTI_INSTANCE_ENV: envFile,
        });
        const binding = await readEnvFile(written);
        await writeProjectLearningSnapshot({
            projectPath: resolvedProjectPath,
            projectEnvFile: written,
            binding,
            agentId: agentId ?? binding.IRANTI_AGENT_ID ?? 'my_agent',
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

    initDb(env.DATABASE_URL, { applicationName: 'iranti:cli:auth_list' });
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

    initDb(env.DATABASE_URL, { applicationName: 'iranti:cli:auth_revoke' });
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
    try {
        const json = hasFlag(args, 'json');
        const target = await resolveAttendantCliTarget(args);
        const task = getFlag(args, 'task')?.trim() || 'CLI handshake';
        let recentMessages = resolveRecentMessages(args);
        const backfillFile = resolveBackfillFile(args);
        let backfillResult: Awaited<ReturnType<typeof backfillChatHistory>> | null = null;

        if (backfillFile) {
            const content = fs.readFileSync(backfillFile, 'utf-8');
            backfillResult = await backfillChatHistory({
                iranti: target.iranti,
                content,
                agent: target.agentId,
                source: 'CLIBackfill',
            });
            if (recentMessages.length === 0) {
                recentMessages = parseBackfillChatTranscript(content)
                    .map((message) => message.text.trim())
                    .filter(Boolean)
                    .slice(-12);
            }
        }

        const result = await target.iranti.handshake({
            agent: target.agentId,
            task,
            recentMessages,
        });
        await flushStaffEventEmitter().catch(() => undefined);

        if (json) {
            console.log(JSON.stringify({
                agent: target.agentId,
                envSource: target.envSource,
                envFile: target.envFile,
                task,
                backfillFile,
                backfillResult,
                recentMessages,
                result,
            }, null, 2));
            return;
        }

        printHandshakeResult(target, task, result);
        if (backfillResult) {
            console.log('');
            console.log('Backfill:');
            console.log(`  file          ${backfillFile}`);
            console.log(`  messages      ${backfillResult.messagesParsed}`);
            console.log(`  extracted     ${backfillResult.extracted}`);
            console.log(`  written       ${backfillResult.written}`);
            if (backfillResult.skipped.length > 0) {
                console.log(`  skipped       ${backfillResult.skipped.length}`);
            }
        }
        if (result.backfillSuggestion?.suggested && !backfillFile) {
            console.log('');
            console.log('Backfill suggestion:');
            console.log(`  reason        ${result.backfillSuggestion.reason}`);
            console.log(`  candidateFacts ${result.backfillSuggestion.candidateFacts}`);
            console.log(`  sample keys   ${result.backfillSuggestion.sampleKeys.join(', ')}`);
            console.log(`  command       ${result.backfillSuggestion.suggestedCommand}`);
        }
        console.log('');
        console.log(`${infoLabel()} This is a manual Attendant inspection tool. Claude Code should still use hooks + MCP in normal operation.`);
    } finally {
        await flushStaffEventEmitter().catch(() => undefined);
        await disconnectDb().catch(() => undefined);
    }
}

async function attendCommand(args: ParsedArgs): Promise<void> {
    try {
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
        await flushStaffEventEmitter().catch(() => undefined);

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
    } finally {
        await flushStaffEventEmitter().catch(() => undefined);
        await disconnectDb().catch(() => undefined);
    }
}

async function issuesCommand(args: ParsedArgs): Promise<void> {
    try {
        const json = hasFlag(args, 'json');
        const target = await resolveAttendantCliTarget(args);
        const entity = resolveIssueEntity(args);
        const statusFilter = resolveIssueStatusFilter(args);
        const allFacts = await target.iranti.queryAll(entity);
        const parsedIssueFacts = allFacts
            .map(parseIssueListFact)
            .filter((result) => result.item || result.invalid);
        const canonicalItems = parsedIssueFacts
            .map((result) => result.item)
            .filter((item): item is IssueListItem => Boolean(item));
        const invalidIssueLikeFacts = parsedIssueFacts
            .map((result) => result.invalid)
            .filter((item): item is InvalidIssueFact => Boolean(item))
            .sort((a, b) => a.key.localeCompare(b.key));
        const inventoryCounts = {
            open: canonicalItems.filter((item) => item.status === 'open').length,
            resolved: canonicalItems.filter((item) => item.status === 'resolved').length,
            invalid: invalidIssueLikeFacts.length,
            canonicalTotal: canonicalItems.length,
            issueLikeTotal: canonicalItems.length + invalidIssueLikeFacts.length,
        };
        const items = canonicalItems
            .filter((item) => !statusFilter || item.status === statusFilter)
            .sort(compareIssueListItems);
        await flushStaffEventEmitter().catch(() => undefined);

        if (json) {
            console.log(JSON.stringify({
                entity,
                status: statusFilter,
                total: items.length,
                counts: inventoryCounts,
                invalidIssueLikeFacts,
                items,
            }, null, 2));
            return;
        }

        printIssuesResult(entity, items, statusFilter, inventoryCounts, invalidIssueLikeFacts);
    } finally {
        await flushStaffEventEmitter().catch(() => undefined);
        await disconnectDb().catch(() => undefined);
    }
}

async function handoffCommand(args: ParsedArgs): Promise<void> {
    try {
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
                properties: handoffWriteProperties(write.key),
            });
        }
        await flushStaffEventEmitter().catch(() => undefined);

        if (json) {
            console.log(JSON.stringify({
                agent: target.agentId,
                envSource: target.envSource,
                envFile: target.envFile,
                source,
                confidence,
                writes,
            }, null, 2));
            return;
        }

        printHandoffResult(target, taskEntity, writes);
        console.log('');
        console.log(`${infoLabel()} Handoffs are shared-memory facts. Pair this with checkpoint() if the sender also needs agent-local recovery.`);
    } finally {
        await flushStaffEventEmitter().catch(() => undefined);
        await disconnectDb().catch(() => undefined);
    }
}

function getGlobalAgentsMdPath(): string {
    return path.join(os.homedir(), 'AGENTS.md');
}

const GLOBAL_IRANTI_AGENTS_BLOCK = [
    '<!-- iranti-rules -->',
    '# Iranti MCP Protocol (Global)',
    '',
    'These rules apply only when Iranti MCP tools (`mcp__iranti__*`) are available in the current',
    'session. If Iranti tools are not accessible, skip this block entirely.',
    '',
    '## Session start',
    '- Call `mcp__iranti__iranti_handshake` with the active task before responding to the first user message.',
    '',
    '## Each turn',
    "- Call `mcp__iranti__iranti_attend(phase='pre-response')` before every reply.",
    '- Call `mcp__iranti__iranti_attend` before any file read, search, or knowledge discovery.',
    "- Call `mcp__iranti__iranti_attend(phase='post-response')` after every response.",
    '',
    '## After writes and discoveries',
    '- Call `mcp__iranti__iranti_write` after every file edit. Value must include:',
    '  - entity: `project/[project_id]/file/[filename_without_ext]` — not the broad project entity.',
    '  - absolutePath, lines (e.g. "65-70"), before (prior text), after (new text), verify (grep/read to confirm), why (the decision).',
    '- Call `mcp__iranti__iranti_write` after WebSearch/WebFetch — record findings AND dead ends / 404s.',
    '- Call `mcp__iranti__iranti_write` after Bash commands that reveal system state — include the command and relevant output lines, not just a summary.',
    '',
    '## Checkpoints',
    '- Call `mcp__iranti__iranti_checkpoint` when completing a task, shifting tasks, or at natural pauses.',
    '- A checkpoint not written means the next session reconstructs state from scratch.',
    '<!-- /iranti-rules -->',
    '',
].join('\n');

function isIrantiGlobalAgentsMdInstalled(): boolean {
    const agentsMd = getGlobalAgentsMdPath();
    if (!fs.existsSync(agentsMd)) return false;
    return fs.readFileSync(agentsMd, 'utf8').includes('<!-- iranti-rules -->');
}

async function codexGlobalSetupCommand(force: boolean): Promise<void> {
    const agentsMdPath = getGlobalAgentsMdPath();

    let status: ClaudeScaffoldStatus = 'unchanged';
    if (!fs.existsSync(agentsMdPath)) {
        await writeText(agentsMdPath, GLOBAL_IRANTI_AGENTS_BLOCK);
        status = 'created';
    } else {
        const existing = fs.readFileSync(agentsMdPath, 'utf8');
        if (!existing.includes('<!-- iranti-rules -->')) {
            await writeText(agentsMdPath, `${existing.trimEnd()}\n\n${GLOBAL_IRANTI_AGENTS_BLOCK}`);
            status = 'updated';
        } else if (force) {
            const replaced = existing.replace(
                /<!-- iranti-rules -->[\s\S]*?<!-- \/iranti-rules -->/,
                GLOBAL_IRANTI_AGENTS_BLOCK.trim(),
            );
            await writeText(agentsMdPath, replaced);
            status = 'updated';
        }
    }

    console.log(`${okLabel()} Global Codex Iranti protocol block installed`);
    console.log(`  file    ${agentsMdPath}  (${status})`);
    console.log(`${infoLabel()} Codex reads AGENTS.md from the project up to ~/. This block fires for all Codex sessions.`);
    console.log(`${infoLabel()} The block is self-disabling: it instructs Codex to skip it if Iranti MCP tools are not available.`);
    console.log(`${infoLabel()} To remove: iranti codex-unsetup --global`);
}

async function codexGlobalUnsetup(): Promise<void> {
    const agentsMdPath = getGlobalAgentsMdPath();

    if (!fs.existsSync(agentsMdPath)) {
        console.log(`${infoLabel()} ${agentsMdPath} does not exist — nothing to remove.`);
        return;
    }

    const existing = fs.readFileSync(agentsMdPath, 'utf8');
    if (!existing.includes('<!-- iranti-rules -->')) {
        console.log(`${infoLabel()} Iranti protocol block not found in ${agentsMdPath} — nothing to remove.`);
        return;
    }

    const cleaned = existing
        .replace(/\n*<!-- iranti-rules -->[\s\S]*?<!-- \/iranti-rules -->\n*/g, '\n')
        .trimEnd();
    await writeText(agentsMdPath, cleaned ? `${cleaned}\n` : '');
    console.log(`${okLabel()} Iranti protocol block removed from ${agentsMdPath}`);
}

function getGlobalClaudeDir(): string {
    return path.join(os.homedir(), '.claude');
}

function getGlobalClaudeSettingsPath(): string {
    return path.join(getGlobalClaudeDir(), 'settings.json');
}

function getGlobalProtocolHookScriptPath(): string {
    return path.join(getGlobalClaudeDir(), 'iranti-protocol-hook.js');
}

const PROTOCOL_HOOK_SCRIPT_CONTENT = [
    "#!/usr/bin/env node",
    "'use strict';",
    "// Iranti protocol reminder hook — fires on UserPromptSubmit for any Iranti project.",
    "// Cross-platform: runs on Windows, macOS, Linux via Node.js (same runtime as Iranti itself).",
    "// Exits cleanly with no output for non-Iranti projects.",
    "const fs = require('fs');",
    "const path = require('path');",
    "",
    "const envFile = path.join(process.cwd(), '.env.iranti');",
    "if (!fs.existsSync(envFile)) process.exit(0);",
    "",
    "process.stdout.write([",
    "  'IRANTI PROTOCOL (required this turn):',",
    "  '1. iranti_attend(phase=pre-response) BEFORE replying',",
    "  '2. iranti_attend BEFORE each Read / Grep / Glob / Bash / WebSearch / WebFetch',",
    "  '3. iranti_write AFTER each Edit or Write:',",
    "  '   entity: project/[id]/file/[filename] -- not the broad project entity',",
    "  '   value must include: absolutePath, lines, before, after, verify, why',",
    "  '4. iranti_write AFTER each Bash that reveals system state (build, errors, ports, env)',",
    "  '5. iranti_write AFTER each WebSearch/WebFetch -- write findings AND dead ends / 404s',",
    "  '6. iranti_attend(phase=post-response) AFTER every response without exception',",
    "].join('\\n') + '\\n');",
].join('\n') + '\n';

function isGlobalProtocolHookInstalled(): boolean {
    const settingsPath = getGlobalClaudeSettingsPath();
    if (!fs.existsSync(settingsPath)) return false;
    const settings = readJsonFile<Record<string, unknown>>(settingsPath);
    if (!settings || !isClaudeHooksObject(settings.hooks)) return false;
    const hooks = settings.hooks;
    const entries = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
    return entries.some((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const nested = (entry as Record<string, unknown>).hooks;
        if (!Array.isArray(nested)) return false;
        return nested.some((h: unknown) => {
            if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
            const cmd = (h as Record<string, unknown>).command;
            return typeof cmd === 'string' && cmd.includes('iranti-protocol-hook.js');
        });
    });
}

async function claudeGlobalSetupCommand(force: boolean): Promise<void> {
    const globalDir = getGlobalClaudeDir();
    const settingsPath = getGlobalClaudeSettingsPath();
    const hookScriptPath = getGlobalProtocolHookScriptPath();

    await ensureDir(globalDir);

    // Write hook script
    let scriptStatus: ClaudeScaffoldStatus = 'unchanged';
    if (!fs.existsSync(hookScriptPath)) {
        await writeText(hookScriptPath, PROTOCOL_HOOK_SCRIPT_CONTENT);
        scriptStatus = 'created';
    } else if (force) {
        await writeText(hookScriptPath, PROTOCOL_HOOK_SCRIPT_CONTENT);
        scriptStatus = 'updated';
    }

    // Use forward slashes so bash does not mangle the path on Windows
    const hookCommand = `node ${hookScriptPath.replace(/\\/g, '/')}`;
    const hookEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: hookCommand }],
    };

    // Read/merge settings.json
    let settingsStatus: ClaudeScaffoldStatus = 'unchanged';
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
        const existing = readJsonFile<Record<string, unknown>>(settingsPath);
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            settings = existing;
        }
    }

    const alreadyInstalled = isGlobalProtocolHookInstalled();
    if (!alreadyInstalled || force) {
        const existingHooks = isClaudeHooksObject(settings.hooks) ? settings.hooks : {};
        const existingEntries = Array.isArray(existingHooks.UserPromptSubmit) ? existingHooks.UserPromptSubmit : [];
        // Remove any existing iranti-protocol-hook.js entries then append fresh
        const filtered = existingEntries.filter((entry: unknown) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
            const nested = (entry as Record<string, unknown>).hooks;
            if (!Array.isArray(nested)) return true;
            return !nested.some((h: unknown) => {
                if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
                const cmd = (h as Record<string, unknown>).command;
                return typeof cmd === 'string' && cmd.includes('iranti-protocol-hook.js');
            });
        });
        const newSettings = {
            ...settings,
            hooks: {
                ...existingHooks,
                UserPromptSubmit: [...filtered, hookEntry],
            },
        };
        await writeText(settingsPath, `${JSON.stringify(newSettings, null, 2)}\n`);
        settingsStatus = alreadyInstalled ? 'updated' : 'created';
    }

    console.log(`${okLabel()} Global Claude Code protocol hook installed`);
    console.log(`  hook script  ${hookScriptPath}  (${scriptStatus})`);
    console.log(`  settings     ${settingsPath}  (${settingsStatus})`);
    console.log(`  command      ${hookCommand}`);
    console.log(`${infoLabel()} Fires on every UserPromptSubmit in any directory containing .env.iranti.`);
    console.log(`${infoLabel()} Silent no-op in all other projects. To remove: iranti claude-unsetup --global`);
}

async function claudeUnsetupCommand(args: ParsedArgs): Promise<void> {
    if (hasFlag(args, 'help')) {
        console.log([
            'Remove Iranti Claude Code integration.',
            '',
            'Usage:',
            '  iranti claude-unsetup [path] [--force]       Remove per-project integration',
            '  iranti claude-unsetup --global [--force]     Remove global protocol hook',
            '',
            'Per-project removes:',
            '  - Iranti hook entries from .claude/settings.local.json',
            '  - Iranti server from .mcp.json and .vscode/mcp.json',
            '  - Iranti protocol block from CLAUDE.md',
            '',
            'Global (--global) removes:',
            '  - UserPromptSubmit hook entry from ~/.claude/settings.json',
            '  - ~/.claude/iranti-protocol-hook.js script',
        ].join('\n'));
        return;
    }

    const force = hasFlag(args, 'force');

    if (hasFlag(args, 'global')) {
        await claudeGlobalUnsetup(force);
        return;
    }

    // Per-project unsetup
    const projectArg = args.positionals[0] ?? (args.command === 'claude-unsetup' ? args.subcommand ?? undefined : undefined);
    const projectPath = path.resolve(projectArg ?? process.cwd());

    if (!fs.existsSync(projectPath)) {
        throw cliError('IRANTI_PROJECT_PATH_NOT_FOUND', `Project path not found: ${projectPath}`);
    }

    let removedHooks = false;
    let removedMcp = false;
    let removedVscodeMcp = false;
    let removedClaudeMd = false;

    // settings.local.json — remove iranti hooks
    const settingsFile = path.join(projectPath, '.claude', 'settings.local.json');
    if (fs.existsSync(settingsFile)) {
        const existing = readJsonFile<Record<string, unknown>>(settingsFile);
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            const hooks = isClaudeHooksObject(existing.hooks) ? existing.hooks : {};
            const cleaned: Record<string, unknown> = {};
            for (const [event, entries] of Object.entries(hooks)) {
                if (!Array.isArray(entries)) { cleaned[event] = entries; continue; }
                const filtered = entries.filter((entry: unknown) => {
                    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
                    const nested = (entry as Record<string, unknown>).hooks;
                    if (!Array.isArray(nested)) return true;
                    return !nested.some((h: unknown) => {
                        if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
                        const cmd = (h as Record<string, unknown>).command;
                        return typeof cmd === 'string' && cmd.includes('iranti claude-hook');
                    });
                });
                if (filtered.length > 0) cleaned[event] = filtered;
            }
            // Remove iranti from permissions.allow
            const permissions = existing.permissions && typeof existing.permissions === 'object' && !Array.isArray(existing.permissions)
                ? { ...(existing.permissions as Record<string, unknown>) }
                : {};
            const allow = Array.isArray(permissions.allow)
                ? (permissions.allow as string[]).filter((t) => !String(t).startsWith('mcp__iranti__'))
                : undefined;
            if (allow) permissions.allow = allow;

            const updated: Record<string, unknown> = { ...existing };
            if (Object.keys(cleaned).length > 0) {
                updated.hooks = cleaned;
            } else {
                delete updated.hooks;
            }
            if (allow !== undefined) updated.permissions = permissions;
            await writeText(settingsFile, `${JSON.stringify(updated, null, 2)}\n`);
            removedHooks = true;
        }
    }

    // .mcp.json — remove iranti server
    const mcpFile = path.join(projectPath, '.mcp.json');
    if (fs.existsSync(mcpFile)) {
        const existing = readJsonFile<Record<string, unknown>>(mcpFile);
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            const servers = existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
                ? { ...(existing.mcpServers as Record<string, unknown>) }
                : null;
            if (servers && Object.prototype.hasOwnProperty.call(servers, 'iranti')) {
                delete servers.iranti;
                await writeText(mcpFile, `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`);
                removedMcp = true;
            }
        }
    }

    // .vscode/mcp.json — remove iranti server
    const vscodeMcpFile = path.join(projectPath, '.vscode', 'mcp.json');
    if (fs.existsSync(vscodeMcpFile)) {
        const existing = readJsonFile<Record<string, unknown>>(vscodeMcpFile);
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            const servers = existing.servers && typeof existing.servers === 'object' && !Array.isArray(existing.servers)
                ? { ...(existing.servers as Record<string, unknown>) }
                : null;
            if (servers && Object.prototype.hasOwnProperty.call(servers, 'iranti')) {
                delete servers.iranti;
                await writeText(vscodeMcpFile, `${JSON.stringify({ ...existing, servers }, null, 2)}\n`);
                removedVscodeMcp = true;
            }
        }
    }

    // CLAUDE.md — remove iranti protocol block
    const claudeMdFile = path.join(projectPath, 'CLAUDE.md');
    if (fs.existsSync(claudeMdFile)) {
        const content = fs.readFileSync(claudeMdFile, 'utf8');
        if (content.includes('<!-- iranti-rules -->')) {
            const cleaned = content
                .replace(/\n*<!-- iranti-rules -->[\s\S]*?<!-- \/iranti-rules -->\n*/g, '\n')
                .trimEnd();
            await writeText(claudeMdFile, cleaned ? `${cleaned}\n` : '');
            removedClaudeMd = true;
        }
    }

    console.log(`${okLabel()} Per-project Iranti Claude Code integration removed`);
    console.log(`  project         ${projectPath}`);
    console.log(`  hooks           ${removedHooks ? 'removed' : 'not present'}`);
    console.log(`  .mcp.json       ${removedMcp ? 'removed' : 'not present'}`);
    console.log(`  .vscode/mcp     ${removedVscodeMcp ? 'removed' : 'not present'}`);
    console.log(`  CLAUDE.md       ${removedClaudeMd ? 'block removed' : 'not present'}`);
    console.log(`${infoLabel()} The global hook (if installed) is separate — use --global to remove it.`);
}

async function claudeGlobalUnsetup(force: boolean): Promise<void> {
    const settingsPath = getGlobalClaudeSettingsPath();
    const hookScriptPath = getGlobalProtocolHookScriptPath();

    let settingsStatus = 'not present';
    let scriptStatus = 'not present';

    if (fs.existsSync(settingsPath)) {
        const existing = readJsonFile<Record<string, unknown>>(settingsPath);
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            const hooks = isClaudeHooksObject(existing.hooks) ? existing.hooks : {};
            const entries = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
            const filtered = entries.filter((entry: unknown) => {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
                const nested = (entry as Record<string, unknown>).hooks;
                if (!Array.isArray(nested)) return true;
                return !nested.some((h: unknown) => {
                    if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
                    const cmd = (h as Record<string, unknown>).command;
                    return typeof cmd === 'string' && cmd.includes('iranti-protocol-hook.js');
                });
            });
            if (filtered.length !== entries.length || force) {
                const updatedHooks = { ...hooks };
                if (filtered.length > 0) {
                    updatedHooks.UserPromptSubmit = filtered;
                } else {
                    delete updatedHooks.UserPromptSubmit;
                }
                const updated: Record<string, unknown> = { ...existing };
                if (Object.keys(updatedHooks).length === 0) {
                    delete updated['hooks'];
                } else {
                    updated.hooks = updatedHooks;
                }
                await writeText(settingsPath, `${JSON.stringify(updated, null, 2)}\n`);
                settingsStatus = 'hook removed';
            } else {
                settingsStatus = 'hook not found';
            }
        }
    }

    if (fs.existsSync(hookScriptPath)) {
        fs.unlinkSync(hookScriptPath);
        scriptStatus = 'deleted';
    }

    console.log(`${okLabel()} Global Iranti protocol hook removed`);
    console.log(`  settings     ${settingsPath}  (${settingsStatus})`);
    console.log(`  hook script  ${hookScriptPath}  (${scriptStatus})`);
}

function printClaudeSetupHelp(): void {
    console.log([
        'Scaffold Claude Code MCP and hook files for the current project.',
        'Use this when a bound repo should be ready for Claude Code without hand-editing `.mcp.json`, `.vscode/mcp.json`, `.claude/settings.local.json`, or `CLAUDE.md`.',
        '',
        'Usage:',
        '  iranti claude-setup [path] [--project-env <path>] [--force]',
        '  iranti claude-setup --global [--force]',
        '  iranti claude-setup --scan <dir> [--recursive] [--force]',
        '  iranti integrate claude [path] [--project-env <path>] [--force]',
        '  iranti integrate claude --scan <dir> [--recursive] [--force]',
        '',
        'Typical scenarios:',
        '  - One repo: run `iranti claude-setup .` from the project root after `iranti project init`.',
        '  - Many repos: run `iranti claude-setup --scan <dir> --recursive` to scaffold every Claude-enabled project tree under a parent folder.',
        '',
        'Notes:',
        '  - Expects a project binding at .env.iranti unless --project-env is supplied.',
        '  - Writes .mcp.json, .vscode/mcp.json, .claude/settings.local.json, and a local `CLAUDE.md` Iranti protocol block.',
        '  - Adds the Iranti MCP server to existing .mcp.json / .vscode/mcp.json files without removing other servers.',
        '  - Leaves existing Claude hook files untouched unless --force is supplied.',
        '  - The generated protocol block explicitly requires handshake at session start, attend before reply and before/after discovery, checkpointing at natural pauses/interrupted work, and durable writes after confirmed findings.',
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
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop'] as const) {
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
            const agentsFile = path.join(current, 'AGENTS.md');

            const artifact: UninstallProjectArtifact = { projectPath: current };
            if (fs.existsSync(bindingFile)) artifact.bindingFile = bindingFile;
            if (fs.existsSync(mcpFile) && hasIrantiMcpServerConfig(readJsonFile<Record<string, unknown>>(mcpFile))) {
                artifact.mcpFile = mcpFile;
            }
            if (fs.existsSync(claudeSettingsFile) && hasIrantiClaudeHookSettings(readJsonFile<Record<string, unknown>>(claudeSettingsFile))) {
                artifact.claudeSettingsFile = claudeSettingsFile;
            }
            if (fs.existsSync(agentsFile)) {
                try {
                    const agentsText = await fsp.readFile(agentsFile, 'utf8');
                    if (agentsText.includes('<!-- iranti-rules -->')) {
                        artifact.agentsFile = agentsFile;
                    }
                } catch {
                    // Ignore unreadable AGENTS files during discovery; cleanup will warn if selected.
                }
            }

            if (artifact.bindingFile || artifact.mcpFile || artifact.claudeSettingsFile || artifact.agentsFile) {
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

    if (hasFlag(args, 'global')) {
        await claudeGlobalSetupCommand(hasFlag(args, 'force'));
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
        let createdVsCodeMcp = 0;
        let updatedVsCodeMcp = 0;
        let createdSettings = 0;
        let updatedSettings = 0;
        let unchanged = 0;
        for (const projectPath of candidates) {
            const result = await writeClaudeCodeProjectFiles(projectPath, undefined, force);
            if (result.mcp === 'created') createdMcp += 1;
            if (result.mcp === 'updated') updatedMcp += 1;
            if (result.vscodeMcp === 'created') createdVsCodeMcp += 1;
            if (result.vscodeMcp === 'updated') updatedVsCodeMcp += 1;
            if (result.settings === 'created') createdSettings += 1;
            if (result.settings === 'updated') updatedSettings += 1;
            if (result.mcp === 'unchanged' && result.vscodeMcp === 'unchanged' && result.settings === 'unchanged' && result.irantiMd === 'unchanged' && result.writeGuardHook === 'unchanged' && result.editTrackerHook === 'unchanged') unchanged += 1;
            console.log(`  ${projectPath}`);
            console.log(`    mcp          ${result.mcp}`);
            console.log(`    vscode       ${result.vscodeMcp}`);
            console.log(`    settings     ${result.settings}`);
            console.log(`    iranti.md    ${result.irantiMd}`);
            console.log(`    write-guard  ${result.writeGuardHook}`);
            console.log(`    edit-tracker ${result.editTrackerHook}`);
        }
        console.log('');
        console.log('Summary:');
        console.log(`  projects          ${candidates.length}`);
        console.log(`  mcp created       ${createdMcp}`);
        console.log(`  mcp updated       ${updatedMcp}`);
        console.log(`  vscode created    ${createdVsCodeMcp}`);
        console.log(`  vscode updated    ${updatedVsCodeMcp}`);
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
    console.log(`  project      ${projectPath}`);
    console.log(`  binding      ${projectEnvPath}`);
    console.log(`  mcp          ${path.join(projectPath, '.mcp.json')}`);
    console.log(`  vscode       ${path.join(projectPath, '.vscode', 'mcp.json')}`);
    console.log(`  settings     ${path.join(projectPath, '.claude', 'settings.local.json')}`);
    console.log(`  claude.md    ${path.join(projectPath, 'CLAUDE.md')}`);
    console.log(`  iranti.md    ${path.join(projectPath, 'IRANTI.md')}`);
    console.log(`  write-guard  ${path.join(projectPath, '.claude', 'iranti-write-guard-hook.js')}`);
    console.log(`  edit-tracker ${path.join(projectPath, '.claude', 'iranti-edit-tracker-hook.js')}`);
    console.log(`  protocol     ${path.join(projectPath, '.claude', 'iranti-protocol-hook.js')}`);
    console.log(`  mcp status           ${result.mcp}`);
    console.log(`  vscode status        ${result.vscodeMcp}`);
    console.log(`  settings status      ${result.settings}`);
    console.log(`  claude.md status     ${result.claudeMd}`);
    console.log(`  iranti.md status     ${result.irantiMd}`);
    console.log(`  write-guard status   ${result.writeGuardHook}`);
    console.log(`  edit-tracker status  ${result.editTrackerHook}`);
    console.log(`  protocol status      ${result.protocolReminderHook}`);
    console.log(`  memory closeout      ${result.closeout.status} (${result.closeout.detail})`);
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
    renderMainHelp({ sectionTitle, commandText });
}

function printChoiceGuide(title: string, entries: Array<{ choice: string; meaning: string; useWhen: string }>): void {
    renderChoiceGuide({ sectionTitle, commandText }, title, entries);
}

function printWizardNotes(title: string, lines: string[]): void {
    renderWizardNotes({ sectionTitle, commandText }, title, lines);
}

function printSetupHelp(): void {
    renderSetupHelp({ sectionTitle, commandText });
}

function printInstallHelp(): void {
    renderInstallHelp({ sectionTitle, commandText });
}

function printRunHelp(): void {
    renderRunHelp({ sectionTitle, commandText });
}

function printUninstallHelp(): void {
    renderUninstallHelp({ sectionTitle, commandText });
}

function printInstanceHelp(): void {
    renderInstanceHelp({ sectionTitle, commandText });
}

function printConfigureHelp(): void {
    renderConfigureHelp({ sectionTitle, commandText });
}

function printConfigureInstanceHelp(): void {
    renderConfigureInstanceHelp({ sectionTitle, commandText });
}

function printConfigureProjectHelp(): void {
    renderConfigureProjectHelp({ sectionTitle, commandText });
}

function printAuthHelp(): void {
    renderAuthHelp({ sectionTitle, commandText });
}

function printAuthCreateKeyHelp(): void {
    renderAuthCreateKeyHelp({ sectionTitle, commandText });
}

function printAuthListKeysHelp(): void {
    renderAuthListKeysHelp({ sectionTitle, commandText });
}

function printAuthRevokeKeyHelp(): void {
    renderAuthRevokeKeyHelp({ sectionTitle, commandText });
}

function printIntegrateHelp(): void {
    renderIntegrateHelp({ sectionTitle, commandText });
}

function printProjectInitHelp(): void {
    renderProjectInitHelp({ sectionTitle, commandText });
}

function printProjectUnbindHelp(): void {
    renderProjectUnbindHelp({ sectionTitle, commandText });
}

function printDoctorHelp(): void {
    renderDoctorHelp({ sectionTitle, commandText });
}

function printStatusHelp(): void {
    renderStatusHelp({ sectionTitle, commandText });
}

function printUpgradeHelp(): void {
    renderUpgradeHelp({ sectionTitle, commandText });
}

function printHandshakeHelp(): void {
    renderHandshakeHelp({ sectionTitle, commandText });
}

function printAttendHelp(): void {
    renderAttendHelp({ sectionTitle, commandText });
}

function printIssuesHelp(): void {
    renderIssuesHelp({ sectionTitle, commandText });
}

function printHandoffHelp(): void {
    renderHandoffHelp({ sectionTitle, commandText });
}

function printChatHelp(): void {
    renderChatHelp({ sectionTitle, commandText });
}

function printResolveHelp(): void {
    renderResolveHelp({ sectionTitle, commandText });
}

function printProviderKeyHelp(): void {
    renderProviderKeyHelp({ sectionTitle, commandText });
}

function printMcpHelp(): void {
    console.log([
        'MCP server and maintenance commands.',
        'Use this when the stdio MCP server should be started directly, or when you need to inspect and clean stale MCP wrapper/server pairs.',
        '',
        'Usage:',
        '  iranti mcp',
        '  iranti mcp cleanup [--dry-run] [--json]',
        '',
        'Notes:',
        '  - `iranti mcp` starts the stdio MCP server for Claude, Codex, or another MCP client.',
        '  - `iranti mcp cleanup` only removes stale launcher/server pairs that no longer have a live host ancestor.',
        '  - Active chains still rooted in `claude.exe` or `codex.exe` are reported but not killed.',
        '  - Current implementation is tuned for Windows process trees.',
    ].join('\n'));
}

function isMcpLauncherCommand(commandLine: string | undefined): boolean {
    if (!commandLine) return false;
    const lower = commandLine.toLowerCase();
    return lower.includes('\\node_modules\\iranti\\bin\\iranti.js')
        && /\bmcp\b/.test(lower);
}

function isMcpChildCommand(commandLine: string | undefined): boolean {
    if (!commandLine) return false;
    return commandLine.toLowerCase().includes('\\dist\\scripts\\iranti-mcp.js');
}

function collectWindowsProcessSnapshot(): ProcessSnapshotRow[] {
    const probe = runCommandCapture('powershell', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Compress',
    ]);
    if (probe.status !== 0) {
        throw cliError(
            'IRANTI_MCP_CLEANUP_PROBE_FAILED',
            'Failed to inspect Windows process state for MCP cleanup.',
            ['Retry with `--debug` to inspect the PowerShell probe output.'],
            { stderr: probe.stderr.trim() || null }
        );
    }

    const payload = JSON.parse(probe.stdout) as Array<Record<string, unknown>> | Record<string, unknown>;
    const rows = Array.isArray(payload) ? payload : [payload];
    return rows.map((row) => ({
        pid: Number(row.ProcessId ?? 0),
        parentPid: row.ParentProcessId === null || row.ParentProcessId === undefined
            ? null
            : Number(row.ParentProcessId),
        name: String(row.Name ?? ''),
        commandLine: String(row.CommandLine ?? ''),
    })).filter((row) => Number.isFinite(row.pid) && row.pid > 0);
}

function summarizeMcpCleanupCounts(candidates: McpCleanupCandidate[]): Record<McpCleanupCandidateStatus, number> {
    return {
        stale_no_host_ancestor: candidates.filter((candidate) => candidate.status === 'stale_no_host_ancestor').length,
        stale_shell_no_host: candidates.filter((candidate) => candidate.status === 'stale_shell_no_host').length,
        stale_child_parent_missing: candidates.filter((candidate) => candidate.status === 'stale_child_parent_missing').length,
        stale_launcher_only: candidates.filter((candidate) => candidate.status === 'stale_launcher_only').length,
        attached_claude: candidates.filter((candidate) => candidate.status === 'attached_claude').length,
        attached_codex: candidates.filter((candidate) => candidate.status === 'attached_codex').length,
        attached_or_uncertain: candidates.filter((candidate) => candidate.status === 'attached_or_uncertain').length,
    };
}

function buildMcpCleanupReport(rows: ProcessSnapshotRow[]): McpCleanupReport {
    const protectedPids = currentProcessFamilyPids();
    const index = new Map<number, ProcessSnapshotRow>();
    for (const row of rows) {
        index.set(row.pid, row);
    }

    const warnings: string[] = [];
    const candidates: McpCleanupCandidate[] = [];
    const matchedLaunchers = new Set<number>();
    const childByLauncher = new Map<number, ProcessSnapshotRow>();

    for (const row of rows) {
        if (row.name.toLowerCase() !== 'node.exe') continue;
        if (!isMcpChildCommand(row.commandLine)) continue;
        if (protectedPids.has(row.pid)) continue;

        const parent = row.parentPid ? index.get(row.parentPid) : undefined;
        if (!parent) {
            candidates.push({
                status: 'stale_child_parent_missing',
                childPid: row.pid,
                reason: 'MCP child process has no live launcher parent.',
            });
            continue;
        }

        if (!isMcpLauncherCommand(parent.commandLine)) {
            candidates.push({
                status: 'attached_or_uncertain',
                childPid: row.pid,
                reason: 'MCP child process is attached to a parent that is not a recognized Iranti MCP launcher.',
            });
            continue;
        }

        matchedLaunchers.add(parent.pid);
        childByLauncher.set(parent.pid, row);
        if (protectedPids.has(parent.pid)) {
            candidates.push({
                status: 'attached_or_uncertain',
                launcherPid: parent.pid,
                childPid: row.pid,
                reason: 'Skipping the current CLI process family.',
            });
            continue;
        }

        const grand = parent.parentPid ? index.get(parent.parentPid) : undefined;
        const great = grand?.parentPid ? index.get(grand.parentPid) : undefined;
        const grandName = grand?.name.toLowerCase() ?? '';
        const greatName = great?.name.toLowerCase() ?? '';

        if (!grand) {
            candidates.push({
                status: 'stale_no_host_ancestor',
                launcherPid: parent.pid,
                childPid: row.pid,
                reason: 'Launcher parent exists, but no live host ancestor remains.',
            });
            continue;
        }

        if (grandName === 'cmd.exe' && !great) {
            candidates.push({
                status: 'stale_shell_no_host',
                launcherPid: parent.pid,
                childPid: row.pid,
                reason: 'Launcher is still wrapped by cmd.exe, but the host process above cmd.exe is gone.',
            });
            continue;
        }

        if (grandName === 'cmd.exe' && greatName === 'claude.exe') {
            candidates.push({
                status: 'attached_claude',
                launcherPid: parent.pid,
                childPid: row.pid,
                host: 'claude',
                reason: 'Chain is still rooted in claude.exe.',
            });
            continue;
        }

        if (grandName === 'cmd.exe' && greatName === 'codex.exe') {
            candidates.push({
                status: 'attached_codex',
                launcherPid: parent.pid,
                childPid: row.pid,
                host: 'codex',
                reason: 'Chain is still rooted in codex.exe.',
            });
            continue;
        }

        candidates.push({
            status: 'attached_or_uncertain',
            launcherPid: parent.pid,
            childPid: row.pid,
            reason: 'Launcher/server pair still has a live ancestor that is not a known stale shape.',
        });
    }

    for (const row of rows) {
        if (row.name.toLowerCase() !== 'node.exe') continue;
        if (!isMcpLauncherCommand(row.commandLine)) continue;
        if (matchedLaunchers.has(row.pid) || protectedPids.has(row.pid)) continue;

        const grand = row.parentPid ? index.get(row.parentPid) : undefined;
        const great = grand?.parentPid ? index.get(grand.parentPid) : undefined;
        const grandName = grand?.name.toLowerCase() ?? '';
        const greatName = great?.name.toLowerCase() ?? '';
        if (!grand) {
            candidates.push({
                status: 'stale_launcher_only',
                launcherPid: row.pid,
                reason: 'Launcher remains alive without a child or live host ancestor.',
            });
        } else if (grandName === 'cmd.exe' && !great) {
            candidates.push({
                status: 'stale_launcher_only',
                launcherPid: row.pid,
                reason: 'Launcher is still wrapped by cmd.exe, but the host process above cmd.exe is gone.',
            });
        }
    }

    const safeStatuses = new Set<McpCleanupCandidateStatus>([
        'stale_no_host_ancestor',
        'stale_shell_no_host',
        'stale_child_parent_missing',
        'stale_launcher_only',
    ]);

    const safeCandidates = candidates.filter((candidate) => safeStatuses.has(candidate.status));
    const skippedCandidates = candidates.filter((candidate) => !safeStatuses.has(candidate.status));

    if (safeCandidates.length === 0) {
        warnings.push('No stale MCP launcher/server pairs were found with the current safe cleanup rule.');
    }

    return {
        platform: process.platform,
        supported: process.platform === 'win32',
        dryRun: true,
        counts: summarizeMcpCleanupCounts(candidates),
        safeCandidates,
        skippedCandidates,
        cleaned: [],
        warnings,
    };
}

function printMcpCleanupReport(report: McpCleanupReport): void {
    console.log(sectionTitle('MCP Cleanup'));
    if (!report.supported) {
        console.log(`${warnLabel()} MCP cleanup is currently supported on Windows only.`);
        return;
    }

    console.log(`  safe stale candidates   ${report.safeCandidates.length}`);
    console.log(`  attached claude         ${report.counts.attached_claude}`);
    console.log(`  attached codex          ${report.counts.attached_codex}`);
    console.log(`  other live / uncertain  ${report.counts.attached_or_uncertain}`);
    console.log(`  cleaned entries         ${report.cleaned.length}`);
    console.log(`  mode                    ${report.dryRun ? 'dry-run' : 'execute'}`);
    console.log('');

    if (report.safeCandidates.length > 0) {
        console.log(sectionTitle('Safe Targets'));
        for (const candidate of report.safeCandidates) {
            const ids = [
                candidate.launcherPid ? `launcher=${candidate.launcherPid}` : null,
                candidate.childPid ? `child=${candidate.childPid}` : null,
            ].filter((value): value is string => Boolean(value));
            console.log(`  ${commandText(candidate.status)} ${ids.join(' ')} - ${candidate.reason}`);
        }
        console.log('');
    }

    if (report.skippedCandidates.length > 0) {
        console.log(sectionTitle('Skipped Targets'));
        for (const candidate of report.skippedCandidates) {
            const ids = [
                candidate.launcherPid ? `launcher=${candidate.launcherPid}` : null,
                candidate.childPid ? `child=${candidate.childPid}` : null,
            ].filter((value): value is string => Boolean(value));
            console.log(`  ${commandText(candidate.status)} ${ids.join(' ')} - ${candidate.reason}`);
        }
        console.log('');
    }

    for (const warning of report.warnings) {
        console.log(`${warnLabel()} ${warning}`);
    }
}

async function mcpCleanupCommand(args: ParsedArgs): Promise<void> {
    const json = hasFlag(args, 'json');
    const dryRun = hasFlag(args, 'dry-run');

    if (process.platform !== 'win32') {
        const report: McpCleanupReport = {
            platform: process.platform,
            supported: false,
            dryRun,
            counts: {
                stale_no_host_ancestor: 0,
                stale_shell_no_host: 0,
                stale_child_parent_missing: 0,
                stale_launcher_only: 0,
                attached_claude: 0,
                attached_codex: 0,
                attached_or_uncertain: 0,
            },
            safeCandidates: [],
            skippedCandidates: [],
            cleaned: [],
            warnings: ['MCP cleanup is currently implemented for Windows process trees only.'],
        };
        if (json) {
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        printMcpCleanupReport(report);
        return;
    }

    const report = buildMcpCleanupReport(collectWindowsProcessSnapshot());
    report.dryRun = dryRun;

    if (!dryRun) {
        const cleaned = new Set<string>();
        for (const candidate of report.safeCandidates) {
            if (candidate.childPid && !cleaned.has(`child:${candidate.childPid}`)) {
                const proc = runCommandCapture('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${candidate.childPid} -Force -ErrorAction SilentlyContinue`]);
                if (proc.status === 0) {
                    report.cleaned.push({ pid: candidate.childPid, role: 'child' });
                    cleaned.add(`child:${candidate.childPid}`);
                }
            }
            if (candidate.launcherPid && !cleaned.has(`launcher:${candidate.launcherPid}`)) {
                const proc = runCommandCapture('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${candidate.launcherPid} -Force -ErrorAction SilentlyContinue`]);
                if (proc.status === 0) {
                    report.cleaned.push({ pid: candidate.launcherPid, role: 'launcher' });
                    cleaned.add(`launcher:${candidate.launcherPid}`);
                }
            }
        }
    }

    if (json) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    printMcpCleanupReport(report);
}

// ── Rule commands ────────────────────────────────────────────────────────────

function printListRulesHelp(): void {
    console.log([
        'List all user-defined operating rules.',
        'Use this to see which rules will be matched during attend() based on trigger keywords.',
        '',
        'Usage:',
        '  iranti list-rules [--instance <name>] [--project-env <path>] [--json]',
        '',
        'Notes:',
        '  - Rules are stored as rule/* entities with trigger keywords.',
        '  - During attend(), triggers are matched against the current context.',
        '  - Soft rules are injected as guidance; hard rules as requirements.',
    ].join('\n'));
}

function printDeleteRuleHelp(): void {
    console.log([
        'Delete a user-defined operating rule by ID.',
        'Use this to remove a rule that is no longer needed.',
        '',
        'Usage:',
        '  iranti delete-rule <rule-id> [--instance <name>] [--project-env <path>] [--json]',
        '',
        'Examples:',
        '  iranti delete-rule no_npm_publish',
        '  iranti delete-rule watch_ci --instance myapp',
    ].join('\n'));
}

async function resolveDbForRuleCommands(args: ParsedArgs): Promise<void> {
    const instanceName = getFlag(args, 'instance');
    if (instanceName) {
        const scope = normalizeScope(getFlag(args, 'scope'));
        const root = resolveInstallRoot(args, scope);
        const loaded = await loadInstanceEnv(root, instanceName);
        applyEnvMap(loaded.env);
    } else {
        const cwd = path.resolve(getFlag(args, 'project') ?? process.cwd());
        const explicitProjectEnv = getFlag(args, 'project-env');
        loadRuntimeEnv({
            cwd,
            projectEnvFile: explicitProjectEnv ? path.resolve(explicitProjectEnv) : undefined,
        });
    }
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
        throw cliError(
            'IRANTI_DATABASE_URL_MISSING',
            'DATABASE_URL is required. Run from a bound project, pass --instance <name>, or set DATABASE_URL.',
            ['Run `iranti project init . --instance <name>` to bind this project.'],
        );
    }
    initDb(databaseUrl, { applicationName: 'iranti:cli:rules' });
}

async function listRulesCommand(args: ParsedArgs): Promise<void> {
    try {
        const json = hasFlag(args, 'json');
        await resolveDbForRuleCommands(args);

        const entries = await findEntriesByEntityType('rule');

        if (json) {
            const items = entries.map((entry) => {
                const props = entry.properties && typeof entry.properties === 'object' && !Array.isArray(entry.properties)
                    ? entry.properties as Record<string, unknown>
                    : null;
                return {
                    ruleId: entry.entityId,
                    key: entry.key,
                    rule: entry.valueSummary || '',
                    triggers: Array.isArray(props?.triggers) ? props!.triggers : [],
                    enforcement: props?.enforcement ?? 'soft',
                    scope: props?.scope ?? 'project',
                    updatedAt: entry.updatedAt.toISOString(),
                };
            });
            console.log(JSON.stringify({ total: items.length, rules: items }, null, 2));
            process.exit(0);
        }

        if (entries.length === 0) {
            console.log(`${infoLabel()} No operating rules found.`);
            console.log('  Create rules with: iranti mcp → iranti_write_rule, or iranti_write with entity type "rule".');
            return;
        }

        console.log(sectionTitle(`Operating Rules (${entries.length})`));
        for (const entry of entries) {
            const props = entry.properties && typeof entry.properties === 'object' && !Array.isArray(entry.properties)
                ? entry.properties as Record<string, unknown>
                : null;
            const triggers = Array.isArray(props?.triggers) ? (props!.triggers as string[]).join(', ') : '(none)';
            const enforcement = props?.enforcement === 'hard' ? 'REQUIRED' : 'soft';
            console.log(`  ${commandText(entry.entityId)} [${enforcement}]`);
            console.log(`    rule:     ${entry.valueSummary || '(no summary)'}`);
            console.log(`    triggers: ${triggers}`);
            console.log(`    scope:    ${props?.scope ?? 'project'}`);
            console.log(`    updated:  ${entry.updatedAt.toISOString()}`);
        }
    } finally {
        await disconnectDb().catch(() => undefined);
    }
}

async function deleteRuleCommand(args: ParsedArgs): Promise<void> {
    try {
        const json = hasFlag(args, 'json');
        const ruleId = args.positionals[0]?.trim();
        if (!ruleId) {
            throw cliError(
                'IRANTI_RULE_ID_REQUIRED',
                'Missing rule ID. Usage: iranti delete-rule <rule-id>',
                ['Run `iranti list-rules` to see available rules.'],
            );
        }

        await resolveDbForRuleCommands(args);

        const entries = await findEntriesByEntityType('rule');
        const matching = entries.filter((entry) => entry.entityId === ruleId);

        if (matching.length === 0) {
            throw cliError(
                'IRANTI_RULE_NOT_FOUND',
                `Rule '${ruleId}' not found.`,
                ['Run `iranti list-rules` to see available rules.'],
                { ruleId },
            );
        }

        for (const entry of matching) {
            await deleteEntryById(entry.id);
        }

        if (json) {
            console.log(JSON.stringify({ deleted: ruleId, entriesRemoved: matching.length }, null, 2));
            process.exit(0);
        }

        console.log(`${okLabel()} Deleted rule '${ruleId}' (${matching.length} ${matching.length === 1 ? 'entry' : 'entries'} removed).`);
    } finally {
        await disconnectDb().catch(() => undefined);
    }
}

/**
 * A2: revert-autowrite CLI — pair for M2 tool-result extraction. Every
 * attendant_autowrite stamps the knowledge entry with source=attendant_autowrite
 * plus an autowriteBatchId in properties, so we can find and revoke all the
 * autowrites in a time window with just two columns. Defaults to --dry-run so
 * a mistaken invocation previews targets instead of destroying them.
 */
function printRevertAutowriteHelp(): void {
    console.log([
        'Revert attendant autowrites performed in a recent time window.',
        'Every fact written by iranti_attend via tool-result extraction is stamped',
        'with source="attendant_autowrite" plus an autowriteBatchId. This command',
        'lists (or, with --commit, deletes) every such entry whose createdAt is in',
        'the given window.',
        '',
        'Usage:',
        '  iranti revert-autowrite --since <duration> [--until <duration>] [--commit] [--json]',
        '                          [--instance <name>] [--project-env <path>]',
        '',
        'Flags:',
        '  --since <duration>    Required. How far back to look (e.g. 15m, 2h, 1d).',
        '  --until <duration>    Optional. How recent the window should end (default: now).',
        '  --commit              Actually delete. WITHOUT this flag, runs as a dry-run preview.',
        '  --json                Print machine-readable output.',
        '  --instance <name>     Use a named Iranti instance instead of the bound project.',
        '  --project-env <path>  Point at a specific project env file.',
        '',
        'Examples:',
        '  iranti revert-autowrite --since 15m                 # dry-run preview of the last 15m',
        '  iranti revert-autowrite --since 2h --commit         # actually delete last 2h of autowrites',
        '  iranti revert-autowrite --since 1d --until 1h       # window from 1d ago to 1h ago (dry-run)',
        '',
        'Notes:',
        '  - Only entries with source="attendant_autowrite" are affected. Host writes,',
        '    librarian writes, and every other source are untouched.',
        '  - Deletion is by knowledge entry id, not by entity. Non-autowrite facts on',
        '    the same entity remain in place.',
    ].join('\n'));
}

/** Parse human durations like `15m`, `2h`, `1d` into milliseconds. */
function parseDurationFlag(value: string, flagName: string): number {
    const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(value.trim());
    if (!match) {
        throw cliError(
            'IRANTI_DURATION_INVALID',
            `Invalid duration for --${flagName}: '${value}'. Expected formats: 500ms, 30s, 15m, 2h, 1d.`,
            [`Try: iranti revert-autowrite --${flagName} 15m`],
        );
    }
    const raw = Number.parseInt(match[1], 10);
    const unit = (match[2] ?? 'ms').toLowerCase();
    const multiplier = unit === 'ms' ? 1
        : unit === 's' ? 1_000
        : unit === 'm' ? 60_000
        : unit === 'h' ? 3_600_000
        : unit === 'd' ? 86_400_000
        : 1;
    return raw * multiplier;
}

async function revertAutowriteCommand(args: ParsedArgs): Promise<void> {
    try {
        const json = hasFlag(args, 'json');
        const commit = hasFlag(args, 'commit');
        const sinceFlag = getFlag(args, 'since');
        const untilFlag = getFlag(args, 'until');

        if (!sinceFlag) {
            throw cliError(
                'IRANTI_REVERT_AUTOWRITE_SINCE_REQUIRED',
                'Missing required flag --since. Usage: iranti revert-autowrite --since <duration>',
                ['Try: iranti revert-autowrite --since 15m'],
            );
        }

        const sinceMs = parseDurationFlag(sinceFlag, 'since');
        const untilMs = untilFlag ? parseDurationFlag(untilFlag, 'until') : 0;
        const now = Date.now();
        const since = new Date(now - sinceMs);
        const until = untilFlag ? new Date(now - untilMs) : undefined;

        // Reuse the rule command env/db resolver — same prerequisites: a bound
        // project or an --instance flag so DATABASE_URL can be resolved.
        await resolveDbForRuleCommands(args);

        const AUTOWRITE_SOURCE = 'attendant_autowrite';
        const targets = await findEntriesBySourceAndWindow(AUTOWRITE_SOURCE, since, until);

        if (json) {
            const payload = {
                mode: commit ? 'commit' : 'dry-run',
                source: AUTOWRITE_SOURCE,
                since: since.toISOString(),
                until: (until ?? new Date(now)).toISOString(),
                matched: targets.length,
                targets: targets.map((entry) => ({
                    id: entry.id,
                    entityType: entry.entityType,
                    entityId: entry.entityId,
                    key: entry.key,
                    summary: entry.valueSummary ?? '',
                    createdAt: entry.createdAt.toISOString(),
                })),
                deleted: 0 as number,
            };
            if (commit && targets.length > 0) {
                payload.deleted = await deleteEntriesBySourceAndWindow(AUTOWRITE_SOURCE, since, until);
            }
            console.log(JSON.stringify(payload, null, 2));
            process.exit(0);
        }

        const header = commit ? 'Revert autowrites (COMMIT)' : 'Revert autowrites (dry-run)';
        console.log(sectionTitle(header));
        console.log(`  source:   ${AUTOWRITE_SOURCE}`);
        console.log(`  since:    ${since.toISOString()}`);
        console.log(`  until:    ${(until ?? new Date(now)).toISOString()}`);
        console.log(`  matched:  ${targets.length}`);

        if (targets.length === 0) {
            console.log(`${infoLabel()} No attendant autowrites in this window.`);
            return;
        }

        for (const entry of targets) {
            console.log(`  - ${entry.entityType}/${entry.entityId} ${entry.key}`);
            if (entry.valueSummary) {
                console.log(`      ${entry.valueSummary.slice(0, 160)}`);
            }
            console.log(`      id=${entry.id} createdAt=${entry.createdAt.toISOString()}`);
        }

        if (!commit) {
            console.log(`${infoLabel()} Dry-run only. Re-run with --commit to delete these entries.`);
            return;
        }

        const deleted = await deleteEntriesBySourceAndWindow(AUTOWRITE_SOURCE, since, until);
        console.log(`${okLabel()} Deleted ${deleted} attendant autowrite ${deleted === 1 ? 'entry' : 'entries'}.`);
    } finally {
        await disconnectDb().catch(() => undefined);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    ACTIVE_PARSED_ARGS = args;
    setCliDebugFlags(args);
    debugLog('CLI invocation started.', {
        command: args.command,
        subcommand: args.subcommand,
        cwd: process.cwd(),
    });
    if (args.command === '--version' || args.command === 'version' || hasFlag(args, 'version')) {
        printVersion();
        return;
    }

    if (!args.command || args.command === 'help' || args.command === '--help') {
        printHelp();
        return;
    }

    if (args.command === 'install') {
        if (hasFlag(args, 'help')) {
            printInstallHelp();
            return;
        }
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
            if (hasFlag(args, 'help')) {
                printInstanceHelp();
                return;
            }
            await createInstanceCommand(args);
            return;
        }
        if (args.subcommand === 'list') {
            if (hasFlag(args, 'help')) {
                printInstanceHelp();
                return;
            }
            await listInstancesCommand(args);
            return;
        }
        if (args.subcommand === 'show') {
            if (hasFlag(args, 'help')) {
                printInstanceHelp();
                return;
            }
            await showInstanceCommand(args);
            return;
        }
        if (args.subcommand === 'restart') {
            if (hasFlag(args, 'help')) {
                printInstanceHelp();
                return;
            }
            await restartInstanceCommand(args);
            return;
        }
        throw new Error(`Unknown instance subcommand '${args.subcommand ?? ''}'.`);
    }

    if (args.command === 'run') {
        if (hasFlag(args, 'help')) {
            printRunHelp();
            return;
        }
        await runInstanceCommand(args);
        return;
    }

    if (args.command === 'configure') {
        if (!args.subcommand || args.subcommand === 'help' || args.subcommand === '--help') {
            printConfigureHelp();
            return;
        }
        if (args.subcommand === 'instance') {
            if (hasFlag(args, 'help')) {
                printConfigureInstanceHelp();
                return;
            }
            await configureInstanceCommand(args);
            return;
        }
        if (args.subcommand === 'project') {
            if (hasFlag(args, 'help')) {
                printConfigureProjectHelp();
                return;
            }
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
            if (hasFlag(args, 'help')) {
                printAuthCreateKeyHelp();
                return;
            }
            await authCreateKeyCommand(args);
            return;
        }
        if (args.subcommand === 'list-keys') {
            if (hasFlag(args, 'help')) {
                printAuthListKeysHelp();
                return;
            }
            await authListKeysCommand(args);
            return;
        }
        if (args.subcommand === 'revoke-key') {
            if (hasFlag(args, 'help')) {
                printAuthRevokeKeyHelp();
                return;
            }
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
        if (hasFlag(args, 'help')) {
            printProjectInitHelp();
            return;
        }
        await projectInitCommand(args);
        return;
    }

    if (args.command === 'project' && args.subcommand === 'unbind') {
        if (hasFlag(args, 'help')) {
            printProjectUnbindHelp();
            return;
        }
        await projectUnbindCommand(args);
        return;
    }

    if (args.command === 'doctor') {
        if (hasFlag(args, 'help')) {
            printDoctorHelp();
            return;
        }
        await doctorCommand(args);
        return;
    }

    if (args.command === 'status') {
        if (hasFlag(args, 'help')) {
            printStatusHelp();
            return;
        }
        await statusCommand(args);
        return;
    }

    if (args.command === 'upgrade') {
        if (hasFlag(args, 'help')) {
            printUpgradeHelp();
            return;
        }
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
        if (hasFlag(args, 'help')) {
            printHandshakeHelp();
            return;
        }
        await handshakeCommand(args);
        return;
    }

    if (args.command === 'attend') {
        if (hasFlag(args, 'help')) {
            printAttendHelp();
            return;
        }
        await attendCommand(args);
        return;
    }

    if (args.command === 'issues') {
        if (hasFlag(args, 'help')) {
            printIssuesHelp();
            return;
        }
        await issuesCommand(args);
        return;
    }

    if (args.command === 'handoff') {
        if (hasFlag(args, 'help')) {
            printHandoffHelp();
            return;
        }
        await handoffCommand(args);
        return;
    }

    if (args.command === 'chat') {
        if (hasFlag(args, 'help')) {
            printChatHelp();
            return;
        }
        await chatCommand(args);
        return;
    }

    if (args.command === 'resolve') {
        if (hasFlag(args, 'help')) {
            printResolveHelp();
            return;
        }
        await resolveCommand(args);
        return;
    }

    if (args.command === 'mcp') {
        if (!args.subcommand || args.subcommand === 'server') {
            if (hasFlag(args, 'help')) {
                printMcpHelp();
                return;
            }
            await handoffToScript('iranti-mcp', args.subcommand === 'server' ? process.argv.slice(4) : process.argv.slice(3));
            return;
        }
        if (args.subcommand === 'cleanup') {
            if (hasFlag(args, 'help')) {
                printMcpHelp();
                return;
            }
            await mcpCleanupCommand(args);
            return;
        }
        if (args.subcommand === 'help' || args.subcommand === '--help') {
            printMcpHelp();
            return;
        }
        await handoffToScript('iranti-mcp', process.argv.slice(3));
        return;
    }

    if (args.command === 'list-rules') {
        if (hasFlag(args, 'help')) {
            printListRulesHelp();
            return;
        }
        await listRulesCommand(args);
        return;
    }

    if (args.command === 'delete-rule') {
        if (hasFlag(args, 'help')) {
            printDeleteRuleHelp();
            return;
        }
        await deleteRuleCommand(args);
        return;
    }

    if (args.command === 'revert-autowrite') {
        if (hasFlag(args, 'help')) {
            printRevertAutowriteHelp();
            return;
        }
        await revertAutowriteCommand(args);
        return;
    }

    if (args.command === 'claude-setup') {
        await claudeSetupCommand(args);
        return;
    }

    if (args.command === 'claude-unsetup') {
        await claudeUnsetupCommand(args);
        return;
    }

    if (args.command === 'claude-hook') {
        await handoffToScript('claude-code-memory-hook', process.argv.slice(3));
        return;
    }

    if (args.command === 'codex-setup') {
        if (hasFlag(args, 'global')) {
            await codexGlobalSetupCommand(hasFlag(args, 'force'));
            return;
        }
        await handoffToScript('codex-setup', process.argv.slice(3));
        return;
    }

    if (args.command === 'codex-unsetup') {
        if (hasFlag(args, 'global')) {
            await codexGlobalUnsetup();
            return;
        }
        // Per-project codex unsetup: remove iranti block from AGENTS.md, iranti from .mcp.json/.vscode/mcp.json
        const projectArg = args.positionals[0];
        const projectPath = path.resolve(projectArg ?? process.cwd());
        let agentsStatus = 'not present';
        let mcpStatus = 'not present';
        let vscodeMcpStatus = 'not present';
        const agentsFile = path.join(projectPath, 'AGENTS.md');
        if (fs.existsSync(agentsFile)) {
            const content = fs.readFileSync(agentsFile, 'utf8');
            if (content.includes('<!-- iranti-rules -->')) {
                const cleaned = content.replace(/\n*<!-- iranti-rules -->[\s\S]*?<!-- \/iranti-rules -->\n*/g, '\n').trimEnd();
                await writeText(agentsFile, cleaned ? `${cleaned}\n` : '');
                agentsStatus = 'block removed';
            }
        }
        const mcpFile = path.join(projectPath, '.mcp.json');
        if (fs.existsSync(mcpFile)) {
            const existing = readJsonFile<Record<string, unknown>>(mcpFile);
            if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
                const servers = existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers) ? { ...(existing.mcpServers as Record<string, unknown>) } : null;
                if (servers && Object.prototype.hasOwnProperty.call(servers, 'iranti')) {
                    delete servers.iranti;
                    await writeText(mcpFile, `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`);
                    mcpStatus = 'removed';
                }
            }
        }
        const vscodeMcpFile = path.join(projectPath, '.vscode', 'mcp.json');
        if (fs.existsSync(vscodeMcpFile)) {
            const existing = readJsonFile<Record<string, unknown>>(vscodeMcpFile);
            if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
                const servers = existing.servers && typeof existing.servers === 'object' && !Array.isArray(existing.servers) ? { ...(existing.servers as Record<string, unknown>) } : null;
                if (servers && Object.prototype.hasOwnProperty.call(servers, 'iranti')) {
                    delete servers.iranti;
                    await writeText(vscodeMcpFile, `${JSON.stringify({ ...existing, servers }, null, 2)}\n`);
                    vscodeMcpStatus = 'removed';
                }
            }
        }
        console.log(`${okLabel()} Per-project Codex Iranti integration removed`);
        console.log(`  project       ${projectPath}`);
        console.log(`  AGENTS.md     ${agentsStatus}`);
        console.log(`  .mcp.json     ${mcpStatus}`);
        console.log(`  .vscode/mcp   ${vscodeMcpStatus}`);
        return;
    }

    if (args.command === 'copilot-setup') {
        await handoffToScript('copilot-setup', process.argv.slice(3));
        return;
    }

    if (args.command === 'copilot-unsetup') {
        // Per-project copilot unsetup: remove iranti block from .github/copilot-instructions.md, iranti from .mcp.json/.vscode/mcp.json
        const projectArg = args.positionals[0];
        const projectPath = path.resolve(projectArg ?? process.cwd());
        let instructionsStatus = 'not present';
        let mcpStatus = 'not present';
        let vscodeMcpStatus = 'not present';
        const instructionsFile = path.join(projectPath, '.github', 'copilot-instructions.md');
        if (fs.existsSync(instructionsFile)) {
            const content = fs.readFileSync(instructionsFile, 'utf8');
            if (content.includes('<!-- iranti-rules -->')) {
                const cleaned = content.replace(/\n*<!-- iranti-rules -->[\s\S]*?<!-- \/iranti-rules -->\n*/g, '\n').trimEnd();
                await writeText(instructionsFile, cleaned ? `${cleaned}\n` : '');
                instructionsStatus = 'block removed';
            }
        }
        const mcpFile = path.join(projectPath, '.mcp.json');
        if (fs.existsSync(mcpFile)) {
            const existing = readJsonFile<Record<string, unknown>>(mcpFile);
            if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
                const servers = existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers) ? { ...(existing.mcpServers as Record<string, unknown>) } : null;
                if (servers && Object.prototype.hasOwnProperty.call(servers, 'iranti')) {
                    delete servers.iranti;
                    await writeText(mcpFile, `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`);
                    mcpStatus = 'removed';
                }
            }
        }
        const vscodeMcpFile = path.join(projectPath, '.vscode', 'mcp.json');
        if (fs.existsSync(vscodeMcpFile)) {
            const existing = readJsonFile<Record<string, unknown>>(vscodeMcpFile);
            if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
                const servers = existing.servers && typeof existing.servers === 'object' && !Array.isArray(existing.servers) ? { ...(existing.servers as Record<string, unknown>) } : null;
                if (servers && Object.prototype.hasOwnProperty.call(servers, 'iranti')) {
                    delete servers.iranti;
                    await writeText(vscodeMcpFile, `${JSON.stringify({ ...existing, servers }, null, 2)}\n`);
                    vscodeMcpStatus = 'removed';
                }
            }
        }
        console.log(`${okLabel()} Per-project Copilot Iranti integration removed`);
        console.log(`  project                          ${projectPath}`);
        console.log(`  .github/copilot-instructions.md  ${instructionsStatus}`);
        console.log(`  .mcp.json                        ${mcpStatus}`);
        console.log(`  .vscode/mcp                      ${vscodeMcpStatus}`);
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
        if (args.subcommand === 'copilot') {
            await handoffToScript('copilot-setup', process.argv.slice(4));
            return;
        }
        throw new Error(`Unknown integrate target '${args.subcommand ?? ''}'. Use 'claude', 'codex', or 'copilot'.`);
    }

    throw cliError(
        'IRANTI_UNKNOWN_COMMAND',
        `Unknown command '${args.command}'. Run: iranti help`,
        ['Use `iranti help` to see the current command surface.'],
        { command: args.command }
    );
}

main().then(async () => {
    await flushStaffEventEmitter();
}).catch(async (err) => {
    try {
        await flushStaffEventEmitter();
    } catch {}
    const failure = normalizeCliFailure(err);
    const code = failure.code ?? 'IRANTI_COMMAND_FAILED';
    const message = failure.message;
    const hints = failure instanceof CliError ? failure.hints : (failure.hints ?? []);
    const details = failure instanceof CliError ? failure.details : undefined;

    if (wantsJsonErrorEnvelope(ACTIVE_PARSED_ARGS)) {
        const payload: Record<string, unknown> = {
            ok: false,
            error: {
                code,
                message,
                hints,
                ...(details && Object.keys(details).length > 0 ? { details } : {}),
                ...(CLI_DEBUG && failure.stack ? { stack: failure.stack } : {}),
            },
        };
        process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
        process.exit(1);
    }

    console.error(`${failLabel('ERROR')}${code ? ` [${code}]` : ''} ${message}`);
    if (hints.length > 0) {
        console.error('');
        console.error('Possible fixes:');
        for (const hint of hints) {
            console.error(`  - ${hint}`);
        }
    }
    if (CLI_DEBUG && details && Object.keys(details).length > 0) {
        console.error('');
        console.error(`${paint('[DEBUG]', 'gray')} ${JSON.stringify(details, null, 2)}`);
    }
    if (CLI_DEBUG && failure.stack) {
        console.error('');
        console.error(failure.stack);
    }
    process.exit(1);
});
