/**
 * Seeds the Librarian conflict-resolution policy into the iranti knowledge base.
 *
 * Writes the ConflictPolicy entry (confidence thresholds, source reliability
 * weights) as a protected system entry. Run after setup.ts when the default
 * policy needs to be overridden or refreshed. Requires DATABASE_URL.
 */
import { initDb } from '../src/library/client';
import { librarianWrite } from '../src/librarian';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/iranti';

async function seedPolicy() {
    console.log('📋 Seeding conflict policy...\n');
    
    initDb(DATABASE_URL, { applicationName: 'iranti:script:seed_policy' });
    
    const policy = {
        minConfidenceToOverwrite: 10,
        minConfidenceToAccept: 50,
        minResolutionCertainty: 0.7,
        sourceReliability: {
            HumanReview: 1.0,
            OpenAlex: 0.9,
            ORCID: 0.85,
            Librarian: 0.8,
            seed: 1.0,
        },
        ttlDefaultsByKey: {
            affiliation: 90,
            email: 180,
        },
        authoritativeSourcesByKey: {
            affiliation: ['HumanReview', 'ORCID'],
        },
    };
    
    const result = await librarianWrite({
        entityType: 'system',
        entityId: 'librarian',
        key: 'conflict_policy',
        valueRaw: policy,
        valueSummary: 'Conflict resolution policy with deterministic rules',
        confidence: 100,
        source: 'seed',
        createdBy: 'seed',
        isProtected: true,
    });
    
    console.log(`✓ Policy seeded: ${result.action}`);
    console.log(`  Reason: ${result.reason}\n`);
    
    console.log('Policy contents:');
    console.log(JSON.stringify(policy, null, 2));
}

seedPolicy().catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
});
