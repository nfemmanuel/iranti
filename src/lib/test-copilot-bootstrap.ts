/**
 * Cross-process bootstrap test for Copilot CLI scenario.
 * Simulates Copilot CLI restarting the MCP subprocess for each tool call.
 *
 * Each call spawns a fresh ts-node process, just as Copilot CLI does.
 * The bootstrap in iranti-mcp.ts restores protocol state from attendant_state in DB.
 */
import { spawn } from 'child_process';
import path from 'path';

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const MCP_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'iranti-mcp.ts');

const AGENT = 'copilot_code';
const HOST = 'copilot_cli';

interface McpResult {
    blocked: boolean;
    errorCode?: string;
    raw: string;
    exitCode: number | null;
}

function buildMcpExchange(toolName: string, toolArgs: Record<string, unknown>): string {
    const init = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.1' },
        },
    });
    const initialized = JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/initialized',
    });
    const toolCall = JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: toolName, arguments: toolArgs },
    });
    return init + '\n' + initialized + '\n' + toolCall + '\n';
}

async function runMcpProcess(toolName: string, toolArgs: Record<string, unknown>): Promise<McpResult> {
    return new Promise((resolve) => {
        const proc = spawn('npx', ['ts-node', '--project', path.join(PROJECT_DIR, 'tsconfig.json'), MCP_SCRIPT], {
            cwd: PROJECT_DIR,
            env: {
                ...process.env,
                IRANTI_MCP_DEFAULT_AGENT: AGENT,
                IRANTI_MCP_DEFAULT_SOURCE: 'Copilot',
                IRANTI_MCP_HOST: HOST,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

        const input = buildMcpExchange(toolName, toolArgs);
        proc.stdin.write(input);
        // Give the process time to handle the message, then close stdin
        setTimeout(() => { proc.stdin.end(); }, 3000);

        proc.on('close', (code) => {
            // Parse the last tools/call response from stdout
            const lines = stdout.split('\n').filter(l => l.trim());
            let blocked = false;
            let errorCode: string | undefined;
            for (const line of lines) {
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === 2 && msg.result) {
                        const content = msg.result.content ?? [];
                        for (const c of content) {
                            const text = typeof c === 'string' ? c : (c.text ?? '');
                            if (text.includes('"blocked": true') || text.includes('"blocked":true')) {
                                blocked = true;
                                const m = text.match(/"code"\s*:\s*"([^"]+)"/);
                                if (m) errorCode = m[1];
                            }
                        }
                    }
                } catch {
                    // not JSON, skip
                }
            }
            resolve({ blocked, errorCode, raw: stdout + '\n---STDERR---\n' + stderr, exitCode: code });
        });
    });
}

async function main() {
    console.log('=== Cross-process bootstrap test (Copilot CLI simulation) ===\n');
    console.log(`Agent: ${AGENT}  Host: ${HOST}`);
    console.log(`MCP script: ${MCP_SCRIPT}\n`);

    // Step 1: Handshake (Process A)
    console.log('[1/3] Spawning Process A → iranti_handshake...');
    const handshakeResult = await runMcpProcess('mcp__iranti__iranti_handshake', {
        task: 'Cross-process bootstrap test',
        agent: AGENT,
        host: HOST,
    });
    if (handshakeResult.blocked) {
        console.error(`FAIL: handshake blocked (${handshakeResult.errorCode})`);
        process.exit(1);
    }
    console.log(`  ✓ handshake ok (exit ${handshakeResult.exitCode})\n`);

    // Brief pause to ensure DB write commits
    await new Promise(r => setTimeout(r, 500));

    // Step 2: Attend pre-response (Process B)
    console.log('[2/3] Spawning Process B → iranti_attend(phase=pre-response)...');
    const attendResult = await runMcpProcess('mcp__iranti__iranti_attend', {
        phase: 'pre-response',
        latestMessage: 'test attend',
        agent: AGENT,
    });
    if (attendResult.blocked) {
        console.error(`FAIL: attend blocked (${attendResult.errorCode})`);
        console.error('Bootstrap did not restore handshake state. Raw output:');
        console.error(attendResult.raw.slice(0, 2000));
        process.exit(1);
    }
    console.log(`  ✓ attend ok (exit ${attendResult.exitCode})\n`);

    await new Promise(r => setTimeout(r, 500));

    // Step 3: Search (Process C)
    console.log('[3/3] Spawning Process C → iranti_search...');
    const searchResult = await runMcpProcess('mcp__iranti__iranti_search', {
        query: 'test query',
        agent: AGENT,
    });
    if (searchResult.blocked) {
        console.error(`FAIL: search blocked (${searchResult.errorCode})`);
        console.error('Bootstrap did not restore attend state. Raw output:');
        console.error(searchResult.raw.slice(0, 2000));
        process.exit(1);
    }
    console.log(`  ✓ search ok (exit ${searchResult.exitCode})\n`);

    console.log('=== PASS: Cross-process bootstrap works ===');
}

main().catch(e => {
    console.error('Unexpected error:', e);
    process.exit(1);
});
