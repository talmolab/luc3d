/**
 * test-plane-constrained-fit.mjs — the CONSTRAINED plane fit (immutable /
 * "frozen" plane nodes) in `pose/triangulation.js`.
 *
 * A plane node may be flagged immutable, freezing its 3D position: the plane of
 * best fit must then pass exactly through it. That turns a free total-least-
 * squares problem into the same residual minimized subject to hard linear
 * constraints, and the number of frozen points decides how much freedom is
 * left (3 = none, 2 = a rotation about a line, 1 = a full pencil, 4+ = over-
 * determined and only solvable if they were already coplanar).
 *
 * What is pinned here, and why each matters:
 *
 *   * **Optimality, not just plausibility.** The 1- and 2-anchor solves are
 *     checked against a brute-force search over the admissible normals — a
 *     wrong-but-smooth answer (e.g. centring the scatter on the centroid
 *     instead of the anchor) would still produce a nice-looking plane through
 *     the anchor, and only a residual comparison catches it.
 *   * **The anchors are honoured EXACTLY.** Every frozen point's distance to
 *     the returned plane is ~0, and after flattening its coordinates are
 *     bit-identical. "Projecting an already-on-plane point is a no-op" is false
 *     in floating point, and a frozen point drifting an ulp per re-fit is
 *     exactly the silent corruption the flag exists to prevent.
 *   * **Failures are structural.** Each failure mode returns its own code, so
 *     the UI can decide block-vs-confirm without sniffing message strings.
 *   * **Non-finite anchors never reach `jacobiEigen`**, which has no NaN guard
 *     and would return a garbage eigenvector rather than an error.
 *   * **The unconstrained path is untouched** — 0 frozen nodes returns
 *     `not_constrained` rather than silently re-implementing
 *     `fitPlaneToPoints3d`.
 *
 * Run:  node tests/test-plane-constrained-fit.mjs
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;

// `pose/triangulation.js` imports a handful of DOM/three.js UI modules; the
// bench loader hook serves stubs for exactly those, leaving triangulation.js
// itself real and unmodified.
register(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'hooks.mjs')).href);

const T = await import(pathToFileURL(path.join(ROOT, 'pose', 'triangulation.js')).href);
const {
    fitPlaneConstrained, projectPoints3dOntoPlaneConstrained, mergeFrozenPoints3d,
    summarizePlaneTriangulation, planesInvalidatedByFit, orientNormalLike,
    normalizeImmutableMask, fitPlaneToPoints3d,
    PLANE_COPLANAR_TOL_FRAC, PLANE_ANCHOR_COND_FRAC,
} = T;

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function eq(a, e, m) { ok(a === e, `${m} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`); }
function near(a, e, tol, m) {
    ok(typeof a === 'number' && Math.abs(a - e) <= tol,
        `${m} (expected ${e} ±${tol}, got ${a})`);
}
function group(n) { console.log('\n• ' + n); }

// ---- helpers ------------------------------------------------------------
const flat = (pts) => {
    const a = new Float64Array(pts.length * 3);
    for (let i = 0; i < pts.length; i++) {
        if (pts[i] == null) { a[i * 3] = NaN; a[i * 3 + 1] = NaN; a[i * 3 + 2] = NaN; }
        else { a[i * 3] = pts[i][0]; a[i * 3 + 1] = pts[i][1]; a[i * 3 + 2] = pts[i][2]; }
    }
    return a;
};
const dist = (plane, p) =>
    (p[0] - plane.centroid[0]) * plane.normal[0] +
    (p[1] - plane.centroid[1]) * plane.normal[1] +
    (p[2] - plane.centroid[2]) * plane.normal[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => Math.sqrt(dot(v, v));
const unit = (v) => { const n = norm(v); return [v[0] / n, v[1] / n, v[2] / n]; };

/** Residual Σ(n·(p−a))² over `pts`, the objective the constrained fit minimizes. */
function residual(n, a, pts) {
    let s = 0;
    for (const p of pts) { const d = dot(n, sub(p, a)); s += d * d; }
    return s;
}

