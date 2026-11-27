/**
 * speed_test.mjs — head-to-head timing of the legacy LUC3D tracker (matchFrameInstances)
 * vs the CrossViewTracker (runCrossViewTracker) on REAL benchmark
 * detections from luc3d-bench (the sleep-nn FILTER+TRACK pool). Loads one real
 * multi-animal session once, then times both engines on the identical frames.
 *
 * Usage: node speed_test.mjs [sessionIdx] [maxFrames]
 */
import { register } from 'node:module';
import * as h5 from 'h5wasm/node';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSE_DIR = path.resolve(HERE, '..', '..', 'pose');
const BENCH = '/root/vast/eric/luc3d-bench';
const POOL = path.join(BENCH, 'outputs', 'keeptrack_h5s');
const CALIB = '/root/talmolab-smb/eric/slap_2m/2022-10-07/10072022131531/calibration.toml';
const CAM_NAMES = ['back', 'backL', 'mid', 'midL', 'top', 'topL'];
const NODE_NAMES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk',
    'Tail_0', 'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
const SESSION_IDX = parseInt(process.argv[2] || '6');
const MAX_FRAMES = parseInt(process.argv[3] || '4000');
const NUM_ANIMALS = 2;

// --- calibration TOML → Camera[] (ported from bench_driver.mjs) ---
function parseTOMLSection(body) {
    const out = {};
    for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('[')) continue;
        const eq = line.indexOf('='); if (eq === -1) continue;
        const key = line.substring(0, eq).trim();
        let value = line.substring(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) { out[key] = value.slice(1, -1); continue; }
        value = value.replace(/,\s*\]/g, ']');
        try { out[key] = JSON.parse(value); } catch (e) { out[key] = value; }
    }
    return out;
}
function parseCalibrationTOML(text, CameraCtor) {
    const cams = [];
    const re = /^\[([^\]]+)\]\s*$/gm; const sections = []; let m;
    while ((m = re.exec(text)) !== null) sections.push({ name: m[1], start: m.index + m[0].length });
    for (let i = 0; i < sections.length; i++) {
        const sec = sections[i]; if (!sec.name.startsWith('cam_')) continue;
        const end = i + 1 < sections.length ? sections[i + 1].start : text.length;
        const props = parseTOMLSection(text.substring(sec.start, end));
        cams.push(new CameraCtor(props.name || sec.name, props.matrix || [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            props.distortions || [0, 0, 0, 0, 0], props.rotation || [0, 0, 0], props.translation || [0, 0, 0],
            props.size || [640, 480]));
    }
    return cams;
}
function instancePoints(sub, fi, animal, nA, nN) {
    const pts = new Array(nN); let allNull = true;
    for (let k = 0; k < nN; k++) {
        const base = (((fi * nA) + animal) * nN + k) * 2;
        const x = sub[base], y = sub[base + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) pts[k] = null; else { pts[k] = [x, y]; allNull = false; }
    }
    return allNull ? null : pts;
}

globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };  // champion defaults from the settings stub
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;
register(pathToFileURL(path.join(HERE, 'hooks.mjs')).href);
const { Camera, Instance, FrameGroup, Session } = await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
const { matchFrameInstances, runCrossViewTracker } = await import(pathToFileURL(path.join(POSE_DIR, 'tracker.js')).href);

await h5.ready;
const allCams = parseCalibrationTOML(fs.readFileSync(CALIB, 'utf8'), Camera);
const benchCams = CAM_NAMES.map(n => { const c = allCams.find(cc => cc.name === n); if (!c) throw new Error('missing cam ' + n); return c; });

