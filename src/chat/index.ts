import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import readline from 'readline/promises';
import { completeWithFallback, getSupportedProviders, LLMMessage } from '../lib/llm';
import { getAllProfiles } from '../lib/router';
import { loadRuntimeEnv } from '../lib/runtimeEnv';
import { resolveInteractive } from '../resolutionist';

type ChatRole = 'user' | 'assistant';

type ChatTurn = {
    role: ChatRole;
    content: string;
};

type WorkingMemoryBrief = {
    operatingRules: string;
    inferredTaskType: string;
    workingMemory: Array<{
        entityKey: string;
        summary: string;
        confidence: number;
        source: string;
    }>;
};

type FactInjection = {
    entityKey: string;
    summary: string;
    value: unknown;
    confidence: number;
    source: string;
};

type AttendResult = {
    shouldInject: boolean;
    reason: string;
    facts: FactInjection[];
};

type ObserveResult = {
    facts: FactInjection[];
};

type QueryResult = {
    found: boolean;
    value?: unknown;
    summary?: string;
    confidence?: number;
    source?: string;
};

type QueryAllFact = {
    key: string;
    value: unknown;
    summary: string;
    confidence: number;
    source: string;
};

type SearchResult = {
    entity: string;
    key: string;
    summary: string;
    score: number;
};

type HistoryEntry = {
    value: unknown;
    summary: string;
    confidence: number;
    source: string;
    validFrom: string;
    validUntil: string | null;
    isCurrent: boolean;
    contested: boolean;
    archivedReason: 'segment_closed' | 'superseded' | 'contradicted' | 'escalated' | 'expired' | null;
    resolutionState: 'not_applicable' | 'pending' | 'resolved' | null;
    resolutionOutcome: 'not_applicable' | 'challenger_won' | 'original_retained' | null;
};

type RelatedResult = {
    entityType: string;
    entityId: string;
    relationshipType: string;
    direction: 'outbound' | 'inbound';
    properties: Record<string, unknown>;
};

type WriteResult = {
    action: 'created' | 'updated' | 'escalated' | 'rejected';
    reason: string;
};

export type ChatSessionOptions = {
    agentId?: string;
    provider?: string;
    model?: string;
    cwd?: string;
};

class ApiClient {
    constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

    private async request<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
        const response = await fetch(`${this.baseUrl}${route}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-Iranti-Key': this.apiKey,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;

        if (!response.ok) {
            const error = typeof payload?.error === 'string' ? payload.error : `API error ${response.status}`;
            throw new Error(error);
        }

        return payload as T;
    }

    handshake(agentId: string): Promise<WorkingMemoryBrief> {
        return this.request('POST', '/memory/handshake', {
            agent: agentId,
            task: 'Interactive chat session',
            recentMessages: [],
        });
    }

    attend(agentId: string, currentContext: string, latestMessage: string): Promise<AttendResult> {
        return this.request('POST', '/memory/attend', {
            agentId,
            currentContext,
            latestMessage,
        });
    }

    observe(agentId: string, currentContext: string): Promise<ObserveResult> {
        return this.request('POST', '/memory/observe', {
            agentId,
            currentContext,
        });
    }

    query(entity: string, key: string): Promise<QueryResult> {
        const [entityType, entityId] = splitEntity(entity);
        return this.request('GET', `/kb/query/${entityType}/${entityId}/${encodeURIComponent(key)}`);
    }

    queryAll(entity: string): Promise<QueryAllFact[]> {
        const [entityType, entityId] = splitEntity(entity);
        return this.request('GET', `/kb/query/${entityType}/${entityId}`);
    }

    history(entity: string, key: string): Promise<HistoryEntry[]> {
        const [entityType, entityId] = splitEntity(entity);
        return this.request('GET', `/kb/history/${entityType}/${entityId}/${encodeURIComponent(key)}`);
    }

    async search(query: string): Promise<SearchResult[]> {
        const search = new URLSearchParams({ query });
        const payload = await this.request<{ results: SearchResult[] }>('GET', `/kb/search?${search.toString()}`);
        return payload.results;
    }

    write(agentId: string, entity: string, key: string, value: unknown, summary: string, confidence: number, source: string = 'iranti_chat'): Promise<WriteResult> {
        return this.request('POST', '/kb/write', {
            entity,
            key,
            value,
            summary,
            confidence,
            source,
            agent: agentId,
        });
    }

    relate(params: {
        fromEntity: string;
        relationshipType: string;
        toEntity: string;
        createdBy: string;
        properties?: Record<string, unknown>;
    }): Promise<{ success: boolean }> {
        return this.request('POST', '/kb/relate', params);
    }

    related(entity: string): Promise<RelatedResult[]> {
        const [entityType, entityId] = splitEntity(entity);
        return this.request('GET', `/kb/related/${entityType}/${entityId}`);
    }
}

function splitEntity(entity: string): [string, string] {
    const trimmed = entity.trim();
    const separator = trimmed.indexOf('/');
    if (separator <= 0 || separator === trimmed.length - 1) {
        throw new Error(`Invalid entity format: "${entity}". Expected entityType/entityId.`);
    }
    return [trimmed.slice(0, separator), trimmed.slice(separator + 1)];
}

function isStrictEntity(value: string | undefined): value is string {
    if (!value) return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    const parts = trimmed.split('/');
    return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}

function tokenizeCommand(input: string): string[] {
    const matches = input.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g);
    if (!matches) return [];
    return matches.map((token) => {
        if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith('\'') && token.endsWith('\''))) {
            return token.slice(1, -1);
        }
        return token;
    });
}

function parseLooseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function formatJson(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function buildMemoryBlock(fact: FactInjection): string {
    return `[MEMORY: ${fact.entityKey}] ${fact.summary} | value=${formatJson(fact.value)} | confidence=${fact.confidence} | source=${fact.source}`;
}

function formatConversation(history: ChatTurn[]): string {
    return history.map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`).join('\n');
}