/** Brute-force minimum of `residual` over unit normals through `a`. */
function bruteForceFree(a, pts, steps = 400) {
    let best = Infinity, bestN = null;
    for (let i = 0; i <= steps; i++) {
        const theta = Math.PI * i / steps;
        for (let j = 0; j < 2 * steps; j++) {
            const phi = Math.PI * j / steps;
            const n = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
            const r = residual(n, a, pts);
            if (r < best) { best = r; bestN = n; }
        }
    }
    return { value: best, normal: bestN };
}

/** Brute-force minimum over normals through `a` AND orthogonal to `d`. */
function bruteForceLine(a, d, pts, steps = 200000) {
    const u = unit(cross(Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], d));
    const w = unit(cross(d, u));
    let best = Infinity, bestN = null;
    for (let i = 0; i < steps; i++) {
        const t = Math.PI * i / steps;
        const c = Math.cos(t), s = Math.sin(t);
        const n = [c * u[0] + s * w[0], c * u[1] + s * w[1], c * u[2] + s * w[2]];
        const r = residual(n, a, pts);
        if (r < best) { best = r; bestN = n; }
    }
    return { value: best, normal: bestN };
}

// ========================================================================
group('normalizeImmutableMask accepts Set / boolean mask / index list');
// ========================================================================
eq(JSON.stringify(normalizeImmutableMask(new Set([0, 2]), 4)), '[true,false,true,false]', 'Set of indices');
eq(JSON.stringify(normalizeImmutableMask([true, false, true, false], 4)), '[true,false,true,false]', 'boolean mask');
eq(JSON.stringify(normalizeImmutableMask([0, 2], 4)), '[true,false,true,false]', 'index list');
eq(JSON.stringify(normalizeImmutableMask(null, 3)), '[false,false,false]', 'null → all mutable');
eq(JSON.stringify(normalizeImmutableMask([9], 3)), '[false,false,false]', 'out-of-range index ignored');

// ========================================================================
group('0 immutable → not_constrained (the free path is NOT re-implemented)');
// ========================================================================
{
    const pts = [[0, 0, 0], [10, 0, 0.2], [10, 10, -0.1], [0, 10, 0.05]];
    const r = fitPlaneConstrained(flat(pts), { nodeNames: ['A', 'B', 'C', 'D'], planeName: 'Floor' });
    eq(r.ok, false, 'not ok');
    eq(r.code, 'not_constrained', 'code');
    ok(/no immutable points/.test(r.message), 'message points at the unconstrained fit');
    eq(r.plane, null, 'no plane returned');
    // …and the unconstrained fit still works, unchanged, on the same input.
    ok(fitPlaneToPoints3d(flat(pts)) != null, 'fitPlaneToPoints3d still fits it');
}

// ========================================================================
group('1 immutable → plane through a point, optimal over the full pencil');
// ========================================================================
{
    // Deliberately noisy and NOT centred on the anchor, so a fit that centred
    // the scatter on the centroid instead of the anchor would score worse.
    const pts = [[0, 0, 0], [10, 0, 0.7], [12, 9, -0.4], [1, 11, 0.25], [6, 5, 0.9]];
    const r = fitPlaneConstrained(flat(pts), {
        immutable: [0], nodeNames: ['A', 'B', 'C', 'D', 'E'], planeName: 'Floor',
    });
    eq(r.code, 'ok', 'code');
    eq(r.metrics.rank, 0, 'anchor rank 0 (a point)');
    eq(r.metrics.freedom, 2, 'two rotational DOF resolved by the mutable points');
    near(Math.abs(dist(r.plane, pts[0])), 0, 1e-9, 'anchor lies exactly on the plane');
    eq(JSON.stringify(r.anchorNames), '["A"]', 'anchor named');
    eq(JSON.stringify(r.mutableNames), '["B","C","D","E"]', 'mutable named');

    const mut = pts.slice(1);
    const got = residual(r.plane.normal, pts[0], mut);
    const bf = bruteForceFree(pts[0], mut);
    ok(got <= bf.value + 1e-9, `fit is optimal over the pencil (got ${got}, brute force ${bf.value})`);
    // A free (unconstrained) fit would do better but violate the constraint —
    // that gap is what proves the constraint is actually binding.
    const free = fitPlaneToPoints3d(flat(pts));
    ok(Math.abs(dist(free, pts[0])) > 1e-3, 'the FREE fit does not pass through the anchor');
}

