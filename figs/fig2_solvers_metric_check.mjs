/**
 * Fig 4 — the control that decides whether the anipose arm is a comparison at all.
 *
 * THE HAZARD. The anipose arm (figs/fig2_solvers_anipose.py) scores reprojection error with
 * `cv2.projectPoints`; LUC3D's arms score it with `pose-data.js`'s own
 * `distortPoint` in JS. Both claim to be "mean Euclidean residual in the camera's
 * native pixels", but if the two distortion implementations disagree by even a few
 * hundredths of a pixel, the whole of Fig 4d becomes an artefact: the measured
 * gaps between the three solvers are 0.07-0.22 px, so a 0.05 px metric difference
 * would be most of the result. Nothing else in the pipeline would notice -- each
 * arm is internally consistent and both produce plausible numbers.
 *
 * THE TEST. Take LUC3D's OWN DLT solutions, dump them, and let the Python side
 * re-score those same 3D points with cv2. Same points, same detections, two
 * metrics. Any residual is metric implementation, not solver, because the solver
 * is held fixed by construction.
 *
 * Writes figs/out/fig4_metric_check.json: for the first --n keypoints of block 0,
 * the DLT solution, the JS-computed native error, and the JS-computed held-out
 * error per camera. Checked by `fig2_solvers_anipose.py --verify-metric`.
 *
 * Usage: node figs/fig2_solvers_metric_check.mjs --n 20000
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
register(pathToFileURL(path.join(HERE, 'fig2_solvers_hooks.mjs')).href, import.meta.url);
const tri = await import(pathToFileURL(path.join(POSE_DIR, 'triangulation.js')).href);
const pd = await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);

const argv = process.argv.slice(2);
const i = argv.indexOf('--n');
const N = i >= 0 ? +argv[i + 1] : 20000;

const data = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'fig4_input.json'), 'utf8'));
const buf = fs.readFileSync(path.join(HERE, 'out', data.bin));
const C = data.n_cameras;
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const OBS = new Float64Array(ab, 0, data.keypoints * C * 2);
const cal = data.calibrations[0];
const cameras = cal.map(c => new pd.Camera(c.name, c.matrix, c.distortions, c.rvec, c.tvec, c.size));
const Ps = cameras.map(c => c.projectionMatrix);
const n = Math.min(N, data.blocks[0].count);

/** Verbatim `nativeError` from fig2_solvers_measure.mjs -- do not "improve" it here. */
function nativeError(X, obsRaw) {
    if (!X) return null;
    let sum = 0, cnt = 0;
    for (let ci = 0; ci < C; ci++) {
        if (!obsRaw[ci]) continue;
        const ideal = tri.reprojectPoint(X, Ps[ci]);
        if (!ideal) continue;
        const p = cameras[ci].distortPoint(ideal);
        sum += Math.hypot(p[0] - obsRaw[ci][0], p[1] - obsRaw[ci][1]);
        cnt++;
    }
    return cnt ? sum / cnt : null;
}

const X3 = new Float64Array(n * 3).fill(NaN);
const ERR = new Float64Array(n).fill(NaN);
const HO = new Float64Array(n * C).fill(NaN);       // held-out error, per camera
const HOX = new Float64Array(n * C * 3).fill(NaN);  // and the solve it came from
for (let k = 0; k < n; k++) {
    const raw = new Array(C);
    for (let c = 0; c < C; c++) {
        const j = (k * C + c) * 2;
        raw[c] = Number.isFinite(OBS[j]) && Number.isFinite(OBS[j + 1])
            ? [OBS[j], OBS[j + 1]] : null;
    }
    const und = raw.map((p, ci) => (p ? cameras[ci].undistortPoint(p) : null));
    const X = tri.triangulatePointDLT(und, Ps);
    if (X) { X3[k * 3] = X[0]; X3[k * 3 + 1] = X[1]; X3[k * 3 + 2] = X[2]; }
    const e = nativeError(X, raw);
    if (e != null) ERR[k] = e;

    for (let h = 0; h < C; h++) {
        if (!raw[h]) continue;
        let nv = 0;
        for (let ci = 0; ci < C; ci++) if (ci !== h && raw[ci]) nv++;
        if (nv < 2) continue;
        const undH = und.map((p, ci) => (ci === h ? null : p));
        const Xd = tri.triangulatePointDLT(undH, Ps);
        if (!Xd) continue;
        const ideal = tri.reprojectPoint(Xd, Ps[h]);
        if (!ideal) continue;
        const q = cameras[h].distortPoint(ideal);
        const d = Math.hypot(q[0] - raw[h][0], q[1] - raw[h][1]);
        if (Number.isFinite(d)) {
            HO[k * C + h] = d;
            const b = (k * C + h) * 3;
            HOX[b] = Xd[0]; HOX[b + 1] = Xd[1]; HOX[b + 2] = Xd[2];
        }
    }
}

const bin = path.join(HERE, 'out', 'fig4_metric_check.bin');
fs.writeFileSync(bin, Buffer.concat([
    Buffer.from(X3.buffer), Buffer.from(ERR.buffer),
    Buffer.from(HO.buffer), Buffer.from(HOX.buffer),
]));
fs.writeFileSync(path.join(HERE, 'out', 'fig4_metric_check.json'), JSON.stringify({
    n, cameras: C, bin: 'fig4_metric_check.bin', poseDir: POSE_DIR,
    layout: ['X3 (n,3)', 'ERR (n)', 'HO (n,C)', 'HOX (n,C,3)'],
    note: ("LUC3D's own DLT solutions and its own native-space error for the first n "
           + 'keypoints of block 0 (calibration 0). Re-score X3/HOX with cv2 and the '
           + 'difference is the METRIC, not the solver.'),
}, null, 1));
console.log(`[metric-check] ${n} keypoints -> figs/out/fig4_metric_check.{json,bin}`);
