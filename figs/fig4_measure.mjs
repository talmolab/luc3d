/**
 * Fig 4 — measure DLT vs non-linear refinement on REAL detections, using the
 * triangulation code from the `eric/bundle-adj` worktree.
 *
 * WHY IT POINTS AT ANOTHER WORKTREE. The #113 work lives on `eric/bundle-adj`
 * (worktree `../lucid-bundle-adj`). This script imports that checkout's
 * pose/triangulation.js READ-ONLY and writes its results into this branch's
 * figs/out/. Nothing on that branch is modified. Override with POSE_DIR=.
 *
 * THREE METHODS, and the naming matters because the UI's is wrong:
 *   dlt        linear DLT. Minimises an ALGEBRAIC error, in ideal-pinhole
 *              (undistorted) coordinates. Closed form.
 *   ba         what the app's "Bundle Adjustment" menu item runs: Levenberg-
 *              Marquardt per point with a soft-L1 robust loss plus an L1 polish
 *              phase, residuals in the camera's NATIVE (distorted) space. The
 *              cameras are held FIXED, so this is non-linear TRIANGULATION -- the
 *              module says so itself. aniposelib's analogue is `optim_points`.
 *   ba_legacy  the pre-#113 option set (robustScale: Infinity, polish: false,
 *              guard: false): plain squared loss against the IDEAL projection.
 *              Included because it is the configuration whose reported error
 *              could exceed DLT's, which is what issue #113 was.
 *
 * (`bundleAdjustCameras` -- joint cameras + structure, the strict sense of the
 * term -- is a separate function and deliberately not wired to the UI, so it is
 * not part of this per-keypoint comparison.)
 *
 * WHAT IS AND IS NOT A RESULT HERE
 * --------------------------------
 * "Refined is never worse than DLT" on the views it was given is NOT a
 * measurement: phase 2 minimises exactly the reported metric and a backtracking
 * guard vetoes any step that raises it. The contingent quantities this script
 * exists to produce are
 *   (i)   heldout_reproj_px / heldout_by_views -- leave-one-camera-out, which
 *         neither solver optimises and which either one can lose;
 *   (ii)  worse_than_dlt.ba_legacy -- how often the pre-#113 option set drove the
 *         DISPLAYED error above the DLT it started from;
 *   (iii) per_session -- the same comparisons within each recording, so the
 *         pooled numbers cannot hide behind 4 M correlated keypoints;
 *   (iv)  robust -- how far the 3D estimate moves when the worst-fitting view is
 *         rejected (a reference-free measure of one bad view's leverage).
 * `by_worst_view` (3D error against the proofread reference, per solver) is
 * emitted as a DIAGNOSTIC only and must not be plotted: the reference's own
 * reprojection error exceeds both solvers', so it cannot rank them.
 *
 * MEMORY. Every accumulator is a preallocated Float64Array rather than a JS array
 * of numbers/objects. At 4.25 M keypoints x 5 cameras the held-out arrays alone
 * are 21 M entries each, and the old `robust` array of 4-field objects was ~250 MB
 * of boxed rows in V8's pointer-compressed heap. Typed backing stores live outside
 * that cage. Percentile semantics are unchanged (filter non-finite, sort, index).
 *
 * Env: POSE_DIR=  LIMIT=<n keypoints>  OUT_JSON=<path>
 *      HOV_SUB=<n>  keypoint stride for the held-out-by-view-count arm (default:
 *                   whatever gives ~1.2 M keypoints; 1 = every keypoint)
 *      DSTEP=<n>    keypoint stride for the lens-distortion fixture (default:
 *                   ~200 k keypoints; 1 = every keypoint)
 *
 * Usage:
 *   /root/.../lp3d_env/bin/python figs/fig4_export.py     # -> figs/out/fig4_input.json
 *   node figs/fig4_measure.mjs                            # -> figs/out/fig4.json
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
// Our own hooks, not the branch's: see figs/fig4_hooks.mjs for why.
const HOOKS = path.join(HERE, 'fig4_hooks.mjs');

if (!fs.existsSync(POSE_DIR)) {
    throw new Error(`no pose dir at ${POSE_DIR} — set POSE_DIR or create the ` +
                    `eric/bundle-adj worktree`);
}
register(pathToFileURL(HOOKS).href, import.meta.url);

const tri = await import(pathToFileURL(path.join(POSE_DIR, 'triangulation.js')).href);
const pd = await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);

const inPath = path.join(HERE, 'out', 'fig4_input.json');
if (!fs.existsSync(inPath)) throw new Error(`run figs/fig4_export.py first (${inPath})`);
const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));

// Two input shapes. 'bin-v1' keeps the coordinates in a flat float64 sidecar so this
// can run over millions of keypoints without parsing a giant JSON array; the older
// shape carried an inline `keypoints` array and is still accepted.
let OBS = null, GT = null, NK = 0, MM_OF = null;
let NK_FILE = 0;
if (data.format === 'bin-v1') {
    const buf = fs.readFileSync(path.join(HERE, 'out', data.bin));
    NK_FILE = data.keypoints;
    const nc = data.n_cameras;
    const obsLen = NK_FILE * nc * 2, gtLen = NK_FILE * 3;
    if (buf.byteLength !== (obsLen + gtLen) * 8) {
        throw new Error(`${data.bin}: expected ${(obsLen + gtLen) * 8} bytes for ` +
                        `${NK_FILE} keypoints x ${nc} cameras, got ${buf.byteLength}`);
    }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    OBS = new Float64Array(ab, 0, obsLen);
    GT = new Float64Array(ab, obsLen * 8, gtLen);
    // LIMIT truncates the keypoint range only; the .bin offsets stay file-sized so a
    // limited run is a strict prefix of the full one (used to check refactors).
    NK = process.env.LIMIT ? Math.min(NK_FILE, +process.env.LIMIT) : NK_FILE;
    // mm_per_unit is per session; build a lookup so 3D errors use the right scale
    MM_OF = new Float64Array(NK_FILE);
    for (const b of data.blocks) MM_OF.fill(b.mm_per_unit, b.offset, b.offset + b.count);
} else {
    NK = NK_FILE = data.keypoints.length;
}

/** Keypoint k as {obs: [[x,y]|null x C], gt3d: [x,y,z], mm} for either input shape. */
function keypointAt(k, nc) {
    if (!OBS) {
        const kp = data.keypoints[k];
        return { obs: kp.obs, gt3d: kp.gt3d, mm: data.mm_per_unit };
    }
    const o = new Array(nc);
    for (let c = 0; c < nc; c++) {
        const i = (k * nc + c) * 2;
        o[c] = Number.isFinite(OBS[i]) && Number.isFinite(OBS[i + 1])
            ? [OBS[i], OBS[i + 1]] : null;
    }
    return { obs: o, gt3d: [GT[k * 3], GT[k * 3 + 1], GT[k * 3 + 2]], mm: MM_OF[k] };
}

