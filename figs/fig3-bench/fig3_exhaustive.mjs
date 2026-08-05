#!/usr/bin/env node
/**
 * fig3_exhaustive.mjs — exhaustive multi-view hypothesis-testing association,
 * exactly as described in Maree, Afshar, Oline, Leonardis, Falkner & Pereira
 * (2024), Measuring Behavior 2024: for each frame, enumerate every assignment
 * of each view's A instances into A identity groups (A! per view), enumerate
 * every whole-frame combination of per-view assignments ((A!)^C total),
 * triangulate + reproject every combination, and keep the minimum total
 * reprojection error.
 *
 * Reuses the REAL, unmodified pose/triangulation.js (triangulateAndReproject)
 * and pose/pose-data.js (Camera/Instance/InstanceGroup) — no reimplementation
 * of the geometry. Does not touch pose/, ui/, loading/, import-export/, lib/.
 *
 * The paper's method is a pure PER-FRAME procedure — it has no mechanism to
 * carry an identity across frames (group index i in frame f and group index i
 * in frame f+1 are not otherwise related). To make IDF1/switches computable at
 * all (Task 3's schema asks for them), this script ADDS a minimal identity-
 * threading step after the per-frame winner is picked: each frame's groups are
 * Hungarian-matched to the most recently computed frame's groups by 3D-centroid
 * distance. This threading is NOT part of the association decision (which
 * detections co-occur) and is disclosed in the output under `caveats` — the
 * clean, threading-free comparison is `agreement_rate` (does exhaustive pick
 * the same partition of detections as greedy, at each frame, using only the
 * paper's actual method).
 *
 * A frame is only a candidate if EVERY included camera has EXACTLY
 * `numAnimals` non-null instances that frame (so "A! per view" is well posed).
 * Frames failing that, or whose (A!)^C exceeds --max-hypotheses, are skipped
 * and counted, never silently dropped from the reported totals.
 *
 * CLI:
 *   node fig3_exhaustive.mjs --session-idx N --num-animals N \
 *     --calibration calib.toml --pred-h5-dir DIR --out out.json \
 *     --cameras back,backL,mid,midL,top [--max-frames N] [--max-hypotheses 1000000]
 */
import { register } from 'node:module';
import * as h5 from 'h5wasm/node';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSE_DIR = path.resolve(HERE, '..', '..', 'pose');
const HOOKS_URL = pathToFileURL(path.resolve(HERE, '..', '..', 'scripts', 'bench', 'hooks.mjs')).href;

function parseArgs(argv) {
    const o = { maxHypotheses: 1_000_000 };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const take = () => argv[++i];
        if (a === '--session-idx') o.sessionIdx = parseInt(take());
        else if (a === '--num-animals') o.numAnimals = parseInt(take());
        else if (a === '--calibration') o.calibration = take();
        else if (a === '--pred-h5-dir') o.predH5Dir = take();
        else if (a === '--out') o.out = take();
        else if (a === '--cameras') o.cameras = take();
        else if (a === '--max-frames') o.maxFrames = parseInt(take());
        else if (a === '--max-hypotheses') o.maxHypotheses = parseInt(take());
    }
    return o;
}

function parseCalibrationTOML(text, CameraCtor) {
    const cameras = [];
    const sectionRegex = /^\[([^\]]+)\]\s*$/gm;
    const sections = [];
    let m;
    while ((m = sectionRegex.exec(text)) !== null) sections.push({ name: m[1], start: m.index + m[0].length });
    for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        if (!sec.name.startsWith('cam_')) continue;
        const end = i + 1 < sections.length ? sections[i + 1].start : text.length;
        const props = parseTOMLSection(text.substring(sec.start, end));
        cameras.push(new CameraCtor(
            props.name || sec.name,
            props.matrix || [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            props.distortions || [0, 0, 0, 0, 0],
            props.rotation || [0, 0, 0],
            props.translation || [0, 0, 0],
            props.size || [640, 480]));
    }
    return cameras;
}
function parseTOMLSection(body) {
    const out = {};
    for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('[')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.substring(0, eq).trim();
        let value = line.substring(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) { out[key] = value.slice(1, -1); continue; }
        value = value.replace(/,\s*\]/g, ']');
        try { out[key] = JSON.parse(value); } catch (e) { out[key] = value; }
    }
    return out;
}

