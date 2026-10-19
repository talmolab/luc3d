/**
 * test-reproject-stored-3d.mjs — `reprojectStoredPoints3d` gives the numbers a
 * solve gave, from the 3D the solve stored, without solving again.
 *
 * Triangulate All keeps only each group's 3D (see `sweepTriangulateAllFrames`
 * in pose/triangulation.js), and the display derives a shown frame's
 * reprojections and errors from it (`ui/rendering.js`'s reprojection fill).
 * The display used to re-solve for that — 2.4 ms per frame with one animal
 * Refined on 17 cameras — although the stored 3D already determines every
 * number. What this pins, per value with Object.is:
 *
 *   * errors, undistorted errors, both means and the method equal those of the
 *     bulk solve (`triangulateAndReproject` over the group's member cameras,
 *     as `prep.groupCameras` does), for DLT and Refined, with distortion, a
 *     missing node, a nulled node and a camera excluded from the solve;
 *   * errors are measured in the member cameras only, and the reprojections
 *     cover every camera — a non-member's equal `reprojectPointsCamera`, as
 *     `reprojectIntoEveryCamera` makes them after a bulk solve;
 *   * the 3D is the group's own array (the fill relies on that being cheap,
 *     and the e2e test uses it to tell this path from a re-solve);
 *   * NEGATIVE CONTROL: with a reprojection-error threshold the solve drops an
 *     outlying observation, and its UNDISTORTED errors leave it out, which the
 *     stored 3D cannot reproduce — the reason the fill re-solves when a
 *     threshold is set. The native-pixel errors still agree.
 *   * `triangulationSummary` keeps the 3D and the means, nothing else.
 *
 * Run: node tests/test-reproject-stored-3d.mjs
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('  ✗ ' + msg); } }
function group(name) { console.log('\n• ' + name); }
function same(a, b) {
    if (a == null || b == null) return a === b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        if (Array.isArray(x) || Array.isArray(y)) { if (!same(x, y)) return false; }
        else if (!Object.is(x, y)) return false;
    }
    return true;
}
const keys = (o) => Object.keys(o || {}).sort().join(',');

globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;
register(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'hooks.mjs')).href);
const pd = await import(pathToFileURL(path.join(ROOT, 'pose', 'pose-data.js')).href);
const tri = await import(pathToFileURL(path.join(ROOT, 'pose', 'triangulation.js')).href);
const core = await import(pathToFileURL(path.join(ROOT, 'pose', 'triangulation-core.js')).href);

let seed = 20261019;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const rr = (a, b) => a + (b - a) * rnd();
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// Five cameras looking at the origin from different sides, with real
// distortion (kept mild so every projection stays far inside the fold radius).
const cams = [];
for (let i = 0; i < 5; i++) {
    const f = rr(900, 1200);
    cams.push(new pd.Camera('c' + i, [[f, 0, 640], [0, f, 512], [0, 0, 1]],
        [rr(-0.15, -0.05), rr(-0.02, 0.02), 0, 0, 0],
        [rr(-0.4, 0.4), rr(-0.6, 0.6), rr(-0.2, 0.2)], [rr(-50, 50), rr(-50, 50), rr(1500, 2000)], [1280, 1024]));
}
const NNODE = 12;
const truth = Array.from({ length: NNODE }, () => [rr(-150, 150), rr(-150, 150), rr(-150, 150)]);
const observe = (cam, X) => { const q = cam.distortPoint(cam.project(X)); return [q[0] + gauss() * 1.5, q[1] + gauss() * 1.5]; };

/** A group with instances in `memberIdx` cameras; node 4 is missing in c1, node 7 nulled in c0. */
function makeGroup(memberIdx, outlier) {
    const g = new pd.InstanceGroup(1, 0);
    for (const ci of memberIdx) {
        const cam = cams[ci];
        const pts = truth.map((X, k) => (ci === 1 && k === 4) ? null : observe(cam, X));
        if (outlier && ci === outlier.cam) pts[outlier.node] = [pts[outlier.node][0] + 60, pts[outlier.node][1] - 45];
        const inst = new pd.Instance(pts, 0, 'predicted', 1);
        if (ci === 0) inst.nulledNodes = new Set([7]);
        g.addInstance(cam.name, inst);
    }
    return g;
}

