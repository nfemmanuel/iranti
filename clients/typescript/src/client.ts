import type {
    AgentProfile,
    AgentRecord,
    AliasResponse,
    AttendParams,
    AttendResult,
    HandshakeParams,
    HealthResponse,
    IngestParams,
    IngestResult,
    IrantiClientOptions,
    LastHttpMetadata,
    MaintenanceReport,
    ObserveParams,
    ObserveResult,
    QueryAllFact,
    QueryOptions,
    QueryResult,
    ReconveneParams,
    RegisterAgentParams,
    RelatedResult,
    RelateParams,
    RelateResult,
    ResolveEntityResponse,
    SearchParams,
    SearchResult,
    WhoKnowsResult,
    WorkingMemoryBrief,
    WriteParams,
    WriteResult,
    HistoryEntry,
} from './types';

function normalizeBaseUrl(baseUrl?: string): string {
    const raw = (baseUrl ?? process.env.IRANTI_URL ?? 'http://localhost:3001').trim();
    return raw.replace(/\/+$/, '');
}

function parseEntity(entity: string): { entityType: string; entityId: string } {
    const raw = entity.trim();
    const idx = raw.indexOf('/');
    if (idx <= 0 || idx === raw.length - 1) {
        throw new IrantiValidationError(`Invalid entity format: "${entity}". Expected "entityType/entityId".`);
    }

    return {
        entityType: raw.slice(0, idx),
        entityId: raw.slice(idx + 1),
    };
}

function normalizeDateInput(value?: string | Date): string | undefined {
    if (value === undefined) return undefined;
    return value instanceof Date ? value.toISOString() : value;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        searchParams.set(key, typeof value === 'boolean' ? String(value).toLowerCase() : String(value));
    }
    const encoded = searchParams.toString();
    return encoded ? `?${encoded}` : '';
}

async function parseResponseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;

    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}

export class IrantiError extends Error {
    readonly status?: number;
    readonly body?: unknown;

    constructor(message: string, options: { status?: number; body?: unknown } = {}) {
        super(message);
        this.name = 'IrantiError';
        this.status = options.status;
        this.body = options.body;
    }
}

export class IrantiAuthError extends IrantiError {
    constructor(message: string, options: { status?: number; body?: unknown } = {}) {
        super(message, options);
        this.name = 'IrantiAuthError';
    }
}

export class IrantiNotFoundError extends IrantiError {
    constructor(message: string, options: { status?: number; body?: unknown } = {}) {
        super(message, options);
        this.name = 'IrantiNotFoundError';
    }
}

export class IrantiValidationError extends IrantiError {
    constructor(message: string, options: { status?: number; body?: unknown } = {}) {
        super(message, options);
        this.name = 'IrantiValidationError';
    }
}

export class IrantiClient {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly timeout: number;
    private lastHttpMeta: LastHttpMetadata = {
        status: null,
        method: null,
        path: null,
        ok: null,
    };

    constructor(options: IrantiClientOptions) {
        if (!options.apiKey || options.apiKey.trim().length === 0) {
            throw new IrantiError('API key is required.');
        }

        this.baseUrl = normalizeBaseUrl(options.baseUrl);
        this.apiKey = options.apiKey.trim();
        this.timeout = options.timeout ?? 30_000;
    }

