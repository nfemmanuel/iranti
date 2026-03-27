import assert from 'assert';
import { normalizeExplicitTask } from '../../src/attendant/AttendantInstance';

function main(): void {
    assert.strictEqual(
        normalizeExplicitTask('General session: reviewing project state, Iranti interaction rules, and user preferences for the iranti-site project.'),
        'reviewing project state, Iranti interaction rules, and user preferences for the iranti-site project',
        'Expected explicit task normalization to preserve the concrete task and strip the generic session prefix.'
    );

    assert.strictEqual(
        normalizeExplicitTask('General session assistance for iranti-control-plane project'),
        'working on iranti-control-plane project',
        'Expected generic assistance phrasing to collapse to a concrete project-work task.'
    );

    assert.strictEqual(
        normalizeExplicitTask('general session'),
        null,
        'Expected purely generic task labels to be ignored so inference can fall back to recent-message analysis.'
    );

    console.log('attendant task inference normalization passed');
}

main();
