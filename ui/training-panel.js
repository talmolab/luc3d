/**
 * ui/training-panel.js — the Training panel: train sleap-nn models on the project's labelled
 * frames, across every camera view, on this machine (the desktop app with sleap-nn in the build)
 * or on a paired SLEAP Connect worker.
 *
 * A replica of sleap-app's Training panel (`src/components/panels/TrainingPanel.tsx` and the
 * training slice of `src/stores/trainingStore.ts` @ c97c6a5): the same sections in the same order
 * (Model Type & Configs, Data, Hyperparameters, Remote), the same labels, defaults, hints, config
 * slots and presets ("Preset: Centroid (Medium RF)" …), the ★ recommendation, Start / Stop Early /
 * Cancel and the progress rows / log / error output / completion block.
 *
 * LUCID changes:
 *   - Data is the project's sessions × camera views, not one labels file: a checklist of every
 *     view with its user-labelled frame count. LUCID writes the training `.slp` itself
 *     (`import-export/training-slp.js`): user instances only, identities as tracks, the current
 *     in-memory edits (nothing has to be saved first);
 *   - "Models for views": one model for all views (default) or one per view
 *     (`pose/training-groups.js`); each group trains its own model pair, one after another, and
 *     each model gets a progress row ("Centroid · all views");
 *   - the ★ recommendation reads every included view, each against its own video size
 *     (`pose/training-recommend.js`); "+ ID" types check LUCID's identities
 *     (`pose/training-data.js` `idModelProblem`); box-detector types are disabled (no box labels);
 *   - Top-Down + ID's second slot defaults to the Multi-Class Top-Down preset (sleap-app's
 *     `slotToHeadType` gives that slot plain centered-instance presets);
 *   - a worker run sends one train job per model of each group (`pose/connect/remote-training-plan.js`,
 *     `ui/connect/remote-training.js`); every video must already be on the worker (Locate on
 *     worker… as for remote inference); validation is sleap-nn's own random split there (the
 *     protocol takes a validation file only as a worker path), which the Data section says;
 *   - local runs go through Rust (`src-tauri/src/training.rs`): the page sends each model's config
 *     as JSON and the training / validation files as bytes; Rust checks the config against
 *     sleap-nn's keys, owns every path and port, runs `sleap-nn train` and streams its progress. The
 *     runs folder is picked once per app run and is read-only to the page (checkpoints are
 *     pickles); each view's video is found on disk from the file the user opened. Locally the
 *     validation split is LUCID's by moment (a separate validation file);
 *   - progress rows stay in the panel while the run goes (no RemoteRunCard / Watch Live); a row
 *     opens the Training Monitor (`ui/training-monitor.js`, with the validation images locally).
 *     Full Configuration and post-training inference come in later updates.
 *
 * Loaded on every build: `pose/initialization.js` imports it after the Inference panel. It talks
 * to native code only through `window.lucidDesktop`, inside `setupTrainingPanel`.
 */
import { state } from './app-state.js';
import { registerPanelRailPanel, showPanelTab } from './panel-rail.js';
import { railIconSvg } from './panel-rail-icons.js';
import { noteProgress, resetProgress } from './progress-delta.js';
import { askConfirm } from './ask.js';
import { createPanelForm, el, icon, button } from './panel-form.js';
import {
    MODEL_TYPE_OPTIONS, MODEL_TYPE_HINT, DEFAULT_MODEL_TYPE, getConfigSlots, getSlotLabel, slotToHeadType, headLabel,
    profilesForHead, defaultProfile, detectHeadType, hyperparamsFromConfig, applyPanelSettings, finalizeConfig,
    anchorChoices, ROTATION_OPTIONS, MAX_EPOCHS_HINT, BATCH_SIZE_HINT, ROTATION_HINT, SCALE_HINT, ANCHOR_HINT,
} from './training-args.js';
import { BASELINE_PROFILES } from '../lib/sleap-app-profiles/profiles.js';
import { trainingGroups, groupModelLabel, trainingRunName, DEFAULT_GROUP_MODE } from '../pose/training-groups.js';
import { idModelProblem, interpolationProblem, isIdModelType, isBoxModelType } from '../pose/training-data.js';
import { recommendPipeline, skeletonCompatibility, arborescenceProblems, arborescenceMessage } from '../pose/training-recommend.js';
import { countUserLabels, collectGroupLabels, buildTrainingLabels, trainingSlpBytes } from '../import-export/training-slp.js';
import { findSkeletonMismatch } from '../import-export/file-io.js';
import { createBackendPicker } from './connect/backend-picker.js';
import { createRemoteTraining } from './connect/remote-training.js';
import { bytesToBase64, payloadCheck, buildTrainSpec, initialRows, rowWithTelemetry, finishRow, rowText } from '../pose/connect/remote-training-plan.js';
import { configureConnect } from '../pose/connect/store.js';
import { formatRunTimestamp, formatDuration } from '../pose/connect/timestamp.js';
import { plateauSettings } from '../pose/training-metrics.js';
import { openTrainingMonitor, trainingMonitor } from './training-monitor.js';
import { rowWithLocalProgress } from '../pose/training-local-progress.js';

export const TRAINING_TAB_ID = 'tabTraining';

const LOG_MAX = 5000;
const LOG_TAIL = 12;
const COUNT_TTL_MS = 15000;
const ERROR_LINE_RE = /error|exception|traceback|failed/i;
/** macOS prints duplicate-ObjC-class warnings for cv2/av on every sleap-nn start; never the cause. */
function isNoise(line) { return /^objc\[\d+\]: Class /.test(line); }

let pane = null;
let YAML = null;                 // the importmap's `yaml` module, once loaded
let remote = null;               // ui/connect/remote-training.js
let sn = null;                   // window.lucidDesktop.sleapNn (with .training), desktop builds with sleap-nn
let fsApi = null;                // window.lucidDesktop.fs
// Backend: true = a paired SLEAP Connect worker; null = this build's default (local when it has sleap-nn).
const backend = { remote: null };
const env = { checked: false, sleapNn: null, gpu: null, error: null };
// Local: the runs folder (a read-only model grant this app run), each (session, view)'s video on disk.
const local = { runsRoot: null, existingRuns: 0, videos: new Map(), videoKey: '', resolving: false, token: null };
const dry = { status: 'idle', rows: [], log: [], key: '', error: null };

const cfg = {
    modelType: DEFAULT_MODEL_TYPE,
    modelTypeTouched: false,
    slots: {},                   // slot -> {name, filename, preset: bool, doc, head}
    hp: {},                      // slot -> hyperparams (training-args `hyperparamsFromConfig`)
    activeTab: null,
    anchorPart: null,
    groupMode: DEFAULT_GROUP_MODE,
    unchecked: new Set(),        // 'sessionIdx:view'
};
const run = {
    status: 'idle', error: null, rows: [], log: [], errorTail: [], startedAt: null, endedAt: null,
    modelDirs: [], cancelled: false, stopRequested: false, note: null,
};
const analysis = { key: '', at: 0, counts: new Map(), rec: null, idReport: null, nodeNames: [], trackNames: [] };
let elapsedTimer = null;
let form = null;
let monitorIndex = null;          // the row the Training Monitor shows

function isRunning() { return run.status === 'running'; }
function isDone() { return run.status === 'completed' || run.status === 'error'; }
function refresh() {
    if (remote) remote.sync();
    if (form) form.runRefreshers();
    const mon = trainingMonitor();
    if (mon && monitorIndex != null) mon.update();
}

// ---------------------------------------------------------------------------
// Project facts
// ---------------------------------------------------------------------------

/** Every session of the project with its index (the key its video files carry). */
function projectSessions() {
    const list = state.sessions && state.sessions.length ? state.sessions : (state.session ? [state.session] : []);
    return list.map(function (s, i) { return { index: i, session: s }; }).filter(function (x) { return !!x.session; });
}

function videoFileOf(sIdx, cam) {
    return (state.videoFiles || []).find(function (vf) {
        const vi = typeof vf.sessionIdx === 'number' ? vf.sessionIdx : 0;
        return vi === sIdx && (vf.assignedCamera || vf.name) === cam;
    }) || null;
}

/** A session's views: its cameras with a video (all of them when none has one yet). */
function sessionViews(sIdx, session) {
    const cams = (session.cameras || []).map(function (c) { return c.name; });
    const withVideo = cams.filter(function (c) { return !!videoFileOf(sIdx, c); });
    return withVideo.length ? withVideo : cams;
}

function viewDescriptors(sIdx) {
    const s = projectSessions().find(function (x) { return x.index === sIdx; });
    if (!s) return [];
    return sessionViews(sIdx, s.session).map(function (view) {
        const vf = videoFileOf(sIdx, view);
        const f = vf && vf.file;
        return {
            view: view,
            fileName: f ? f.name : (vf && vf.videoPath ? String(vf.videoPath).split(/[\\/]/).pop() : ''),
            fileSize: f && typeof f.size === 'number' ? f.size : null,
            relPath: f && f.webkitRelativePath ? f.webkitRelativePath : '',
            videoPath: vf ? vf.videoPath : '',
        };
    });
}

function viewKey(sIdx, view) { return sIdx + ':' + view; }

/** Camera names across sessions, in first-seen order (the "views" groups are made of). */
function allViewNames() {
    const out = [];
    for (const s of projectSessions()) for (const v of sessionViews(s.index, s.session)) if (out.indexOf(v) === -1) out.push(v);
    return out;
}

function labelCount(sIdx, view) {
    const c = analysis.counts.get(viewKey(sIdx, view));
    return c || { frames: 0, instances: 0 };
}

/** The (session, view) pairs that will train: checked and holding at least one user label. */
function includedSelections() {
    const out = [];
    for (const s of projectSessions()) {
        for (const view of sessionViews(s.index, s.session)) {
            if (cfg.unchecked.has(viewKey(s.index, view))) continue;
            if (labelCount(s.index, view).frames === 0) continue;
            out.push({ sessionIndex: s.index, session: s.session, cameraName: view, videoFileInfo: videoFileOf(s.index, view) || {} });
        }
    }
    return out;
}

