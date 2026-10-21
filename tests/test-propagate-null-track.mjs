/**
 * test-propagate-null-track.mjs — luc3d #111.
 *
 * "Propagate IDs → Tracks" must give an identified instance its identity's
 * track even when that instance arrives with NO track. It did not: the whole
 * identity lookup in `remapInstance` was gated on `inst.trackIdx != null`, so
 * every untracked detection was skipped — and an identity carried ONLY by
 * trackless instances never even got a track minted, because step 1 built its
 * "used identities" set from `frameIdentityMap` alone, which is keyed by raw
 * trackIdx and cannot represent a null track.
 *
 * Reported from the Grouped Instances panel: after Track All the row for `id_2`
 * reads `TRACK (none)`, and after Propagate IDs → Tracks it STILL reads
 * `(none)` while every other row becomes track_0/1/3. On the real
 * `10072022145420_small` session that is 10,775 group members left trackless,
 * under a plain success message.
 *
 * ## The two spellings of "no track" both have to work
 *
 * They come from different load paths and only ONE of them was ever exercised
 * by a passing test:
 *
 *   null   `import-export/slp-import.js` ("A null trackIdx means the instance
 *          is trackless — keep it null") — i.e. File ▸ Load Single Session
 *          Folder, the per-camera `.slp` import. THIS is the broken one.
 *   -1     the lazy columnar store (File ▸ Load Project on a `project.slp`).
 *          This one worked, because `-1 != null` passes the old guard.
 *
 * `Session._fimKey` normalizes both to one slot, so a fixture using only `-1`
 * passes against the BROKEN build. Several cases below therefore run both
 * spellings over the same scenario — that is the point of `forEachNullish`.
 *
 * Run:  node tests/test-propagate-null-track.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const POSE_DIR = path.join(ROOT, 'pose');

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function eq(a, e, m) { ok(a === e, `${m} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`); }
function eqArr(a, e, m) {
    ok(JSON.stringify(a) === JSON.stringify(e), `${m} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`);
}
function group(n) { console.log('\n• ' + n); }

globalThis.window = globalThis;
globalThis.document = { getElementById: () => null };

const { Camera, Instance, Skeleton, Session, FrameGroup, InstanceGroup, UnlinkedInstance } =
    await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);

const CAMS = ['cam0', 'cam1', 'cam2'];
const makeCam = (n) => new Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 10], [640, 480]);
const makeSkel = () => new Skeleton('s', ['a', 'b'], [[0, 1]]);
const pts = (s) => [[s, s], [s + 5, s + 5]];

/** Run `fn` for both spellings of "no track", so neither can rot unnoticed. */
function forEachNullish(fn) {
    [['null', null], ['-1', -1]].forEach(([label, v]) => fn(v, label));
}

/** Track NAME an instance resolves to, or null when it is trackless. */
const trackNameOf = (session, inst) =>
    (inst.trackIdx == null || inst.trackIdx < 0) ? null : session.tracks[inst.trackIdx];

// --------------------------------------------------------------------------
// §1 The reported case: the tracker grouped + identified untracked detections.
//
// `commitTrackedFrame` DOES write a frameIdentityMap entry for them (under the
// shared null/-1 slot), so the track is minted either way — what was missing is
// the assignment. Mirrors the real session: two animals that carry a raw track,
// one that does not.
// --------------------------------------------------------------------------
function trackerFixture(noTrack) {
    const session = new Session(CAMS.map(makeCam), makeSkel(), ['global_1', 'global_2'], 'S');
    const idA = session.addIdentity('id_0').id;
    const idB = session.addIdentity('id_1').id;
    const idC = session.addIdentity('id_2').id;

    const fg = new FrameGroup(0);
    session.addFrameGroup(fg);
    const mk = (trackIdx, seed) => new Instance(pts(seed), trackIdx, 'predicted', 0.9);
    const groups = [];
    [[idA, 0], [idB, 1], [idC, noTrack]].forEach(([identityId, trackIdx], gi) => {
        const g = new InstanceGroup(gi + 1, identityId);
        CAMS.forEach((cn, ci) => {
            const inst = mk(trackIdx, 10 * gi + ci);
            fg.addInstance(cn, inst);
            g.addInstance(cn, inst);
            // What the tracker writes. For the untracked animal this lands in the
            // shared null/-1 slot — present, but unable to name an individual.
            session.setFrameIdentity(0, cn, trackIdx, identityId);
        });
        groups.push(g);
    });
    session.instanceGroups.set(0, groups);
    return { session, groups, idA, idB, idC };
}

