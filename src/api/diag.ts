/**
 * Dev-only: active-handle / active-request diagnostics for the iranti Express server.
 *
 * Starts a minimal Express server and a raw http.createServer on ports 3001/3002,
 * then calls the Node.js internal `_getActiveHandles` / `_getActiveRequests` APIs
 * to inspect what is keeping the event loop alive at each lifecycle stage.
 *
 * NOT shipped — run directly with ts-node for debugging graceful-shutdown hang issues.
 * The `(process as NodeProcessInternal)` casts are intentional: these are private
 * Node.js inspection APIs with no public TypeScript declarations.
 */

import express from 'express';
import http from 'http';

/** Minimal typing for Node.js private inspection APIs used only in this dev script. */
interface NodeProcessInternal extends NodeJS.Process {
    _getActiveHandles(): { constructor: { name: string }; fd?: number }[];
    _getActiveRequests(): unknown[];
}

/** Minimal typing for the internal handle on an http.Server, used only in this dev script. */
interface ServerWithHandle extends http.Server {
    _handle?: { hasRef(): boolean };
}

function logHandles(label: string) {
    console.log(`--- ${label} ---`);
    const handles = (process as NodeProcessInternal)._getActiveHandles();
    const requests = (process as NodeProcessInternal)._getActiveRequests();
    console.log(`Active Handles: ${handles.length}`);
    handles.forEach((h, i) => {
        console.log(`  Handle ${i}: ${h.constructor.name} ${h.fd ? `(fd: ${h.fd})` : ''}`);
    });
    console.log(`Active Requests: ${requests.length}`);
    console.log(`------------------\n`);
}

async function testExpress() {
    console.log('Testing Express 5 app.listen...');
    const app = express();
    const server = app.listen(3001, () => {
        console.log('Express listening on 3001');
        logHandles('After Express listen');
        
        // Check if server handle is ref'd
        const serverWithHandle = server as ServerWithHandle;
        if (serverWithHandle._handle && typeof serverWithHandle._handle.hasRef === 'function') {
            console.log(`Server handle hasRef: ${serverWithHandle._handle.hasRef()}`);
        }
        
        // Wait a bit and check again
        setTimeout(() => {
            logHandles('After 1s (Express)');
            server.close();
            testRawHttp();
        }, 1000);
    });
}

function testRawHttp() {
    console.log('Testing Raw http.createServer listen...');
    const server = http.createServer((req, res) => {
        res.end('ok');
    });
    server.listen(3002, () => {
        console.log('Raw HTTP listening on 3002');
        logHandles('After Raw HTTP listen');
        
        setTimeout(() => {
            logHandles('After 1s (Raw HTTP)');
            server.close();
            console.log('Diagnosis complete.');
        }, 1000);
    });
}

logHandles('Startup');
testExpress();
