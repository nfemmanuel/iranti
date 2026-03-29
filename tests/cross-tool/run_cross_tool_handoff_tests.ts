import 'dotenv/config';
import { bootstrapHarness } from '../../scripts/harness';
import { configureMock } from '../../src/lib/providers/mock';
import { Iranti } from '../../src/sdk';
import { disconnectDb } from '../../src/library/client';
import { Pool } from 'pg';

const DEFAULT_VALIDATION_DATABASE_URL = 'postgresql://postgres:053435@localhost:5433/iranti_temporal';

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

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

async function hasModernKnowledgeSchema(connectionString: string): Promise<boolean> {
    const pool = new Pool({
        connectionString,
        max: 1,
        idleTimeoutMillis: 0,
        connectionTimeoutMillis: 2000,
    });

    try {
        const client = await pool.connect();
        try {
            const result = await client.query<{ exists: boolean }>(
                `SELECT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = 'knowledge_base'
                      AND column_name = 'validFrom'
                ) AS exists`
            );
            return result.rows[0]?.exists === true;
        } finally {
            client.release();
        }
    } catch {
        return false;
    } finally {
        await pool.end().catch(() => undefined);
    }
}

async function resolveCrossToolDatabaseUrl(): Promise<string> {
    const candidates = [
        process.env.DATABASE_URL?.trim(),
        process.env.IRANTI_VALIDATION_DATABASE_URL?.trim(),
        DEFAULT_VALIDATION_DATABASE_URL,
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
        if (!await canReachDatabase(candidate)) continue;
        if (!await hasModernKnowledgeSchema(candidate)) continue;
        process.env.DATABASE_URL = candidate;
        return candidate;
    }

    throw new Error(
        'Cross-tool handoff tests could not find a reachable migrated database. ' +
        `Checked: ${candidates.join(', ')}`
    );
}

