import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, SpawnSyncOptions } from 'child_process';

export type CommandInvocation = {
    executable: string;
    args: string[];
};

function windowsNodeToolScript(name: 'npm-cli.js' | 'npx-cli.js'): string {
    const nodeDir = path.dirname(process.execPath);
    const candidate = path.join(nodeDir, 'node_modules', 'npm', 'bin', name);
    if (!fs.existsSync(candidate)) {
        throw new Error(`Unable to locate ${name} next to ${process.execPath}.`);
    }
    return candidate;
}

function findPackageRoot(startDir: string): string | null {
    let current = startDir;
    for (let depth = 0; depth < 8; depth += 1) {
        const packageJson = path.join(current, 'package.json');
        if (fs.existsSync(packageJson)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return null;
}

function currentIrantiBin(): string | null {
    const packageRoot = findPackageRoot(__dirname);
    if (!packageRoot) {
        return null;
    }
    const candidate = path.join(packageRoot, 'bin', 'iranti.js');
    return fs.existsSync(candidate) ? candidate : null;
}

function windowsNodeToolOverride(envKey: 'IRANTI_TEST_NPM_CLI' | 'IRANTI_TEST_NPX_CLI', executable: string, args: string[]): CommandInvocation | null {
    const override = process.env[envKey]?.trim();
    if (!override) return null;
    const resolved = path.resolve(override);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Configured ${envKey} does not exist: ${resolved}`);
    }
    return {
        executable: process.execPath,
        args: [resolved, executable, ...args],
    };
}

function genericTestToolShim(executable: string, args: string[]): CommandInvocation | null {
    const override = process.env.IRANTI_TEST_TOOL_SHIM?.trim();
    if (!override) return null;
    if (path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
        return null;
    }
    const resolved = path.resolve(override);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Configured IRANTI_TEST_TOOL_SHIM does not exist: ${resolved}`);
    }
    return {
        executable: process.execPath,
        args: [resolved, executable, ...args],
    };
}

function spawnSyncText(command: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
    });
    return {
        status: result.status,
        stdout: typeof result.stdout === 'string' ? result.stdout : Buffer.from(result.stdout ?? []).toString('utf8'),
        stderr: typeof result.stderr === 'string' ? result.stderr : Buffer.from(result.stderr ?? []).toString('utf8'),
        error: result.error as Error | undefined,
    };
}

function windowsWhereHits(executable: string): string[] {
    const override = process.env.IRANTI_TEST_WHERE_EXE?.trim();
    const whereArgs = [executable];
    let result: { status: number | null; stdout: string; stderr: string; error?: Error };
    if (override) {
        const resolved = path.resolve(override);
        if (!fs.existsSync(resolved)) {
            throw new Error(`Configured IRANTI_TEST_WHERE_EXE does not exist: ${resolved}`);
        }
        if (/\.(cjs|mjs|js)$/i.test(resolved)) {
            result = spawnSyncText(process.execPath, [resolved, ...whereArgs]);
        } else {
            result = spawnSyncText(resolved, whereArgs);
        }
    } else {
        result = spawnSyncText('where.exe', whereArgs);
    }

    if (result.error || result.status !== 0) {
        return [];
    }

    return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function normalizeWindowsCandidate(candidate: string): string[] {
    const resolved = path.resolve(candidate);
    const ext = path.extname(resolved).toLowerCase();
    if (ext) {
        return [resolved];
    }

    const options = [resolved];
    for (const suffix of ['.exe', '.cmd', '.bat', '.ps1']) {
        const sibling = `${resolved}${suffix}`;
        if (fs.existsSync(sibling)) {
            options.push(sibling);
        }
    }
    return options;
}

function windowsCodexCandidates(rawCandidates: string[]): string[] {
    return Array.from(new Set(
        rawCandidates.flatMap((candidate) => normalizeWindowsCandidate(candidate)),
    ));
}

function windowsCodexInvocationFromCandidates(candidates: string[], args: string[]): CommandInvocation | null {
    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) {
            continue;
        }
        const ext = path.extname(candidate).toLowerCase();
        if (ext === '.exe') {
            return {
                executable: candidate,
                args: [...args],
            };
        }
    }

    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) {
            continue;
        }
        const ext = path.extname(candidate).toLowerCase();
        if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
            return {
                executable: process.execPath,
                args: [candidate, ...args],
            };
        }
        if (ext === '.cmd' || ext === '.bat') {
            const packageEntrypoint = path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
            if (fs.existsSync(packageEntrypoint)) {
                return {
                    executable: process.execPath,
                    args: [packageEntrypoint, ...args],
                };
            }
        }
    }

    return null;
}

function windowsCodexInvocation(args: string[]): CommandInvocation | null {
    const explicit = process.env.CODEX_CLI_PATH?.trim();
    if (explicit) {
        const explicitInvocation = windowsCodexInvocationFromCandidates(windowsCodexCandidates([explicit]), args);
        if (explicitInvocation) {
            return explicitInvocation;
        }
    }

    return windowsCodexInvocationFromCandidates(windowsCodexCandidates(windowsWhereHits('codex')), args);
}

export function resolveCommandInvocation(executable: string, args: string[]): CommandInvocation {
    if (process.platform !== 'win32') {
        return { executable, args: [...args] };
    }

    const shim = genericTestToolShim(executable, args);
    if (shim) return shim;

    if (executable === 'npm') {
        const override = windowsNodeToolOverride('IRANTI_TEST_NPM_CLI', executable, args);
        if (override) return override;
        return {
            executable: process.execPath,
            args: [windowsNodeToolScript('npm-cli.js'), ...args],
        };
    }

    if (executable === 'npx') {
        const override = windowsNodeToolOverride('IRANTI_TEST_NPX_CLI', executable, args);
        if (override) return override;
        return {
            executable: process.execPath,
            args: [windowsNodeToolScript('npx-cli.js'), ...args],
        };
    }

    if (executable === 'iranti') {
        const irantiBin = currentIrantiBin();
        if (irantiBin) {
            return {
                executable: process.execPath,
                args: [irantiBin, ...args],
            };
        }
    }

    if (executable === 'codex') {
        const invocation = windowsCodexInvocation(args);
        if (invocation) return invocation;
    }

    return { executable, args: [...args] };
}

export function spawnSyncResolved(
    executable: string,
    args: string[],
    options: SpawnSyncOptions,
){
    const invocation = resolveCommandInvocation(executable, args);
    return spawnSync(invocation.executable, invocation.args, {
        ...options,
        shell: false,
    });
}

export async function spawnResolved(
    executable: string,
    args: string[],
    options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        stdio?: 'inherit' | 'ignore';
        detached?: boolean;
        windowsHide?: boolean;
    } = {},
): Promise<void> {
    const invocation = resolveCommandInvocation(executable, args);
    await new Promise<void>((resolve, reject) => {
        const child = spawn(invocation.executable, invocation.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: options.stdio ?? 'inherit',
            detached: options.detached ?? false,
            windowsHide: options.windowsHide ?? false,
            shell: false,
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`${executable} terminated with signal ${signal}`));
                return;
            }
            if ((code ?? 0) !== 0) {
                reject(new Error(`${executable} exited with code ${code ?? 1}`));
                return;
            }
            resolve();
        });
    });
}
