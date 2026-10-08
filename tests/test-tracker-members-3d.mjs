/**
 * test-tracker-members-3d.mjs — a group committed by Track All carries 3D
 * solved from ITS OWN MEMBERS only, never from a stale view the tracker target
 * still holds for association.
 *
 * `CrossViewTracker` keeps a camera's last detection on a target for up to
 * `stale` frames after that camera stops matching it (THE STALE-ANCHOR FIX in
 * pose/cross-view-tracker.js), and `_retriangulate` fuses it into
 * `target.points3d`. That is deliberate for matching. `commitTrackedFrame`
 * (pose/tracker.js) makes only the detections of the CURRENT frame the group's
 * members, but used to store `target.points3d` as the group's 3D — so a camera
 * that missed a moving animal pulled the saved, exported and drawn 3D toward
 * where the animal was up to `stale` frames earlier. Measured on the six
 * proofread SLAP sessions: 30% of committed groups, node shift median 1.0 mm,
 * p99 135 mm.
 *
 * The fixture MOVES the animal while one camera misses it. A static animal
 * cannot test this: its stale detection equals a fresh one, every solve agrees,
 * and the test passes on the broken build. §1 asserts the fixture really
 * separates the two solves, so it cannot silently stop testing that.
 *
 * Drives the REAL `runCrossViewTracker` / `CrossViewTracker` /
 * `commitTrackedFrame` headlessly (UI stubbed via scripts/bench/hooks.mjs),
 * with the app's default tracking thresholds (stale 20, gate off).
 *
 * Run:  node tests/test-tracker-members-3d.mjs
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const POSE_DIR = path.join(ROOT, 'pose');

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function eq(a, e, m) { ok(a === e, `${m} (expected ${e}, got ${a})`); }
function group(n) { console.log('\n• ' + n); }

globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;

register(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'hooks.mjs')).href);
const { Camera, Instance, FrameGroup, Session } =
    await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
const { runCrossViewTracker, commitTrackedFrame } =
    await import(pathToFileURL(path.join(POSE_DIR, 'tracker.js')).href);
// A namespace import, so a missing export (the pre-fix build has no
// `membersPoints3d`) fails §4 rather than the whole file at link time.
const XV = await import(pathToFileURL(path.join(POSE_DIR, 'cross-view-tracker.js')).href);
const { CrossViewTracker, Detection, normalizePoint } = XV;
const { triangulatePoints } = await import(pathToFileURL(path.join(POSE_DIR, 'triangulation.js')).href);

// --- rig: three well-separated views, none at [I|0] ---------------------------
const NODES = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
function mk(name, rvec, tvec) {
    return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
}
const CAMS = [mk('c0', [0, 0, 0], [0, 0, 40]), mk('c1', [0, 0.35, 0], [-12, 0, 43]), mk('c2', [0.35, 0, 0], [0, -12, 43])];
const OFF = [[0, 0, 0], [2, 1, 0], [-2, 1, 0], [0, -2, 1], [1.5, 0, -1.5], [-1.5, 0, 1.5]];
const nodes3d = c => OFF.map(o => [c[0] + o[0], c[1] + o[1], c[2] + o[2]]);

// Animal A walks +1.5/frame along x; animal B stands still. Camera c2 misses A
// on MISS frames (A is still seen by c0 and c1), so A's target keeps c2's frame-2
// detection as a stale view while A moves 1.5–4.5 units away from it.
const N_FRAMES = 9;
const MISS = new Set([3, 4, 5]);
const centroidA = f => [-6 + 1.5 * f, 0, 8];
const centroidB = () => [8, 0, 8];

function pixelsOf(ctr, cam) { return nodes3d(ctr).map(p => cam.project(p)); }

function buildSession() {
    const s = new Session(CAMS, { nodes: NODES }, [], 'members-3d');
    for (let f = 0; f < N_FRAMES; f++) {
        const fg = new FrameGroup(f);
        for (const cam of CAMS) {
            if (!(cam.name === 'c2' && MISS.has(f))) fg.addInstance(cam.name, new Instance(pixelsOf(centroidA(f), cam), 0, 'predicted', 1.0));
            fg.addInstance(cam.name, new Instance(pixelsOf(centroidB(), cam), 1, 'predicted', 1.0));
        }
        s.addFrameGroup(fg);
    }
    return s;
}

// The tracker's own convention: normalized points against the bare extrinsic,
// one view per camera, in the order given.
function dlt(views) {
    const obs = OFF.map((_, k) => views.map(v => normalizePoint(v.pixels[k], v.cam)));
    return triangulatePoints(obs, views.map(v => v.cam.extrinsicMatrix));
}
function bitEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
}
function maxAbsDiff(a, b) {
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
}
function maxErrToTruth(p3, ctr) {
    const t = nodes3d(ctr);
    let m = 0;
    for (let k = 0; k < t.length; k++) for (let d = 0; d < 3; d++) m = Math.max(m, Math.abs(p3[3 * k + d] - t[k][d]));
    return m;
}
const byCam = name => CAMS.find(c => c.name === name);
// Which group is animal A: the one whose c0 member is A's instance (trackIdx 0).
const groupOfA = groups => groups.find(g => g.getInstance('c0') && g.getInstance('c0').trackIdx === 0);

// ===========================================================================
group('§1 Track All: a camera that missed a MOVING animal does not reach its 3D');
{
    const s = buildSession();
    runCrossViewTracker(s, s.cameras, s.frameIndices, false);
    eq(s.identities.length, 2, 'two identities (the fixture tracks cleanly)');
    for (const f of MISS) {
        const groups = s.instanceGroups.get(f) || [];
        const gA = groupOfA(groups);
        ok(!!gA, `frame ${f}: animal A was committed`);
        if (!gA) continue;
        eq(gA.cameraNames.slice().sort().join(','), 'c0,c1', `frame ${f}: A's members are the two cameras that saw it`);
        const members = dlt(gA.cameraNames.map(n => ({ cam: byCam(n), pixels: pixelsOf(centroidA(f), byCam(n)) })));
        // What the target fuses: the members plus c2's last detection (frame 2).
        const staleIncluded = dlt([
            { cam: byCam('c0'), pixels: pixelsOf(centroidA(f), byCam('c0')) },
            { cam: byCam('c1'), pixels: pixelsOf(centroidA(f), byCam('c1')) },
            { cam: byCam('c2'), pixels: pixelsOf(centroidA(2), byCam('c2')) },
        ]);
        // The fixture must actually separate the two solves, or nothing below is tested.
        ok(maxAbsDiff(staleIncluded, members) > 0.1,
            `frame ${f}: the fixture moves A far enough that the stale-included solve is off (${maxAbsDiff(staleIncluded, members).toFixed(3)} > 0.1)`);
        ok(bitEqual(gA.points3d, members), `frame ${f}: A's 3D is EXACTLY the members-only DLT`);
        ok(maxAbsDiff(gA.points3d, staleIncluded) > 0.1,
            `frame ${f}: A's 3D is not the stale-included solve (diff ${maxAbsDiff(gA.points3d, staleIncluded).toFixed(3)})`);
        ok(maxErrToTruth(gA.points3d, centroidA(f)) < 1e-6,
            `frame ${f}: A's 3D lands on where A IS (err ${maxErrToTruth(gA.points3d, centroidA(f)).toExponential(2)})`);
    }
}

// ===========================================================================
group('§2 the common case is untouched: no stale view ⇒ the target\'s own 3D, bit for bit');
{
    // Drive the tracker by hand so the target is visible at commit time.
    const s = buildSession();
    const trk = new CrossViewTracker({ corr2dWeight: 1, corr3dWeight: 6, velocityThreshold: 10, distanceThreshold: 25, timePenalty: 0.1, stale: 20 });
    const trackToIdentity = new Map();
    let checkedFresh = 0, checkedStale = 0;
    for (let f = 0; f < N_FRAMES; f++) {
        const fg = s.getFrameGroup(f);
        const dets = new Map();
        for (const cam of CAMS) {
            dets.set(cam.name, (fg.getInstances(cam.name) || []).map((inst, i) => {
                const d = new Detection(inst, cam, f, i); d.unlinkedId = null; return d;
            }));
        }
        trk.trackFrame(dets, CAMS);
        // Snapshot each target's 3D and staleness BEFORE commit reads it.
        const snap = trk.targets.map(t => ({
            t, p3: t.points3d ? Float64Array.from(t.points3d) : null,
            stale: Array.from(t.detsByCam.values()).some(d => d.frameIdx !== f),
        }));
        const before = (s.instanceGroups.get(f) || []).length;
        commitTrackedFrame(s, trk, f, trackToIdentity);
        const added = (s.instanceGroups.get(f) || []).slice(before);
        for (const g of added) {
            const sn = snap.find(x => trackToIdentity.get(x.t.trackId) === g.identityId);
            if (!sn) continue;
            if (!sn.stale) {
                checkedFresh++;
                ok(bitEqual(g.points3d, sn.p3), `frame ${f}: a target with no stale view commits its points3d unchanged`);
                ok(g.points3d !== sn.t.points3d, `frame ${f}: …as a COPY, not the target's live array`);
            } else {
                checkedStale++;
                ok(!bitEqual(g.points3d, sn.p3), `frame ${f}: a target holding a stale view does NOT commit its own points3d`);
            }
        }
    }
    eq(checkedStale, MISS.size, 'one stale-view commit per MISS frame (A only)');
    ok(checkedFresh >= 2 * N_FRAMES - MISS.size, `every other commit was checked for bit-identity (${checkedFresh})`);
}

// ===========================================================================
group('§3 identities stay continuous through the miss');
{
    // The fix writes only group.points3d, which the tracker never reads back, so
    // it cannot move an identity; Track All's identity output was checked
    // bit-identical before/after on six real sessions (see the PR). Here: the
    // fixture's identities are the right ones on every frame, the miss included.
    const s = buildSession();
    runCrossViewTracker(s, s.cameras, s.frameIndices, false);
    const idOf = (f, trackIdx) => {
        const g = (s.instanceGroups.get(f) || []).find(x => x.getInstance('c0') && x.getInstance('c0').trackIdx === trackIdx);
        return g ? g.identityId : null;
    };
    const idA = idOf(0, 0), idB = idOf(0, 1);
    ok(idA != null && idB != null && idA !== idB, 'A and B get distinct identities on frame 0');
    let contA = true, contB = true, mapOk = true;
    for (let f = 0; f < N_FRAMES; f++) {
        if (idOf(f, 0) !== idA) contA = false;
        if (idOf(f, 1) !== idB) contB = false;
        for (const cam of CAMS) {
            if (cam.name === 'c2' && MISS.has(f)) {
                if (s.getFrameIdentityValue(f, 'c2', 0) != null) mapOk = false;   // c2 never saw A here
                continue;
            }
            if (s.getFrameIdentityValue(f, cam.name, 0) !== idA) mapOk = false;
            if (s.getFrameIdentityValue(f, cam.name, 1) !== idB) mapOk = false;
        }
    }
    ok(contA, "A keeps one identity on every frame, through c2's miss");
    ok(contB, 'B keeps one identity on every frame');
    ok(mapOk, 'the per-frame identity map agrees with the groups on every (frame, camera)');
}

// ===========================================================================
group('§4 membersPoints3d — the helper commitTrackedFrame uses');
{
    const fn = XV.membersPoints3d;
    ok(typeof fn === 'function', 'cross-view-tracker.js exports membersPoints3d');
    if (typeof fn === 'function') {
        const live = new Float64Array([1, 2, 3]);
        const fresh = (cam, f) => new Detection(new Instance(pixelsOf(centroidA(f), cam), 0, 'predicted', 1.0), cam, f, 0);
        const t = { points3d: live, detsByCam: new Map([['c0', fresh(CAMS[0], 7)], ['c1', fresh(CAMS[1], 7)]]) };
        ok(fn(t, 7) === live, 'no stale view → returns target.points3d itself (no re-solve)');
        t.detsByCam.set('c2', fresh(CAMS[2], 4));
        const r = fn(t, 7);
        ok(r !== live && bitEqual(r, dlt([0, 1].map(i => ({ cam: CAMS[i], pixels: pixelsOf(centroidA(7), CAMS[i]) })))),
            'a stale view → the DLT over the frame\'s detections only, same convention as _retriangulate');
        const lone = { points3d: live, detsByCam: new Map([['c0', fresh(CAMS[0], 7)], ['c2', fresh(CAMS[2], 4)]]) };
        eq(fn(lone, 7), null, 'fewer than two members → null (nothing to triangulate)');
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error('\nFailures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
