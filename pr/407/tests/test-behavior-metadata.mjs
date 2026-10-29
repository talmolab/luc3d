/**
 * test-behavior-metadata.mjs — behavior labels in `metadata.lucid`.
 *
 * `import-export/behavior-metadata.js` is the one seam every writer (eager and
 * streaming `.slp`, project JSON) and every reader calls, so what it writes
 * and how it reads it back decides whether a reopened project shows what was
 * coded. The full save → reopen path through the real writers and readers is
 * the e2e `behavior-label-roundtrip`; this pins the payload itself:
 *
 *   - an untouched project writes no key (save-golden-digest must not move);
 *   - the ethogram goes into every session, bouts into their own;
 *   - a multi-session reopen ingests the ethogram once;
 *   - a session file added to an open project is merged by behavior name;
 *   - garbage is ignored.
 */

import { writeBehaviorMetadata, readBehaviorMetadata, resetBehaviorState, BEHAVIOR_METADATA_KEYS }
    from '../import-export/behavior-metadata.js';
import { addBehavior, behaviors, behaviorByName } from '../pose/behavior-ethogram.js';
import { labelRange, toggleState, setBehaviorCursor, noteBehaviorFps, exportBoutRows, listBouts, isRunning }
    from '../pose/behavior-labels.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const roundTrip = (o) => JSON.parse(JSON.stringify(o));

console.log('\n1. Nothing to say, nothing written');
{
    resetBehaviorState();
    const lucid = {};
    writeBehaviorMetadata(lucid, { name: 's' });
    check(Object.keys(lucid).length === 0, 'no ethogram, no bouts: no keys');
    check(BEHAVIOR_METADATA_KEYS.join() === 'ethogram,behaviorLabels', 'the keys this module owns');
}

console.log('\n2. Write and read back');
{
    resetBehaviorState();
    const rear = addBehavior({ name: 'rear', key: 'r' }).behavior;
    const chase = addBehavior({ name: 'chase', key: 'c', social: true, group: 'social' }).behavior;
    const s1 = { name: 'day1' }, s2 = { name: 'day2' };
    labelRange(s1, rear.id, 'id_1', '', 10, 20, true);
    labelRange(s1, chase.id, 'id_2', 'id_1', 30, 35, true, { note: 'fast' });
    noteBehaviorFps(s1, 50);
    toggleState(s1, rear.id, 'id_2', '', 100);
    setBehaviorCursor(s1, 140);
    const l1 = {}, l2 = {};
    writeBehaviorMetadata(l1, s1);
    writeBehaviorMetadata(l2, s2);
    check(l1.ethogram && l2.ethogram && JSON.stringify(l1.ethogram) === JSON.stringify(l2.ethogram),
        'the ethogram is written into every session, identically');
    check(!l2.behaviorLabels, 'a session without bouts writes no behaviorLabels');
    check(l1.behaviorLabels.v === 1 && l1.behaviorLabels.fps === 50 && l1.behaviorLabels.bouts.length === 3,
        'bouts with their fps; the running state is saved as a bout…');
    check(l1.behaviorLabels.bouts.some(r => r[3] === 100 && r[4] === 140), '…ending at the playhead');
    check(isRunning(s1, rear.id, 'id_2'), 'and saving did not stop it');
    const expected = exportBoutRows(s1);

    // Reopen: a fresh project, sessions read in order.
    resetBehaviorState();
    const r1 = { name: 'day1' }, r2 = { name: 'day2' };
    readBehaviorMetadata(r1, roundTrip(l1));
    readBehaviorMetadata(r2, roundTrip(l2));
    check(behaviors().length === 2, 'the ethogram is ingested once across sessions');
    check(behaviorByName('chase').social && behaviorByName('chase').group === 'social', 'fields survive');
    check(JSON.stringify(exportBoutRows(r1)) === JSON.stringify(expected), 'bouts read back exactly');
    check(!listBouts(r2).length, 'the bout-less session stays empty');
}

console.log('\n3. A session file added to an open project is merged by name');
{
    resetBehaviorState();
    const groom = addBehavior({ name: 'groom' }).behavior;          // b1 in the open project
    const rear = addBehavior({ name: 'rear' }).behavior;            // b2
    // The file comes from a project where rear was b1 and sniff b2.
    const file = {
        ethogram: { v: 1, behaviors: [{ id: 'b1', name: 'rear', color: '#ffffff', kind: 'state' },
                                      { id: 'b2', name: 'sniff', color: '#000000', kind: 'state' }] },
        behaviorLabels: { v: 1, bouts: [['b1', 'id_1', '', 0, 9, 1, 'm', ''], ['b2', 'id_1', '', 20, 29, 1, 'm', '']] },
    };
    const s = { name: 'added' };
    const res = readBehaviorMetadata(s, file);
    const sniff = behaviorByName('sniff');
    check(res.kept === 2 && behaviors().length === 3 && sniff && sniff.id === 'b3', 'the unknown behavior is added under a fresh id');
    const bouts = listBouts(s);
    check(bouts[0].behaviorId === rear.id && bouts[1].behaviorId === sniff.id, 'the file\'s bouts are remapped onto the project\'s ids');
    check(groom.id === 'b1', 'existing behaviors keep their ids');
}

console.log('\n4. Garbage is ignored');
{
    resetBehaviorState();
    const s = {};
    check(readBehaviorMetadata(s, { behaviorLabels: 'nope' }).kept === 0, 'a string payload');
    check(readBehaviorMetadata(s, { behaviorLabels: { v: 9, bouts: [] } }).kept === 0, 'an unknown version');
    check(readBehaviorMetadata(s, { ethogram: { v: 1, behaviors: 'x' } }).kept === 0 && behaviors().length === 0, 'a broken ethogram');
    check(readBehaviorMetadata(null, {}).kept === 0 && readBehaviorMetadata(s, null).kept === 0, 'no session / no dict');
    const r = readBehaviorMetadata(s, { behaviorLabels: { v: 1, bouts: [['b1', 'id_1', '', 0, 1, 1, 'm', '']] } });
    check(r.kept === 0 && r.dropped === 1, 'bouts naming no known behavior are skipped');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
