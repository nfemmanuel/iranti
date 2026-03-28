import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { rewriteCommandError } from '../../src/lib/commandErrors';

const repoRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(repoRoot, 'bin', 'iranti.js');

type CommandResult = {
    status: number | null;
    stdout: string;
    stderr: string;
};

function runCli(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): CommandResult {
    const proc = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: options?.cwd ?? repoRoot,
        env: options?.env ?? process.env,
        encoding: 'utf8',
    });

    return {
        status: proc.status,
        stdout: proc.stdout ?? '',
        stderr: proc.stderr ?? '',
    };
}

function assertSuccess(result: CommandResult, label: string): void {
    assert.strictEqual(result.status, 0, `${label} failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
}

function assertFailure(result: CommandResult, label: string): void {
    assert.notStrictEqual(result.status, 0, `${label} unexpectedly succeeded:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
}

function assertContains(text: string, token: string, label: string): void {
    assert.ok(text.includes(token), `${label} missing token "${token}". Received:\n${text}`);
}

function testHelpMatrix(): void {
    const checks: Array<{ args: string[]; token: string }> = [
        { args: ['--help'], token: 'Iranti CLI' },
        { args: ['setup', '--help'], token: 'Setup Command' },
        { args: ['install', '--help'], token: 'Install Command' },
        { args: ['instance', '--help'], token: 'Instance Commands' },
        { args: ['instance', 'create', '--help'], token: 'Instance Commands' },
        { args: ['instance', 'list', '--help'], token: 'Instance Commands' },
        { args: ['instance', 'show', '--help'], token: 'Instance Commands' },
        { args: ['instance', 'restart', '--help'], token: 'Instance Commands' },
        { args: ['run', '--help'], token: 'Run Command' },
        { args: ['configure', '--help'], token: 'Configure Commands' },
        { args: ['configure', 'instance', '--help'], token: 'Configure Instance Command' },
        { args: ['configure', 'project', '--help'], token: 'Configure Project Command' },
        { args: ['auth', '--help'], token: 'Auth Commands' },
        { args: ['auth', 'create-key', '--help'], token: 'Auth Create-Key Command' },
        { args: ['auth', 'list-keys', '--help'], token: 'Auth List-Keys Command' },
        { args: ['auth', 'revoke-key', '--help'], token: 'Auth Revoke-Key Command' },
        { args: ['list', 'api-keys', '--help'], token: 'Provider Key Commands' },
        { args: ['add', 'api-key', '--help'], token: 'Provider Key Commands' },
        { args: ['update', 'api-key', '--help'], token: 'Provider Key Commands' },
        { args: ['remove', 'api-key', '--help'], token: 'Provider Key Commands' },
        { args: ['project', 'init', '--help'], token: 'Project Init Command' },
        { args: ['project', 'unbind', '--help'], token: 'Project Unbind Command' },
        { args: ['doctor', '--help'], token: 'Doctor Command' },
        { args: ['status', '--help'], token: 'Status Command' },
        { args: ['upgrade', '--help'], token: 'Upgrade Command' },
        { args: ['uninstall', '--help'], token: 'Uninstall Command' },
        { args: ['handshake', '--help'], token: 'Handshake Command' },
        { args: ['attend', '--help'], token: 'Attend Command' },
        { args: ['handoff', '--help'], token: 'Handoff Command' },
        { args: ['chat', '--help'], token: 'Chat Command' },
        { args: ['resolve', '--help'], token: 'Resolve Command' },
        { args: ['integrate', '--help'], token: 'Integrations' },
        { args: ['mcp', '--help'], token: 'Iranti MCP Server' },
        { args: ['claude-setup', '--help'], token: 'Scaffold Claude Code MCP and hook files for the current project.' },
        { args: ['claude-hook', '--help'], token: 'Claude Code -> Iranti hook helper' },
        { args: ['codex-setup', '--help'], token: 'Configure Codex to use the local Iranti MCP server.' },
    ];

    for (const check of checks) {
        const result = runCli(check.args);
        assertSuccess(result, `${check.args.join(' ')} --help`);
        assertContains(result.stdout, check.token, `${check.args.join(' ')} output`);
    }
}

function testHelpDoesNotMutate(): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-cli-help-root-'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-cli-help-project-'));

    try {
        const installHelp = runCli(['install', '--root', root, '--help']);
        assertSuccess(installHelp, 'install --help');
        assert.ok(!fs.existsSync(path.join(root, 'install.json')), 'install --help should not create install metadata');

        const projectInitHelp = runCli(['project', 'init', projectDir, '--instance', 'local', '--help']);
        assertSuccess(projectInitHelp, 'project init --help');
        assert.ok(!fs.existsSync(path.join(projectDir, '.env.iranti')), 'project init --help should not create a project binding');

        const projectUnbindHelp = runCli(['project', 'unbind', projectDir, '--help']);
        assertSuccess(projectUnbindHelp, 'project unbind --help');
        assert.ok(!fs.existsSync(path.join(projectDir, '.env.iranti')), 'project unbind --help should not create or remove a project binding');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(projectDir, { recursive: true, force: true });
    }
}

function testUnknownCommandFailsClearly(): void {
    const result = runCli(['definitely-not-a-command']);
    assertFailure(result, 'unknown command');
    assertContains(result.stderr, 'IRANTI_UNKNOWN_COMMAND', 'unknown command error code');
}

function testSchemaMismatchRewrite(): void {
    const formatted = rewriteCommandError(
        'iranti mcp',
        new Error('The column `validFrom` does not exist in the current database.'),
    );

    assertContains(formatted.message, 'database schema is behind the current Iranti code', 'schema mismatch guidance');
    assertContains(formatted.message, 'npx prisma migrate deploy --schema prisma/schema.prisma', 'schema mismatch migration guidance');
    assertContains(formatted.message, 'npm run prisma:generate', 'schema mismatch prisma generate guidance');
}

function testDatabaseUnreachableRewrite(): void {
    const error = Object.assign(
        new Error('Prisma wrapped an unreachable database as an invalid invocation.'),
        { code: 'ECONNREFUSED' },
    );
    const formatted = rewriteCommandError('iranti auth create-key', error);

    assertContains(formatted.message, 'cannot reach the configured PostgreSQL database', 'db unreachable guidance');
    assertContains(formatted.message, 'DATABASE_URL', 'db unreachable mentions database url');
    assertContains(formatted.message, 'iranti doctor --debug', 'db unreachable doctor guidance');
}

function main(): void {
    testHelpMatrix();
    testHelpDoesNotMutate();
    testUnknownCommandFailsClearly();
    testSchemaMismatchRewrite();
    testDatabaseUnreachableRewrite();
    console.log('command surface tests passed');
}

main();
