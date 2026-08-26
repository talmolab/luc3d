/**
 * Fig 4b — error vs view count for BOTH LUC3D solvers, in TWO metrics.
 *
 * WHY THIS EXISTS. Panel b's curve came from `fig2_measure.py`, whose
 * `triangulate_batch` is a vectorised NumPy DLT. There is no refinement arm there,
 * and adding one would mean reimplementing `triangulatePointBA` in Python — a
 * second implementation of the thing under test, which is how you end up measuring
 * the reimplementation. This runs the REAL branch solvers over Fig 4's own input,
 * so both curves come from one run, one keypoint set, one alignment.
 *
 * TWO ARMS, AND ONLY ONE OF THEM CAN COMPARE SOLVERS.
 * ---------------------------------------------------
 *   heldout_px  (PLOTTED)  Solve from k views, project into a camera the solve was
 *                          NOT given, score against that camera's RAW DETECTION.
 *                          No reference 3D enters it. Neither solver optimises it.
 *                          k = 2..C-1 only — at k = C there is no camera left to
 *                          hold out, which is a hard limit of a 5-camera rig, not a
 *                          choice.
 *   err3d_mm    (deposited, NOT plotted)  3D distance to the proofread reference.
 *
 * The mm arm was what panel b plotted until `fig2_solvers_move_geometry.mjs` measured why it
 * cannot rank two solvers. Per keypoint, with D = DLT, R = refined, G = reference:
 * the refinement MOVES a median 1.249 mm at k = 5 while the reference sits 1.214 mm
 * from the DLT, and the move's direction is essentially UNCORRELATED with the
 * direction to the reference (median cos 0.135, mean 0.066; at k = 2, 0.004). Adding
 * a displacement orthogonal to an existing error always increases the distance —
 * measured |R-G| 2.895 mm at k = 2 against a perpendicular prediction of 2.917 — so
 * the mm axis reports "the refinement moved" and calls it "the refinement is worse",
 * whichever way it moved. That is arithmetic, not accuracy.
 *
 * (It also rules OUT the alternative reading. A solver genuinely trading 3D accuracy
 * for 2D fit would move systematically AWAY from truth: cos well below zero and
 * |R-G| approaching |D-G| + |R-D| = 2.463 mm at k = 5. Measured 1.852 mm, cos
 * slightly POSITIVE. So the refinement is not wrecking the 3D — the reference simply
 * cannot see what it did.)
 *
 * NOT fig2.json's px arm, which is a different measurement despite the similar name:
 * `by_anchor_count` scores against `gtk`, the REPROJECTED REFERENCE ("3D-consistent
 * target"), so it inherits the reference's error too. This arm scores against the
 * raw detection, matching `fig2_solvers_measure.mjs`'s `heldout_by_views`, and cross-checks
 * against that rather than against fig2.
 *
 * PROTOCOL. For each k, for every C-choose-k subset of cameras, solve from just
 * those views with each solver; then (px) project into every camera outside the
 * subset that has a detection and take the Euclidean residual in that camera's
 * NATIVE pixels, and (mm) take the 3D distance to the reference scaled by the
 * session's own `mm_per_unit`. Per session, all subsets at a given k are pooled and
 * that session's p25/p50/p75 recorded; the panel plots the across-session median of
 * each, so the band is the typical session's IQR.
 *
 * SHARDING. Sessions are independent here -- every accumulator is per session and
 * the published summary is a median ACROSS session medians -- so a run splits
 * cleanly across processes by block index. `BLOCKS=lo:hi` measures only that
 * half-open range of blocks; `node figs/fig2_solvers_by_views.mjs --merge a.json b.json ...`
 * concatenates the shards' `per_session` rows (in block order) and recomputes the
 * summary through the SAME `summarize()` the single-process path uses, so a merged
 * run and a whole run differ in nothing but wall clock. Verified: 16 shards at
 * STRIDE=4 reproduce the single-process stride-4 run to the last digit. Default (no
 * BLOCKS) is unchanged -- every block, one process.
 *
 * Env: POSE_DIR=  STRIDE=<n, default 4>  OUT_JSON=  BLOCKS=<lo:hi>
 * Usage: node figs/fig2_solvers_by_views.mjs
 *        BLOCKS=0:10 OUT_JSON=out/shard0.json node figs/fig2_solvers_by_views.mjs
 *        node figs/fig2_solvers_by_views.mjs --merge out/shard*.json
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

const STRIDE = +(process.env.STRIDE || 4);

/** Median of a numeric array (the across-session summary panel b plots). */
function med(xs) {
    const v = xs.filter(Number.isFinite).sort((a, b2) => a - b2);
    if (!v.length) return null;
    const h = v.length >> 1;
    return v.length % 2 ? v[h] : 0.5 * (v[h - 1] + v[h]);
}

