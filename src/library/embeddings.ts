const DEFAULT_DIMENSIONS = 256;

function clampDimensions(raw: string | undefined): number {
    const parsed = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_DIMENSIONS;
    }
    return Math.min(parsed, 1024);
}

export const EMBEDDING_DIMENSIONS = clampDimensions(process.env.IRANTI_EMBEDDING_DIM);

function normalizeText(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
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

export function buildEmbeddingText(key: string, summary: string, valueRaw: unknown): string {
    const valueText = typeof valueRaw === 'string' ? valueRaw : JSON.stringify(valueRaw);
    return `${key} ${summary} ${valueText}`;
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
