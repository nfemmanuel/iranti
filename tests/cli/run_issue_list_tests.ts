import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bootstrapHarness, ensureHarnessStaffEventsTable } from '../../scripts/harness';
import { Iranti } from '../../src/sdk';
import { findEntry } from '../../src/library/queries';
import { disconnectDb } from '../../src/library/client';

const repoRoot = path.resolve(__dirname, '..', '..');
const cliSourcePath = path.join(repoRoot, 'scripts', 'iranti-cli.ts');
const tsNodeTranspileOnlyRegister = require.resolve('ts-node/register/transpile-only');

function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function runCli(args: string[], options?: { cwd?: string }): { status: number | null; stdout: string; stderr: string } {
    const proc = spawnSync(
        process.execPath,
        ['-r', tsNodeTranspileOnlyRegister, cliSourcePath, ...args],
        {
            cwd: options?.cwd ?? repoRoot,
            env: process.env,
            encoding: 'utf8',
        },
    );
    return {
        status: proc.status,
        stdout: proc.stdout ?? '',
        stderr: proc.stderr ?? '',
    };
}

async function main(): Promise<void> {
    bootstrapHarness({ requireDb: true, dbApplicationName: 'iranti:test:cli_issues' });
    await ensureHarnessStaffEventsTable();

    const databaseUrl = process.env.DATABASE_URL?.trim();
    assert.ok(databaseUrl, 'DATABASE_URL is required for CLI issue list tests.');

    const entity = `project/${uniqueId('issue_list_cli')}`;
    const isolatedProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iranti-cli-issues-'));
    const iranti = new Iranti({
        connectionString: databaseUrl,
        dbApplicationName: 'iranti:test:cli_issues',
        sessionLedgerSource: 'cli',
        sessionLedgerHost: 'plain_cli',
        sessionLedgerAgentId: 'issue_list_test',
    });

    await iranti.writeIssue({
        entity,
        issueId: 'missing_status_surface',
        title: 'Missing status surface',
        status: 'open',
        summary: 'Operator status is missing the issue surface.',
        confidence: 95,
        source: 'IssueListTest',
        agent: 'issue_list_test',
        severity: 'high',
        tags: ['cli', 'status'],
    });
    await iranti.writeIssue({
        entity,
        issueId: 'legacy_issue_cleanup',
        title: 'Legacy issue cleanup',
        status: 'resolved',
        summary: 'Legacy cleanup issue was resolved.',
        confidence: 95,
        source: 'IssueListTest',
        agent: 'issue_list_test',
        severity: 'low',
        resolvedAt: new Date().toISOString(),
        resolution: 'Closed after verification.',
        tags: ['cleanup'],
    });
    await iranti.write({
        entity,
        key: 'issue_legacy_note',
        value: { note: 'This is not a canonical issue fact.' },
        summary: 'Legacy issue note stored under an issue_* key.',
        confidence: 61,
        source: 'IssueListTest',
        agent: 'issue_list_test',
    });

    // ── Semantic property regression: verify issue write produces correct metadata ──
    const openIssueEntry = await findEntry({
        entityType: 'project',
        entityId: entity.split('/')[1]!,
        key: 'issue_missing_status_surface',
    });
    assert.ok(openIssueEntry, 'Expected open issue entry to be stored in the knowledge base.');
    const openIssueProperties = openIssueEntry.properties as Record<string, unknown>;
    assert.equal(openIssueProperties.durableClass, 'issue_status', 'issue write: durableClass must be issue_status');
    assert.equal(openIssueProperties.canonicalKey, 'issue_missing_status_surface', 'issue write: canonicalKey must match stable issue key');
    assert.equal(openIssueProperties.mergeStrategy, 'replace', 'issue write: mergeStrategy must be replace');
    assert.equal(openIssueProperties.memoryScope, 'project', 'issue write: memoryScope must be project');
    assert.equal(openIssueProperties.issueStatus, 'open', 'issue write: issueStatus must be open');
    assert.equal(openIssueProperties.issueSeverity, 'high', 'issue write: issueSeverity must be high');
    assert.equal(openIssueProperties.semanticDomain, 'issue_tracking', 'issue write: semanticDomain must be issue_tracking');
    assert.equal(openIssueProperties.semanticIntent, 'issue_status_tracking', 'issue write: semanticIntent must be issue_status_tracking');
    assert.equal(openIssueProperties.temporalScope, 'project_durable', 'issue write: temporalScope must be project_durable');
    const openIssueTags = openIssueProperties.semanticTags as string[];
    assert.ok(Array.isArray(openIssueTags), 'issue write: semanticTags must be an array');
    assert.ok(openIssueTags.includes('project_memory'), 'issue write: semanticTags must include project_memory');
    assert.ok(openIssueTags.includes('issue'), 'issue write: semanticTags must include issue');
    assert.ok(openIssueTags.includes('status'), 'issue write: semanticTags must include status');
    assert.ok(openIssueTags.includes('tracking'), 'issue write: semanticTags must include tracking');
    assert.ok(openIssueTags.includes('singleton_fact'), 'issue write: semanticTags must include singleton_fact for replace mergeStrategy');
    assert.ok(openIssueTags.includes('open'), 'issue write: semanticTags must include issue status (open)');
    assert.ok(openIssueTags.includes('high'), 'issue write: semanticTags must include issue severity (high)');

    try {
        const allIssues = runCli(['issues', '--project', isolatedProjectDir, '--entity', entity, '--json'], { cwd: isolatedProjectDir });
        assert.equal(allIssues.status, 0, `issues --json failed:\n${allIssues.stdout}\n${allIssues.stderr}`);
        const parsedAll = JSON.parse(allIssues.stdout) as {
            entity: string;
            total: number;
            counts: {
                open: number;
                resolved: number;
                invalid: number;
                canonicalTotal: number;
                issueLikeTotal: number;
            };
            invalidIssueLikeFacts: Array<{ key: string; reason: string; source: string; confidence: number }>;
            items: Array<{ issueId: string; status: string }>;
        };
        assert.equal(parsedAll.entity, entity, 'Expected issues command to echo the requested entity.');
        assert.equal(parsedAll.total, 2, `Expected two issues, got ${parsedAll.total}.`);
        assert.equal(parsedAll.counts.open, 1, 'Expected one open canonical issue.');
        assert.equal(parsedAll.counts.resolved, 1, 'Expected one resolved canonical issue.');
        assert.equal(parsedAll.counts.invalid, 1, 'Expected one invalid issue_* fact to be surfaced.');
        assert.equal(parsedAll.counts.canonicalTotal, 2, 'Expected canonicalTotal to count only canonical issue facts.');
        assert.equal(parsedAll.counts.issueLikeTotal, 3, 'Expected issueLikeTotal to count canonical plus invalid issue_* facts.');
        assert.equal(parsedAll.invalidIssueLikeFacts.length, 1, 'Expected invalid issue-like facts to be listed.');
        assert.equal(parsedAll.invalidIssueLikeFacts[0]?.key, 'issue_legacy_note', 'Expected invalid issue-like fact key to be surfaced.');
        assert.equal(parsedAll.invalidIssueLikeFacts[0]?.source, 'IssueListTest', 'Expected invalid issue-like fact source to be surfaced.');
        assert.ok(parsedAll.items.some((item) => item.issueId === 'missing_status_surface' && item.status === 'open'), 'Expected open issue to appear in CLI issue inventory.');
        assert.ok(parsedAll.items.some((item) => item.issueId === 'legacy_issue_cleanup' && item.status === 'resolved'), 'Expected resolved issue to appear in CLI issue inventory.');

        const openOnly = runCli(['issues', '--project', isolatedProjectDir, '--entity', entity, '--status', 'open', '--json'], { cwd: isolatedProjectDir });
        assert.equal(openOnly.status, 0, `issues --status open --json failed:\n${openOnly.stdout}\n${openOnly.stderr}`);
        const parsedOpen = JSON.parse(openOnly.stdout) as {
            total: number;
            items: Array<{ issueId: string; status: string }>;
        };
        assert.equal(parsedOpen.total, 1, `Expected one open issue, got ${parsedOpen.total}.`);
        assert.deepEqual(parsedOpen.items.map((item) => item.issueId), ['missing_status_surface'], `Expected only the open issue, got ${JSON.stringify(parsedOpen.items)}.`);

        const textRun = runCli(['issues', '--project', isolatedProjectDir, '--entity', entity], { cwd: isolatedProjectDir });
        assert.equal(textRun.status, 0, `issues failed:\n${textRun.stdout}\n${textRun.stderr}`);
        assert.ok(textRun.stdout.includes('Canonical inventory: 2 (1 open, 1 resolved)'), `Expected human output to show canonical inventory counts. Output:\n${textRun.stdout}`);
        assert.ok(textRun.stdout.includes('Invalid issue_* facts: 1'), `Expected human output to show invalid issue_* fact count. Output:\n${textRun.stdout}`);
        assert.ok(textRun.stdout.includes('issue_legacy_note: issue_* fact is missing canonical open/resolved status'), `Expected human output to show invalid issue_* fact warning. Output:\n${textRun.stdout}`);
        assert.ok(textRun.stdout.includes('Source: IssueListTest'), `Expected human output to show issue fact source. Output:\n${textRun.stdout}`);
        assert.ok(textRun.stdout.includes('Confidence: 95'), `Expected human output to show issue fact confidence. Output:\n${textRun.stdout}`);

        const debugRun = runCli(['issues', '--debug', '--project', isolatedProjectDir, '--entity', entity], { cwd: isolatedProjectDir });
        assert.equal(debugRun.status, 0, `issues --debug failed:\n${debugRun.stdout}\n${debugRun.stderr}`);
        assert.ok(debugRun.stdout.includes('Attendant CLI runtime env resolved.'), `Expected debug output to explain runtime env resolution. Output:\n${debugRun.stdout}`);
        assert.ok(debugRun.stdout.includes('environment-only'), `Expected debug output to surface authorityMode=environment-only. Output:\n${debugRun.stdout}`);
    } finally {
        fs.rmSync(isolatedProjectDir, { recursive: true, force: true });
        await disconnectDb().catch(() => undefined);
    }

    console.log('CLI issue list tests passed');
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