function compare(label, g, members, method, options) {
    const ref = tri.triangulateAndReproject(g, members, Object.assign({ method: method }, options));
    g.points3d = ref.points3d;
    g.triangulationMethod = method;
    const got = tri.reprojectStoredPoints3d(g, cams, options);
    const memberNames = members.map(c => c.name).sort().join(',');
    ok(got.points3d === g.points3d, `${label}: the 3D is the group's own array`);
    ok(got.method === method, `${label}: method ${got.method}`);
    ok(keys(got.errors) === memberNames, `${label}: errors measured in the members only (${keys(got.errors)})`);
    ok(keys(got.errorsUndistorted) === memberNames, `${label}: undistorted errors in the members only`);
    let errSame = true, undSame = true;
    for (const c of members) {
        if (!same(got.errors[c.name], ref.errors[c.name])) errSame = false;
        if (!same(got.errorsUndistorted[c.name], ref.errorsUndistorted[c.name])) undSame = false;
    }
    ok(errSame, `${label}: per-camera errors equal the solve's, value for value`);
    ok(undSame, `${label}: per-camera undistorted errors equal the solve's`);
    ok(Object.is(got.meanError, ref.meanError), `${label}: mean error ${got.meanError} vs ${ref.meanError}`);
    ok(Object.is(got.meanErrorUndistorted, ref.meanErrorUndistorted),
        `${label}: undistorted mean ${got.meanErrorUndistorted} vs ${ref.meanErrorUndistorted}`);
    ok(keys(got.reprojections) === cams.map(c => c.name).sort().join(','), `${label}: reprojections cover every camera`);
    const everyCam = tri.reprojectIntoEveryCamera(Object.assign({}, ref.reprojections), ref.points3d, cams);
    let repSame = true;
    for (const c of cams) if (!same(got.reprojections[c.name], everyCam[c.name])) repSame = false;
    ok(repSame, `${label}: reprojections equal the solve's plus reprojectIntoEveryCamera's, value for value`);
    return { ref, got };
}

for (const method of ['dlt', 'ba']) {
    group(`${method}: three member cameras of five`);
    const members = [cams[0], cams[1], cams[3]];
    const r = compare(method, makeGroup([0, 1, 3]), members, method);
    ok(r.ref.meanError > 0 && r.ref.meanError < 10, `${method}: precondition — a sane error (${r.ref.meanError.toFixed(3)} px)`);
    ok(r.got.errors.c0[7] === null && r.got.errors.c1[4] === null,
        `${method}: the nulled and the missing node carry no error`);

    group(`${method}: one member excluded from the solve (Camera Views)`);
    compare(method + ' excluded c1', makeGroup([0, 1, 3]), members, method, { includedCameras: ['c0', 'c3'] });
}

group('negative control: a reprojection-error threshold');
{
    const members = [cams[0], cams[2], cams[3], cams[4]];
    const g = makeGroup([0, 2, 3, 4], { cam: 2, node: 3 });
    const ref = tri.triangulateAndReproject(g, members, { method: 'dlt', reprojErrorThreshold: 8 });
    g.points3d = ref.points3d;
    g.triangulationMethod = 'dlt';
    const got = tri.reprojectStoredPoints3d(g, cams);
    ok(ref.errorsUndistorted.c2[3] === null, 'precondition: the solve dropped the outlying observation (c2, node 3)');
    ok(got.errorsUndistorted.c2[3] !== null && got.errorsUndistorted.c2[3] > 8,
        `the stored 3D cannot know it was dropped: undistorted error ${got.errorsUndistorted.c2[3]} — so the fill re-solves when a threshold is set`);
    ok(!Object.is(got.meanErrorUndistorted, ref.meanErrorUndistorted), 'and the undistorted mean differs');
    let errSame = true;
    for (const c of members) if (!same(got.errors[c.name], ref.errors[c.name])) errSame = false;
    ok(errSame && Object.is(got.meanError, ref.meanError), 'the native-pixel errors and mean still agree');
}

group('triangulationSummary');
{
    const g = makeGroup([0, 1, 2]);
    const r = tri.triangulateAndReproject(g, [cams[0], cams[1], cams[2]], { method: 'ba' });
    const s = core.triangulationSummary(r);
    ok(keys(s) === 'meanError,meanErrorUndistorted,method,points3d', `keys ${keys(s)}`);
    ok(s.points3d === r.points3d && Object.is(s.meanError, r.meanError) &&
        Object.is(s.meanErrorUndistorted, r.meanErrorUndistorted) && s.method === 'ba', 'values carried over');
}

group('a group with no instances');
{
    const g = new pd.InstanceGroup(2, 0);
    g.triangulationMethod = 'dlt';
    const got = tri.reprojectStoredPoints3d(g, cams);
    ok(got && keys(got.errors) === '' && got.meanError === null, 'empty result, no throw');
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
