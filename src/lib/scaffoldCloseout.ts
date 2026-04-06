import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { disconnectDb } from '../library/client';
import { createFirstPartyIranti } from './createFirstPartyIranti';
import { buildSemanticFactTags } from './semanticFactTags';

export type ScaffoldCloseoutStatus =
    | { status: 'written'; detail: string; entity: string; key: string; sessionId: string | null; }
    | { status: 'skipped' | 'failed'; detail: string; entity: null; key: null; sessionId: null; };

export type ScaffoldCloseoutFile = {
    path: string;
    status: 'created' | 'updated' | 'unchanged';
};

type ScaffoldCloseoutInput = {
    tool: 'claude' | 'codex' | 'copilot';
    projectPath: string;
    projectEnvFile?: string | null;
    files: ScaffoldCloseoutFile[];
    agentId?: string;
};

async function readEnvFile(filePath: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const raw = await fsp.readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        const valueRaw = trimmed.slice(idx + 1).trim();
        out[key] =
            (valueRaw.startsWith('"') && valueRaw.endsWith('"'))
            || (valueRaw.startsWith("'") && valueRaw.endsWith("'"))
                ? valueRaw.slice(1, -1)
                : valueRaw;
    }
    return out;
}

function toolDisplayName(tool: 'claude' | 'codex' | 'copilot'): string {
    switch (tool) {
        case 'claude': return 'Claude';
        case 'codex': return 'Codex';
        case 'copilot': return 'Copilot';
    }
}

function closeoutKey(tool: 'claude' | 'codex' | 'copilot'): string {
    switch (tool) {
        case 'claude': return 'claude_setup_scaffold_status';
        case 'codex': return 'codex_setup_scaffold_status';
        case 'copilot': return 'copilot_setup_scaffold_status';
    }
}

function closeoutSource(tool: 'claude' | 'codex' | 'copilot'): string {
    switch (tool) {
        case 'claude': return 'ClaudeSetupScaffold';
        case 'codex': return 'CodexSetupScaffold';
        case 'copilot': return 'CopilotSetupScaffold';
    }
}

export async function writeProjectScaffoldCloseout(input: ScaffoldCloseoutInput): Promise<ScaffoldCloseoutStatus> {
    const projectEnvFile = input.projectEnvFile?.trim();
    if (!projectEnvFile) {
        return { status: 'skipped', detail: 'no project binding available', entity: null, key: null, sessionId: null };
    }
    if (!fs.existsSync(projectEnvFile)) {
        return { status: 'skipped', detail: 'project binding file not found', entity: null, key: null, sessionId: null };
    }

    try {
        const binding = await readEnvFile(projectEnvFile);
        const entity = binding.IRANTI_MEMORY_ENTITY?.trim();
        if (!entity) {
            return { status: 'skipped', detail: 'binding is missing IRANTI_MEMORY_ENTITY', entity: null, key: null, sessionId: null };
        }

        const instanceEnvFile = binding.IRANTI_INSTANCE_ENV?.trim();
        if (!instanceEnvFile) {
            return { status: 'skipped', detail: 'binding is missing IRANTI_INSTANCE_ENV', entity: null, key: null, sessionId: null };
        }
        if (!fs.existsSync(instanceEnvFile)) {
            return { status: 'skipped', detail: 'instance env file not found', entity: null, key: null, sessionId: null };
        }

        const instanceEnv = await readEnvFile(instanceEnvFile);
        const connectionString = instanceEnv.DATABASE_URL?.trim();
        if (!connectionString) {
            return { status: 'skipped', detail: 'instance env is missing DATABASE_URL', entity: null, key: null, sessionId: null };
        }

        const toolName = toolDisplayName(input.tool);
        const key = closeoutKey(input.tool);
        const source = closeoutSource(input.tool);
        const projectLabel = path.basename(path.resolve(input.projectPath));
        const fileOutputs = input.files.map((file) => `${path.basename(file.path)}:${file.status}`);
        const iranti = createFirstPartyIranti({
            connectionString,
            llmProvider: instanceEnv.LLM_PROVIDER,
            sessionLedgerSource: 'cli',
            sessionLedgerHost: 'plain_cli',
            sessionLedgerAgentId: input.agentId ?? 'iranti_cli_scaffold',
        });

        await iranti.write({
            entity,
            key,
            value: {
                tool: `${input.tool}-setup`,
                projectPath: path.resolve(input.projectPath),
                projectEnvFile,
                files: input.files,
                updatedAt: new Date().toISOString(),
            },
            summary: `${toolName} setup scaffold updated integration files for ${projectLabel}.`,
            confidence: 95,
            source,
            agent: input.agentId ?? 'iranti_cli_scaffold',
            properties: {
                memoryScope: 'project',
                capturePhase: 'manual',
                durableClass: 'scaffold_status',
                canonicalKey: key,
                mergeStrategy: 'replace',
                ...buildSemanticFactTags({
                    memoryScope: 'project',
                    durableClass: 'scaffold_status',
                    mergeStrategy: 'replace',
                    extraTags: ['integration', input.tool, 'scaffold'],
                }),
            },
        });

        const brief = await iranti.checkpoint({
            agentId: input.agentId ?? 'iranti_cli_scaffold',
            task: `${toolName} setup scaffold for ${projectLabel}`,
            recentMessages: [`Scaffold ${toolName} integration files for ${projectLabel}.`],
            checkpoint: {
                currentStep: `${toolName} setup scaffolded MCP and host protocol files for ${projectLabel}.`,
                nextStep: `Open ${projectLabel} in ${toolName} and verify Iranti tools are available before real work starts.`,
                recentOutputs: fileOutputs,
                entityTargets: [entity],
            },
        });

        return {
            status: 'written',
            detail: `shared closeout written to ${entity}/${key}`,
            entity,
            key,
            sessionId: brief.sessionCheckpoint?.sessionId ?? null,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: 'failed', detail: message, entity: null, key: null, sessionId: null };
    } finally {
        await disconnectDb().catch(() => undefined);
    }
}
