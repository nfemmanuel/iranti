import 'dotenv/config';
import path from 'path';
import type { Iranti } from '../src/sdk';
import { createFirstPartyIranti } from '../src/lib/createFirstPartyIranti';
import { loadRuntimeEnv } from '../src/lib/runtimeEnv';
import { flushStaffEventEmitter } from '../src/lib/staffEventRegistry';
import {
    autoRememberAssistantFacts,
    autoRememberPromptFacts,
    canonicalizeMemoryKey,
    classifyMemoryScope,
    extractExplicitAssistantMemory,
    getPersonalMemoryEntity,
    getProjectMemoryEntity,
    isAutoRememberEnabled,
} from '../src/lib/autoRemember';

type HookEventName = 'SessionStart' | 'UserPromptSubmit' | 'Stop';
type HookPayload = Record<string, unknown>;
type HookFact = {
    entity: string;
    key: string;
    summary: string;
    confidence: number;
    source: string;
};

type HookWorkingMemoryEntry = {
    entityKey?: unknown;
    summary?: unknown;
    confidence?: unknown;
    source?: unknown;
};

type HookCheckpointPayload = {
    currentStep?: string;
    nextStep?: string;
    openRisks?: string[];
    recentOutputs?: string[];
};

const MEMORY_NEED_POSITIVE_PATTERNS: RegExp[] = [
    /\bwhat(?:'s| is| was)?\s+my\b/i,
    /\bdo you remember\b/i,
    /\bremind me\b/i,
    /\bmy\s+(?:favorite|favourite|name|email|phone|address|city|country|movie|snack|color|colour)\b/i,
    /\bwe decided\b/i,
    /\bearlier\b/i,
    /\bprevious(?:ly)?\b/i,
    /\bagain\b/i,
];

const MEMORY_NEED_NEGATIVE_PATTERNS: RegExp[] = [
    /^\s*(hi|hello|hey|yo|sup|good (?:morning|afternoon|evening))\b[!.?\s]*$/i,
    /^\s*(thanks|thank you|cool|great|nice)\b[!.?\s]*$/i,
];

function printHelp(): void {
    console.log([
        'Claude Code -> Iranti hook helper',
        '',
        'Usage:',
        '  ts-node scripts/claude-code-memory-hook.ts --event SessionStart',
        '  ts-node scripts/claude-code-memory-hook.ts --event UserPromptSubmit',
        '  ts-node scripts/claude-code-memory-hook.ts --event Stop',
        '',
        'Optional flags:',
        '  --project-env <path>   Explicit .env.iranti path',
        '  --instance-env <path>  Explicit instance env path',
        '  --env-file <path>      Explicit base .env path',
        '',
        'Reads Claude Code hook JSON from stdin and returns hookSpecificOutput.additionalContext on stdout.',
        'This helper retrieves working memory; durable KB writes still require explicit iranti_write/ingest calls.',
        'Set IRANTI_AUTO_REMEMBER=true to auto-save narrow personal facts to IRANTI_PERSONAL_MEMORY_ENTITY/user/main, project summaries to IRANTI_MEMORY_ENTITY, and shared checkpoint breadcrumbs for resumable work.',
    ].join('\n'));
}

function parseArgs(argv: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            out[key] = 'true';
            continue;
        }
        out[key] = next;
        i += 1;
    }
    return out;
}

async function readStdin(): Promise<string> {
    return new Promise((resolve) => {
        let out = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { out += chunk; });
        process.stdin.on('end', () => resolve(out));
        process.stdin.resume();
    });
}

function parsePayload(raw: string): HookPayload {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
        return JSON.parse(trimmed) as HookPayload;
    } catch {
        return {};
    }
}

function requireConnectionString(): string {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        throw new Error('DATABASE_URL is required for claude-code-memory-hook.');
    }
    return connectionString;
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function getCwd(payload: HookPayload): string {
    const fromPayload = typeof payload.cwd === 'string' && payload.cwd.trim().length > 0
        ? payload.cwd.trim()
        : null;
    return fromPayload || process.cwd();
}

function getDefaultAgentId(payload: HookPayload): string {
    const explicit = process.env.IRANTI_CLAUDE_AGENT_ID?.trim();
    if (explicit) return explicit;
    const projectBindingAgent = process.env.IRANTI_AGENT_ID?.trim();
    if (projectBindingAgent) return projectBindingAgent;
    const base = path.basename(getCwd(payload));
    return `claude_code_${slugify(base || 'project')}`;
}