// PER-BLOCK CALIBRATION. BMimica spans several recording dates and the rig was
// recalibrated between them. An earlier export carried one shared camera block and
// SKIPPED any session on a different calibration -- 13 of 20, i.e. every other recording
// day -- which silently reduced this figure to one rig, one calibration, one day. Each
// block now names its calibration and we build a Camera set per calibration.
const calSets = (data.calibrations && data.calibrations.length
    ? data.calibrations : [data.cameras]).map(set => {
        const cams = set.map(c =>
            new pd.Camera(c.name, c.matrix, c.distortions, c.rvec, c.tvec, c.size));
        return { cameras: cams, Ps: cams.map(c => c.projectionMatrix) };
    });
// keypoint index -> calibration index
const CAL_OF = new Int32Array(NK_FILE);
for (const b of (data.blocks || [])) {
    CAL_OF.fill(b.calibration || 0, b.offset, b.offset + b.count);
}
let cameras = calSets[0].cameras;
let Ps = calSets[0].Ps;
const C = cameras.length;
if (calSets.length > 1) {
    console.log(`[calibration] ${calSets.length} distinct calibrations across ` +
                `${(data.blocks || []).length} sessions`);
}
const MM_DEFAULT = data.mm_per_unit || 1;

/** Switch the active camera set to the calibration keypoint kIdx belongs to. */
function useCalibration(kIdx) {
    const ci = CAL_OF.length ? CAL_OF[kIdx] : 0;
    if (calSets[ci] && calSets[ci].cameras !== cameras) {
        cameras = calSets[ci].cameras;
        Ps = calSets[ci].Ps;
    }
}

/** Mean Euclidean reprojection error in each camera's NATIVE space. */
function nativeError(X, obsRaw) {
    if (!X) return null;
    let sum = 0, n = 0;
    for (let ci = 0; ci < C; ci++) {
        if (!obsRaw[ci]) continue;
        const ideal = tri.reprojectPoint(X, Ps[ci]);
        if (!ideal) continue;
        const p = cameras[ci].distortPoint(ideal);
        sum += Math.hypot(p[0] - obsRaw[ci][0], p[1] - obsRaw[ci][1]);
        n++;
    }
    return n ? sum / n : null;
}

