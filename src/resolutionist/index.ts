import fs from 'fs/promises';
import path from 'path';
import readline from 'readline/promises';

type EscalationContext = {
    filename: string;
    filePath: string;
    detectedAt: string;
    requestId: string;
    entityType: string;
    entityId: string;
    key: string;
    existingValue: unknown;
    existingConfidence: string;
    incomingValue: unknown;
    incomingConfidence: string;
    reasoning: string;
};

type ResolutionSummary = {
    resolved: number;
    skipped: number;
    remaining: number;
};

function parseEscalationValue(raw: string): unknown {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return trimmed;
    }
}

function extractField(content: string, label: string): string | null {
    const match = content.match(new RegExp(`^- \\*\\*${label}:\\*\\* (.+)$`, 'm'));
    return match?.[1]?.trim() ?? null;
}

function parseEntityDescriptor(raw: string | null): { entityType: string; entityId: string; key: string } {
    if (!raw) {
        throw new Error('Missing Entity field.');
    }
    const parts = raw.split('/').map((part) => part.trim());
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        throw new Error(`Malformed Entity field: ${raw}`);
    }
    return {
        entityType: parts[0],
        entityId: parts[1],
        key: parts[2],
    };
}

function parseEscalationFile(filename: string, filePath: string, content: string): EscalationContext {
    const entity = parseEntityDescriptor(extractField(content, 'Entity'));
    return {
        filename,
        filePath,
        detectedAt: extractField(content, 'Detected at') ?? 'unknown',
        requestId: extractField(content, 'Request ID') ?? 'unknown',
        entityType: entity.entityType,
        entityId: entity.entityId,
        key: entity.key,
        existingValue: parseEscalationValue(extractField(content, 'Existing value') ?? 'null'),
        existingConfidence: extractField(content, 'Existing confidence') ?? 'unknown',
        incomingValue: parseEscalationValue(extractField(content, 'Incoming value') ?? 'null'),
        incomingConfidence: extractField(content, 'Incoming confidence') ?? 'unknown',
        reasoning: extractField(content, 'Reasoning') ?? 'No Librarian reasoning recorded.',
    };
}

