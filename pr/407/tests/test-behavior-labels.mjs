/**
 * test-behavior-labels.mjs — the ethogram and the per-session bout store,
 * away from the UI.
 *
 * `pose/behavior-ethogram.js` holds the project's behaviors and
 * `pose/behavior-labels.js` the labelled bouts. Everything the Behavior tab,
 * Label Behaviors mode and the timeline show is read from these two, and
 * every edit they make is one of the operations below, so the interval
 * arithmetic (overwrite, split, merge, exclusive groups, running states, the
 * identity swap that follows an ID-switch fix) is pinned here.
 *
 * ESM, picked up by `tests/run-mjs-tests.mjs`. Both modules are DOM-free.
 */

import {
    resetEthogram, addBehavior, updateBehavior, removeBehavior, moveBehavior, behaviors, behaviorById,
    behaviorByKey, validateBehaviorFields, serializeEthogram, ingestEthogram, ethogramIsEmpty, BEHAVIOR_COLORS,
} from '../pose/behavior-ethogram.js';
import {
    labelRange, clearRange, toggleState, closeRunning, cancelRunning, markReviewed, deleteBout, editBout,
    deleteBehaviorBouts, renameAnimal, swapAnimalsInRange, orphanedAnimals, reassignAnimal, hasBehaviorData,
    boutIntervals, listBouts, runningStates, isRunning, activeAt, timeBudget, countBehaviorBouts,
    setBehaviorCursor, exportBoutRows, importBoutRows, undoBehaviorEdit, redoBehaviorEdit,
    canUndoBehaviorEdit, onBehaviorChange,
} from '../pose/behavior-labels.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const spans = (list) => list.map(iv => `${iv.start}-${iv.end}${iv.present ? '' : '!'}`).join(' ');

let notified = 0;
onBehaviorChange(() => { notified++; });

function freshEthogram() {
    resetEthogram();
    const rear = addBehavior({ name: 'rear', key: 'r' }).behavior;
    const groom = addBehavior({ name: 'groom', key: 'g', group: 'posture' }).behavior;
    const walk = addBehavior({ name: 'walk', key: 'w', group: 'posture' }).behavior;
    const jump = addBehavior({ name: 'jump', key: 'j', kind: 'point' }).behavior;
    const chase = addBehavior({ name: 'chase', key: 'c', social: true }).behavior;
    return { rear, groom, walk, jump, chase };
}

console.log('\n1. Ethogram: adding, validating, keys and names');
{
    resetEthogram();
    check(ethogramIsEmpty(), 'starts empty');
    const a = addBehavior({ name: 'rear', key: 'R' });
    check(a.behavior && a.behavior.id === 'b1' && a.behavior.key === 'r', 'ids are b1.., keys stored lower-case');
    check(a.behavior.color === BEHAVIOR_COLORS[0] && a.behavior.kind === 'state', 'first default color, state by default');
    check(addBehavior({ name: 'Rear' }).error, 'a name clash (case-insensitive) is refused');
    check(addBehavior({ name: 'x', key: 'r' }).error, 'a key clash is refused');
    check(addBehavior({ name: 'x', key: '3' }).error, 'a digit key is refused (digits pick the animal)');
    check(addBehavior({ name: '' }).error, 'a blank name is refused');
    const b = addBehavior({ name: 'groom', key: 'g' }).behavior;
    check(b.id === 'b2' && b.color === BEHAVIOR_COLORS[1], 'second behavior gets b2 and the next color');
    check(behaviorByKey('G') === b, 'keys match either case');
    check(updateBehavior(b.id, { key: 'r' }).error, 'editing into a key clash is refused');
    check(!updateBehavior(b.id, { name: 'Groom', key: '' }).error && b.name === 'Groom' && b.key === '',
        'renaming a behavior to a different case of its own name, and clearing its key, is allowed');
    check(validateBehaviorFields({ name: 'rear' }, a.behavior.id) === null, 'a behavior does not clash with itself');
    moveBehavior(b.id, -1);
    check(behaviors()[0] === b, 'moveBehavior reorders');
    removeBehavior(a.behavior.id);
    const c = addBehavior({ name: 'sniff' }).behavior;
    check(c.id === 'b3', 'ids are never reused after a removal');
}

