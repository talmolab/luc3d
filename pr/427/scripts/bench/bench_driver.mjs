#!/usr/bin/env node
/**
 * Headless benchmark driver for the luc3d cross-view tracker.
 *
 * Loads the REAL, unmodified pose/tracker.js + pose/triangulation.js +
 * pose/pose-data.js (UI/DOM modules are stubbed via hooks.mjs), feeds them
 * per-frame instances sliced from an aggregated camera H5, and drives
 * matchFrameInstances() exactly like trackAll() does in the app. Writes the
 * per-frame identity assignments to JSON in the format the lucid_lite bench
 * converter (_luc3d_web.convert_to_h5) consumes.
 *
 * CLI (mirrors the driver contract in lucid_lite/benchmark/scripts/_luc3d_web.py):
 *   node bench_driver.mjs \
 *     --session-idx <n> --num-animals <n> \
 *     --calibration <calibration.toml> --pred-h5-dir <dir/{cam}_predictions.h5> \
 *     --out <output.json> --cameras back,backL,mid,midL,top,topL \
 *     [--tracker <variant>] [--max-frames <n>] [--params <overrides.json>]
 *
 * --params JSON may contain:
 *   { "nodeWeights": { "<node>": <0..1>, ... },
 *     "thresholds":  { "<id>": <value>, ... },
 *     "nodeNames":   [ "<node>", ... ] }   // skeleton node order (15 for SLAP)
 */
import { register } from 'node:module';
import { Command } from 'commander';
import * as h5 from 'h5wasm/node';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSE_DIR = path.resolve(HERE, '..', '..', 'pose');

// Default SLAP skeleton node order (matches the proofread GT node_names).
const DEFAULT_NODE_NAMES = [
    'Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk',
    'Tail_0', 'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right',
    'Haunch_left', 'Haunch_right', 'Neck',
];

// ---------------------------------------------------------------------------
// Minimal TOML calibration parser (ported from ui/file-io.js, no DOM).
// ---------------------------------------------------------------------------
function parseCalibrationTOML(text, CameraCtor) {
    const cameras = [];
    const sectionRegex = /^\[([^\]]+)\]\s*$/gm;
    const sections = [];
    let m;
    while ((m = sectionRegex.exec(text)) !== null) {
        sections.push({ name: m[1], start: m.index + m[0].length });
    }
    for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        if (!sec.name.startsWith('cam_')) continue;
        const end = i + 1 < sections.length ? sections[i + 1].start : text.length;
        const body = text.substring(sec.start, end);
        const props = parseTOMLSection(body);
        const name = props.name || sec.name;
        const size = props.size || [640, 480];
        const matrix = props.matrix || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        const dist = props.distortions || [0, 0, 0, 0, 0];
        const rvec = props.rotation || [0, 0, 0];
        const tvec = props.translation || [0, 0, 0];
        cameras.push(new CameraCtor(name, matrix, dist, rvec, tvec, size));
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

// ---------------------------------------------------------------------------
// Aggregated H5: tracks shape (n_sessions, n_frames, n_animals, n_nodes, 2).
// ---------------------------------------------------------------------------
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
        if (!Number.isFinite(x) || !Number.isFinite(y)) { pts[k] = null; }
        else { pts[k] = [x, y]; allNull = false; }
    }
    return allNull ? null : pts;
}

