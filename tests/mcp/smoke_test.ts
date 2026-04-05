import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { spawn } from 'node:child_process';
import { bootstrapHarness, ensureHarnessStaffEventsTable } from '../../scripts/harness';
import { Iranti } from '../../src/sdk';
import { initDb, disconnectDb, getDb } from '../../src/library/client';
import { findEntry } from '../../src/library/queries';

const mcpSdkRoot = path.resolve(process.cwd(), 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client');
const { Client } = require(path.join(mcpSdkRoot, 'index.js'));
const { StdioClientTransport } = require(path.join(mcpSdkRoot, 'stdio.js'));

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function normalizeDescription(value: string | undefined): string {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

async function expectMcpWrapperToExitOnStdinClose(connectionString: string): Promise<void> {
    const cliPath = path.resolve(process.cwd(), 'dist', 'scripts', 'iranti-cli.js');
    const wrapperConnectionString = process.env.IRANTI_MCP_WRAPPER_TEST_DATABASE_URL?.trim() || connectionString;
    const wrapperCwd = path.join(os.tmpdir(), 'iranti-mcp-wrapper-smoke');
    fs.mkdirSync(wrapperCwd, { recursive: true });
    const childEnv = {
        ...process.env,
        DATABASE_URL: wrapperConnectionString,
        LLM_PROVIDER: process.env.LLM_PROVIDER || 'mock',
        IRANTI_AGENT_ID: 'main_agent',
        IRANTI_MCP_DEFAULT_AGENT: 'codex_code',
        IRANTI_MCP_DEFAULT_SOURCE: 'Codex',
        IRANTI_MCP_HOST: 'codex_cli',
        IRANTI_ESCALATION_DIR: process.env.IRANTI_ESCALATION_DIR || path.resolve(process.cwd(), 'tests', 'mcp', '.runtime', 'escalation'),
    } as Record<string, string>;
    delete childEnv.IRANTI_PROJECT_ENV;
    delete childEnv.IRANTI_INSTANCE_ENV;

    const child = spawn(process.execPath, [cliPath, 'mcp'], {
        cwd: wrapperCwd,
        env: childEnv,
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
    });

    const stderrChunks: string[] = [];
    child.stderr?.on('data', (chunk) => {
        const text = String(chunk ?? '');
        if (text) stderrChunks.push(text);
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    child.stdin?.end();

    const exit = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            child.once('close', (code, signal) => resolve({ code, signal }));
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);

    if (exit === null) {
        child.kill('SIGKILL');
        throw new Error(`Expected CLI MCP wrapper to exit after stdin closed. stderr: ${stderrChunks.join('').trim()}`);
    }

    expect(exit.signal === null, `Expected CLI MCP wrapper to exit normally after stdin closed, got signal ${exit.signal ?? 'null'}.`);
    expect((exit.code ?? 0) === 0, `Expected CLI MCP wrapper to exit 0 after stdin closed, got ${exit.code ?? 'null'}. stderr: ${stderrChunks.join('').trim()}`);
    expect(
        !stderrChunks.join('').includes('staff_events table is missing'),
        `Expected CLI MCP wrapper stderr to avoid staff_events-missing warnings. stderr: ${stderrChunks.join('').trim()}`
    );
}

async function expectDirectMcpServerToCloseWithoutShutdownAssertion(serverEnv: Record<string, string>): Promise<void> {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve(process.cwd(), 'dist', 'scripts', 'iranti-mcp.js')],
        cwd: path.join(os.tmpdir(), 'iranti-mcp-direct-shutdown-smoke'),
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
        name: 'iranti-mcp-direct-shutdown-smoke',
        version: '0.1.0',
    });

    try {
        await client.connect(transport);
        const child = (transport as unknown as { _process?: import('node:child_process').ChildProcess })._process;
        if (!child) {
            throw new Error('Expected direct MCP transport to spawn a child process for shutdown verification.');
        }

        const agentId = 'mcp_direct_shutdown_smoke';
        const handshake = await client.callTool({
            name: 'iranti_handshake',
            arguments: {
                task: 'Verify direct MCP shutdown behavior after a successful handshake.',
                recentMessages: ['Closing the direct MCP transport after this handshake.'],
                agent: agentId,
            },
        });
        expect(!handshake.isError, 'Expected direct MCP handshake to succeed before shutdown.');

        const checkpoint = await client.callTool({
            name: 'iranti_checkpoint',
            arguments: {
                agent: agentId,
                task: 'Verify direct MCP shutdown behavior after a successful handshake.',
                recentMessages: ['Persist richer checkpoint payload before MCP shutdown.'],
                currentStep: 'close the direct MCP transport cleanly',
                nextStep: 'inspect the saved shutdown checkpoint',
                recentOutputs: ['verified direct MCP handshake before shutdown'],
                actions: [
                    {
                        kind: 'validation',
                        summary: 'Ran direct MCP shutdown handshake',
                        status: 'passed',
                        target: 'iranti_handshake',
                    },
                ],
                fileChanges: [
                    {
                        action: 'updated',
                        path: 'tests/mcp/smoke_test.ts',
                        purpose: 'shutdown regression coverage',
                    },
                ],
            },
        });
        expect(!checkpoint.isError, 'Expected direct MCP checkpoint to succeed before shutdown.');

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
            throw new Error(`Expected direct MCP server to exit after client close. stderr: ${stderrChunks.join('').trim()}`);
        }

        expect(exit.signal === null, `Expected direct MCP server to exit normally, got signal ${exit.signal ?? 'null'}.`);
        expect((exit.code ?? 0) === 0, `Expected direct MCP server to exit 0, got ${exit.code ?? 'null'}. stderr: ${stderrChunks.join('').trim()}`);
        expect(
            !stderrChunks.join('').includes('UV_HANDLE_CLOSING'),
            `Expected direct MCP server shutdown to avoid UV_HANDLE_CLOSING assertion. stderr: ${stderrChunks.join('').trim()}`
        );
        expect(
            !stderrChunks.join('').includes('staff_events table is missing'),
            `Expected direct MCP server stderr to avoid staff_events-missing warnings. stderr: ${stderrChunks.join('').trim()}`
        );

        const iranti = new Iranti({
            connectionString: serverEnv.DATABASE_URL,
            llmProvider: serverEnv.LLM_PROVIDER || 'mock',
            sessionLedgerSource: 'test',
            sessionLedgerHost: 'mcp_smoke',
            sessionLedgerAgentId: 'main_agent',
        });
        const session = await iranti.inspectSession({ agentId });
        expect(session.hasCheckpoint === true, 'Expected shutdown smoke agent to expose an active checkpoint after MCP exit.');
        expect(
            session.sessionCheckpoint?.checkpoint.recentOutputs?.includes('verified direct MCP handshake before shutdown') === true,
            'Expected shutdown checkpoint to preserve recentOutputs on MCP exit.'
        );
        expect(
            session.sessionCheckpoint?.checkpoint.actions?.some((item) => item.summary === 'Ran direct MCP shutdown handshake') === true,
            'Expected shutdown checkpoint to preserve actions on MCP exit.'
        );
        expect(
            session.sessionCheckpoint?.checkpoint.fileChanges?.some((item) => item.path === 'tests/mcp/smoke_test.ts') === true,
            'Expected shutdown checkpoint to preserve fileChanges on MCP exit.'
        );
    } finally {
        await client.close().catch(() => undefined);
    }
}

