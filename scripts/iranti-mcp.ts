import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import type { Iranti } from '../src/sdk';
import { ProtocolViolationError } from '../src/sdk';
import { rewriteCommandError } from '../src/lib/commandErrors';
import { createFirstPartyIranti } from '../src/lib/createFirstPartyIranti';
import { loadRuntimeEnv } from '../src/lib/runtimeEnv';
import { autoRememberPromptFacts, isAutoRememberEnabled, rememberAssistantResponseFacts, resolvePersonalWriteTarget } from '../src/lib/autoRemember';
import { flushStaffEventEmitter, getStaffEventEmitter } from '../src/lib/staffEventRegistry';
import { disconnectDb } from '../src/library/client';
import { activeAttendants, clearAttendant, getAttendant } from '../src/attendant';
import { extractAssistantCheckpointPayload } from '../src/lib/assistantCheckpoint';
import { formatStructuredFactBlock } from '../src/lib/hostMemoryFormatting';

type JsonRecord = Record<string, unknown>;

loadRuntimeEnv();
let runtimeHostOverride: string | null = null;
let shutdownPromise: Promise<void> | null = null;
let processIranti: Iranti | null = null;

const HOST_SETUP_CHECKS: Record<string, { file: string; command: string }> = {
    claude_code: { file: 'CLAUDE.md', command: 'iranti claude-setup .' },
    codex: { file: 'AGENTS.md', command: 'iranti codex-setup' },
    codex_cli: { file: 'AGENTS.md', command: 'iranti codex-setup' },
    codex_vscode: { file: 'AGENTS.md', command: 'iranti codex-setup' },
};

function checkHostSetup(host: string | undefined, cwd: string): string[] {
    if (!host) return [];
    const check = HOST_SETUP_CHECKS[host];
    if (!check) return [];
    const filePath = path.join(cwd, check.file);
    if (!fs.existsSync(filePath)) {
        return [`⚠ ${check.file} not found in ${cwd}. Run \`${check.command}\` to complete host setup for this project. Until then, operating rules will not be enforced across sessions.`];
    }
    return [];
}

function printHelp(): void {
    console.log([
        'Iranti MCP Server',
        '',
        'Usage:',
        '  ts-node scripts/iranti-mcp.ts',
        '  node dist/scripts/iranti-mcp.js',
        '',
        'Environment:',
        '  DATABASE_URL                  PostgreSQL connection string (required)',
        '  LLM_PROVIDER                  Optional Iranti provider override',
        '  IRANTI_PROJECT_ENV            Optional project binding path (.env.iranti)',
        '  IRANTI_INSTANCE_ENV           Optional instance env path',
        '  IRANTI_MCP_DEFAULT_AGENT      Default agent id (default: claude_code)',
        '  IRANTI_MCP_AGENT_NAME         Default agent display name',
        '  IRANTI_MCP_AGENT_DESCRIPTION  Default agent description',
        '  IRANTI_MCP_AGENT_MODEL        Default agent model label',
        '  IRANTI_MCP_DEFAULT_SOURCE     Default write source (default: ClaudeCode)',
        '  IRANTI_MCP_HOST               Host label for session ledger events (default: generic_mcp)',
        '  IRANTI_AUTO_REMEMBER         Opt-in prompt-side auto-save before pre-response attend()',
        '',
        'This server is intended for Claude Code and other MCP clients over stdio.',
        'If you run `iranti mcp` directly in a terminal, it will stay running and wait for an MCP client.',
    ].join('\n'));
}

function requireConnectionString(): string {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        throw new Error('DATABASE_URL is required for iranti-mcp.');
    }
    return connectionString;
}

function currentHost(host?: string): string | undefined {
    return host?.trim()
        || runtimeHostOverride?.trim()
        || process.env.IRANTI_MCP_HOST?.trim();
}

function defaultAgentId(host?: string): string {
    const resolvedHost = currentHost(host);
    if (resolvedHost === 'claude_code') {
        return process.env.IRANTI_CLAUDE_AGENT_ID?.trim()
            || process.env.IRANTI_AGENT_ID?.trim()
            || 'claude_code';
    }
    const explicit = process.env.IRANTI_MCP_DEFAULT_AGENT?.trim();
    if (explicit) return explicit;
    if (resolvedHost === 'codex' || resolvedHost === 'codex_cli' || resolvedHost === 'codex_vscode') {
        return 'codex_code';
    }
    return process.env.IRANTI_AGENT_ID?.trim()
        || 'claude_code';
}

