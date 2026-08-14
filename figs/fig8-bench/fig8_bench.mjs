#!/usr/bin/env node
/**
 * fig8_bench.mjs — Fig 8 METHOD-SEARCH driver. A fork of figs/fig3-bench/fig3_bench.mjs
 * (itself a fork of scripts/bench/bench_crossview.mjs) that differs in exactly two ways:
 *
 *   1. It registers `figs/fig8-bench/hooks8.mjs` instead of `scripts/bench/hooks.mjs`.
 *      That hook is the base hook PLUS one redirect: `pose/cross-view-tracker.js` is
 *      served from `figs/fig8-bench/xv_experimental.js`. pose/tracker.js,
 *      pose/triangulation.js, pose/pose-data.js and the shipped
 *      pose/cross-view-tracker.js file itself are all untouched on disk.
 *   2. `--params` gains a `method` block, forwarded on `globalThis.__BENCH.method`,
 *      which is how each candidate method configuration is injected. `thresholds`
 *      and `nodeWeights` behave exactly as in fig3_bench.mjs, so a Fig 8 method run
 *      and a Fig 3e / Fig 8 threshold cell are the same measurement apart from the
 *      method block.
 *
 * Output JSON keeps fig3_bench.mjs's key ORDER, because fig8_param_sweeps.py's
 * `payload_digest()` hashes the raw byte slice from `"identities":` to
 * `,"framesProcessed"`. Anything new (`methodStats`) is appended AFTER that slice so
 * digests stay comparable across the two drivers — which is what lets
 * `fig8_methods.py --verify` prove the experimental tracker reproduces the shipped
 * one bit for bit when no method flag is set.
 *
 * CLI (identical to fig3_bench.mjs):
 *   node fig8_bench.mjs --session-idx N --num-animals N \
 *     --calibration calib.toml --pred-h5-dir DIR --out out.json \
 *     [--cameras back,backL,mid,midL,top,topL] [--no-exclude-tail] [--max-frames N] \
 *     [--params overrides.json]
 *
 * --params JSON may contain: { "thresholds": {"corr2dWeight":1,"corr3dWeight":6,...},
 *                              "nodeWeights": {"<node>": 0..1, ...},
 *                              "method": {"bundle":true,"reid":4,...} }
 */
import { register } from 'node:module';
import * as h5 from 'h5wasm/node';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSE_DIR = path.resolve(HERE, '..', '..', 'pose');
const HOOKS_URL = pathToFileURL(path.resolve(HERE, 'hooks8.mjs')).href;

const NODE_NAMES = [
    'Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk',
    'Tail_0', 'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right',
    'Haunch_left', 'Haunch_right', 'Neck',
];
const TAIL_NODES = NODE_NAMES.filter(n => /tail/i.test(n));