function includedViewNames() {
    const out = [];
    for (const sel of includedSelections()) if (out.indexOf(sel.cameraName) === -1) out.push(sel.cameraName);
    return out;
}

function groups() { return trainingGroups(cfg.groupMode, includedViewNames()); }

function skeletonOf() {
    const s = state.session || (projectSessions()[0] && projectSessions()[0].session);
    const sk = s && s.skeleton;
    if (!sk) return null;
    return {
        nodes: (sk.nodes || []).map(function (n) { return typeof n === 'string' ? n : (n && n.name) || ''; }),
        edges: (sk.edges || []).map(function (e) { return [e[0], e[1]]; }),
    };
}

/**
 * Counts, the ★ recommendation and the identity report, recomputed when the project changes
 * (sessions, resident frames, dirty flag) or every 15 s while the panel shows: the counts walk
 * every lazy store row, too slow for each 2 s refresh.
 */
function analyze(force) {
    const sess = projectSessions();
    const key = [sess.length, state.activeSessionIdx, state.isDirty ? 1 : 0,
        sess.map(function (s) { return s.session.name + '#' + (s.session.frameGroups ? s.session.frameGroups.size : 0); }).join(','),
        (state.videoFiles || []).length].join('|');
    const now = Date.now();
    if (!force && key === analysis.key && now - analysis.at < COUNT_TTL_MS) return;
    analysis.key = key; analysis.at = now;
    analysis.counts = new Map();
    for (const s of sess) {
        const views = sessionViews(s.index, s.session);
        try {
            const c = countUserLabels(s.session, views);
            for (const [v, n] of c) analysis.counts.set(viewKey(s.index, v), n);
        } catch (e) { console.warn('[training] counting labels failed:', e); }
    }
    analysis.rec = null; analysis.idReport = null; analysis.trackNames = [];
    const sk = skeletonOf();
    analysis.nodeNames = sk ? sk.nodes : [];
    const sels = includedSelections();
    if (!sels.length) return;
    try {
        const collected = collectGroupLabels(sels);
        const frames = collected.frames.map(function (fr) {
            const sel = sels[fr.sel];
            const vf = sel.videoFileInfo || {};
            return {
                maxDim: Math.max(Number(vf.videoWidth) || 0, Number(vf.videoHeight) || 0),
                instances: fr.items.map(function (it) {
                    const pts = [];
                    for (let k = 0; k < it.inst.numNodes; k++) {
                        const has = it.inst.hasPoint(k);
                        pts.push([has ? it.inst.getX(k) : NaN, has ? it.inst.getY(k) : NaN, has && !it.inst.isOccluded(k)]);
                    }
                    return pts;
                }),
            };
        });
        const tracks = new Set();
        for (const r of collected.sessions.values()) r.trackNames.forEach(function (n) { tracks.add(n); });
        analysis.trackNames = Array.from(tracks);
        analysis.rec = recommendPipeline({ frames: frames, numEdges: sk ? sk.edges.length : 0, trackCount: tracks.size });
        analysis.idReport = Array.from(collected.sessions.values());
    } catch (e) {
        console.warn('[training] reading labels failed:', e);
    }
}

function totalLabelledFrames() {
    let n = 0;
    for (const sel of includedSelections()) n += labelCount(sel.sessionIndex, sel.cameraName).frames;
    return n;
}

// ---------------------------------------------------------------------------
// Configs (YAML)
// ---------------------------------------------------------------------------

async function ensureYaml() {
    if (YAML) return YAML;
    YAML = await import('yaml');
    // The Connect store hoists each train config's run name into its job (`withYamlRunName`).
    configureConnect({ yamlLoad: function (s) { return YAML.parse(s); } });
    return YAML;
}

/** Load a config into a slot, from a preset or a file the user picked. */
function setSlotConfig(slot, text, name, filename, preset) {
    let doc;
    try { doc = YAML.parse(text); } catch (e) { run.note = 'Could not read ' + (filename || 'the config') + ': ' + e.message; refresh(); return false; }
    if (!doc || typeof doc !== 'object') { run.note = (filename || 'The config') + ' is not a training config.'; refresh(); return false; }
    cfg.slots[slot] = { name: name, filename: filename, preset: !!preset, doc: doc, head: detectHeadType(doc) };
    cfg.hp[slot] = hyperparamsFromConfig(doc);
    if ((slot === 'centered_instance' || slot === 'config') && cfg.hp[slot].anchorPart != null && cfg.anchorPart == null) cfg.anchorPart = cfg.hp[slot].anchorPart;
    run.note = null;
    return true;
}

/** Make sure every slot of the model type holds a config of the right head (the Medium RF preset by default). */
function ensureSlots() {
    if (!YAML) return;
    const slots = getConfigSlots(cfg.modelType);
    for (const slot of Object.keys(cfg.slots)) if (slots.indexOf(slot) === -1) { delete cfg.slots[slot]; delete cfg.hp[slot]; }
    for (const slot of slots) {
        const want = slotToHeadType(cfg.modelType, slot);
        const cur = cfg.slots[slot];
        if (cur && (cur.head === want || !cur.preset)) continue;
        const p = defaultProfile(cfg.modelType, slot);
        if (p) setSlotConfig(slot, p.content, p.label, p.filename, true);
    }
    if (slots.indexOf(cfg.activeTab) === -1) cfg.activeTab = slots[0];
}

function setModelType(t) {
    if (t === cfg.modelType) return;
    cfg.modelType = t;
    cfg.modelTypeTouched = true;
    // A preset of the old pipeline does not fit the new one: start the new slots from their presets.
    for (const slot of Object.keys(cfg.slots)) if (cfg.slots[slot].preset) { delete cfg.slots[slot]; delete cfg.hp[slot]; }
    ensureSlots();
}

function slotOptions(slot) {
    const head = slotToHeadType(cfg.modelType, slot);
    const opts = profilesForHead(head).map(function (p) { return ['preset:' + p.filename, p.label]; });
    const cur = cfg.slots[slot];
    if (cur && !cur.preset) opts.push(['file:' + cur.filename, cur.filename]);
    opts.push(['__browse__', 'Browse for config file...']);
    return opts;
}

function slotValue(slot) {
    const cur = cfg.slots[slot];
    if (!cur) return '';
    return cur.preset ? 'preset:' + cur.filename : 'file:' + cur.filename;
}

function browseConfig(slot) {
    const input = el('input');
    input.type = 'file';
    input.accept = '.yaml,.yml';
    input.addEventListener('change', function () {
        const f = input.files && input.files[0];
        if (f) readConfigFile(slot, f);
    });
    input.click();
}

function readConfigFile(slot, file) {
    if (!/\.ya?ml$/i.test(file.name)) { run.note = file.name + ' is not a YAML config.'; refresh(); return; }
    file.text().then(function (text) {
        if (setSlotConfig(slot, text, file.name, file.name, false)) refresh();
    }, function (e) { run.note = 'Could not read ' + file.name + ': ' + e.message; refresh(); });
}

/** The finished YAML of a slot for one group's run. */
function configText(slot, runName) {
    const s = cfg.slots[slot];
    const hp = Object.assign({}, cfg.hp[slot]);
    if (cfg.modelType === 'top_down' || cfg.modelType === 'top_down_id') hp.anchorPart = cfg.anchorPart || null;
    const doc = finalizeConfig(applyPanelSettings(s.doc, hp), { runName: runName });
    return YAML.stringify(doc);
}

// ---------------------------------------------------------------------------
// Can it start?
// ---------------------------------------------------------------------------

function pipelineProblem() {
    if (isBoxModelType(cfg.modelType)) return 'Box Detector types need box labels, which LUCID does not have.';
    const sk = skeletonOf();
    if (cfg.modelType === 'bottom_up' && sk) {
        const p = arborescenceProblems(sk);
        if (p) return arborescenceMessage(p);
    }
    if (isIdModelType(cfg.modelType) && analysis.idReport) {
        const views = cfg.groupMode === 'perview' ? 1 : includedViewNames().length;
        const p = idModelProblem(analysis.idReport, { views: views });
        if (p) return p;
    }
    const interp = interpolationProblem([{ kind: 'node', names: analysis.nodeNames }, { kind: 'identity / track', names: analysis.trackNames }]);
    if (interp) return interp;
    const sels = includedSelections();
    if (sels.length > 1) {
        const bySession = [];
        const seen = new Set();
        for (const s of sels) if (!seen.has(s.session)) { seen.add(s.session); bySession.push(s); }
        const mm = findSkeletonMismatch(bySession);
        if (mm) return mm + '. Uncheck that session’s views to train without it.';
    }
    return null;
}

function hasAllConfigs() {
    return getConfigSlots(cfg.modelType).every(function (s) { return !!cfg.slots[s]; });
}

/** Views that train but are not on the worker yet. */
function unplacedViews() {
    if (!remote || !remote.connected()) return [];
    return includedSelections().filter(function (s) { return !remote.workerVideo(s.sessionIndex, s.cameraName); });
}

function whyNotStart() {
    if (isRunning()) return '';
    if (!YAML) return 'Loading presets…';
    if (!projectSessions().length) return 'Open a session first.';
    if (pipelineProblem()) return 'Fix the problem under Model Type to start';
    if (!hasAllConfigs()) return 'Upload config file(s) to begin';
    if (totalLabelledFrames() === 0) return 'Label at least one frame before training';
    if (isRemoteRun()) {
        const w = remote ? remote.whyNot() : 'Select a worker';
        if (w) return w;
        if (unplacedViews().length) return 'Locate each view’s video on the worker (Data).';
        if (!remote.outputDir()) return 'Choose an output folder on the worker (Data).';
    } else {
        if (!env.checked) return 'Checking for sleap-nn…';
        if (!sleapNnAvailable()) return 'sleap-nn was not found on this machine (Remote: pick a worker instead).';
        if (!local.runsRoot) return 'Choose a runs folder (Data).';
        if (local.resolving) return 'Finding the videos on disk…';
        if (missingLocalVideos().length) return 'Open each view’s video from its file so the app knows where it is on disk (' + missingLocalVideos()[0].cameraName + ').';
        if (dry.status === 'running') return '';
    }
    return '';
}

