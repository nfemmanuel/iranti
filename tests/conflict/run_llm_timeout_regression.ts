import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { bootstrapHarness } from '../../scripts/harness';
import { configureMock } from '../../src/lib/providers/mock';
import { Iranti } from '../../src/sdk';

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

async function main() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('DATABASE_URL is required to run the LLM timeout regression.');
    }

    process.env.LLM_PROVIDER = 'mock';
    process.env.IRANTI_CONFLICT_RESOLUTION_TIMEOUT_MS = '1000';
    process.env.IRANTI_TX_TIMEOUT_MS = '4000';
    process.env.IRANTI_TX_MAX_WAIT_MS = '2000';
    process.env.IRANTI_ESCALATION_DIR = path.resolve(process.cwd(), 'tests', 'conflict', '.runtime', 'escalation');
    await fs.mkdir(process.env.IRANTI_ESCALATION_DIR, { recursive: true });

    bootstrapHarness({ requireDb: true, forceLocalEscalationDir: false });
    configureMock({
        scenario: 'default',
        seed: 42,
        failureRate: 0,
        responseDelayMs: 2500,
    });

    const iranti = new Iranti({
        connectionString,
        llmProvider: 'mock',
    });

    const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const entity = `project/timeout_regression_${suffix}`;

    const first = await iranti.write({
        entity,
        key: 'budget',
        value: { amount: 50000, currency: 'USD' },
        summary: 'Budget is 50K USD.',
        confidence: 55,
        source: 'source_alpha',
        agent: 'agent_alpha',
    });

    const second = await iranti.write({
        entity,
        key: 'budget',
        value: { amount: 54000, currency: 'USD' },
        summary: 'Budget is 54K USD.',
        confidence: 50,
        source: 'source_beta',
        agent: 'agent_beta',
    });

    const current = await iranti.query(entity, 'budget');
    const history = await iranti.history(entity, 'budget');

    expect(first.action === 'created', `Expected first action created, got ${first.action}.`);
    expect(second.action === 'escalated', `Expected second action escalated after LLM timeout, got ${second.action}.`);
    expect(!/transaction/i.test(second.reason), `Expected clean escalation reason, got ${second.reason}.`);
    expect(current.found === false, 'Expected no current row while escalation is pending.');
    expect(history.some((row) => row.archivedReason === 'escalated'), 'Expected escalated history row.');

    console.log('llm timeout regression passed');
    process.exit(0);
}

main().catch((err) => {
    console.error('LLM timeout regression failed:', err);
    process.exit(1);
});
