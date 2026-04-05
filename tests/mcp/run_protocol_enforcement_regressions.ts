import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapHarness, ensureHarnessStaffEventsTable } from '../../scripts/harness';
import { resolveValidationDatabaseUrl } from '../helpers/resolveValidationDatabase';

const mcpSdkRoot = path.resolve(process.cwd(), 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client');
const { Client } = require(path.join(mcpSdkRoot, 'index.js'));
const { StdioClientTransport } = require(path.join(mcpSdkRoot, 'stdio.js'));

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

async function main(): Promise<void> {
    process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'mock';
    const connectionString = await resolveValidationDatabaseUrl('MCP protocol enforcement regressions');
    bootstrapHarness({
        requireDb: true,
        forceLocalEscalationDir: true,
        dbApplicationName: 'iranti:test:mcp_protocol_enforcement',
    });
    await ensureHarnessStaffEventsTable();

    const serverCwd = path.join(os.tmpdir(), 'iranti-mcp-protocol-enforcement');
    fs.mkdirSync(serverCwd, { recursive: true });

    const serverEnv = {
        ...process.env,
        DATABASE_URL: connectionString,
        LLM_PROVIDER: process.env.LLM_PROVIDER || 'mock',
        IRANTI_AGENT_ID: 'main_agent',
        IRANTI_MCP_DEFAULT_AGENT: 'codex_code',
        IRANTI_MCP_DEFAULT_SOURCE: 'Codex',
        IRANTI_MCP_HOST: 'codex_cli',
        IRANTI_MEMORY_ENTITY: 'project/mcp_protocol_project_memory',
        IRANTI_PERSONAL_MEMORY_ENTITY: 'user/main',
        IRANTI_ESCALATION_DIR: process.env.IRANTI_ESCALATION_DIR || path.resolve(process.cwd(), 'tests', 'mcp', '.runtime', 'escalation'),
    } as Record<string, string>;
    delete serverEnv.IRANTI_PROJECT_ENV;
    delete serverEnv.IRANTI_INSTANCE_ENV;

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve(process.cwd(), 'dist', 'scripts', 'iranti-mcp.js')],
        cwd: serverCwd,
        env: serverEnv,
        stderr: 'pipe',
    });

    if (transport.stderr) {
        transport.stderr.on('data', (chunk: unknown) => {
            const text = String(chunk ?? '').trim();
            if (text) {
                process.stderr.write(`[mcp-protocol][server] ${text}\n`);
            }
        });
    }

    const client = new Client({
        name: 'iranti-mcp-protocol-enforcement',
        version: '0.1.0',
    });

    const agentId = `mcp_protocol_${Date.now()}`;
    const entity = `project/mcp_protocol_${Date.now()}`;

    try {
        await client.connect(transport);

        const write = await client.callTool({
            name: 'iranti_write',
            arguments: {
                entity,
                key: 'status',
                valueJson: JSON.stringify({ phase: 'protocol_regression' }),
                summary: 'Focused MCP protocol regression entity status is protocol_regression.',
                confidence: 93,
                agent: agentId,
            },
        });
        expect(!write.isError, 'Expected focused MCP protocol write to succeed.');

        const policyWrite = await client.callTool({
            name: 'iranti_write',
            arguments: {
                entity: 'project/mcp_protocol_project_memory',
                key: 'agent_worktree_cleanup_rule',
                valueJson: JSON.stringify({ rule: 'Leave a clean worktree or emit an explicit residue report before ending the run.' }),
                summary: 'Leave a clean worktree or emit an explicit residue report before ending the run.',
                confidence: 95,
                agent: agentId,
            },
        });
        expect(!policyWrite.isError, 'Expected focused MCP protocol policy write to succeed.');

        const queryBeforeHandshake = await client.callTool({
            name: 'iranti_query',
            arguments: {
                agent: agentId,
                entity,
                key: 'status',
            },
        });
        expect(!queryBeforeHandshake.isError, 'Expected pre-handshake query to return a structured protocol violation.');
        expect(
            JSON.stringify(queryBeforeHandshake.structuredContent).includes('"code":"handshake_required"'),
            'Expected pre-handshake query to be blocked with handshake_required.',
        );

        const handshake = await client.callTool({
            name: 'iranti_handshake',
            arguments: {
                task: 'Validate MCP protocol enforcement.',
                recentMessages: ['Start focused MCP protocol enforcement regression test.'],
                agent: agentId,
            },
        });
        expect(!handshake.isError, 'Expected focused MCP handshake to succeed.');
        const handshakePayload = JSON.stringify(handshake.structuredContent);
        expect(
            handshakePayload.includes('"projectPolicies"') && handshakePayload.includes('agent_worktree_cleanup_rule'),
            'Expected focused MCP handshake to surface project-scoped policies.',
        );
        expect(
            handshakePayload.includes('Leave a clean worktree or emit an explicit residue report before ending the run.'),
            'Expected focused MCP handshake to append the project-scoped policy into the operating rules.',
        );

        const queryBeforeAttend = await client.callTool({
            name: 'iranti_query',
            arguments: {
                agent: agentId,
                entity,
                key: 'status',
            },
        });
        expect(!queryBeforeAttend.isError, 'Expected post-handshake pre-attend query to return a structured protocol violation.');
        expect(
            JSON.stringify(queryBeforeAttend.structuredContent).includes('"code":"attend_required"'),
            'Expected post-handshake pre-attend query to be blocked with attend_required.',
        );

        const attend = await client.callTool({
            name: 'iranti_attend',
            arguments: {
                agent: agentId,
                latestMessage: 'What is the focused MCP protocol regression entity status?',
                currentContext: 'We are validating fail-closed protocol enforcement in the MCP host adapter.',
                entityHints: [entity],
                maxFacts: 3,
                phase: 'pre-response',
            },
        });
        expect(!attend.isError, 'Expected iranti_attend to succeed.');

        const attendWithoutPostResponse = await client.callTool({
            name: 'iranti_attend',
            arguments: {
                agent: agentId,
                latestMessage: 'Start another turn without closing the previous one.',
                currentContext: 'We are validating post-response lifecycle enforcement in the MCP host adapter.',
                entityHints: [entity],
                maxFacts: 3,
                phase: 'pre-response',
            },
        });
        expect(
            JSON.stringify(attendWithoutPostResponse.structuredContent).includes('"code":"post_response_required"'),
            'Expected repeated pre-response attend to be blocked with post_response_required.',
        );

        const closePreviousTurn = await client.callTool({
            name: 'iranti_attend',
            arguments: {
                agent: agentId,
                latestMessage: 'Close the previous response.',
                currentContext: 'We are closing the previous MCP response loop.',
                phase: 'post-response',
            },
        });
        expect(!closePreviousTurn.isError, 'Expected post-response attend to succeed.');

        const nextAttend = await client.callTool({
            name: 'iranti_attend',
            arguments: {
                agent: agentId,
                latestMessage: 'Start the next turn correctly.',
                currentContext: 'We are validating the next turn after a compliant post-response.',
                entityHints: [entity],
                maxFacts: 3,
                phase: 'pre-response',
            },
        });
        expect(!nextAttend.isError, 'Expected pre-response attend after a post-response close to succeed.');

        const queryAfterAttend = await client.callTool({
            name: 'iranti_query',
            arguments: {
                agent: agentId,
                entity,
                key: 'status',
            },
        });
        expect(!queryAfterAttend.isError, 'Expected post-attend query to succeed.');
        expect(
            JSON.stringify(queryAfterAttend.structuredContent).includes('protocol_regression'),
            'Expected post-attend query to return the stored fact.',
        );

        const searchAfterConsumedBudget = await client.callTool({
            name: 'iranti_search',
            arguments: {
                agent: agentId,
                query: `${entity} protocol_regression`,
                limit: 5,
            },
        });
        expect(!searchAfterConsumedBudget.isError, 'Expected search after the query to return a structured protocol violation.');
        expect(
            JSON.stringify(searchAfterConsumedBudget.structuredContent).includes('"code":"attend_required"'),
            'Expected search after the first discovery read to require a fresh attend.',
        );

        const historyAfterConsumedBudget = await client.callTool({
            name: 'iranti_history',
            arguments: {
                agent: agentId,
                entity,
                key: 'status',
            },
        });
        expect(!historyAfterConsumedBudget.isError, 'Expected history after the query to return a structured protocol violation.');
        expect(
            JSON.stringify(historyAfterConsumedBudget.structuredContent).includes('"code":"attend_required"'),
            'Expected history after the first discovery read to require a fresh attend.',
        );

        const ignoredMemoryAgentId = `mcp_protocol_memory_enforced_${Date.now()}`;
        const ignoredMemoryEntity = `project/mcp_protocol_memory_enforced_${Date.now()}`;

        const ignoredMemoryWrite = await client.callTool({
            name: 'iranti_write',
            arguments: {
                entity: ignoredMemoryEntity,
                key: 'next_step',
                valueJson: JSON.stringify({ instruction: 'rerun the runtime validation and capture the result.' }),
                summary: 'Next step is rerun the runtime validation and capture the result.',
                confidence: 94,
                agent: ignoredMemoryAgentId,
            },
        });
        expect(!ignoredMemoryWrite.isError, 'Expected ignored-memory seed write to succeed.');

        const ignoredMemoryHandshake = await client.callTool({
            name: 'iranti_handshake',
            arguments: {
                task: 'Validate strict blocking after repeated ignored injected memory.',
                recentMessages: ['Start ignored injected memory MCP coverage.'],
                agent: ignoredMemoryAgentId,
            },
        });
        expect(!ignoredMemoryHandshake.isError, 'Expected ignored-memory MCP handshake to succeed.');

        for (let turn = 0; turn < 2; turn++) {
            const ignoredPreAttend = await client.callTool({
                name: 'iranti_attend',
                arguments: {
                    agent: ignoredMemoryAgentId,
                    latestMessage: 'What should I do next on this runtime validation task?',
                    currentContext: 'The host surfaced memory but will ignore it.',
                    entityHints: [ignoredMemoryEntity],
                    maxFacts: 3,
                    phase: 'pre-response',
                },
            });
            expect(!ignoredPreAttend.isError, `Expected ignored-memory pre-response attend ${turn + 1} to succeed.`);

            const ignoredPostAttend = await client.callTool({
                name: 'iranti_attend',
                arguments: {
                    agent: ignoredMemoryAgentId,
                    latestMessage: 'I will investigate manually and respond later.',
                    currentContext: 'Closing a turn where injected memory was surfaced but not used.',
                    entityHints: [ignoredMemoryEntity],
                    phase: 'post-response',
                },
            });
            expect(!ignoredPostAttend.isError, `Expected ignored-memory post-response attend ${turn + 1} to succeed.`);
            const ignoredPostPayload = JSON.stringify(ignoredPostAttend.structuredContent);
            if (turn === 0) {
                expect(
                    ignoredPostPayload.includes('"status":"degraded"'),
                    'Expected the first ignored-memory closeout to degrade compliance.',
                );
            } else {
                expect(
                    ignoredPostPayload.includes('"status":"non_compliant"'),
                    'Expected repeated ignored-memory closeouts to become non-compliant.',
                );
                expect(
                    ignoredPostPayload.includes('"code":"ignored_injected_memory"') && ignoredPostPayload.includes('"severity":"error"'),
                    'Expected repeated ignored-memory closeouts to include an error-level ignored_injected_memory issue.',
                );
            }
        }

        const ignoredMemoryNewTurn = await client.callTool({
            name: 'iranti_attend',
            arguments: {
                agent: ignoredMemoryAgentId,
                latestMessage: 'Start another turn after repeatedly ignoring injected memory.',
                currentContext: 'We are beginning another turn after repeated ignored injections.',
                entityHints: [ignoredMemoryEntity],
                maxFacts: 3,
                phase: 'pre-response',
            },
        });
        expect(!ignoredMemoryNewTurn.isError, 'Expected a new turn attend after repeated ignored injections to succeed.');

        const blockedIgnoredMemoryQuery = await client.callTool({
            name: 'iranti_query',
            arguments: {
                agent: ignoredMemoryAgentId,
                entity: ignoredMemoryEntity,
                key: 'next_step',
            },
        });
        expect(!blockedIgnoredMemoryQuery.isError, 'Expected repeated ignored-memory query to return a structured protocol violation.');
        expect(
            JSON.stringify(blockedIgnoredMemoryQuery.structuredContent).includes('"code":"memory_use_required"'),
            'Expected repeated ignored-memory query to be blocked with memory_use_required.',
        );

        const ignoredMemoryCheckpoint = await client.callTool({
            name: 'iranti_checkpoint',
            arguments: {
                agent: ignoredMemoryAgentId,
                task: 'Explain why injected memory was insufficient before rediscovery.',
                recentMessages: ['Injected memory was insufficient because the response needed a fresh external validation step.'],
                currentStep: 'documented why injected memory was insufficient',
                nextStep: 'perform a fresh validation after acknowledging the limitation',
                openRisks: ['Avoid redoing rediscovery without first recording why memory was insufficient.'],
                entityTargets: [ignoredMemoryEntity],
            },
        });
        expect(!ignoredMemoryCheckpoint.isError, 'Expected ignored-memory checkpoint to clear strict blocking.');

        const ignoredMemoryRecoveredAttend = await client.callTool({
            name: 'iranti_attend',
            arguments: {
                agent: ignoredMemoryAgentId,
                latestMessage: 'Start a compliant turn after checkpointing the limitation.',
                currentContext: 'We are resuming after acknowledging why injected memory was insufficient.',
                entityHints: [ignoredMemoryEntity],
                maxFacts: 3,
                phase: 'pre-response',
            },
        });
        expect(!ignoredMemoryRecoveredAttend.isError, 'Expected attend after ignored-memory checkpoint to succeed.');

        const ignoredMemoryRecoveredQuery = await client.callTool({
            name: 'iranti_query',
            arguments: {
                agent: ignoredMemoryAgentId,
                entity: ignoredMemoryEntity,
                key: 'next_step',
            },
        });
        expect(!ignoredMemoryRecoveredQuery.isError, 'Expected query after ignored-memory checkpoint to succeed.');
        // next_step is now a clean replace (no accumulation of prior steps).
        // The checkpoint wrote "perform a fresh validation after acknowledging the limitation" as the latest next_step.
        expect(
            JSON.stringify(ignoredMemoryRecoveredQuery.structuredContent).includes('perform a fresh validation after acknowledging the limitation'),
            'Expected recovery query after ignored-memory checkpoint to return the latest next step (clean replace).',
        );
    } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
    }

    console.log('MCP protocol enforcement regressions passed');
}

main().catch((error) => {
    console.error('MCP protocol enforcement regressions failed:', error);
    process.exit(1);
});