function buildPreamble(agentId: string, brief: WorkingMemoryBrief): string {
    const workingMemory = brief.workingMemory.length === 0
        ? '- none loaded'
        : brief.workingMemory
            .slice(0, 10)
            .map((entry) => `- ${entry.entityKey}: ${entry.summary} (${entry.confidence}, ${entry.source})`)
            .join('\n');

    return [
        `You are chatting through Iranti.`,
        `Agent ID: ${agentId}`,
        `Inferred task: ${brief.inferredTaskType}`,
        `Operating rules: ${brief.operatingRules}`,
        'Known working memory:',
        workingMemory,
    ].join('\n');
}

function normalizeProvider(raw: string | undefined): string | undefined {
    const trimmed = raw?.trim().toLowerCase();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveDefaultModel(): string {
    return getAllProfiles().summarization.model;
}

function buildSummary(key: string, value: unknown): string {
    const raw = formatJson(value);
    return `${key}: ${raw.length > 96 ? `${raw.slice(0, 93)}...` : raw}`;
}

function formatDate(value: string | null | undefined): string {
    if (!value) return 'now';
    return value.slice(0, 10);
}

function formatHistoryStatus(entry: HistoryEntry): string {
    if (entry.isCurrent) return 'current';
    if (entry.archivedReason) return entry.archivedReason;
    return 'historical';
}

function line(width: number): string {
    return '-'.repeat(width);
}

function resolveEscalationRoot(): string {
    return path.resolve(process.env.IRANTI_ESCALATION_DIR ?? path.join(os.homedir(), '.iranti', 'escalation'));
}

async function hasPendingEscalations(root: string): Promise<boolean> {
    const activeDir = path.join(root, 'active');
    try {
        const entries = await fs.readdir(activeDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.md')) {
                continue;
            }
            const content = await fs.readFile(path.join(activeDir, entry.name), 'utf-8');
            if (content.includes('**Status:** PENDING')) {
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
}

function printHelp(): void {
    console.log('/memory                          show all memory facts for this session');
    console.log('/search <query>                  search facts by keyword or concept');
    console.log('/inject <entity> <key>           inject a specific fact into the next turn');
    console.log('/write <key> <value> [conf]      write a fact to session memory');
    console.log('/observe                         manually pull memory from conversation history');
    console.log('/history <entity> <key>          show temporal history for a fact');
    console.log('/relate <from> <to> <type>       create a relationship between two entities');
    console.log('/related <entity>                show all relationships for an entity');
    console.log('/resolve                         walk through pending conflict escalations');
    console.log('/confidence <entity> <key> <n>   update confidence score for a fact (0-100)');
    console.log('/clear                           clear conversation history');
    console.log('/provider <name> [model]         switch LLM provider for this session');
    console.log('/exit                            quit');
}

export async function startChatSession(options: ChatSessionOptions = {}): Promise<void> {
    loadRuntimeEnv({ cwd: options.cwd ?? process.cwd() });

    const baseUrl = (process.env.IRANTI_URL ?? '').trim();
    const apiKey = (process.env.IRANTI_API_KEY ?? '').trim();
    if (!baseUrl) {
        throw new Error('IRANTI_URL is required. Load .env.iranti or set IRANTI_URL before running iranti chat.');
    }
    if (!apiKey) {
        throw new Error('IRANTI_API_KEY is required. Load .env.iranti or set IRANTI_API_KEY before running iranti chat.');
    }

    const supportedProviders = getSupportedProviders();
    const initialProvider = normalizeProvider(options.provider ?? process.env.LLM_PROVIDER) ?? 'mock';
    if (!supportedProviders.includes(initialProvider)) {
        throw new Error(`Unsupported provider "${initialProvider}". Available: ${supportedProviders.join(', ')}`);
    }

    process.env.LLM_PROVIDER = initialProvider;

    const agentId = options.agentId?.trim() || 'iranti_chat';
    const sessionEntity = `session/${agentId}`;
    const client = new ApiClient(baseUrl.replace(/\/+$/, ''), apiKey);

    let provider = initialProvider;
    let model = options.model?.trim() || resolveDefaultModel();
    let manualInjections: FactInjection[] = [];
    const history: ChatTurn[] = [];

    const brief = await client.handshake(agentId);
    console.log(`Iranti Chat — provider: ${provider}, model: ${model}`);
    console.log('Type /help for commands. Ctrl+C to exit.');
    if (brief.workingMemory.length > 0) {
        console.log(`Loaded ${brief.workingMemory.length} memory entries.`);
    }

    const createInterface = () => readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    let rl = createInterface();

    let closing = false;
    const closeHandler = () => {
        if (closing) return;
        closing = true;
        console.log('\nExiting chat.');
        rl.close();
    };

    process.on('SIGINT', closeHandler);

    try {
        while (!closing) {
            const input = (await rl.question('> ')).trim();
            if (!input) {
                continue;
            }

            if (input.startsWith('/')) {
                const parts = tokenizeCommand(input);
                const command = parts[0]?.toLowerCase();

                if (command === '/help') {
                    printHelp();
                    continue;
                }

                if (command === '/memory') {
                    const facts = await client.queryAll(sessionEntity);
                    if (facts.length === 0) {
                        console.log('No memory entries for this session.');
                        continue;
                    }
                    for (const fact of facts) {
                        console.log(`${fact.key} | ${fact.summary} | ${fact.confidence} | ${fact.source}`);
                    }
                    continue;
                }

                if (command === '/search') {
                    const query = input.replace(/^\/search\s*/i, '').trim();
                    if (!query) {
                        console.log('Usage: /search <query>');
                        continue;
                    }
                    const results = await client.search(query);
                    if (results.length === 0) {
                        console.log('No search results.');
                        continue;
                    }
                    for (const result of results) {
                        console.log(`${result.entity} | ${result.key} | ${result.summary} | ${result.score.toFixed(3)}`);
                    }
                    continue;
                }

                if (command === '/inject') {
                    if (parts.length < 3) {
                        console.log('Usage: /inject <entity> <key>');
                        continue;
                    }
                    const entity = parts[1];
                    const key = parts[2];
                    const fact = await client.query(entity, key);
                    if (!fact.found) {
                        console.log(`No fact found for ${entity}/${key}.`);
                        continue;
                    }
                    manualInjections.push({
                        entityKey: `${entity}/${key}`,
                        summary: fact.summary ?? buildSummary(key, fact.value),
                        value: fact.value,
                        confidence: fact.confidence ?? 0,
                        source: fact.source ?? 'unknown',
                    });
                    console.log(`Injected: [${entity}/${key}] ${fact.summary ?? buildSummary(key, fact.value)}`);
                    continue;
                }

                if (command === '/write') {
                    if (parts.length < 3) {
                        console.log('Usage: /write <key> <value> [confidence]');
                        continue;
                    }
                    const key = parts[1];
                    const maybeConfidence = parts.length >= 4 ? Number.parseInt(parts[parts.length - 1], 10) : NaN;
                    const hasConfidence = Number.isFinite(maybeConfidence);
                    const rawValue = hasConfidence
                        ? parts.slice(2, -1).join(' ')
                        : parts.slice(2).join(' ');
                    const confidence = hasConfidence ? maybeConfidence : 75;
                    const value = parseLooseJson(rawValue);
                    const result = await client.write(agentId, sessionEntity, key, value, buildSummary(key, value), confidence);
                    console.log(`${result.action} | ${result.reason}`);
                    continue;
                }

                if (command === '/observe') {
                    const observed = await client.observe(agentId, formatConversation(history));
                    if (observed.facts.length === 0) {
                        console.log('Nothing to inject.');
                        continue;
                    }
                    manualInjections = [...manualInjections, ...observed.facts];
                    console.log(`Queued ${observed.facts.length} memory facts for the next turn.`);
                    continue;
                }

                if (command === '/history') {
                    if (parts.length < 3) {
                        console.log('Usage: /history <entity> <key>');
                        continue;
                    }
                    const entity = parts[1];
                    const key = parts[2];
                    if (!isStrictEntity(entity)) {
                        console.log('Invalid entity format. Use entityType/entityId (e.g. project/acme).');
                        continue;
                    }
                    try {
                        const entries = await client.history(entity, key);
                        if (entries.length === 0) {
                            console.log(`No history found for ${entity}/${key}.`);
                            continue;
                        }
                        const ordered = [...entries].sort((left, right) => left.validFrom.localeCompare(right.validFrom));
                        console.log(`History: ${entity} -> ${key}`);
                        console.log(line(53));
                        ordered.forEach((entry, index) => {
                            console.log(`  ${index + 1}. [${formatDate(entry.validFrom)} -> ${formatDate(entry.validUntil)}] ${formatJson(entry.value)}   conf:${entry.confidence}  source:${entry.source}  ${formatHistoryStatus(entry)}`);
                        });
                        console.log(line(53));
                        console.log(`${ordered.length} interval${ordered.length === 1 ? '' : 's'}`);
                    } catch (error) {
                        console.log(error instanceof Error ? error.message : String(error));
                    }
                    continue;
                }

                if (command === '/relate') {
                    if (parts.length < 4) {
                        console.log('Usage: /relate <from> <to> <type>');
                        continue;
                    }
                    const fromEntity = parts[1];
                    const toEntity = parts[2];
                    const relationshipType = parts.slice(3).join(' ').trim();
                    if (!isStrictEntity(fromEntity) || !isStrictEntity(toEntity)) {
                        console.log('Invalid entity format. Use entityType/entityId (e.g. project/acme).');
                        continue;
                    }
                    if (!relationshipType) {
                        console.log('Usage: /relate <from> <to> <type>');
                        continue;
                    }
                    try {
                        await client.relate({
                            fromEntity,
                            toEntity,
                            relationshipType,
                            createdBy: agentId,
                        });
                        console.log(`Related: ${fromEntity} -> ${toEntity} [${relationshipType}]`);
                    } catch (error) {
                        console.log(error instanceof Error ? error.message : String(error));
                    }
                    continue;
                }

                if (command === '/related') {
                    if (parts.length < 2) {
                        console.log('Invalid entity format. Use entityType/entityId (e.g. project/acme).');
                        continue;
                    }
                    const entity = parts[1];
                    if (!isStrictEntity(entity)) {
                        console.log('Invalid entity format. Use entityType/entityId (e.g. project/acme).');
                        continue;
                    }
                    try {
                        const relationships = await client.related(entity);
                        if (relationships.length === 0) {
                            console.log(`No relationships found for ${entity}.`);
                            continue;
                        }
                        console.log(`Related entities: ${entity}`);
                        console.log(line(33));
                        for (const relationship of relationships) {
                            const arrow = relationship.direction === 'outbound' ? '->' : '<-';
                            console.log(`  ${relationship.relationshipType} ${arrow} ${relationship.entityType}/${relationship.entityId}`);
                        }
                        console.log(line(33));
                        console.log(`${relationships.length} relationship${relationships.length === 1 ? '' : 's'}`);
                    } catch (error) {
                        console.log(error instanceof Error ? error.message : String(error));
                    }
                    continue;
                }

                if (command === '/resolve') {
                    try {
                        const escalationRoot = resolveEscalationRoot();
                        if (!(await hasPendingEscalations(escalationRoot))) {
                            console.log('No pending escalations.');
                            continue;
                        }
                        console.log(line(48));
                        console.log('Resolutionist');
                        console.log(line(48));
                        rl.close();
                        await resolveInteractive(escalationRoot);
                        if (!closing) {
                            rl = createInterface();
                            console.log(line(48));
                            console.log('Back in chat');
                            console.log(line(48));
                        }
                    } catch (error) {
                        if (!closing) {
                            rl = createInterface();
                        }
                        console.log(error instanceof Error ? error.message : String(error));
                    }
                    continue;
                }

                if (command === '/confidence') {
                    if (parts.length < 4) {
                        console.log('Usage: /confidence <entity> <key> <new_value>');
                        continue;
                    }
                    const entity = parts[1];
                    const key = parts[2];
                    const nextConfidence = Number.parseInt(parts[3], 10);
                    if (!isStrictEntity(entity)) {
                        console.log('Invalid entity format. Use entityType/entityId (e.g. project/acme).');
                        continue;
                    }
                    if (!Number.isInteger(nextConfidence) || nextConfidence < 0 || nextConfidence > 100) {
                        console.log('Confidence must be an integer between 0 and 100.');
                        continue;
                    }
                    try {
                        const current = await client.query(entity, key);
                        if (!current.found) {
                            console.log(`No fact found for ${entity}/${key}.`);
                            continue;
                        }
                        const oldConfidence = current.confidence ?? 0;
                        const value = current.value;
                        const summary = current.summary ?? buildSummary(key, value);
                        const result = await client.write(
                            agentId,
                            entity,
                            key,
                            value,
                            summary,
                            nextConfidence,
                            current.source ?? 'iranti_chat',
                        );
                        console.log(`confidence updated: ${oldConfidence} -> ${nextConfidence} | ${result.action}`);
                    } catch (error) {
                        console.log(error instanceof Error ? error.message : String(error));
                    }
                    continue;
                }

                if (command === '/clear') {
                    history.length = 0;
                    manualInjections = [];
                    console.log('Conversation history cleared.');
                    continue;
                }

                if (command === '/provider') {
                    const nextProvider = normalizeProvider(parts[1]);
                    if (!nextProvider) {
                        console.log(`Usage: /provider <${supportedProviders.join('|')}> [model]`);
                        continue;
                    }
                    if (!supportedProviders.includes(nextProvider)) {
                        console.log(`Unsupported provider "${nextProvider}". Available: ${supportedProviders.join(', ')}`);
                        continue;
                    }
                    provider = nextProvider;
                    process.env.LLM_PROVIDER = nextProvider;
                    model = parts[2]?.trim() || resolveDefaultModel();
                    console.log(`Switched to provider: ${provider} (${model})`);
                    continue;
                }

                if (command === '/exit' || command === '/quit') {
                    closeHandler();
                    continue;
                }

                console.log(`Unknown command: ${command}. Type /help for available commands.`);
                continue;
            }

            const currentContext = formatConversation(history);
            const attended = await client.attend(agentId, currentContext, input);
            const autoBlocks = attended.shouldInject ? attended.facts.map(buildMemoryBlock) : [];
            const manualBlocks = manualInjections.map(buildMemoryBlock);
            const memoryBlocks = [...manualBlocks, ...autoBlocks];
            manualInjections = [];

            if (memoryBlocks.length > 0) {
                console.log(`Injecting ${memoryBlocks.length} memory fact(s).`);
            }

            const messages: LLMMessage[] = [
                { role: 'user', content: buildPreamble(agentId, brief) },
                ...history.map<LLMMessage>((turn) => ({ role: turn.role, content: turn.content })),
                {
                    role: 'user',
                    content: [
                        memoryBlocks.join('\n'),
                        input,
                    ].filter(Boolean).join('\n\n'),
                },
            ];

            const response = await completeWithFallback(messages, {
                preferredProvider: provider,
                model,
            });

            console.log(response.text.trim());

            history.push({ role: 'user', content: input });
            history.push({ role: 'assistant', content: response.text.trim() });

            // observe() is retrieval-only in the current codebase; this background call just warms the next-turn memory path.
            void client.observe(agentId, formatConversation(history)).catch(() => undefined);
        }
    } finally {
        process.off('SIGINT', closeHandler);
        rl.close();
    }
}