forEachNullish((noTrack, label) => {
    group(`§1 tracker-grouped untracked detections (trackIdx = ${label})`);
    const { session, groups } = trackerFixture(noTrack);

    for (const g of groups[2].instances.values()) {
        ok(g.trackIdx == null || g.trackIdx < 0, 'precondition: id_2 starts with no track');
    }

    const res = session.propagateIdentitiesToTracks();

    eq(res.tracks, 3, 'one track per identity, including the untracked animal\'s');
    // An auto-generated `id_N` identity name is deliberately NOT used verbatim as
    // a track name (`AUTO_IDENTITY_NAME_RE`) — it becomes `track_N`, so a
    // Tracks→IDs→Tracks round trip restores the app's own naming.
    eqArr(session.tracks, ['track_0', 'track_1', 'track_2'], 'one track per identity, in identity order');
    groups.forEach((g, gi) => {
        for (const [cn, inst] of g.instances) {
            eq(trackNameOf(session, inst), 'track_' + gi,
                `group ${gi} / ${cn} lands on its identity's track`);
        }
    });
    // The regression in one line: this is what the panel's TRACK dropdown reads.
    const first = groups[2].instances.values().next().value;
    eq(trackNameOf(session, first), 'track_2',
        'the panel\'s TRACK dropdown no longer reads "(none)" for the untracked animal');
});

// --------------------------------------------------------------------------
// §2 Identity ONLY on the group — no frameIdentityMap entry at all.
//
// Hand annotation: `+ Instance` → Group → set the group's ID. Nothing writes
// the map (only the tracker does), so step 1's used-identity set had no way to
// learn this identity exists and minted NO track for it. §1 cannot catch this:
// there the tracker had written an entry.
// --------------------------------------------------------------------------
forEachNullish((noTrack, label) => {
    group(`§2 identity only on group.identityId, no map entry (trackIdx = ${label})`);
    const session = new Session(CAMS.map(makeCam), makeSkel(), ['track_0'], 'S');
    const idA = session.addIdentity('Alice').id;
    const idB = session.addIdentity('Bob').id;

    const fg = new FrameGroup(0);
    session.addFrameGroup(fg);
    const gA = new InstanceGroup(1, idA), gB = new InstanceGroup(2, idB);
    CAMS.forEach((cn, ci) => {
        const a = new Instance(pts(ci), 0, 'user', 1);
        fg.addInstance(cn, a); gA.addInstance(cn, a);
        session.setFrameIdentity(0, cn, 0, idA);
        const b = new Instance(pts(50 + ci), noTrack, 'user', 1);
        fg.addInstance(cn, b); gB.addInstance(cn, b);
    });
    session.instanceGroups.set(0, [gA, gB]);

    eq(session.frameIdentityMap.size, CAMS.length, 'precondition: only Alice is in the map');

    session.propagateIdentitiesToTracks();

    ok(session.tracks.indexOf('Bob') >= 0, 'a track IS minted for an identity only the group knows');
    for (const [cn, inst] of gB.instances) {
        eq(trackNameOf(session, inst), 'Bob', `Bob / ${cn} gets his track`);
    }
    for (const [cn, inst] of gA.instances) {
        eq(trackNameOf(session, inst), 'Alice', `Alice / ${cn} is unaffected`);
    }
});

// --------------------------------------------------------------------------
// §3 Ungrouped + trackless, identity retained on the INSTANCE (luc3d #201).
// --------------------------------------------------------------------------
group('§3 ungrouped trackless instance carrying instance.identityId');
{
    const session = new Session(CAMS.map(makeCam), makeSkel(), ['track_0'], 'S');
    const idC = session.addIdentity('Carol').id;
    const fg = new FrameGroup(0);
    session.addFrameGroup(fg);
    const c = new Instance(pts(3), null, 'user', 1);
    c.identityId = idC;
    fg.addUnlinkedInstance(CAMS[0], new UnlinkedInstance(c, CAMS[0]));

    session.propagateIdentitiesToTracks();

    ok(session.tracks.indexOf('Carol') >= 0, 'a track is minted for the retained identity');
    eq(trackNameOf(session, c), 'Carol', 'the ungrouped trackless row gets its track');
}

