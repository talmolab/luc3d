#!/usr/bin/env node
/**
 * bench_crossview.mjs — headless driver for the CrossViewTracker (the app's
 * tracker), for one session. Loads the REAL pose/tracker.js +
 * pose/cross-view-tracker.js + pose/triangulation.js + pose/pose-data.js (UI
 * stubbed via hooks.mjs) and drives runCrossViewTracker() exactly as trackAll()
 * does in the app — on RAW (non-proofread) predictions.
 *
 * Benchmark conditions (mirrors the user's request):
 *   - Input = RAW aggregated predictions H5 ({cam}_predictions.h5), NOT proofread.
 *   - Cameras = back,backL,mid,midL,top,topL  (side / sideL excluded).
 *   - maxTargets = --num-animals  (from the master sheet → tracker never spawns
 *     more identities than there are animals).
 *   - Tail nodes (TailTip, Tail_0, Tail_1, Tail_2) weighted 0 (dropped from the
 *     association cost) when --exclude-tail is set (default on).
 *
 * Output JSON matches luc3d-bench's luc3d_results format so evaluate.py can score
 * it verbatim: { sessionIdx, numAnimals, cameras, identities, frames:[{frame,
 * assignments:[["cam:slot", identity], ...]}], runtimeSeconds, framesProcessed, fps }.
 *
 * CLI:
 *   node bench_crossview.mjs --session-idx N --num-animals N \
 *     --calibration calib.toml --pred-h5-dir DIR --out out.json \
 *     [--cameras back,backL,mid,midL,top,topL] [--no-exclude-tail] [--max-frames N]
 */
import { register } from 'node:module';
import * as h5 from 'h5wasm/node';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSE_DIR = path.resolve(HERE, '..', '..', 'pose');

// SLAP skeleton node order (matches the aggregated H5 node axis + proofread GT).
const NODE_NAMES = [
    'Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk',
    'Tail_0', 'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right',
    'Haunch_left', 'Haunch_right', 'Neck',
];
const TAIL_NODES = NODE_NAMES.filter(n => /tail/i.test(n));   // TailTip, Tail_0, Tail_1, Tail_2

// --- tiny arg parser ---
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
        else if (a === '--no-cap') o.noCap = true;   // don't enforce maxTargets (uncapped births)
    }
    return o;
}

// --- minimal TOML calibration parser (ported from bench_driver.mjs) ---
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

    // Inject node weights (tail → 0) via the settings stub BEFORE importing the
    // tracker (its module-level button-wiring IIFE touches document).
    const nodeWeights = {};
    if (opts.excludeTail) for (const n of TAIL_NODES) nodeWeights[n] = 0;
    globalThis.__BENCH = { nodeWeights, thresholds: {} };
    globalThis.document = { getElementById: () => null };
    globalThis.window = globalThis;

    register('./hooks.mjs', import.meta.url);
    const { Camera, Instance, FrameGroup, Session } =
        await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
    const { runCrossViewTracker } = await import(pathToFileURL(path.join(POSE_DIR, 'tracker.js')).href);
    await h5.ready;

    // 1. Calibration → ordered bench Camera list (only the requested cameras).
    const allCams = parseCalibrationTOML(fs.readFileSync(opts.calibration, 'utf8'), Camera);
    const benchCams = cameras.map(name => {
        const c = allCams.find(cc => cc.name === name);
        if (!c) throw new Error(`Camera ${name} missing in calibration ${opts.calibration}`);
        return c;
    });

    // 2. Slice each cam's raw predictions for this session.
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

    // 3. Frames with any detection in any camera.
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

    // 4. Build Session + FrameGroups (skeleton carries node-name order so the
    //    tracker resolves tail-node weights by name).
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

    // maxTargets = num_animals unless --no-cap (uncapped births, like the
    // reference / old behavior — lets us A/B the cap's effect on recall).
    const maxTargets = opts.noCap ? undefined : opts.numAnimals;
    process.stderr.write(
        `[crossview] session-idx=${opts.sessionIdx} frames=${usedFrames.length} dets=${totalDets} ` +
        `numAnimals=${opts.numAnimals} maxTargets=${opts.noCap ? 'uncapped' : maxTargets} ` +
        `cams=${cameras.join(',')} tailExcluded=${opts.excludeTail}\n`);

    // 5. Drive the CrossViewTracker over every frame (propagate=false keeps each
    //    instance's trackIdx = its raw detection slot, which the scorer needs).
    const t0 = Date.now();
    runCrossViewTracker(session, benchCams, session.frameIndices, false, maxTargets);
    const runtimeSeconds = (Date.now() - t0) / 1000;

    // 6. Extract per-frame assignments from the committed InstanceGroups:
    //    ["cam:slot", identityId] for every grouped detection.
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
        identities,
        frames,
        framesProcessed: usedFrames.length,
        detections: totalDets,
        runtimeSeconds,
        fps,
    }));
    process.stderr.write(
        `[crossview] wrote ${frames.length} frames w/ assignments, ${identities.length} identities, ` +
        `${runtimeSeconds.toFixed(2)}s, ${fps.toFixed(1)} fps → ${opts.out}\n`);
    // Machine-readable timing line for the orchestrator to capture from stdout.
    process.stdout.write(JSON.stringify({
        sessionIdx: opts.sessionIdx, framesProcessed: usedFrames.length,
        detections: totalDets, runtimeSeconds, fps, numIdentities: identities.length,
    }) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
