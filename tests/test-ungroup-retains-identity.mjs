/**
 * test-ungroup-retains-identity.mjs — luc3d #201.
 *
 * Ungrouping an InstanceGroup must not destroy the identity its members were
 * carrying. The reported workflow (from an alpha tester asking "how does one
 * swap IDs in only one view?") is:
 *
 *     ungroup both groups  ->  change the ID on ONE view's row  ->  regroup
 *
 * and step 1 was resetting every row's ID dropdown to "—".
 *
 * Every identity reader for an UNLINKED instance resolves it exactly one way —
 * `session.getIdentityIdForTrack(camName, instance.trackIdx, frameIdx)`, i.e.
 * `frameIdentityMap`, with no group-level fallback available:
 * `ui/info-panel.js`'s Ungrouped row, `ui/overlays.js` `getInstanceColor`, and
 * the export paths. The GROUPED row falls back to `group.identityId`, but
 * `Session.unlinkGroup` drops the group object, so that value is gone. So the
 * fix is for `unlinkGroup` to stamp the identity into the map, and these tests
 * assert on that same resolution.
 *
 * Run:  node tests/test-ungroup-retains-identity.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const POSE_DIR = path.join(ROOT, 'pose');

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function eq(a, e, m) { ok(a === e, `${m} (expected ${e}, got ${a})`); }
function group(n) { console.log('\n• ' + n); }

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };

const { Camera, Instance, Session, Skeleton, InstanceGroup } =
    await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);

// --------------------------------------------------------------------------
// Fixture: 3 cameras, 2 animals, one frame, both animals grouped with an
// identity — the state a Track All / Triangulate All run leaves behind.
// --------------------------------------------------------------------------

const CAM_NAMES = ['cam0', 'cam1', 'cam2'];
const FRAME = 7;

function makeCam(name) {
    return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
        [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 10], [640, 480]);
}

function makeSkeleton() {
    return new Skeleton(['a', 'b'], [[0, 1]]);
}

function pts(seed) {
    return [[seed, seed], [seed + 5, seed + 5]];
}

/**
 * @param {boolean} writeFrameIdentities - whether to write the per-frame
 *   `frameIdentityMap` entries the tracker path (`commitTrackedFrame`) writes.
 *   Grouping paths that go through `assignIdentityToGroup` /
 *   `createGroupFromUnlinked` do NOT write them, so both states are real.
 */
function makeSession(writeFrameIdentities) {
    const cams = CAM_NAMES.map(makeCam);
    const session = new Session(cams, makeSkeleton(), ['track0', 'track1'], 'S');
    const idA = session.addIdentity('animal_A');
    const idB = session.addIdentity('animal_B');

    session.getOrCreateFrameGroup
        ? session.getOrCreateFrameGroup(FRAME)
        : null;
    const fg = session.frameGroups.get(FRAME) || (function () {
        // Session has no public creator in every build — mirror addUnlinkedInstance's
        // lazy creation by routing one instance through it, then clear.
        session.addUnlinkedInstance(FRAME, CAM_NAMES[0], new Instance(pts(0), 0, 'user', 1));
        const g = session.frameGroups.get(FRAME);
        g.unlinkedInstances.clear();
        return g;
    })();

    const groups = [];
    [[idA.id, 0], [idB.id, 1]].forEach(function (pair, animal) {
        const identityId = pair[0], trackIdx = pair[1];
        const g = new InstanceGroup(100 + animal, identityId);
        CAM_NAMES.forEach(function (cn, ci) {
            const inst = new Instance(pts(10 * animal + ci), trackIdx, 'predicted', 0.9);
            g.addInstance(cn, inst);
            fg.addInstance(cn, inst);
            if (writeFrameIdentities) {
                session.setFrameIdentity(FRAME, cn, trackIdx, identityId);
            }
        });
        if (!session.instanceGroups.has(FRAME)) session.instanceGroups.set(FRAME, []);
        session.instanceGroups.get(FRAME).push(g);
        groups.push(g);
    });

    return { session, fg, groups, idA: idA.id, idB: idB.id };
}

/**
 * What the Ungrouped Instances row shows, verbatim from `ui/info-panel.js`
 * (and what `getInstanceColor` colors it by): the per-frame entry, full stop.
 */
function rowIdentity(session, ul) {
    const v = session.getIdentityIdForTrack(ul.cameraName, ul.instance.trackIdx, FRAME);
    return v != null && v >= 0 ? v : null;
}

// --------------------------------------------------------------------------

