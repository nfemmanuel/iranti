import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { Iranti } from '../src/sdk';
import { loadRuntimeEnv } from '../src/lib/runtimeEnv';

type JsonRecord = Record<string, unknown>;

loadRuntimeEnv();

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
        '',
        'This server is intended for Claude Code and other MCP clients over stdio.',
    ].join('\n'));
}

function requireConnectionString(): string {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        throw new Error('DATABASE_URL is required for iranti-mcp.');
    }
    return connectionString;
}

function defaultAgentId(): string {
    return process.env.IRANTI_MCP_DEFAULT_AGENT?.trim()
        || process.env.IRANTI_AGENT_ID?.trim()
        || 'claude_code';
}

function defaultWriteSource(): string {
    return process.env.IRANTI_MCP_DEFAULT_SOURCE?.trim() || 'ClaudeCode';
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

function parseValidUntil(raw?: string): Date | undefined {
    if (!raw) return undefined;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid validUntil timestamp: "${raw}"`);
    }
    return parsed;
}

async function ensureDefaultAgent(iranti: Iranti): Promise<void> {
    const agentId = defaultAgentId();
    await iranti.registerAgent({
        agentId,
        name: process.env.IRANTI_MCP_AGENT_NAME?.trim() || 'Claude Code',
        description: process.env.IRANTI_MCP_AGENT_DESCRIPTION?.trim() || 'Claude Code MCP client',
        capabilities: ['memory_read', 'memory_write', 'hybrid_search', 'working_memory'],
        model: process.env.IRANTI_MCP_AGENT_MODEL?.trim() || process.env.ANTHROPIC_MODEL || 'claude-code',
    });
}

function withDefaultAgent(agent?: string): string {
    return agent?.trim() || defaultAgentId();
}

function normalizeRecentMessages(messages?: string[]): string[] {
    if (!Array.isArray(messages)) return [];
    return messages
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .slice(-12);
}

async function main(): Promise<void> {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        printHelp();
        return;
    }

    const iranti = new Iranti({
        connectionString: requireConnectionString(),
        llmProvider: process.env.LLM_PROVIDER,
    });

    await ensureDefaultAgent(iranti);

    const server = new McpServer({
        name: 'iranti-mcp',
        version: '0.1.2',
    });

    server.registerTool('iranti_handshake', {
        description: 'Initialize or refresh Claude working memory for the current task.',
        inputSchema: {
            task: z.string().min(1).describe('The current task or objective.'),
            recentMessages: z.array(z.string()).optional().describe('Recent conversation messages.'),
            agent: z.string().optional().describe('Override the default agent id.'),
        },
    }, async ({ task, recentMessages, agent }) => {
        const result = await iranti.handshake({
            agent: withDefaultAgent(agent),
            task,
            recentMessages: normalizeRecentMessages(recentMessages),
        });
        return textResult(result);
    });

    server.registerTool('iranti_attend', {
        description: 'Ask Iranti whether memory should be injected for the next Claude turn.',
        inputSchema: {
            latestMessage: z.string().min(1).describe('The latest user or assistant message.'),
            currentContext: z.string().optional().describe('Current visible context window.'),
            entityHints: z.array(z.string()).optional().describe('Optional entity hints in entityType/entityId format.'),
            maxFacts: z.number().int().min(1).max(20).optional().describe('Maximum facts to inject.'),
            forceInject: z.boolean().optional().describe('Force a memory injection decision.'),
            agent: z.string().optional().describe('Override the default agent id.'),
        },
    }, async ({ latestMessage, currentContext, entityHints, maxFacts, forceInject, agent }) => {
        const result = await iranti.attend({
            agent: withDefaultAgent(agent),
            latestMessage,
            currentContext: currentContext ?? latestMessage,
            entityHints,
            maxFacts,
            forceInject,
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
        },
    }, async ({ currentContext, entityHints, maxFacts, agent }) => {
        const result = await iranti.observe({
            agent: withDefaultAgent(agent),
            currentContext,
            entityHints,
            maxFacts,
        });
        return textResult(result);
    });

    server.registerTool('iranti_query', {
        description: 'Query an exact fact by entity and key.',
        inputSchema: {
            entity: z.string().min(1).describe('Entity in entityType/entityId format.'),
            key: z.string().min(1).describe('Fact key to retrieve.'),
        },
    }, async ({ entity, key }) => {
        const result = await iranti.query(entity, key);
        return textResult(result);
    });

    server.registerTool('iranti_search', {
        description: 'Run hybrid lexical/vector search when the exact key is unknown.',
        inputSchema: {
            query: z.string().min(1).describe('Natural language search phrase.'),
            entityType: z.string().optional().describe('Optional entity type filter.'),
            entityId: z.string().optional().describe('Optional entity id filter.'),
            limit: z.number().int().min(1).max(50).optional().describe('Maximum number of results.'),
            lexicalWeight: z.number().min(0).max(1).optional().describe('Lexical ranking weight.'),
            vectorWeight: z.number().min(0).max(1).optional().describe('Vector similarity weight.'),
            minScore: z.number().min(0).max(1).optional().describe('Minimum final score threshold.'),
        },
    }, async ({ query, entityType, entityId, limit, lexicalWeight, vectorWeight, minScore }) => {
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
    });

    server.registerTool('iranti_write', {
        description: 'Write one durable fact to Iranti. Use only for stable facts, decisions, preferences, or constraints.',
        inputSchema: {
            entity: z.string().min(1).describe('Entity in entityType/entityId format.'),
            key: z.string().min(1).describe('Fact key.'),
            valueJson: z.string().min(1).describe('JSON-serialized fact value.'),
            summary: z.string().min(1).describe('Short retrieval-safe summary.'),
            confidence: z.number().int().min(0).max(100).optional().describe('Raw confidence score.'),
            source: z.string().optional().describe('Source label for provenance.'),
            validUntil: z.string().optional().describe('Optional ISO timestamp for expiry.'),
            requestId: z.string().optional().describe('Optional idempotency key.'),
            agent: z.string().optional().describe('Override the default agent id.'),
        },
    }, async ({ entity, key, valueJson, summary, confidence, source, validUntil, requestId, agent }) => {
        const result = await iranti.write({
            entity,
            key,
            value: safeJsonParse(valueJson),
            summary,
            confidence: confidence ?? 85,
            source: source?.trim() || defaultWriteSource(),
            agent: withDefaultAgent(agent),
            validUntil: parseValidUntil(validUntil),
            requestId,
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
        },
    }, async ({ entity, content, confidence, source, agent }) => {
        const result = await iranti.ingest({
            entity,
            content,
            confidence: confidence ?? 80,
            source: source?.trim() || defaultWriteSource(),
            agent: withDefaultAgent(agent),
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
        const result = await iranti.relate(fromEntity, relationshipType, toEntity, {
            createdBy: withDefaultAgent(createdBy),
            properties: (properties ?? {}) as JsonRecord,
        });
        return textResult({ ok: true, result });
    });

    server.registerTool('iranti_who_knows', {
        description: 'List which agents have written facts about an entity.',
        inputSchema: {
            entity: z.string().min(1).describe('Entity in entityType/entityId format.'),
        },
    }, async ({ entity }) => {
        const result = await iranti.whoKnows(entity);
        return textResult(result);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error('[iranti-mcp] fatal:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