// ========================================================================
group('2 immutable → plane contains the line, optimal over that pencil');
// ========================================================================
{
    const pts = [[0, 0, 0], [10, 0, 0], [3, 8, 1.2], [9, 7, -0.6], [1, 6, 0.3]];
    const r = fitPlaneConstrained(flat(pts), {
        immutable: [0, 1], nodeNames: ['A', 'B', 'C', 'D', 'E'], planeName: 'Floor',
    });
    eq(r.code, 'ok', 'code');
    eq(r.metrics.rank, 1, 'anchor rank 1 (a line)');
    eq(r.metrics.freedom, 1, 'one rotational DOF about A–B');
    near(Math.abs(dist(r.plane, pts[0])), 0, 1e-9, 'anchor A on the plane');
    near(Math.abs(dist(r.plane, pts[1])), 0, 1e-9, 'anchor B on the plane');
    near(dot(r.plane.normal, unit(sub(pts[1], pts[0]))), 0, 1e-12, 'normal ⟂ the frozen line');

    const mut = pts.slice(2);
    const d = unit(sub(pts[1], pts[0]));
    const got = residual(r.plane.normal, pts[0], mut);
    const bf = bruteForceLine(pts[0], d, mut);
    ok(got <= bf.value + 1e-7, `fit is optimal over the line pencil (got ${got}, brute force ${bf.value})`);
}

// ========================================================================
group('3 non-collinear immutable → exact, mutable points get ZERO weight');
// ========================================================================
{
    const a = [0, 0, 0], b = [10, 0, 0], c = [0, 10, 0];
    const base = [a, b, c, [5, 5, 3]];
    const r1 = fitPlaneConstrained(flat(base), {
        immutable: [0, 1, 2], nodeNames: ['A', 'B', 'C', 'D'], planeName: 'Floor',
    });
    eq(r1.code, 'ok', 'code');
    eq(r1.metrics.rank, 2, 'anchor rank 2 (fully determined)');
    eq(r1.metrics.freedom, 0, 'no freedom left');
    near(Math.abs(r1.plane.normal[2]), 1, 1e-12, 'normal is ±Z (exact cross product)');
    for (const p of [a, b, c]) near(Math.abs(dist(r1.plane, p)), 0, 1e-12, 'anchor on the plane');

    // Move the mutable point a very long way: the plane must not budge.
    const moved = [a, b, c, [5, 5, 9999]];
    const r2 = fitPlaneConstrained(flat(moved), { immutable: [0, 1, 2] });
    near(Math.abs(dot(r1.plane.normal, r2.plane.normal)), 1, 1e-12,
        'normal unchanged by a wildly moved mutable point');
    ok(r2.warnings.some(w => w.code === 'mutable_far_from_plane'),
        'but it is reported as an absurd flatten (warning, not error)');
    const w = r2.warnings.find(w => w.code === 'mutable_far_from_plane');
    near(w.maxDeviation, 9999, 1e-6, 'warning carries the max deviation');
    eq(JSON.stringify(w.nodeIndices), '[3]', 'warning names the offending node');
}