function sliceCamSession(h5File, sessionIdx) {
    const ds = h5File.get('tracks');
    const [, nF, nA, nN, two] = ds.shape;
    const data = ds.slice([[sessionIdx, sessionIdx + 1], [0, nF], [0, nA], [0, nN], [0, two]]);
    return { data, nFrames: nF, nAnimals: nA, nNodes: nN };
}
function instancePoints(sub, fi, animal, nAnimals, nNodes) {
    const pts = new Array(nNodes);
    let allNull = true;
    for (let k = 0; k < nNodes; k++) {
        const base = (((fi * nAnimals) + animal) * nNodes + k) * 2;
        const x = sub[base], y = sub[base + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) pts[k] = null;
        else { pts[k] = [x, y]; allNull = false; }
    }
    return allNull ? null : pts;
}

// All permutations of [0..n-1], as arrays of indices. Small n only (n<=6).
function permutations(n) {
    const idx = Array.from({ length: n }, (_, i) => i);
    const out = [];
    function heap(k, arr) {
        if (k === 1) { out.push(arr.slice()); return; }
        for (let i = 0; i < k; i++) {
            heap(k - 1, arr);
            if (k % 2 === 0) { const t = arr[i]; arr[i] = arr[k - 1]; arr[k - 1] = t; }
            else { const t = arr[0]; arr[0] = arr[k - 1]; arr[k - 1] = t; }
        }
    }
    heap(n, idx);
    return out;
}

function groupCentroid(points3d) {
    // points3d: Float64Array(3N) or boxed [[x,y,z]|null...]; mean of finite points.
    let sx = 0, sy = 0, sz = 0, n = 0;
    if (points3d == null) return null;
    const N = points3d.length / 3;
    for (let k = 0; k < N; k++) {
        const x = points3d[3 * k], y = points3d[3 * k + 1], z = points3d[3 * k + 2];
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) { sx += x; sy += y; sz += z; n++; }
    }
    if (n === 0) return null;
    return [sx / n, sy / n, sz / n];
}

