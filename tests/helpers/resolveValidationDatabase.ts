import { Pool } from 'pg';

const DEFAULT_VALIDATION_DATABASE_URL = 'postgresql://postgres:053435@localhost:5433/iranti_temporal';
const LOCAL_COMPOSE_DATABASE_URL = 'postgresql://postgres:053435@localhost:5432/iranti';

async function canReachDatabase(connectionString: string): Promise<boolean> {
    const pool = new Pool({
        connectionString,
        max: 1,
        idleTimeoutMillis: 0,
        connectionTimeoutMillis: 2000,
    });

    try {
        const client = await pool.connect();
        try {
            await client.query('SELECT 1');
            return true;
        } finally {
            client.release();
        }
    } catch {
        return false;
    } finally {
        await pool.end().catch(() => undefined);
    }
}

export async function resolveValidationDatabaseUrl(label: string): Promise<string> {
    const candidates = [
        process.env.DATABASE_URL?.trim(),
        process.env.IRANTI_VALIDATION_DATABASE_URL?.trim(),
        LOCAL_COMPOSE_DATABASE_URL,
        DEFAULT_VALIDATION_DATABASE_URL,
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
        if (!await canReachDatabase(candidate)) continue;
        process.env.DATABASE_URL = candidate;
        return candidate;
    }

    throw new Error(`${label} could not find a reachable database. Checked: ${candidates.join(', ')}`);
}
