#!/usr/bin/env node
/**
 * fig3_rescore_frames.mjs — for a handful of specific frames, rescore BOTH the
 * greedy tracker's partition and the exhaustive optimum partition with the
 * SAME whole-frame total-reprojection-error objective that fig3_exhaustive.mjs
 * minimizes. Used by figs/fig3_quality.py (task 3) to quantify the cost gap on
 * the frames where greedy and exhaustive disagree.
 *
 * Reuses the REAL, unmodified pose/triangulation.js (triangulateAndReproject)
 * and pose/pose-data.js (Camera/Instance/InstanceGroup) via the same loader
 * hooks as fig3_exhaustive.mjs — no reimplementation of the geometry, and no
 * modification of app source.
 *
 * The greedy partition is restricted to the keys the exhaustive frame used
 * (exactly the restriction agreement_rate() applies in fig3_headtohead.py),
 * so both partitions are scored over the identical detection pool.
 *
 * CLI:
 *   node fig3_rescore_frames.mjs --session-idx N --calibration calib.toml \
 *     --pred-h5-dir DIR --cameras back,backL,... \
 *     --greedy greedy.json --exhaustive exhaustive.json \
 *     --frames 2640,13328 --out out.json
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
    const o = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const take = () => argv[++i];
        if (a === '--session-idx') o.sessionIdx = parseInt(take());
        else if (a === '--calibration') o.calibration = take();
        else if (a === '--pred-h5-dir') o.predH5Dir = take();
        else if (a === '--cameras') o.cameras = take();
        else if (a === '--greedy') o.greedy = take();
        else if (a === '--exhaustive') o.exhaustive = take();
        else if (a === '--frames') o.frames = take();
        else if (a === '--out') o.out = take();
    }
    return o;
}

// --- calibration TOML parsing: identical to fig3_exhaustive.mjs ---
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

async function main() {
    const opts = parseArgs(process.argv);
    const cameras = opts.cameras.split(',').map(s => s.trim());
    const frameList = opts.frames.split(',').map(s => parseInt(s.trim()));

    globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
    globalThis.document = { getElementById: () => null };
    globalThis.window = globalThis;
    register(HOOKS_URL, import.meta.url);
    const { Camera, Instance, InstanceGroup } =
        await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
    const { triangulateAndReproject } =
        await import(pathToFileURL(path.join(POSE_DIR, 'triangulation.js')).href);
    await h5.ready;

    const allCams = parseCalibrationTOML(fs.readFileSync(opts.calibration, 'utf8'), Camera);
    const benchCams = cameras.map(name => {
        const c = allCams.find(cc => cc.name === name);
        if (!c) throw new Error(`Camera ${name} missing in calibration ${opts.calibration}`);
        return c;
    });

    const camSlices = {};
    for (const cam of cameras) {
        const f = new h5.File(path.join(opts.predH5Dir, `${cam}_predictions.h5`), 'r');
        camSlices[cam] = sliceCamSession(f, opts.sessionIdx);
        f.close();
    }

    const exhJson = JSON.parse(fs.readFileSync(opts.exhaustive, 'utf8'));
    const greedyJson = JSON.parse(fs.readFileSync(opts.greedy, 'utf8'));
    const exhByFrame = new Map(exhJson.frames.map(f => [f.frame, f]));
    const greedyByFrame = new Map(greedyJson.frames.map(f => [f.frame, f]));

    // Score a partition given as [["cam:slot", identity], ...], restricted to
    // keysFilter (a Set of "cam:slot" or null). Objective: sum of every non-null
    // per-node per-view reprojection error across all identity groups — EXACTLY
    // the quantity fig3_exhaustive.mjs minimizes as `totalError`.
    function scorePartition(fi, assignments, keysFilter) {
        const byIdent = new Map();
        let dupCamInGroup = false;
        for (const [key, ident] of assignments) {
            if (keysFilter && !keysFilter.has(key)) continue;
            if (!byIdent.has(ident)) byIdent.set(ident, []);
            byIdent.get(ident).push(key);
        }
        let totalError = 0;
        let nKeys = 0;
        let g = 0;
        for (const [, keys] of byIdent) {
            const group = new InstanceGroup(g, g);
            const seenCams = new Set();
            for (const key of keys) {
                const ci = key.lastIndexOf(':');
                const cam = key.substring(0, ci);
                const slot = parseInt(key.substring(ci + 1));
                const sl = camSlices[cam];
                if (!sl) throw new Error(`unknown camera in key ${key}`);
                const pts = instancePoints(sl.data, fi, slot, sl.nAnimals, sl.nNodes);
                if (pts == null) throw new Error(`null instance for key ${key} at frame ${fi}`);
                if (seenCams.has(cam)) dupCamInGroup = true;
                seenCams.add(cam);
                group.addInstance(cam, new Instance(pts, slot, 'predicted', 1.0));
                nKeys++;
            }
            const res = triangulateAndReproject(group, benchCams, {});
            for (const camName in res.errors) {
                const errs = res.errors[camName];
                for (let k = 0; k < errs.length; k++) {
                    if (errs[k] != null) totalError += errs[k];
                }
            }
            g++;
        }
        return { totalError, nKeys, nGroups: byIdent.size, dupCamInGroup };
    }

    const results = [];
    for (const fi of frameList) {
        const ef = exhByFrame.get(fi);
        const gf = greedyByFrame.get(fi);
        const rec = { frame: fi };
        if (!ef) {
            rec.status = 'failed';
            rec.why = `frame ${fi} not present in exhaustive.json`;
            results.push(rec);
            continue;
        }
        const exhKeys = new Set(ef.assignments.map(([k]) => k));
        try {
            const es = scorePartition(fi, ef.assignments, null);
            rec.exhaustive_error_stored = ef.totalError;
            rec.exhaustive_error_recomputed = es.totalError;
            rec.exhaustive_reproduced = Math.abs(es.totalError - ef.totalError) < 1e-6 * Math.max(1, Math.abs(ef.totalError));
            rec.exhaustive_keys = es.nKeys;
        } catch (e) {
            rec.exhaustive_error_recomputed = null;
            rec.exhaustive_rescore_failed_why = String(e && e.message || e);
        }
        if (!gf) {
            rec.greedy_error = null;
            rec.greedy_rescore_failed_why = `frame ${fi} not present in greedy.json`;
        } else {
            try {
                const gs = scorePartition(fi, gf.assignments, exhKeys);
                rec.greedy_error = gs.totalError;
                rec.greedy_keys = gs.nKeys;
                rec.greedy_groups = gs.nGroups;
                rec.greedy_covers_all_exh_keys = gs.nKeys === exhKeys.size;
                if (gs.dupCamInGroup) rec.greedy_dup_cam_in_group = true;
            } catch (e) {
                rec.greedy_error = null;
                rec.greedy_rescore_failed_why = String(e && e.message || e);
            }
        }
        results.push(rec);
    }

    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify({ sessionIdx: opts.sessionIdx, cameras, frames: results }, null, 2));
    process.stderr.write(`[fig3_rescore_frames] wrote ${opts.out} (${results.length} frames)\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