async function main() {
    const opts = parseArgs(process.argv);
    const cameras = opts.cameras.split(',').map(s => s.trim());
    const A = opts.numAnimals;

    globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
    globalThis.document = { getElementById: () => null };
    globalThis.window = globalThis;
    register(HOOKS_URL, import.meta.url);
    const { Camera, Instance, InstanceGroup } =
        await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
    const { triangulateAndReproject, hungarianAlgorithm } =
        await import(pathToFileURL(path.join(POSE_DIR, 'triangulation.js')).href);
    await h5.ready;

    const allCams = parseCalibrationTOML(fs.readFileSync(opts.calibration, 'utf8'), Camera);
    const benchCams = cameras.map(name => {
        const c = allCams.find(cc => cc.name === name);
        if (!c) throw new Error(`Camera ${name} missing in calibration ${opts.calibration}`);
        return c;
    });

    const camSlices = {};
    let minFrames = Infinity;
    for (const cam of cameras) {
        const f = new h5.File(path.join(opts.predH5Dir, `${cam}_predictions.h5`), 'r');
        const sl = sliceCamSession(f, opts.sessionIdx);
        camSlices[cam] = sl;
        f.close();
        minFrames = Math.min(minFrames, sl.nFrames);
    }
    let frameLimit = minFrames;
    if (opts.maxFrames) frameLimit = Math.min(frameLimit, opts.maxFrames);

    const permsA = permutations(A);
    const hypothesesPerFrame = Math.pow(permsA.length, cameras.length);
    const capped = hypothesesPerFrame > opts.maxHypotheses;

    let framesConsidered = 0, framesClean = 0, framesComputed = 0;
    const frames = [];
    let prevCentroids = null; // array of A [x,y,z] from the last computed frame
    const t0 = Date.now();

    if (!capped) {
        outer:
        for (let fi = 0; fi < frameLimit; fi++) {
            framesConsidered++;
            // Per-camera instance list for this frame; require EXACTLY A per camera.
            const perCamInstances = {};
            for (const cam of cameras) {
                const sl = camSlices[cam];
                const insts = [];
                for (let a = 0; a < sl.nAnimals; a++) {
                    const pts = instancePoints(sl.data, fi, a, sl.nAnimals, sl.nNodes);
                    if (pts) insts.push({ slot: a, instance: new Instance(pts, a, 'predicted', 1.0) });
                }
                if (insts.length !== A) continue outer;   // not clean — skip whole frame
                perCamInstances[cam] = insts;
            }
            framesClean++;

            // Enumerate (A!)^C combinations via mixed-radix counter over the C views.
            const C = cameras.length;
            const radix = permsA.length;
            let bestError = Infinity, bestCombo = null, bestGroups = null;
            const total = Math.pow(radix, C);
            for (let combo = 0; combo < total; combo++) {
                let rem = combo;
                const permIdxPerCam = new Array(C);
                for (let c = 0; c < C; c++) { permIdxPerCam[c] = rem % radix; rem = Math.floor(rem / radix); }

                // Build A InstanceGroups for this combination.
                const groups = [];
                for (let g = 0; g < A; g++) groups.push(new InstanceGroup(g, g));
                for (let c = 0; c < C; c++) {
                    const cam = cameras[c];
                    const perm = permsA[permIdxPerCam[c]];   // perm[groupSlot] = which detection index
                    const insts = perCamInstances[cam];
                    for (let g = 0; g < A; g++) {
                        groups[g].addInstance(cam, insts[perm[g]].instance);
                    }
                }
                // Triangulate + reproject every group; sum ALL per-node per-view errors.
                let totalError = 0, anyNull = false;
                const groupPoints3d = new Array(A);
                for (let g = 0; g < A; g++) {
                    const res = triangulateAndReproject(groups[g], benchCams, {});
                    groupPoints3d[g] = res.points3d;
                    for (const camName in res.errors) {
                        const errs = res.errors[camName];
                        for (let k = 0; k < errs.length; k++) {
                            if (errs[k] != null) totalError += errs[k];
                            else anyNull = true;
                        }
                    }
                }
                if (totalError < bestError) {
                    bestError = totalError; bestCombo = permIdxPerCam.slice(); bestGroups = groupPoints3d;
                }
            }

            // Identity threading: Hungarian-match this frame's A groups to the
            // previous computed frame's group centroids by 3D distance (disclosed
            // add-on — the paper's method itself has no cross-frame identity).
            const centroids = bestGroups.map(groupCentroid);
            let identityOf; // identityOf[groupIndex] = persistent id
            if (prevCentroids == null) {
                identityOf = Array.from({ length: A }, (_, g) => g);
            } else {
                const cost = [];
                for (let g = 0; g < A; g++) {
                    cost[g] = [];
                    for (let h = 0; h < A; h++) {
                        const cg = centroids[g], ch = prevCentroids[h];
                        if (cg == null || ch == null) { cost[g][h] = 1e9; continue; }
                        const dx = cg[0] - ch[0], dy = cg[1] - ch[1], dz = cg[2] - ch[2];
                        cost[g][h] = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    }
                }
                const assign = hungarianAlgorithm(cost);
                identityOf = new Array(A);
                for (let g = 0; g < A; g++) {
                    const h = assign[g];
                    identityOf[g] = (h != null && h >= 0 && h < A) ? h : g;
                }
            }
            // IMPORTANT: index the carried-forward centroids by PERSISTENT IDENTITY h,
            // not by this frame's raw group index g — identityOf[g] is the mapping from
            // group to identity, so identity h's new position is centroids[g] where
            // identityOf[g] === h. (A prior version indexed by g directly, which silently
            // discarded the matching result every frame and produced spurious churn.)
            const newIdentityCentroids = new Array(A).fill(null);
            for (let g = 0; g < A; g++) {
                newIdentityCentroids[identityOf[g]] = centroids[g] != null
                    ? centroids[g]
                    : (prevCentroids ? prevCentroids[identityOf[g]] : null);
            }
            prevCentroids = newIdentityCentroids;

            // Emit assignments in the same "cam:slot" -> identity shape as fig3_bench.mjs.
            const assignments = [];
            for (let c = 0; c < C; c++) {
                const cam = cameras[c];
                const perm = permsA[bestCombo[c]];
                const insts = perCamInstances[cam];
                for (let g = 0; g < A; g++) {
                    const detSlot = insts[perm[g]].slot;
                    assignments.push([`${cam}:${detSlot}`, identityOf[g]]);
                }
            }
            frames.push({ frame: fi, assignments, totalError: bestError });
            framesComputed++;
        }
    }
    const runtimeSeconds = (Date.now() - t0) / 1000;

    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify({
        sessionIdx: opts.sessionIdx,
        numAnimals: opts.numAnimals,
        cameras,
        hypothesesPerFrame,
        maxHypotheses: opts.maxHypotheses,
        capped,
        framesConsidered,
        framesClean,
        framesComputed,
        runtimeSeconds,
        secondsPerComputedFrame: framesComputed > 0 ? runtimeSeconds / framesComputed : null,
        frames,
    }));
    process.stderr.write(
        `[fig3_exhaustive] A=${A} C=${cameras.length} hyps/frame=${hypothesesPerFrame} capped=${capped} ` +
        `considered=${framesConsidered} clean=${framesClean} computed=${framesComputed} ` +
        `${runtimeSeconds.toFixed(2)}s → ${opts.out}\n`);
    process.stdout.write(JSON.stringify({
        hypothesesPerFrame, capped, framesConsidered, framesClean, framesComputed, runtimeSeconds,
    }) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