// --------------------------------------------------------------------------
// §4 NEGATIVE CONTROLS — the fix must not invent tracks.
// --------------------------------------------------------------------------
group('§4 negative controls');
{
    // 4a. Trackless AND identity-less stays trackless.
    const session = new Session(CAMS.map(makeCam), makeSkel(), ['track_0'], 'S');
    const idA = session.addIdentity('Alice').id;
    const fg = new FrameGroup(0);
    session.addFrameGroup(fg);
    const gA = new InstanceGroup(1, idA);
    const a = new Instance(pts(1), 0, 'user', 1);
    fg.addInstance(CAMS[0], a); gA.addInstance(CAMS[0], a);
    session.setFrameIdentity(0, CAMS[0], 0, idA);
    const orphan = new Instance(pts(9), null, 'predicted', 0.5);
    fg.addUnlinkedInstance(CAMS[1], new UnlinkedInstance(orphan, CAMS[1]));
    session.instanceGroups.set(0, [gA]);

    session.propagateIdentitiesToTracks();
    eqArr(session.tracks, ['Alice'], 'no track is invented for an un-identified detection');
    eq(orphan.trackIdx, null, 'a trackless, identity-less instance stays trackless');

    // 4b. An explicit "no identity" group (identityId -1) gets nothing.
    const s2 = new Session(CAMS.map(makeCam), makeSkel(), ['track_0'], 'S');
    const idZ = s2.addIdentity('Zed').id;
    const fg2 = new FrameGroup(0);
    s2.addFrameGroup(fg2);
    const gZ = new InstanceGroup(1, idZ), gNone = new InstanceGroup(2, -1);
    const z = new Instance(pts(1), null, 'user', 1);
    fg2.addInstance(CAMS[0], z); gZ.addInstance(CAMS[0], z);
    const n = new Instance(pts(2), null, 'user', 1);
    fg2.addInstance(CAMS[1], n); gNone.addInstance(CAMS[1], n);
    s2.instanceGroups.set(0, [gZ, gNone]);

    s2.propagateIdentitiesToTracks();
    eqArr(s2.tracks, ['Zed'], 'an identityId of -1 mints no track');
    eq(n.trackIdx, null, 'a member of a "no identity" group stays trackless');
    eq(trackNameOf(s2, z), 'Zed', 'its identified sibling is still assigned');
}

// --------------------------------------------------------------------------
// §5 The shared null/-1 slot must NOT be used to name an individual.
//
// `_fimKey` folds every trackless detection in a (frame, camera) onto ONE slot,
// so when two untracked animals share a camera-frame that slot cannot say which
// is which. Resolving through it would put two instances on ONE track in one
// frame — invalid in SLEAP. The group is per-instance, so it is what decides.
// --------------------------------------------------------------------------
group('§5 two untracked animals in one camera-frame resolve per instance');
{
    const session = new Session(CAMS.map(makeCam), makeSkel(), ['track_0'], 'S');
    const idA = session.addIdentity('A').id;
    const idB = session.addIdentity('B').id;
    const fg = new FrameGroup(0);
    session.addFrameGroup(fg);
    const gA = new InstanceGroup(1, idA), gB = new InstanceGroup(2, idB);
    const a = new Instance(pts(1), null, 'predicted', 0.9);
    const b = new Instance(pts(40), null, 'predicted', 0.9);
    fg.addInstance(CAMS[0], a); fg.addInstance(CAMS[0], b);
    gA.addInstance(CAMS[0], a); gB.addInstance(CAMS[0], b);
    // Both animals' tracker writes land in the same slot; the second wins.
    session.setFrameIdentity(0, CAMS[0], null, idA);
    session.setFrameIdentity(0, CAMS[0], null, idB);
    session.instanceGroups.set(0, [gA, gB]);

    session.propagateIdentitiesToTracks();

    eq(trackNameOf(session, a), 'A', 'animal A follows its own group, not the shared slot');
    eq(trackNameOf(session, b), 'B', 'animal B follows its own group, not the shared slot');
    ok(a.trackIdx !== b.trackIdx, 'the two never collapse onto one track in one frame');
}

// --------------------------------------------------------------------------
// §6 A single-view ID switch still outranks the group FOR A TRACKED instance
//    (luc3d #201 / #183). The trackless branch is group-first; the tracked
//    branch must stay map-first, or this regresses.
// --------------------------------------------------------------------------
group('§6 tracked instances keep map-first precedence');
{
    const session = new Session(CAMS.map(makeCam), makeSkel(), ['t0'], 'S');
    const idA = session.addIdentity('A').id;
    const idB = session.addIdentity('B').id;
    const fg = new FrameGroup(0);
    session.addFrameGroup(fg);
    const g = new InstanceGroup(1, idA);
    const inst = new Instance(pts(1), 0, 'predicted', 0.9);
    fg.addInstance(CAMS[0], inst); g.addInstance(CAMS[0], inst);
    // One view switched to B; the cross-view group deliberately still says A.
    session.setFrameIdentity(0, CAMS[0], 0, idB);
    // Keep A in use elsewhere so both identities get a track.
    const other = new Instance(pts(70), 1, 'predicted', 0.9);
    fg.addInstance(CAMS[1], other);
    const gOther = new InstanceGroup(2, idA);
    gOther.addInstance(CAMS[1], other);
    session.setFrameIdentity(0, CAMS[1], 1, idA);
    session.instanceGroups.set(0, [g, gOther]);

    session.propagateIdentitiesToTracks();
    eq(trackNameOf(session, inst), 'B',
        'the per-frame map still wins over group.identityId for a TRACKED instance');
}

console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') +
    ` — ${passed} passed, ${failed} failed`);
if (failed) {
    console.error('\nFailures:');
    failures.forEach(function (f) { console.error('  - ' + f); });
    process.exit(1);
}
