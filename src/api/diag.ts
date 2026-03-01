import express from 'express';
import http from 'http';

function logHandles(label: string) {
    console.log(`--- ${label} ---`);
    const handles = (process as any)._getActiveHandles();
    const requests = (process as any)._getActiveRequests();
    console.log(`Active Handles: ${handles.length}`);
    handles.forEach((h: any, i: number) => {
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
        if ((server as any)._handle && typeof (server as any)._handle.hasRef === 'function') {
            console.log(`Server handle hasRef: ${(server as any)._handle.hasRef()}`);
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
