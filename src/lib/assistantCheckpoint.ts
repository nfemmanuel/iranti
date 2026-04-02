import { extractExplicitAssistantMemory } from './autoRemember';

export type AssistantCheckpointPayload = {
    currentStep?: string;
    nextStep?: string;
    openRisks?: string[];
    recentOutputs?: string[];
    actions?: Array<{
        kind: string;
        summary: string;
        status?: string;
        target?: string;
        detail?: string;
    }>;
    fileChanges?: Array<{
        action: string;
        path: string;
        toPath?: string;
        purpose?: string;
    }>;
};

function readTextField(value: unknown, preferredKey: string): string | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const raw = record[preferredKey];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function readItems(value: unknown): string[] {
    if (typeof value !== 'object' || value === null) return [];
    const record = value as Record<string, unknown>;
    const items = Array.isArray(record.items) ? record.items : [];
    return items.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function readFileChangeOutputs(value: unknown): string[] {
    if (typeof value !== 'object' || value === null) return [];
    const record = value as Record<string, unknown>;
    const items = Array.isArray(record.items) ? record.items : [];
    return items.map((item) => {
        if (typeof item !== 'object' || item === null) return '';
        const change = item as Record<string, unknown>;
        const action = String(change.action ?? 'updated').trim();
        const targetPath = String(change.path ?? '').trim();
        const toPath = String(change.toPath ?? '').trim();
        if (!targetPath) return '';
        return toPath ? `${action} ${targetPath} -> ${toPath}` : `${action} ${targetPath}`;
    }).filter(Boolean);
}

function readCheckpointActions(value: unknown): Array<{
    kind: string;
    summary: string;
    status?: string;
    target?: string;
    detail?: string;
}> {
    if (typeof value !== 'object' || value === null) return [];
    const record = value as Record<string, unknown>;
    const items = Array.isArray(record.items) ? record.items : [];
    return items
        .map((item) => {
            if (typeof item !== 'object' || item === null) return null;
            const action = item as Record<string, unknown>;
            const summary = String(action.summary ?? '').trim();
            if (!summary) return null;
            const kind = String(action.kind ?? 'action').trim() || 'action';
            return {
                kind,
                summary,
                ...(typeof action.status === 'string' && action.status.trim() ? { status: action.status.trim() } : {}),
                ...(typeof action.target === 'string' && action.target.trim() ? { target: action.target.trim() } : {}),
                ...(typeof action.detail === 'string' && action.detail.trim() ? { detail: action.detail.trim() } : {}),
            };
        })
        .filter((item): item is {
            kind: string;
            summary: string;
            status?: string;
            target?: string;
            detail?: string;
        } => Boolean(item));
}

function readActionOutputs(value: unknown): string[] {
    if (typeof value !== 'object' || value === null) return [];
    const record = value as Record<string, unknown>;
    const items = Array.isArray(record.items) ? record.items : [];
    return items.map((item) => {
        if (typeof item !== 'object' || item === null) return '';
        const action = item as Record<string, unknown>;
        const kind = String(action.kind ?? 'action').trim() || 'action';
        const summary = String(action.summary ?? '').trim();
        const status = String(action.status ?? '').trim();
        if (!summary) return '';
        return status ? `[${status}] ${kind}: ${summary}` : `${kind}: ${summary}`;
    }).filter(Boolean);
}

export function extractAssistantCheckpointPayload(response: string): AssistantCheckpointPayload | null {
    const facts = extractExplicitAssistantMemory(response).filter((fact) => fact.scope === 'project');
    if (facts.length === 0) {
        return null;
    }

    const checkpoint: AssistantCheckpointPayload = {};
    const outputs: string[] = [];
    for (const fact of facts) {
        if (fact.key === 'current_step') {
            checkpoint.currentStep = readTextField(fact.value, 'text');
            continue;
        }
        if (fact.key === 'next_step') {
            checkpoint.nextStep = readTextField(fact.value, 'instruction') ?? readTextField(fact.value, 'text');
            continue;
        }
        if (fact.key === 'open_risks') {
            checkpoint.openRisks = readItems(fact.value);
            continue;
        }
        if (fact.key === 'important_artifacts') {
            outputs.push(...readItems(fact.value));
            continue;
        }
        if (fact.key === 'recent_file_changes') {
            const fileChanges = typeof fact.value === 'object' && fact.value !== null && Array.isArray((fact.value as Record<string, unknown>).items)
                ? ((fact.value as Record<string, unknown>).items as Array<Record<string, unknown>>)
                    .filter((item) => item && typeof item === 'object')
                    .map((item) => ({
                        action: String(item.action ?? 'updated').trim() || 'updated',
                        path: String(item.path ?? '').trim(),
                        ...(typeof item.toPath === 'string' && item.toPath.trim() ? { toPath: String(item.toPath).trim() } : {}),
                        ...(typeof item.purpose === 'string' && item.purpose.trim() ? { purpose: String(item.purpose).trim() } : {}),
                    }))
                    .filter((item) => item.path)
                : [];
            if (fileChanges.length > 0) {
                checkpoint.fileChanges = [...(checkpoint.fileChanges ?? []), ...fileChanges];
            }
            outputs.push(...readFileChangeOutputs(fact.value));
            continue;
        }
        if (fact.key === 'recent_actions') {
            const actions = readCheckpointActions(fact.value);
            if (actions.length > 0) {
                checkpoint.actions = [...(checkpoint.actions ?? []), ...actions];
            }
            outputs.push(...readActionOutputs(fact.value));
            continue;
        }
        if (fact.key === 'failed_paths') {
            outputs.push(...readItems(fact.value));
        }
    }

    if (outputs.length > 0) {
        checkpoint.recentOutputs = outputs;
    }

    return checkpoint.currentStep
        || checkpoint.nextStep
        || (checkpoint.openRisks && checkpoint.openRisks.length > 0)
        || (checkpoint.recentOutputs && checkpoint.recentOutputs.length > 0)
        || (checkpoint.actions && checkpoint.actions.length > 0)
        || (checkpoint.fileChanges && checkpoint.fileChanges.length > 0)
        ? checkpoint
        : null;
}