function sleapNnAvailable() { return !!(sn && env.sleapNn && env.sleapNn.available); }
/** Whether a run goes to a worker: the only choice without local sleap-nn, else the Backend picker's. */
function isRemoteRun() { return !sn ? true : backend.remote === true; }

// ---------------------------------------------------------------------------
// Local: videos on disk, runs folder
// ---------------------------------------------------------------------------

function isAbsolutePath(p) { return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(String(p || '')); }

/** Find each included (session, view)'s video on disk: the file the user opened, else the path the
 *  .slp recorded (when the app may read it). Re-run when the views or their files change. */
async function resolveLocalVideos() {
    if (!fsApi || local.resolving) return;
    const sels = includedSelections();
    const key = sels.map(function (s) {
        const f = s.videoFileInfo && s.videoFileInfo.file;
        return viewKey(s.sessionIndex, s.cameraName) + '|' + (f ? f.name + ':' + f.size + ':' + (f.webkitRelativePath || '') : '') + '|' + (s.videoFileInfo.videoPath || '');
    }).join('\u0001');
    if (key === local.videoKey) return;
    local.resolving = true;
    try {
        const found = new Map();
        for (const s of sels) {
            const vf = s.videoFileInfo || {};
            const f = vf.file;
            let hit = null;
            if (f && typeof fsApi.pathOfFile === 'function') {
                try { hit = await fsApi.pathOfFile(f); } catch (e) { hit = null; }
            }
            if (!hit && isAbsolutePath(vf.videoPath)) {
                try {
                    const st = await fsApi.stat(vf.videoPath);
                    if (st && st.isFile && (!f || Number(st.size) === f.size)) hit = { path: vf.videoPath };
                } catch (e) { /* not readable by the app */ }
            }
            if (hit && hit.path) found.set(viewKey(s.sessionIndex, s.cameraName), hit.path);
        }
        local.videos = found;
        local.videoKey = key;
    } finally {
        local.resolving = false;
        refresh();
    }
}

function localVideo(sIdx, view) { return local.videos.get(viewKey(sIdx, view)) || null; }
function missingLocalVideos() { return includedSelections().filter(function (s) { return !localVideo(s.sessionIndex, s.cameraName); }); }

async function chooseRunsFolder() {
    if (!sn || !sn.training) return;
    try {
        const r = await sn.training.pickRunsDirectory('Choose the folder trained models go to');
        if (r && r.path) {
            local.runsRoot = r.path;
            local.existingRuns = r.existingRuns || 0;
            try { localStorage.setItem('trainingRunsFolder', r.path); } catch (e) { /* best effort */ }
            run.note = null;
        }
    } catch (e) {
        run.note = String((e && e.message) || e).replace(/^TRAINING_NOT_ALLOWED: /, '');
    }
    refresh();
}

function lastRunsFolder() {
    try { return localStorage.getItem('trainingRunsFolder') || ''; } catch (e) { return ''; }
}

async function detectEnvironment() {
    if (!sn) { env.checked = true; refresh(); return; }
    env.error = null;
    try { env.sleapNn = await sn.detectSleapNn(); } catch (e) { env.sleapNn = null; env.error = e.message; }
    try { env.gpu = await sn.detectGpu(); } catch (e) { env.gpu = null; }
    env.checked = true;
    refresh();
}

// ---------------------------------------------------------------------------
// Run (remote)
// ---------------------------------------------------------------------------

function appendLog(line, progress) {
    const s = String(line).replace(/[\r\n]+$/, '');
    if (!s.trim()) return;
    if (progress && run.log.length && run._lastProgress) run.log[run.log.length - 1] = s;
    else run.log.push(s);
    run._lastProgress = !!progress;
    if (!progress && ERROR_LINE_RE.test(s) && !isNoise(s)) {
        run.errorTail.push(s);
        if (run.errorTail.length > 20) run.errorTail.shift();
    }
    if (run.log.length > LOG_MAX) run.log.splice(0, run.log.length - LOG_MAX);
}

function startElapsed() {
    stopElapsed();
    elapsedTimer = setInterval(function () { if (pane && pane.offsetParent !== null) refresh(); }, 1000);
}
function stopElapsed() { if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = null; }

/** One group's selections, with each video named by its worker path. */
function groupSelections(group) {
    return includedSelections().filter(function (s) { return group.views.indexOf(s.cameraName) !== -1; })
        .map(function (s) { return Object.assign({}, s, { videoFilename: remote.workerVideo(s.sessionIndex, s.cameraName) }); });
}

function startTraining() {
    if (whyNotStart()) return;
    if (isRemoteRun()) startRemoteTraining(); else startLocalTraining(false);
}

/** The progress-row plan of one group's models. */
function groupModels(g, slots, runNames) {
    return slots.map(function (s, i) {
        const h = cfg.slots[s].head;
        const pl = plateauSettings(cfg.slots[s].doc);
        return { head: h, label: groupModelLabel(headLabel(h), g), maxEpochs: cfg.hp[s].maxEpochs, runName: runNames[i],
            plateauPatience: pl.patience, plateauMinDelta: pl.minDelta };
    });
}

/** The finished config (an object) of a slot for one run name. */
function configObject(slot, runName) {
    const hp = Object.assign({}, cfg.hp[slot]);
    if (cfg.modelType === 'top_down' || cfg.modelType === 'top_down_id') hp.anchorPart = cfg.anchorPart || null;
    return finalizeConfig(applyPanelSettings(cfg.slots[slot].doc, hp), { runName: runName });
}

/**
 * Plan a local run: per group, the training and validation files (split by moment, videos named by
 * placeholders), each video's disk path in table order, and each model's config.
 */
async function planLocal(stamp, dryRun) {
    const slots = getConfigSlots(cfg.modelType);
    const plans = [];
    for (const g of groups()) {
        const sels = includedSelections().filter(function (s) { return g.views.indexOf(s.cameraName) !== -1; })
            // The file names each video by its disk path (what a reader of the file expects); Rust still
            // passes the same grant-checked paths as --video-paths, which is what sleap-nn uses.
            .map(function (s) { return Object.assign({}, s, { videoFilename: localVideo(s.sessionIndex, s.cameraName) }); });
        const hp0 = cfg.hp[slots[0]];
        const built = buildTrainingLabels(sels, { split: { fraction: hp0.validationFraction, seed: hp0.seed == null ? 0 : hp0.seed } });
        const train = await trainingSlpBytes(built.train);
        const val = built.split.sameAsTrain ? null : await trainingSlpBytes(built.val);
        const runNames = slots.map(function (s) {
            return trainingRunName({ timestamp: stamp, head: cfg.slots[s].head, group: g, mode: cfg.groupMode, nFrames: built.stats.frames }) + (dryRun ? '.dryrun' : '');
        });
        plans.push({
            group: g, stats: built.stats, split: built.split,
            args: {
                runsRoot: local.runsRoot,
                models: slots.map(function (s, i) { return { config: configObject(s, runNames[i]), runName: runNames[i] }; }),
                trainSlp: bytesToBase64(train),
                valSlp: val ? bytesToBase64(val) : null,
                videoPaths: sels.map(function (s) { return localVideo(s.sessionIndex, s.cameraName); }),
            },
            models: groupModels(g, slots, runNames),
        });
    }
    return plans;
}

/** Strip Rust's refusal prefixes for the panel. */
function plainError(e) {
    return String((e && e.message) || e).replace(/^(TRAINING_NOT_ALLOWED|CONFIG_NOT_ALLOWED|NOT_GRANTED): /, '');
}

/** One model of a prepared local run; resolves to the `finished` event's data. */
function runLocalModel(token, index, k, dryRun, onLine) {
    return new Promise(function (resolve) {
        let fin = null;
        sn.training.run(token, index, function (msg) {
            const d = msg && msg.data;
            if (!msg || !d) return;
            if (msg.event === 'stdout' || msg.event === 'stderr') {
                const line = String(d.line || '');
                onLine(line.replace(/\r$/, ''), /\r$/.test(line), msg.event === 'stderr');
            } else if (msg.event === 'progress' && k != null && run.rows[k]) {
                run.rows[k] = rowWithLocalProgress(run.rows[k], d);
                if (run.rows[k].status !== 'running') markRunning(k);
                scheduleRefresh();
            } else if (msg.event === 'finished') {
                fin = d;
            }
        }, { dryRun: dryRun }).then(function () {
            resolve(fin || { success: false, error: 'sleap-nn ended without a result' });
        }, function (e) {
            resolve({ success: false, error: plainError(e) });
        });
    });
}

