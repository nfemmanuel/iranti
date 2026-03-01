const express = require('express');
const app = express();

app.get('/test', (req, res) => {
    console.log('Request received!');
    res.json({ ok: true });
});

const server = app.listen(3001, () => {
    console.log('Test server on 3001');
});

setInterval(() => {}, 1 << 30);