async function expectApplicationName(applicationName: string): Promise<void> {
    const child = spawn(process.execPath, ['-e', `
        const path = require('node:path');
        const { Iranti } = require(${JSON.stringify(path.resolve(process.cwd(), 'dist', 'src', 'sdk'))});
        const { getDb, disconnectDb } = require(${JSON.stringify(path.resolve(process.cwd(), 'dist', 'src', 'library', 'client'))});
        async function main() {
            new Iranti({
                connectionString: process.env.DATABASE_URL,
                llmProvider: 'mock',
                sessionLedgerSource: 'mcp',
                sessionLedgerHost: 'codex_cli',
                sessionLedgerAgentId: 'main_agent',
            });
            await getDb().$queryRawUnsafe('SELECT now() FROM pg_sleep(3)');
            await disconnectDb();
        }
        main().catch((error) => { console.error(error); process.exit(1); });
    `], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            DATABASE_URL: process.env.DATABASE_URL ?? '',
            LLM_PROVIDER: process.env.LLM_PROVIDER || 'mock',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });

    const stderrChunks: string[] = [];
    child.stderr?.on('data', (chunk) => {
        const text = String(chunk ?? '');
        if (text) stderrChunks.push(text);
    });

    const deadline = Date.now() + 5000;
    let found = false;

    while (Date.now() < deadline) {
        const rows = await getDb().$queryRawUnsafe<Array<{ count: bigint | number }>>(
            `SELECT COUNT(*)::bigint AS count
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND application_name = $1
               AND pid <> pg_backend_pid()`,
            applicationName,
        );
        const count = Number(rows[0]?.count ?? 0);
        if (count >= 1) {
            found = true;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }));
    });

    expect(exit.signal === null, `Expected DB attribution probe to exit normally, got signal ${exit.signal ?? 'null'}.`);
    expect((exit.code ?? 0) === 0, `Expected DB attribution probe to exit 0, got ${exit.code ?? 'null'}. stderr: ${stderrChunks.join('').trim()}`);
    expect(found, `Expected at least one active DB connection with application_name "${applicationName}".`);
}