/**
 * The published summary, from per-session rows alone. Factored out so a merged run
 * and a single-process run go through identical arithmetic.
 */
function summarize(perSession, C, extra) {
    const METHODS_ = ['dlt', 'ba'];
    const out = {
        sessions: perSession.length, cameras: C,
        ...extra,
        heldout_px_across_sessions: {},
        err3d_mm_across_sessions: {},
        per_session: perSession,
    };
    for (let k = 2; k <= C; k++) {
        out.err3d_mm_across_sessions[k] = {};
        for (const m of METHODS_) {
            const g = perSession.map(r => r.by_k[k][m]).filter(Boolean);
            out.err3d_mm_across_sessions[k][m] = {
                p25: med(g.map(x => x.p25)), p50: med(g.map(x => x.p50)),
                p75: med(g.map(x => x.p75)), n_sessions: g.length,
                n_values: g.reduce((a, x) => a + x.n, 0),
            };
        }
        if (k >= C) continue;
        out.heldout_px_across_sessions[k] = {};
        for (const m of METHODS_) {
            const g = perSession.map(r => r.heldout_px_by_k[k][m]).filter(Boolean);
            out.heldout_px_across_sessions[k][m] = {
                p25: med(g.map(x => x.p25)), p50: med(g.map(x => x.p50)),
                p75: med(g.map(x => x.p75)), n_sessions: g.length,
                n_values: g.reduce((a, x) => a + x.n, 0),
            };
        }
    }
    return out;
}

// --- merge mode: recombine shards and exit, before any measurement machinery ---
const MERGE_AT = process.argv.indexOf('--merge');
if (MERGE_AT >= 0) {
    const shards = process.argv.slice(MERGE_AT + 1)
        .map(p => JSON.parse(fs.readFileSync(p, 'utf8')));
    if (!shards.length) throw new Error('--merge needs shard json paths');
    const C_ = shards[0].cameras;
    for (const s of shards) {
        if (s.cameras !== C_ || s.stride_within_export !== shards[0].stride_within_export
            || s.export_stride !== shards[0].export_stride) {
            throw new Error('shards disagree on cameras/stride — refusing to merge');
        }
    }
    const rows = shards.flatMap(s => s.per_session)
        .sort((a, b2) => a.block_index - b2.block_index);
    const seen = new Set();
    for (const r of rows) {
        if (seen.has(r.block_index)) throw new Error(`block ${r.block_index} appears twice`);
        seen.add(r.block_index);
    }
    const merged = summarize(rows, C_, {
        stride_within_export: shards[0].stride_within_export,
        export_stride: shards[0].export_stride,
        keypoints_used: rows.reduce((a, r) => a + r.n_keypoints, 0),
        subsets_per_k: shards[0].subsets_per_k, poseDir: shards[0].poseDir,
        solves: shards.reduce((a, s) => a + s.solves, 0),
        plotted_arm: shards[0].plotted_arm, caveat: shards[0].caveat,
        merged_from: shards.length,
    });
    const mp = process.env.OUT_JSON || path.join(HERE, 'out', 'fig4_by_views.json');
    fs.writeFileSync(mp, JSON.stringify(merged, null, 1));
    console.log(`[merge] ${shards.length} shards, ${rows.length} sessions, ` +
                `${merged.keypoints_used} keypoints, ${merged.solves} solves`);
    for (let k = 2; k < C_; k++) {
        const d = merged.heldout_px_across_sessions[k].dlt;
        const b = merged.heldout_px_across_sessions[k].ba;
        console.log(`  k=${k}  DLT ${d.p50.toFixed(3)}  refined ${b.p50.toFixed(3)}  ` +
                    `(n ${d.n_values})`);
    }
    console.log(`[json] ${mp}`);
    process.exit(0);
}