// ========================================================================
group('3 collinear immutable → relax to the 2-anchor case, with a warning');
// ========================================================================
{
    const pts = [[0, 0, 0], [5, 0, 0], [10, 0, 0], [3, 8, 1.2], [9, 7, -0.6]];
    const r = fitPlaneConstrained(flat(pts), {
        immutable: [0, 1, 2], nodeNames: ['A', 'B', 'C', 'D', 'E'], planeName: 'Floor',
    });
    eq(r.code, 'ok', 'still fits');
    eq(r.metrics.rank, 1, 'rank reduced to the line');
    ok(r.warnings.some(w => w.code === 'anchors_collinear_relaxed'), 'relaxation warned');
    for (const k of [0, 1, 2]) near(Math.abs(dist(r.plane, pts[k])), 0, 1e-9, 'collinear anchor on the plane');
}

// ========================================================================
group('3 collinear immutable + nothing off the line → anchors_collinear');
// ========================================================================
{
    const pts = [[0, 0, 0], [5, 0, 0], [10, 0, 0], [7, 0, 0]];
    const r = fitPlaneConstrained(flat(pts), {
        immutable: [0, 1, 2], nodeNames: ['A', 'B', 'C', 'D'], planeName: 'Floor',
    });
    eq(r.ok, false, 'rejected');
    eq(r.code, 'anchors_collinear', 'code');
    ok(/collinear/.test(r.message) && /A, B, C/.test(r.message), 'message names the anchors');
    eq(r.plane, null, 'no plane');
}

// ========================================================================
group('1 immutable + <2 usable mutable → underdetermined');
// ========================================================================
{
    const r = fitPlaneConstrained(flat([[0, 0, 0], [1, 2, 3]]), {
        immutable: [0], nodeNames: ['A', 'B'], planeName: 'Floor',
    });
    eq(r.ok, false, 'rejected');
    eq(r.code, 'underdetermined', 'code');
    ok(/point A is immutable/.test(r.message), 'message names the anchor');
    ok(/points B/.test(r.message) || /point B/.test(r.message), 'message names the mutable point');
}
{
    // 2 anchors, every mutable point ON the frozen line ⇒ the pencil is free.
    const r = fitPlaneConstrained(flat([[0, 0, 0], [10, 0, 0], [4, 0, 0], [7, 0, 0]]), {
        immutable: [0, 1], nodeNames: ['A', 'B', 'C', 'D'], planeName: 'Floor',
    });
    eq(r.ok, false, 'rejected');
    eq(r.code, 'underdetermined', 'code');
    ok(/rotation about A and B/.test(r.message), 'message says which freedom is unresolved');
}