console.log('\n2. Ethogram: save and reopen');
{
    resetEthogram();
    check(serializeEthogram() === null, 'an empty ethogram writes nothing');
    const { chase } = freshEthogram();
    updateBehavior(chase.id, { description: 'runs after' });
    const saved = JSON.parse(JSON.stringify(serializeEthogram()));
    check(saved.v === 1 && saved.behaviors.length === 5, 'v1 payload with every behavior');
    check(saved.behaviors[0].group === undefined && saved.behaviors[1].group === 'posture', 'defaults are omitted, groups kept');
    resetEthogram();
    const idMap = ingestEthogram(saved);
    check(behaviors().length === 5 && behaviorById('b5').social && behaviorById('b5').description === 'runs after',
        'into an empty ethogram: same ids and fields');
    check(idMap.get('b2') === 'b2', 'id map is the identity on a fresh load');
    // A later session of the same project: same names, nothing added.
    const again = ingestEthogram(saved);
    check(behaviors().length === 5 && again.get('b3') === 'b3', 'the same ethogram again is a no-op');
    // A file from another project: matched by name, new ones added under fresh ids.
    const other = { v: 1, behaviors: [{ id: 'b1', name: 'walk', color: '#ffffff', kind: 'state' },
                                      { id: 'b2', name: 'bite', color: '#123456', kind: 'point', key: 'r' }] };
    const m2 = ingestEthogram(other);
    check(m2.get('b1') === 'b3', 'a known name maps to the project\'s id');
    const bite = behaviorById(m2.get('b2'));
    check(bite && bite.id === 'b6' && bite.kind === 'point' && bite.key === '', 'an unknown name is added under a fresh id; its clashing key is dropped');
    check(ingestEthogram({ v: 2, behaviors: [] }).size === 0 && ingestEthogram(null).size === 0, 'garbage is ignored');
}

console.log('\n3. Labelling a range: overwrite, split, merge');
{
    const { rear, jump } = freshEthogram();
    const s = {};
    check(labelRange(s, rear.id, 'id_1', '', 100, 200, true) !== null, 'label a present range');
    labelRange(s, rear.id, 'id_1', '', 140, 160, false);
    check(spans(boutIntervals(s, rear.id, 'id_1')) === '100-139 140-160! 161-200', 'an absent label splits a present bout');
    labelRange(s, rear.id, 'id_1', '', 140, 160, true);
    check(spans(boutIntervals(s, rear.id, 'id_1')) === '100-200', 'relabelling present merges back into one bout');
    labelRange(s, rear.id, 'id_1', '', 201, 210, true);
    check(spans(boutIntervals(s, rear.id, 'id_1')) === '100-210', 'a touching present range merges');
    labelRange(s, rear.id, 'id_1', '', 260, 250, true);
    check(spans(boutIntervals(s, rear.id, 'id_1')) === '100-210 250-260', 'start/end in either order');
    check(clearRange(s, rear.id, 'id_1', '', 0, 105) && spans(boutIntervals(s, rear.id, 'id_1')) === '106-210 250-260',
        'clearRange unlabels');
    labelRange(s, jump.id, 'id_1', '', 10, 99, true);
    labelRange(s, jump.id, 'id_1', '', 11, 11, true);
    check(spans(boutIntervals(s, jump.id, 'id_1')) === '10-10 11-11', 'point events are one frame and never merge');
    labelRange(s, jump.id, 'id_1', '', 0, 30, false);
    labelRange(s, jump.id, 'id_1', '', 20, 20, true);
    check(spans(boutIntervals(s, jump.id, 'id_1')) === '0-19! 20-20 21-30!', 'a point inside an absent run splits it');
}

