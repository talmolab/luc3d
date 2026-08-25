#!/usr/bin/env node
/**
 * fig10_bench.mjs — Fig 10 headless driver: the SHIPPED CrossViewTracker from
 * eric/switch-correct on sDANNCE-derived 2D detections (fig10_prep.py output).
 *
 * Fork of scripts/bench/bench_crossview.mjs (that branch, fd21291), differing in:
 *   1. POSE_DIR + hooks come from the eric/switch-correct WORKTREE
 *      (override with LUCID_SC_ROOT) — pose/cross-view-tracker.js, tracker.js,
 *      triangulation.js, pose-data.js load REAL and unmodified; the worktree's
 *      scripts/bench/hooks.mjs stubs only the UI imports. No experimental
 *      redirect — this is the shipped tracker, shipped defaults
 *      (sync association, stale=20, distanceThreshold=25, corr3dWeight=6).
 *   2. Node names are generic (node00..nodeNN — sDANNCE's 23-kp skeleton has no
 *      name manifest in the release), node count read from the first H5.
 *      No tail exclusion; all node weights 1 unless --params overrides.
 *   3. Default cameras cam_1..cam_6; sessionIdx defaults to 0 (prep writes one
 *      session per H5).
 *   4. --params JSON passthrough ({"thresholds":{...},"nodeWeights":{...}}) as in
 *      fig8_bench.mjs, for the C5 sensitivity cell only. Unset = shipped defaults.
 *
 * Output JSON matches the house luc3d_results format (fig10_score.py reads it).
 *
 * CLI:
 *   node fig10_bench.mjs --pred-h5-dir DIR --num-animals N --out out.json \
 *     [--calibration DIR/calibration.toml] [--cameras cam_1,...] [--max-frames N] \
 *     [--params overrides.json] [--no-cap]
 */
import { register } from 'node:module';
import * as h5 from 'h5wasm/node';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SC_ROOT = process.env.LUCID_SC_ROOT ||
    '/root/vast/eric/sleap-3d-gui/scratch/repos/lucid-switch-correct';
const POSE_DIR = path.join(SC_ROOT, 'pose');
const HOOKS_URL = pathToFileURL(path.join(SC_ROOT, 'scripts', 'bench', 'hooks.mjs')).href;

function parseArgs(argv) {
    const o = { cameras: 'cam_1,cam_2,cam_3,cam_4,cam_5,cam_6', sessionIdx: 0 };
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
        else if (a === '--no-cap') o.noCap = true;
        else if (a === '--params') o.params = take();
    }
    if (!o.calibration && o.predH5Dir)
        o.calibration = path.join(o.predH5Dir, 'calibration.toml');
    return o;
}

// --- minimal TOML calibration parser (verbatim from bench_crossview.mjs) ---
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

    // --params passthrough (thresholds / nodeWeights); default = shipped config.
    let overrides = {};
    if (opts.params) overrides = JSON.parse(fs.readFileSync(opts.params, 'utf8'));
    globalThis.__BENCH = {
        nodeWeights: overrides.nodeWeights || {},
        thresholds: overrides.thresholds || {},
    };
    globalThis.document = { getElementById: () => null };
    globalThis.window = globalThis;

    register(HOOKS_URL);
    const { Camera, Instance, FrameGroup, Session } =
        await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
    const { runCrossViewTracker } = await import(pathToFileURL(path.join(POSE_DIR, 'tracker.js')).href);
    // C0 defaults audit: the settings module resolves to the hooks' SETTINGS_STUB
    // (globalThis.__BENCH thresholds over THRESHOLD_DEFAULTS) — the SAME source
    // tracker.js snapshots in createTrackerRun. CrossViewTracker is imported so
    // the effective config can be read back off a tracker instance's own fields.
    const settings = await import(pathToFileURL(path.join(SC_ROOT, 'ui', 'settings.js')).href);
    const { CrossViewTracker } = await import(pathToFileURL(path.join(POSE_DIR, 'cross-view-tracker.js')).href);
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
    const NODE_NAMES = Array.from({ length: nNodes }, (_, i) =>
        'node' + String(i).padStart(2, '0'));

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

    // --- effective-config readback (C0 audit) ---------------------------------
    // Mirror createTrackerRun (pose/tracker.js) exactly: hyperparams come from
    // getTrackingThresholds() (the hooks' settings stub — __BENCH overrides over
    // THRESHOLD_DEFAULTS), maxTargets from the CLI cap, nodeWeights from
    // getNodeWeightArray over the session skeleton. Construct a CrossViewTracker
    // with that hp and read the instance's OWN fields back, so the emitted config
    // is what the tracker actually holds, not what we intended to pass.
    const effThresholds = settings.getTrackingThresholds();
    const probeHp = {
        corr2dWeight: effThresholds.corr2dWeight,
        corr3dWeight: effThresholds.corr3dWeight,
        velocityThreshold: effThresholds.velocityThreshold,
        distanceThreshold: effThresholds.distanceThreshold,
        timePenalty: effThresholds.timePenalty,
        stale: effThresholds.stale,
    };
    if (maxTargets != null) probeHp.maxTargets = maxTargets;
    probeHp.nodeWeights = settings.getNodeWeightArray(NODE_NAMES);
    const probe = new CrossViewTracker(probeHp);
    const effectiveConfig = {
        // runCrossViewTracker is the SYNCHRONOUS association loop (one blocking
        // pass over frames; per-frame association is view-sequential inside
        // CrossViewTracker.trackFrame) — the shipped "sync association" path.
        association: 'sync (runCrossViewTracker)',
        thresholds: effThresholds,
        tracker: {
            corr2d: probe.corr2d,
            corr3d: probe.corr3d,
            velThresh: probe.velThresh,
            distThresh: probe.distThresh,
            timePenalty: probe.timePenalty,
            stale: probe.stale,
            maxTargets: probe.maxTargets,
            nodeWeights: probe.nodeWeights,
        },
    };
    process.stderr.write(`[fig10] effectiveConfig=${JSON.stringify(effectiveConfig.tracker)}\n`);
    process.stderr.write(
        `[fig10] frames=${usedFrames.length} dets=${totalDets} numAnimals=${opts.numAnimals} ` +
        `maxTargets=${opts.noCap ? 'uncapped' : maxTargets} cams=${cameras.join(',')} ` +
        `nodes=${nNodes} overrides=${JSON.stringify(overrides)}\n`);

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
        capped: !opts.noCap,
        overrides,
        effectiveConfig,
        identities,
        frames,
        framesProcessed: usedFrames.length,
        detections: totalDets,
        runtimeSeconds,
        fps,
    }));
    process.stderr.write(
        `[fig10] wrote ${frames.length} frames w/ assignments, ${identities.length} identities, ` +
        `${runtimeSeconds.toFixed(2)}s, ${fps.toFixed(1)} fps → ${opts.out}\n`);
    process.stdout.write(JSON.stringify({
        framesProcessed: usedFrames.length, detections: totalDets,
        runtimeSeconds, fps, numIdentities: identities.length,
    }) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