// ========================================================================
group('4+ immutable → over-determined; coplanarity tolerance boundary');
// ========================================================================
{
    const square = [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]];
    const clean = fitPlaneConstrained(flat(square.concat([[50, 50, 0.3]])), {
        immutable: [0, 1, 2, 3], nodeNames: ['A', 'B', 'C', 'D', 'E'], planeName: 'Floor',
    });
    eq(clean.code, 'ok', 'exactly coplanar anchors fit');
    near(clean.metrics.anchorRms, 0, 1e-9, 'anchor RMS ~0');
    near(clean.metrics.anchorTolerance, PLANE_COPLANAR_TOL_FRAC * Math.sqrt(2) * 100, 1e-9,
        'tolerance is τ × the ANCHOR set diameter');

    // Lift one corner well beyond tolerance.
    const bent = [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 5]];
    const bad = fitPlaneConstrained(flat(bent.concat([[50, 50, 0]])), {
        immutable: [0, 1, 2, 3], nodeNames: ['A', 'B', 'C', 'D', 'E'], planeName: 'Floor',
    });
    eq(bad.ok, false, 'non-coplanar anchors rejected');
    eq(bad.code, 'anchors_noncoplanar', 'code');
    eq(bad.plane, null, 'no plane');
    ok(/A, B, C, D/.test(bad.message), 'message names all four anchors');
    ok(/immutable/.test(bad.message) && /impossible fit/.test(bad.message), 'message phrasing');
    ok(bad.metrics.anchorRms > bad.metrics.anchorTolerance, 'metrics explain the rejection');
    ok(bad.metrics.anchorMaxDeviation >= bad.metrics.anchorRms, 'max deviation reported too');

    // BOUNDARY: re-run the same bent anchors with τ set from the measured RMS.
    const rms = bad.metrics.anchorRms;
    const diam = bad.metrics.anchorDiameter;   // lifting a corner grows it past √2·100
    ok(diam > Math.sqrt(2) * 100, 'anchor diameter accounts for the lifted corner');
    const justOver = fitPlaneConstrained(flat(bent), {
        immutable: [0, 1, 2, 3], tolFrac: (rms * 1.0001) / diam,
    });
    eq(justOver.code, 'ok', 'accepted when the tolerance is a hair above the RMS');
    const justUnder = fitPlaneConstrained(flat(bent), {
        immutable: [0, 1, 2, 3], tolFrac: (rms * 0.9999) / diam,
    });
    eq(justUnder.code, 'anchors_noncoplanar', 'rejected when a hair below');

    // Scale invariance: the same shape scaled x1000 must give the same verdict.
    const big = bent.map(p => [p[0] * 1000, p[1] * 1000, p[2] * 1000]);
    eq(fitPlaneConstrained(flat(big), { immutable: [0, 1, 2, 3] }).code, 'anchors_noncoplanar',
        'verdict is scale-invariant (relative tolerance, not absolute)');
    const flatish = bent.map(p => [p[0], p[1], p[2] * 0.001]);
    eq(fitPlaneConstrained(flat(flatish.concat([[50, 50, 0]])), { immutable: [0, 1, 2, 3] }).code, 'ok',
        'a 1000x flatter version passes');
}

// ========================================================================
group('non-finite anchor is rejected before jacobiEigen sees it');
// ========================================================================
for (const [label, bad] of [['NaN', [NaN, 0, 0]], ['Infinity', [Infinity, 0, 0]], ['missing', null]]) {
    const pts = [bad, [10, 0, 0], [0, 10, 0], [5, 5, 1]];
    const r = fitPlaneConstrained(flat(pts), {
        immutable: [0], nodeNames: ['A', 'B', 'C', 'D'], planeName: 'Floor',
    });
    eq(r.ok, false, `${label} anchor rejected`);
    eq(r.code, 'no_anchor_3d', `${label} → no_anchor_3d`);
    eq(JSON.stringify(r.anchorNames), '["A"]', `${label} names the offending anchor`);
    ok(/no 3D position/.test(r.message), `${label} message`);
}
{
    // A non-finite MUTABLE point is simply skipped, not an error.
    const r = fitPlaneConstrained(flat([[0, 0, 0], [10, 0, 0], [0, 10, 0], [NaN, NaN, NaN]]), {
        immutable: [0], nodeNames: ['A', 'B', 'C', 'D'],
    });
    eq(r.code, 'ok', 'missing mutable point is skipped');
    eq(JSON.stringify(r.mutableNames), '["B","C"]', 'and excluded from the mutable set');
}

// ========================================================================
group('normal sign carries forward across a re-fit');
// ========================================================================
{
    const pts = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [5, 5, 0.1]];
    const r1 = fitPlaneConstrained(flat(pts), { immutable: [0, 1, 2] });
    const flipped = [-r1.plane.normal[0], -r1.plane.normal[1], -r1.plane.normal[2]];
    const r2 = fitPlaneConstrained(flat(pts), { immutable: [0, 1, 2], previousNormal: flipped });
    near(dot(r2.plane.normal, flipped), 1, 1e-12, 'normal follows the previous sign');
    const r3 = fitPlaneConstrained(flat(pts), { immutable: [0, 1, 2], previousNormal: r1.plane.normal });
    near(dot(r3.plane.normal, r1.plane.normal), 1, 1e-12, 'and keeps it when already agreeing');
    // Also true for the eigen-solved (1-anchor) branch.
    const s1 = fitPlaneConstrained(flat(pts), { immutable: [0] });
    const sFlip = [-s1.plane.normal[0], -s1.plane.normal[1], -s1.plane.normal[2]];
    const s2 = fitPlaneConstrained(flat(pts), { immutable: [0], previousNormal: sFlip });
    near(dot(s2.plane.normal, sFlip), 1, 1e-12, 'sign carry-forward on the eigen branch too');

    eq(JSON.stringify(orientNormalLike([0, 0, 1], [0, 0, -1])), '[0,0,-1]', 'orientNormalLike flips');
    eq(JSON.stringify(orientNormalLike([0, 0, 1], null)), '[0,0,1]', 'orientNormalLike passes through');
    eq(JSON.stringify(orientNormalLike([0, 0, 1], [NaN, 0, 0])), '[0,0,1]', 'orientNormalLike ignores non-finite');
}