const data = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'fig4_input.json'), 'utf8'));
if (data.format !== 'bin-v1') throw new Error('expected bin-v1 input');
const buf = fs.readFileSync(path.join(HERE, 'out', data.bin));
const NK = data.keypoints, C = data.n_cameras;
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const OBS = new Float64Array(ab, 0, NK * C * 2);
const GT = new Float64Array(ab, NK * C * 2 * 8, NK * 3);

const calSets = (data.calibrations && data.calibrations.length
    ? data.calibrations : [data.cameras]).map(set => {
        const cams = set.map(c =>
            new pd.Camera(c.name, c.matrix, c.distortions, c.rvec, c.tvec, c.size));
        return { cameras: cams, Ps: cams.map(c => c.projectionMatrix) };
    });
const blocks = data.blocks;
// BLOCKS=lo:hi -- measure only this half-open range of sessions (see the header).
const [BLO, BHI] = process.env.BLOCKS
    ? process.env.BLOCKS.split(':').map(Number)
    : [0, blocks.length];
if (!(BLO >= 0 && BHI <= blocks.length && BLO < BHI)) {
    throw new Error(`BLOCKS=${process.env.BLOCKS} out of range (${blocks.length} blocks)`);
}

/** All C-choose-k camera subsets, as boolean masks, for k = 2..C. */
const SUBSETS = {};
for (let k = 2; k <= C; k++) {
    SUBSETS[k] = [];
    for (let bits = 0; bits < (1 << C); bits++) {
        let n = 0;
        for (let c = 0; c < C; c++) if ((bits >> c) & 1) n++;
        if (n !== k) continue;
        const m = new Array(C);
        for (let c = 0; c < C; c++) m[c] = !!((bits >> c) & 1);
        SUBSETS[k].push(m);
    }
}
const NSUB = {};
for (let k = 2; k <= C; k++) NSUB[k] = SUBSETS[k].length;
console.log(`[protocol] subsets per k: ` +
            Object.entries(NSUB).map(([k, v]) => `k=${k}:${v}`).join(' '));

/** Percentiles of the finite entries of a Float64Array prefix. */
function stats(a, n) {
    const v = a.subarray(0, n).filter(Number.isFinite);
    if (!v.length) return null;
    v.sort();
    const q = p => v[Math.min(v.length - 1, Math.floor(v.length * p / 100))];
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i];
    return { n: v.length, mean: s / v.length, p25: q(25), p50: q(50), p75: q(75) };
}

const METHODS = ['dlt', 'ba'];
const perSession = [];
const t0 = Date.now();
let solves = 0;