group('unlinkGroup retains identity — group had per-frame entries (tracker path)');
{
    const env = makeSession(true);
    const unlinked = env.session.unlinkGroup(FRAME, env.groups[0]);
    eq(unlinked.length, 3, 'all three views land in the unlinked pool');
    unlinked.forEach(function (ul) {
        eq(rowIdentity(env.session, ul), env.idA,
            'row for ' + ul.cameraName + ' still reads animal_A');
    });
}

group('unlinkGroup retains identity — group had NO per-frame entries');
{
    // This is the case that reads "—" without the fix: the identity lived only
    // on `group.identityId` (assignIdentityToGroup / createGroupFromUnlinked
    // never write frameIdentityMap), and unlinkGroup discards the group.
    const env = makeSession(false);
    const unlinked = env.session.unlinkGroup(FRAME, env.groups[1]);
    eq(unlinked.length, 3, 'all three views land in the unlinked pool');
    unlinked.forEach(function (ul) {
        eq(rowIdentity(env.session, ul), env.idB,
            'row for ' + ul.cameraName + ' still reads animal_B');
    });
}

group('retention never overwrites a positive per-frame entry');
{
    // The per-frame entry is what the grouped row and the 2D color path already
    // PREFER over group.identityId, so claiming the key for the group's own
    // (possibly stale) field would change the displayed identity, not preserve it.
    const env = makeSession(true);
    env.session.setFrameIdentity(FRAME, CAM_NAMES[1], 0, env.idB);
    env.session.unlinkGroup(FRAME, env.groups[0]);
    eq(env.session.getFrameIdentityValue(FRAME, CAM_NAMES[1], 0), env.idB,
        'the pre-existing positive entry is left alone');
}

group('retention skips a raw-trackIdx key still shared with another group');
{
    // `commitTrackedFrame`'s collision guard marks an ambiguous
    // (frame, camera, trackIdx) with -1 when one camera's raw tracker gives two
    // different animals the same trackIdx. That key cannot name one animal, so
    // the departing group must not claim it — the group still holding it would
    // be mis-colored.
    const env = makeSession(false);
    env.groups[1].instances.get(CAM_NAMES[1]).trackIdx = 0;   // collide with group A
    env.session.setFrameIdentity(FRAME, CAM_NAMES[1], 0, -1);
    env.session.unlinkGroup(FRAME, env.groups[0]);
    eq(env.session.getFrameIdentityValue(FRAME, CAM_NAMES[1], 0), -1,
        'the ambiguous key keeps its explicit -1 marker');
    // The views that are NOT ambiguous still retain, so the ungroup is not
    // wholesale abandoned because one camera collided.
    eq(env.session.getIdentityIdForTrack(CAM_NAMES[0], 0, FRAME), env.idA,
        'the unambiguous views still retain animal_A');
}

group('retention skips trackless members rather than claiming the shared null slot');
{
    const env = makeSession(false);
    CAM_NAMES.forEach(function (cn) { env.groups[0].instances.get(cn).trackIdx = null; });
    const unlinked = env.session.unlinkGroup(FRAME, env.groups[0]);
    unlinked.forEach(function (ul) {
        eq(env.session.getFrameIdentityValue(FRAME, ul.cameraName, null), undefined,
            'no entry written to the trackless slot for ' + ul.cameraName);
    });
}

group('a group with no identity stays identity-less through ungroup');
{
    const env = makeSession(false);
    env.groups[0].identityId = -1;
    const unlinked = env.session.unlinkGroup(FRAME, env.groups[0]);
    unlinked.forEach(function (ul) {
        eq(rowIdentity(env.session, ul), null,
            'row for ' + ul.cameraName + ' reads no identity');
    });
}

group('regroup honors the retained identity instead of deriving one from the raw track');
{
    // The other half of the tester's round trip. `createGroupFromUnlinked` with
    // no explicit identity derived "id_<trackIdx>" from the first member's RAW
    // track index, so ungroup -> regroup renamed the animal.
    const env = makeSession(true);
    const unlinked = env.session.unlinkGroup(FRAME, env.groups[1]);
    const regrouped = env.session.createGroupFromUnlinked(FRAME, unlinked);
    eq(regrouped.identityId, env.idB, 'regrouped group is still animal_B');
}

group('an explicit identity argument still wins over the retained one');
{
    const env = makeSession(true);
    const unlinked = env.session.unlinkGroup(FRAME, env.groups[0]);
    const regrouped = env.session.createGroupFromUnlinked(FRAME, unlinked, env.idB);
    eq(regrouped.identityId, env.idB, 'caller-supplied identity is respected');
}