async function startLocalTraining() {
    const stamp = formatRunTimestamp();
    run.status = 'running'; run.error = null; run.log = []; run.errorTail = []; run.modelDirs = [];
    run.cancelled = false; run.stopRequested = false; run.startedAt = Date.now(); run.endedAt = null; run.note = null;
    refresh();
    let plans;
    try {
        plans = await planLocal(stamp, false);
    } catch (e) {
        run.status = 'error'; run.error = plainError(e); run.endedAt = Date.now();
        refresh();
        return;
    }
    run.rows = initialRows(plans);
    let ri = 0;
    plans.forEach(function (p) {
        p.models.forEach(function (m) {
            Object.assign(run.rows[ri], { plateauPatience: m.plateauPatience, plateauMinDelta: m.plateauMinDelta, runDir: joinRunDir(local.runsRoot, m.runName) });
            ri++;
        });
        appendLog('$ Training: ' + p.group.name + ' — ' + p.stats.frames.toLocaleString('en-US') + ' labelled frames (' +
            p.split.train.size.toLocaleString('en-US') + ' moments for training, ' + (p.split.sameAsTrain ? 'validated on the same frames' : p.split.val.size.toLocaleString('en-US') + ' for validation') +
            '), ' + p.stats.videos + ' video' + (p.stats.videos === 1 ? '' : 's'));
    });
    startElapsed();
    refresh();
    let base = 0;
    outer:
    for (const p of plans) {
        if (run.cancelled) break;
        let token;
        try {
            token = await sn.training.prepare(p.args);
        } catch (e) {
            run.error = plainError(e);
            break;
        }
        local.token = token;
        for (let i = 0; i < p.models.length; i++) {
            const k = base + i;
            if (run.cancelled) break outer;
            markRunning(k);
            refresh();
            const fin = await runLocalModel(token, i, k, false, function (line, progress, err) {
                appendLog(line, progress);
                if (err && !progress && !ERROR_LINE_RE.test(line) && line.trim() && !isNoise(line)) {
                    run.errorTail.push(line);
                    if (run.errorTail.length > 20) run.errorTail.shift();
                }
                scheduleRefresh();
            });
            if (fin.success) {
                run.rows[k] = endRow(run.rows[k], { status: 'completed', modelDir: fin.modelDir });
                if (fin.modelDir) run.modelDirs.push(fin.modelDir);
            } else {
                run.rows[k] = endRow(run.rows[k], { status: fin.cancelled || run.cancelled ? 'cancelled' : 'failed' });
                if (!(fin.cancelled || run.cancelled)) {
                    const last = run.errorTail.length ? run.errorTail[run.errorTail.length - 1] : '';
                    run.error = 'Training ' + run.rows[k].label + ' failed' + (fin.error ? ': ' + fin.error : fin.code != null ? ' (exit code ' + fin.code + ')' : '') +
                        (last && !fin.error ? ' — ' + last : '');
                }
                try { await sn.training.release(token); } catch (e) { /* already gone */ }
                local.token = null;
                break outer;
            }
        }
        local.token = null;
        base += p.models.length;
    }
    run.endedAt = Date.now();
    if (run.cancelled) {
        run.status = 'error';
        run.error = 'Training cancelled';
        run.rows.forEach(function (r, i) { if (r.status === 'running') run.rows[i] = endRow(r, { status: 'cancelled' }); });
    } else {
        run.status = run.error ? 'error' : 'completed';
    }
    stopElapsed();
    refresh();
}

function joinRunDir(root, name) {
    const sep = String(root).indexOf('\\') !== -1 && String(root).indexOf('/') === -1 ? '\\' : '/';
    return String(root).replace(/[\\/]+$/, '') + sep + name;
}

/** The config + data a dry run checked, to say when it no longer matches. */
function dryRunKey() {
    return JSON.stringify([cfg.modelType, cfg.groupMode, getConfigSlots(cfg.modelType).map(function (s) { return [slotValue(s), cfg.hp[s]]; }),
        cfg.anchorPart, includedSelections().map(function (s) { return viewKey(s.sessionIndex, s.cameraName); }), local.runsRoot]);
}

/** sleap-app's Dry run: setup plus one training and one validation batch per model, nothing kept. */
async function startDryRun() {
    if (whyNotStart() || isRemoteRun() || dry.status === 'running') return;
    dry.status = 'running'; dry.rows = []; dry.log = []; dry.error = null; dry.key = dryRunKey();
    refresh();
    let plans;
    try {
        plans = await planLocal(formatRunTimestamp(), true);
    } catch (e) {
        dry.status = 'failed'; dry.error = plainError(e);
        refresh();
        return;
    }
    outer:
    for (const p of plans) {
        let token;
        try { token = await sn.training.prepare(p.args); } catch (e) { dry.status = 'failed'; dry.error = plainError(e); break; }
        local.token = token;
        for (let i = 0; i < p.models.length; i++) {
            if (dry.status === 'cancelled') {
                try { await sn.training.release(token); } catch (e) { /* already gone */ }
                local.token = null;
                break outer;
            }
            const lines = [];
            const fin = await runLocalModel(token, i, null, true, function (line) {
                lines.push(line);
                dry.log.push(line);
                if (dry.log.length > LOG_MAX) dry.log.splice(0, dry.log.length - LOG_MAX);
            });
            const text = lines.join('\n');
            if (/No such option:? .?--dry-run/i.test(text)) {
                dry.status = 'unsupported';
                try { await sn.training.release(token); } catch (e) { /* already gone */ }
                local.token = null;
                break outer;
            }
            const passed = !!fin.success;
            dry.rows.push({ label: p.models[i].label, passed: passed,
                summary: passed ? lines.filter(function (l) { return /dry run|samples|steps per epoch|device|run folder/i.test(l); }).slice(-6) : [],
                errors: passed ? [] : lines.filter(function (l) { return ERROR_LINE_RE.test(l) || /^\s+File /.test(l); }).slice(-12) });
            refresh();
        }
        try { await sn.training.release(token); } catch (e) { /* already gone */ }
        local.token = null;
    }
    if (dry.status === 'running') dry.status = dry.rows.length && dry.rows.every(function (r) { return r.passed; }) ? 'passed' : 'failed';
    refresh();
}

async function startRemoteTraining() {
    const gs = groups();
    const slots = getConfigSlots(cfg.modelType);
    const stamp = formatRunTimestamp();
    run.status = 'running'; run.error = null; run.log = []; run.errorTail = []; run.modelDirs = [];
    run.cancelled = false; run.stopRequested = false; run.startedAt = Date.now(); run.endedAt = null; run.note = null;
    // Plan every group first (data + configs), so nothing is sent if one of them cannot be built.
    const plans = [];
    try {
        for (const g of gs) {
            const sels = groupSelections(g);
            const built = buildTrainingLabels(sels, { split: { overfit: true } });
            const bytes = await trainingSlpBytes(built.train);
            const check = payloadCheck(bytes.byteLength);
            if (check.level === 'refuse') throw new Error(check.message + ' Train fewer views per model (One per view).');
            if (check.level === 'warn' && !(await askConfirm(check.message + ' Send it?', { okLabel: 'Send' }))) {
                throw new Error('Not sent.');
            }
            const heads = slots.map(function (s) { return cfg.slots[s].head; });
            const runNames = heads.map(function (h) {
                return trainingRunName({ timestamp: stamp, head: h, group: g, mode: cfg.groupMode, nFrames: built.stats.frames });
            });
            const configs = slots.map(function (s, i) { return configText(s, runNames[i]); });
            const spec = buildTrainSpec({
                configs: configs, modelTypes: heads, labelsContent: bytesToBase64(bytes),
                project: remote.tag(), outputDir: remote.outputDir(),
            });
            plans.push({
                group: g, spec: spec, stats: built.stats,
                models: heads.map(function (h, i) {
                    const pl = plateauSettings(cfg.slots[slots[i]].doc);
                    return { head: h, label: groupModelLabel(headLabel(h), g), maxEpochs: cfg.hp[slots[i]].maxEpochs, runName: runNames[i],
                        plateauPatience: pl.patience, plateauMinDelta: pl.minDelta };
                }),
            });
        }
    } catch (e) {
        run.status = 'error'; run.error = (e && e.message) || String(e); run.endedAt = Date.now();
        refresh();
        return;
    }
    run.rows = initialRows(plans);
    let ri = 0;
    plans.forEach(function (p) { p.models.forEach(function (m) { run.rows[ri].plateauPatience = m.plateauPatience; run.rows[ri].plateauMinDelta = m.plateauMinDelta; ri++; }); });
    plans.forEach(function (p) {
        appendLog('$ Remote training: ' + p.group.name + ' — ' + p.stats.frames.toLocaleString('en-US') + ' labelled frames, ' +
            p.stats.instances.toLocaleString('en-US') + ' instances, ' + p.stats.videos + ' video' + (p.stats.videos === 1 ? '' : 's') +
            ' (' + p.models.map(function (m) { return m.runName; }).join(', ') + ')');
    });
    remote.beginRun();
    startElapsed();
    refresh();
    let base = 0;
    try {
        for (const p of plans) {
            if (run.cancelled) break;
            let inGroup = 0;
            markRunning(base);
            refresh();
            const res = await remote.submitGroup(p.spec, {
                onLog: function (line, progress) { appendLog(line, progress); scheduleRefresh(); },
                onTelemetry: function (t, i) {
                    const k = base + i;
                    if (!run.rows[k]) return;
                    run.rows[k] = rowWithTelemetry(run.rows[k], t);
                    if (run.rows[k].status !== 'running') markRunning(k);
                    if (t.kind === 'epoch') run.rows[k].epochStartedAt = Date.now();
                    scheduleRefresh();
                },
                onModelComplete: function (r) {
                    const k = base + inGroup;
                    run.rows[k] = endRow(run.rows[k], { status: 'completed', modelDir: r.modelDir });
                    if (r.modelDir) run.modelDirs.push(r.modelDir);
                    inGroup++;
                    if (run.rows[base + inGroup]) markRunning(base + inGroup);
                    refresh();
                },
            });
            const k = base + inGroup;
            if (res && res.success) {
                run.rows[k] = endRow(run.rows[k], { status: 'completed', modelDir: res.modelDir });
                if (res.modelDir) run.modelDirs.push(res.modelDir);
            } else {
                run.rows[k] = endRow(run.rows[k], { status: run.cancelled ? 'cancelled' : 'failed' });
                if (!run.cancelled) {
                    const last = run.errorTail.length ? run.errorTail[run.errorTail.length - 1] : '';
                    run.error = 'Training ' + run.rows[k].label + ' failed' + (res && res.error ? ': ' + res.error : '') + (last ? ' — ' + last : '');
                }
                break;
            }
            base += p.models.length;
        }
    } catch (e) {
        if (!run.cancelled) run.error = (e && e.message) || String(e);
    }
    run.endedAt = Date.now();
    if (run.cancelled) {
        run.status = 'error';
        run.error = 'Training cancelled';
        run.rows.forEach(function (r, i) { if (r.status === 'running') run.rows[i] = endRow(r, { status: 'cancelled' }); });
    } else {
        run.status = run.error ? 'error' : 'completed';
    }
    stopElapsed();
    refresh();
}

/** A row starts: its clocks start (the monitor's runtime lines). */
function markRunning(k) {
    const r = run.rows[k];
    if (!r) return;
    r.status = 'running';
    r.startedAt = r.startedAt || Date.now();
    r.epochStartedAt = Date.now();
}

/** A row ends: `finishRow` plus its end time. */
function endRow(r, outcome) {
    const out = finishRow(r, outcome);
    out.endedAt = Date.now();
    return out;
}