console.log('\n4. Exclusive groups');
{
    const { groom, walk } = freshEthogram();
    const s = {};
    labelRange(s, walk.id, 'id_1', '', 100, 300, true);
    labelRange(s, groom.id, 'id_1', '', 150, 200, true);
    check(spans(boutIntervals(s, walk.id, 'id_1')) === '100-149 150-200! 201-300',
        'labelling a group behavior turns the animal\'s other group behaviors absent there');
    labelRange(s, groom.id, 'id_2', '', 0, 400, true);
    check(spans(boutIntervals(s, walk.id, 'id_1')) === '100-149 150-200! 201-300', 'another animal is untouched');
    const s2 = {};
    toggleState(s2, walk.id, 'id_1', '', 10);
    toggleState(s2, groom.id, 'id_1', '', 20);
    check(!isRunning(s2, walk.id, 'id_1') && isRunning(s2, groom.id, 'id_1'), 'starting a group state stops the running peer');
    check(spans(boutIntervals(s2, walk.id, 'id_1')) === '10-19', '…which ends on the frame before');
}

console.log('\n5. Running states (Label Behaviors mode)');
{
    const { rear, jump } = freshEthogram();
    const s = {};
    check(toggleState(s, rear.id, 'id_1', '', 50).started, 'the key starts a state');
    check(!hasBehaviorData({}) && hasBehaviorData(s), 'a running state counts as data');
    check(activeAt(s, 49).length === 0 && activeAt(s, 60)[0].running, 'active from its start on');
    setBehaviorCursor(s, 80);
    const rows = exportBoutRows(s);
    check(rows.length === 1 && rows[0][3] === 50 && rows[0][4] === 80, 'a save writes it as ending at the cursor…');
    check(isRunning(s, rear.id, 'id_1'), '…without stopping it');
    const stop = toggleState(s, rear.id, 'id_1', '', 90);
    check(stop.stopped && spans(boutIntervals(s, rear.id, 'id_1')) === '50-90', 'the key again stops it into a bout');
    toggleState(s, rear.id, 'id_1', '', 200);
    toggleState(s, rear.id, 'id_1', '', 150);
    check(spans(boutIntervals(s, rear.id, 'id_1')) === '50-90 150-200', 'stopping before the start swaps the ends');
    toggleState(s, rear.id, 'id_2', '', 300);
    check(cancelRunning(s, rear.id, 'id_2', '') && !runningStates(s).length, 'cancelRunning drops it unwritten');
    toggleState(s, rear.id, 'id_1', '', 400);
    toggleState(s, rear.id, 'id_2', '', 410);
    check(closeRunning(s, 420) === 2 && countBehaviorBouts(s, rear.id) === 4, 'closeRunning ends them all');
    check(toggleState(s, jump.id, 'id_1', '', 5).point, 'a point behavior\'s key codes one frame');
}

console.log('\n6. Social behaviors need a target');
{
    const { chase } = freshEthogram();
    const s = {};
    check(labelRange(s, chase.id, 'id_1', '', 0, 10, true) === null, 'no target: refused');
    check(labelRange(s, chase.id, 'id_1', 'id_1', 0, 10, true) === null, 'self as target: refused');
    check(labelRange(s, chase.id, 'id_1', 'id_2', 0, 10, true) !== null, 'with a target: labelled');
    check(listBouts(s)[0].target === 'id_2', 'the bout records its target');
}

console.log('\n7. Mark reviewed fills only unlabelled frames');
{
    const { rear, chase } = freshEthogram();
    const s = {};
    labelRange(s, rear.id, 'id_1', '', 20, 30, true);
    const n = markReviewed(s, [rear.id, chase.id], ['id_1'], ['id_1', 'id_2', 'id_3'], 0, 49);
    check(spans(boutIntervals(s, rear.id, 'id_1')) === '0-19! 20-30 31-49!', 'gaps become absent, labels stay');
    check(spans(boutIntervals(s, chase.id, 'id_1', 'id_2')) === '0-49!' && spans(boutIntervals(s, chase.id, 'id_1', 'id_3')) === '0-49!',
        'a social behavior is reviewed against every other animal');
    check(n === 39 + 50 + 50, 'returns the frames filled');
    check(markReviewed(s, [rear.id], ['id_1'], [], 0, 49) === 0, 'a fully labelled range fills nothing');
}

