const DEFAULT_DIMENSIONS = 256;
const TOKEN_SYNONYMS: Record<string, string[]> = {
    hq: ['headquarters', 'location', 'city'],
    headquarters: ['hq', 'location', 'city'],
    location: ['city', 'headquarters', 'hq'],
    city: ['location', 'hq', 'headquarters'],
    capital: ['city', 'location'],
    employee: ['employees', 'staff', 'team', 'headcount'],
    employees: ['employee', 'staff', 'team', 'headcount'],
    staff: ['employees', 'team', 'headcount'],
    team: ['staff', 'employees', 'headcount'],
    size: ['count', 'headcount', 'team'],
    count: ['size', 'total', 'number'],
    headcount: ['employees', 'team', 'staff', 'count'],
    runway: ['cash', 'months', 'burn'],
    months: ['runway', 'duration'],
    budget: ['funding', 'funds', 'spend'],
    blocker: ['issue', 'problem', 'risk'],
    blockers: ['issues', 'problems', 'risks'],
    issue: ['blocker', 'problem', 'risk'],
    issues: ['blockers', 'problems', 'risks'],
    bug: ['issue', 'problem', 'defect'],
    bugs: ['issues', 'problems', 'defects'],
    defect: ['issue', 'problem', 'bug'],
    defects: ['issues', 'problems', 'bugs'],
    problem: ['issue', 'blocker', 'risk'],
    problems: ['issues', 'blockers', 'risks'],
    risk: ['issue', 'problem', 'blocker'],
    risks: ['issues', 'problems', 'blockers'],
    status: ['progress', 'state', 'summary', 'overview'],
    progress: ['status', 'state', 'summary', 'overview'],
    state: ['status', 'progress', 'summary'],
    summary: ['status', 'progress', 'overview'],
    overview: ['summary', 'status', 'progress'],
    decision: ['decided', 'choice', 'resolution'],
    decisions: ['decided', 'choices', 'resolutions'],
    decided: ['decision', 'resolution', 'choice'],
    launch: ['release', 'ship', 'rollout'],
    release: ['launch', 'ship', 'rollout'],
    favorite: ['preferred', 'likes', 'preference'],
    preferred: ['favorite', 'preference'],
};

const SAFE_TOKEN_SYNONYMS: Record<string, string[]> = Object.assign(Object.create(null), TOKEN_SYNONYMS);

function clampDimensions(raw: string | undefined): number {
    const parsed = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_DIMENSIONS;
    }
    return Math.min(parsed, 1024);
}

export const EMBEDDING_DIMENSIONS = clampDimensions(process.env.IRANTI_EMBEDDING_DIM);

function normalizeText(text: string): string[] {
    const baseTokens = String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);

    const expanded: string[] = [];
    for (const token of baseTokens) {
        expanded.push(token);
        const synonyms = SAFE_TOKEN_SYNONYMS[token];
        if (Array.isArray(synonyms)) {
            expanded.push(...synonyms);
        }
    }

    return expanded;
}

function fnv1a(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function l2Normalize(values: number[]): number[] {
    const sumSquares = values.reduce((sum, value) => sum + value * value, 0);
    if (sumSquares === 0) {
        return values;
    }
    const norm = Math.sqrt(sumSquares);
    return values.map((value) => value / norm);
}

export function cosineSimilarity(left: number[], right: number[]): number {
    if (left.length === 0 || right.length === 0 || left.length !== right.length) {
        return 0;
    }

    let dot = 0;
    let leftMagnitude = 0;
    let rightMagnitude = 0;

    for (let index = 0; index < left.length; index += 1) {
        const leftValue = left[index];
        const rightValue = right[index];
        dot += leftValue * rightValue;
        leftMagnitude += leftValue * leftValue;
        rightMagnitude += rightValue * rightValue;
    }

    if (leftMagnitude === 0 || rightMagnitude === 0) {
        return 0;
    }

    return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

type EmbeddingTextInput = {
    entityType?: string;
    entityId?: string;
    key: string;
    summary: string;
    valueRaw: unknown;
};

function buildEntityAddressText(entityType?: string, entityId?: string): string {
    const normalizedType = entityType?.trim() ?? '';
    const normalizedId = entityId?.trim() ?? '';
    const spacedId = normalizedId.replace(/[-_/]+/g, ' ').trim();
    const address = normalizedType && normalizedId ? `${normalizedType}/${normalizedId}` : '';
    return [normalizedType, normalizedId, spacedId, address].filter(Boolean).join(' ');
}

export function buildEmbeddingText(input: EmbeddingTextInput): string {
    const valueText = typeof input.valueRaw === 'string' ? input.valueRaw : JSON.stringify(input.valueRaw);
    const entityText = buildEntityAddressText(input.entityType, input.entityId);
    return [entityText, input.key, input.summary, valueText].filter(Boolean).join(' ');
}

export function generateEmbedding(text: string, dimensions: number = EMBEDDING_DIMENSIONS): number[] {
    const tokens = normalizeText(text);
    const vector = new Array(dimensions).fill(0) as number[];

    if (tokens.length === 0) {
        return vector;
    }

    for (const token of tokens) {
        const hashA = fnv1a(token);
        const hashB = fnv1a(`${token}:iranti`);

        const indexA = hashA % dimensions;
        const indexB = hashB % dimensions;
        const signA = ((hashA >>> 1) & 1) === 0 ? 1 : -1;
        const signB = ((hashB >>> 1) & 1) === 0 ? 1 : -1;

        const weight = 1 + Math.log1p(token.length);
        vector[indexA] += signA * weight;
        vector[indexB] += signB * weight * 0.5;
    }

    return l2Normalize(vector);
}

export function toPgVectorLiteral(vector: number[]): string {
    const values = vector.map((value) => {
        if (!Number.isFinite(value)) return '0';
        return value.toFixed(8);
    });
    return `[${values.join(',')}]`;
}
