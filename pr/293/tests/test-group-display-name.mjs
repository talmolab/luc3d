/**
 * test-group-display-name.mjs — what a status line calls an InstanceGroup.
 *
 * REGRESSION: double-clicking a predicted instance to convert it wrote
 * "Converted Track undefined to user instance" (seen 2026-10-06 on a lazy
 * 8-camera per-camera project after Track All, converting groups labelled
 * id_2 / id_4). `onInstanceConverted` (pose/initialization.js) read
 * `state.session.tracks[instanceGroup.trackIdx]`, but an InstanceGroup has no
 * `trackIdx` — its MEMBERS do (and since luc3d #273 a member's can be `null`),
 * while the group carries `identityId`. The sibling handlers read
 * `tracks[group.identityId]`, treating an identity id as a track index, which
 * prints `Group -1` / `Track null` or names the wrong track.
 *
 * All five now go through `groupDisplayName` (pose/pose-data.js — no imports,
 * so it loads under Node; pose/initialization.js pulls in the whole UI and
 * cannot). The fixtures below are REAL `Session` / `InstanceGroup` /
 * `Instance` objects, so the per-frame identity lookup runs through the real
 * packed `frameIdentityMap` codec, not a stub.
 *
 * Run:  node tests/test-group-display-name.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    Session, InstanceGroup, Instance, groupDisplayName,
} from '../pose/pose-data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const eq = (actual, expected, msg) =>
    check(actual === expected, `${msg} (expected '${expected}', got '${actual}')`);

const CAMS = ['cam1', 'cam2', 'cam3'];
const FRAME = 7;

function makeSession(tracks) {
    const s = new Session(CAMS.map(name => ({ name })), { nodes: ['a', 'b'] }, tracks);
    for (let i = 0; i < 5; i++) s.addIdentity();   // id_0 .. id_4
    return s;
}

/** A group whose member in camera `cams[i]` has `trackIdxs[i]`. */
function makeGroup(identityId, trackIdxs, type = 'predicted') {
    const g = new InstanceGroup(42, identityId);
    trackIdxs.forEach((t, i) => g.addInstance(CAMS[i], new Instance([[1, 2], [3, 4]], t, type, 0.9)));
    return g;
}

// The two status lines this fixes, composed exactly as the handlers do.
const messages = (name) => [
    'Converted ' + name + ' to user instance',   // onInstanceConverted
    'Converted ' + name + ' to user labels',     // onClonePredictedGroup
];
const clean = (s) => !/undefined|null|NaN|-1\b/.test(s);
function checkMessages(name, label) {
    for (const m of messages(name)) check(clean(m), `${label}: "${m}" names nothing undefined/null`);
}

console.log('\n0. Negative control: the old expressions on these fixtures');
{
    // Proves the fixtures reach the bug: the pre-fix expressions, verbatim.
    const s = makeSession(['track_0', 'track_1']);
    const g = makeGroup(2, [1, 1, 1]);
    const oldConverted = s.tracks[g.trackIdx] || 'Track ' + g.trackIdx;
    eq(oldConverted, 'Track undefined', 'onInstanceConverted\'s old lookup printed "Track undefined"');
    const nullGroup = makeGroup(-1, [null, null]);
    nullGroup.identityId = null;   // assignIdentityToGroup can store null
    const trackIdx = nullGroup.identityId;
    const oldClone = (trackIdx >= 0 && s.tracks[trackIdx]) || ('Group ' + trackIdx);
    eq(oldClone, 'Group null', 'onClonePredictedGroup\'s old lookup printed "Group null" (null >= 0 is true)');
}

