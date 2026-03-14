import 'dotenv/config';
import path from 'path';
import { Iranti } from '../src/sdk';

type HookEventName = 'SessionStart' | 'UserPromptSubmit';
type HookPayload = Record<string, unknown>;

function printHelp(): void {
    console.log([
        'Claude Code -> Iranti hook helper',
        '',
        'Usage:',
        '  ts-node scripts/claude-code-memory-hook.ts --event SessionStart',
        '  ts-node scripts/claude-code-memory-hook.ts --event UserPromptSubmit',
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
    const base = path.basename(getCwd(payload));
    return `claude_code_${slugify(base || 'project')}`;
}

function getEntityHints(payload: HookPayload): string[] {
    const out = new Set<string>();
    const cwd = getCwd(payload);
    const projectHint = `project/${slugify(path.basename(cwd) || 'project')}`;
    out.add(projectHint);

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
    return typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
}

function getMaxFacts(): number {
    const raw = Number(process.env.IRANTI_CLAUDE_MAX_FACTS ?? 6);
    if (!Number.isFinite(raw) || raw < 1) return 6;
    return Math.min(12, Math.trunc(raw));
}

function formatHandshakeContext(brief: any, cwd: string): string {
    const facts = Array.isArray(brief?.workingMemory) ? brief.workingMemory.slice(0, getMaxFacts()) : [];
    const lines = [
        '[Iranti Session Memory]',
        `Project: ${path.basename(cwd)}`,
    ];

    if (typeof brief?.inferredTaskType === 'string' && brief.inferredTaskType) {
        lines.push(`Task type: ${brief.inferredTaskType}`);
    }

    if (facts.length > 0) {
        lines.push('Relevant memory:');
        for (const fact of facts) {
            const label = typeof fact?.entityKey === 'string' ? fact.entityKey : `${fact?.entityType ?? 'entity'}/${fact?.entityId ?? 'unknown'}`;
            const summary = typeof fact?.summary === 'string' ? fact.summary : fact?.valueSummary;
            if (!summary) continue;
            lines.push(`- ${label}: ${summary}`);
        }
    }

    return lines.join('\n');
}

function formatAttendContext(attend: any): string {
    const facts = Array.isArray(attend?.facts) ? attend.facts.slice(0, getMaxFacts()) : [];
    if (!attend?.shouldInject || facts.length === 0) return '';

    const lines = ['[Iranti Retrieved Memory]'];
    if (typeof attend?.reason === 'string' && attend.reason) {
        lines.push(`Reason: ${attend.reason}`);
    }
    for (const fact of facts) {
        const label = typeof fact?.entityKey === 'string' ? fact.entityKey : `${fact?.entityType ?? 'entity'}/${fact?.entityId ?? 'unknown'}`;
        const summary = typeof fact?.summary === 'string' ? fact.summary : fact?.valueSummary;
        if (!summary) continue;
        lines.push(`- ${label}: ${summary}`);
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
    const cwd = getCwd(payload);
    const iranti = new Iranti({
        connectionString: requireConnectionString(),
        llmProvider: process.env.LLM_PROVIDER,
    });
    const agent = await ensureHookAgent(iranti, payload);
    const entityHints = getEntityHints(payload);

    if (event === 'SessionStart') {
        const task = process.env.IRANTI_CLAUDE_SESSION_TASK?.trim()
            || `Claude Code session in ${path.basename(cwd)}`;
        const brief = await iranti.handshake({
            agent,
            task,
            recentMessages: [],
        });
        emitHookContext(event, formatHandshakeContext(brief, cwd));
        return;
    }

    const prompt = getPrompt(payload);
    if (!prompt) return;

    const attend = await iranti.attend({
        agent,
        latestMessage: prompt,
        currentContext: prompt,
        entityHints,
        maxFacts: getMaxFacts(),
    });

    const context = formatAttendContext(attend);
    if (!context) return;
    emitHookContext(event, context);
}

main().catch((error) => {
    console.error('[claude-code-memory-hook] fatal:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