function defaultWriteSource(host?: string): string {
    const resolvedHost = currentHost(host);
    if (resolvedHost === 'claude_code') {
        return 'ClaudeCode';
    }
    const explicit = process.env.IRANTI_MCP_DEFAULT_SOURCE?.trim();
    if (explicit) return explicit;
    if (resolvedHost === 'codex' || resolvedHost === 'codex_cli' || resolvedHost === 'codex_vscode') {
        return 'Codex';
    }
    return 'MCP';
}

function safeJsonParse(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON payload: ${message}`);
    }
}

function toStructuredContent(data: unknown): JsonRecord {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        return data as JsonRecord;
    }
    return { result: data };
}

function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: JsonRecord } {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(data, null, 2),
            },
        ],
        structuredContent: toStructuredContent(data),
    };
}

function parseIsoDate(raw?: string): Date | undefined {
    if (!raw) return undefined;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid ISO timestamp: "${raw}"`);
    }
    return parsed;
}

async function ensureDefaultAgent(iranti: Iranti, host?: string): Promise<void> {
    const agentId = defaultAgentId(host);
    const resolvedHost = currentHost(host);
    const isCodexHost = resolvedHost === 'codex' || resolvedHost === 'codex_cli' || resolvedHost === 'codex_vscode';
    await iranti.registerAgent({
        agentId,
        name: process.env.IRANTI_MCP_AGENT_NAME?.trim() || (isCodexHost ? 'Codex' : 'Claude Code'),
        description: process.env.IRANTI_MCP_AGENT_DESCRIPTION?.trim() || (isCodexHost ? 'Codex MCP client' : 'Claude Code MCP client'),
        capabilities: ['memory_read', 'memory_write', 'hybrid_search', 'working_memory'],
        model: process.env.IRANTI_MCP_AGENT_MODEL?.trim()
            || process.env.ANTHROPIC_MODEL
            || (isCodexHost ? 'codex' : 'claude-code'),
    });
}

function syncRuntimeLedgerContext(iranti: Iranti, host?: string, agent?: string): void {
    iranti.setSessionLedgerContext({
        source: 'mcp',
        host: currentHost(host) ?? null,
        agentId: agent?.trim() || defaultAgentId(host),
    });
}

function withDefaultAgent(agent?: string, host?: string): string {
    return agent?.trim() || defaultAgentId(host);
}

function resolveToolAgent(agent?: string, agentId?: string, host?: string): string {
    return withDefaultAgent(agentId ?? agent, host);
}

function resolveToolHost(host?: string): string | undefined {
    const trimmed = host?.trim();
    if (trimmed) {
        runtimeHostOverride = trimmed;
        return trimmed;
    }
    return currentHost();
}

function protocolViolationResult(error: ProtocolViolationError): { content: Array<{ type: 'text'; text: string }>; structuredContent: JsonRecord } {
    return {
        content: [
            {
                type: 'text',
                text: `${error.protocolViolation.message}\n\n${JSON.stringify({
                    blocked: true,
                    protocolViolation: error.protocolViolation,
                }, null, 2)}`,
            },
        ],
        structuredContent: {
            blocked: true,
            protocolViolation: error.protocolViolation,
        },
    };
}

function normalizeRecentMessages(messages?: string[]): string[] {
    if (!Array.isArray(messages)) return [];
    return messages
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .slice(-12);
}