console.log('\n8. Editing and deleting bouts');
{
    const { rear, groom, chase } = freshEthogram();
    const s = {};
    labelRange(s, rear.id, 'id_1', '', 10, 20, true);
    const b = listBouts(s)[0];
    editBout(s, b, { end: 25, note: 'tall' });
    check(spans(boutIntervals(s, rear.id, 'id_1')) === '10-25' && listBouts(s)[0].note === 'tall', 'edit frames and note');
    editBout(s, listBouts(s)[0], { behaviorId: groom.id, animal: 'id_2' });
    check(boutIntervals(s, rear.id, 'id_1').length === 0 && spans(boutIntervals(s, groom.id, 'id_2')) === '10-25',
        'edit moves a bout to another behavior and animal');
    check(editBout(s, listBouts(s)[0], { behaviorId: chase.id }) === null, 'moving onto a social behavior needs a target');
    check(deleteBout(s, listBouts(s)[0]) && !listBouts(s).length, 'delete');
    labelRange(s, rear.id, 'id_1', '', 0, 5, true);
    labelRange(s, rear.id, 'id_2', '', 0, 5, true);
    check(deleteBehaviorBouts(s, rear.id) === 2 && !hasBehaviorData(s), 'deleteBehaviorBouts removes them all');
}

console.log('\n9. Undo and redo');
{
    const { rear, groom, walk } = freshEthogram();
    const s = {};
    labelRange(s, rear.id, 'id_1', '', 0, 10, true);
    labelRange(s, rear.id, 'id_1', '', 5, 6, false);
    check(undoBehaviorEdit(s) && spans(boutIntervals(s, rear.id, 'id_1')) === '0-10', 'undo the split');
    check(redoBehaviorEdit(s) && spans(boutIntervals(s, rear.id, 'id_1')) === '0-4 5-6! 7-10', 'redo it');
    labelRange(s, walk.id, 'id_1', '', 0, 100, true);
    labelRange(s, groom.id, 'id_1', '', 50, 60, true);
    undoBehaviorEdit(s);
    check(spans(boutIntervals(s, walk.id, 'id_1')) === '0-100' && !boutIntervals(s, groom.id, 'id_1').length,
        'undo restores the exclusive peer too');
    toggleState(s, rear.id, 'id_3', '', 7);
    undoBehaviorEdit(s);
    check(!runningStates(s).length, 'undo a start');
    check(!redoBehaviorEdit({}) && !undoBehaviorEdit({}), 'nothing to undo on a new session');
}

console.log('\n10. Identity rename and swap follow the labels');
{
    const { rear, chase } = freshEthogram();
    const s = {};
    labelRange(s, rear.id, 'id_1', '', 0, 100, true);
    labelRange(s, chase.id, 'id_2', 'id_1', 10, 20, true);
    renameAnimal(s, 'id_1', 'Alice');
    check(boutIntervals(s, rear.id, 'Alice').length === 1 && boutIntervals(s, chase.id, 'id_2', 'Alice').length === 1,
        'rename moves bouts as actor and as target');
    check(!canUndoBehaviorEdit(s), 'and clears the undo history (it holds the old name)');
    const o = {};
    labelRange(o, rear.id, 'Bob', '', 0, 50, false);               // orphan labels under the new name
    labelRange(o, rear.id, 'id_7', '', 20, 30, true);
    renameAnimal(o, 'id_7', 'Bob');
    check(spans(boutIntervals(o, rear.id, 'Bob')) === '0-19! 20-30 31-50!',
        'renaming onto a name with orphaned labels overwrites them, never overlapping');
    swapAnimalsInRange(s, 'Alice', 'id_2', 40, 60);
    check(spans(boutIntervals(s, rear.id, 'Alice')) === '0-39 61-100' && spans(boutIntervals(s, rear.id, 'id_2')) === '40-60',
        'a range swap splits the bout at its edges');
    check(spans(boutIntervals(s, chase.id, 'id_2', 'Alice')) === '10-20', 'bouts outside the range stay');
    swapAnimalsInRange(s, 'Alice', 'id_2', 40, 60);
    check(spans(boutIntervals(s, rear.id, 'Alice')) === '0-100' && !boutIntervals(s, rear.id, 'id_2').length,
        'the swap is its own inverse (an ID-switch Undo)');
    swapAnimalsInRange(s, 'Alice', 'id_2', 15, Infinity);
    check(spans(boutIntervals(s, chase.id, 'id_2', 'Alice')) === '10-14' && spans(boutIntervals(s, chase.id, 'Alice', 'id_2')) === '15-20',
        'a swap to the end of the timeline swaps actor and target');
}

