/**
 * Dev-only: minimal Express reproduction server for diagnosing active-handle / event-loop behaviour.
 *
 * Starts a bare Express server on port 3004 with a single /health route, then inspects
 * the Node.js `_getActiveHandles` internal API to log what is keeping the process alive.
 * NOT shipped — run directly with ts-node when investigating graceful-shutdown hang issues.
 */

import express from 'express';

/** Minimal typing for the Node.js private inspection API used only in this dev script. */
interface NodeProcessInternal extends NodeJS.Process {
    _getActiveHandles(): { constructor: { name: string }; hasRef?: () => boolean }[];
}

const app = express();

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

const PORT = 3004;
app.listen(PORT, () => {
    console.log(`Repro server running on port ${PORT}`);

    // Diagnostic: check handles
    const handles = (process as NodeProcessInternal)._getActiveHandles();
    console.log(`Number of active handles: ${handles.length}`);
    handles.forEach((h, i) => {
        console.log(`  Handle ${i}: ${h.constructor.name}`);
        if (h.hasRef) console.log(`    hasRef: ${h.hasRef()}`);
    });
});

// We are NOT adding setInterval here to see if it exits.
console.log('Server listen called. Waiting for callback...');