console.log('\n1. A group with an identity is named by it');
{
    const s = makeSession(['track_0', 'track_1', 'track_2']);
    // Group-level identity only (no per-frame entry yet — e.g. a fresh Group).
    const g = makeGroup(2, [0, 1, 2]);
    eq(groupDisplayName(s, g, FRAME), 'id_2', 'group.identityId resolves through session.identities');
    checkMessages(groupDisplayName(s, g, FRAME), 'identity');

    // Per-frame identity is preferred over a stale group.identityId (#155),
    // looked up with each member's OWN camera.
    const g2 = makeGroup(2, [0, 1]);
    s.setFrameIdentity(FRAME, 'cam1', 0, 4);
    eq(groupDisplayName(s, g2, FRAME), 'id_4', 'the per-frame identity wins over a stale group.identityId');
    eq(groupDisplayName(s, g2, FRAME + 1), 'id_2', 'and on a frame with no entry, group.identityId is used');
    // A per-frame entry for the same trackIdx in ANOTHER camera is not this group's.
    const g3 = makeGroup(-1, [1]);
    s.setFrameIdentity(FRAME, 'cam2', 1, 3);
    eq(groupDisplayName(s, g3, FRAME), 'track_1', 'a same-numbered track in another camera does not name it');

    // Explicit "no identity" marker falls through, it is not printed.
    const g4 = makeGroup(1, [2]);
    s.setFrameIdentity(FRAME, 'cam1', 2, -1);
    eq(groupDisplayName(s, g4, FRAME), 'id_1', 'an explicit no-identity marker falls through to group.identityId');

    // A renamed identity is named as renamed.
    s.getIdentity(3).name = 'Mouse C';
    eq(groupDisplayName(s, makeGroup(3, [null]), FRAME), 'Mouse C', 'a renamed identity is named as renamed');
}

console.log('\n2. A trackless group with no identity gets the neutral wording');
{
    const s = makeSession(['track_0']);
    for (const [label, id] of [['identityId -1', -1], ['identityId null', null], ['identityId undefined', undefined]]) {
        const g = makeGroup(-1, [null, null, null]);
        g.identityId = id;
        const name = groupDisplayName(s, g, FRAME);
        eq(name, 'group', `members trackIdx null, ${label}`);
        checkMessages(name, `trackless, ${label}`);
    }
    // Pre-#273 lazy hydration wrote -1 for a trackless instance.
    const gNeg = makeGroup(-1, [-1, -1]);
    eq(groupDisplayName(s, gNeg, FRAME), 'group', 'members trackIdx -1 are trackless too, not "Track -1"');
    // An identity id with no identity behind it is not printed either.
    eq(groupDisplayName(s, makeGroup(99, [null]), FRAME), 'group', 'a dangling identityId is skipped');
    eq(groupDisplayName(s, new InstanceGroup(1, -1), FRAME), 'group', 'an empty group');
    eq(groupDisplayName(s, null, FRAME), 'group', 'a null group');
    eq(groupDisplayName(null, makeGroup(2, [0]), FRAME), 'Track 0', 'no session: a member\'s track index still names it');
}

console.log('\n3. A group whose members have tracks is named by the track');
{
    const s = makeSession(['track_0', 'track_1', 'track_2']);
    const g = makeGroup(-1, [null, 1, 2]);   // first member trackless
    eq(groupDisplayName(s, g, FRAME), 'track_1', 'the first member WITH a track names it');
    checkMessages(groupDisplayName(s, g, FRAME), 'tracked');
    const gNoName = makeGroup(-1, [5]);
    eq(groupDisplayName(s, gNoName, FRAME), 'Track 5', 'a track index with no name reads "Track N", as the 2D labels do');
    checkMessages(groupDisplayName(s, gNoName, FRAME), 'unnamed track');
    // Without a frame there is no per-frame step, but the group identity still wins.
    eq(groupDisplayName(s, makeGroup(0, [1]), undefined), 'id_0', 'no frameIdx: group.identityId before the track');
}

console.log('\n4. The handlers in pose/initialization.js use it');
{
    // pose/initialization.js imports the UI and cannot be loaded under Node, so
    // this pins the call sites in the source instead.
    const src = readFileSync(path.join(ROOT, 'pose', 'initialization.js'), 'utf8');
    const body = (name) => {
        const i = src.indexOf(name + ': function');
        const j = src.indexOf('\n        },', i);
        return i >= 0 && j > i ? src.slice(i, j) : '';
    };
    for (const h of ['onInstanceConverted', 'onClonePredictedGroup', 'onDoubleClickReprojected',
                     'onInstanceDeleted', 'onAssignmentGroupCreated']) {
        check(body(h).includes('groupDisplayName(state.session, '), `${h} names its group with groupDisplayName`);
    }
    check(!/tracks\[\s*\w+\.trackIdx\s*\]/.test(body('onInstanceConverted')),
        'onInstanceConverted no longer reads a group\'s (nonexistent) trackIdx');
    check(!/tracks\[[^\]]*identityId\s*\]/.test(src),
        'no handler indexes session.tracks by an identity id');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