for (let bi = BLO; bi < BHI; bi++) {
    const b = blocks[bi];
    const cs = calSets[b.calibration || 0];
    const cameras = cs.cameras, Ps = cs.Ps;
    const MM = b.mm_per_unit || data.mm_per_unit || 1;
    const lo = b.offset, hi = Math.min(NK, b.offset + b.count);
    // Count the strided keypoints first so every accumulator is a right-sized typed
    // array -- at k=2 this session contributes 10 values per keypoint and a JS array
    // of those would be ~10x the boxed-number cost for nothing.
    let nkp = 0;
    for (let k = lo; k < hi; k += STRIDE) nkp++;
    const ACC = {}, PX = {};
    for (const m of METHODS) {
        ACC[m] = {}; PX[m] = {};
        for (let k = 2; k <= C; k++) {
            ACC[m][k] = new Float64Array(nkp * NSUB[k]).fill(NaN);
            // px arm: one value per (subset, held-out camera), so C-k per subset. At
            // k = C there is no held-out camera and the array is empty by construction.
            if (k < C) PX[m][k] = new Float64Array(nkp * NSUB[k] * (C - k)).fill(NaN);
        }
    }
    const N = {}, NP = {};
    for (const m of METHODS) {
        N[m] = {}; NP[m] = {};
        for (let k = 2; k <= C; k++) { N[m][k] = 0; NP[m][k] = 0; }
    }

    for (let kk = lo; kk < hi; kk += STRIDE) {
        const raw = new Array(C), und = new Array(C);
        for (let c = 0; c < C; c++) {
            const i = (kk * C + c) * 2;
            raw[c] = Number.isFinite(OBS[i]) && Number.isFinite(OBS[i + 1])
                ? [OBS[i], OBS[i + 1]] : null;
            und[c] = raw[c] ? cameras[c].undistortPoint(raw[c]) : null;
        }
        const gx = GT[kk * 3], gy = GT[kk * 3 + 1], gz = GT[kk * 3 + 2];
        if (!Number.isFinite(gx)) continue;

        for (let k = 2; k <= C; k++) {
            for (const m of SUBSETS[k]) {
                let nv = 0;
                for (let c = 0; c < C; c++) if (m[c] && raw[c]) nv++;
                if (nv < 2) continue;
                const rk = new Array(C), uk = new Array(C);
                for (let c = 0; c < C; c++) {
                    rk[c] = m[c] ? raw[c] : null;
                    uk[c] = m[c] ? und[c] : null;
                }
                const Xd = tri.triangulatePointDLT(uk, Ps);
                solves++;
                if (!Xd) continue;
                ACC.dlt[k][N.dlt[k]++] =
                    Math.hypot(Xd[0] - gx, Xd[1] - gy, Xd[2] - gz) * MM;
                const Xb = tri.triangulatePointBA(rk, Ps, Xd, { cameras });
                solves++;
                if (Xb) {
                    ACC.ba[k][N.ba[k]++] =
                        Math.hypot(Xb[0] - gx, Xb[1] - gy, Xb[2] - gz) * MM;
                }
                // HELD-OUT REPROJECTION, the reference-free arm. Score in every camera
                // OUTSIDE the subset that carries a detection, in that camera's native
                // (still distorted) pixels -- `distortPoint` after `reprojectPoint`,
                // exactly as fig2_solvers_measure.mjs's `heldout_by_views` does. `raw`, not
                // `rk`: the held-out camera's detection is deliberately not one the
                // solve was given.
                if (k < C) {
                    for (let c = 0; c < C; c++) {
                        if (m[c] || !raw[c]) continue;
                        for (const [name, X_] of [['dlt', Xd], ['ba', Xb]]) {
                            if (!X_) continue;
                            const id = tri.reprojectPoint(X_, Ps[c]);
                            if (!id) continue;
                            const p = cameras[c].distortPoint(id);
                            const e = Math.hypot(p[0] - raw[c][0], p[1] - raw[c][1]);
                            if (Number.isFinite(e)) PX[name][k][NP[name][k]++] = e;
                        }
                    }
                }
            }
        }
    }
    const row = { session: b.session, block_index: bi,
                  calibration: b.calibration || 0,
                  n_keypoints: nkp, by_k: {}, heldout_px_by_k: {} };
    for (let k = 2; k <= C; k++) {
        row.by_k[k] = {};
        for (const m of METHODS) row.by_k[k][m] = stats(ACC[m][k], N[m][k]);
        if (k < C) {
            row.heldout_px_by_k[k] = {};
            for (const m of METHODS) row.heldout_px_by_k[k][m] = stats(PX[m][k], NP[m][k]);
        }
    }
    perSession.push(row);
    const el = (Date.now() - t0) / 1000;
    const h4 = row.heldout_px_by_k[C - 1];
    console.log(`[${String(bi + 1).padStart(2)}/${blocks.length}] ${b.session}  ` +
                `${nkp} kp  k=${C - 1} held-out dlt ${h4.dlt.p50.toFixed(2)} / ba ` +
                `${h4.ba.p50.toFixed(2)} px  ` +
                `[${el.toFixed(0)}s, ${(solves / 1e6).toFixed(1)}M solves]`);
}

