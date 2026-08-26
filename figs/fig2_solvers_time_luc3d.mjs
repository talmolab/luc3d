/**
 * Fig 4e — re-time LUC3D's two solvers on a SUBSAMPLE of the same input, so the
 * anipose bar and the LUC3D bars come out of one sitting on one machine.
 *
 * WHY THIS EXISTS. `fig2_solvers_measure.mjs` already deposits `methods.{dlt,ba}
 * .us_per_keypoint`, measured over all 4.25 M keypoints. That is the number the
 * panel quotes. But the anipose arm is measured months later by a different
 * process, and "6.3 vs 43.8 vs N" is only a comparison if the three were timed
 * under the same machine load. This script re-times the two LUC3D solvers on the
 * first `--n` keypoints, in the SAME scope fig2_solvers_measure.mjs uses, immediately
 * before/after the anipose timing, so `fig2_solvers_anipose.py` can check the two agree
 * and refuse to plot if they do not.
 *
 * SCOPE, and it matters. fig2_solvers_measure.mjs times ONLY the solve:
 *
 *     const und = raw.map(...undistortPoint...);      // NOT timed
 *     t0 = now(); triangulatePointDLT(und, Ps);       // timed  -> dlt
 *     t0 = now(); triangulatePointBA(raw, Ps, Xdlt);  // timed  -> ba
 *
 * aniposelib's `CameraGroup.triangulate` undistorts INSIDE the call, so a naive
 * comparison charges anipose for work LUC3D's number excludes. This script
 * therefore also times undistortion separately (`undistort_us_per_keypoint`) and
 * `fig2_solvers_anipose.py` reports anipose both ways.
 *
 * Reads figs/out/fig4_input.json + .bin (bin-v1 only). Writes JSON on stdout.
 *
 * Env: POSE_DIR=  (default ../lucid-bundle-adj/pose, as fig2_solvers_measure.mjs)
 * Usage: node figs/fig2_solvers_time_luc3d.mjs --n 200000 --repeats 3
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
if (!fs.existsSync(POSE_DIR)) throw new Error(`no pose dir at ${POSE_DIR}`);
register(pathToFileURL(path.join(HERE, 'fig2_solvers_hooks.mjs')).href, import.meta.url);

const tri = await import(pathToFileURL(path.join(POSE_DIR, 'triangulation.js')).href);
const pd = await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? +argv[i + 1] : dflt;
};
const N = arg('n', 200000);
const REPEATS = arg('repeats', 3);

const data = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'fig4_input.json'), 'utf8'));
if (data.format !== 'bin-v1') throw new Error('expected bin-v1 input');
const buf = fs.readFileSync(path.join(HERE, 'out', data.bin));
const C = data.n_cameras;
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const OBS = new Float64Array(ab, 0, data.keypoints * C * 2);

// Calibration 0 only, and the run is capped at block 0's keypoint count so every
// timed keypoint really is on that calibration. A timing run that silently used
// one rig's intrinsics for another rig's detections would still produce a plausible
// number -- the solve does not care -- so the cap is asserted, not assumed.
const cal = (data.calibrations && data.calibrations.length ? data.calibrations[0] : data.cameras);
const cameras = cal.map(c => new pd.Camera(c.name, c.matrix, c.distortions, c.rvec, c.tvec, c.size));
const Ps = cameras.map(c => c.projectionMatrix);
const block0 = (data.blocks && data.blocks.length) ? data.blocks[0] : null;
const cap = block0 ? block0.count : data.keypoints;
const n = Math.min(N, cap);
if (block0 && (block0.offset !== 0 || (block0.calibration || 0) !== 0)) {
    throw new Error('block 0 is not calibration 0 at offset 0; fix the slice');
}

/** Keypoint k as [[x,y]|null x C] of RAW (distorted) detections. */
function rawAt(k) {
    const o = new Array(C);
    for (let c = 0; c < C; c++) {
        const i = (k * C + c) * 2;
        o[c] = Number.isFinite(OBS[i]) && Number.isFinite(OBS[i + 1])
            ? [OBS[i], OBS[i + 1]] : null;
    }
    return o;
}
const RAW = [];
for (let k = 0; k < n; k++) RAW.push(rawAt(k));

// Warm the JIT on a prefix. Without this the first pass pays deoptimisation on a
// cold, polymorphic call site and reads ~3x the steady-state cost -- which is
// roughly the gap between this script's numbers and the whole-corpus run's, where
// 4.25 M iterations amortise the warm-up to nothing.
{
    const w = Math.min(n, 20000);
    for (let k = 0; k < w; k++) {
        const raw = RAW[k];
        const und = raw.map((p, ci) => (p ? cameras[ci].undistortPoint(p) : null));
        const X = tri.triangulatePointDLT(und, Ps);
        tri.triangulatePointBA(raw, Ps, X, { cameras });
    }
}

const best = { undistort: Infinity, dlt: Infinity, ba: Infinity };
for (let r = 0; r < REPEATS; r++) {
    const UND = new Array(n);
    let t0 = performance.now();
    for (let k = 0; k < n; k++) {
        const raw = RAW[k];
        UND[k] = raw.map((p, ci) => (p ? cameras[ci].undistortPoint(p) : null));
    }
    best.undistort = Math.min(best.undistort, performance.now() - t0);

    // KEEP THE RESULT IN A LOCAL, exactly as fig2_solvers_measure.mjs does. Storing each
    // solve into an `Array(n)` instead measured 13 us/kp against fig2_solvers_measure.mjs's
    // 6.3 -- the DLT is cheap enough that retaining 200k boxed [x,y,z] arrays
    // (allocation plus the GC that follows) roughly doubles it, and the panel would
    // have reported the harness's bookkeeping as the solver's cost. `sink` keeps
    // the call from being optimised away without retaining anything.
    let sink = 0;
    t0 = performance.now();
    for (let k = 0; k < n; k++) {
        const X = tri.triangulatePointDLT(UND[k], Ps);
        if (X) sink += X[0];
    }
    best.dlt = Math.min(best.dlt, performance.now() - t0);

    // The BA step needs a seed, so build the seeds UNTIMED and time only the
    // refinement -- which is what fig2_solvers_measure.mjs's `ba` number is.
    const SEED = new Array(n);
    for (let k = 0; k < n; k++) SEED[k] = tri.triangulatePointDLT(UND[k], Ps);
    t0 = performance.now();
    for (let k = 0; k < n; k++) {
        const X = tri.triangulatePointBA(RAW[k], Ps, SEED[k], { cameras });
        if (X) sink += X[0];
    }
    best.ba = Math.min(best.ba, performance.now() - t0);
    if (!Number.isFinite(sink)) throw new Error('non-finite solves in the timing run');
}

process.stdout.write(JSON.stringify({
    n, repeats: REPEATS, poseDir: POSE_DIR, node: process.version,
    undistort_us_per_keypoint: (best.undistort * 1000) / n,
    dlt_us_per_keypoint: (best.dlt * 1000) / n,
    ba_us_per_keypoint: (best.ba * 1000) / n,
    note: ('best-of-repeats, single-threaded, JIT warmed on a 20k prefix. Scope '
           + 'matches fig2_solvers_measure.mjs: undistortion is timed SEPARATELY and is '
           + 'not part of dlt/ba. ba is the refinement step alone, seeded by the '
           + 'DLT solution, exactly as the app runs it.'),
}, null, 1) + '\n');
