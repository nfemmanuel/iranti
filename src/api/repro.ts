import express from 'express';

const app = express();

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

const PORT = 3004;
const server = app.listen(PORT, () => {
    console.log(`Repro server running on port ${PORT}`);
    
    // Diagnostic: check handles
    const handles = (process as any)._getActiveHandles();
    console.log(`Number of active handles: ${handles.length}`);
    handles.forEach((h: any, i: number) => {
        console.log(`  Handle ${i}: ${h.constructor.name}`);
        if (h.hasRef) console.log(`    hasRef: ${h.hasRef()}`);
    });
});

// We are NOT adding setInterval here to see if it exits.
console.log('Server listen called. Waiting for callback...');
