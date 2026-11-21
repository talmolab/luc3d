/**
 * test-back-projection.mjs — `backProjectToRay(s)` (pose/triangulation-core.js)
 * cast the ray through P = [M | p4] as centre −M⁻¹·p4, direction M⁻¹·(u, v, 1).
 *
 * They used to cast it from the centre to the pseudo-inverse point P⁺·(u, v, 1),
 * which is at infinity for a camera at the world origin (P = [M | 0] makes P⁺'s
 * 4th row zero): every direction came out NaN, and Track All's 3D term silently
 * dropped that camera. campy writes cam_0 at exactly the origin. Away from the
 * origin the same point runs off to infinity along one line of the image (rays
 * perpendicular to the camera's offset from the origin), and the old rays lost
 * precision there (up to ~1e-5 on the SLAP rig).
 *
 * Run: node tests/test-back-projection.mjs
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) { if (cond) passed++; else { failed++; failures.push(msg); console.error('  ✗ ' + msg); } }
function group(name) { console.log('\n• ' + name); }

globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;
register(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'hooks.mjs')).href);
const pd = await import(pathToFileURL(path.join(ROOT, 'pose', 'pose-data.js')).href);
const core = await import(pathToFileURL(path.join(ROOT, 'pose', 'triangulation-core.js')).href);

let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const rr = (a, b) => a + (b - a) * rnd();
const finite = (v) => v != null && v.every(Number.isFinite);
const unit = (v) => Math.abs(Math.hypot(v[0], v[1], v[2]) - 1) < 1e-12;
const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
const cam = (name, rvec, tvec) => new pd.Camera(name, K, [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// Re-base the world rigidly, X' = Rw·X + tw: a camera's R' = R·Rwᵀ, t' = t − R'·tw.
function rebaseCam(c, Rw, tw) {
    const R = c.rotationMatrix;
    const R2 = [0, 1, 2].map(i => [0, 1, 2].map(j => R[i][0] * Rw[j][0] + R[i][1] * Rw[j][1] + R[i][2] * Rw[j][2]));
    const t2 = [0, 1, 2].map(i => c.tvec[i] - (R2[i][0] * tw[0] + R2[i][1] * tw[1] + R2[i][2] * tw[2]));
    return new pd.Camera(c.name, c.matrix, c.dist, R2, t2, c.size);
}
const moveWorld = (p, Rw, tw) => [0, 1, 2].map(i => Rw[i][0] * p[0] + Rw[i][1] * p[1] + Rw[i][2] * p[2] + tw[i]);
const randRot = () => cam('r', [rr(-1, 1), rr(-1, 1), rr(-1, 1)], [0, 0, 0]).rotationMatrix;

// The largest distance between (u, v) and the reprojection of points along its
// ray, relative to |(u, v, 1)|: 0 up to rounding for an exact ray.
function reprojErr(ray, uv, P) {
    let worst = 0;
    for (const s of [100, 2000]) {
        const q = core.reprojectPoint([0, 1, 2].map(j => ray.origin[j] + s * ray.direction[j]), P);
        worst = Math.max(worst, Math.hypot(q[0] - uv[0], q[1] - uv[1]) / Math.hypot(uv[0], uv[1], 1));
    }
    return worst;
}
const rayAt = (rays, i) => ({ origin: rays.origin, direction: rays.directions[i] });

// ===========================================================================
group('a camera at the world origin gets real rays (was NaN)');
{
    const P0 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
    const r = core.backProjectToRays([[0.1, 0.2]], P0);
    ok(finite(r.directions[0]) && unit(r.directions[0]), `[I | 0]: unit, finite direction (got ${r.directions[0]})`);
    ok(r.origin.every(v => v === 0), `[I | 0]: origin is the world origin (got ${r.origin})`);

    // Extrinsic (what the tracker passes) and full projection, as campy writes cam_0.
    const c0 = cam('c0', [0, 0, 0], [0, 0, 0]);
    const X = [10, 5, 50];
    for (const [label, P, uv] of [['extrinsic', c0.extrinsicMatrix, [X[0] / X[2], X[1] / X[2]]],
                                  ['projection', c0.projectionMatrix, c0.project(X)]]) {
        const one = core.backProjectToRay(uv, P);
        ok(finite(one.direction) && unit(one.direction), `${label}: unit, finite direction`);
        ok(core.pointToRayDistance(X, one.origin, one.direction) < 1e-9, `${label}: the ray passes through the 3D point it came from`);
        ok(one.direction[2] > 0, `${label}: the direction points in front of the camera`);
        const many = core.backProjectToRays([uv, null, uv], P);
        ok(many.directions[1] === null && many.directions[0].every((v, k) => Object.is(v, one.direction[k])),
            `${label}: the batch call gives the single call's direction, null for a missing point`);
    }
    // Rotated camera at the origin.
    const cr = cam('cr', [0.3, -0.5, 0.2], [0, 0, 0]);
    const Xr = moveWorld([4, -3, 60], cr.rotationMatrix.map((_, i) => [0, 1, 2].map(j => cr.rotationMatrix[j][i])), [0, 0, 0]);
    const ray = core.backProjectToRay(cr.project(Xr), cr.projectionMatrix);
    ok(finite(ray.direction) && core.pointToRayDistance(Xr, ray.origin, ray.direction) < 1e-9, 'rotated camera at the origin: the ray hits its 3D point');
}

// ===========================================================================
group('exact everywhere in the image, including where the pseudo-inverse point is at infinity');
{
    let worst = 0, worstLine = 0, n = 0, nLine = 0;
    for (let i = 0; i < 40; i++) {
        const far = i % 4 === 0 ? 1e4 : 1e3;
        const c = cam('c' + i, [rr(-1, 1), rr(-1, 1), rr(-1, 1)], [rr(-far, far), rr(-far, far), rr(-far, far)]);
        for (const P of [c.extrinsicMatrix, c.projectionMatrix]) {
            const ext = P === c.extrinsicMatrix;
            const uvs = Array.from({ length: 50 }, () => ext ? [rr(-1, 1), rr(-1, 1)] : [rr(0, 640), rr(0, 480)]);
            const rays = core.backProjectToRays(uvs, P);
            uvs.forEach((uv, k) => { worst = Math.max(worst, reprojErr(rayAt(rays, k), uv, P)); n++; });
        }
        // The pixels whose ray is perpendicular to the camera's offset from the
        // origin, t·(u, v, 1) = 0 on the extrinsic [R | t], where they are in view.
        const t = c.tvec, u = rr(-0.5, 0.5), v = -(t[0] * u + t[2]) / t[1];
        if (Math.abs(v) < 1) {
            const r1 = core.backProjectToRay([u, v], c.extrinsicMatrix);
            ok(finite(r1.direction), `camera ${i}: finite direction on the old degenerate line`);
            worstLine = Math.max(worstLine, reprojErr(r1, [u, v], c.extrinsicMatrix));
            nLine++;
        }
    }
    ok(worst < 1e-12, `${n} rays reproject onto their pixels (worst ${worst.toExponential(1)} relative)`);
    ok(nLine >= 3 && worstLine < 1e-12, `${nLine} rays on the old degenerate line reproject exactly too (worst ${worstLine.toExponential(1)})`);
}

// ===========================================================================
group('point-to-ray distances do not depend on where the world origin is');
{
    const rig = [cam('a', [0.1, 0.4, -0.2], [-150, 40, 900]), cam('b', [-0.3, -0.2, 0.1], [200, -60, 1100]), cam('c', [0.5, 0.1, 0.3], [30, 180, 1000])];
    const pts = Array.from({ length: 30 }, () => [rr(-200, 200), rr(-200, 200), rr(-100, 200)]);
    const uvs = Array.from({ length: 30 }, () => [rr(-0.6, 0.6), rr(-0.6, 0.6)]);
    const dists = (cams, P3) => cams.flatMap(c => {
        const rays = core.backProjectToRays(uvs, c.extrinsicMatrix);
        return P3.map((p, k) => core.pointToRayDistance(p, rays.origin, rays.directions[k]));
    });
    const base = dists(rig, pts);
    const frames = [];
    for (let i = 0; i < 4; i++) frames.push(['random', randRot(), [rr(-2000, 2000), rr(-2000, 2000), rr(-2000, 2000)]]);
    // The world moved into camera b's frame: b becomes [I | 0], set exactly (as campy writes it).
    frames.push(['camera b at the origin', rig[1].rotationMatrix, rig[1].tvec]);
    for (const [label, Rw, tw] of frames) {
        const moved = rig.map(c => rebaseCam(c, Rw, tw));
        if (label !== 'random') moved[1] = cam('b', I3, [0, 0, 0]);
        const got = dists(moved, pts.map(p => moveWorld(p, Rw, tw)));
        let diff = 0;
        got.forEach((d, k) => { diff = Math.max(diff, Number.isFinite(d) ? Math.abs(d - base[k]) : Infinity); });
        ok(diff < 1e-9, `${label}: ${got.length} distances unchanged (max diff ${diff.toExponential(1)} mm)`);
    }
}

// ===========================================================================
group('a P with no finite centre returns no rays instead of throwing');
{
    const Paff = [[1, 0, 0, 5], [0, 1, 0, 7], [0, 0, 0, 1]];     // affine: singular left 3x3
    let r, threw = false;
    try { r = core.backProjectToRays([[0.1, 0.2], null], Paff); } catch (e) { threw = true; }
    ok(!threw && r.directions.every(d => d === null) && r.origin.every(Number.isNaN), 'backProjectToRays: null directions, NaN origin');
    const one = core.backProjectToRay([0.1, 0.2], Paff);
    ok(one.direction === null && one.origin.every(Number.isNaN), 'backProjectToRay: null direction, NaN origin');
    const d = core.pointsToRayDistances([[1, 2, 3], [4, 5, 6]], r.origin, r.directions);
    ok(d.every(v => v === null), 'pointsToRayDistances skips them (null)');
}

// ===========================================================================
group('memo: a P mutated in place recasts its rays; returned origins are copies');
{
    const c = cam('m', [0.2, 0.1, -0.3], [10, 20, 900]);
    const P = c.extrinsicMatrix.map(r => r.slice());
    const a = core.backProjectToRays([[0.1, 0.1]], P);
    a.origin[0] = 999;
    ok(core.backProjectToRays([[0.1, 0.1]], P).origin[0] !== 999, 'mutating a returned origin cannot poison the memo');
    P[0][3] += 50;
    const b = core.backProjectToRays([[0.1, 0.1]], P);
    const fresh = core.backProjectToRays([[0.1, 0.1]], P.map(r => r.slice()));
    ok(b.origin.every((v, k) => Object.is(v, fresh.origin[k])) && b.origin[0] !== a.origin[0], 'the mutated P gets its new centre');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error('\nFailures:'); for (const f of failures) console.error('  - ' + f); process.exit(1); }