// --------------------------------------------------------------------------
// swapIdentitiesForwardInCamera — the single-view correction primitive.
// --------------------------------------------------------------------------

/** Multi-frame fixture: 2 animals x 3 cameras x frames 0..9, all identified. */
function makeMultiFrame() {
    const cams = CAM_NAMES.map(makeCam);
    const session = new Session(cams, makeSkeleton(), ['track0', 'track1'], 'S');
    const idA = session.addIdentity('animal_A');
    const idB = session.addIdentity('animal_B');
    for (let f = 0; f < 10; f++) {
        CAM_NAMES.forEach(function (cn) {
            session.setFrameIdentity(f, cn, 0, idA.id);
            session.setFrameIdentity(f, cn, 1, idB.id);
        });
    }
    return { session, idA: idA.id, idB: idB.id };
}

group('swapIdentitiesForwardInCamera — only the named camera changes');
{
    const env = makeMultiFrame();
    const r = env.session.swapIdentitiesForwardInCamera(4, CAM_NAMES[1], env.idA, env.idB);
    eq(r.frames, 6, 'reports frames 4..9 touched');
    eq(r.entries, 12, 'reports 2 tracks x 6 frames of entries changed');

    // cam1 is swapped from frame 4 on...
    eq(env.session.getIdentityIdForTrack(CAM_NAMES[1], 0, 9), env.idB,
        'cam1 track0 reads animal_B at frame 9');
    eq(env.session.getIdentityIdForTrack(CAM_NAMES[1], 1, 9), env.idA,
        'cam1 track1 reads animal_A at frame 9');
    // ...and untouched before it.
    eq(env.session.getIdentityIdForTrack(CAM_NAMES[1], 0, 3), env.idA,
        'cam1 track0 still reads animal_A at frame 3 (before the correction)');
    // The OTHER views are completely untouched — the whole point.
    [CAM_NAMES[0], CAM_NAMES[2]].forEach(function (cn) {
        eq(env.session.getIdentityIdForTrack(cn, 0, 9), env.idA,
            cn + ' track0 still reads animal_A at frame 9');
        eq(env.session.getIdentityIdForTrack(cn, 1, 9), env.idB,
            cn + ' track1 still reads animal_B at frame 9');
    });
}

group('swapIdentitiesForwardInCamera — survives raw-track fragmentation (the #172 trap)');
{
    // The reason this swaps by identity VALUE rather than following a raw track:
    // real per-camera tracker output renumbers the same animal partway through.
    const env = makeMultiFrame();
    for (let f = 5; f < 10; f++) {
        env.session.deleteFrameIdentity(f, CAM_NAMES[1], 0);
        env.session.setFrameIdentity(f, CAM_NAMES[1], 7, env.idA);   // track 0 -> 7
    }
    env.session.swapIdentitiesForwardInCamera(0, CAM_NAMES[1], env.idA, env.idB);
    eq(env.session.getIdentityIdForTrack(CAM_NAMES[1], 0, 2), env.idB,
        'the pre-fragment track is swapped');
    eq(env.session.getIdentityIdForTrack(CAM_NAMES[1], 7, 9), env.idB,
        'the POST-fragment track (a different trackIdx) is swapped too');
}

group('swapIdentitiesForwardInCamera — leaves group-level identityId alone');
{
    // `InstanceGroup.identityId` is one field shared by every view, so a
    // single-view correction must not touch it.
    const env = makeSession(true);
    const before = env.groups.map(function (g) { return g.identityId; });
    env.session.swapIdentitiesForwardInCamera(0, CAM_NAMES[0], env.idA, env.idB);
    eq(env.groups.map(function (g) { return g.identityId; }).join(','), before.join(','),
        'both groups keep their identityId');
}

group('swapIdentitiesForwardInCamera — degenerate arguments are no-ops');
{
    const env = makeMultiFrame();
    eq(env.session.swapIdentitiesForwardInCamera(0, CAM_NAMES[0], env.idA, env.idA).entries, 0,
        'swapping an identity with itself changes nothing');
    eq(env.session.swapIdentitiesForwardInCamera(0, 'nope', env.idA, env.idB).entries, 0,
        'an unknown camera name changes nothing');
    eq(env.session.getIdentityIdForTrack(CAM_NAMES[0], 0, 0), env.idA,
        'the map is intact after the no-ops');
}

console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') +
    ` — ${passed} passed, ${failed} failed`);
if (failed) {
    console.error('\nFailures:');
    failures.forEach(function (f) { console.error('  - ' + f); });
    process.exit(1);
}
