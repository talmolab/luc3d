/**
 * Per-SESSION robust re-triangulation for Fig 4c (Eric, 2026-08-15: "just do the
 * reprojection error per session scatter for all views and worst view dropped ...
 * then take the average -- I don't like the disagreement strata").
 *
 * fig2_solvers_measure.mjs computes the same before/after quantities but pools them into
 * three worst-view-disagreement strata and never records which SESSION a solve came
 * from -- so the per-session form Eric asked for is not derivable from fig4.json.
 * This is the robust arm alone (two DLT solves per keypoint, no BA -- the expensive
 * refinement is not needed for this comparison), re-run with session capture, over
 * the SAME export (out/fig4_input.json), the same undistort/solve/nativeError calls
 * imported from the same pose modules through the same loader hook.
 *
 * GATE: the pooled means recomputed here must reproduce fig4.json's
 * robust.{clean,mid,outlier} n-weighted means to 1e-9 -- same computation, so any
 * daylight means this pass diverged from the deposit's and its per-session numbers
 * would not be the published quantity's.
 *
 *   node figs/fig2_solvers_robust_sessions.mjs
 *
 * Output: figs/out/fig4_robust_sessions.json  (fig4.json is NOT touched)
 */
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSE_DIR = path.join(HERE, '..', 'pose');
const HOOKS = path.join(HERE, 'fig3-bench', 'probe_hooks.mjs');
if (fs.existsSync(HOOKS)) register(pathToFileURL(HOOKS).href, import.meta.url);

const tri = await import(pathToFileURL(path.join(POSE_DIR, 'triangulation.js')).href);

const inPath = path.join(HERE, 'out', 'fig4_input.json');
const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
if (data.format !== 'bin-v1') throw new Error('expects the bin-v1 export');

const buf = fs.readFileSync(path.join(HERE, 'out', data.bin));
const NK = data.keypoints;
const C = data.n_cameras;
const obsLen = NK * C * 2;
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const OBS = new Float64Array(ab, 0, obsLen);

// Per-block calibration, exactly as fig2_solvers_measure.mjs builds it.
const pd = await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
// The Camera constructor call is fig2_solvers_measure.mjs's own, positional -- the dict
// guess in the first draft built cameras with undefined rvec.
const calSets = (data.calibrations && data.calibrations.length
    ? data.calibrations : [data.cameras]).map(set => {
    const cams = set.map(c =>
        new pd.Camera(c.name, c.matrix, c.distortions, c.rvec, c.tvec, c.size));
    return { cameras: cams, Ps: cams.map(c => c.projectionMatrix) };
});
const CAL_OF = new Uint8Array(NK);
for (const b of data.blocks) CAL_OF.fill(b.calibration || 0, b.offset, b.offset + b.count);

function obsAt(k) {
    const o = new Array(C);
    for (let c = 0; c < C; c++) {
        const i = (k * C + c) * 2;
        o[c] = Number.isFinite(OBS[i]) && Number.isFinite(OBS[i + 1])
            ? [OBS[i], OBS[i + 1]] : null;
    }
    return o;
}

