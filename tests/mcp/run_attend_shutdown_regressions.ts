import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapHarness, ensureHarnessStaffEventsTable } from '../../scripts/harness';
import { Iranti } from '../../src/sdk';

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
        dbApplicationName: 'iranti:test:mcp_attend_shutdown_regressions',
    });
    await ensureHarnessStaffEventsTable();

    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        throw new Error('DATABASE_URL is required for MCP attend/shutdown regressions.');
    }

    const serverCwd = path.join(os.tmpdir(), 'iranti-mcp-attend-shutdown-regressions');
    fs.mkdirSync(serverCwd, { recursive: true });

    const serverEnv = {
        ...process.env,
        DATABASE_URL: connectionString,
        LLM_PROVIDER: process.env.LLM_PROVIDER || 'mock',
        IRANTI_AGENT_ID: 'main_agent',
        IRANTI_MCP_DEFAULT_AGENT: 'codex_code',
        IRANTI_MCP_DEFAULT_SOURCE: 'Codex',
        IRANTI_MCP_HOST: 'codex_cli',
        IRANTI_MEMORY_ENTITY: 'project/mcp_regression_project_memory',
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

    const stderrChunks: string[] = [];
    if (transport.stderr) {
        transport.stderr.on('data', (chunk: unknown) => {
            const text = String(chunk ?? '');
            if (text) stderrChunks.push(text);
        });
    }

    const client = new Client({
        name: 'iranti-mcp-attend-shutdown-regressions',
        version: '0.1.0',
    });

    const agentId = `mcp_regression_${Date.now()}`;
    const entity = `project/mcp_regression_${Date.now()}`;

    try {
        await client.connect(transport);

        const handshake = await client.callTool({
            name: 'iranti_handshake',
            arguments: {
                task: 'Validate MCP attend alias and graceful shutdown checkpoint preservation.',
                recentMessages: ['Start focused MCP attend/shutdown regression test.'],
                agent: agentId,
            },
        });
        expect(!handshake.isError, 'Expected focused MCP handshake to succeed.');

        const write = await client.callTool({
            name: 'iranti_write',
            arguments: {
                entity,
                key: 'status',
                valueJson: JSON.stringify({ phase: 'regression' }),
                summary: 'Focused MCP regression entity status is regression.',
                confidence: 92,
            },
        });
        expect(!write.isError, 'Expected focused MCP write to succeed.');

        const attendAlias = await client.callTool({
            name: 'iranti_attend',
            arguments: {
                agent: agentId,
                message: 'What is the focused MCP regression entity status?',
                currentContext: 'We are validating the message alias for iranti_attend.',
                entityHints: [entity],
                maxFacts: 3,
            },
        });
        expect(!attendAlias.isError, 'Expected iranti_attend to accept message as an alias.');
        expect(
            typeof attendAlias.structuredContent === 'object' && attendAlias.structuredContent !== null,
            'Expected iranti_attend alias call to return structured content.',
        );

        const checkpoint = await client.callTool({
            name: 'iranti_checkpoint',
            arguments: {
                agent: agentId,
                task: 'Validate MCP attend alias and graceful shutdown checkpoint preservation.',
                recentMessages: ['Persist richer checkpoint payload before focused MCP shutdown.'],
                currentStep: 'close the MCP client and verify the saved checkpoint',
                nextStep: 'inspect the interrupted checkpoint payload',
                recentOutputs: ['validated iranti_attend message alias'],
                actions: [
                    {
                        kind: 'validation',
                        summary: 'Called iranti_attend with message alias',
                        status: 'passed',
                        target: 'iranti_attend',
                    },
                ],
                fileChanges: [
                    {
                        action: 'updated',
                        path: 'scripts/iranti-mcp.ts',
                        purpose: 'attend alias and shutdown checkpointing',
                    },
                ],
            },
        });
        expect(!checkpoint.isError, 'Expected focused MCP checkpoint to succeed.');

        const child = (transport as unknown as { _process?: import('node:child_process').ChildProcess })._process;
        if (!child) {
            throw new Error('Expected focused MCP transport to spawn a child process.');
        }

        const exitPromise = Promise.race([
            new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
                child.once('close', (code, signal) => resolve({ code, signal }));
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);

        await client.close().catch(() => undefined);

        const exit = await exitPromise;
        if (exit === null) {
            child.kill('SIGKILL');
            throw new Error(`Expected focused MCP server to exit after client close. stderr: ${stderrChunks.join('').trim()}`);
        }

        expect(exit.signal === null, `Expected focused MCP server to exit normally, got signal ${exit.signal ?? 'null'}.`);
        expect((exit.code ?? 0) === 0, `Expected focused MCP server to exit 0, got ${exit.code ?? 'null'}. stderr: ${stderrChunks.join('').trim()}`);
        expect(
            !stderrChunks.join('').includes('UV_HANDLE_CLOSING'),
            `Expected focused MCP server shutdown to avoid UV_HANDLE_CLOSING assertion. stderr: ${stderrChunks.join('').trim()}`
        );

        const iranti = new Iranti({
            connectionString,
            llmProvider: process.env.LLM_PROVIDER || 'mock',
            sessionLedgerSource: 'test',
            sessionLedgerHost: 'mcp_regression',
            sessionLedgerAgentId: 'main_agent',
            dbApplicationName: 'iranti:test:mcp_attend_shutdown_regressions',
        });
        const session = await iranti.inspectSession({ agentId });
        expect(session.hasCheckpoint === true, 'Expected focused MCP agent to expose an active checkpoint after shutdown.');
        expect(
            session.sessionCheckpoint?.checkpoint.recentOutputs?.includes('validated iranti_attend message alias') === true,
            'Expected shutdown checkpoint to preserve recentOutputs.',
        );
        expect(
            session.sessionCheckpoint?.checkpoint.actions?.some((item) => item.summary === 'Called iranti_attend with message alias') === true,
            'Expected shutdown checkpoint to preserve actions.',
        );
        expect(
            session.sessionCheckpoint?.checkpoint.fileChanges?.some((item) => item.path === 'scripts/iranti-mcp.ts') === true,
            'Expected shutdown checkpoint to preserve fileChanges.',
        );
    } finally {
        await client.close().catch(() => undefined);
    }

    console.log('MCP attend/shutdown regressions passed');
}

main().catch((error) => {
    console.error('MCP attend/shutdown regressions failed:', error);
    process.exit(1);
});