// ---------------------------------------------------------------- accumulators --
const METHODS = ['dlt', 'ba', 'ba_legacy'];
const nan = n => { const a = new Float64Array(n); a.fill(NaN); return a; };
const ERR = {}, ERR3D = {};
for (const m of METHODS) { ERR[m] = nan(NK); ERR3D[m] = nan(NK); }
const REF = nan(NK);                 // the reference's OWN reprojection error
const WORST = nan(NK);               // worst single-view residual of the DLT solve
const BUCKET = new Uint8Array(NK);   // 0 clean (<3 px), 1 mid (3-10), 2 outlier (>=10)
// drop-the-worst-view re-solve
const ROB_worst = nan(NK), ROB_before = nan(NK), ROB_after = nan(NK), ROB_moved = nan(NK);
let ROBN = 0;
// leave-one-camera-out, pushed in lockstep for the two methods
const HO_dlt = nan(NK * C), HO_ba = nan(NK * C);
let HON = 0;
// how much the pre-#113 option set raised the DISPLAYED error above DLT's
const LEGACY_UP = nan(NK);
let LEGUPN = 0;
// the SIGNED change in the displayed error, refined minus DLT, for both option sets.
// The shipped set cannot be positive (guard); the pre-#113 set straddles zero, and the
// figure shows that difference in shape rather than asserting it.
const DIFF_BA = nan(NK), DIFF_LEG = nan(NK);
const LEG_WORSE = new Uint8Array(NK);
let guardReturnedSeed = 0;
let worseThanDlt = { ba: 0, ba_legacy: 0 };
let compared = 0;
const MS = { dlt: 0, ba: 0, ba_legacy: 0 };

// HELD-OUT ERROR VS NUMBER OF CONTRIBUTING VIEWS. Same leave-one-camera-out
// protocol, but the solve is given only k of the remaining views. This is the one
// view-count curve in the figure that needs NO reference 3D at all -- it is scored
// against the raw detection in a view no solve ever saw -- so it cannot inherit the
// proofread reference's own bias. Run on a subsample because each keypoint costs
// (kmax-1) extra refinements.
// HOV_SUB=1 runs it on EVERY keypoint (the reviewer's "no secondary subsample"
// setting, ~+35% wall clock); unset keeps the old 1.2 M-keypoint target.
const SUB = process.env.HOV_SUB
    ? Math.max(1, +process.env.HOV_SUB)
    : Math.max(1, Math.floor(NK / 1.2e6));
const NSUB = Math.ceil(NK / SUB);
const KMAX = C - 1;
const HOV = {};
for (let k = 2; k <= KMAX; k++) HOV[k] = { dlt: nan(NSUB), ba: nan(NSUB) };
let HOVN = 0;

// Per-session bookkeeping. Blocks are contiguous in keypoint index, so a block maps
// to a slice of every per-keypoint array; only the held-out arrays need a marker.
const blocks = (data.blocks && data.blocks.length)
    ? data.blocks
    : [{ session: data.session || null, offset: 0, count: NK, calibration: 0 }];
const HO_START = new Int32Array(blocks.length);
let nextBlock = 0;

// LENS DISTORTION. If undistortion barely moves the detections then "native space vs
// ideal space" is a distinction without a difference and the whole DLT-vs-refined
// comparison is vacuous. Measured across the WHOLE corpus (strided), with each
// keypoint's own calibration -- an earlier version sampled only the first 500
// keypoints, i.e. one session on one calibration, and never deposited the number.
const DSTEP = process.env.DSTEP
    ? Math.max(1, +process.env.DSTEP)
    : Math.max(1, Math.floor(NK / 200000));
const DIST = nan(Math.ceil(NK / DSTEP) * C);
let DISTN = 0;
for (let k = 0; k < NK; k += DSTEP) {
    useCalibration(k);
    const kp = keypointAt(k, C);
    for (let ci = 0; ci < C; ci++) {
        if (!kp.obs[ci]) continue;
        const u = cameras[ci].undistortPoint(kp.obs[ci]);
        DIST[DISTN++] = Math.hypot(u[0] - kp.obs[ci][0], u[1] - kp.obs[ci][1]);
    }
}