async function main(): Promise<void> {
    process.env.LLM_PROVIDER = 'mock';
    configureMock({
        scenario: 'default',
        seed: 42,
        failureRate: 0,
    });

    const connectionString = await resolveCrossToolDatabaseUrl();
    bootstrapHarness({ requireDb: true, forceLocalEscalationDir: true });

    const iranti = new Iranti({
        connectionString,
        llmProvider: 'mock',
    });

    const suffix = Date.now();
    const taskEntity = `task/cross_tool_handoff_${suffix}`;
    const projectEntity = `project/cross_tool_demo_${suffix}`;
    const claudeAgent = `claude_code_handoff_${suffix}`;
    const codexAgent = `codex_code_handoff_${suffix}`;

    await iranti.registerAgent({
        agentId: claudeAgent,
        name: 'Claude Code',
        description: 'Cross-tool handoff smoke sender',
        capabilities: ['working_memory', 'handoff_write'],
        model: 'claude-code',
    });

    await iranti.registerAgent({
        agentId: codexAgent,
        name: 'Codex',
        description: 'Cross-tool handoff smoke receiver',
        capabilities: ['working_memory', 'handoff_read'],
        model: 'codex',
    });

    await iranti.write({
        entity: taskEntity,
        key: 'status',
        value: { state: 'ready_for_codex' },
        summary: 'Shared task is ready for Codex pickup.',
        confidence: 96,
        source: 'ClaudeCode',
        agent: claudeAgent,
    });

    await iranti.write({
        entity: taskEntity,
        key: 'next_step',
        value: { instruction: 'Implement the CLI runtime verification pass.' },
        summary: 'Next step is to implement the CLI runtime verification pass.',
        confidence: 95,
        source: 'ClaudeCode',
        agent: claudeAgent,
    });

    await iranti.write({
        entity: taskEntity,
        key: 'blockers',
        value: { items: ['Need receiver to preserve compatibility docs.'] },
        summary: 'One blocker remains: preserve compatibility docs while implementing.',
        confidence: 92,
        source: 'ClaudeCode',
        agent: claudeAgent,
    });

    await iranti.write({
        entity: taskEntity,
        key: 'artifacts',
        value: { files: ['docs/guides/codex.md', 'docs/guides/claude-code.md'] },
        summary: 'Relevant artifacts are the Codex and Claude guides.',
        confidence: 90,
        source: 'ClaudeCode',
        agent: claudeAgent,
    });

    const checkpointedBrief = await iranti.checkpoint({
        agentId: claudeAgent,
        task: 'Prepare a Codex handoff for the runtime verification pass.',
        recentMessages: [
            'Writing a shared handoff for Codex.',
            'Checkpointing before handing the task over.',
        ],
        checkpoint: {
            currentStep: 'captured shared task status and next step',
            nextStep: 'hand task to Codex via shared memory',
            openRisks: ['Receiver must use shared task facts rather than assume Claude session ownership.'],
            recentOutputs: ['Persisted status, next_step, blockers, and artifacts to the shared task entity.'],
            entityTargets: [taskEntity, projectEntity],
            notes: 'Cross-tool handoff uses shared task facts plus explicit entity hints. Session recovery remains agent-scoped.',
        },
    });

    expect(checkpointedBrief.sessionCheckpoint?.status === 'active', 'Expected Claude checkpoint to remain active.');
    expect(
        checkpointedBrief.sessionCheckpoint?.checkpoint.entityTargets?.includes(taskEntity),
        'Expected Claude checkpoint to include the shared task entity.'
    );

    const checkpointCurrentStep = await iranti.query(taskEntity, 'checkpoint_current_step');
    expect(checkpointCurrentStep.found === true, 'Expected checkpoint_current_step breadcrumb to be persisted for shared task targets.');
    expect(
        JSON.stringify(checkpointCurrentStep.value).includes('captured shared task status and next step'),
        'Expected checkpoint_current_step breadcrumb to preserve the current step.'
    );

    const checkpointNextStep = await iranti.query(taskEntity, 'checkpoint_next_step');
    expect(checkpointNextStep.found === true, 'Expected checkpoint_next_step breadcrumb to be persisted for shared task targets.');
    expect(
        JSON.stringify(checkpointNextStep.value).includes('hand task to Codex'),
        'Expected checkpoint_next_step breadcrumb to preserve the next step.'
    );

    const checkpointSummary = await iranti.query(projectEntity, 'checkpoint_summary');
    expect(checkpointSummary.found === true, 'Expected checkpoint_summary breadcrumb to be persisted for all checkpoint targets.');
    expect(
        JSON.stringify(checkpointSummary.value).includes('Cross-tool handoff uses shared task facts'),
        'Expected checkpoint_summary breadcrumb to preserve checkpoint notes for later handoff recovery.'
    );

    const codexHandshake = await iranti.handshake({
        agentId: codexAgent,
        task: 'Continue the shared runtime verification task handed off from Claude.',
        recentMessages: [
            `Resume work for ${taskEntity}.`,
            'Read the shared handoff and continue implementation.',
        ],
    });

    expect(codexHandshake.agentId === codexAgent, 'Expected Codex handshake to initialize the Codex agent.');
    expect(
        codexHandshake.workingMemory.every((entry) => !entry.entityKey.startsWith(`${taskEntity}/`)),
        'Expected receiver handshake to avoid auto-importing shared task facts without an explicit query, observe, or attend call.'
    );

    const codexSession = await iranti.inspectSession({
        agentId: codexAgent,
        task: 'Continue the shared runtime verification task handed off from Claude.',
        recentMessages: [
            `Resume work for ${taskEntity}.`,
            'Read the shared handoff and continue implementation.',
        ],
    });
    expect(codexSession.hasCheckpoint === false, 'Expected the receiver handshake to avoid inheriting the sender checkpoint.');
    expect(codexSession.summary.operatorState === 'none', 'Expected the receiver session summary to show no private checkpoint until Codex creates one.');

    const nextStepQuery = await iranti.query(taskEntity, 'next_step');
    expect(nextStepQuery.found === true, 'Expected Codex to be able to query the shared next_step fact.');
    expect(
        JSON.stringify(nextStepQuery.value).includes('runtime verification pass'),
        'Expected next_step fact to mention the runtime verification pass.'
    );

    const claudeSession = await iranti.inspectSession({ agentId: claudeAgent });
    expect(claudeSession.hasCheckpoint === true, 'Expected inspectSession() to expose the Claude handoff checkpoint.');
    expect(claudeSession.summary.operatorState === 'active', 'Expected Claude handoff checkpoint to remain operator-active.');

    const activeSessions = await iranti.listSessions({
        agentId: claudeAgent,
        operatorState: 'active',
        sort: 'operator',
        limit: 5,
    });
    expect(activeSessions.length === 1, 'Expected Claude session inventory filter to return a single active checkpoint.');
    expect(activeSessions[0]?.sessionId === checkpointedBrief.sessionCheckpoint?.sessionId, 'Expected session inventory to return the Claude checkpoint session id.');

    const codexSessions = await iranti.listSessions({
        agentId: codexAgent,
        sort: 'operator',
        limit: 5,
    });
    expect(codexSessions.length === 0, 'Expected session inventory to remain agent-scoped until the receiver checkpoints its own work.');

    const codexObserve = await iranti.observe({
        agentId: codexAgent,
        currentContext: '',
        entityHints: [taskEntity, projectEntity],
        maxFacts: 10,
    });

    expect(
        codexObserve.facts.some((fact) => fact.entityKey === `${taskEntity}/next_step`),
        'Expected Codex observe() to surface the shared next_step fact.'
    );

    const codexAttend = await iranti.attend({
        agentId: codexAgent,
        latestMessage: `Continue work for ${taskEntity}. What should I do next?`,
        currentContext: 'We are continuing a shared task handoff between Claude Code and Codex.',
        entityHints: [taskEntity, projectEntity],
        maxFacts: 10,
        forceInject: true,
    });

    expect(
        codexAttend.facts.some((fact) => fact.entityKey === `${taskEntity}/next_step`),
        'Expected Codex attend() to surface the shared next_step fact when forceInject is enabled.'
    );

    await iranti.write({
        entity: taskEntity,
        key: 'implementation_status',
        value: { state: 'started_by_codex' },
        summary: 'Codex has picked up the shared task and started implementation.',
        confidence: 94,
        source: 'Codex',
        agent: codexAgent,
    });

    const implementationStatus = await iranti.query(taskEntity, 'implementation_status');
    expect(implementationStatus.found === true, 'Expected Claude to be able to query the Codex implementation_status fact.');

    const claudeObserve = await iranti.observe({
        agentId: claudeAgent,
        currentContext: '',
        entityHints: [taskEntity],
        maxFacts: 5,
    });

    expect(
        claudeObserve.facts.some((fact) => fact.entityKey === `${taskEntity}/implementation_status`),
        'Expected Claude observe() to see the Codex implementation_status fact.'
    );

    console.log('Cross-tool handoff smoke test passed.');
    console.log(`task entity: ${taskEntity}`);
    console.log(`claude checkpoint session: ${checkpointedBrief.sessionCheckpoint?.sessionId}`);
    console.log(`codex observed facts: ${codexObserve.facts.map((fact) => fact.entityKey).join(', ')}`);
    console.log(`codex injected facts: ${codexAttend.facts.map((fact) => fact.entityKey).join(', ')}`);
    console.log(`claude reconvened facts: ${claudeObserve.facts.map((fact) => fact.entityKey).join(', ')}`);
}

main()
    .catch((error) => {
        console.error('Cross-tool handoff smoke test failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await disconnectDb().catch(() => undefined);
    });
