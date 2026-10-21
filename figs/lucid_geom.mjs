/**
 * LUC3D v1.0.5 geometry for Python callers (LUC3D-JS plan R2, 2026-10-20).
 *
 * Python scripts in figs/ must not triangulate, undistort or reproject on LUC3D's
 * behalf. When one needs those steps it hands a batch to this script, which runs the
 * app's own code -- `pose-data.js` `Camera` (undistortPoint / distortPoint) and
 * `triangulation.js` (`triangulatePointDLT`, `reprojectPoint`) -- from the checkout
 * `lucid_v105.mjs` asserts. Same calls, in the same order, as fig2_solvers_by_views.mjs.
 *
 *   node figs/lucid_geom.mjs <request.json>
 *
 * request.json: { mode, cameras: [{name, matrix, distortions, rvec, tvec, size}], in, out }
 *   mode "triangulate": in = float64 (M, C, 2) RAW (distorted) pixels, NaN = missing.
 *        Each point is undistorted with its camera, then triangulatePointDLT over the
 *        views that have it (>= 2). out = float64 (M, 3), NaN where untriangulable.
 *   mode "project": in = float64 (M, 3) points in the calibration frame.
 *        out = float64 (C, M, 2) distorted pixels per camera: reprojectPoint, then
 *        distortPoint. NaN where the input is NaN or the point does not project.
 *   mode "project_pinhole": as "project" but WITHOUT distortPoint: reprojectPoint's own
 *        UNDISTORTED pixels, the coordinates of a cv2.undistort-ed frame (overlays drawn
 *        on undistorted photos).
 * Writes <out>.json beside the binary with the LUC3D stamp, which callers record.
 */
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lucidPose } from './lucid_v105.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { poseDir: POSE_DIR, stamp: LUCID } = lucidPose();
register(pathToFileURL(path.join(HERE, 'fig2_solvers_hooks.mjs')).href, import.meta.url);
const tri = await import(pathToFileURL(path.join(POSE_DIR, 'triangulation.js')).href);
const pd = await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);

const req = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const cams = req.cameras.map(c =>
    new pd.Camera(c.name, c.matrix, c.distortions, c.rvec, c.tvec, c.size));
const Ps = cams.map(c => c.projectionMatrix);
const C = cams.length;
const buf = fs.readFileSync(req.in);
const IN = new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

let OUT, M;
if (req.mode === 'triangulate') {
    M = IN.length / (C * 2);
    OUT = new Float64Array(M * 3).fill(NaN);
    const obs = new Array(C);
    for (let i = 0; i < M; i++) {
        for (let c = 0; c < C; c++) {
            const x = IN[(i * C + c) * 2], y = IN[(i * C + c) * 2 + 1];
            obs[c] = Number.isFinite(x) && Number.isFinite(y) ? cams[c].undistortPoint([x, y]) : null;
        }
        const X = tri.triangulatePointDLT(obs, Ps);
        if (X) { OUT[i * 3] = X[0]; OUT[i * 3 + 1] = X[1]; OUT[i * 3 + 2] = X[2]; }
    }
} else if (req.mode === 'project' || req.mode === 'project_pinhole') {
    M = IN.length / 3;
    OUT = new Float64Array(C * M * 2).fill(NaN);
    for (let i = 0; i < M; i++) {
        const X = [IN[i * 3], IN[i * 3 + 1], IN[i * 3 + 2]];
        if (!X.every(Number.isFinite)) continue;
        for (let c = 0; c < C; c++) {
            const id = tri.reprojectPoint(X, Ps[c]);
            if (!id) continue;
            const p = req.mode === 'project' ? cams[c].distortPoint(id) : id;
            OUT[(c * M + i) * 2] = p[0]; OUT[(c * M + i) * 2 + 1] = p[1];
        }
    }
} else {
    throw new Error(`unknown mode ${req.mode}`);
}
fs.writeFileSync(req.out, Buffer.from(OUT.buffer));
fs.writeFileSync(req.out + '.json', JSON.stringify(
    { ...LUCID, driver: 'figs/lucid_geom.mjs', mode: req.mode, points: M, cameras: C }));
