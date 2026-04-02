import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapHarness, ensureHarnessStaffEventsTable } from '../../scripts/harness';

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
    bootstrapHarness({
        requireDb: true,
        forceLocalEscalationDir: true,
        dbApplicationName: 'iranti:test:mcp_protocol_enforcement',
    });
    await ensureHarnessStaffEventsTable();

    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        throw new Error('DATABASE_URL is required for MCP protocol enforcement regressions.');
    }

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