function parseArgs(argv) {
    const o = { cameras: 'back,backL,mid,midL,top,topL', excludeTail: true };
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
        else if (a === '--no-exclude-tail') o.excludeTail = false;
        else if (a === '--no-cap') o.noCap = true;
        else if (a === '--params') o.params = take();
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

async function main() {
    const opts = parseArgs(process.argv);
    const cameras = opts.cameras.split(',').map(s => s.trim());

    let params = {};
    if (opts.params) params = JSON.parse(fs.readFileSync(opts.params, 'utf8'));

    const nodeWeights = Object.assign({}, params.nodeWeights || {});
    if (opts.excludeTail) for (const n of TAIL_NODES) if (!(n in nodeWeights)) nodeWeights[n] = 0;
    globalThis.__BENCH = {
        nodeWeights,
        thresholds: params.thresholds || {},
        // Fig 8 method search. Empty ⇒ xv_experimental.js takes the shipped path.
        method: params.method || {},
        nodeNames: NODE_NAMES,
    };
    globalThis.document = { getElementById: () => null };
    globalThis.window = globalThis;

    register(HOOKS_URL, import.meta.url);
    const { Camera, Instance, FrameGroup, Session } =
        await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
    const { runCrossViewTracker } = await import(pathToFileURL(path.join(POSE_DIR, 'tracker.js')).href);
    await h5.ready;

    const allCams = parseCalibrationTOML(fs.readFileSync(opts.calibration, 'utf8'), Camera);
    const benchCams = cameras.map(name => {
        const c = allCams.find(cc => cc.name === name);
        if (!c) throw new Error(`Camera ${name} missing in calibration ${opts.calibration}`);
        return c;
    });

    const camSlices = {};
    let minFrames = Infinity, nNodes = 0;
    for (const cam of cameras) {
        const f = new h5.File(path.join(opts.predH5Dir, `${cam}_predictions.h5`), 'r');
        const sl = sliceCamSession(f, opts.sessionIdx);
        camSlices[cam] = sl;
        f.close();
        minFrames = Math.min(minFrames, sl.nFrames);
        nNodes = Math.max(nNodes, sl.nNodes);
    }
    let frameLimit = minFrames;
    if (opts.maxFrames) frameLimit = Math.min(frameLimit, opts.maxFrames);

    const usedFrames = [];
    for (let fi = 0; fi < frameLimit; fi++) {
        let any = false;
        for (const cam of cameras) {
            const sl = camSlices[cam];
            for (let a = 0; a < sl.nAnimals && !any; a++) {
                if (instancePoints(sl.data, fi, a, sl.nAnimals, sl.nNodes)) any = true;
            }
            if (any) break;
        }
        if (any) usedFrames.push(fi);
    }

    const tracks = Array.from({ length: opts.numAnimals }, (_, i) => 'track_' + i);
    const session = new Session(benchCams, { nodes: NODE_NAMES }, tracks, 'bench');
    let totalDets = 0;
    for (const fi of usedFrames) {
        const fg = new FrameGroup(fi);
        for (const cam of cameras) {
            const sl = camSlices[cam];
            for (let a = 0; a < sl.nAnimals; a++) {
                const pts = instancePoints(sl.data, fi, a, sl.nAnimals, sl.nNodes);
                if (!pts) continue;
                fg.addInstance(cam, new Instance(pts, a, 'predicted', 1.0));
                totalDets++;
            }
        }
        session.addFrameGroup(fg);
    }

    const maxTargets = opts.noCap ? undefined : opts.numAnimals;
    process.stderr.write(
        `[fig8_bench] session-idx=${opts.sessionIdx} frames=${usedFrames.length} dets=${totalDets} ` +
        `numAnimals=${opts.numAnimals} maxTargets=${opts.noCap ? 'uncapped' : maxTargets} ` +
        `cams=${cameras.join(',')} tailExcluded=${opts.excludeTail} thresholds=${JSON.stringify(globalThis.__BENCH.thresholds)} ` +
        `method=${JSON.stringify(globalThis.__BENCH.method)}\n`);

    const t0 = Date.now();
    runCrossViewTracker(session, benchCams, session.frameIndices, false, maxTargets);
    const runtimeSeconds = (Date.now() - t0) / 1000;

    const frames = [];
    for (const fi of session.frameIndices) {
        const groups = session.instanceGroups.get(fi) || [];
        const assignments = [];
        for (const g of groups) {
            if (g.identityId == null) continue;
            g.instances.forEach((inst, camName) => {
                assignments.push([`${camName}:${inst.trackIdx}`, g.identityId]);
            });
        }
        if (assignments.length) frames.push({ frame: fi, assignments });
    }

    const identities = (session.identities || []).map(id => ({ id: id.id, name: id.name }));
    const fps = usedFrames.length / Math.max(1e-9, runtimeSeconds);
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify({
        sessionIdx: opts.sessionIdx,
        numAnimals: opts.numAnimals,
        cameras,
        excludeTail: opts.excludeTail,
        capped: !opts.noCap,
        params,
        identities,
        frames,
        framesProcessed: usedFrames.length,
        detections: totalDets,
        runtimeSeconds,
        fps,
        // AFTER framesProcessed on purpose: payload_digest() slices
        // "identities" .. ",framesProcessed", so these must not land inside it.
        method: globalThis.__BENCH.method,
        methodStats: (globalThis.__BENCH_LAST_TRACKER || {}).stats || null,
    }));
    process.stderr.write(
        `[fig8_bench] wrote ${frames.length} frames w/ assignments, ${identities.length} identities, ` +
        `${runtimeSeconds.toFixed(2)}s, ${fps.toFixed(1)} fps → ${opts.out}\n`);
    process.stdout.write(JSON.stringify({
        sessionIdx: opts.sessionIdx, framesProcessed: usedFrames.length,
        detections: totalDets, runtimeSeconds, fps, numIdentities: identities.length,
    }) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