// ------------------------------------------------------------------ main sweep --
for (let kIdx = 0; kIdx < NK; kIdx++) {
    while (nextBlock < blocks.length && kIdx === blocks[nextBlock].offset) {
        HO_START[nextBlock++] = HON;
    }
    useCalibration(kIdx);
    const kp = keypointAt(kIdx, C);
    const MM = kp.mm || MM_DEFAULT;
    const raw = kp.obs;
    const und = raw.map((p, ci) => (p ? cameras[ci].undistortPoint(p) : null));

    // --- DLT: linear, in ideal pinhole coordinates ---
    let t0 = performance.now();
    const Xdlt = tri.triangulatePointDLT(und, Ps);
    MS.dlt += performance.now() - t0;

    // --- BA as the app runs it: native-space residuals, soft-L1 + polish ---
    t0 = performance.now();
    const Xba = tri.triangulatePointBA(raw, Ps, Xdlt, { cameras });
    MS.ba += performance.now() - t0;

    // --- the pre-#113 option set: plain squared loss against the IDEAL projection ---
    t0 = performance.now();
    const Xleg = tri.triangulatePointBA(und, Ps, Xdlt,
        { robustScale: Infinity, polish: false, guard: false });
    MS.ba_legacy += performance.now() - t0;

    // DIAGNOSTIC: the reference's OWN reprojection error. If the proofread 3D does
    // not itself minimise native-space reprojection error on these detections, then
    // "distance to the reference" is not a valid arbiter between two solvers that
    // differ precisely in which error they minimise -- it silently rewards whichever
    // objective the reference pipeline happened to use.
    const refE = nativeError(kp.gt3d, raw);
    if (refE != null) REF[kIdx] = refE;

    const e = {
        dlt: nativeError(Xdlt, raw),
        ba: nativeError(Xba, raw),
        ba_legacy: nativeError(Xleg, raw),
    };
    const X = { dlt: Xdlt, ba: Xba, ba_legacy: Xleg };
    if (e.dlt == null) continue;
    compared++;
    for (const m of METHODS) {
        if (e[m] == null) continue;
        ERR[m][kIdx] = e[m];
        if (X[m]) {
            ERR3D[m][kIdx] = Math.hypot(X[m][0] - kp.gt3d[0], X[m][1] - kp.gt3d[1],
                                        X[m][2] - kp.gt3d[2]) * MM;
        }
    }
    // The #113 invariant: does the REPORTED error ever rise above DLT's?
    for (const m of ['ba', 'ba_legacy']) {
        if (e[m] != null && e[m] > e.dlt + 1e-12) worseThanDlt[m]++;
    }
    // ...and by how much, when it does. A regression rate says how often the
    // displayed number moved the wrong way; this says whether it mattered.
    if (e.ba_legacy != null && e.ba_legacy > e.dlt + 1e-12) {
        LEGACY_UP[LEGUPN++] = e.ba_legacy - e.dlt;
        LEG_WORSE[kIdx] = 1;
    }
    if (e.ba != null) DIFF_BA[kIdx] = e.ba - e.dlt;
    if (e.ba_legacy != null) DIFF_LEG[kIdx] = e.ba_legacy - e.dlt;

    // STRATIFY BY WORST-VIEW DISAGREEMENT. A robust loss is supposed to buy
    // accuracy where a view is badly wrong and to cost a little efficiency where
    // every view is clean, so bucket each keypoint by how far its WORST view sits
    // from the DLT solution.
    let worst = 0, worstIdx = -1;
    for (let ci = 0; ci < C; ci++) {
        if (!raw[ci]) continue;
        const ideal = tri.reprojectPoint(Xdlt, Ps[ci]);
        if (!ideal) continue;
        const q = cameras[ci].distortPoint(ideal);
        const dv = Math.hypot(q[0] - raw[ci][0], q[1] - raw[ci][1]);
        if (dv > worst) { worst = dv; worstIdx = ci; }
    }
    // ROBUST RE-TRIANGULATION. What the app's `reprojErrorThreshold` does: find the
    // view whose residual is worst, drop it, re-solve from the rest. The honest test
    // is not "does error fall in the views we kept" (dropping the worst view lowers
    // that by construction) but "was the bad view DRAGGING the estimate" -- i.e. does
    // the solution from the other views move, and by how far in millimetres.
    if (worstIdx >= 0) {
        const kept = raw.map((p, ci) => (ci === worstIdx ? null : p));
        const keptU = und.map((p, ci) => (ci === worstIdx ? null : p));
        const Xdrop = tri.triangulatePointDLT(keptU, Ps);
        if (Xdrop) {
            const before = nativeError(Xdlt, kept);   // all-view solution, kept views
            const after = nativeError(Xdrop, kept);   // dropped-view solution, same views
            if (before != null && after != null) {
                ROB_worst[ROBN] = worst;
                ROB_before[ROBN] = before;
                ROB_after[ROBN] = after;
                ROB_moved[ROBN] = Math.hypot(Xdrop[0] - Xdlt[0], Xdrop[1] - Xdlt[1],
                                             Xdrop[2] - Xdlt[2]) * MM;
                ROBN++;
            }
        }
    }

    WORST[kIdx] = worst;
    BUCKET[kIdx] = worst < 3 ? 0 : (worst < 10 ? 1 : 2);

    // --- leave-one-camera-out ---
    for (let h = 0; h < C; h++) {
        if (!raw[h]) continue;
        const rawH = raw.map((p, ci) => (ci === h ? null : p));
        const undH = und.map((p, ci) => (ci === h ? null : p));
        let nv = 0;
        for (let ci = 0; ci < C; ci++) if (rawH[ci]) nv++;
        if (nv < 2) continue;
        const Xd = tri.triangulatePointDLT(undH, Ps);
        if (!Xd) continue;
        const Xb = tri.triangulatePointBA(rawH, Ps, Xd, { cameras });
        const ideal = Xd && tri.reprojectPoint(Xd, Ps[h]);
        const idealB = Xb && tri.reprojectPoint(Xb, Ps[h]);
        if (!ideal || !idealB) continue;
        const qd = cameras[h].distortPoint(ideal);
        const qb = cameras[h].distortPoint(idealB);
        const dd = Math.hypot(qd[0] - raw[h][0], qd[1] - raw[h][1]);
        const db = Math.hypot(qb[0] - raw[h][0], qb[1] - raw[h][1]);
        if (!Number.isFinite(dd) || !Number.isFinite(db)) continue;
        HO_dlt[HON] = dd;
        HO_ba[HON] = db;
        HON++;
    }
    if (Xba && Xdlt && Xba[0] === Xdlt[0] && Xba[1] === Xdlt[1] && Xba[2] === Xdlt[2]) {
        guardReturnedSeed++;
    }

    // --- held-out error as a function of how many views the solve was given ---
    if (kIdx % SUB === 0) {
        const h = kIdx % C;
        if (raw[h]) {
            const others = [];
            for (let ci = 0; ci < C; ci++) if (ci !== h && raw[ci]) others.push(ci);
            if (others.length >= 2) {
                // rotate which views are picked so the curve averages over subsets
                const rot = kIdx % others.length;
                const ordered = others.slice(rot).concat(others.slice(0, rot));
                for (let k = 2; k <= Math.min(KMAX, ordered.length); k++) {
                    const sel = new Set(ordered.slice(0, k));
                    const rk = raw.map((p, ci) => (sel.has(ci) ? p : null));
                    const uk = und.map((p, ci) => (sel.has(ci) ? p : null));
                    const Xk = tri.triangulatePointDLT(uk, Ps);
                    if (!Xk) continue;
                    const Xkb = tri.triangulatePointBA(rk, Ps, Xk, { cameras });
                    for (const [nm, X_] of [['dlt', Xk], ['ba', Xkb]]) {
                        if (!X_) continue;
                        const id = tri.reprojectPoint(X_, Ps[h]);
                        if (!id) continue;
                        const q2 = cameras[h].distortPoint(id);
                        const d2 = Math.hypot(q2[0] - raw[h][0], q2[1] - raw[h][1]);
                        if (Number.isFinite(d2)) HOV[k][nm][HOVN] = d2;
                    }
                }
                HOVN++;
            }
        }
    }
}
while (nextBlock < blocks.length) HO_START[nextBlock++] = HON;

