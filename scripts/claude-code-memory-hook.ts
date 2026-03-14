import 'dotenv/config';
import path from 'path';
import { Iranti } from '../src/sdk';
import { loadRuntimeEnv } from '../src/lib/runtimeEnv';

type HookEventName = 'SessionStart' | 'UserPromptSubmit';
type HookPayload = Record<string, unknown>;
type HookFact = {
    entity: string;
    key: string;
    summary: string;
    confidence: number;
    source: string;
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
        '',
        'Optional flags:',
        '  --project-env <path>   Explicit .env.iranti path',
        '  --instance-env <path>  Explicit instance env path',
        '  --env-file <path>      Explicit base .env path',
        '',
        'Reads Claude Code hook JSON from stdin and returns hookSpecificOutput.additionalContext on stdout.',
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
    out.add(projectHint);

    const memoryEntity = process.env.IRANTI_MEMORY_ENTITY?.trim();
    if (memoryEntity) {
        out.add(memoryEntity);
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

function formatPromptContext(facts: HookFact[]): string {
    if (facts.length === 0) return '';

    const lines = ['[Iranti Retrieved Memory]'];
    for (const fact of facts) {
        lines.push(`- ${fact.entity}/${fact.key}: ${fact.summary}`);
    }
    return lines.join('\n');
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
        const identity = `${fact.entity}/${fact.key}`;
        const existing = byKey.get(identity);
        if (!existing || fact.confidence > existing.confidence) {
            byKey.set(identity, fact);
        }
    }
    return Array.from(byKey.values())
        .sort((a, b) => b.confidence - a.confidence || a.entity.localeCompare(b.entity) || a.key.localeCompare(b.key))
        .slice(0, getMaxFacts());
}

async function loadAttendantStateFacts(iranti: Iranti, agent: string): Promise<HookFact[]> {
    const state = await iranti.query(`agent/${agent}`, 'attendant_state');
    if (!state.found || !state.value || typeof state.value !== 'object') {
        return [];
    }

    const workingMemory = Array.isArray((state.value as { workingMemory?: unknown[] }).workingMemory)
        ? (state.value as { workingMemory: Array<Record<string, unknown>> }).workingMemory
        : [];

    return workingMemory.flatMap((entry) => {
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

async function searchPromptFacts(iranti: Iranti, prompt: string, entityHints: string[]): Promise<HookFact[]> {
    if (!prompt.trim()) return [];

    const results = await iranti.search({
        query: prompt,
        limit: getMaxFacts(),
        minScore: Number(process.env.IRANTI_CLAUDE_MIN_SEARCH_SCORE ?? 0.05),
    }).catch(() => []);

    const searched = results.map((result) => ({
        entity: result.entity,
        key: result.key,
        summary: result.summary,
        confidence: result.confidence,
        source: result.source,
    }));

    if (searched.length > 0) {
        return searched;
    }

    return loadEntityFacts(iranti, entityHints);
}

async function main(): Promise<void> {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        printHelp();
        return;
    }

    const args = parseArgs(process.argv.slice(2));
    const event = args.event as HookEventName | undefined;
    if (event !== 'SessionStart' && event !== 'UserPromptSubmit') {
        throw new Error('--event must be SessionStart or UserPromptSubmit');
    }

    const payload = parsePayload(await readStdin());
    loadRuntimeEnv({
        payloadCwd: getCwd(payload),
        projectEnvFile: args['project-env'],
        instanceEnvFile: args['instance-env'],
        explicitEnvFile: args['env-file'],
    });
    const cwd = getCwd(payload);
    const iranti = new Iranti({
        connectionString: requireConnectionString(),
        llmProvider: process.env.LLM_PROVIDER,
    });
    const agent = await ensureHookAgent(iranti, payload);
    const entityHints = getEntityHints(payload);

    if (event === 'SessionStart') {
        const persistedFacts = await loadAttendantStateFacts(iranti, agent);
        const directFacts = persistedFacts.length > 0
            ? persistedFacts
            : await loadEntityFacts(iranti, entityHints);
        emitHookContext(event, formatSessionContext(dedupeFacts(directFacts), cwd));
        process.exit(0);
    }

    const prompt = getPrompt(payload);
    if (!prompt) {
        process.exit(0);
    }

    if (!shouldFetchMemory(prompt)) {
        process.exit(0);
    }

    const facts = await searchPromptFacts(iranti, prompt, entityHints);
    const context = formatPromptContext(dedupeFacts(facts));
    if (!context) {
        process.exit(0);
    }
    emitHookContext(event, context);
    process.exit(0);
}

main().catch((error) => {
    console.error('[claude-code-memory-hook] fatal:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
