import 'dotenv/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { Iranti } from '../src/sdk';
import { route } from '../src/lib/router';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExtractedFact {
    key: string;
    value: unknown;
    summary: string;
    confidence: number;
    category: 'codebase' | 'decision' | 'session' | 'blocker' | 'open_question';
}

// ─── Extraction ──────────────────────────────────────────────────────────────

async function extractFacts(conversationText: string): Promise<ExtractedFact[]> {
    const response = await route('classification', [
        {
            role: 'user',
            content: `You are extracting persistent facts from a development conversation.

Extract every fact that a developer would want to remember in future sessions.
Focus on:
- Technical decisions made (libraries chosen, patterns adopted, architecture choices)
- Commands run and their results
- Problems encountered and how they were solved
- Open questions or unresolved decisions
- What was built or changed
- Configuration details (versions, env vars, settings)
- What was discussed but not yet built

For each fact, assign a category:
- codebase: technical facts about the code, dependencies, configuration
- decision: architectural or design decisions made
- session: what was worked on, current state, next steps
- blocker: problems encountered, workarounds applied
- open_question: unresolved decisions or questions

Conversation:
${conversationText.substring(0, 8000)}

Return ONLY a valid JSON array. No markdown, no backticks.
Each item must have: key (snake_case), value (object with full details), summary (one sentence), confidence (0-100), category.

Example:
[
  {
    "key": "prisma_adapter_requirement",
    "value": {
      "detail": "Prisma v6 requires @prisma/adapter-pg and PrismaPg adapter",
      "errorIfMissing": "Constructor signature error",
      "fix": "Pass adapter as first argument to PrismaClient constructor"
    },
    "summary": "Prisma v6 requires PrismaPg adapter passed to constructor",
    "confidence": 100,
    "category": "codebase"
  }
]

If no facts can be extracted, return: []`,
        },
    ], 2048);

    try {
        const clean = response.text.replace(/```json|```/g, '').trim();
        return JSON.parse(clean);
    } catch {
        console.error('Failed to parse extracted facts. Raw response:');
        console.error(response.text.substring(0, 500));
        return [];
    }
}

// ─── Input ───────────────────────────────────────────────────────────────────

async function getConversationText(): Promise<string> {
    const args = process.argv.slice(2);

    // Option 1 — file path provided
    if (args[0]) {
        const filePath = path.resolve(args[0]);
        console.log(`Reading conversation from: ${filePath}`);
        return fs.readFile(filePath, 'utf-8');
    }

    // Option 2 — stdin
    console.log('Paste conversation text below. Press Ctrl+D (Unix) or Ctrl+Z (Windows) when done:\n');
    const rl = readline.createInterface({ input: process.stdin });
    const lines: string[] = [];

    return new Promise((resolve) => {
        rl.on('line', (line) => lines.push(line));
        rl.on('close', () => resolve(lines.join('\n')));
    });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function extractSession() {
    console.log('\n🧠 Iranti Session Extractor\n');

    const iranti = new Iranti();
    const conversationText = await getConversationText();

    if (!conversationText.trim()) {
        console.log('No conversation text provided. Exiting.');
        process.exit(0);
    }

    console.log(`\nExtracting facts from ${conversationText.length} characters of conversation...\n`);

    const facts = await extractFacts(conversationText);

    if (facts.length === 0) {
        console.log('No facts extracted.');
        process.exit(0);
    }

    console.log(`Extracted ${facts.length} facts. Writing to Library...\n`);

    const entityMap: Record<string, string> = {
        codebase: 'codebase/iranti',
        decision: 'codebase/iranti',
        blocker: `session/${new Date().toISOString().split('T')[0]}`,
        session: `session/${new Date().toISOString().split('T')[0]}`,
        open_question: 'codebase/iranti',
    };

    let written = 0;
    let rejected = 0;

    for (const fact of facts) {
        const entity = entityMap[fact.category] ?? 'session/current';

        const result = await iranti.write({
            entity,
            key: `${fact.category}_${fact.key}`,
            value: fact.value,
            summary: fact.summary,
            confidence: fact.confidence,
            source: 'session_extractor',
            agent: 'developer',
        });

        const icon = result.action === 'created' ? '✓' :
                     result.action === 'updated' ? '↑' :
                     result.action === 'escalated' ? '⚡' : '–';

        console.log(`  ${icon} [${fact.category}] ${fact.key}: ${result.action}`);

        if (result.action === 'created' || result.action === 'updated') written++;
        else rejected++;
    }

    console.log(`\nDone. Written: ${written}, Skipped: ${rejected}`);
    console.log('\nQuery session knowledge anytime:');
    console.log('  iranti.queryAll("session/current")');
    console.log('  iranti.queryAll("codebase/iranti")\n');

    process.exit(0);
}

extractSession().catch((err) => {
    console.error('Session extraction failed:', err);
    process.exit(1);
});
