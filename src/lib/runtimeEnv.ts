import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

type RuntimeEnvOptions = {
    cwd?: string;
    payloadCwd?: string;
    projectEnvFile?: string;
    instanceEnvFile?: string;
    explicitEnvFile?: string;
};

type RuntimeEnvLoadResult = {
    loadedFiles: string[];
    projectEnvFile?: string;
    instanceEnvFile?: string;
};

function parseEnvFile(filePath: string): Record<string, string> {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return dotenv.parse(raw);
}

function applyEnvVars(vars: Record<string, string>, initialEnvKeys: Set<string>): void {
    for (const [key, value] of Object.entries(vars)) {
        if (initialEnvKeys.has(key)) continue;
        process.env[key] = value;
    }
}

function dedupePaths(paths: Array<string | undefined | null>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const candidate of paths) {
        if (!candidate) continue;
        const resolved = path.resolve(candidate);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        out.push(resolved);
    }
    return out;
}

function findProjectEnvFile(options: RuntimeEnvOptions): string | undefined {
    const explicit = options.projectEnvFile?.trim() || process.env.IRANTI_PROJECT_ENV?.trim();
    if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);

    const candidates = dedupePaths([
        options.payloadCwd ? path.join(options.payloadCwd, '.env.iranti') : null,
        options.cwd ? path.join(options.cwd, '.env.iranti') : null,
        path.join(process.cwd(), '.env.iranti'),
    ]);

    return candidates.find((candidate) => fs.existsSync(candidate));
}

function findFallbackEnvFile(options: RuntimeEnvOptions): string | undefined {
    const explicit = options.explicitEnvFile?.trim() || process.env.IRANTI_ENV_FILE?.trim();
    if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);

    const candidates = dedupePaths([
        options.payloadCwd ? path.join(options.payloadCwd, '.env') : null,
        options.cwd ? path.join(options.cwd, '.env') : null,
        path.join(process.cwd(), '.env'),
        path.resolve(__dirname, '..', '..', '.env'),
        path.resolve(__dirname, '..', '..', '..', '.env'),
    ]);

    return candidates.find((candidate) => fs.existsSync(candidate));
}

export function loadRuntimeEnv(options: RuntimeEnvOptions = {}): RuntimeEnvLoadResult {
    const loadedFiles: string[] = [];
    const initialEnvKeys = new Set(Object.keys(process.env));

    const fallbackEnvFile = findFallbackEnvFile(options);
    if (fallbackEnvFile) {
        applyEnvVars(parseEnvFile(fallbackEnvFile), initialEnvKeys);
        loadedFiles.push(fallbackEnvFile);
    }

    const projectEnvFile = findProjectEnvFile(options);
    const projectEnv = projectEnvFile && fs.existsSync(projectEnvFile)
        ? parseEnvFile(projectEnvFile)
        : null;

    const instanceEnvFile = options.instanceEnvFile?.trim()
        || process.env.IRANTI_INSTANCE_ENV?.trim()
        || projectEnv?.IRANTI_INSTANCE_ENV;

    const resolvedInstanceEnvFile = instanceEnvFile && fs.existsSync(instanceEnvFile)
        ? path.resolve(instanceEnvFile)
        : undefined;

    if (resolvedInstanceEnvFile) {
        applyEnvVars(parseEnvFile(resolvedInstanceEnvFile), initialEnvKeys);
        loadedFiles.push(resolvedInstanceEnvFile);
    }

    if (projectEnvFile && projectEnv) {
        applyEnvVars(projectEnv, initialEnvKeys);
        loadedFiles.push(projectEnvFile);
    }

    return {
        loadedFiles,
        projectEnvFile,
        instanceEnvFile: resolvedInstanceEnvFile,
    };
}