// Slice each camera's session (cap the frame window to keep memory sane).
const camSlices = {};
let nNodes = 0, nAnimals = 0;
for (const cam of CAM_NAMES) {
    const f = new h5.File(path.join(POOL, `${cam}_predictions.h5`), 'r');
    const ds = f.get('tracks'); const [, nF, nA, nN] = ds.shape;
    const win = Math.min(nF, 12000);
    const data = ds.slice([[SESSION_IDX, SESSION_IDX + 1], [0, win], [0, nA], [0, nN], [0, 2]]);
    camSlices[cam] = { data, nA, nN, win }; nNodes = nN; nAnimals = nA;
    f.close();
}
const win = camSlices[CAM_NAMES[0]].win;
const usedFrames = [];
for (let fi = 0; fi < win && usedFrames.length < MAX_FRAMES; fi++) {
    let any = false;
    for (const cam of CAM_NAMES) { const sl = camSlices[cam]; for (let a = 0; a < sl.nA && !any; a++) if (instancePoints(sl.data, fi, a, sl.nA, sl.nN)) any = true; if (any) break; }
    if (any) usedFrames.push(fi);
}

function buildSession() {
    const s = new Session(benchCams, { nodes: NODE_NAMES }, [], 'speed');
    for (const fi of usedFrames) {
        const fg = new FrameGroup(fi);
        for (const cam of CAM_NAMES) {
            const sl = camSlices[cam];
            for (let a = 0; a < sl.nA; a++) { const pts = instancePoints(sl.data, fi, a, sl.nA, sl.nN); if (pts) fg.addInstance(cam, new Instance(pts, a, 'predicted', 1.0)); }
        }
        s.addFrameGroup(fg);
    }
    return s;
}

// Count total detections for context.
let totalDets = 0;
{ const s = buildSession(); for (const [, fg] of s.frameGroups) for (const [, insts] of fg.instances) totalDets += insts.length; }

function timeLuc3d() {
    const s = buildSession(); s.identities = []; s.frameIdentityMap = new Map();
    const t0 = performance.now(); let pa = null, pt = null, ids = 0;
    for (const fi of s.frameIndices) {
        const fg = s.getFrameGroup(fi);
        try {
            const r = matchFrameInstances(fg, s.cameras, s, { numAnimals: NUM_ANIMALS, perFrame: true, prevAssignments: pa, prevTargets3d: pt });
            if (r.assignments && r.assignments.size > 0) pa = r.assignments;
            if (r.targets3d && r.targets3d.length > 0) pt = r.targets3d;
        } catch (e) { /* skip frame */ }
    }
    return { ms: performance.now() - t0, ids: s.identities.length };
}
function timeCrossView() {
    const s = buildSession(); s.identities = []; s.frameIdentityMap = new Map(); s.instanceGroups = new Map();
    const t0 = performance.now();
    const r = runCrossViewTracker(s, s.cameras, s.frameIndices, true);
    return { ms: performance.now() - t0, ids: r.numIdentities };
}

// warmup (JIT) on a small slice
timeLuc3d(); timeCrossView();
const L = timeLuc3d(), Z = timeCrossView();
const F = usedFrames.length;
console.log(`\nsession-idx ${SESSION_IDX} (10072022131531)  cameras=${CAM_NAMES.length}  animals(cap)=${nAnimals}  nodes=${nNodes}`);
console.log(`frames with detections: ${F}   total detections: ${totalDets}  (~${(totalDets / F).toFixed(1)} dets/frame across ${CAM_NAMES.length} cams)`);
console.log(`\nLUC3D      (matchFrameInstances):  ${L.ms.toFixed(0)} ms  →  ${(F / (L.ms / 1000)).toFixed(1)} fps   (${(L.ms / F).toFixed(2)} ms/frame)  [${L.ids} identities]`);
console.log(`CrossView  (runCrossViewTracker):  ${Z.ms.toFixed(0)} ms  →  ${(F / (Z.ms / 1000)).toFixed(1)} fps   (${(Z.ms / F).toFixed(2)} ms/frame)  [${Z.ids} identities]`);
console.log(`\nratio (CrossView / LUC3D time): ${(Z.ms / L.ms).toFixed(2)}x  ${Z.ms < L.ms ? '(CrossView faster)' : '(CrossView slower)'}`);
