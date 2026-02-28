import 'dotenv/config';
import express from 'express';
import { authenticate } from './middleware/auth';
import { knowledgeRoutes } from './routes/knowledge';
import { agentRoutes } from './routes/agents';
import { memoryRoutes } from './routes/memory';
import { Iranti } from '../sdk';

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const iranti = new Iranti({
    connectionString: process.env.DATABASE_URL,
    llmProvider: process.env.LLM_PROVIDER,
});

// ─── Health (no auth) ─────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        version: '0.1.0',
        provider: process.env.LLM_PROVIDER ?? 'mock',
    });
});

// ─── Authenticated Routes ─────────────────────────────────────────────────────

app.use(authenticate);
app.use('/', knowledgeRoutes(iranti));
app.use('/agents', agentRoutes(iranti));
app.use('/', memoryRoutes(iranti));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.IRANTI_PORT ?? '3000');

app.listen(PORT, () => {
    console.log(`\nIranti API running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Provider: ${process.env.LLM_PROVIDER ?? 'mock'}\n`);
});

export default app;