/** Open the Training Monitor on row `i` (sleap-app: click a progress row). */
function openMonitor(i) {
    if (!run.rows[i]) return;
    monitorIndex = i;
    openTrainingMonitor({
        row: function () { return run.rows[monitorIndex]; },
        runStatus: function () { return run.status; },
        isActive: function () {
            const r = run.rows[monitorIndex];
            return isRunning() && !!r && r.status === 'running' && !run.cancelled;
        },
        errorLines: function () { return run.errorTail.slice(); },
        onStopEarly: stopEarly,
        onCancel: cancelTraining,
        // Local runs: sleap-nn's per-epoch prediction images, read from the run folder (a model grant).
        readFile: !isRemoteRun() && fsApi && typeof fsApi.readFile === 'function' ? function (path) { return fsApi.readFile(path); } : null,
    });
}

let refreshPending = false;
function scheduleRefresh() {
    if (refreshPending) return;
    refreshPending = true;
    setTimeout(function () { refreshPending = false; refresh(); }, 250);
}

async function stopEarly() {
    if (!isRunning()) return;
    run.stopRequested = true;
    appendLog('Stop requested: the current model saves its checkpoint, then the run goes on.');
    try {
        if (isRemoteRun()) { if (remote) await remote.stopCurrent(); }
        else if (local.token) await sn.training.stop(local.token);
    } catch (e) { appendLog('Stop Early failed: ' + plainError(e)); }
    refresh();
}

async function cancelTraining() {
    if (!isRunning()) return;
    run.cancelled = true;
    appendLog('Cancel requested.');
    try {
        if (isRemoteRun()) { if (remote) await remote.cancelAll(); }
        else if (local.token) await sn.training.cancel(local.token);
    } catch (e) { appendLog('Cancel failed: ' + plainError(e)); }
    refresh();
}

async function cancelDryRun() {
    if (dry.status !== 'running') return;
    dry.status = 'cancelled';
    if (local.token) { try { await sn.training.cancel(local.token); } catch (e) { /* ended */ } }
    refresh();
}

function resetRun(keepConfig) {
    const mon = trainingMonitor();
    if (mon) mon.close();
    monitorIndex = null;
    run.status = 'idle'; run.error = null; run.rows = []; run.log = []; run.errorTail = []; run.modelDirs = [];
    run.startedAt = null; run.endedAt = null; run.cancelled = false; run.stopRequested = false; run.note = null;
    if (!keepConfig) {
        cfg.slots = {}; cfg.hp = {}; cfg.anchorPart = null; cfg.modelTypeTouched = false; cfg.modelType = DEFAULT_MODEL_TYPE;
        cfg.groupMode = DEFAULT_GROUP_MODE; cfg.unchecked.clear();
        ensureSlots();
    }
    refresh();
}

// ---------------------------------------------------------------------------
// Log window (sleap-app LogTerminalDialog)
// ---------------------------------------------------------------------------

function openLogDialog() {
    if (document.getElementById('trnLogDialog')) return;
    const scrim = el('div', 'inf-log-scrim');
    scrim.id = 'trnLogDialog';
    scrim.setAttribute('data-shortcut-modal', '1');
    const box = el('div', 'inf-log-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Training log');
    const head = el('div', 'inf-log-head');
    head.appendChild(el('span', null, 'Training log'));
    const close = button('Close', 'btn btn-sm');
    head.appendChild(close);
    const pre = el('pre', 'inf-log-full', run.log.join('\n'));
    box.appendChild(head); box.appendChild(pre);
    scrim.appendChild(box);
    document.body.appendChild(scrim);
    pre.scrollTop = pre.scrollHeight;
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(); } }
    function done() { document.removeEventListener('keydown', onKey, true); scrim.remove(); }
    close.addEventListener('click', done);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) done(); });
    document.addEventListener('keydown', onKey, true);
}

