import express from 'express';

const app = express();

app.use((req, res, next) => {
    console.log(`[request] ${req.method} ${req.path}`);
    next();
});

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

const server = app.listen(3002, () => {
    console.log('Server on 3002');
});

setInterval(() => {}, 1 << 30);