/**
 * Percentiles. Accepts a plain array or a (Float64Array, n) pair; in both cases
 * non-finite entries are dropped first, which is how the untyped version behaved
 * when a method returned null for a keypoint.
 */
function stats(a, n) {
    const src = (n === undefined || !a.subarray) ? a : a.subarray(0, n);
    let v;
    if (src instanceof Float64Array) {
        v = src.filter(Number.isFinite);
        v.sort();                                  // typed sort is numeric ascending
    } else {
        v = src.filter(Number.isFinite).sort((x, y) => x - y);
    }
    if (!v.length) return null;
    const q = p => v[Math.min(v.length - 1, Math.floor(v.length * p / 100))];
    let sum = 0;
    for (let i = 0; i < v.length; i++) sum += v[i];
    return {
        n: v.length, mean: sum / v.length,
        p5: q(5), p25: q(25), p50: q(50), p75: q(75), p90: q(90), p95: q(95), p99: q(99),
    };
}

/** Median of the finite entries of arr[lo, hi). */
function medianOf(arr, lo, hi) {
    const v = arr.subarray(lo, hi).filter(Number.isFinite);
    if (!v.length) return null;
    v.sort();
    return v[Math.floor(v.length / 2)];
}

const out = {
    session: data.session || null, sessions: data.sessions || null,
    n_sessions: blocks.length,
    n_calibrations: calSets.length,
    keypoints: compared, cameras: C, stride: data.stride || null,
    limit: process.env.LIMIT ? NK : null,
    poseDir: POSE_DIR,
    methods: {},
    // The headline #113 result: with the fix, the reported error is never worse
    // than the DLT it started from; with the pre-fix option set it often is.
    worse_than_dlt: {
        ba: worseThanDlt.ba, ba_legacy: worseThanDlt.ba_legacy, of: compared,
    },
};
for (const m of METHODS) {
    out.methods[m] = {
        reproj_px: stats(ERR[m], NK),
        err3d_mm: stats(ERR3D[m], NK),
        us_per_keypoint: (MS[m] * 1000) / Math.max(1, compared),
    };
}
out.reference_reproj_px = stats(REF, NK);
// The measured lens-distortion displacement, deposited rather than logged: without it
// "native vs ideal pixel space" is an unsupported premise.
out.distortion_px = stats(DIST, DISTN);
out.distortion_px.note = ('median |raw - undistorted| over every sampled detection, '
    + `every ${DSTEP}th keypoint x ${C} views, each on its own calibration`);