function copyText(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function buildModelSection(top) {
    const sec = form.section(top, 'Model Type & Configs', true);
    form.selectField(sec, null, null, function () {
        const sk = skeletonOf();
        const compat = skeletonCompatibility(sk);
        const recType = analysis.rec ? analysis.rec.recommended : null;
        return MODEL_TYPE_OPTIONS.map(function (o) {
            const box = isBoxModelType(o.value);
            const edges = compat.disabledTypes.has(o.value);
            return [o.value, o.label + (box ? ' (needs box labels)' : edges ? ' (requires edges)' : '') +
                (recType === o.value && !box && !edges ? ' ★' : '') + (compat.warnings.has(o.value) ? ' ⚠' : ''), box || edges];
        });
    }, function () { return cfg.modelType; }, setModelType, { id: 'trnModelType' });
    // The label sits above the select (sleap-app), with the long ⓘ.
    const typeLabel = form.fieldLabel('Model Type', MODEL_TYPE_HINT);
    sec.insertBefore(typeLabel, sec.firstChild);
    const rec = el('p', 'trn-rec');
    rec.id = 'trnRecommendation';
    sec.appendChild(rec);
    const warnLine = el('p', 'trn-warnline');
    sec.appendChild(warnLine);
    const problem = el('p', 'inf-error-text');
    problem.id = 'trnPipelineProblem';
    sec.appendChild(problem);
    form.onRefresh(function () {
        const r = analysis.rec;
        const compat = skeletonCompatibility(skeletonOf());
        rec.hidden = !r || compat.disabledTypes.has(cfg.modelType);
        if (r) {
            rec.innerHTML = '';
            rec.appendChild(icon('lightbulb'));
            const lab = (MODEL_TYPE_OPTIONS.find(function (o) { return o.value === r.recommended; }) || {}).label;
            rec.appendChild(document.createTextNode(' ' + (cfg.modelType === r.recommended ? r.reason : 'Recommended: ' + lab + ' — ' + r.reason)));
        }
        const w = compat.warnings.get(cfg.modelType);
        warnLine.textContent = w ? '⚠ ' + w : '';
        warnLine.hidden = !w;
        const p = pipelineProblem();
        problem.textContent = p || '';
        problem.hidden = !p;
    });

    const slotsBox = el('div', 'trn-slots');
    sec.appendChild(slotsBox);
    let slotsKey = '';
    form.onRefresh(function () {
        const slots = getConfigSlots(cfg.modelType);
        const key = slots.join(',') + '|' + slots.map(slotValue).join(',') + '|' + isRunning();
        if (key === slotsKey) return;
        slotsKey = key;
        slotsBox.textContent = '';
        for (const slot of slots) {
            const f = el('div', 'inf-block');
            f.appendChild(form.fieldLabel(getSlotLabel(slot), 'Config file for this model in the pipeline. Pick a preset, or browse to a training_config.yaml (also one from a trained model) to reuse its settings.'));
            const box = el('div', 'trn-slot' + (cfg.slots[slot] ? ' trn-slot-set' : ''));
            box.dataset.slot = slot;
            const sel = el('select', 'inf-select');
            sel.id = 'trnSlot-' + slot;
            const cur = slotValue(slot);
            if (!cur) { const ph = el('option', null, 'Select training config file...'); ph.value = ''; sel.appendChild(ph); }
            for (const o of slotOptions(slot)) {
                const op = el('option', null, o[1]);
                op.value = o[0];
                sel.appendChild(op);
            }
            sel.value = cur;
            sel.disabled = isRunning();
            sel.addEventListener('change', function () {
                const v = sel.value;
                if (v === '__browse__') { sel.value = cur; browseConfig(slot); return; }
                if (v.indexOf('preset:') === 0) {
                    const p = BASELINE_PROFILES.find(function (x) { return 'preset:' + x.filename === v; });
                    if (p) setSlotConfig(slot, p.content, p.label, p.filename, true);
                }
                refresh();
            });
            box.appendChild(sel);
            const meta = el('div', 'trn-slot-meta', cfg.slots[slot] ? 'head: ' + cfg.slots[slot].head : 'or drop a YAML config here');
            box.appendChild(meta);
            box.addEventListener('dragover', function (e) { e.preventDefault(); box.classList.add('trn-slot-drag'); });
            box.addEventListener('dragleave', function () { box.classList.remove('trn-slot-drag'); });
            box.addEventListener('drop', function (e) {
                e.preventDefault(); box.classList.remove('trn-slot-drag');
                const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                if (file && !isRunning()) readConfigFile(slot, file);
            });
            f.appendChild(box);
            slotsBox.appendChild(f);
        }
    });
    const filled = el('div', 'trn-ok-note', 'Auto-filled from config files. All fields are editable.');
    sec.appendChild(form.shownIf(filled, function () { return hasAllConfigs(); }));
    const note = el('p', 'inf-error-text');
    sec.appendChild(note);
    form.onRefresh(function () { note.textContent = run.note || ''; note.hidden = !run.note; });
}

function buildDataSection(top) {
    const sec = form.section(top, 'Data', true);

    // Training data: sessions × views
    sec.appendChild(form.fieldLabel('Training data', 'The labelled frames of every checked view are training data: your own instances only (predictions are not), ' +
        'with identities as tracks. Your current edits are used; nothing has to be saved first.'));
    const list = el('div', 'trn-views');
    list.id = 'trnViews';
    sec.appendChild(list);
    const summary = el('p', 'inf-muted');
    summary.id = 'trnDataSummary';
    sec.appendChild(summary);
    let listKey = '';
    form.onRefresh(function () {
        const sess = projectSessions();
        const rows = [];
        for (const s of sess) {
            const lazy = !!(s.session.lazyLoader);
            rows.push({ head: true, s: s, lazy: lazy });
            for (const view of sessionViews(s.index, s.session)) {
                const c = labelCount(s.index, view);
                const vf = videoFileOf(s.index, view);
                const file = vf && vf.file ? (vf.file.webkitRelativePath || vf.file.name) : (vf && vf.videoPath ? vf.videoPath : '');
                rows.push({ s: s, view: view, c: c, file: file,
                    checked: !cfg.unchecked.has(viewKey(s.index, view)),
                    worker: isRemoteRun() ? (remote && remote.connected() ? remote.videoStatus(s.index, view) : '')
                        : (local.resolving && !localVideo(s.index, view) ? 'finding it on disk\u2026' : localVideo(s.index, view) || 'not found among the files you opened'),
                    locate: isRemoteRun() && remote && remote.canLocate(s.index, view) && c.frames > 0 });
            }
        }
        const key = JSON.stringify(rows.map(function (r) { return r.head ? ['h', r.s.index, r.s.session.name, r.lazy] : [r.s.index, r.view, r.c.frames, r.c.instances, r.file, r.checked, r.worker, r.locate]; })) + isRunning();
        if (key !== listKey) {
            listKey = key;
            list.textContent = '';
            for (const r of rows) {
                if (r.head) {
                    const h = el('div', 'trn-vsess', r.s.session.name || ('Session ' + (r.s.index + 1)));
                    if (r.lazy) h.appendChild(el('span', 'trn-lazy', 'lazy'));
                    list.appendChild(h);
                    continue;
                }
                const row = el('div', 'trn-vrow' + (r.c.frames === 0 ? ' trn-vrow-empty' : ''));
                row.dataset.view = r.view; row.dataset.session = String(r.s.index);
                const cb = el('input');
                cb.type = 'checkbox';
                cb.checked = r.checked;
                cb.disabled = isRunning() || r.c.frames === 0;
                cb.setAttribute('aria-label', 'Train on ' + r.view + ' of ' + (r.s.session.name || 'this session'));
                cb.addEventListener('change', function () {
                    const k = viewKey(r.s.index, r.view);
                    if (cb.checked) cfg.unchecked.delete(k); else cfg.unchecked.add(k);
                    analyze(true);
                    refresh();
                });
                row.appendChild(cb);
                row.appendChild(el('span', 'trn-vname', r.view));
                row.appendChild(el('span', 'trn-vfile', r.file));
                row.appendChild(el('span', 'trn-vcount', r.c.frames.toLocaleString('en-US') + ' frame' + (r.c.frames === 1 ? '' : 's')));
                list.appendChild(row);
                if (r.worker && r.c.frames > 0 && r.checked) {
                    const w = el('div', 'trn-vworker');
                    w.appendChild(el('span', 'trn-vworker-text', r.worker));
                    if (r.locate) {
                        const b = button('Locate on worker…', 'btn btn-sm inf-btn-outline trn-locate');
                        b.disabled = isRunning();
                        b.addEventListener('click', function () { remote.locate(r.s.index, r.view); });
                        w.appendChild(b);
                    }
                    list.appendChild(w);
                }
            }
            if (!rows.length) list.appendChild(el('p', 'inf-muted', 'Open a session to see its views.'));
        }
        let frames = 0, inst = 0, vids = 0;
        for (const sel of includedSelections()) { const c = labelCount(sel.sessionIndex, sel.cameraName); frames += c.frames; inst += c.instances; vids++; }
        summary.textContent = frames.toLocaleString('en-US') + ' labelled frame' + (frames === 1 ? '' : 's') + ' · ' +
            inst.toLocaleString('en-US') + ' user instance' + (inst === 1 ? '' : 's') + ' · ' + vids + ' video' + (vids === 1 ? '' : 's');
    });

    // Models for views
    const mvRow = el('div', 'inf-block');
    mvRow.appendChild(form.fieldLabel('Models for views', 'One model for all views trains one model (or top-down pair) on every view together. ' +
        'One per view trains a separate model for each camera, one after another: for rigs whose cameras see the animals very differently.'));
    const seg = el('div', 'trn-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Models for views');
    [['shared', 'One for all views'], ['perview', 'One per view']].forEach(function (m) {
        const b = button(m[1], 'trn-seg-btn');
        b.dataset.mode = m[0];
        b.addEventListener('click', function () { cfg.groupMode = m[0]; refresh(); });
        seg.appendChild(b);
        form.onRefresh(function () { b.setAttribute('aria-pressed', cfg.groupMode === m[0] ? 'true' : 'false'); b.disabled = isRunning(); });
    });
    mvRow.appendChild(seg);
    const chips = el('div', 'trn-chips');
    chips.id = 'trnGroups';
    mvRow.appendChild(chips);
    sec.appendChild(mvRow);
    form.onRefresh(function () {
        chips.textContent = '';
        for (const g of groups()) {
            const c = el('span', 'trn-chip');
            const dot = el('i');
            dot.style.background = g.color;
            c.appendChild(dot);
            c.appendChild(document.createTextNode(cfg.groupMode === 'shared' ? 'One model · ' + g.views.join(', ') : g.name));
            chips.appendChild(c);
        }
    });

    // Validation split
    const vs = el('div', 'inf-block');
    vs.appendChild(form.fieldLabel('Validation split', 'A fraction of the labelled frames is held out to measure the validation loss.'));
    sec.appendChild(vs);
    form.numField(vs, 'Validation Fraction', null, function () { const hp = cfg.hp[firstSlot()]; return hp ? hp.validationFraction : 0.1; },
        function (v) { for (const s of Object.keys(cfg.hp)) cfg.hp[s].validationFraction = v; }, { min: 0.01, max: 0.5, step: 0.01, id: 'trnValFraction' });
    const vnote = el('p', 'inf-muted');
    vs.appendChild(vnote);
    form.onRefresh(function () {
        vnote.textContent = isRemoteRun()
            ? 'On a worker, sleap-nn picks the validation frames at random, so another camera’s view of a validation moment can be in training.'
            : 'All views of one moment stay on the same side.';
    });

    // Output folder on the worker
    const outRow = el('div', 'inf-block');
    outRow.id = 'trnOutput';
    outRow.appendChild(form.fieldLabel('Output folder', 'Where the worker puts the trained models: a models folder inside this folder, one run folder per model.'));
    const outLine = el('div', 'trn-pathrow');
    const outPath = el('span', 'trn-path');
    outLine.appendChild(outPath);
    const outChange = button('Change…', 'btn btn-sm inf-btn-outline');
    outChange.addEventListener('click', function () { remote.chooseOutputDir(); });
    outLine.appendChild(outChange);
    outRow.appendChild(outLine);
    sec.appendChild(form.shownIf(outRow, function () { return isRemoteRun() && !!remote && remote.connected(); }));

    // Runs folder (local): picked once per app run; read-only to the app (checkpoints are pickles).
    const runsRow = el('div', 'inf-block');
    runsRow.id = 'trnRunsFolder';
    runsRow.appendChild(form.fieldLabel('Runs folder', 'Where trained models go: one run folder per model. The app reads this folder but never writes in it ' +
        '(only sleap-nn does), so pick a folder for models only, such as a models folder next to the project.'));
    const runsLine = el('div', 'trn-pathrow');
    const runsPath = el('span', 'trn-path');
    runsLine.appendChild(runsPath);
    const runsChoose = button('Choose\u2026', 'btn btn-sm inf-btn-outline');
    runsChoose.id = 'trnRunsChoose';
    runsChoose.addEventListener('click', chooseRunsFolder);
    runsLine.appendChild(runsChoose);
    runsRow.appendChild(runsLine);
    const runsNote = el('p', 'inf-muted');
    runsRow.appendChild(runsNote);
    sec.appendChild(form.shownIf(runsRow, function () { return !isRemoteRun(); }));
    form.onRefresh(function () {
        runsPath.textContent = local.runsRoot || (lastRunsFolder() ? 'choose again: ' + lastRunsFolder() : 'none chosen');
        runsChoose.disabled = isRunning();
        runsNote.textContent = local.runsRoot && local.existingRuns
            ? local.existingRuns.toLocaleString('en-US') + ' trained run' + (local.existingRuns === 1 ? '' : 's') + ' already there.' : '';
        runsNote.hidden = !runsNote.textContent;
    });
    form.onRefresh(function () {
        if (!remote) return;
        outPath.textContent = remote.outputChecking() ? 'Checking…' : (remote.outputDir() ? remote.outputDir() + '/models' : 'none: choose a folder');
        outChange.disabled = isRunning();
    });
}

function firstSlot() { return getConfigSlots(cfg.modelType)[0]; }

function buildHyperSection(top) {
    const sec = form.section(top, 'Hyperparameters', true);
    const none = el('p', 'inf-muted', 'Upload config file(s) above to see hyperparameters.');
    sec.appendChild(form.shownIf(none, function () { return !hasAllConfigs(); }));
    const body = el('div', 'inf-sub0');
    sec.appendChild(form.shownIf(body, function () { return hasAllConfigs(); }));

    const anchor = form.selectField(body, 'Anchor Part', ANCHOR_HINT, function () { return anchorChoices(analysis.nodeNames); },
        function () { return cfg.anchorPart || ''; }, function (v) { cfg.anchorPart = v || null; }, { id: 'trnAnchor' });
    form.shownIf(anchor, function () { return cfg.modelType === 'top_down' || cfg.modelType === 'top_down_id'; });

    const tabs = el('div', 'trn-seg trn-tabs');
    body.appendChild(tabs);
    form.onRefresh(function () {
        const slots = getConfigSlots(cfg.modelType);
        tabs.hidden = slots.length < 2;
        const key = slots.join(',');
        if (tabs.dataset.key !== key) {
            tabs.dataset.key = key;
            tabs.textContent = '';
            for (const slot of slots) {
                const b = button(getSlotLabel(slot).replace(' Config', ''), 'trn-seg-btn');
                b.dataset.slot = slot;
                b.addEventListener('click', function () { cfg.activeTab = slot; refresh(); });
                tabs.appendChild(b);
            }
        }
        for (const b of tabs.children) b.setAttribute('aria-pressed', b.dataset.slot === cfg.activeTab ? 'true' : 'false');
    });
    function hp() { return cfg.hp[cfg.activeTab] || cfg.hp[firstSlot()] || null; }
    form.numField(body, 'Max Epochs', MAX_EPOCHS_HINT, function () { const h = hp(); return h ? h.maxEpochs : null; },
        function (v) { const h = hp(); if (h) h.maxEpochs = v; }, { min: 1, max: 1000, integer: true, id: 'trnMaxEpochs' });
    form.numField(body, 'Batch Size', BATCH_SIZE_HINT, function () { const h = hp(); return h ? h.batchSize : null; },
        function (v) { const h = hp(); if (h) h.batchSize = v; }, { min: 1, max: 512, integer: true, id: 'trnBatchSize' });
    form.selectField(body, 'Rotation Augmentation', ROTATION_HINT, ROTATION_OPTIONS, function () { const h = hp(); return h ? h.rotationPreset : 'off'; },
        function (v) { const h = hp(); if (h) h.rotationPreset = v; }, { id: 'trnRotation' });
    const custom = form.numField(body, 'Rotation (± degrees)', null, function () { const h = hp(); return h ? h.rotationCustomAngle : null; },
        function (v) { const h = hp(); if (h) h.rotationCustomAngle = v; }, { min: 0, max: 180, integer: true });
    form.shownIf(custom, function () { const h = hp(); return !!h && h.rotationPreset === 'custom'; });
    form.check(body, 'Scale Augmentation', SCALE_HINT, function () { const h = hp(); return !!h && h.scaleEnabled; },
        function (v) { const h = hp(); if (h) h.scaleEnabled = v; });
}

function buildRemoteSection(top) {
    // sleap-app: collapsed on the desktop (Local is the default there); the only backend on the web.
    const sec = form.section(top, 'Remote', !sn);
    const picker = createBackendPicker({
        jobLabel: 'training job',
        localAvailable: function () { return !!sn; },
        localListed: function () { return typeof window !== 'undefined' && !!window.lucidDesktop; },
        remoteEnabled: isRemoteRun,
        onRemoteEnabledChange: function (on) { backend.remote = on; local.videoKey = ''; refresh(); },
        hintButton: form.hintBtn,
        idPrefix: 'trn',
    });
    sec.appendChild(picker.el);
    form.onRefresh(picker.refresh);
    const envLine = el('p', 'inf-muted');
    envLine.id = 'trnEnvLine';
    sec.appendChild(envLine);
    form.onRefresh(function () {
        envLine.hidden = !sn;
        if (!sn) return;
        envLine.textContent = !env.checked ? 'Checking for sleap-nn\u2026'
            : sleapNnAvailable() ? 'sleap-nn ' + (env.sleapNn.version || '') + (env.gpu ? ' \u00b7 ' + String(env.gpu).toUpperCase() : '')
                : 'sleap-nn not found' + (env.error ? ': ' + env.error : '');
    });
}

function buildRunBlock(top) {
    const startRow = el('div', 'trn-btns trn-start-row');
    const startBtn = button('Start Remote Training', 'btn btn-primary inf-run', 'upload');
    startBtn.id = 'trnStart';
    const startLabel = startBtn.lastChild;
    startBtn.addEventListener('click', function () { startTraining(); });
    const dryBtn = button('Dry run', 'btn btn-sm inf-btn-outline trn-dry', 'flask-conical');
    dryBtn.id = 'trnDryRun';
    dryBtn.title = 'Check the config and data first, in seconds: setup plus one training and one validation batch per model, with your settings. Nothing is kept.';
    dryBtn.addEventListener('click', function () { startDryRun(); });
    startRow.appendChild(startBtn);
    startRow.appendChild(dryBtn);
    top.appendChild(form.shownIf(startRow, function () { return !isRunning() && !isDone(); }));
    form.onRefresh(function () {
        startLabel.textContent = ' ' + (isRemoteRun() ? 'Start Remote Training' : 'Start Training');
        // sleap-nn's --dry-run runs here, on this machine; a worker has no way to run one.
        dryBtn.hidden = isRemoteRun();
        dryBtn.disabled = !!whyNotStart() || dry.status === 'running';
    });
    buildDryRunResult(top);
    const why = el('p', 'inf-muted trn-center');
    why.id = 'trnWhy';
    top.appendChild(why);
    form.onRefresh(function () {
        const w = whyNotStart();
        startBtn.disabled = !!w;
        why.textContent = !isRunning() && !isDone() ? w : '';
        why.hidden = !why.textContent;
    });

    const stopRow = el('div', 'trn-btns');
    const stopBtn = button('Stop Early', 'btn btn-sm trn-stop', 'square');
    stopBtn.id = 'trnStopEarly';
    stopBtn.addEventListener('click', stopEarly);
    const cancelBtn = button('Cancel', 'btn btn-sm inf-btn-danger trn-cancel', 'x');
    cancelBtn.id = 'trnCancel';
    cancelBtn.addEventListener('click', cancelTraining);
    stopRow.appendChild(stopBtn); stopRow.appendChild(cancelBtn);
    top.appendChild(form.shownIf(stopRow, isRunning));
    const stopNote = el('p', 'trn-tiny', 'Stop Early saves a checkpoint. Cancel terminates immediately.');
    top.appendChild(form.shownIf(stopNote, isRunning));
    form.onRefresh(function () { stopBtn.disabled = run.cancelled; cancelBtn.disabled = run.cancelled; });

    // Completed / failed actions
    const models = el('div', 'trn-banner-ok');
    models.id = 'trnModels';
    top.appendChild(form.shownIf(models, function () { return run.status === 'completed' && run.modelDirs.length > 0; }));
    form.onRefresh(function () {
        models.textContent = '';
        models.appendChild(el('div', 'trn-strong', 'Trained model' + (run.modelDirs.length > 1 ? 's' : '') + ':'));
        for (const d of run.modelDirs) models.appendChild(el('div', 'trn-path-ok', d));
    });
    const again = button('Train Again', 'btn btn-primary inf-run');
    again.id = 'trnTrainAgain';
    again.addEventListener('click', function () { resetRun(true); });
    top.appendChild(form.shownIf(again, function () { return run.status === 'completed'; }));
    const failRow = el('div', 'trn-btns');
    const retry = button('Retry', 'btn btn-sm inf-btn-outline');
    retry.id = 'trnRetry';
    retry.addEventListener('click', function () { resetRun(true); });
    const fresh = button('New Training', 'btn btn-sm btn-primary');
    fresh.id = 'trnNewTraining';
    fresh.addEventListener('click', function () { resetRun(false); });
    failRow.appendChild(retry); failRow.appendChild(fresh);
    top.appendChild(form.shownIf(failRow, function () { return run.status === 'error'; }));
}

/** sleap-app DryRunResult: a headline, one row per model, the error output and the log on demand. */
function buildDryRunResult(top) {
    const box = el('div', 'trn-dry-box');
    box.id = 'trnDryResult';
    const head = el('div', 'trn-dry-head');
    const headIcon = el('span', 'inf-icon');
    const headText = el('span');
    const cancel = button('Cancel', 'btn btn-sm inf-btn-ghost');
    cancel.addEventListener('click', cancelDryRun);
    head.appendChild(headIcon); head.appendChild(headText); head.appendChild(cancel);
    box.appendChild(head);
    const stale = el('p', 'inf-muted', 'The config changed since this check; run it again to check the new one.');
    box.appendChild(stale);
    const rows = el('div', 'trn-dry-rows');
    box.appendChild(rows);
    const logBtns = el('div', 'trn-btns');
    const showLog = button('Show log', 'btn btn-sm inf-btn-ghost');
    const copyLog = button('Copy log', 'btn btn-sm inf-btn-ghost', 'copy');
    logBtns.appendChild(showLog); logBtns.appendChild(copyLog);
    box.appendChild(logBtns);
    const logPre = el('pre', 'inf-log');
    logPre.hidden = true;
    box.appendChild(logPre);
    showLog.addEventListener('click', function () { logPre.hidden = !logPre.hidden; showLog.textContent = logPre.hidden ? 'Show log' : 'Hide log'; });
    copyLog.addEventListener('click', function () { copyText(dry.log.join('\n')); });
    top.appendChild(form.shownIf(box, function () { return dry.status !== 'idle' && !isRemoteRun() && !isRunning(); }));
    form.onRefresh(function () {
        const S = {
            running: ['loader-circle', 'Checking\u2026', 'inf-spin'],
            passed: ['circle-check', 'Dry run passed. Ready to train.', 'inf-ok'],
            failed: ['circle-x', 'Dry run failed. Fix this before training.', 'inf-bad'],
            unsupported: ['circle-alert', 'This sleap-nn can\u2019t do a dry run. Training itself still works.', 'inf-warnc'],
            cancelled: ['circle-alert', 'Dry run cancelled', 'inf-warnc'],
        }[dry.status];
        if (!S) return;
        headIcon.className = 'inf-icon ' + S[2];
        headIcon.innerHTML = railIconSvg(S[0]);
        headText.textContent = dry.error ? 'Dry run failed: ' + dry.error : S[1];
        cancel.hidden = dry.status !== 'running';
        stale.hidden = dry.status === 'running' || dry.key === dryRunKey();
        rows.textContent = '';
        for (const r of dry.rows) {
            const row = el('div', 'trn-dry-row ' + (r.passed ? 'trn-completed' : 'trn-failed'));
            row.appendChild(icon(r.passed ? 'circle-check' : 'circle-x'));
            row.appendChild(el('span', null, r.label));
            rows.appendChild(row);
            const detail = (r.passed ? r.summary : r.errors).join('\n');
            if (detail) {
                const pre = el('pre', 'inf-log' + (r.passed ? '' : ' trn-dry-err'), detail);
                rows.appendChild(pre);
                if (!r.passed) {
                    const c = button('Copy', 'btn btn-sm inf-btn-ghost', 'copy');
                    c.addEventListener('click', function () { copyText(detail); });
                    rows.appendChild(c);
                }
            }
        }
        logBtns.hidden = dry.log.length === 0;
        logPre.textContent = dry.log.slice(-200).join('\n');
    });
}

function buildProgress(root) {
    const prog = el('div', 'inf-progress trn-progress');
    prog.id = 'trnProgress';
    root.appendChild(form.shownIf(prog, function () { return run.rows.length > 0 || run.status === 'error'; }));
    const head = el('div', 'inf-status');
    const statusIcon = el('span', 'inf-icon');
    const statusText = el('span', 'inf-status-text');
    const elapsed = el('span', 'inf-elapsed');
    head.appendChild(statusIcon); head.appendChild(statusText); head.appendChild(elapsed);
    prog.appendChild(head);
    const banner = el('div', 'trn-banner-ok');
    prog.appendChild(banner);
    const rowsBox = el('div', 'trn-rows');
    rowsBox.id = 'trnRows';
    prog.appendChild(rowsBox);
    const logHead = el('div', 'inf-row');
    logHead.appendChild(el('span', 'inf-label', 'Log'));
    const logBtns = el('span', 'trn-logbtns');
    const expand = button('Expand', 'btn btn-sm inf-btn-ghost', 'maximize-2');
    expand.addEventListener('click', openLogDialog);
    const copy = button('Copy', 'btn btn-sm inf-btn-ghost', 'copy');
    copy.addEventListener('click', function () { copyText(run.log.join('\n')); });
    logBtns.appendChild(expand); logBtns.appendChild(copy);
    logHead.appendChild(logBtns);
    const logPre = el('pre', 'inf-log');
    logPre.id = 'trnLog';
    logPre.title = 'Click to open the full log';
    logPre.addEventListener('click', openLogDialog);
    const logWrap = el('div');
    logWrap.appendChild(logHead); logWrap.appendChild(logPre);
    prog.appendChild(logWrap);
    const errBox = el('div', 'inf-errbox');
    errBox.id = 'trnError';
    prog.appendChild(errBox);
    const errOut = el('div', 'trn-errout');
    const errTitle = el('div', 'inf-row');
    errTitle.appendChild(el('span', 'inf-label', 'Error output (sleap-nn)'));
    const errCopy = button('Copy', 'btn btn-sm inf-btn-ghost', 'copy');
    errCopy.addEventListener('click', function () { copyText(run.errorTail.join('\n')); });
    errTitle.appendChild(errCopy);
    const errPre = el('pre', 'inf-log');
    errOut.appendChild(errTitle); errOut.appendChild(errPre);
    prog.appendChild(errOut);
    const next = el('div', 'trn-banner-next');
    next.appendChild(el('b', null, 'Next step: '));
    next.appendChild(document.createTextNode('Use these models in the Inference tab (Models ▸ Assign models… ▸ the worker) to run predictions on your data.'));
    prog.appendChild(next);

    const fills = new Map();
    form.onRefresh(function () {
        const running = isRunning();
        const ST = running ? ['loader-circle', 'Training...', 'inf-spin']
            : run.status === 'completed' ? ['circle-check', 'Complete', 'inf-ok']
                : run.status === 'error' ? ['circle-x', 'Failed', 'inf-bad'] : null;
        if (ST) {
            statusIcon.className = 'inf-icon ' + ST[2];
            statusIcon.innerHTML = railIconSvg(ST[0]);
            statusText.textContent = ST[1];
        }
        elapsed.textContent = run.startedAt ? formatDuration((run.endedAt || Date.now()) - run.startedAt) : '';
        banner.hidden = run.status !== 'completed';
        banner.innerHTML = '';
        banner.appendChild(el('b', null, 'Training complete! '));
        banner.appendChild(document.createTextNode(run.rows.length > 1 ? 'All ' + run.rows.length + ' models trained successfully.' : 'Model trained successfully.'));

        // Rows: rebuilt only when their shape changes, the bars updated in place.
        const shape = run.rows.map(function (r) { return r.label + '|' + r.status; }).join(',');
        if (rowsBox.dataset.shape !== shape) {
            rowsBox.dataset.shape = shape;
            rowsBox.textContent = '';
            fills.clear();
            run.rows.forEach(function (r, i) {
                const row = el('div', 'trn-row' + (r.status === 'completed' && running ? ' trn-row-done' : ''));
                row.dataset.index = String(i);
                const lab = el('div', 'trn-row-lab trn-' + r.status);
                const ic = r.status === 'completed' ? 'circle-check' : r.status === 'failed' ? 'circle-x' : r.status === 'cancelled' ? 'ban'
                    : r.status === 'running' ? 'loader-circle' : null;
                if (ic) lab.appendChild(icon(ic, r.status === 'running' ? 'inf-spin' : ''));
                else lab.appendChild(el('span', 'trn-dot'));
                lab.appendChild(el('span', 'trn-row-text'));
                if (r.status !== 'pending') {
                    // sleap-app: a row with a chart opens the Training Monitor.
                    lab.classList.add('trn-row-open');
                    lab.setAttribute('role', 'button');
                    lab.tabIndex = 0;
                    lab.title = 'Open the Training Monitor';
                    lab.appendChild(icon('chart-line', 'trn-row-chart'));
                    lab.addEventListener('click', function () { openMonitor(i); });
                    lab.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMonitor(i); } });
                }
                row.appendChild(lab);
                const bar = el('div', 'inf-bar trn-bar');
                const fill = el('div', 'inf-bar-fill trn-fill-' + r.status);
                bar.appendChild(fill);
                row.appendChild(bar);
                row.appendChild(el('div', 'trn-stats'));
                rowsBox.appendChild(row);
                fills.set(i, { fill: fill, last: 0 });
            });
        }
        run.rows.forEach(function (r, i) {
            const row = rowsBox.children[i];
            if (!row) return;
            row.querySelector('.trn-row-text').textContent = rowText(r, i, run.rows.length, running);
            const frac = r.maxEpochs > 0 ? Math.max(0, Math.min(1, r.epoch / r.maxEpochs)) : 0;
            const f = fills.get(i);
            if (f) {
                if (frac < f.last) resetProgress(f.fill);
                f.fill.style.width = (frac * 100) + '%';
                noteProgress(f.fill, frac);
                f.last = frac;
            }
            const stats = row.querySelector('.trn-stats');
            const shown = r.status !== 'pending';
            stats.hidden = !shown;
            stats.textContent = '';
            if (shown) {
                stats.appendChild(el('span', null, r.epoch.toLocaleString('en-US') + ' / ' + r.maxEpochs.toLocaleString('en-US') + ' epochs'));
                if (r.loss != null) stats.appendChild(el('span', null, 'loss: ' + r.loss.toFixed(4)));
            }
        });
        logWrap.hidden = run.log.length === 0;
        logPre.textContent = run.log.slice(-LOG_TAIL).join('\n');
        errBox.textContent = run.error || '';
        errBox.hidden = !(run.error && run.status === 'error');
        errOut.hidden = !(run.status === 'error' && !run.cancelled && run.errorTail.length > 0);
        errPre.textContent = run.errorTail.join('\n');
        next.hidden = run.status !== 'completed';
    });
}

