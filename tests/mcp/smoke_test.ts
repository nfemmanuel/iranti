import 'dotenv/config';
import path from 'path';
import { bootstrapHarness } from '../../scripts/harness';
import { initDb, disconnectDb } from '../../src/library/client';

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
    bootstrapHarness({ requireDb: true, forceLocalEscalationDir: true });

    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        throw new Error('DATABASE_URL is required for MCP smoke test.');
    }

    initDb(connectionString);

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve(process.cwd(), 'dist', 'scripts', 'iranti-mcp.js')],
        cwd: process.cwd(),
        env: {
            ...process.env,
            DATABASE_URL: connectionString,
            LLM_PROVIDER: process.env.LLM_PROVIDER || 'mock',
            IRANTI_MCP_DEFAULT_AGENT: 'mcp_smoke_agent',
            IRANTI_MCP_DEFAULT_SOURCE: 'MCPSmoke',
            IRANTI_ESCALATION_DIR: process.env.IRANTI_ESCALATION_DIR || path.resolve(process.cwd(), 'tests', 'mcp', '.runtime', 'escalation'),
        } as Record<string, string>,
        stderr: 'pipe',
    });

    if (transport.stderr) {
        transport.stderr.on('data', (chunk: unknown) => {
            const text = String(chunk ?? '').trim();
            if (text) {
                process.stderr.write(`[mcp-smoke][server] ${text}\n`);
            }
        });
    }

    const client = new Client({
        name: 'iranti-mcp-smoke',
        version: '0.1.0',
    });

    try {
        await client.connect(transport);

        const tools = await client.listTools();
        const toolNames = tools.tools.map((tool: { name: string }) => tool.name);
        for (const required of ['iranti_handshake', 'iranti_attend', 'iranti_query', 'iranti_search', 'iranti_write']) {
            expect(toolNames.includes(required), `Expected MCP tool ${required} to be listed.`);
        }

        const expectedDescriptions: Record<string, string> = {
            iranti_write: `Write one durable fact to shared memory for a specific entity.
Use this when you learned something concrete that future turns,
agents, or sessions should retain. Requires: entity ("type/id"),
key, value JSON, and summary. Confidence is optional and defaults
to 85. Conflicts on the same entity+key are detected automatically
and may be resolved or escalated.`,
            iranti_query: `Retrieve the current fact for an exact entity+key lookup.
Use this when you already know both the entity and the key.
Returns the current value, summary, confidence, source, and
temporal metadata when available. Prefer this over iranti_search
when the target fact is already known.`,
            iranti_search: `Search shared memory with natural language when the exact entity
or key is unknown. Uses hybrid lexical and vector search across
stored facts. Use this for discovery and recall, not exact lookup.`,
            iranti_attend: `Ask Iranti whether memory should be injected before the next LLM turn.
Call this before each turn, passing the latest message and the current
visible context window. Returns an injection decision plus any facts
that should be added to context if relevant memory is missing.
Omitting currentContext falls back to latestMessage only — pass the
full visible context when available.`,
            iranti_handshake: `Initialize or refresh an agent's working-memory brief for the current task.
Call this at session start or when a new task begins, passing the task and
recent messages. Returns operating rules plus prioritized relevant memory
for that task. Do not use this as a per-turn retrieval tool; use iranti_attend.`,
        };

        for (const tool of tools.tools as Array<{ name: string; description?: string }>) {
            if (expectedDescriptions[tool.name]) {
                expect(
                    tool.description === expectedDescriptions[tool.name],
                    `Description mismatch for ${tool.name}.`
                );
            }
        }

        const entity = `project/mcp_smoke_${Date.now()}`;

        const handshake = await client.callTool({
            name: 'iranti_handshake',
            arguments: {
                task: 'Validate MCP smoke test setup.',
                recentMessages: ['Starting MCP smoke test.'],
            },
        });
        expect(!handshake.isError, 'Expected iranti_handshake to succeed.');

        const write = await client.callTool({
            name: 'iranti_write',
            arguments: {
                entity,
                key: 'status',
                valueJson: JSON.stringify({ phase: 'smoke_test' }),
                summary: 'Smoke test project status is smoke_test.',
                confidence: 88,
            },
        });
        expect(!write.isError, 'Expected iranti_write to succeed.');

        const query = await client.callTool({
            name: 'iranti_query',
            arguments: {
                entity,
                key: 'status',
            },
        });
        expect(!query.isError, 'Expected iranti_query to succeed.');
        expect(
            JSON.stringify(query.structuredContent).includes('smoke_test'),
            'Expected iranti_query to return the written fact.'
        );

        const search = await client.callTool({
            name: 'iranti_search',
            arguments: {
                query: 'smoke test project status',
                limit: 5,
            },
        });
        expect(!search.isError, 'Expected iranti_search to succeed.');
        expect(
            JSON.stringify(search.structuredContent).includes(entity),
            'Expected iranti_search to surface the written entity.'
        );

        const attend = await client.callTool({
            name: 'iranti_attend',
            arguments: {
                latestMessage: 'What is the smoke test project status?',
                currentContext: 'We are validating MCP memory recall.',
                entityHints: [entity],
                maxFacts: 3,
            },
        });
        expect(!attend.isError, 'Expected iranti_attend to succeed.');
        expect(
            typeof attend.structuredContent === 'object' && attend.structuredContent !== null,
            'Expected iranti_attend to return structured content.'
        );

        console.log('MCP smoke test passed.');
    } finally {
        await transport.close().catch(() => undefined);
        await disconnectDb().catch(() => undefined);
    }
}

main().catch((error) => {
    console.error('MCP smoke test failed:', error);
    process.exit(1);
});