// ========================================================================
group('anchor conditioning is scaled by the ANCHORS, never the whole scene');
// ========================================================================
{
    // REGRESSION. The coincidence tolerance was `κ · diam` over ALL points, so
    // one far-away mutable node inflated it until a real, deliberately-placed
    // anchor separation was ruled "coincident": rank collapsed 1 → 0, the line
    // the user pinned was silently discarded, and the fit then failed
    // `underdetermined` on a perfectly solvable problem.
    const pts = [[0, 0, 0], [50, 0, 0], [10, 30, 5], [100000, 0, 0]];
    const r = fitPlaneConstrained(flat(pts), {
        immutable: [0, 1], nodeNames: ['A', 'B', 'C', 'D'], planeName: 'Floor',
    });
    eq(r.code, 'ok', 'the distant mutable point no longer breaks the fit');
    eq(r.metrics.rank, 1, 'anchors still pin a LINE (rank 1)');
    eq(r.metrics.freedom, 1, 'one DOF left, resolved by the mutable points');
    ok(!r.warnings.some(w => w.code === 'anchors_coincident'), 'not called coincident');
    near(Math.abs(dist(r.plane, pts[0])), 0, 1e-9, 'anchor A on the plane');
    near(Math.abs(dist(r.plane, pts[1])), 0, 1e-9, 'anchor B on the plane');
    near(dot(r.plane.normal, [1, 0, 0]), 0, 1e-12, 'normal ⟂ the frozen line');
    ok(r.metrics.diameter > 99999, 'the whole-scene diameter really is ~1e5');
    ok(r.metrics.coincidenceTolerance < 1e-6,
        'yet the coincidence tolerance is anchor-intrinsic and tiny');

    // Sweeping the far point out to 1e12 must not change the verdict either.
    for (const far of [1e3, 1e6, 1e9, 1e12]) {
        const rr = fitPlaneConstrained(flat([[0, 0, 0], [50, 0, 0], [10, 30, 5], [far, 0, 0]]),
            { immutable: [0, 1] });
        eq(rr.metrics.rank, 1, `rank stays 1 with a mutable point at ${far}`);
        eq(rr.code, 'ok', `fit still succeeds with a mutable point at ${far}`);
    }
    // Symmetrically, the MUTABLE-spread guard must not be scaled by a huge
    // ANCHOR separation: tiny mutable offsets next to a vast frozen line are
    // still a determinate fit.
    const wide = fitPlaneConstrained(
        flat([[0, 0, 0], [1e6, 0, 0], [10, 1, 0.5], [20, 2, 0.9]]), { immutable: [0, 1] });
    eq(wide.code, 'ok', 'a small mutable spread beside a vast frozen line still fits');
    eq(wide.metrics.rank, 1, 'rank 1');
}