function buildPanel(root) {
    const top = el('div', 'inf-config');
    root.appendChild(top);

    const noLabels = el('div', 'inf-warn trn-nolabels');
    noLabels.appendChild(el('p', null, 'No labeled frames in this project — predicted instances aren’t training data. ' +
        'The settings below are a baseline preset; label some frames to get suggestions tailored to your data.'));
    top.appendChild(form.shownIf(noLabels, function () { return projectSessions().length > 0 && totalLabelledFrames() === 0 && !isRunning(); }));

    buildModelSection(top);
    form.sep(top);
    buildDataSection(top);
    form.sep(top);
    buildHyperSection(top);
    form.sep(top);
    buildRemoteSection(top);
    form.sep(top);
    buildRunBlock(top);
    buildProgress(root);
}

/** The panel's own refresh: re-read the project, then every control. */
function panelRefresh() {
    analyze(false);
    if (!isRemoteRun() && !isRunning()) resolveLocalVideos();
    // sleap-app auto-selects the recommendation for a project whose type the user has not picked.
    if (!cfg.modelTypeTouched && analysis.rec && analysis.rec.recommended !== cfg.modelType && !isRunning()) {
        const compat = skeletonCompatibility(skeletonOf());
        if (!compat.disabledTypes.has(analysis.rec.recommended)) {
            cfg.modelType = analysis.rec.recommended;
            for (const slot of Object.keys(cfg.slots)) if (cfg.slots[slot].preset) { delete cfg.slots[slot]; delete cfg.hp[slot]; }
            ensureSlots();
        }
    }
    refresh();
}

