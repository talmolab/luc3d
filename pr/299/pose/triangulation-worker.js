/**
 * triangulation-worker.js — module worker that runs `triangulateAndReproject`
 * for batches of instance groups, for the parallel Triangulate All
 * (`pose/triangulation-pool.js`).
 *
 * It runs the SAME code the main thread runs (`./triangulation-core.js`) on the
 * same inputs, so results are bit-identical:
 *   - cameras arrive with the main thread's own cached rotation / extrinsic /
 *     projection matrices installed, so no matrix is recomputed here;
 *   - each group arrives as, per camera, a copy of its instance's flat `_xy`
 *     plus its nulled-node indices, rebuilt into real `Instance`s;
 *   - the two settings the pipeline reads (camera inclusion, reprojection
 *     threshold) arrive already resolved in `options`.
 *
 * Messages in:
 *   { type: 'cameras', cameras: [{ name, matrix, dist, rvec, tvec, size, R, Rt, P }] }
 *   { type: 'solve', id, jobs: [{ camNames, insts: [{ xy, nulled } | null], options }] }
 * Messages out:
 *   { type: 'solved', id, results: [triangulateAndReproject result] }  (points3d transferred)
 *   { type: 'error', id, message }
 */
import { Camera, Instance } from './pose-data.js?v=c7dfbda309cd';
import { triangulateAndReproject } from './triangulation-core.js?v=c7dfbda309cd';

let cameras = new Map();

function buildCamera(c) {
    const cam = new Camera(c.name, c.matrix, c.dist, c.rvec, c.tvec, c.size);
    // The main thread's cached matrices, so nothing is re-derived here.
    cam._cachedR = c.R;
    cam._cachedRt = c.Rt;
    cam._cachedP = c.P;
    return cam;
}

function solveJob(job) {
    const byCam = new Map();
    for (let i = 0; i < job.camNames.length; i++) {
        const src = job.insts[i];
        if (!src) continue;
        const inst = new Instance(src.xy, 0, 'predicted', 1);
        if (src.nulled) inst.nulledNodes = new Set(src.nulled);
        byCam.set(job.camNames[i], inst);
    }
    const group = { getInstance: (name) => byCam.get(name) };
    const cams = job.camNames.map((n) => cameras.get(n));
    // The method is threaded through EXPLICITLY (never left to
    // triangulateAndReproject's silent DLT default — see
    // tests/test-triangulation-method-propagation.mjs).
    const o = job.options, method = o.method;
    return triangulateAndReproject(group, cams, {
        method: method, includedCameras: o.includedCameras,
        reprojErrorThreshold: o.reprojErrorThreshold, triangulateOnly: o.triangulateOnly,
    });
}

self.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'cameras') {
        cameras = new Map();
        for (const c of m.cameras) cameras.set(c.name, buildCamera(c));
        return;
    }
    if (m.type === 'solve') {
        try {
            const results = new Array(m.jobs.length);
            const transfer = [];
            for (let i = 0; i < m.jobs.length; i++) {
                const r = solveJob(m.jobs[i]);
                results[i] = r;
                if (r.points3d && r.points3d.buffer) transfer.push(r.points3d.buffer);
            }
            self.postMessage({ type: 'solved', id: m.id, results }, transfer);
        } catch (err) {
            self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
        }
    }
};