// ========================================================================
group('genuinely near-coincident anchors are STILL caught');
// ========================================================================
{
    const eps = 1e-9;
    const pts = [[0, 0, 0], [eps, 0, 0], [10, 0, 0], [0, 10, 0], [5, 5, 0.4]];
    const r = fitPlaneConstrained(flat(pts), {
        immutable: [0, 1], nodeNames: ['A', 'B', 'C', 'D', 'E'], planeName: 'Floor',
    });
    eq(r.code, 'ok', 'still fits');
    eq(r.metrics.rank, 0, 'rank 0, not a bogus line');
    ok(r.warnings.some(w => w.code === 'anchors_coincident'), 'coincidence warned');
}
{
    // Duplicated anchors far from the origin: the floor alone would not catch
    // this pair (1e-12 > 0 and the scene is large), so it exercises the
    // noise-floor term against a large coordinate magnitude.
    const pts = [[1000, 2000, 3000], [1000 + 1e-12, 2000, 3000], [1010, 2000, 3000], [1000, 2010, 3005]];
    const r = fitPlaneConstrained(flat(pts), { immutable: [0, 1], nodeNames: ['A', 'B', 'C', 'D'] });
    eq(r.metrics.rank, 0, 'a 1e-12 separation at 3e3 magnitude is coincident');
    ok(r.warnings.some(w => w.code === 'anchors_coincident'), 'warned');
}
{
    // Noise-floor term doing the work on its own: at 1e12 magnitude a 1e-4
    // separation is BELOW machine precision for those coordinates, so the
    // direction it implies is pure rounding noise — and the 1e-9 floor would
    // have waved it through.
    const pts = [[1e12, 0, 0], [1e12 + 1e-4, 0, 0], [1e12, 1e6, 0], [1e12, 0, 1e6]];
    const r = fitPlaneConstrained(flat(pts), { immutable: [0, 1] });
    eq(r.metrics.rank, 0, 'noise-dominated separation is coincident');
    ok(r.metrics.coincidenceTolerance > 1e-4, 'because the tolerance grew with the magnitude');
    // …while a separation well above that noise floor at the same magnitude is
    // trusted, so the guard is not just "always fire when coordinates are big".
    const real = fitPlaneConstrained(
        flat([[1e12, 0, 0], [1e12 + 1e6, 0, 0], [1e12, 1e6, 0], [1e12, 0, 1e6]]), { immutable: [0, 1] });
    eq(real.metrics.rank, 1, 'a real separation at the same magnitude is a line');
}
{
    // Near-collinear (but not exactly) anchors: κ is a LENGTH ratio, so a
    // 1e-9-of-diameter bow is treated as a line, not as a determined plane.
    const pts = [[0, 0, 0], [50, 1e-8, 0], [100, 0, 0], [50, 50, 2]];
    const r = fitPlaneConstrained(flat(pts), { immutable: [0, 1, 2] });
    eq(r.metrics.rank, 1, 'near-collinear anchors are rank 1');
    ok(r.warnings.some(w => w.code === 'anchors_collinear_relaxed'), 'and warned');
    ok(PLANE_ANCHOR_COND_FRAC === 1e-3, 'κ is the documented 1e-3');
}

// ========================================================================
group('constrained flatten: immutable coords BIT-identical, mutable on-plane');
// ========================================================================
{
    // Values chosen so a project-then-round-trip is not exact in binary.
    const pts = [[0.1, 0.2, 0.30000000000000004], [10.7, 0.3, 0], [0.9, 10.1, 0], [5.55, 5.55, 3.3], null];
    const src = flat(pts);
    const before = Float64Array.from(src);
    const r = fitPlaneConstrained(src, { immutable: [0, 1, 2] });
    eq(r.code, 'ok', 'fit ok');
    const out = projectPoints3dOntoPlaneConstrained(src, r.plane, [0, 1, 2]);

    ok(before.every((v, i) => Object.is(v, src[i])), 'fit did not mutate the input');
    for (const k of [0, 1, 2]) {
        for (let c = 0; c < 3; c++) {
            ok(Object.is(out[k * 3 + c], src[k * 3 + c]),
                `immutable node ${k} component ${c} is bit-identical`);
        }
    }
    // The mutable point moved and now lies on the plane.
    ok(out[9] !== src[9] || out[10] !== src[10] || out[11] !== src[11], 'mutable node moved');
    near(dist(r.plane, [out[9], out[10], out[11]]), 0, 1e-12, 'mutable node is on the plane');
    ok(Number.isNaN(out[12]) && Number.isNaN(out[13]) && Number.isNaN(out[14]), 'missing node stays missing');
    ok(before.every((v, i) => Object.is(v, src[i])), 'flatten did not mutate the input either');

    // A missing IMMUTABLE node also stays missing (copied verbatim).
    const withHole = flat([null, [10, 0, 0], [0, 10, 0], [5, 5, 1]]);
    const out2 = projectPoints3dOntoPlaneConstrained(withHole, { centroid: [0, 0, 0], normal: [0, 0, 1] }, [0]);
    ok(Number.isNaN(out2[0]), 'missing immutable node stays missing');
}