function isInteractiveTerminalLaunch(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function clearProcessAttendants(): void {
    for (const agentId of activeAttendants()) {
        clearAttendant(agentId);
    }
}

async function checkpointActiveAttendants(iranti: Iranti, reason: string): Promise<void> {
    const agents = activeAttendants();
    for (const agentId of agents) {
        const brief = getAttendant(agentId).getBrief();
        const existing = brief?.sessionCheckpoint;
        if (!existing?.task) continue;
        const existingCheckpoint = existing.checkpoint ?? {};
        await iranti.checkpoint({
            agentId,
            task: existing.task,
            recentMessages: [],
            checkpoint: {
                currentStep: existingCheckpoint.currentStep ?? 'in progress',
                nextStep: existingCheckpoint.nextStep,
                openRisks: existingCheckpoint.openRisks,
                recentOutputs: existingCheckpoint.recentOutputs,
                actions: existingCheckpoint.actions,
                fileChanges: existingCheckpoint.fileChanges,
                entityTargets: existingCheckpoint.entityTargets,
                notes: `Host exited gracefully (${reason}). Resume from next step if applicable.`,
            },
            sessionId: existing.sessionId,
        }).catch(() => undefined);
    }
}

function resolveAttendLatestMessage(input: { latestMessage?: string; message?: string }): string {
    const latestMessage = input.latestMessage?.trim();
    if (latestMessage) return latestMessage;
    const message = input.message?.trim();
    if (message) return message;
    throw new Error('iranti_attend requires latestMessage or message.');
}

async function shutdownProcess(code: number, reason: string): Promise<void> {
    if (shutdownPromise) {
        return shutdownPromise;
    }

    shutdownPromise = (async () => {
        try {
            if (processIranti) {
                await checkpointActiveAttendants(processIranti, reason).catch(() => undefined);
            }
            clearProcessAttendants();
            await flushStaffEventEmitter().catch(() => undefined);
            await disconnectDb().catch(() => undefined);
        } finally {
            if (isInteractiveTerminalLaunch()) {
                console.error(`[iranti-mcp] shutting down (${reason}).`);
            }
            process.exitCode = code;
        }
    })();

    return shutdownPromise;
}

function installShutdownHooks(transport: StdioServerTransport): void {
    let shutdownRequested = false;

    const requestShutdown = (code: number, reason: string): void => {
        if (shutdownRequested) return;
        shutdownRequested = true;
        void shutdownProcess(code, reason);
    };

    transport.onclose = () => {
        requestShutdown(0, 'transport_closed');
    };

    // When stdin is already ending or closing, asking the SDK transport to close
    // can re-touch the same handle. On Windows that has been reproducing a
    // UV_HANDLE_CLOSING assertion during shutdown, so we exit directly here.
    process.stdin.once('end', () => requestShutdown(0, 'stdin_end'));
    process.stdin.once('close', () => requestShutdown(0, 'stdin_close'));
    process.stdin.once('error', () => requestShutdown(1, 'stdin_error'));
    process.stdout.once('error', (error: NodeJS.ErrnoException) => {
        requestShutdown(error?.code === 'EPIPE' ? 0 : 1, error?.code === 'EPIPE' ? 'stdout_epipe' : 'stdout_error');
    });
    process.once('SIGINT', () => {
        requestShutdown(130, 'sigint');
    });
    process.once('SIGTERM', () => {
        requestShutdown(143, 'sigterm');
    });
}

async function main(): Promise<void> {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        printHelp();
        return;
    }

    const iranti = createFirstPartyIranti({
        connectionString: requireConnectionString(),
        llmProvider: process.env.LLM_PROVIDER,
        sessionLedgerSource: 'mcp',
        sessionLedgerHost: currentHost() || 'generic_mcp',
        sessionLedgerAgentId: defaultAgentId(),
        dbPoolMax: 3,
    });
    processIranti = iranti;

    await ensureDefaultAgent(iranti);

    const server = new McpServer({
        name: 'iranti-mcp',
        version: '0.3.0',
    });

    server.registerTool('iranti_handshake', {
        description: `Initialize or refresh an agent's working-memory brief for the current task.
Call this at session start or when a new task begins, passing the task and
recent messages. Returns operating rules plus prioritized relevant memory
for that task. If the recent messages appear to contain durable facts that
are not yet in shared memory, the result may include a backfill suggestion.
If your host does not support a true session-start hook, call this on the
first user turn before you start answering recall-style questions.
Do not use this as a per-turn retrieval tool; use iranti_attend.`,
        inputSchema: {
            task: z.string().min(1).describe('The current task or objective.'),
            recentMessages: z.array(z.string()).optional().describe('Recent conversation messages.'),
            agent: z.string().optional().describe('Override the default agent id.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id.'),
            host: z.string().optional().describe('Host identifier (e.g. claude_code, codex). Used to verify host setup has been run for this project.'),
        },
    }, async ({ task, recentMessages, agent, agentId, host }) => {
        const resolvedHost = resolveToolHost(host);
        const resolvedAgent = resolveToolAgent(agent, agentId, resolvedHost);
        syncRuntimeLedgerContext(iranti, resolvedHost, resolvedAgent);
        await ensureDefaultAgent(iranti, resolvedHost);
        const result = await iranti.handshake({
            agent: resolvedAgent,
            task,
            recentMessages: normalizeRecentMessages(recentMessages),
        });
        const setupWarnings = checkHostSetup(resolvedHost, process.cwd());
        if (setupWarnings.length > 0) {
            return textResult({ ...result, setupWarnings });
        }
        return textResult(result);
    });

    server.registerTool('iranti_attend', {
        description: `Ask Iranti whether memory should be injected before the next LLM turn.
Call this before each turn, passing the latest message and the current
visible context window. If the user is asking you to recall a remembered
fact (for example a preference, decision, blocker, next step, or prior
project detail), use this before answering instead of guessing or saying
you do not know. Returns an injection decision plus any facts that should
be added to context if relevant memory is missing. If no handshake has been
performed yet for this agent in the current process, attend will auto-bootstrap
the session first and report that in the result metadata.
This is the minimum safe pre-reply call even when the host skipped handshake.
Omitting currentContext falls back to the latest message only; pass the
full visible context when available. For host compatibility, message is
accepted as an alias for latestMessage. When phase='post-response', pass the
assistant response so Iranti can persist strict continuity facts and shared
checkpoint breadcrumbs before closing the turn.`,
        inputSchema: {
            latestMessage: z.string().min(1).optional().describe('The latest user or assistant message.'),
            message: z.string().min(1).optional().describe('Alias for latestMessage, accepted for host compatibility.'),
            currentContext: z.string().optional().describe('Current visible context window.'),
            entityHints: z.array(z.string()).optional().describe('Optional entity hints in entityType/entityId format.'),
            maxFacts: z.number().int().min(1).max(20).optional().describe('Maximum facts to inject.'),
            forceInject: z.boolean().optional().describe('Force a memory injection decision.'),
            phase: z.enum(['pre-response', 'post-response', 'mid-turn']).optional().describe("Call phase: 'pre-response' before replying, 'post-response' after replying. Enables precise compliance tracking."),
            agent: z.string().optional().describe('Override the default agent id.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id.'),
        },
    }, async ({ latestMessage, message, currentContext, entityHints, maxFacts, forceInject, phase, agent, agentId }) => {
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        const resolvedLatestMessage = resolveAttendLatestMessage({ latestMessage, message });
        try {
            if (phase === 'post-response') {
                await rememberAssistantResponseFacts({
                    iranti,
                    response: resolvedLatestMessage,
                    agent: resolvedAgent,
                    source: defaultWriteSource(),
                    ledgerContext: {
                        source: 'mcp',
                        host: currentHost() || 'generic_mcp',
                    },
                });
                const checkpoint = extractAssistantCheckpointPayload(resolvedLatestMessage);
                const projectEntity = process.env.IRANTI_MEMORY_ENTITY?.trim();
                if (checkpoint && projectEntity) {
                    await iranti.checkpoint({
                        agent: resolvedAgent,
                        task: `Post-response checkpoint for ${resolvedAgent}`,
                        recentMessages: [],
                        checkpoint: {
                            ...checkpoint,
                            entityTargets: [projectEntity],
                        },
                    });
                }
            } else if (isAutoRememberEnabled()) {
                await autoRememberPromptFacts({
                    iranti,
                    prompt: resolvedLatestMessage,
                    agent: resolvedAgent,
                    source: defaultWriteSource(),
                });
            }
            const result = await iranti.attend({
                agent: resolvedAgent,
                latestMessage: resolvedLatestMessage,
                currentContext: currentContext ?? resolvedLatestMessage,
                entityHints,
                maxFacts,
                forceInject,
                phase,
            });
            const injectionBlock = result.shouldInject
                ? formatStructuredFactBlock(result.facts, {
                    title: 'Iranti Retrieved Memory',
                    includeValues: true,
                })
                : '';
            return textResult({
                ...result,
                injectionBlock,
            });
        } catch (error) {
            if (error instanceof ProtocolViolationError) {
                return protocolViolationResult(error);
            }
            throw error;
        }
    });

    server.registerTool('iranti_checkpoint', {
        description: `Persist a shared progress checkpoint while you work.
Use this at meaningful milestones so current step, next step, open risks,
recent outputs, structured actions, and shared entity breadcrumbs survive across turns,
sessions, and agents. This is the strongest shared-RAM tool for active work:
prefer it over ad-hoc prose when you need another session or another agent
to pick up where you left off. If entityTargets are supplied, Iranti also
writes canonical shared breadcrumbs such as current_step, next_step,
open_risks, recent_actions, and recent_file_changes to those entities for handoff.`,
        inputSchema: {
            task: z.string().min(1).describe('Current task or objective for the active checkpoint.'),
            recentMessages: z.array(z.string()).optional().describe('Recent messages that help fingerprint the active task.'),
            currentStep: z.string().optional().describe('What is being worked on right now.'),
            nextStep: z.string().optional().describe('The next step another session or agent should take.'),
            openRisks: z.array(z.string()).optional().describe('Open risks or blockers that still matter.'),
            recentOutputs: z.array(z.string()).optional().describe('Important outputs or artifacts produced so far.'),
            actions: z.array(z.object({
                kind: z.string().min(1).describe('Action kind such as command, test, edit, search, validation, or decision.'),
                summary: z.string().min(1).describe('Compact description of what action happened.'),
                status: z.string().optional().describe('Optional outcome such as passed, failed, succeeded, or skipped.'),
                target: z.string().optional().describe('Optional command, file, test, or subsystem the action touched.'),
                detail: z.string().optional().describe('Optional compact supporting detail for later recovery.'),
            })).optional().describe('Structured actions completed so far, such as commands, tests, searches, or validations.'),
            fileChanges: z.array(z.object({
                action: z.string().min(1).describe('Change action such as created, updated, moved, renamed, or deleted.'),
                path: z.string().min(1).describe('Primary file path affected by the action.'),
                toPath: z.string().optional().describe('Destination path for move/rename actions.'),
                purpose: z.string().optional().describe('Why the file changed or what role it now serves.'),
            })).optional().describe('Structured file actions produced so far.'),
            entityTargets: z.array(z.string()).optional().describe('Shared entities that should receive checkpoint breadcrumbs, in entityType/entityId format.'),
            notes: z.string().optional().describe('Compact extra checkpoint notes that aid handoff.'),
            sessionId: z.string().optional().describe('Optional existing session id to refresh.'),
            agent: z.string().optional().describe('Override the default agent id.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id.'),
        },
    }, async ({ task, recentMessages, currentStep, nextStep, openRisks, recentOutputs, actions, fileChanges, entityTargets, notes, sessionId, agent, agentId }) => {
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        const result = await iranti.checkpoint({
            agent: resolvedAgent,
            task,
            recentMessages: normalizeRecentMessages(recentMessages),
            sessionId,
            checkpoint: {
                currentStep,
                nextStep,
                openRisks,
                recentOutputs,
                actions,
                fileChanges,
                entityTargets,
                notes,
            },
        });
        return textResult(result);
    });

    server.registerTool('iranti_observe', {
        description: 'Recover relevant facts that have fallen out of Claude context.',
        inputSchema: {
            currentContext: z.string().min(1).describe('Current context text being shown to Claude.'),
            entityHints: z.array(z.string()).optional().describe('Optional entity hints in entityType/entityId format.'),
            maxFacts: z.number().int().min(1).max(20).optional().describe('Maximum facts to recover.'),
            agent: z.string().optional().describe('Override the default agent id.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id.'),
        },
    }, async ({ currentContext, entityHints, maxFacts, agent, agentId }) => {
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        try {
            const result = await iranti.observe({
                agent: resolvedAgent,
                currentContext,
                entityHints,
                maxFacts,
            });
            return textResult(result);
        } catch (error) {
            if (error instanceof ProtocolViolationError) {
                return protocolViolationResult(error);
            }
            throw error;
        }
    });

    server.registerTool('iranti_query', {
        description: `Retrieve the current fact for an exact entity+key lookup.
REQUIRED: call iranti_attend before this discovery tool so Iranti can decide
whether memory should be injected before exact lookup.
Use this when you already know both the entity and the key.
Returns the current value, summary, confidence, source, and
temporal metadata when available. Prefer this over iranti_search
when the target fact is already known, and do not answer from
memory alone before checking Iranti.`,
        inputSchema: {
            entity: z.string().min(1).describe('Entity in entityType/entityId format.'),
            key: z.string().min(1).describe('Fact key to retrieve.'),
            agent: z.string().optional().describe('Override the default agent id for protocol tracking.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id for protocol tracking.'),
        },
    }, async ({ entity, key, agent, agentId }) => {
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        try {
            const result = await iranti.query(entity, key);
            return textResult(result);
        } catch (error) {
            if (error instanceof ProtocolViolationError) {
                return protocolViolationResult(error);
            }
            throw error;
        }
    });

    server.registerTool('iranti_history', {
        description: `Retrieve the full version history of a fact for an exact entity+key pair.
Returns all archived past values plus the current value, ordered oldest-first.
Each entry includes value, summary, confidence, source, validFrom, validUntil,
isCurrent, archivedReason, and resolutionState.
REQUIRED: call iranti_attend before this discovery tool so Iranti can decide
whether memory should be injected first.
Use this to understand how a fact evolved over time — decisions that changed,
blockers that were resolved, values that were contested or superseded.`,
        inputSchema: {
            entity: z.string().min(1).describe('Entity in entityType/entityId format.'),
            key: z.string().min(1).describe('Fact key to retrieve history for.'),
            limit: z.number().int().min(1).optional().describe('Maximum number of entries to return (applied after sorting oldest-first).'),
            includeExpired: z.boolean().optional().describe('Include entries that expired without being superseded.'),
            includeContested: z.boolean().optional().describe('Include entries that were contested or escalated.'),
            agent: z.string().optional().describe('Override the default agent id for protocol tracking.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id for protocol tracking.'),
        },
    }, async ({ entity, key, limit, includeExpired, includeContested, agent, agentId }) => {
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        try {
            const history = await iranti.history(entity, key, { includeExpired, includeContested });
            const result = limit != null ? history.slice(0, limit) : history;
            return textResult(result);
        } catch (error) {
            if (error instanceof ProtocolViolationError) {
                return protocolViolationResult(error);
            }
            throw error;
        }
    });

    server.registerTool('iranti_search', {
        description: `Search shared memory with natural language when the exact entity
or key is unknown. Uses hybrid lexical and vector search across
stored facts. Use this for discovery and recall, not exact lookup.
REQUIRED: call iranti_attend before this discovery tool so Iranti can decide
whether memory should be injected before search.
If the user asks what they previously told you and you do not know
the exact key, use this before saying you do not know.`,
        inputSchema: {
            query: z.string().min(1).describe('Natural language search phrase.'),
            entityType: z.string().optional().describe('Optional entity type filter.'),
            entityId: z.string().optional().describe('Optional entity id filter.'),
            limit: z.number().int().min(1).max(50).optional().describe('Maximum number of results.'),
            lexicalWeight: z.number().min(0).max(1).optional().describe('Lexical ranking weight.'),
            vectorWeight: z.number().min(0).max(1).optional().describe('Vector similarity weight.'),
            minScore: z.number().min(0).max(1).optional().describe('Minimum final score threshold.'),
            agent: z.string().optional().describe('Override the default agent id for protocol tracking.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id for protocol tracking.'),
        },
    }, async ({ query, entityType, entityId, limit, lexicalWeight, vectorWeight, minScore, agent, agentId }) => {
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        try {
            const result = await iranti.search({
                query,
                entityType,
                entityId,
                limit,
                lexicalWeight,
                vectorWeight,
                minScore,
            });
            return textResult(result);
        } catch (error) {
            if (error instanceof ProtocolViolationError) {
                return protocolViolationResult(error);
            }
            throw error;
        }
    });

    server.registerTool('iranti_write', {
        description: `Write one durable fact to shared memory for a specific entity.
Use this when you learned something concrete that future turns,
agents, or sessions should retain. Requires: entity ("type/id"),
key, value JSON, and summary. Confidence is optional and defaults
to 85. Conflicts on the same entity+key are detected automatically
and may be resolved or escalated. Personal-memory keys honor the
configured canonical personal entity for this project/session.
Use properties JSON when you need structured issue or workflow metadata
such as issueStatus=open|resolved, severity, or resolution notes.`,
        inputSchema: {
            entity: z.string().min(1).describe('Entity in entityType/entityId format.'),
            key: z.string().min(1).describe('Fact key.'),
            valueJson: z.string().min(1).describe('JSON-serialized fact value.'),
            summary: z.string().min(1).describe('Short retrieval-safe summary.'),
            confidence: z.number().int().min(0).max(100).optional().describe('Raw confidence score.'),
            source: z.string().optional().describe('Source label for provenance.'),
            propertiesJson: z.string().optional().describe('Optional JSON-serialized fact properties for metadata such as issueStatus or severity.'),
            validFrom: z.string().optional().describe('Optional ISO timestamp for when the fact became true/current.'),
            requestId: z.string().optional().describe('Optional idempotency key.'),
            agent: z.string().optional().describe('Override the default agent id.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id.'),
        },
    }, async ({ entity, key, valueJson, summary, confidence, source, propertiesJson, validFrom, requestId, agent, agentId }) => {
        const target = resolvePersonalWriteTarget({ entity, key });
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        const result = await iranti.write({
            entity: target.entity,
            key,
            value: safeJsonParse(valueJson),
            summary,
            confidence: confidence ?? 85,
            source: source?.trim() || defaultWriteSource(),
            agent: resolvedAgent,
            properties: propertiesJson ? safeJsonParse(propertiesJson) as Record<string, unknown> : undefined,
            validFrom: parseIsoDate(validFrom),
            requestId,
        });
        return textResult({
            ...toStructuredContent(result),
            resolvedEntity: target.entity,
            ...(target.rerouted ? { originalEntity: target.originalEntity, canonicalizedPersonalEntity: true } : {}),
        });
    });

    server.registerTool('iranti_write_issue', {
        description: `Write a canonical open or resolved issue fact on a stable key.
Use this when you want defects, bugs, or chores to remain first-class shared
memory instead of loose prose. The same issueId always maps to the same
issue_<id> key, so changing status from open to resolved archives the prior
state automatically while preserving history. Prefer this over hand-rolling
issueStatus properties through iranti_write when the fact is specifically a
trackable issue lifecycle entry.`,
        inputSchema: {
            entity: z.string().min(1).describe('Owner entity in entityType/entityId format, usually a project entity.'),
            issueId: z.string().min(1).describe('Stable issue identifier that becomes issue_<normalized_id>.'),
            title: z.string().min(1).describe('Short human-readable issue title.'),
            status: z.enum(['open', 'resolved']).describe('Issue lifecycle status.'),
            summary: z.string().min(1).describe('Short retrieval-safe summary of the issue state.'),
            confidence: z.number().int().min(0).max(100).optional().describe('Raw confidence score.'),
            source: z.string().optional().describe('Source label for provenance.'),
            severity: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Optional issue severity.'),
            detailsJson: z.string().optional().describe('Optional JSON-serialized structured issue details.'),
            discoveredAt: z.string().optional().describe('Optional ISO timestamp for when the issue was first observed.'),
            resolvedAt: z.string().optional().describe('Optional ISO timestamp for when the issue was resolved.'),
            resolution: z.string().optional().describe('Optional resolution note for resolved issues.'),
            tags: z.array(z.string()).optional().describe('Optional issue tags.'),
            requestId: z.string().optional().describe('Optional idempotency key.'),
            agent: z.string().optional().describe('Override the default agent id.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id.'),
        },
    }, async ({ entity, issueId, title, status, summary, confidence, source, severity, detailsJson, discoveredAt, resolvedAt, resolution, tags, requestId, agent, agentId }) => {
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        const result = await iranti.writeIssue({
            entity,
            issueId,
            title,
            status,
            summary,
            confidence: confidence ?? 85,
            source: source?.trim() || defaultWriteSource(),
            agent: resolvedAgent,
            severity,
            details: detailsJson ? safeJsonParse(detailsJson) : undefined,
            discoveredAt,
            resolvedAt,
            resolution,
            tags,
            requestId,
        });
        return textResult(result);
    });

    server.registerTool('iranti_remember_response', {
        description: `Persist a strict durable summary from your own response.
Use this after you decide to say something like "the next step is ...",
"the blocker is ...", "we decided ...", or "the current owner is ...".
This uses the same narrow summary extractor as the Claude Stop hook,
but it is explicit and works for Codex or any MCP client. Do not use
this for arbitrary prose or every turn.`,
        inputSchema: {
            response: z.string().min(1).describe('The assistant response text to scan for strict durable summary patterns.'),
            projectEntity: z.string().optional().describe('Optional explicit project entity target for project-scoped summaries.'),
            personalEntity: z.string().optional().describe('Optional explicit personal entity target for personal summaries.'),
            source: z.string().optional().describe('Optional provenance label override.'),
            confidence: z.number().int().min(0).max(100).optional().describe('Raw confidence score for remembered summaries.'),
            agent: z.string().optional().describe('Override the default agent id.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id.'),
        },
    }, async ({ response, projectEntity, personalEntity, source, confidence, agent, agentId }) => {
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        const result = await rememberAssistantResponseFacts({
            iranti,
            response,
            agent: resolvedAgent,
            source: source?.trim() || defaultWriteSource(),
            projectEntity,
            personalEntity,
            confidence: confidence ?? 90,
            ledgerContext: {
                source: 'mcp',
                host: currentHost() || 'generic_mcp',
            },
        });
        return textResult(result);
    });

    server.registerTool('iranti_ingest', {
        description: 'Ingest a raw text block and let the Librarian chunk it into atomic facts.',
        inputSchema: {
            entity: z.string().min(1).describe('Entity in entityType/entityId format.'),
            content: z.string().min(1).describe('Raw text content to ingest.'),
            confidence: z.number().int().min(0).max(100).optional().describe('Raw confidence score.'),
            source: z.string().optional().describe('Source label for provenance.'),
            agent: z.string().optional().describe('Override the default agent id.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id.'),
        },
    }, async ({ entity, content, confidence, source, agent, agentId }) => {
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        const result = await iranti.ingest({
            entity,
            content,
            confidence: confidence ?? 80,
            source: source?.trim() || defaultWriteSource(),
            agent: resolvedAgent,
        });
        return textResult(result);
    });

    server.registerTool('iranti_relate', {
        description: 'Create a relationship edge between two entities.',
        inputSchema: {
            fromEntity: z.string().min(1).describe('Source entity in entityType/entityId format.'),
            relationshipType: z.string().min(1).describe('Caller-defined relationship type.'),
            toEntity: z.string().min(1).describe('Target entity in entityType/entityId format.'),
            propertiesJson: z.string().optional().describe('Optional JSON-serialized relationship properties.'),
            createdBy: z.string().optional().describe('Override the default agent id.'),
        },
    }, async ({ fromEntity, relationshipType, toEntity, propertiesJson, createdBy }) => {
        const properties = propertiesJson ? safeJsonParse(propertiesJson) : undefined;
        const resolvedAgent = withDefaultAgent(createdBy);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        const result = await iranti.relate(fromEntity, relationshipType, toEntity, {
            createdBy: resolvedAgent,
            properties: (properties ?? {}) as JsonRecord,
        });
        return textResult({ ok: true, result });
    });

    server.registerTool('iranti_related', {
        description: `Read directly related entities (1 hop) for a given entity.
REQUIRED: call iranti_attend before this discovery tool so Iranti can decide
whether memory should be injected before graph traversal.`,
        inputSchema: {
            entity: z.string().min(1).describe('Entity in entityType/entityId format.'),
            agent: z.string().optional().describe('Override the default agent id for protocol tracking.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id for protocol tracking.'),
        },
    }, async ({ entity, agent, agentId }) => {
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        try {
            const result = await iranti.getRelated(entity);
            return textResult(result);
        } catch (error) {
            if (error instanceof ProtocolViolationError) {
                return protocolViolationResult(error);
            }
            throw error;
        }
    });

    server.registerTool('iranti_related_deep', {
        description: `Read related entities up to N hops deep for a given entity.
REQUIRED: call iranti_attend before this discovery tool so Iranti can decide
whether memory should be injected before graph traversal.`,
        inputSchema: {
            entity: z.string().min(1).describe('Entity in entityType/entityId format.'),
            depth: z.number().int().min(1).max(5).optional().describe('Traversal depth.'),
            agent: z.string().optional().describe('Override the default agent id for protocol tracking.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id for protocol tracking.'),
        },
    }, async ({ entity, depth, agent, agentId }) => {
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        try {
            const result = await iranti.getRelatedDeep(entity, depth ?? 2);
            return textResult(result);
        } catch (error) {
            if (error instanceof ProtocolViolationError) {
                return protocolViolationResult(error);
            }
            throw error;
        }
    });

    server.registerTool('iranti_who_knows', {
        description: `List which agents have written facts about an entity.
REQUIRED: call iranti_attend before this discovery tool so Iranti can decide
whether memory should be injected before provenance discovery.`,
        inputSchema: {
            entity: z.string().min(1).describe('Entity in entityType/entityId format.'),
            agent: z.string().optional().describe('Override the default agent id for protocol tracking.'),
            agentId: z.string().optional().describe('Alias for agent. Override the default agent id for protocol tracking.'),
        },
    }, async ({ entity, agent, agentId }) => {
        const resolvedAgent = resolveToolAgent(agent, agentId);
        syncRuntimeLedgerContext(iranti, undefined, resolvedAgent);
        try {
            const result = await iranti.whoKnows(entity);
            return textResult(result);
        } catch (error) {
            if (error instanceof ProtocolViolationError) {
                return protocolViolationResult(error);
            }
            throw error;
        }
    });

    if (isInteractiveTerminalLaunch()) {
        console.error('[iranti-mcp] stdio server running; waiting for an MCP client. Press Ctrl+C to exit.');
    }

    const transport = new StdioServerTransport();
    installShutdownHooks(transport);
    await server.connect(transport);
}

main().catch((error) => {
    const formatted = rewriteCommandError('iranti mcp', error);
    getStaffEventEmitter().emit({
        staffComponent: 'Attendant',
        actionType: 'host_failure',
        agentId: defaultAgentId(),
        source: 'mcp',
        level: 'audit',
        reason: formatted.message,
        metadata: {
            host: currentHost() || 'generic_mcp',
            operation: 'mcp_startup',
        },
    });
    console.error('[iranti-mcp] fatal:', formatted.message);
    void shutdownProcess(1, 'fatal_error');
});