console.log('\n10b. Session.swapIdentitiesInRange carries the labels (ID-switch fix, identity reassignment)');
{
    const { rear } = freshEthogram();
    const PD = await import('../pose/pose-data.js');
    const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
    const cam = new PD.Camera('c0', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
    const s = new PD.Session([cam], new PD.Skeleton('m', ['n0'], []), ['t0', 't1'], 'S');
    const a = s.addIdentity('a').id, b = s.addIdentity('b').id;
    labelRange(s, rear.id, 'a', '', 0, 99, true);
    s.swapIdentitiesInRange(50, 59, a, b);
    check(spans(boutIntervals(s, rear.id, 'a')) === '0-49 60-99' && spans(boutIntervals(s, rear.id, 'b')) === '50-59',
        'a fix swaps the labels on the fixed frames');
    s.swapIdentitiesInRange(50, 59, a, b);
    check(spans(boutIntervals(s, rear.id, 'a')) === '0-99', 'its Undo swaps them back');
    s.swapIdentitiesForward(90, a, b);
    check(spans(boutIntervals(s, rear.id, 'b')) === '90-99', 'a swap to the end of the timeline moves the tail');
}

console.log('\n11. Orphans after a deleted identity');
{
    const { rear } = freshEthogram();
    const s = {};
    labelRange(s, rear.id, 'id_9', '', 0, 10, true);
    labelRange(s, rear.id, 'id_1', '', 5, 20, true);
    check(orphanedAnimals(s, ['id_1']).join() === 'id_9', 'names no identity has are orphans');
    reassignAnimal(s, 'id_9', 'id_1');
    check(!orphanedAnimals(s, ['id_1']).length && spans(boutIntervals(s, rear.id, 'id_1')) === '0-20', 'reassign merges them in');
}

console.log('\n12. Queries');
{
    const { rear, walk } = freshEthogram();
    const s = {};
    labelRange(s, rear.id, 'id_1', '', 0, 9, true);
    labelRange(s, rear.id, 'id_1', '', 20, 29, true);
    labelRange(s, rear.id, 'id_1', '', 10, 19, false);
    labelRange(s, walk.id, 'id_2', '', 5, 6, true);
    const tb = timeBudget(s).find(r => r.animal === 'id_1' && r.behaviorId === rear.id);
    check(tb.bouts === 2 && tb.presentFrames === 20 && tb.absentFrames === 10, 'time budget counts bouts and frames');
    check(activeAt(s, 5).length === 2 && activeAt(s, 15).length === 0, 'activeAt reports present bouts only');
    check(listBouts(s, { animal: 'id_2' }).length === 1 && listBouts(s, { present: false }).length === 1, 'listBouts filters');
}

console.log('\n13. Save rows and load them back');
{
    const { rear, chase } = freshEthogram();
    const s = {};
    labelRange(s, chase.id, 'id_1', 'id_2', 30, 40, true, { note: 'fast' });
    labelRange(s, rear.id, 'id_1', '', 0, 9, true, { source: 'a' });
    labelRange(s, rear.id, 'id_1', '', 10, 12, false);
    const rows = exportBoutRows(s);
    check(rows.length === 3 && rows[0][0] === rear.id && rows[2][2] === 'id_2' && rows[2][7] === 'fast', 'rows are sorted and complete');
    check(rows[0][6] === 'a' && rows[1][5] === 0, 'source and presence are kept');
    const n0 = notified;
    const t = {};
    const res = importBoutRows(t, JSON.parse(JSON.stringify(rows)));
    check(res.kept === 3 && res.dropped === 0 && JSON.stringify(exportBoutRows(t)) === JSON.stringify(rows), 'round trip is exact');
    check(notified === n0, 'a load does not notify (so it never marks the project dirty)');
    const r2 = importBoutRows({}, [['b9', 'id_1', '', 0, 5, 1, 'm', ''], ['b1', 'id_1', '', 7, 3, 1, 'm', ''], 'junk',
                                   ['old1', 'id_1', '', 0, 5, 1, 'm', '']], new Map([['old1', rear.id]]));
    check(r2.kept === 1 && r2.dropped === 3, 'unknown behaviors and malformed rows are dropped; the id map remaps');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
