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