const out = summarize(perSession, C, {
    stride_within_export: STRIDE,
    export_stride: data.stride,
    keypoints_used: perSession.reduce((a, r) => a + r.n_keypoints, 0),
    subsets_per_k: NSUB, poseDir: POSE_DIR, solves,
    blocks_measured: [BLO, BHI],
    plotted_arm: 'heldout_px_across_sessions',
    caveat: ('err3d_mm_* is 3D distance to the proofread reference and is DEPOSITED '
        + 'BUT NOT PLOTTED: fig2_solvers_move_geometry.mjs shows the refinement moves a '
        + 'median 1.249 mm at k=5 in a direction essentially uncorrelated with the '
        + 'direction to the reference (mean cos 0.066), and adding a displacement '
        + 'orthogonal to an existing error always increases the distance. So that '
        + 'axis reports "the refinement moved" whichever way it moved. It is valid '
        + 'for one solver against ITSELF across k, where the bias cancels; it is NOT '
        + 'a ranking. heldout_px_* is the reference-free arm and is what panel b '
        + 'draws.'),
});
const outPath = process.env.OUT_JSON || path.join(HERE, 'out', 'fig4_by_views.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));

console.log('\nPLOTTED ARM — across-session medians (px), held-out camera, ' +
            'reference-free:');
for (let k = 2; k < C; k++) {
    const d = out.heldout_px_across_sessions[k].dlt, b = out.heldout_px_across_sessions[k].ba;
    console.log(`  k=${k}  DLT ${d.p50.toFixed(3)}  refined ${b.p50.toFixed(3)}  ` +
                `(refined/DLT ${(b.p50 / d.p50).toFixed(3)}x, n_sessions ${d.n_sessions}, ` +
                `n ${d.n_values})`);
}
{
    const d2 = out.heldout_px_across_sessions[2].dlt.p50;
    const dm = out.heldout_px_across_sessions[C - 1].dlt.p50;
    const b2 = out.heldout_px_across_sessions[2].ba.p50;
    const bm = out.heldout_px_across_sessions[C - 1].ba.p50;
    console.log(`  span 2->${C - 1}: DLT ${(d2 / dm).toFixed(2)}x  ` +
                `refined ${(b2 / bm).toFixed(2)}x`);
    console.log(`  (k stops at ${C - 1}: at k=${C} no camera is left to hold out)`);
}
console.log('\ndeposited but NOT plotted — 3D vs proofread reference (mm):');
for (let k = 2; k <= C; k++) {
    const d = out.err3d_mm_across_sessions[k].dlt, b = out.err3d_mm_across_sessions[k].ba;
    console.log(`  k=${k}  DLT ${d.p50.toFixed(3)}  refined ${b.p50.toFixed(3)}  ` +
                `(refined/DLT ${(b.p50 / d.p50).toFixed(2)}x)`);
}
// CROSS-CHECKS. Each arm against the run that already measured it, because a drifted
// arm would mean this is not the same measurement and the panel would be overlaying
// curves that cannot be compared.
//  * px  -> fig4.json heldout_by_views (same protocol: raw detection in a held-out
//           camera). Its by_k is POOLED over keypoints while this is a median of
//           session medians, so expect closeness, not equality.
//  * mm  -> fig2.json err3d_mm_by_anchor_count (same protocol, different stride).
// fig2's PX arm is deliberately NOT used: it scores against the reprojected
// reference (`gtk`), not the raw detection, so it is a different quantity.
try {
    const f4 = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'fig4.json'), 'utf8'));
    console.log('\ncross-check px vs fig4.json heldout_by_views (pooled there, ' +
                'median-of-sessions here):');
    for (let k = 2; k < C; k++) {
        const v = f4.heldout_by_views.by_k[String(k)];
        if (!v) continue;
        for (const m of METHODS) {
            const a = v[m].p50, b = out.heldout_px_across_sessions[k][m].p50;
            console.log(`  k=${k} ${m.padEnd(3)}  fig4 ${a.toFixed(3)}  this run ` +
                        `${b.toFixed(3)}  (${(100 * Math.abs(a - b) / a).toFixed(1)}%)`);
        }
    }
} catch (e) {
    console.log(`\n(no fig4.json px cross-check: ${e.message})`);
}
try {
    const f2 = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'fig2.json'), 'utf8'));
    console.log('\ncross-check mm vs fig2.json (DLT arm; different stride):');
    for (let k = 2; k <= C; k++) {
        const g = f2.per_session.map(s => (s.err3d_mm_by_anchor_count || {})[String(k)])
                    .filter(Boolean).map(x => x.p50);
        const a = med(g), b = out.err3d_mm_across_sessions[k].dlt.p50;
        console.log(`  k=${k}  fig2 ${a.toFixed(3)}  this run ${b.toFixed(3)}  ` +
                    `(${(100 * Math.abs(a - b) / a).toFixed(1)}%)`);
    }
} catch (e) {
    console.log(`\n(no fig2.json cross-check: ${e.message})`);
}
console.log(`[json] ${outPath}`);