    private async request<T>(
        method: 'GET' | 'POST',
        path: string,
        options: { body?: unknown; headers?: Record<string, string> } = {}
    ): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Iranti-Key': this.apiKey,
                    ...options.headers,
                },
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: controller.signal,
            });

            const body = await parseResponseBody(response);
            this.lastHttpMeta = {
                status: response.status,
                method,
                path,
                ok: response.ok,
            };

            if (response.ok) {
                return body as T;
            }

            const message = typeof body === 'object' && body !== null && 'error' in body && typeof (body as { error?: unknown }).error === 'string'
                ? (body as { error: string }).error
                : `API error ${response.status}`;

            if (response.status === 401) {
                throw new IrantiAuthError(message, { status: response.status, body });
            }
            if (response.status === 404) {
                throw new IrantiNotFoundError(message, { status: response.status, body });
            }
            if (response.status === 400) {
                throw new IrantiValidationError(message, { status: response.status, body });
            }

            throw new IrantiError(message, { status: response.status, body });
        } catch (error) {
            if (error instanceof IrantiError) {
                throw error;
            }

            if (error instanceof Error && error.name === 'AbortError') {
                throw new IrantiError(`Request timed out after ${this.timeout}ms.`);
            }

            const message = error instanceof Error ? error.message : String(error);
            throw new IrantiError(`Could not connect to Iranti API at ${this.baseUrl}: ${message}`);
        } finally {
            clearTimeout(timer);
        }
    }

    health(): Promise<HealthResponse> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        return fetch(`${this.baseUrl}/health`, { signal: controller.signal })
            .then(async (response) => {
                const body = await parseResponseBody(response);
                this.lastHttpMeta = {
                    status: response.status,
                    method: 'GET',
                    path: '/health',
                    ok: response.ok,
                };

                if (!response.ok) {
                    throw new IrantiError(`Health check failed with status ${response.status}.`, {
                        status: response.status,
                        body,
                    });
                }

                return body as HealthResponse;
            })
            .catch((error: unknown) => {
                if (error instanceof IrantiError) {
                    throw error;
                }
                if (error instanceof Error && error.name === 'AbortError') {
                    throw new IrantiError(`Request timed out after ${this.timeout}ms.`);
                }
                const message = error instanceof Error ? error.message : String(error);
                throw new IrantiError(`Could not connect to Iranti API at ${this.baseUrl}: ${message}`);
            })
            .finally(() => {
                clearTimeout(timer);
            });
    }

    write(params: WriteParams): Promise<WriteResult> {
        const payload = {
            entity: params.entity,
            key: params.key,
            value: params.value,
            summary: params.summary,
            confidence: params.confidence,
            source: params.source,
            agent: params.agent,
            validFrom: normalizeDateInput(params.validFrom),
            requestId: params.requestId,
        };

        return this.request<WriteResult>('POST', '/kb/write', { body: payload });
    }

    ingest(params: IngestParams): Promise<IngestResult> {
        return this.request<IngestResult>('POST', '/kb/ingest', { body: params });
    }

    query(entity: string, key: string, options: QueryOptions = {}): Promise<QueryResult> {
        const { entityType, entityId } = parseEntity(entity);
        const query = buildQuery({
            asOf: normalizeDateInput(options.asOf),
            includeExpired: options.includeExpired ?? false,
            includeContested: options.includeContested ?? true,
        });

        return this.request<QueryResult>('GET', `/kb/query/${entityType}/${entityId}/${key}${query}`);
    }

    history(entity: string, key: string, options: Omit<QueryOptions, 'asOf'> = {}): Promise<HistoryEntry[]> {
        const { entityType, entityId } = parseEntity(entity);
        const query = buildQuery({
            includeExpired: options.includeExpired ?? false,
            includeContested: options.includeContested ?? true,
        });

        return this.request<HistoryEntry[]>('GET', `/kb/history/${entityType}/${entityId}/${key}${query}`);
    }

    queryAll(entity: string): Promise<QueryAllFact[]> {
        const { entityType, entityId } = parseEntity(entity);
        return this.request<QueryAllFact[]>('GET', `/kb/query/${entityType}/${entityId}`);
    }

    async search(params: SearchParams): Promise<SearchResult[]> {
        const query = buildQuery({
            query: params.query,
            limit: params.limit,
            entityType: params.entityType,
            entityId: params.entityId,
            lexicalWeight: params.lexicalWeight,
            vectorWeight: params.vectorWeight,
            minScore: params.minScore,
        });

        const result = await this.request<{ results: SearchResult[] }>('GET', `/kb/search${query}`);
        return result.results;
    }

    relate(params: RelateParams): Promise<RelateResult> {
        return this.request<RelateResult>('POST', '/kb/relate', { body: params });
    }

    getRelated(entity: string): Promise<RelatedResult[]> {
        const { entityType, entityId } = parseEntity(entity);
        return this.request<RelatedResult[]>('GET', `/kb/related/${entityType}/${entityId}`);
    }

    related(entity: string): Promise<RelatedResult[]> {
        return this.getRelated(entity);
    }

    getRelatedDeep(entity: string, depth: number = 2): Promise<RelatedResult[]> {
        const { entityType, entityId } = parseEntity(entity);
        return this.request<RelatedResult[]>(
            'GET',
            `/kb/related/${entityType}/${entityId}/deep${buildQuery({ depth })}`
        );
    }

    relatedDeep(entity: string, depth: number = 2): Promise<RelatedResult[]> {
        return this.getRelatedDeep(entity, depth);
    }

    handshake(params: HandshakeParams): Promise<WorkingMemoryBrief> {
        return this.request<WorkingMemoryBrief>('POST', '/memory/handshake', { body: params });
    }

    reconvene(params: ReconveneParams): Promise<WorkingMemoryBrief> {
        return this.request<WorkingMemoryBrief>('POST', '/memory/reconvene', { body: params });
    }

    observe(params: ObserveParams): Promise<ObserveResult> {
        return this.request<ObserveResult>('POST', '/memory/observe', {
            body: {
                agentId: params.agentId,
                currentContext: params.currentContext,
                maxFacts: params.maxFacts,
                entityHints: params.entityHints,
            },
        });
    }

    attend(params: AttendParams): Promise<AttendResult> {
        return this.request<AttendResult>('POST', '/memory/attend', {
            body: {
                agentId: params.agentId,
                currentContext: params.currentContext,
                latestMessage: params.latestMessage,
                maxFacts: params.maxFacts,
                entityHints: params.entityHints,
                forceInject: params.forceInject ?? false,
            },
        });
    }

    whoKnows(entity: string): Promise<WhoKnowsResult[]> {
        const { entityType, entityId } = parseEntity(entity);
        return this.request<WhoKnowsResult[]>('GET', `/memory/whoknows/${entityType}/${entityId}`);
    }

    registerAgent(params: RegisterAgentParams): Promise<{ success: boolean }> {
        return this.request<{ success: boolean }>('POST', '/agents/register', { body: params });
    }

    async getAgent(agentId: string): Promise<AgentRecord | null> {
        try {
            return await this.request<AgentRecord>('GET', `/agents/${agentId}`);
        } catch (error) {
            if (error instanceof IrantiNotFoundError) {
                return null;
            }
            throw error;
        }
    }

    listAgents(): Promise<AgentProfile[]> {
        return this.request<AgentProfile[]>('GET', '/agents');
    }

    assignToTeam(agentId: string, teamId: string): Promise<{ success: boolean }> {
        return this.request<{ success: boolean }>('POST', `/agents/${agentId}/team`, {
            body: { teamId },
        });
    }

    runMaintenance(): Promise<MaintenanceReport> {
        return this.request<MaintenanceReport>('POST', '/memory/maintenance', { body: {} });
    }

    resolveEntity(params: {
        entity: string;
        createIfMissing?: boolean;
        aliases?: string[];
        source?: string;
        confidence?: number;
        agent?: string;
    }): Promise<ResolveEntityResponse> {
        return this.request<ResolveEntityResponse>('POST', '/kb/resolve', { body: params });
    }

    addAlias(params: {
        canonicalEntity: string;
        alias: string;
        source?: string;
        confidence?: number;
        force?: boolean;
    }): Promise<AliasResponse> {
        return this.request<AliasResponse>('POST', '/kb/alias', { body: params });
    }

    listAliases(entity: string): Promise<string[]> {
        const { entityType, entityId } = parseEntity(entity);
        return this.request<string[]>('GET', `/kb/entity/${entityType}/${entityId}/aliases`);
    }

    lastHttp(): LastHttpMetadata {
        return { ...this.lastHttpMeta };
    }
}