// How badly the pre-#113 option set raised the displayed error, where it did.
out.legacy_regression_px = stats(LEGACY_UP, LEGUPN);
// The signed change in the displayed error, refined minus DLT. Positive = the number
// the app shows the user got WORSE after refining.
out.diff_vs_dlt_px = { ba: stats(DIFF_BA, NK), ba_legacy: stats(DIFF_LEG, NK) };
// The de-tautologised comparison, plus the paired difference on the observed views
// (which is the honest way to show a guaranteed-signed effect).
out.heldout_reproj_px = { dlt: stats(HO_dlt, HON), ba: stats(HO_ba, HON) };
{
    const diff = nan(HON);
    let better = 0, worse = 0, tie = 0;
    for (let i = 0; i < HON; i++) {
        const d = HO_dlt[i] - HO_ba[i];
        diff[i] = d;
        if (d > 0) better++; else if (d < 0) worse++; else tie++;
    }
    out.heldout_paired = {
        n: HON, ba_better: better, dlt_better: worse, tie,
        ba_better_frac: HON ? better / HON : null,
        diff_px: stats(diff, HON),
        median_diff_px: medianOf(diff, 0, HON),
    };
}
// Held-out error vs how many views the solve was given. Reference-free.
out.heldout_by_views = {
    n_keypoints: HOVN, subsample_every: SUB,
    by_k: Object.fromEntries(Object.entries(HOV).map(([k, v]) => [k, {
        dlt: stats(v.dlt, HOVN), ba: stats(v.ba, HOVN),
    }])),
    note: ('leave-one-camera-out with only k of the remaining views given to the '
           + 'solve, scored against the raw detection in the held-out view; needs no '
           + 'reference 3D, so it carries none of its bias'),
};
out.guard = {
    returned_seed: guardReturnedSeed, of: compared,
    frac: compared ? guardReturnedSeed / compared : null,
    note: ("Fraction of keypoints where the refined solve came back bit-identical to "
           + "its DLT seed, i.e. the backtracking guard found no non-worsening step. "
           + "This is the contingent quantity; 'never worse than DLT' itself is "
           + "enforced by that guard and is not a measurement.")
};
// PER SESSION. Pooling 4 M keypoints from 50 recordings into one median is
// pseudo-replication: the keypoints within a session are correlated, so the pooled
// comparison has no error bar. Each session gets its own paired medians here, which is
// what the figure plots.
out.per_session = blocks.map((b, i) => {
    const lo = b.offset, hi = Math.min(NK, b.offset + b.count);
    if (hi <= lo) return null;
    const hLo = HO_START[i], hHi = (i + 1 < blocks.length ? HO_START[i + 1] : HON);
    let legWorse = 0, legN = 0;
    for (let j = lo; j < hi; j++) {
        if (!Number.isFinite(ERR.ba_legacy[j])) continue;
        legN++;
        if (LEG_WORSE[j]) legWorse++;
    }
    let baBetter = 0, hn = 0;
    for (let j = hLo; j < hHi; j++) {
        if (!Number.isFinite(HO_dlt[j]) || !Number.isFinite(HO_ba[j])) continue;
        hn++;
        if (HO_dlt[j] > HO_ba[j]) baBetter++;
    }
    return {
        session: b.session, calibration: b.calibration || 0,
        n_keypoints: hi - lo,
        reproj_p50: { dlt: medianOf(ERR.dlt, lo, hi), ba: medianOf(ERR.ba, lo, hi),
                      ba_legacy: medianOf(ERR.ba_legacy, lo, hi) },
        heldout_p50: { dlt: medianOf(HO_dlt, hLo, hHi), ba: medianOf(HO_ba, hLo, hHi) },
        heldout_n: hn,
        heldout_ba_better_frac: hn ? baBetter / hn : null,
        legacy_worse_frac: legN ? legWorse / legN : null,
    };
}).filter(Boolean);
// TRIAGE CONCENTRATION. Sort keypoints worst-first and ask: after reviewing the top
// x% of them, what share of the total reprojection error has been seen? If error is
// concentrated, targeted review beats exhaustive review, which is the claim Fig 5
// makes. A diagonal would mean sorting buys nothing.
{
    const v = WORST.subarray(0, NK).filter(Number.isFinite);
    v.sort();
    v.reverse();
    let total = 0;
    for (let i = 0; i < v.length; i++) total += v[i];
    const curve = [];
    let acc = 0;
    for (let i = 0; i < v.length; i++) {
        acc += v[i];
        const frac = (i + 1) / v.length;
        // sample the curve rather than emit one point per keypoint
        if (i === 0 || frac >= curve.length * 0.02) {
            curve.push({ reviewed_frac: +frac.toFixed(4),
                         error_frac: +(acc / total).toFixed(4) });
        }
    }
    curve.push({ reviewed_frac: 1, error_frac: 1 });
    let nOver = 0, sOver = 0;
    for (let i = 0; i < v.length; i++) if (v[i] > 20) { nOver++; sOver += v[i]; }
    out.triage = {
        n: v.length, total_error_px: total, curve,
        over_tau: { tau_px: 20, frac_keypoints: nOver / v.length, frac_error: sOver / total },
        // headline: error captured by reviewing the worst 1/5/10/20%
        captured: [0.01, 0.05, 0.10, 0.20].map(fr => {
            const k = Math.max(1, Math.round(fr * v.length));
            let s2 = 0;
            for (let i = 0; i < k; i++) s2 += v[i];
            return { reviewed_frac: fr, error_frac: s2 / total };
        }),
    };
}
// Robust re-triangulation, bucketed by how bad the worst view was.
out.robust = {};
for (const [name, lo, hi] of [['clean', 0, 3], ['mid', 3, 10], ['outlier', 10, 1e9]]) {
    let n = 0;
    for (let i = 0; i < ROBN; i++) if (ROB_worst[i] >= lo && ROB_worst[i] < hi) n++;
    if (!n) continue;
    const before = nan(n), after = nan(n), moved = nan(n);
    let j = 0, improved = 0;
    for (let i = 0; i < ROBN; i++) {
        if (ROB_worst[i] < lo || ROB_worst[i] >= hi) continue;
        before[j] = ROB_before[i]; after[j] = ROB_after[i]; moved[j] = ROB_moved[i];
        if (ROB_after[i] < ROB_before[i]) improved++;
        j++;
    }
    out.robust[name] = {
        n, kept_view_err_before: stats(before, n), kept_view_err_after: stats(after, n),
        moved_mm: stats(moved, n), improved_frac: improved / n,
    };
}
// DIAGNOSTIC ONLY -- see the header. Never plot this.
out.by_worst_view = { note: 'DIAGNOSTIC: 3D error against a reference whose own '
    + 'reprojection error exceeds both solvers\'. Cannot rank solvers; do not plot.' };