// ========================================================================
group('mergeFrozenPoints3d carries frozen 3D into a fresh triangulation');
// ========================================================================
{
    const frozen = flat([[1.1, 2.2, 3.3], [0, 0, 0], [0, 0, 0]]);
    const solved = flat([null, [4, 5, 6], [7, 8, 9]]);   // node 0 skipped by triangulation
    const out = mergeFrozenPoints3d(solved, frozen, [0]);
    for (let c = 0; c < 3; c++) ok(Object.is(out[c], frozen[c]), `frozen component ${c} carried verbatim`);
    eq(out[3], 4, 'mutable node kept from the solve');
    eq(out[8], 9, 'mutable node kept from the solve (2)');
    const noFrozen = mergeFrozenPoints3d(solved, null, [0]);
    ok(Number.isNaN(noFrozen[0]), 'immutable node with no stored 3D stays missing');
}

// ========================================================================
group('summarizePlaneTriangulation separates solve error from anchor residual');
// ========================================================================
{
    const pts3d = flat([[0, 0, 0], [1, 0, 0], [0, 1, 0], null]);
    const s = summarizePlaneTriangulation(pts3d, [10, 2, 4, null], [0]);
    eq(s.nNodes, 2, 'nNodes counts MUTABLE solved nodes only');
    near(s.meanError, 3, 1e-12, 'meanError excludes the frozen node');
    eq(s.nAnchors, 1, 'anchors counted separately');
    near(s.anchorMeanError, 10, 1e-12, 'anchorMeanError is the frozen residual');
    eq(JSON.stringify(s.provenance), '["frozen","triangulated","triangulated","missing"]', 'provenance');

    const none = summarizePlaneTriangulation(flat([[0, 0, 0]]), [null], [0]);
    eq(none.meanError, null, 'no mutable nodes → null meanError, not 0');
    eq(none.anchorMeanError, null, 'no residual → null anchorMeanError');
}

// ========================================================================
group('planesInvalidatedByFit');
// ========================================================================
{
    const planes = [
        { id: 1, nodeIds: [10, 11, 12] },
        { id: 2, nodeIds: [12, 13, 14] },
        { id: 3, nodeIds: [20, 21] },
        { id: 2, nodeIds: [12] },            // duplicate id
    ];
    eq(JSON.stringify(planesInvalidatedByFit([12, 13], planes, 1)), '[2]', 'shared node invalidates, deduped');
    eq(JSON.stringify(planesInvalidatedByFit([12], planes)), '[1,2]', 'without an exclusion, both');
    eq(JSON.stringify(planesInvalidatedByFit([99], planes, 1)), '[]', 'no overlap → none');
    eq(JSON.stringify(planesInvalidatedByFit([], planes, 1)), '[]', 'nothing moved → none');
    eq(JSON.stringify(planesInvalidatedByFit(new Set(['a']), [{ id: 'x', nodeIds: ['a'] }])), '["x"]',
        'string node ids and a Set work too');
}

// ========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error('\nFailures:'); failures.forEach(f => console.error('  - ' + f)); }
process.exit(failed ? 1 : 0);