async function main() {
    const program = new Command();
    program
        .requiredOption('--session-idx <n>', 'session index in aggregated H5', v => parseInt(v))
        .requiredOption('--num-animals <n>', 'expected number of animals', v => parseInt(v))
        .requiredOption('--calibration <path>', 'calibration.toml path')
        .requiredOption('--pred-h5-dir <path>', 'dir with {cam}_predictions.h5')
        .requiredOption('--out <path>', 'output JSON path')
        .option('--cameras <list>', 'comma-separated camera names', 'back,backL,mid,midL,top,topL')
        .option('--tracker <name>', 'tracker variant (informational; one tracker here)')
        .option('--max-frames <n>', 'cap frames processed', v => parseInt(v))
        .option('--params <path>', 'JSON with nodeWeights / thresholds / nodeNames');
    program.parse();
    const opts = program.opts();
    const cameras = opts.cameras.split(',').map(s => s.trim());

    let params = {};
    if (opts.params) params = JSON.parse(fs.readFileSync(opts.params, 'utf8'));
    const nodeNames = Array.isArray(params.nodeNames) && params.nodeNames.length
        ? params.nodeNames : DEFAULT_NODE_NAMES;

    // Expose params to the stubbed settings module + provide DOM stubs BEFORE
    // importing the tracker (its module-level button-wiring IIFE touches document).
    globalThis.__BENCH = {
        nodeWeights: params.nodeWeights || {},
        thresholds: params.thresholds || {},
    };
    globalThis.document = { getElementById: () => null };
    globalThis.window = globalThis;

    // Register the UI-stubbing loader, then load the real tracker modules.
    register('./hooks.mjs', import.meta.url);
    const poseData = await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
    const tracker = await import(pathToFileURL(path.join(POSE_DIR, 'tracker.js')).href);
    const { Camera, Instance, FrameGroup, Session } = poseData;
    const { matchFrameInstances } = tracker;

    await h5.ready;

    // 1. Calibration → ordered bench Camera list.
    const tomlText = fs.readFileSync(opts.calibration, 'utf8');
    const allCams = parseCalibrationTOML(tomlText, Camera);
    const benchCams = cameras.map(name => {
        const c = allCams.find(cc => cc.name === name);
        if (!c) throw new Error(`Camera ${name} missing in calibration`);
        return c;
    });

    // 2. Slice each cam's session.
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

    // 3. Frames with any detection in any cam.
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
    process.stderr.write(
        `[bench_driver] session=${opts.sessionIdx} frames-with-data=${usedFrames.length}/${frameLimit} ` +
        `numAnimals=${opts.numAnimals} nodeWeights=${JSON.stringify(globalThis.__BENCH.nodeWeights)} ` +
        `thresholds=${JSON.stringify(globalThis.__BENCH.thresholds)}\n`);

    // 4. Build Session + FrameGroups (skeleton carries node-name order).
    const tracks = Array.from({ length: opts.numAnimals }, (_, i) => 'track_' + i);
    const session = new Session(benchCams, { nodes: nodeNames }, tracks, 'bench');
    for (const fi of usedFrames) {
        const fg = new FrameGroup(fi);
        for (const cam of cameras) {
            const sl = camSlices[cam];
            for (let a = 0; a < sl.nAnimals; a++) {
                const pts = instancePoints(sl.data, fi, a, sl.nAnimals, sl.nNodes);
                if (!pts) continue;
                fg.addInstance(cam, new Instance(pts, a, 'predicted', 1.0));
            }
        }
        session.addFrameGroup(fg);
    }

    // 5. Drive matchFrameInstances per frame (mirrors trackAll()).
    const t0 = Date.now();
    let prevAssignments = null, prevTargets3d = null;
    const frames = [];
    for (const fi of session.frameIndices) {
        const fg = session.getFrameGroup(fi);
        let r;
        try {
            r = matchFrameInstances(fg, session.cameras, session, {
                numAnimals: opts.numAnimals,
                perFrame: true,
                prevAssignments,
                prevTargets3d,
            });
        } catch (e) {
            process.stderr.write(`[bench_driver] frame ${fi} error: ${e.message}\n`);
            continue;
        }
        const assignments = [];
        if (r && r.assignments) {
            for (const [key, id] of r.assignments) assignments.push([key, id]);
        }
        const targets3d = (r && r.targets3d) ? r.targets3d.map(t => ({
            identityId: t.identityId != null ? t.identityId : null,
            points3d: t.points3d || null,
        })) : [];
        frames.push({ frame: fi, assignments, targets3d });
        if (r && r.assignments && r.assignments.size > 0) prevAssignments = r.assignments;
        if (r && r.targets3d && r.targets3d.length > 0) prevTargets3d = r.targets3d;
    }
    const runtimeSeconds = (Date.now() - t0) / 1000;

    const identities = (session.identities || []).map(id => ({ id: id.id, name: id.name }));
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, JSON.stringify({
        sessionIdx: opts.sessionIdx,
        numAnimals: opts.numAnimals,
        cameras,
        identities,
        frames,
        runtimeSeconds,
    }));
    process.stderr.write(
        `[bench_driver] wrote ${frames.length} frames, ${identities.length} identities, ` +
        `${runtimeSeconds.toFixed(1)}s → ${opts.out}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
