/**
 * DIAGNOSTIC (not a panel): why is the refinement FARTHER from the proofread
 * reference (Fig 4b) while having LOWER reprojection error (Fig 4d)?
 *
 * Two explanations, and they mean opposite things:
 *
 *   (1) THE REFERENCE IS NOT TRUTH. Distance-to-reference cannot see whether a move
 *       helped, so any move looks bad.
 *   (2) THE REFINEMENT REALLY IS TRADING 3D ACCURACY FOR 2D FIT. With a
 *       systematically imperfect calibration, the point that best reprojects is not
 *       the true point, and minimising reprojection error moves the structure to
 *       absorb the camera model's error.
 *
 * (1) is what Fig 4b's caption asserts. This script exists because the evidence
 * offered for it -- the refined/DLT ratio growing with view count -- is CONSISTENT
 * with (2) as well, so it does not discriminate.
 *
 * THE TEST. Per keypoint take the three 3D points D (DLT), R (refined), G
 * (reference) and look at the TRIANGLE, not just its two sides:
 *
 *     a = |D-G|   how far the DLT sits from the reference
 *     b = |R-G|   how far the refinement sits from the reference   (Fig 4b's axis)
 *     m = |R-D|   how far the refinement MOVED
 *     cos t       direction of the move (R-D) against the direction to the
 *                 reference (G-D):  +1 = straight toward it, -1 = straight away,
 *                 0 = perpendicular
 *
 * The three regimes are distinguishable and predict different b:
 *     toward        b ~= |a - m|                cos t ~= +1
 *     away          b ~= a + m                  cos t ~= -1
 *     PERPENDICULAR b ~= sqrt(a^2 + m^2)        cos t ~= 0
 *
 * The perpendicular case is the decisive one. Adding a displacement ORTHOGONAL to
 * the existing error always increases the distance to the reference, no matter
 * whether the move was right or wrong -- so under it, Fig 4b's axis is structurally
 * incapable of scoring the refinement, and explanation (1) holds. A move that is
 * systematically AWAY (cos t << 0) would instead be real evidence for (2), and Fig
 * 4b's caption would have to be rewritten to say the refinement degrades the 3D.
 *
 * Reported at k = 5 (all views) and at k = 2, because the artefact argument rests on
 * the two solvers coinciding at k = 2 and diverging at k = 5.
 *
 * Usage: node figs/_diag_refined_vs_reference.mjs [--stride 40]
 */
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const POSE_DIR = process.env.POSE_DIR
    ? path.resolve(process.env.POSE_DIR)
    : path.resolve(REPO, '..', 'lucid-bundle-adj', 'pose');
register(pathToFileURL(path.join(HERE, 'fig4_hooks.mjs')).href, import.meta.url);
const tri = await import(pathToFileURL(path.join(POSE_DIR, 'triangulation.js')).href);
const pd = await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);

const argv = process.argv.slice(2);
const gi = argv.indexOf('--stride');
const STRIDE = gi >= 0 ? +argv[gi + 1] : 40;

const data = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'fig4_input.json'), 'utf8'));
const buf = fs.readFileSync(path.join(HERE, 'out', data.bin));
const NK = data.keypoints, C = data.n_cameras;
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const OBS = new Float64Array(ab, 0, NK * C * 2);
const GT = new Float64Array(ab, NK * C * 2 * 8, NK * 3);
const calSets = data.calibrations.map(set => {
    const cams = set.map(c =>
        new pd.Camera(c.name, c.matrix, c.distortions, c.rvec, c.tvec, c.size));
    return { cameras: cams, Ps: cams.map(c => c.projectionMatrix) };
});
const CAL_OF = new Int32Array(NK), MM_OF = new Float64Array(NK);
for (const b of data.blocks) {
    CAL_OF.fill(b.calibration || 0, b.offset, b.offset + b.count);
    MM_OF.fill(b.mm_per_unit, b.offset, b.offset + b.count);
}

/** Percentiles of a Float64Array prefix. */
function q(a, n) {
    const v = a.subarray(0, n).filter(Number.isFinite);
    v.sort();
    const p = x => v[Math.min(v.length - 1, Math.floor(v.length * x / 100))];
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i];
    return { n: v.length, mean: s / v.length, p25: p(25), p50: p(50), p75: p(75) };
}