function formatValue(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function buildSummary(context: EscalationContext, value: unknown): string {
    const normalized = typeof value === 'string' ? value : JSON.stringify(value);
    const compact = normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
    return `${context.entityType}/${context.entityId} ${context.key} resolved to ${compact}`;
}

function replaceAuthoritativeJson(content: string, payload: Record<string, unknown>): string {
    const marker = '### AUTHORITATIVE_JSON';
    const markerIndex = content.indexOf(marker);
    if (markerIndex === -1) {
        throw new Error("Missing '### AUTHORITATIVE_JSON' section.");
    }

    const afterMarkerIndex = markerIndex + marker.length;
    const afterMarker = content.slice(afterMarkerIndex);
    const fenceStart = afterMarker.indexOf('```json');
    if (fenceStart === -1) {
        throw new Error('Missing ```json block after AUTHORITATIVE_JSON.');
    }

    const jsonStart = afterMarkerIndex + fenceStart + '```json'.length;
    const afterFence = content.slice(jsonStart);
    const fenceEnd = afterFence.indexOf('```');
    if (fenceEnd === -1) {
        throw new Error('Unclosed ```json block in AUTHORITATIVE_JSON.');
    }

    const jsonEnd = jsonStart + fenceEnd;
    const serialized = `\n${JSON.stringify(payload, null, 2)}\n`;
    return `${content.slice(0, jsonStart)}${serialized}${content.slice(jsonEnd)}`;
}

function markResolved(content: string): string {
    if (content.includes('**Status:** RESOLVED')) {
        return content;
    }
    if (!content.includes('**Status:** PENDING')) {
        throw new Error("Missing '**Status:** PENDING' marker.");
    }
    return content.replace('**Status:** PENDING', '**Status:** RESOLVED');
}

async function readPendingEscalations(activeDir: string): Promise<EscalationContext[]> {
    const entries = await fs.readdir(activeDir, { withFileTypes: true });
    const pending: EscalationContext[] = [];

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) {
            continue;
        }
        const filePath = path.join(activeDir, entry.name);
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            if (!content.includes('**Status:** PENDING')) {
                continue;
            }
            pending.push(parseEscalationFile(entry.name, filePath, content));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[resolutionist] Skipping ${entry.name}: ${message}`);
        }
    }

    pending.sort((a, b) => a.filename.localeCompare(b.filename));
    return pending;
}

async function promptChoice(rl: readline.Interface): Promise<'1' | '2' | '3' | 'S' | 'Q'> {
    while (true) {
        const answer = (await rl.question('Choose [1/2/3/S/Q]: ')).trim().toUpperCase();
        if (['1', '2', '3', 'S', 'Q'].includes(answer)) {
            return answer as '1' | '2' | '3' | 'S' | 'Q';
        }
        console.log('Enter 1, 2, 3, S, or Q.');
    }
}

async function promptCustomJson(rl: readline.Interface): Promise<unknown> {
    while (true) {
        const raw = (await rl.question('Custom value (valid JSON): ')).trim();
        if (!raw) {
            console.log('Custom value is required.');
            continue;
        }
        try {
            return JSON.parse(raw);
        } catch {
            console.log('Value must parse as valid JSON.');
        }
    }
}

async function promptRequired(rl: readline.Interface, prompt: string): Promise<string> {
    while (true) {
        const value = (await rl.question(`${prompt}: `)).trim();
        if (value.length > 0) {
            return value;
        }
        console.log(`${prompt} is required.`);
    }
}

function printEscalation(context: EscalationContext): void {
    console.log('');
    console.log(`File: ${context.filename}`);
    console.log(`Entity: ${context.entityType}/${context.entityId}`);
    console.log(`Key: ${context.key}`);
    console.log(`Escalated at: ${context.detectedAt}`);
    console.log(`Request ID: ${context.requestId}`);
    console.log('Existing fact:');
    console.log(`  value      ${formatValue(context.existingValue)}`);
    console.log(`  confidence ${context.existingConfidence}`);
    console.log('  source     not recorded in escalation file');
    console.log('  validFrom  not recorded in escalation file');
    console.log('Challenging fact:');
    console.log(`  value      ${formatValue(context.incomingValue)}`);
    console.log(`  confidence ${context.incomingConfidence}`);
    console.log('  source     not recorded in escalation file');
    console.log('  validFrom  not recorded in escalation file');
    console.log(`Librarian notes: ${context.reasoning}`);
    console.log('');
    console.log('[1] Accept existing fact');
    console.log('[2] Accept challenger');
    console.log('[3] Enter custom value');
    console.log('[S] Skip this escalation');
    console.log('[Q] Quit');
}

export async function resolveInteractive(escalationDir: string): Promise<ResolutionSummary> {
    const root = path.resolve(escalationDir);
    const activeDir = path.join(root, 'active');
    const resolvedDir = path.join(root, 'resolved');
    const archivedDir = path.join(root, 'archived');

    await Promise.all([
        fs.mkdir(activeDir, { recursive: true }),
        fs.mkdir(resolvedDir, { recursive: true }),
        fs.mkdir(archivedDir, { recursive: true }),
    ]);

    const pending = await readPendingEscalations(activeDir);
    if (pending.length === 0) {
        console.log(`No pending escalations in ${activeDir}.`);
        return { resolved: 0, skipped: 0, remaining: 0 };
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    let resolved = 0;
    let skipped = 0;
    let quitRequested = false;

    try {
        for (const escalation of pending) {
            printEscalation(escalation);
            const choice = await promptChoice(rl);

            if (choice === 'Q') {
                quitRequested = true;
                break;
            }

            if (choice === 'S') {
                skipped++;
                continue;
            }

            let payload: Record<string, unknown>;
            if (choice === '1' || choice === '2') {
                const acceptedValue = choice === '1' ? escalation.existingValue : escalation.incomingValue;
                payload = {
                    entityType: escalation.entityType,
                    entityId: escalation.entityId,
                    key: escalation.key,
                    value: acceptedValue,
                    summary: buildSummary(escalation, acceptedValue),
                    notes: choice === '1'
                        ? 'Resolutionist accepted the pre-escalation fact.'
                        : 'Resolutionist accepted the challenging fact.',
                };
            } else {
                const value = await promptCustomJson(rl);
                const summary = await promptRequired(rl, 'Summary');
                const confidence = await promptRequired(rl, 'Reviewer confidence (0-100)');
                const notes = (await rl.question('Optional notes: ')).trim();
                payload = {
                    entityType: escalation.entityType,
                    entityId: escalation.entityId,
                    key: escalation.key,
                    value,
                    summary,
                    notes: notes
                        ? `${notes} | Reviewer confidence: ${confidence}`
                        : `Reviewer confidence: ${confidence}`,
                };
            }

            try {
                const original = await fs.readFile(escalation.filePath, 'utf-8');
                const withJson = replaceAuthoritativeJson(original, payload);
                const resolvedContent = markResolved(withJson);
                await fs.writeFile(escalation.filePath, resolvedContent, 'utf-8');
                resolved++;
                console.log(`Resolved ${escalation.entityType}/${escalation.entityId}/${escalation.key} -> ${formatValue(payload.value)}`);
            } catch (error) {
                skipped++;
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[resolutionist] Could not update ${escalation.filename}: ${message}`);
            }
        }
    } finally {
        rl.close();
    }

    const remaining = (await readPendingEscalations(activeDir)).length;
    if (quitRequested) {
        console.log('Resolutionist exited before processing all pending escalations.');
    }
    console.log(`Summary: ${resolved} resolved, ${skipped} skipped, ${remaining} remaining.`);
    return { resolved, skipped, remaining };
}