for (const [name, id] of [['clean', 0], ['mid', 1], ['outlier', 2]]) {
    let n = 0;
    for (let i = 0; i < NK; i++) if (BUCKET[i] === id && Number.isFinite(WORST[i])) n++;
    if (!n) continue;
    const d = nan(n), b = nan(n);
    let j = 0;
    for (let i = 0; i < NK; i++) {
        if (BUCKET[i] !== id || !Number.isFinite(WORST[i])) continue;
        d[j] = ERR3D.dlt[i]; b[j] = ERR3D.ba[i]; j++;
    }
    out.by_worst_view[name] = { n, dlt_mm: stats(d, n), ba_mm: stats(b, n) };
}
const outPath = process.env.OUT_JSON || path.join(HERE, 'out', 'fig4.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));

for (const m of METHODS) {
    const s = out.methods[m];
    console.log(`${m.padEnd(10)} reproj p50 ${s.reproj_px.p50.toFixed(3)} px  ` +
                `mean ${s.reproj_px.mean.toFixed(3)}  |  3D p50 ${s.err3d_mm.p50.toFixed(2)} mm  ` +
                `|  ${s.us_per_keypoint.toFixed(0)} us/kp`);
}
console.log(`worse than DLT on the reported error: ba ${worseThanDlt.ba}/${compared}, ` +
            `ba_legacy ${worseThanDlt.ba_legacy}/${compared}`);
{
    const d = out.distortion_px;
    console.log(`[fixture] median |raw - undistorted| = ${d.p50.toFixed(2)} px ` +
                `(p95 ${d.p95.toFixed(2)}, n ${d.n})`);
}
{
    const r = out.reference_reproj_px, d = out.methods.dlt.reproj_px,
          b = out.methods.ba.reproj_px;
    console.log(`reference (proofread 3D) own reproj p50 ${r.p50.toFixed(3)} px ` +
                `vs DLT ${d.p50.toFixed(3)} vs BA ${b.p50.toFixed(3)}`);
}
for (const k of ['clean', 'mid', 'outlier']) {
    const r = out.robust[k];
    if (r) {
        console.log(`  drop-worst-view ${k.padEnd(8)} n=${String(r.n).padStart(5)}  ` +
                    `kept-view err ${r.kept_view_err_before.p50.toFixed(2)} -> ` +
                    `${r.kept_view_err_after.p50.toFixed(2)} px  ` +
                    `3D moved ${r.moved_mm.p50.toFixed(2)} mm  ` +
                    `improved ${(r.improved_frac * 100).toFixed(0)}%`);
    }
    const b = out.by_worst_view[k];
    if (!b || !b.dlt_mm) continue;
    console.log(`  worst view ${k.padEnd(8)} n=${String(b.n).padStart(5)}  ` +
                `3D median  DLT ${b.dlt_mm.p50.toFixed(2)} mm  ` +
                `BA ${b.ba_mm.p50.toFixed(2)} mm  ` +
                `(BA/DLT ${(b.ba_mm.p50 / b.dlt_mm.p50).toFixed(2)}x)  [diagnostic]`);
}
if (out.triage) {
    const c = out.triage.captured;
    console.log('triage: reviewing worst ' + c.map(
        q => `${(q.reviewed_frac * 100).toFixed(0)}% -> ${(q.error_frac * 100).toFixed(0)}% of error`
    ).join(', '));
}
if (out.heldout_reproj_px.dlt && out.heldout_reproj_px.ba) {
    const d = out.heldout_reproj_px.dlt, b = out.heldout_reproj_px.ba;
    const pr = out.heldout_paired;
    console.log(`HELD-OUT view reproj: DLT p50 ${d.p50.toFixed(3)} mean ${d.mean.toFixed(3)}` +
                `  |  BA p50 ${b.p50.toFixed(3)} mean ${b.mean.toFixed(3)}`);
    console.log(`  paired n=${pr.n}: BA better on ${(pr.ba_better_frac * 100).toFixed(1)}%` +
                `, median diff ${pr.median_diff_px.toFixed(4)} px ` +
                `(positive = BA better)`);
}
for (const [k, v] of Object.entries(out.heldout_by_views.by_k)) {
    console.log(`  held-out with ${k} of ${C - 1} views: DLT p50 ${v.dlt.p50.toFixed(3)} px` +
                `  BA p50 ${v.ba.p50.toFixed(3)} px  (n ${v.dlt.n})`);
}
{
    const w = out.per_session.filter(s => s.heldout_p50.dlt != null
                                         && s.heldout_p50.ba != null);
    const dltWins = w.filter(s => s.heldout_p50.dlt < s.heldout_p50.ba).length;
    console.log(`per-session (n=${w.length}): DLT's held-out median is lower in ` +
                `${dltWins}/${w.length} sessions`);
}
console.log(`guard returned the DLT seed on ${out.guard.returned_seed}/${out.guard.of}` +
            ` (${(out.guard.frac * 100).toFixed(2)}%)`);
console.log(`[json] ${outPath}`);