async function main(): Promise<void> {
    process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'mock';
    bootstrapHarness({
        requireDb: true,
        forceLocalEscalationDir: true,
        dbApplicationName: 'iranti:test:mcp_smoke',
    });
    await ensureHarnessStaffEventsTable();

    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        throw new Error('DATABASE_URL is required for MCP smoke test.');
    }

    const serverCwd = path.join(os.tmpdir(), 'iranti-mcp-smoke-server');
    fs.mkdirSync(serverCwd, { recursive: true });
    fs.mkdirSync(path.join(os.tmpdir(), 'iranti-mcp-direct-shutdown-smoke'), { recursive: true });
    const serverEnv = {
        ...process.env,
        DATABASE_URL: connectionString,
        LLM_PROVIDER: process.env.LLM_PROVIDER || 'mock',
        IRANTI_AGENT_ID: 'main_agent',
        IRANTI_MCP_DEFAULT_AGENT: 'codex_code',
        IRANTI_MCP_DEFAULT_SOURCE: 'Codex',
        IRANTI_MCP_HOST: 'codex_cli',
        IRANTI_MEMORY_ENTITY: 'project/mcp_smoke_project_memory',
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

        const allTools: Array<{ name: string; description?: string }> = [];
        let cursor: string | undefined;
        do {
            const page = await client.listTools(cursor ? { cursor } : undefined);
            allTools.push(...page.tools);
            cursor = page.nextCursor;
        } while (cursor);

        const tools = { tools: allTools };
        const toolNames = tools.tools.map((tool: { name: string }) => tool.name);
        for (const required of ['iranti_handshake', 'iranti_attend', 'iranti_checkpoint', 'iranti_query', 'iranti_history', 'iranti_search', 'iranti_write', 'iranti_write_issue', 'iranti_remember_response', 'iranti_related', 'iranti_related_deep']) {
            expect(toolNames.includes(required), `Expected MCP tool ${required} to be listed.`);
        }

        const expectedDescriptions: Record<string, string> = {
            iranti_write: `Write one durable fact to shared memory for a specific entity.
TIMING: Call IMMEDIATELY when a fact is confirmed — do not batch or defer to end of turn.
One call per finding. If you edited a file, write before the next action. If you ran a command and got a result, write before the next action. If you got a search result, write before moving on.
Use this when you learned something concrete that future turns,
agents, or sessions should retain. Requires: entity ("type/id"),
key, value JSON, and summary. Confidence is optional and defaults
to 85. Conflicts on the same entity+key are detected automatically
and may be resolved or escalated. Personal-memory keys honor the
configured canonical personal entity for this project/session.
Use properties JSON when you need structured issue or workflow metadata
such as issueStatus=open|resolved, severity, or resolution notes.`,
            iranti_write_issue: `Write a canonical open or resolved issue fact on a stable key.
Use this when you want defects, bugs, or chores to remain first-class shared
memory instead of loose prose. The same issueId always maps to the same
issue_<id> key, so changing status from open to resolved archives the prior
state automatically while preserving history. Prefer this over hand-rolling
issueStatus properties through iranti_write when the fact is specifically a
trackable issue lifecycle entry.`,
            iranti_remember_response: `Persist a strict durable summary from your own response.
Use this after you decide to say something like "the next step is ...",
"the blocker is ...", "we decided ...", or "the current owner is ...".
This uses the same narrow summary extractor as the Claude Stop hook,
but it is explicit and works for Codex or any MCP client. Do not use
this for arbitrary prose or every turn.`,
            iranti_query: `Retrieve the current fact for an exact entity+key lookup.
REQUIRED: call iranti_attend before this discovery tool so Iranti can decide
whether memory should be injected before exact lookup.
Use this when you already know both the entity and the key.
Returns the current value, summary, confidence, source, and
temporal metadata when available. Prefer this over iranti_search
when the target fact is already known, and do not answer from
memory alone before checking Iranti.`,
            iranti_history: `Retrieve the full version history of a fact for an exact entity+key pair.
Returns all archived past values plus the current value, ordered oldest-first.
Each entry includes value, summary, confidence, source, validFrom, validUntil,
isCurrent, archivedReason, and resolutionState.
REQUIRED: call iranti_attend before this discovery tool so Iranti can decide
whether memory should be injected first.
Use this to understand how a fact evolved over time — decisions that changed,
blockers that were resolved, values that were contested or superseded.`,
            iranti_search: `Search shared memory with natural language when the exact entity
or key is unknown. Uses hybrid lexical and vector search across
stored facts. Use this for discovery and recall, not exact lookup.
REQUIRED: call iranti_attend before this discovery tool so Iranti can decide
whether memory should be injected before search.
If the user asks what they previously told you and you do not know
the exact key, use this before saying you do not know.`,
            iranti_attend: `Ask Iranti whether memory should be injected before the next LLM turn.
REQUIRED CALL SEQUENCE — follow this every turn, regardless of host:
1. Call with phase='pre-response' BEFORE replying to the user.
2. Call BEFORE any lookup tool (Read, Grep, Glob, Bash, WebSearch, WebFetch) where Iranti might already hold the answer.
3. If you just ran Edit/Write/Bash/WebSearch/WebFetch since your last iranti_write, call iranti_write FIRST — then attend.
4. Call with phase='post-response' AFTER every reply, without exception.

If the user is asking you to recall a remembered fact (preference, decision, blocker, next step, prior project detail), use this before answering instead of guessing or saying you do not know. Returns an injection decision plus any facts that should be added to context if relevant memory is missing. If no handshake has been performed yet for this agent in the current process, attend will auto-bootstrap the session first and report that in the result metadata.
This is the minimum safe pre-reply call even when the host skipped handshake.
Omitting currentContext falls back to the latest message only; pass the
full visible context when available. For host compatibility, message is
accepted as an alias for latestMessage. When phase='post-response', pass the
assistant response so Iranti can persist strict continuity facts and shared
checkpoint state before closing the turn.`,
            iranti_checkpoint: `Persist a shared progress checkpoint while you work.
Use this at meaningful milestones so current step, next step, open risks,
recent outputs, structured actions, and shared entity state survive across turns,
sessions, and agents. This is the strongest shared-RAM tool for active work:
prefer it over ad-hoc prose when you need another session or another agent
to pick up where you left off. If entityTargets are supplied, Iranti also
writes canonical shared state such as current_step, next_step,
open_risks, recent_actions, and recent_file_changes to those entities for handoff.`,
            iranti_handshake: `Initialize or refresh an agent's working-memory brief for the current task.
Call this at session start or when a new task begins, passing the task and
recent messages. Returns operating rules plus prioritized relevant memory
for that task. If the recent messages appear to contain durable facts that
are not yet in shared memory, the result may include a backfill suggestion.
If your host does not support a true session-start hook, call this on the
first user turn before you start answering recall-style questions.
Do not use this as a per-turn retrieval tool; use iranti_attend.`,
            iranti_related: `Read directly related entities (1 hop) for a given entity.
REQUIRED: call iranti_attend before this discovery tool so Iranti can decide
whether memory should be injected before graph traversal.`,
            iranti_related_deep: `Read related entities up to N hops deep for a given entity.
REQUIRED: call iranti_attend before this discovery tool so Iranti can decide
whether memory should be injected before graph traversal.`,
        };

        for (const tool of tools.tools as Array<{ name: string; description?: string }>) {
            if (expectedDescriptions[tool.name]) {
                expect(
                    normalizeDescription(tool.description) === normalizeDescription(expectedDescriptions[tool.name]),
                    `Description mismatch for ${tool.name}.`
                );
            }
        }

        const entity = `project/mcp_smoke_${Date.now()}`;
        const relatedEntity = `team/mcp_smoke_team_${Date.now()}`;

        const projectPolicyWrite = await client.callTool({
            name: 'iranti_write',
            arguments: {
                entity: 'project/mcp_smoke_project_memory',
                key: 'agent_worktree_cleanup_rule',
                valueJson: JSON.stringify({ rule: 'Leave a clean worktree or emit an explicit residue report before ending the run.' }),
                summary: 'Leave a clean worktree or emit an explicit residue report before ending the run.',
                confidence: 95,
            },
        });
        expect(!projectPolicyWrite.isError, 'Expected project policy seed write to succeed before MCP handshake.');

        const handshake = await client.callTool({
            name: 'iranti_handshake',
            arguments: {
                task: 'Validate MCP smoke test setup.',
                recentMessages: ['Starting MCP smoke test.'],
            },
        });
        expect(!handshake.isError, 'Expected iranti_handshake to succeed.');
        const handshakePayload = JSON.stringify(handshake.structuredContent);
        expect(
            handshakePayload.includes('"projectPolicies"') && handshakePayload.includes('agent_worktree_cleanup_rule'),
            'Expected MCP smoke handshake to surface project-scoped policies.',
        );
        expect(
            handshakePayload.includes('Leave a clean worktree or emit an explicit residue report before ending the run.'),
            'Expected MCP smoke handshake to append the project-scoped policy into operating rules.',
        );
        await expectApplicationName('iranti:mcp:codex_cli');

        const claudeHandshake = await client.callTool({
            name: 'iranti_handshake',
            arguments: {
                task: 'Validate Claude host override when Codex env leaks into MCP startup.',
                recentMessages: ['Starting Claude host override smoke test.'],
                host: 'claude_code',
            },
        });
        expect(!claudeHandshake.isError, 'Expected Claude host override handshake to succeed.');
        expect(
            JSON.stringify(claudeHandshake.structuredContent).includes('"agentId":"main_agent"'),
            'Expected Claude host override handshake to resolve agentId main_agent even when Codex default env is present.',
        );

        const checkpoint = await client.callTool({
            name: 'iranti_checkpoint',
            arguments: {
                task: 'Validate MCP smoke test setup.',
                recentMessages: ['Checkpointing shared progress for MCP smoke test.'],
                currentStep: 'validate the MCP tool surface',
                nextStep: 'rerun the smoke query assertions',
                openRisks: ['tool registration drift'],
                recentOutputs: ['verified handshake and write tools'],
                actions: [
                    {
                        kind: 'validation',
                        summary: 'Ran MCP handshake smoke',
                        status: 'passed',
                        target: 'iranti_handshake',
                    },
                ],
                entityTargets: ['project/mcp_smoke_project_memory'],
            },
        });
        expect(!checkpoint.isError, 'Expected iranti_checkpoint to succeed.');

        const actionFact = await findEntry({
            entityType: 'project',
            entityId: 'mcp_smoke_project_memory',
            key: 'recent_actions',
        });
        expect(Boolean(actionFact), 'Expected iranti_checkpoint actions to persist a raw recent_actions entry.');
        expect(
            JSON.stringify(actionFact?.valueRaw).includes('Ran MCP handshake smoke'),
            'Expected iranti_checkpoint actions to preserve structured action breadcrumbs.'
        );

        const write = await client.callTool({
            name: 'iranti_write',
            arguments: {
                entity,
                key: 'status',
                valueJson: JSON.stringify({ phase: 'smoke_test' }),
                summary: `Smoke test project ${entity} status is smoke_test.`,
                confidence: 88,
                propertiesJson: JSON.stringify({
                    issueStatus: 'open',
                    issueType: 'smoke_test',
                }),
            },
        });
        expect(!write.isError, 'Expected iranti_write to succeed.');

        const writeEntry = await findEntry({
            entityType: 'project',
            entityId: entity.split('/')[1]!,
            key: 'status',
        });
        expect(Boolean(writeEntry), 'Expected iranti_write to persist a raw entry for the MCP smoke entity.');
        const writeProperties = writeEntry?.properties as Record<string, unknown>;
        expect(writeProperties.issueStatus === 'open', 'Expected iranti_write propertiesJson to persist issueStatus metadata.');
        expect(writeProperties.issueType === 'smoke_test', 'Expected iranti_write propertiesJson to persist issueType metadata.');

        const freshAgentQuery = await client.callTool({
            name: 'iranti_query',
            arguments: {
                agent: `mcp_smoke_fresh_agent_${Date.now()}`,
                entity,
                key: 'status',
            },
        });
        expect(!freshAgentQuery.isError, 'Expected iranti_query for a fresh agent to return a structured protocol violation.');
        expect(
            JSON.stringify(freshAgentQuery.structuredContent).includes('"code":"handshake_required"'),
            'Expected iranti_query without handshake to be blocked with handshake_required.'
        );

        const issueWrite = await client.callTool({
            name: 'iranti_write_issue',
            arguments: {
                entity,
                issueId: 'mcp_issue_lifecycle',
                title: 'MCP issue lifecycle missing',
                status: 'open',
                summary: 'MCP issue lifecycle is open.',
                confidence: 80,
                severity: 'high',
                detailsJson: JSON.stringify({ source: 'mcp_smoke' }),
                tags: ['mcp', 'issue-lifecycle'],
            },
        });
        expect(!issueWrite.isError, 'Expected iranti_write_issue open write to succeed.');

        const issueResolve = await client.callTool({
            name: 'iranti_write_issue',
            arguments: {
                entity,
                issueId: 'mcp_issue_lifecycle',
                title: 'MCP issue lifecycle missing',
                status: 'resolved',
                summary: 'MCP issue lifecycle is resolved.',
                confidence: 95,
                severity: 'high',
                resolution: 'Added iranti_write_issue to the MCP tool surface.',
                resolvedAt: new Date().toISOString(),
                tags: ['mcp', 'issue-lifecycle'],
            },
        });
        expect(!issueResolve.isError, 'Expected iranti_write_issue resolved write to succeed.');

        const issueEntry = await findEntry({
            entityType: 'project',
            entityId: entity.split('/')[1]!,
            key: 'issue_mcp_issue_lifecycle',
        });
        expect(Boolean(issueEntry), 'Expected iranti_write_issue to persist the stable issue key.');
        const issueProperties = issueEntry?.properties as Record<string, unknown>;
        expect(issueProperties.issueStatus === 'resolved', 'Expected iranti_write_issue to update the stable issue fact to resolved.');
        expect(issueProperties.durableClass === 'issue_status', 'Expected iranti_write_issue to persist canonical issue metadata.');

        const personalKey = `favorite_mcp_smoke_${Date.now()}`;

        const personalWrite = await client.callTool({
            name: 'iranti_write',
            arguments: {
                entity: 'user/nf',
                key: personalKey,
                valueJson: JSON.stringify({ text: 'The Bible' }),
                summary: `${personalKey.replace(/_/g, ' ')} is The Bible`,
                confidence: 95,
            },
        });
        expect(!personalWrite.isError, 'Expected personal iranti_write to succeed.');
        expect(
            JSON.stringify(personalWrite.structuredContent).includes('"resolvedEntity":"user/main"'),
            'Expected personal iranti_write to resolve to the configured canonical personal entity.',
        );

        const personalQuery = await client.callTool({
            name: 'iranti_query',
            arguments: {
                entity: 'user/main',
                key: personalKey,
            },
        });
        expect(!personalQuery.isError, 'Expected iranti_query for personal canonical entity to succeed.');
        expect(
            JSON.stringify(personalQuery.structuredContent).includes('protocolViolation'),
            'Expected iranti_query before attend to be blocked with a protocol violation.',
        );

        const relate = await client.callTool({
            name: 'iranti_relate',
            arguments: {
                fromEntity: entity,
                relationshipType: 'MEMBER_OF',
                toEntity: relatedEntity,
            },
        });
        expect(!relate.isError, 'Expected iranti_relate to succeed.');

        const query = await client.callTool({
            name: 'iranti_query',
            arguments: {
                entity,
                key: 'status',
            },
        });
        expect(!query.isError, 'Expected iranti_query to succeed.');
        expect(
            JSON.stringify(query.structuredContent).includes('protocolViolation'),
            'Expected iranti_query before attend to be blocked with a protocol violation.'
        );

        const search = await client.callTool({
            name: 'iranti_search',
            arguments: {
                query: `${entity} smoke_test`,
                limit: 5,
            },
        });
        expect(!search.isError, 'Expected iranti_search to succeed.');
        expect(
            JSON.stringify(search.structuredContent).includes('protocolViolation'),
            'Expected iranti_search before attend to be blocked with a protocol violation.'
        );

        const historyBeforeAttend = await client.callTool({
            name: 'iranti_history',
            arguments: {
                entity,
                key: 'issue_mcp_issue_lifecycle',
            },
        });
        expect(!historyBeforeAttend.isError, 'Expected iranti_history to return a structured protocol violation before attend.');
        expect(
            JSON.stringify(historyBeforeAttend.structuredContent).includes('protocolViolation'),
            'Expected iranti_history before attend to be blocked with a protocol violation.'
        );

        const rememberResponse = await client.callTool({
            name: 'iranti_remember_response',
            arguments: {
                response: 'The next step is rerun the db validation.',
                projectEntity: 'project/mcp_smoke_project_memory',
            },
        });
        expect(!rememberResponse.isError, 'Expected iranti_remember_response to succeed.');

        const rememberedNextStep = await client.callTool({
            name: 'iranti_query',
            arguments: {
                entity: 'project/mcp_smoke_project_memory',
                key: 'next_step',
            },
        });
        expect(!rememberedNextStep.isError, 'Expected iranti_query for remembered next_step to succeed.');
        expect(
            JSON.stringify(rememberedNextStep.structuredContent).includes('protocolViolation'),
            'Expected exact query before attend to be blocked with a protocol violation.'
        );

        const rememberedCurrentStep = await client.callTool({
            name: 'iranti_remember_response',
            arguments: {
                response: 'The current step is audit the retrieval lifecycle.',
                projectEntity: 'project/mcp_smoke_project_memory',
            },
        });
        expect(!rememberedCurrentStep.isError, 'Expected iranti_remember_response current_step write to succeed.');

        const currentStepQuery = await client.callTool({
            name: 'iranti_query',
            arguments: {
                entity: 'project/mcp_smoke_project_memory',
                key: 'current_step',
            },
        });
        expect(!currentStepQuery.isError, 'Expected iranti_query for remembered current_step to succeed.');
        expect(
            JSON.stringify(currentStepQuery.structuredContent).includes('protocolViolation'),
            'Expected exact query before attend to be blocked with a protocol violation.'
        );

        const rememberedOpenRisks = await client.callTool({
            name: 'iranti_remember_response',
            arguments: {
                response: 'Open risks are stale runtime metadata and duplicate instance state.',
                projectEntity: 'project/mcp_smoke_project_memory',
            },
        });
        expect(!rememberedOpenRisks.isError, 'Expected iranti_remember_response open_risks write to succeed.');

        const openRisksQuery = await client.callTool({
            name: 'iranti_query',
            arguments: {
                entity: 'project/mcp_smoke_project_memory',
                key: 'open_risks',
            },
        });
        expect(!openRisksQuery.isError, 'Expected iranti_query for remembered open_risks to succeed.');
        expect(
            JSON.stringify(openRisksQuery.structuredContent).includes('protocolViolation'),
            'Expected exact query before attend to be blocked with a protocol violation.'
        );

        const checkpointStepQuery = await client.callTool({
            name: 'iranti_query',
            arguments: {
                entity: 'project/mcp_smoke_project_memory',
                key: 'current_step',
            },
        });
        expect(!checkpointStepQuery.isError, 'Expected current_step query to succeed.');
        expect(
            JSON.stringify(checkpointStepQuery.structuredContent).includes('protocolViolation'),
            'Expected exact query before attend to be blocked with a protocol violation.'
        );

        const related = await client.callTool({
            name: 'iranti_related',
            arguments: {
                entity,
            },
        });
        expect(!related.isError, 'Expected iranti_related to succeed.');
        expect(
            JSON.stringify(related.structuredContent).includes('protocolViolation'),
            'Expected iranti_related before attend to be blocked with a protocol violation.'
        );

        const relatedDeep = await client.callTool({
            name: 'iranti_related_deep',
            arguments: {
                entity,
                depth: 2,
            },
        });
        expect(!relatedDeep.isError, 'Expected iranti_related_deep to succeed.');
        expect(
            JSON.stringify(relatedDeep.structuredContent).includes('protocolViolation'),
            'Expected iranti_related_deep before attend to be blocked with a protocol violation.'
        );

        const attend = await client.callTool({
            name: 'iranti_attend',
            arguments: {
                latestMessage: 'What is the smoke test project status?',
                currentContext: 'We are validating MCP memory recall.',
                entityHints: [entity],
                maxFacts: 3,
                phase: 'pre-response',
            },
        });
        expect(!attend.isError, 'Expected iranti_attend to succeed.');
        expect(
            typeof attend.structuredContent === 'object' && attend.structuredContent !== null,
            'Expected iranti_attend to return structured content.'
        );
        expect(
            JSON.stringify(attend.structuredContent).includes('"factId":"F1"'),
            'Expected iranti_attend to tag injected facts with stable fact IDs.'
        );
        expect(
            JSON.stringify(attend.structuredContent).includes('[Iranti Retrieved Memory]'),
            'Expected iranti_attend to include a structured injection block for first-party hosts.'
        );

        const attendAlias = await client.callTool({
            name: 'iranti_attend',
            arguments: {
                message: 'What is the smoke test project status when the host sends message instead?',
                currentContext: 'We are validating MCP message alias handling.',
                entityHints: [entity],
                maxFacts: 3,
                phase: 'mid-turn',
            },
        });
        expect(!attendAlias.isError, 'Expected iranti_attend to accept message as an alias for latestMessage.');
        expect(
            typeof attendAlias.structuredContent === 'object' && attendAlias.structuredContent !== null,
            'Expected iranti_attend alias call to return structured content.'
        );

        const historyAfterAttend = await client.callTool({
            name: 'iranti_history',
            arguments: {
                entity,
                key: 'issue_mcp_issue_lifecycle',
            },
        });
        expect(!historyAfterAttend.isError, 'Expected iranti_history after attend to succeed.');
        const historyPayload = JSON.stringify(historyAfterAttend.structuredContent);
        expect(
            historyPayload.includes('\"status\":\"open\"') && historyPayload.includes('\"status\":\"resolved\"'),
            'Expected iranti_history after attend to return both open and resolved issue states.'
        );

        const refreshAttendForQuery = await client.callTool({
            name: 'iranti_attend',
            arguments: {
                latestMessage: 'What is the smoke test project status after checking issue history?',
                currentContext: 'We already read the issue lifecycle history and need a fresh discovery window for exact lookup.',
                entityHints: [entity],
                maxFacts: 3,
                phase: 'mid-turn',
            },
        });
        expect(!refreshAttendForQuery.isError, 'Expected a fresh iranti_attend before querying after history.');
        expect(
            !JSON.stringify(refreshAttendForQuery.structuredContent).includes('"code":"post_response_required"'),
            'Expected the refresh attend to reopen the discovery budget within the active turn, not request a new pre-response cycle.'
        );

        const queryAfterAttend = await client.callTool({
            name: 'iranti_query',
            arguments: {
                entity,
                key: 'status',
            },
        });
        expect(!queryAfterAttend.isError, 'Expected iranti_query after attend to succeed.');
        expect(
            JSON.stringify(queryAfterAttend.structuredContent).includes('smoke_test'),
            'Expected iranti_query after attend to return the written fact.'
        );

        const searchAfterConsumedAttend = await client.callTool({
            name: 'iranti_search',
            arguments: {
                query: `${entity} smoke_test`,
                limit: 5,
            },
        });
        expect(!searchAfterConsumedAttend.isError, 'Expected iranti_search after the attend-backed query to return a structured protocol violation.');
        expect(
            JSON.stringify(searchAfterConsumedAttend.structuredContent).includes('"code":"attend_required"'),
            'Expected discovery budget to be consumed after one read, requiring a fresh iranti_attend.'
        );

        const postResponseAttend = await client.callTool({
            name: 'iranti_attend',
            arguments: {
                latestMessage: 'File created docs/mcp-followup.md for host contract notes.',
                currentContext: 'We just finished the smoke-test response and are closing the turn.',
                phase: 'post-response',
            },
        });
        expect(!postResponseAttend.isError, 'Expected phase=post-response attend to succeed.');
        const autoFileChange = await findEntry({
            entityType: 'project',
            entityId: 'mcp_smoke_project_memory',
            key: 'recent_file_changes',
        });
        expect(Boolean(autoFileChange), 'Expected post-response attend to auto-persist assistant response file changes.');
        expect(
            JSON.stringify(autoFileChange?.valueRaw).includes('docs/mcp-followup.md'),
            'Expected post-response attend to checkpoint the assistant response continuity breadcrumbs.'
        );

        await expectMcpWrapperToExitOnStdinClose(connectionString);
        await expectDirectMcpServerToCloseWithoutShutdownAssertion(serverEnv);

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