function getEntityHints(payload: HookPayload): string[] {
    const out = new Set<string>();
    const cwd = getCwd(payload);
    const projectHint = `project/${slugify(path.basename(cwd) || 'project')}`;
    const scope = classifyMemoryScope(getPrompt(payload));

    if (scope === 'personal') {
        out.add(getPersonalMemoryEntity());
    } else {
        out.add(projectHint);
        const memoryEntity = getProjectMemoryEntity();
        if (memoryEntity) {
            out.add(memoryEntity);
        }
    }

    const envHints = (process.env.IRANTI_CLAUDE_ENTITY_HINTS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    for (const hint of envHints) out.add(hint);

    return Array.from(out);
}

async function ensureHookAgent(iranti: Iranti, payload: HookPayload): Promise<string> {
    const agentId = getDefaultAgentId(payload);
    await iranti.registerAgent({
        agentId,
        name: process.env.IRANTI_CLAUDE_AGENT_NAME?.trim() || 'Claude Code Hook',
        description: process.env.IRANTI_CLAUDE_AGENT_DESCRIPTION?.trim() || 'Claude Code automatic memory hook',
        capabilities: ['working_memory', 'memory_injection'],
        model: process.env.ANTHROPIC_MODEL || 'claude-code',
    });
    return agentId;
}

function getPrompt(payload: HookPayload): string {
    const candidates = [
        payload.prompt,
        payload.message,
        payload.text,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }
    return '';
}

function getLastAssistantMessage(payload: HookPayload): string {
    const candidates = [
        payload.last_assistant_message,
        payload.lastAssistantMessage,
        payload.response,
        payload.text,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }
    return '';
}

function getRecentMessages(payload: HookPayload): string[] {
    const candidates = [
        payload.recentMessages,
        payload.messages,
        payload.history,
        payload.transcript,
    ];

    for (const candidate of candidates) {
        if (!Array.isArray(candidate)) continue;
        const normalized = candidate
            .flatMap((entry) => {
                if (typeof entry === 'string' && entry.trim()) {
                    return [entry.trim()];
                }

                if (entry && typeof entry === 'object') {
                    const content = (entry as { content?: unknown }).content;
                    if (typeof content === 'string' && content.trim()) {
                        const role = typeof (entry as { role?: unknown }).role === 'string'
                            ? String((entry as { role?: unknown }).role).trim()
                            : '';
                        return [role ? `${role}: ${content.trim()}` : content.trim()];
                    }
                }

                return [];
            })
            .slice(-12);

        if (normalized.length > 0) {
            return normalized;
        }
    }

    return [];
}

function buildSessionTask(payload: HookPayload): string {
    const explicit = process.env.IRANTI_CLAUDE_SESSION_TASK?.trim();
    if (explicit) return explicit;

    const payloadTask = typeof payload.task === 'string' && payload.task.trim().length > 0
        ? payload.task.trim()
        : null;
    if (payloadTask) return payloadTask;

    return `Claude Code session for ${path.basename(getCwd(payload)) || 'project'}`;
}

function buildCurrentContext(payload: HookPayload, prompt: string): string {
    const recentMessages = getRecentMessages(payload);
    if (recentMessages.length === 0) {
        return prompt;
    }

    return [...recentMessages, `user: ${prompt}`].join('\n');
}

function getMaxFacts(): number {
    const raw = Number(process.env.IRANTI_CLAUDE_MAX_FACTS ?? 6);
    if (!Number.isFinite(raw) || raw < 1) return 6;
    return Math.min(12, Math.trunc(raw));
}

function formatSessionContext(facts: HookFact[], cwd: string): string {
    const limited = facts.slice(0, getMaxFacts());
    const lines = [
        '[Iranti Session Memory]',
        `Project: ${path.basename(cwd)}`,
    ];

    if (limited.length > 0) {
        lines.push('Relevant memory:');
        for (const fact of limited) {
            lines.push(`- ${fact.entity}/${fact.key}: ${fact.summary}`);
        }
    }

    return lines.join('\n');
}

function extractSelfMemoryQueryKey(prompt: string): string | null {
    const normalized = prompt.trim();
    if (!normalized) return null;

    const favoriteMatch = normalized.match(/\bwhat(?:'s| is| was)?\s+my\s+favou?rite\s+([a-z0-9_\-\s]+?)\??$/i);
    if (favoriteMatch) {
        return canonicalizeMemoryKey(`favorite_${favoriteMatch[1]}`);
    }

    const fieldMatch = normalized.match(/\bwhat(?:'s| is| was)?\s+my\s+([a-z0-9_\-\s]+?)\??$/i);
    if (fieldMatch) {
        return canonicalizeMemoryKey(fieldMatch[1]);
    }

    return null;
}

function formatPromptContext(facts: HookFact[], prompt?: string): string {
    if (facts.length === 0) return '';

    const lines = ['[Iranti Retrieved Memory]'];
    const targetKey = prompt ? extractSelfMemoryQueryKey(prompt) : null;
    if (targetKey) {
        const answerCandidate = facts.find((fact) => canonicalizeMemoryKey(fact.key) === targetKey);
        if (answerCandidate) {
            lines.push(`Direct answer: ${answerCandidate.summary}.`);
            lines.push('Use the direct answer above when it fully answers the user question.');
        }
    }
    for (const fact of facts) {
        lines.push(`- ${fact.entity}/${fact.key}: ${fact.summary}`);
    }
    return lines.join('\n');
}

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

function extractHookCheckpointPayload(response: string): HookCheckpointPayload | null {
    const facts = extractExplicitAssistantMemory(response).filter((fact) => fact.scope === 'project');
    if (facts.length === 0) {
        return null;
    }

    const checkpoint: HookCheckpointPayload = {};
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
            outputs.push(...readFileChangeOutputs(fact.value));
        }
    }

    if (outputs.length > 0) {
        checkpoint.recentOutputs = outputs;
    }

    return checkpoint.currentStep || checkpoint.nextStep || (checkpoint.openRisks && checkpoint.openRisks.length > 0) || (checkpoint.recentOutputs && checkpoint.recentOutputs.length > 0)
        ? checkpoint
        : null;
}

function emitHookContext(event: HookEventName, additionalContext: string): void {
    const payload = {
        hookSpecificOutput: {
            hookEventName: event,
            additionalContext,
        },
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function shouldFetchMemory(prompt: string): boolean {
    const normalized = prompt.trim();
    if (!normalized) return false;
    if (MEMORY_NEED_NEGATIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
        return false;
    }
    if (MEMORY_NEED_POSITIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
        return true;
    }
    if (/\b(my|our|we)\b/i.test(normalized)) {
        return true;
    }
    return normalized.includes('/');
}

function dedupeFacts(facts: HookFact[]): HookFact[] {
    const byKey = new Map<string, HookFact>();
    for (const fact of facts) {
        const identity = `${fact.entity}/${canonicalizeMemoryKey(fact.key)}`;
        const existing = byKey.get(identity);
        if (!existing || fact.confidence > existing.confidence) {
            byKey.set(identity, fact);
        }
    }
    return Array.from(byKey.values())
        .sort((a, b) => b.confidence - a.confidence || a.entity.localeCompare(b.entity) || a.key.localeCompare(b.key))
        .slice(0, getMaxFacts());
}

function workingMemoryToFacts(entries: HookWorkingMemoryEntry[]): HookFact[] {
    return entries.flatMap((entry) => {
        const entityKey = typeof entry.entityKey === 'string' ? entry.entityKey.trim() : '';
        const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
        if (!entityKey || !summary) return [];

        const segments = entityKey.split('/');
        if (segments.length < 3) return [];

        return [{
            entity: `${segments[0]}/${segments[1]}`,
            key: segments.slice(2).join('/'),
            summary,
            confidence: typeof entry.confidence === 'number' ? entry.confidence : 0,
            source: typeof entry.source === 'string' ? entry.source : 'attendant',
        }];
    });
}

async function loadEntityFacts(iranti: Iranti, entities: string[]): Promise<HookFact[]> {
    const out: HookFact[] = [];
    for (const entity of entities) {
        const trimmed = entity.trim();
        if (!trimmed) continue;
        const entries = await iranti.queryAll(trimmed).catch(() => []);
        for (const entry of entries) {
            out.push({
                entity: trimmed,
                key: entry.key,
                summary: entry.summary,
                confidence: entry.confidence,
                source: entry.source,
            });
        }
    }
    return out;
}

export async function buildHookAdditionalContext(options: {
    iranti: Iranti;
    event: HookEventName;
    payload: HookPayload;
}): Promise<string> {
    const { iranti, event, payload } = options;
    const cwd = getCwd(payload);
    const agent = await ensureHookAgent(iranti, payload);
    const entityHints = getEntityHints(payload);

    if (event === 'SessionStart') {
        const brief = await iranti.handshake({
            agent,
            task: buildSessionTask(payload),
            recentMessages: getRecentMessages(payload),
        });
        const briefFacts = workingMemoryToFacts(brief.workingMemory as HookWorkingMemoryEntry[]);
        const directFacts = briefFacts.length > 0
            ? briefFacts
            : await loadEntityFacts(iranti, entityHints);
        return formatSessionContext(dedupeFacts(directFacts), cwd);
    }

    if (event === 'Stop') {
        const response = getLastAssistantMessage(payload);
        if (response && isAutoRememberEnabled()) {
            await autoRememberAssistantFacts({
                iranti,
                response,
                agent,
                source: 'ClaudeCodeHookStop',
            });
            const checkpoint = extractHookCheckpointPayload(response);
            const projectEntity = getProjectMemoryEntity();
            if (checkpoint && projectEntity && typeof (iranti as { checkpoint?: unknown }).checkpoint === 'function') {
                await (iranti as {
                    checkpoint(input: {
                        agent?: string;
                        task: string;
                        recentMessages: string[];
                        checkpoint: HookCheckpointPayload & { entityTargets: string[] };
                    }): Promise<unknown>;
                }).checkpoint({
                    agent,
                    task: buildSessionTask(payload),
                    recentMessages: getRecentMessages(payload),
                    checkpoint: {
                        ...checkpoint,
                        entityTargets: [projectEntity],
                    },
                });
            }
        }
        return '';
    }

    const prompt = getPrompt(payload);
    if (!prompt) {
        return '';
    }

    if (isAutoRememberEnabled()) {
        await autoRememberPromptFacts({
            iranti,
            prompt,
            agent,
            source: 'ClaudeCodeHook',
        });
    }

    if (!shouldFetchMemory(prompt)) {
        return '';
    }

    const attend = await iranti.attend({
        agent,
        latestMessage: prompt,
        currentContext: buildCurrentContext(payload, prompt),
        entityHints,
        maxFacts: getMaxFacts(),
    });
    const facts = attend.facts.map((fact) => ({
        entity: fact.entityKey.split('/').slice(0, 2).join('/'),
        key: fact.entityKey.split('/').slice(2).join('/'),
        summary: fact.summary,
        confidence: fact.confidence,
        source: fact.source,
    })).filter((fact) => fact.entity.includes('/') && fact.key.length > 0);
    return formatPromptContext(dedupeFacts(facts), prompt);
}

async function main(): Promise<void> {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        printHelp();
        return;
    }

    const args = parseArgs(process.argv.slice(2));
    const event = args.event as HookEventName | undefined;
    if (event !== 'SessionStart' && event !== 'UserPromptSubmit' && event !== 'Stop') {
        throw new Error('--event must be SessionStart, UserPromptSubmit, or Stop');
    }

    const payload = parsePayload(await readStdin());
    loadRuntimeEnv({
        payloadCwd: getCwd(payload),
        projectEnvFile: args['project-env'],
        instanceEnvFile: args['instance-env'],
        explicitEnvFile: args['env-file'],
    });
    const iranti = createFirstPartyIranti({
        connectionString: requireConnectionString(),
        llmProvider: process.env.LLM_PROVIDER,
    });
    const context = await buildHookAdditionalContext({
        iranti,
        event,
        payload,
    });
    if (!context) {
        await flushStaffEventEmitter();
        process.exit(0);
    }
    emitHookContext(event, context);
    await flushStaffEventEmitter();
    process.exit(0);
}

if (require.main === module) {
    main().catch(async (error) => {
        try {
            await flushStaffEventEmitter();
        } catch {}
        console.error('[claude-code-memory-hook] fatal:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