// k = 5 is every view; k = 2 uses the first two views that saw the keypoint, which is
// enough to show the two solvers coinciding there.
for (const K of [5, 2]) {
    const cap = Math.ceil(NK / STRIDE);
    const A = new Float64Array(cap), B = new Float64Array(cap), M = new Float64Array(cap);
    const COS = new Float64Array(cap), PRED = new Float64Array(cap);
    let n = 0, moved = 0;
    for (let k = 0; k < NK; k += STRIDE) {
        const cs = calSets[CAL_OF[k]], cameras = cs.cameras, Ps = cs.Ps;
        const MM = MM_OF[k];
        const raw = new Array(C), und = new Array(C);
        let seen = 0;
        for (let c = 0; c < C; c++) {
            const i = (k * C + c) * 2;
            const ok = Number.isFinite(OBS[i]) && Number.isFinite(OBS[i + 1]);
            raw[c] = ok ? [OBS[i], OBS[i + 1]] : null;
            und[c] = ok ? cameras[c].undistortPoint(raw[c]) : null;
            if (ok) seen++;
        }
        if (seen < K) continue;
        if (K < C) {                       // keep only the first K seen views
            let kept = 0;
            for (let c = 0; c < C; c++) {
                if (!raw[c]) continue;
                if (kept < K) { kept++; continue; }
                raw[c] = null; und[c] = null;
            }
        }
        const gx = GT[k * 3], gy = GT[k * 3 + 1], gz = GT[k * 3 + 2];
        if (!Number.isFinite(gx)) continue;
        const D = tri.triangulatePointDLT(und, Ps);
        if (!D) continue;
        const R = tri.triangulatePointBA(raw, Ps, D, { cameras });
        if (!R) continue;

        const dg = [gx - D[0], gy - D[1], gz - D[2]];          // D -> G
        const dr = [R[0] - D[0], R[1] - D[1], R[2] - D[2]];    // D -> R  (the move)
        const a = Math.hypot(dg[0], dg[1], dg[2]) * MM;
        const m = Math.hypot(dr[0], dr[1], dr[2]) * MM;
        const b = Math.hypot(R[0] - gx, R[1] - gy, R[2] - gz) * MM;
        if (!(a > 0) || !(m > 0)) { if (m === 0) moved++; continue; }
        const dot = dg[0] * dr[0] + dg[1] * dr[1] + dg[2] * dr[2];
        A[n] = a; B[n] = b; M[n] = m;
        COS[n] = dot / ((a / MM) * (m / MM));
        PRED[n] = Math.hypot(a, m);       // b if the move were exactly perpendicular
        n++;
    }
    const sa = q(A, n), sb = q(B, n), sm = q(M, n), sc = q(COS, n), sp = q(PRED, n);
    console.log(`\n=== k = ${K} views ===   n = ${n}` +
                (moved ? `   (${moved} keypoints where the guard returned the seed)` : ''));
    console.log(`  a = |DLT - reference|   median ${sa.p50.toFixed(3)} mm`);
    console.log(`  b = |refined - ref|     median ${sb.p50.toFixed(3)} mm   <- Fig 4b's axis`);
    console.log(`  m = |refined - DLT|     median ${sm.p50.toFixed(3)} mm   <- how far it moved`);
    console.log(`  cos(move, toward-ref)   median ${sc.p50.toFixed(3)}  mean ${sc.mean.toFixed(3)}` +
                `  [p25 ${sc.p25.toFixed(3)}, p75 ${sc.p75.toFixed(3)}]`);
    console.log(`  PREDICTIONS for median b:`);
    console.log(`    if move were TOWARD the reference : ${Math.abs(sa.p50 - sm.p50).toFixed(3)} mm`);
    console.log(`    if PERPENDICULAR (sqrt(a^2+m^2))  : ${sp.p50.toFixed(3)} mm`);
    console.log(`    if move were AWAY                 : ${(sa.p50 + sm.p50).toFixed(3)} mm`);
    console.log(`    MEASURED                          : ${sb.p50.toFixed(3)} mm`);
}