/**
 * Add the Training panel to the rail (every build: remote training needs only a paired worker).
 * Resolves to true when it was added.
 */
export async function setupTrainingPanel() {
    if (pane) return false;
    // Local training: the desktop app with sleap-nn in the build (`lucidDesktop.sleapNn.training`).
    const d = typeof window !== 'undefined' ? window.lucidDesktop : null;
    if (d && d.sleapNn && d.sleapNn.training && d.fs) {
        try {
            const st = await d.sleapNn.status();
            if (st && st.available) { sn = d.sleapNn; fsApi = d.fs; }
        } catch (e) { /* remote only */ }
    }
    form = createPanelForm({ isBusy: function () { return isRunning() || dry.status === 'running'; }, refresh: refresh });
    remote = createRemoteTraining({
        sessions: projectSessions,
        viewDescriptors: viewDescriptors,
        getProjectInfo: function () {
            return { fileName: state.slpFileHandle ? state.slpFileHandle.name : null,
                sessionFolders: (state.sessions || []).map(function (s) { return s.name; }) };
        },
        onChange: function () { if (form) form.runRefreshers(); },
    });
    pane = el('div', 'inference-panel training-panel');
    buildPanel(pane);
    if (!registerPanelRailPanel({ tab: TRAINING_TAB_ID, label: 'Training', icon: 'graduation-cap' }, pane)) {
        pane = null;
        return false;
    }
    pane.addEventListener('pointerenter', function () { analyze(true); panelRefresh(); });
    setInterval(function () { if (pane && pane.offsetParent !== null && !document.hidden) panelRefresh(); }, 2000);
    try {
        await ensureYaml();
        ensureSlots();
    } catch (e) {
        run.note = 'Could not load the training presets: ' + ((e && e.message) || e);
    }
    panelRefresh();
    detectEnvironment();
    return true;
}

/** Test/automation hook: show the panel. */
export function showTrainingPanel() { return showPanelTab(TRAINING_TAB_ID); }

/** For tests: the live config and run state (read-only use). */
export function _trainingState() {
    return { cfg: cfg, run: run, analysis: analysis, groups: groups(), selections: includedSelections(), remote: remote && remote._state(), monitorIndex: monitorIndex,
        local: { runsRoot: local.runsRoot, videos: Object.fromEntries(local.videos), token: local.token }, dry: dry, backendRemote: isRemoteRun() };
}
/** For tests: recompute the label analysis now. */
export function _trainingAnalyze() { analyze(true); panelRefresh(); }
