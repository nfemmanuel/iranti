import assert from 'assert';
import { backfillChatHistory, parseBackfillChatTranscript } from '../../src/lib/autoRemember';

type StoredFact = {
    value: unknown;
    summary: string;
};

class StubIrantiClient {
    private readonly store = new Map<string, StoredFact>();

    async query(entity: string, key: string): Promise<{ found: boolean; value?: unknown }> {
        const stored = this.store.get(`${entity}::${key}`);
        return stored
            ? { found: true, value: stored.value }
            : { found: false };
    }

    async write(input: {
        entity: string;
        key: string;
        value: unknown;
        summary: string;
        confidence: number;
        source: string;
        agent: string;
    }): Promise<unknown> {
        this.store.set(`${input.entity}::${input.key}`, {
            value: input.value,
            summary: input.summary,
        });
        return { ok: true };
    }

    keys(): string[] {
        return Array.from(this.store.keys()).sort();
    }
}

async function main(): Promise<void> {
    const transcript = [
        'User: my favorite painter is Hilma af Klint',
        'Assistant: Your favorite painter is Hilma af Klint.',
        'User: we decided to ship the patch release first',
        'Assistant: The next step is rerun the db validation.',
    ].join('\n');

    const parsed = parseBackfillChatTranscript(transcript);
    assert.strictEqual(parsed.length, 4, 'Expected transcript parser to preserve four role-labeled messages.');
    assert.strictEqual(parsed[0]?.role, 'user');
    assert.strictEqual(parsed[1]?.role, 'assistant');

    const stub = new StubIrantiClient();
    const result = await backfillChatHistory({
        iranti: stub,
        content: transcript,
        agent: 'test_agent',
        source: 'CLIBackfill',
        projectEntity: 'project/test_repo',
        personalEntity: 'user/main',
    });

    assert.strictEqual(result.messagesParsed, 4, 'Expected backfill to report parsed messages.');
    assert.ok(result.extracted >= 3, 'Expected multiple durable facts to be extracted from the transcript.');
    assert.ok(result.written >= 3, 'Expected the backfill flow to persist extracted durable facts.');

    const keys = stub.keys();
    assert.ok(keys.includes('user/main::favorite_painter'), 'Expected a personal preference fact to be written.');
    assert.ok(keys.includes('project/test_repo::decision'), 'Expected a project decision fact to be written.');
    assert.ok(keys.includes('project/test_repo::next_step'), 'Expected a project next-step fact to be written.');

    console.log('attendant backfill import passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
