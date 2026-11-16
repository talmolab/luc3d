/**
 * test-run-state.mjs — pose/run-state.js: Track and Triangulate count as run
 * once they finish, and stay so only while their result stands.
 *
 *   - Not run -> false, whatever the data holds (identities from a file, 3D
 *     from Track All).
 *   - Track: true after a run while some group has an identity.
 *   - Triangulate: true after a run while some group still holds 3D the run
 *     marked; replacing a group's array drops it, a node-move re-solve
 *     (`carryTriangulateMark`) keeps it; only the frames a run covered count.
 *   - The witness: a removed or changed witness is replaced by another group,
 *     and once nothing holds the run is forgotten and the session is not
 *     walked again.
 *
 * Run: node tests/test-run-state.mjs
 */
import {
    noteTrackRun, noteTriangulateRun, carryTriangulateMark, hasTrackResult, hasTriangulateResult,
} from '../pose/run-state.js';
import { InstanceGroup, makePoints3d, setPoint3d } from '../pose/pose-data.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) passed++;
    else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function eq(actual, expected, msg) { ok(actual === expected, `${msg} (expected ${expected}, got ${actual})`); }
function group(name) { console.log('\n• ' + name); }

function makeGroup(identityId, x, method) {
    const g = new InstanceGroup(1, identityId);
    const pts = makePoints3d(2);
    setPoint3d(pts, 0, [x, 0, 0]);
    setPoint3d(pts, 1, [x, 1, 0]);
    g.points3d = pts;
    g.triangulationMethod = method;
    return g;
}

/** A session-shaped object whose instanceGroups counts full walks. */
function makeSession(frames, perFrame, identity, method) {
    const instanceGroups = new Map();
    for (let f = 0; f < frames; f++) {
        const list = [];
        for (let a = 0; a < perFrame; a++) list.push(makeGroup(identity == null ? a : identity, f + a, method));
        instanceGroups.set(f, list);
    }
    let walks = 0;
    const iter = instanceGroups[Symbol.iterator].bind(instanceGroups);
    instanceGroups[Symbol.iterator] = () => { walks++; return iter(); };
    return { session: { instanceGroups }, walks: () => walks };
}

group('not run: never blue, whatever the data holds');
{
    const { session } = makeSession(5, 2, null, 'dlt');
    eq(hasTrackResult(session), false, 'identities but no Track run');
    eq(hasTriangulateResult(session), false, 'solved 3D but no Triangulate run');
    eq(hasTrackResult(null), false, 'no session');
}

group('Track: stands while some group has an identity');
{
    const { session, walks } = makeSession(5, 2, null, undefined);
    noteTrackRun(session);
    eq(hasTrackResult(session), true, 'after a run, with identities');
    const w0 = walks();
    for (let i = 0; i < 100; i++) hasTrackResult(session);
    eq(walks(), w0, 'repeated asks re-check the witness without walking the session');
    // Take identities away from the first frame's groups (the witness).
    session.instanceGroups.get(0).forEach(g => { g.identityId = -1; });
    eq(hasTrackResult(session), true, 'witness lost its identity: another group still has one');
    for (const [, list] of session.instanceGroups) list.forEach(g => { g.identityId = -1; });
    eq(hasTrackResult(session), false, 'no identity anywhere: grey');
    const w1 = walks();
    hasTrackResult(session);
    hasTrackResult(session);
    eq(walks(), w1, 'and the run is forgotten: no more walks');
    session.instanceGroups.get(2)[0].identityId = 4;
    eq(hasTrackResult(session), false, 'an identity set later, without a run, does not count');
    noteTrackRun(session);
    eq(hasTrackResult(session), true, 'a new run counts again');

    const t = makeSession(3, 1, -1, undefined).session;
    noteTrackRun(t);
    eq(hasTrackResult(t), false, 'a run that assigned no identity: grey');
}

group('Triangulate: stands while some group holds 3D the run marked');
{
    const { session, walks } = makeSession(6, 2, null, 'dlt');
    noteTriangulateRun(session, null);
    eq(hasTriangulateResult(session), true, 'after an all-frames run');
    const w0 = walks();
    for (let i = 0; i < 100; i++) hasTriangulateResult(session);
    eq(walks(), w0, 'repeated asks do not walk the session');

    // A node move re-solves into a new array: still the run's result.
    const g = session.instanceGroups.get(0)[0];
    const moved = makePoints3d(2);
    carryTriangulateMark(g.points3d, moved);
    g.points3d = moved;
    eq(hasTriangulateResult(session), true, 'a node-move re-solve keeps it');

    // Replace every group's 3D, as Track All's own 3D does: grey.
    for (const [, list] of session.instanceGroups) list.forEach(x => { x.points3d = makePoints3d(2); });
    eq(hasTriangulateResult(session), false, 'every array replaced: grey');
    const w1 = walks();
    hasTriangulateResult(session);
    eq(walks(), w1, 'and the run is forgotten: no more walks');
}
{
    // The witness group removed from its frame: another one is found.
    const { session } = makeSession(4, 1, null, 'dlt');
    noteTriangulateRun(session, null);
    eq(hasTriangulateResult(session), true, 'precondition: blue');
    session.instanceGroups.set(0, []);
    eq(hasTriangulateResult(session), true, 'witness group removed: another group still holds');
    session.instanceGroups.clear();
    for (let f = 0; f < 4; f++) session.instanceGroups.set(f, [makeGroup(0, f, 'dlt')]);
    eq(hasTriangulateResult(session), false, 'all groups rebuilt (re-tracked): grey');
}
{
    // Only the frames a run covered, and only groups it left solved.
    const { session } = makeSession(5, 1, null, 'dlt');
    session.instanceGroups.get(3)[0].triangulationMethod = undefined;   // e.g. Track All's 3D
    noteTriangulateRun(session, [3]);
    eq(hasTriangulateResult(session), false, 'a group with no solve method is not marked');
    noteTriangulateRun(session, [2]);
    eq(hasTriangulateResult(session), true, 'a this-frame run on a solved group counts');
    session.instanceGroups.get(2)[0].points3d = makePoints3d(2);
    eq(hasTriangulateResult(session), false, 'only frame 2 was run: replacing it leaves nothing');
    const empty = makeSession(2, 1, null, 'dlt').session;
    for (const [, list] of empty.instanceGroups) list.forEach(x => { x.points3d = makePoints3d(2); });   // all-NaN
    noteTriangulateRun(empty, null);
    eq(hasTriangulateResult(empty), false, 'groups without any valid 3D are not marked');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
    console.error('\nFailures:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