function nativeError(X, obsRaw, cameras, Ps) {
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

const perSession = [];
const strata = { clean: [0, 3, 0, 0, 0], mid: [3, 10, 0, 0, 0], outlier: [10, 1e9, 0, 0, 0] };
const t0 = Date.now();
for (const b of data.blocks) {
    const { cameras, Ps } = calSets[b.calibration || 0];
    let n = 0, sumB = 0, sumA = 0;
    let nR = 0, sumBR = 0, sumAR = 0;   // REFINED arm (added 2026-09-29), see below
    const hi = Math.min(NK, b.offset + b.count);
    for (let k = b.offset; k < hi; k++) {
        const raw = obsAt(k);
        const und = raw.map((p, ci) => (p ? cameras[ci].undistortPoint(p) : null));
        const Xdlt = tri.triangulatePointDLT(und, Ps);
        if (!Xdlt) continue;
        let worst = 0, worstIdx = -1;
        for (let ci = 0; ci < C; ci++) {
            if (!raw[ci]) continue;
            const ideal = tri.reprojectPoint(Xdlt, Ps[ci]);
            if (!ideal) continue;
            const q = cameras[ci].distortPoint(ideal);
            const dv = Math.hypot(q[0] - raw[ci][0], q[1] - raw[ci][1]);
            if (dv > worst) { worst = dv; worstIdx = ci; }
        }
        if (worstIdx < 0) continue;
        const kept = raw.map((p, ci) => (ci === worstIdx ? null : p));
        const keptU = und.map((p, ci) => (ci === worstIdx ? null : p));
        const Xdrop = tri.triangulatePointDLT(keptU, Ps);
        if (!Xdrop) continue;
        const before = nativeError(Xdlt, kept, cameras, Ps);
        const after = nativeError(Xdrop, kept, cameras, Ps);
        if (before == null || after == null) continue;
        n++; sumB += before; sumA += after;
        for (const name in strata) {
            const s = strata[name];
            if (worst >= s[0] && worst < s[1]) { s[2]++; s[3] += before; s[4] += after; }
        }
        // REFINED arm (added 2026-09-29 so Fig 2E bottom shows both solvers). The same
        // operation with the refined solver throughout: solve from all views (seeded by
        // the DLT, as the app does), drop the view that fits the REFINED solution worst,
        // re-solve refined from the rest (seeded by the DLT of the kept views), and score
        // both on the kept views with the same nativeError. Runs strictly AFTER the DLT
        // arm, so the DLT numbers and their gate are unchanged.
        const Xba = tri.triangulatePointBA(raw, Ps, Xdlt, { cameras });
        if (Xba) {
            let wR = 0, wIdx = -1;
            for (let ci = 0; ci < C; ci++) {
                if (!raw[ci]) continue;
                const ideal = tri.reprojectPoint(Xba, Ps[ci]);
                if (!ideal) continue;
                const q = cameras[ci].distortPoint(ideal);
                const dv = Math.hypot(q[0] - raw[ci][0], q[1] - raw[ci][1]);
                if (dv > wR) { wR = dv; wIdx = ci; }
            }
            if (wIdx >= 0) {
                const keptR = raw.map((p, ci) => (ci === wIdx ? null : p));
                const keptRU = und.map((p, ci) => (ci === wIdx ? null : p));
                const seed = tri.triangulatePointDLT(keptRU, Ps);
                const XbaDrop = seed ? tri.triangulatePointBA(keptR, Ps, seed, { cameras }) : null;
                const bR = nativeError(Xba, keptR, cameras, Ps);
                const aR = nativeError(XbaDrop, keptR, cameras, Ps);
                if (bR != null && aR != null) { nR++; sumBR += bR; sumAR += aR; }
            }
        }
    }
    perSession.push({ session: b.session, n,
                      all_views_px: n ? sumB / n : null,
                      worst_dropped_px: n ? sumA / n : null,
                      n_refined: nR,
                      refined_all_views_px: nR ? sumBR / nR : null,
                      refined_worst_dropped_px: nR ? sumAR / nR : null });
    console.log(`${b.session}: n=${n} before=${(sumB / n).toFixed(3)} ` +
                `after=${(sumA / n).toFixed(3)}  refined ${(sumBR / nR).toFixed(3)} -> ` +
                `${(sumAR / nR).toFixed(3)} (${((Date.now() - t0) / 1000) | 0}s)`);
}

// GATE against the deposit's pooled strata means.
const dep = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'fig4.json'), 'utf8'));
const gate = {};
let ok = true;
for (const name in strata) {
    const s = strata[name];
    const ref = dep.robust[name];
    const dB = Math.abs(s[3] / s[2] - ref.kept_view_err_before.mean);
    const dA = Math.abs(s[4] / s[2] - ref.kept_view_err_after.mean);
    const dN = s[2] - ref.n;
    gate[name] = { n_diff: dN, before_mean_diff: dB, after_mean_diff: dA };
    if (dN !== 0 || dB > 1e-9 || dA > 1e-9) ok = false;
    console.log(`gate ${name}: n ${s[2]} vs ${ref.n}, |dB| ${dB.toExponential(2)}, ` +
                `|dA| ${dA.toExponential(2)}`);
}
if (!ok) console.log('GATE FAILED -- deposited with passed:false; do NOT plot');

fs.writeFileSync(path.join(HERE, 'out', 'fig4_robust_sessions.json'), JSON.stringify({
    generated_by: 'figs/fig2_solvers_robust_sessions.mjs',
    claim: 'Per-session mean reprojection error in the kept views: the all-view DLT ' +
           'solution vs the same solve with the worst-fitting view dropped. Session ' +
           'capture of the same computation fig4.json pools into disagreement strata. ' +
           'refined_*: the same operation with the refined solver throughout (worst view ' +
           'chosen by the refined residual), added 2026-09-29.',
    gate: { passed: ok, ...gate },
    per_session: perSession,
}, null, 1));
console.log(`wrote out/fig4_robust_sessions.json (gate ${ok ? 'PASSED' : 'FAILED'})`);
