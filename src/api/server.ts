import { config } from 'dotenv';
config();

import express from 'express';
import { Iranti } from '../sdk';
import { knowledgeRoutes } from './routes/knowledge';
import { memoryRoutes } from './routes/memory';
import { agentRoutes } from './routes/agents';
import { authenticate } from './middleware/auth';

const app = express();

app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
});

app.use(express.json());

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        version: '0.1.0',
        provider: process.env.LLM_PROVIDER ?? 'mock',
    });
});

// Initialize Iranti SDK
const iranti = new Iranti({
    connectionString: process.env.DATABASE_URL!,
    llmProvider: (process.env.LLM_PROVIDER as 'gemini' | 'openai' | 'mock') ?? 'mock',
});

// Register API routes with auth (skip auth for health and chat endpoints)
app.use('/write', authenticate);
app.use('/ingest', authenticate);
app.use('/query', authenticate);
app.use('/relate', authenticate);
app.use('/related', authenticate);
app.use('/handshake', authenticate);
app.use('/reconvene', authenticate);
app.use('/whoknows', authenticate);
app.use('/agents', authenticate);
app.use('/maintenance', authenticate);
app.use('/observe', authenticate);

app.use(knowledgeRoutes(iranti));
app.use(memoryRoutes(iranti));
app.use(agentRoutes(iranti));

app.post(['/v1/chat/completions', '/chat/completions'], async (req, res) => {
    const providedKey = req.headers['authorization']?.replace('Bearer ', '');
    const apiKey = process.env.IRANTI_API_KEY;

    if (!providedKey || providedKey !== apiKey) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    try {
        const messages = (req.body.messages ?? []).map((m: any) => ({
            role: m.role as 'user' | 'assistant',
            content: String(m.content),
        }));

        // Dynamic provider selection
        const provider = process.env.LLM_PROVIDER || 'mock';
        let response;
        
        if (provider === 'gemini') {
            const { default: geminiProvider } = await import('../lib/providers/gemini');
            response = await geminiProvider.complete(messages);
        } else if (provider === 'openai') {
            const { default: openaiProvider } = await import('../lib/providers/openai');
            response = await openaiProvider.complete(messages);
        } else {
            const { default: mockProvider } = await import('../lib/providers/mock');
            response = await mockProvider.complete(messages);
        }

        res.json({
            id: `mock-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock',
            choices: [{
                index: 0,
                message: { role: 'assistant', content: response.text },
                finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});

const PORT = parseInt(process.env.IRANTI_PORT ?? '3001');
app.listen(PORT, () => {
    console.log(`\nIranti API running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Provider: ${process.env.LLM_PROVIDER ?? 'mock'}\n`);
});

// Keep process alive
setInterval(() => {}, 1000);
