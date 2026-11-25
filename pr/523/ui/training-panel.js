/**
 * ui/training-panel.js — the Training panel: train sleap-nn models on the project's labelled
 * frames, across every camera view, on this machine (the desktop app with sleap-nn in the build)
 * or on a paired SLEAP Connect worker.
 *
 * A replica of sleap-app's Training panel (`src/components/panels/TrainingPanel.tsx` and the
 * training slice of `src/stores/trainingStore.ts` @ c97c6a5): the same sections in the same order
 * (Model Type & Configs, Data, Hyperparameters, Remote; now in the Models modal), the same labels, defaults, hints, config
 * slots and presets ("Preset: Centroid (Medium RF)" …), the ★ recommendation, Start / Stop Early /
 * Cancel and the progress rows / log / error output / completion block.
 *
 * LUCID changes:
 *   - Data is the project's sessions × camera views, not one labels file: a checklist of every
 *     view with its user-labelled frame count. LUCID writes the training `.slp` itself
 *     (`import-export/training-slp.js`): user instances only, identities as tracks, the current
 *     in-memory edits (nothing has to be saved first);
 *   - Models: the run trains one or more models, each on a set of camera views, each with its own
 *     settings (model type, configs, anchor, hyperparameters); a view may train several models
 *     (`pose/training-models.js`). They are made and edited in the "Models to train" modal
 *     (`ui/training-models-modal.js`, Edit models…), which also holds the run settings; the panel shows
 *     a summary, Start and the progress, grouped by model. Each model trains its own model pair, one
 *     after another; one model on every view (the default) is sleap-app's training;
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
 *     opens the Training Monitor (`ui/training-monitor.js`, with the validation images locally);
 *   - post-training inference hands the trained models to the Inference panel (`runTrainedModels`),
 *     which runs them on the current session's views each was trained for, with its usual progress,
 *     Cancel and (worker) Fetch & Load; targets and defaults in `pose/training-handoff.js` (Random
 *     sample, not sleap-app's Suggested frames);
 *   - Full Configuration... (`ui/training-config-dialog.js`, fields `ui/training-config-fields.js`) edits the
 *     configs themselves: the panel's fields are written into them on open and re-read after each edit.
 *
 * Loaded on every build: `pose/initialization.js` imports it after the Inference panel. It talks
 * to native code only through `window.lucidDesktop`, inside `setupTrainingPanel`.
 */
import { state } from './app-state.js?v=e37e05d05839';
import { registerPanelRailPanel, showPanelTab } from './panel-rail.js?v=e37e05d05839';
import { railIconSvg } from './panel-rail-icons.js?v=e37e05d05839';
import { noteProgress, resetProgress } from './progress-delta.js?v=e37e05d05839';
import { askConfirm } from './ask.js?v=e37e05d05839';
import { createPanelForm, el, icon, button } from './panel-form.js?v=e37e05d05839';
import {
    MODEL_TYPE_OPTIONS, MODEL_TYPE_HINT, DEFAULT_MODEL_TYPE, getConfigSlots, getSlotLabel, slotToHeadType, headLabel,
    profilesForHead, defaultProfile, detectHeadType, hyperparamsFromConfig, applyPanelSettings, finalizeConfig,
    anchorChoices, ROTATION_OPTIONS, MAX_EPOCHS_HINT, BATCH_SIZE_HINT, ROTATION_HINT, SCALE_HINT, ANCHOR_HINT, CROP_HINT,
    detectTrainingMode, applyTrainingMode, checkpointProblem, pickCheckpointFile,
} from './training-args.js?v=e37e05d05839';
import { BASELINE_PROFILES } from '../lib/sleap-app-profiles/profiles.js?v=e37e05d05839';
import {
    ALL_VIEWS_NAME, createModel, modelViews, modelProblems, modelRunLabel, trainingRunName, uniqueRunParts,
} from '../pose/training-models.js?v=e37e05d05839';
import { openTrainingModelsModal, trainingModelsModal } from './training-models-modal.js?v=e37e05d05839';
import { idModelProblem, interpolationProblem, isIdModelType, isBoxModelType } from '../pose/training-data.js?v=e37e05d05839';
import { recommendPipeline, skeletonCompatibility, arborescenceProblems, arborescenceMessage } from '../pose/training-recommend.js?v=e37e05d05839';
import { countUserLabels, collectGroupLabels, buildTrainingLabels, trainingSlpBytes } from '../import-export/training-slp.js?v=e37e05d05839';
import { findSkeletonMismatch } from '../import-export/file-io.js?v=e37e05d05839';
import { createBackendPicker } from './connect/backend-picker.js?v=e37e05d05839';
import { createRemoteTraining } from './connect/remote-training.js?v=e37e05d05839';
import { bytesToBase64, payloadCheck, buildTrainSpec, initialRows, rowWithTelemetry, finishRow, rowText } from '../pose/connect/remote-training-plan.js?v=e37e05d05839';
import { configureConnect } from '../pose/connect/store.js?v=e37e05d05839';
import { formatRunTimestamp, formatDuration } from '../pose/connect/timestamp.js?v=e37e05d05839';
import { plateauSettings } from '../pose/training-metrics.js?v=e37e05d05839';
import { openTrainingMonitor, trainingMonitor } from './training-monitor.js?v=e37e05d05839';
import { rowWithLocalProgress } from '../pose/training-local-progress.js?v=e37e05d05839';
import { POST_TRAINING_TARGETS, POST_TRAINING_DEFAULTS, POST_TRAINING_TARGET_HINT, inferencePipelineFor, trainedModels,
    skeletonChangeProblem, handoffPlan } from '../pose/training-handoff.js?v=e37e05d05839';
import { runTrainedModels, showInferencePanel } from './inference-panel.js?v=e37e05d05839';
import { openTrainingConfigDialog, trainingConfigDialog } from './training-config-dialog.js?v=e37e05d05839';
import { openTrainingMetricsDialog } from './training-metrics-dialog.js?v=e37e05d05839';
import { effectiveCropSize, cropSizeWarnings, nodeVisibility, sizeMatchTarget, configCentroid } from '../pose/training-crop-size.js?v=e37e05d05839';
import { setAnchorCropPreview } from './anchor-crop-preview.js?v=e37e05d05839';
import { drawAllOverlays } from './rendering.js?v=e37e05d05839';

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
const local = { runsRoot: null, existingRuns: 0, videos: new Map(), videoKey: '', resolving: false, token: null,
    trained: [], scanning: false, rescan: false };   // trained: the runs folder's trained runs, newest first (`scanTrainedRuns`)
const dry = { status: 'idle', rows: [], log: [], key: '', error: null };

/**
 * The models of the next run (`pose/training-models.js`), each with its own settings:
 *   {id, name, color, views, auto,                    the model and its camera views
 *    modelType, modelTypeTouched,                     the pipeline (★ auto-picked until the user picks one)
 *    slots,                                           slot -> {name, filename, preset: bool, doc, head, mode, checkpoint…}
 *    hp,                                              slot -> hyperparams (training-args `hyperparamsFromConfig`)
 *    activeTab, anchorPart}
 * The Models modal edits a copy (`structuredClone`) and hands it back on Apply.
 */
let models = [];
/** Settings of the whole run (every model). */
let runCfg = {
    unchecked: new Set(),        // 'sessionIdx:view' left out of training
    post: Object.assign({}, POST_TRAINING_DEFAULTS),   // post-training inference (target, sampleCount, ...)
    inferWith: {},               // view -> model id: whose predictions a view in several models gets after training
};
/** A model's settings, fresh: the default pipeline, its slots filled from the presets (`ensureSlots`). */
function modelSettings() {
    return { modelType: DEFAULT_MODEL_TYPE, modelTypeTouched: false, slots: {}, hp: {}, activeTab: null, anchorPart: null };
}
/** A new model; with `template`, a copy of that model's settings (model type, configs, hyperparameters, anchor). */
function newTrainingModel(list, o, template) {
    const settings = template ? structuredClone({ modelType: template.modelType, modelTypeTouched: template.modelTypeTouched, slots: template.slots,
        hp: template.hp, activeTab: template.activeTab, anchorPart: template.anchorPart }) : modelSettings();
    const m = createModel(list, Object.assign({}, o, { extra: settings }));
    ensureSlots(m);
    return m;
}
/** sleap-app's training: one model, every view (follows views added later). */
function defaultModels() {
    return [newTrainingModel([], { name: ALL_VIEWS_NAME, auto: true })];
}
const run = {
    status: 'idle', error: null, rows: [], log: [], errorTail: [], startedAt: null, endedAt: null,
    modelDirs: [], cancelled: false, stopRequested: false, note: null,
    groups: [], trainedNodes: null,  // the run's models ({id, name, color, views, modelType}) and the skeleton's node names when it started
};
// Post-training inference: status null | 'running' | 'completed' | 'error' | 'skipped'.
const postRun = { status: null, message: null, remote: false };
let postSeq = 0;   // the newest post-training inference; an older one finishing late writes nothing
const analysis = { key: '', at: 0, counts: new Map(), rec: null, idReport: null, nodeNames: [], trackNames: [], frames: [] };
const crop = { cache: new WeakMap(), preview: false, model: null };   // each model's centered-instance crop (by model object); the preview (Models modal)
let elapsedTimer = null;
let form = null;
let monitorIndex = null;          // the row the Training Monitor shows

function isRunning() { return run.status === 'running'; }
function isDone() { return run.status === 'completed' || run.status === 'error'; }
function refresh() {
    if (remote) remote.sync();
    if (form) form.runRefreshers();
    const mm = trainingModelsModal();
    if (mm) mm.refresh();
    const mon = trainingMonitor();
    if (mon && monitorIndex != null) mon.update();
    const dlg = trainingConfigDialog();
    if (dlg) dlg.update();
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

/** The (session, view) pairs holding at least one user label (checked or not). */
function labelledSelections() {
    const out = [];
    for (const s of projectSessions()) {
        for (const view of sessionViews(s.index, s.session)) {
            if (labelCount(s.index, view).frames === 0) continue;
            out.push({ sessionIndex: s.index, session: s.session, cameraName: view, videoFileInfo: videoFileOf(s.index, view) || {} });
        }
    }
    return out;
}

/** The (session, view) pairs that will train: checked (`rc`, the run settings) and holding at least one user label. */
function includedSelections(rc) {
    const un = (rc || runCfg).unchecked;
    return labelledSelections().filter(function (s) { return !un.has(viewKey(s.sessionIndex, s.cameraName)); });
}

function includedViewNames(rc) {
    const out = [];
    for (const sel of includedSelections(rc)) if (out.indexOf(sel.cameraName) === -1) out.push(sel.cameraName);
    return out;
}

/** The models that train in the next run (`list`, default the live ones), each with the views it trains on. */
function runModels(list, rc) {
    const avail = includedViewNames(rc);
    return (list || models).map(function (m) { return { model: m, views: modelViews(m, avail) }; })
        .filter(function (x) { return x.views.length > 0; });
}

/** A run's snapshot of one model, for its rows and the post-training handoff. */
function modelSnapshot(x) {
    return { id: x.model.id, name: x.model.name, color: x.model.color, views: x.views.slice(), modelType: x.model.modelType };
}

/** The labelled frames (`analysis.frames`) one model trains on: its views, checked. */
function modelFrames(m, rc) {
    const un = (rc || runCfg).unchecked;
    const views = modelViews(m, includedViewNames(rc));
    return (analysis.frames || []).filter(function (f) { return views.indexOf(f.view) !== -1 && !un.has(f.key); });
}

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
    analysis.rec = null; analysis.idReport = null; analysis.trackNames = []; analysis.frames = []; analysis.recs = new WeakMap();
    const sk = skeletonOf();
    analysis.nodeNames = sk ? sk.nodes : [];
    // Every labelled view, checked or not: each model reads its own views' frames (`modelFrames`).
    const sels = labelledSelections();
    if (!sels.length) return;
    try {
        const collected = collectGroupLabels(sels);
        const frames = collected.frames.map(function (fr) {
            const sel = sels[fr.sel];
            const vf = sel.videoFileInfo || {};
            return {
                view: sel.cameraName,
                key: viewKey(sel.sessionIndex, sel.cameraName),
                width: Number(vf.videoWidth) || 0,
                height: Number(vf.videoHeight) || 0,
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
        analysis.frames = frames;
        analysis.trackCount = tracks.size;
        analysis.idReport = Array.from(collected.sessions.values());
    } catch (e) {
        console.warn('[training] reading labels failed:', e);
    }
}

function totalLabelledFrames(rc) {
    let n = 0;
    for (const sel of includedSelections(rc)) n += labelCount(sel.sessionIndex, sel.cameraName).frames;
    return n;
}

/** sleap-app's ★ recommendation for one model, from the labelled frames of its views (cached per analysis). */
function modelRecommendation(m, rc) {
    const frames = modelFrames(m, rc);
    if (!frames.length) return null;
    const key = m.id + '|' + analysis.at + '|' + frames.length + '|' + modelViews(m, includedViewNames(rc)).join(',');
    if (!analysis.recs) analysis.recs = new WeakMap();
    const hit = analysis.recs.get(m);
    if (hit && hit.key === key) return hit.rec;
    const sk = skeletonOf();
    let rec = null;
    try { rec = recommendPipeline({ frames: frames, numEdges: sk ? sk.edges.length : 0, trackCount: analysis.trackCount || 0 }); } catch (e) { rec = null; }
    analysis.recs.set(m, { key: key, rec: rec });
    return rec;
}

/** sleap-app auto-selects the recommended type for a model whose type the user has not picked. */
function autoModelType(m, rc) {
    if (m.modelTypeTouched || isRunning()) return;
    const rec = modelRecommendation(m, rc);
    if (!rec || rec.recommended === m.modelType) return;
    if (skeletonCompatibility(skeletonOf()).disabledTypes.has(rec.recommended)) return;
    replacePipeline(m, rec.recommended);
}

/** Change a model's pipeline: a preset of the old one does not fit, so its slots restart from their presets. The
 *  validation fraction (a Run setting, one for every model) is kept. */
function replacePipeline(m, t) {
    const vf = runValidationFraction(m);
    m.modelType = t;
    for (const slot of Object.keys(m.slots)) if (m.slots[slot].preset) { delete m.slots[slot]; delete m.hp[slot]; }
    ensureSlots(m);
    if (vf != null) for (const s of Object.keys(m.hp)) m.hp[s].validationFraction = vf;
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

/**
 * Load a config into a slot, from a preset, a file the user picked or a trained run (`extra`: `{trainedPath,
 * checkpoint}`, the run folder and its checkpoint). The training mode is read from the config (sleap-app: a
 * config naming a checkpoint is a Resume / Fine-tune of it); a trained run's own checkpoint is the one offered.
 */
function setSlotConfig(m, slot, text, name, filename, preset, extra) {
    let doc;
    try { doc = YAML.parse(text); } catch (e) { run.note = 'Could not read ' + (filename || 'the config') + ': ' + e.message; refresh(); return false; }
    if (!doc || typeof doc !== 'object') { run.note = (filename || 'The config') + ' is not a training config.'; refresh(); return false; }
    // `text`: what Reset to profile defaults goes back to (the preset, or the file as it was read).
    const tm = detectTrainingMode(doc);
    const ex = extra || {};
    m.slots[slot] = { name: name, filename: filename, preset: !!preset, doc: doc, head: detectHeadType(doc), text: text,
        extra: extra || null, trainedPath: ex.trainedPath || null, mode: tm.mode, checkpoint: ex.checkpoint || tm.checkpoint, checkpointNote: null,
        // 'local' (a folder on this computer), 'worker' (typed for a worker) or 'config' (named by the config itself).
        checkpointWhere: ex.checkpoint ? 'local' : 'config' };
    m.hp[slot] = hyperparamsFromConfig(doc);
    if ((slot === 'centered_instance' || slot === 'config') && m.hp[slot].anchorPart != null && m.anchorPart == null) m.anchorPart = m.hp[slot].anchorPart;
    // The run's validation split is one setting for every model (Run settings): a new config keeps it.
    const vf = runValidationFraction(m);
    if (vf != null) m.hp[slot].validationFraction = vf;
    run.note = null;
    return true;
}

/** The validation fraction a model's other slots hold (null when it has none yet). */
function runValidationFraction(m, skip) {
    for (const s of Object.keys(m.hp)) if (s !== skip && m.hp[s] && m.hp[s].validationFraction != null) return m.hp[s].validationFraction;
    return null;
}

/** Make sure every slot of the model type holds a config of the right head (the Medium RF preset by default). */
function ensureSlots(m) {
    if (!YAML) return;
    const slots = getConfigSlots(m.modelType);
    for (const slot of Object.keys(m.slots)) if (slots.indexOf(slot) === -1) { delete m.slots[slot]; delete m.hp[slot]; }
    for (const slot of slots) {
        const want = slotToHeadType(m.modelType, slot);
        const cur = m.slots[slot];
        if (cur && (cur.head === want || !cur.preset)) continue;
        const p = defaultProfile(m.modelType, slot);
        if (p) setSlotConfig(m, slot, p.content, p.label, p.filename, true);
    }
    if (slots.indexOf(m.activeTab) === -1) m.activeTab = slots[0];
}

function setModelType(m, t) {
    if (t === m.modelType) return;
    m.modelTypeTouched = true;
    replacePipeline(m, t);
}

function slotOptions(m, slot) {
    const head = slotToHeadType(m.modelType, slot);
    const opts = profilesForHead(head).map(function (p) { return ['preset:' + p.filename, p.label]; });
    // sleap-app: every trained run of this head in the runs folder, newest first (this computer's runs: local only).
    if (!isRemoteRun()) trainedRunsFor(head).forEach(function (r) { opts.push(['trained:' + r.path, '[Trained] ' + (r.runName || r.name) + ' (training_config.yaml)']); });
    const cur = m.slots[slot];
    const listed = !!cur && !!cur.trainedPath && !isRemoteRun() && trainedRunsFor(cur.head).some(function (r) { return r.path === cur.trainedPath; });
    if (cur && !cur.preset && !listed) opts.push(['file:' + cur.filename, cur.trainedPath ? cur.name : cur.filename]);
    opts.push(['__browse__', 'Browse for config file...']);
    return opts;
}

function slotValue(m, slot) {
    const cur = m.slots[slot];
    if (!cur) return '';
    if (cur.trainedPath && !isRemoteRun() && trainedRunsFor(cur.head).some(function (r) { return r.path === cur.trainedPath; })) return 'trained:' + cur.trainedPath;
    return cur.preset ? 'preset:' + cur.filename : 'file:' + cur.filename;
}

/** The runs folder's trained runs of one head. */
function trainedRunsFor(head) { return local.trained.filter(function (r) { return r.head === head; }); }

/**
 * sleap-app `findTrainedModels` on the local runs folder (one level deep): folders with a
 * `training_config.yaml` and a checkpoint, newest first. Read-only: the runs folder is a model grant.
 */
async function scanTrainedRuns() {
    if (!fsApi || !local.runsRoot || !YAML) return;
    // One scan at a time; a call during one (another folder, a run that just ended) scans again after it.
    if (local.scanning) { local.rescan = true; return; }
    local.scanning = true;
    local.rescan = false;
    const root = local.runsRoot;
    const out = [];
    try {
        const dirs = (await fsApi.listDir(root)).filter(function (e) { return e.kind === 'directory'; }).slice(0, 500);
        for (const d of dirs) {
            const path = joinRunDir(root, d.name);
            let entries;
            try { entries = await fsApi.listDir(path); } catch (e) { continue; }
            const names = entries.filter(function (e) { return e.kind === 'file'; }).map(function (e) { return e.name; });
            const ckpt = pickCheckpointFile(names, 'resume');
            if (names.indexOf('training_config.yaml') === -1 || !ckpt) continue;
            let doc;
            try { doc = YAML.parse(new TextDecoder().decode(await fsApi.readFile(joinRunDir(path, 'training_config.yaml')))); } catch (e) { continue; }
            const head = detectHeadType(doc);
            if (!head) continue;
            const t = doc && doc.trainer_config;
            out.push({ path: path, name: d.name, head: head, runName: t && typeof t.run_name === 'string' ? t.run_name : null,
                checkpoint: joinRunDir(path, ckpt), mtimeMs: Number(d.mtimeMs) || 0 });
        }
    } catch (e) {
        /* an unreadable runs folder lists nothing */
    } finally {
        local.scanning = false;
    }
    if (local.runsRoot === root) {
        out.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });
        local.trained = out;
        refresh();
    }
    if (local.rescan || local.runsRoot !== root) scanTrainedRuns();
}

/** Load a trained run's config into a slot, offering its checkpoint for Fine-tune / Resume (sleap-app `handleSelectRun`). */
async function selectTrainedRun(m, slot, path) {
    const r = local.trained.find(function (x) { return x.path === path; });
    if (!r) return;
    try {
        const text = new TextDecoder().decode(await fsApi.readFile(joinRunDir(r.path, 'training_config.yaml')));
        setSlotConfig(m, slot, text, '[Trained] ' + (r.runName || r.name), 'training_config.yaml', false, { trainedPath: r.path, checkpoint: r.checkpoint });
    } catch (e) {
        run.note = 'Could not read ' + r.name + '/training_config.yaml: ' + ((e && e.message) || e);
    }
    refresh();
}

function browseConfig(m, slot) {
    const input = el('input');
    input.type = 'file';
    input.accept = '.yaml,.yml';
    input.addEventListener('change', function () {
        const f = input.files && input.files[0];
        if (f) readConfigFile(m, slot, f);
    });
    input.click();
}

function readConfigFile(m, slot, file) {
    if (!/\.ya?ml$/i.test(file.name)) { run.note = file.name + ' is not a YAML config.'; refresh(); return; }
    file.text().then(function (text) {
        if (setSlotConfig(m, slot, text, file.name, file.name, false)) refresh();
    }, function (e) { run.note = 'Could not read ' + file.name + ': ' + e.message; refresh(); });
}

/** A slot's fields as `applyPanelSettings` takes them (Top-Down: the model's one Anchor Part). */
function effectiveHp(m, slot) {
    const hp = Object.assign({}, m.hp[slot]);
    if (m.modelType === 'top_down' || m.modelType === 'top_down_id') hp.anchorPart = m.anchorPart || null;
    return hp;
}

// ---------------------------------------------------------------------------
// The centered-instance crop (sleap-app AnchorPartField's crop preview, ModelStatsPreview's "Crop Size", cropWarnings)
// ---------------------------------------------------------------------------

function cropsAround(m) { return !!m && (m.modelType === 'top_down' || m.modelType === 'top_down_id'); }

/**
 * The crop a model's centered-instance head trains on: the config's Crop Size, or what sleap-nn computes for Auto
 * from that model's own labels (`pose/training-crop-size.js`). Null outside Top-Down or without the config.
 * @returns {{cropSize: number, low: number, auto: boolean, maxBboxDim: number, warnings: string[],
 *            byView: Object<string, {cropSize: number, target: {height: number|null, width: number|null}}>}|null}
 */
function cropInfo(m, rc) {
    if (!cropsAround(m) || !m.slots.centered_instance || !m.slots.centered_instance.doc) return null;
    const doc = applyPanelSettings(m.slots.centered_instance.doc, effectiveHp(m, 'centered_instance'));
    const frames = modelFrames(m, rc);
    const views = modelViews(m, includedViewNames(rc));
    const key = [analysis.key, analysis.at, m.anchorPart || '', views.join(','), frames.length,
        JSON.stringify(doc.data_config), JSON.stringify(doc.model_config && doc.model_config.backbone_config)].join('|');
    const hit = crop.cache.get(m);
    if (hit && hit.key === key) return hit.info;
    const names = analysis.nodeNames || [];
    const ai = m.anchorPart ? names.indexOf(m.anchorPart) : -1;
    const c = Object.assign(effectiveCropSize(doc, frames, ai >= 0 ? ai : null), { views: views, target: sizeMatchTarget(doc, frames) });
    let info = null;
    if (c.cropSize != null) {
        const scale = Number(doc.data_config && doc.data_config.preprocessing && doc.data_config.preprocessing.scale) || 1;
        const byView = {};
        const centroid = configCentroid(doc);
        views.forEach(function (v) { byView[v] = { cropSize: c.cropSize, target: c.target, centroid: centroid }; });
        info = { cropSize: c.cropSize, low: c.cropSize, auto: c.auto, maxBboxDim: c.maxBboxDim, warnings: cropSizeWarnings(c, scale), byView: byView };
    }
    crop.cache.set(m, { key: key, info: info });
    return info;
}

/** "752 px (Auto)", "512 px". */
function cropText(info, m, rc) {
    if (!info) return m && modelFrames(m, rc).length ? '—' : 'Label an animal to size it.';
    return info.cropSize.toLocaleString('en-US') + ' px' + (info.auto ? ' (Auto)' : '');
}

/**
 * Keep the on-canvas preview in step with the crop and the anchor (sleap-app: while its toggle is on): the crop of the
 * model the Models modal shows (`crop.model`), on that model's views, while the modal is open.
 */
function syncCropPreview() {
    const m = crop.model;
    const mm = trainingModelsModal();
    const info = crop.preview && mm && m && cropsAround(m) ? cropInfo(m, mm.runCfg()) : null;
    const changed = setAnchorCropPreview(info ? { anchor: m.anchorPart || null, byView: info.byView, isShown: function () { return !!trainingModelsModal(); } } : null);
    if (changed && state.session) { try { drawAllOverlays(state.currentFrame); } catch (e) { console.warn('[training] crop preview redraw failed:', e); } }
}

/** The finished YAML of a model's slot for one run. */
function configText(m, slot, runName) {
    return YAML.stringify(sentConfig(m, slot, runName));
}

/** The config a worker gets (and Save writes): the model's fields, LUC3D's finishing, the training mode. */
function sentConfig(m, slot, runName) {
    const c = m.slots[slot];
    return applyTrainingMode(finalizeConfig(applyPanelSettings(c.doc, effectiveHp(m, slot)), runName ? { runName: runName } : {}), c.mode, c.checkpoint);
}

/**
 * `checkpointProblem`, plus where the checkpoint is: a folder picked on this computer cannot go to a worker, and a
 * path typed for a worker means nothing here (Rust would refuse it anyway).
 */
function slotCheckpointProblem(c) {
    if (c.mode === 'scratch') return null;
    const p = checkpointProblem(c.mode, c.checkpoint);
    if (p) return p;
    if (isRemoteRun() && c.checkpointWhere === 'local') return 'that checkpoint is on this computer: type its path on the worker';
    if (!isRemoteRun() && c.checkpointWhere === 'worker') return 'that checkpoint path is on the worker: Choose… the model folder on this computer';
    return null;
}

/** A local model's start (Rust checks the checkpoint is inside a model grant and writes the keys). */
function initOf(m, slot) {
    const c = m.slots[slot];
    return c && c.mode !== 'scratch' && c.checkpoint ? { mode: c.mode, checkpoint: c.checkpoint } : undefined;
}

function baseName(p) { return String(p).split(/[\\/]/).pop(); }

/**
 * Fine-tune / Resume locally: the user picks a trained model's FOLDER (a read-only model grant, like an
 * inference model), and its checkpoint is taken from it (sleap-app `pickCheckpointFile`). A head that does
 * not match the slot's is said (sleap-app warns, it does not block).
 */
async function chooseCheckpoint(m, slot) {
    const c = m.slots[slot];
    if (!c || !sn) return;
    let dir;
    try { dir = await sn.pickModelDirectory('Select the trained model to start from'); } catch (e) { c.checkpointNote = plainError(e); refresh(); return; }
    if (!dir) return;
    try {
        const names = (await fsApi.listDir(dir)).filter(function (e) { return e.kind === 'file'; }).map(function (e) { return e.name; });
        const f = pickCheckpointFile(names, c.mode);
        if (!f) { c.checkpointNote = 'No ' + (c.mode === 'finetune' ? '.ckpt or .h5' : '.ckpt') + ' file in ' + dir + '.'; refresh(); return; }
        c.checkpoint = joinRunDir(dir, f);
        c.checkpointWhere = 'local';
        c.checkpointNote = null;
        if (names.indexOf('training_config.yaml') !== -1) {
            const head = detectHeadType(YAML.parse(new TextDecoder().decode(await fsApi.readFile(joinRunDir(dir, 'training_config.yaml')))));
            if (head && head !== c.head) c.checkpointNote = 'Possible checkpoint head mismatch: it was trained for "' + head + '" and may not be compatible with this ' + c.head + ' head.';
        }
    } catch (e) {
        c.checkpointNote = plainError(e);
    }
    refresh();
}

/**
 * sleap-app's Full Configuration... (`ui/training-config-dialog.js`) for one model. It edits the configs themselves,
 * so the model's fields are written into them first and re-read from them after each edit: both always agree.
 */
function openFullConfig(m, initialTab, rc) {
    if (!YAML || isRunning() || !m) return;
    const slots = getConfigSlots(m.modelType).filter(function (s) { return !!m.slots[s]; });
    if (!slots.length) return;
    slots.forEach(function (s) { m.slots[s].doc = applyPanelSettings(m.slots[s].doc, effectiveHp(m, s)); });
    openTrainingConfigDialog({
        slots: function () { return slots.filter(function (s) { return !!m.slots[s]; }).map(function (s) { return { slot: s, label: getSlotLabel(s).replace(' Config', '') }; }); },
        doc: function (s) { return m.slots[s] ? m.slots[s].doc : null; },
        changed: function (s) {
            const keep = m.hp[s] ? m.hp[s].anchorPart : null;
            m.hp[s] = Object.assign(hyperparamsFromConfig(m.slots[s].doc), { anchorPart: keep });
            refresh();
        },
        reset: function (which) {
            (which || slots).forEach(function (s) { const c = m.slots[s]; if (c && c.text) setSlotConfig(m, s, c.text, c.name, c.filename, c.preset, c.extra); });
            refresh();
        },
        yamlOf: function (s) { return YAML.stringify(sentConfig(m, s, null)); },
        mode: function (s) {
            const c = m.slots[s];
            return c ? { mode: c.mode, checkpoint: c.checkpoint, note: c.checkpointNote, problem: slotCheckpointProblem(c), local: !isRemoteRun() } : null;
        },
        setMode: function (s, mode) { const c = m.slots[s]; if (c) { c.mode = mode; c.checkpointNote = null; } refresh(); },
        setCheckpoint: function (s, p) { const c = m.slots[s]; if (c) { c.checkpoint = p || null; c.checkpointWhere = 'worker'; c.checkpointNote = null; } refresh(); },
        chooseCheckpoint: function (s) { return chooseCheckpoint(m, s); },
        fileNameOf: function (s) { return (m.slots[s].head || s) + '.yaml'; },
        isBusy: function () { return isRunning() || dry.status === 'running'; },
        cropInfo: function (s) { return s === 'centered_instance' ? cropInfo(m, rc) : null; },
        initialTab: initialTab,
        title: models.length > 1 || (trainingModelsModal() && trainingModelsModal().modelCount() > 1) ? m.name : null,
    });
}

// ---------------------------------------------------------------------------
// Can it start?
// ---------------------------------------------------------------------------

/** What stops a model's pipeline from training on this project, or null. */
function pipelineProblem(m, rc) {
    if (isBoxModelType(m.modelType)) return 'Box Detector types need box labels, which LUCID does not have.';
    const sk = skeletonOf();
    if (m.modelType === 'bottom_up' && sk) {
        const p = arborescenceProblems(sk);
        if (p) return arborescenceMessage(p);
    }
    if (isIdModelType(m.modelType) && analysis.idReport) {
        const p = idModelProblem(analysis.idReport, { views: Math.max(1, modelViews(m, includedViewNames(rc)).length) });
        if (p) return p;
    }
    return projectProblem(rc);
}

/** What stops any model from training on this project (names that sleap-nn would interpolate, mixed skeletons), or null. */
function projectProblem(rc) {
    const interp = interpolationProblem([{ kind: 'node', names: analysis.nodeNames }, { kind: 'identity / track', names: analysis.trackNames }]);
    if (interp) return interp;
    const sels = includedSelections(rc);
    if (sels.length > 1) {
        const bySession = [];
        const seen = new Set();
        for (const s of sels) if (!seen.has(s.session)) { seen.add(s.session); bySession.push(s); }
        const mm = findSkeletonMismatch(bySession);
        if (mm) return mm + '. Uncheck that session’s views to train without it (Edit models… ▸ Run settings).';
    }
    return null;
}

function hasAllConfigs(m) {
    return getConfigSlots(m.modelType).every(function (s) { return !!m.slots[s]; });
}

/** The (session, view) pairs some model trains on. */
function trainedSelections(rc, list) {
    const used = [];
    runModels(list, rc).forEach(function (x) { x.views.forEach(function (v) { if (used.indexOf(v) === -1) used.push(v); }); });
    return includedSelections(rc).filter(function (s) { return used.indexOf(s.cameraName) !== -1; });
}

/** Views that train but are not on the worker yet. */
function unplacedViews() {
    if (!remote || !remote.connected()) return [];
    return trainedSelections().filter(function (s) { return !remote.workerVideo(s.sessionIndex, s.cameraName); });
}

/** Why the models cannot start, as one line, or '' (the panel's Start button and the Models modal's footer). */
function whyNotStart() {
    if (isRunning()) return '';
    if (!YAML) return 'Loading presets…';
    if (!projectSessions().length) return 'Open a session first.';
    if (totalLabelledFrames() === 0) return 'Label at least one frame before training';
    if (!models.length) return 'Add a model to train (Edit models…).';
    const probs = modelProblems(models, includedViewNames());
    if (probs.empty.length) return '“' + probs.empty[0].name + '” has no labelled view to train on (Edit models…).';
    for (const m of models) {
        const named = models.length > 1 ? m.name + ': ' : '';
        if (pipelineProblem(m)) return named + 'fix the problem under Model Type to start (Edit models…).';
        if (!hasAllConfigs(m)) return named + 'upload config file(s) to begin (Edit models…).';
        for (const sl of getConfigSlots(m.modelType)) {
            const c = m.slots[sl];
            const cp = c && slotCheckpointProblem(c);
            if (cp) return named + getSlotLabel(sl).replace(' Config', '') + ': ' + cp + ' (Full Configuration).';
        }
    }
    if (isRemoteRun()) {
        const w = remote ? remote.whyNot() : 'Select a worker';
        if (w) return w;
        if (unplacedViews().length) return 'Locate each view’s video on the worker (Edit models… ▸ Run settings).';
        if (!remote.outputDir()) return 'Choose an output folder on the worker (Edit models… ▸ Run settings).';
    } else {
        if (!env.checked) return 'Checking for sleap-nn…';
        if (!sleapNnAvailable()) return 'sleap-nn was not found on this machine (Remote: pick a worker instead).';
        if (!local.runsRoot) return 'Choose a runs folder (Edit models… ▸ Run settings).';
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
    // Every labelled view, checked or not: the Models modal can check a view before Apply.
    const sels = labelledSelections();
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
function missingLocalVideos() { return trainedSelections().filter(function (s) { return !localVideo(s.sessionIndex, s.cameraName); }); }

async function chooseRunsFolder() {
    if (!sn || !sn.training) return;
    try {
        const r = await sn.training.pickRunsDirectory('Choose the folder trained models go to');
        if (r && r.path) {
            local.runsRoot = r.path;
            local.existingRuns = r.existingRuns || 0;
            try { localStorage.setItem('trainingRunsFolder', r.path); } catch (e) { /* best effort */ }
            run.note = null;
            local.trained = [];
            scanTrainedRuns();
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

/** One model's selections (`x`: a `runModels` entry), with each video named by its worker path. */
function modelSelections(x) {
    return includedSelections().filter(function (s) { return x.views.indexOf(s.cameraName) !== -1; })
        .map(function (s) { return Object.assign({}, s, { videoFilename: remote.workerVideo(s.sessionIndex, s.cameraName) }); });
}

function startTraining() {
    if (whyNotStart()) return;
    if (isRemoteRun()) startRemoteTraining(); else startLocalTraining(false);
}

/** The progress-row plan of one model's heads (`x`: a `runModels` entry; `multi`: the run trains several models). */
function headRows(x, slots, runNames, multi) {
    const m = x.model;
    return slots.map(function (s, i) {
        const h = m.slots[s].head;
        const pl = plateauSettings(m.slots[s].doc);
        return { head: h, label: modelRunLabel(headLabel(h), m, multi), maxEpochs: m.hp[s].maxEpochs, runName: runNames[i],
            plateauPatience: pl.patience, plateauMinDelta: pl.minDelta };
    });
}

/** The finished config (an object) of a model's slot for one run name. */
function configObject(m, slot, runName) {
    return finalizeConfig(applyPanelSettings(m.slots[slot].doc, effectiveHp(m, slot)), { runName: runName });
}

/**
 * Plan a local run: per model, the training and validation files of its views (split by moment, videos
 * named by their disk paths), each video's disk path in table order, and each head's config.
 */
async function planLocal(stamp, dryRun) {
    const plans = [];
    const xs = runModels();
    const multi = xs.length > 1;
    const parts = uniqueRunParts(xs.map(function (x) { return x.model; }));
    for (const x of xs) {
        const m = x.model;
        const slots = getConfigSlots(m.modelType);
        const sels = includedSelections().filter(function (s) { return x.views.indexOf(s.cameraName) !== -1; })
            // The file names each video by its disk path (what a reader of the file expects); Rust still
            // passes the same grant-checked paths as --video-paths, which is what sleap-nn uses.
            .map(function (s) { return Object.assign({}, s, { videoFilename: localVideo(s.sessionIndex, s.cameraName) }); });
        const hp0 = m.hp[slots[0]];
        const built = buildTrainingLabels(sels, { split: { fraction: hp0.validationFraction, seed: hp0.seed == null ? 0 : hp0.seed } });
        const train = await trainingSlpBytes(built.train);
        const val = built.split.sameAsTrain ? null : await trainingSlpBytes(built.val);
        const runNames = slots.map(function (s) {
            return trainingRunName({ timestamp: stamp, head: m.slots[s].head, model: { name: parts.get(m.id) }, multi: multi, nFrames: built.stats.frames }) + (dryRun ? '.dryrun' : '');
        });
        plans.push({
            group: modelSnapshot(x), stats: built.stats, split: built.split,
            args: {
                runsRoot: local.runsRoot,
                models: slots.map(function (s, i) { return { config: configObject(m, s, runNames[i]), runName: runNames[i], init: initOf(m, s) }; }),
                trainSlp: bytesToBase64(train),
                valSlp: val ? bytesToBase64(val) : null,
                videoPaths: sels.map(function (s) { return localVideo(s.sessionIndex, s.cameraName); }),
            },
            models: headRows(x, slots, runNames, multi),
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
    run.groups = runModels().map(modelSnapshot); run.trainedNodes = currentNodeNames(); postRun.status = null; postRun.message = null; postSeq++;
    run.remote = isRemoteRun(); run.post = Object.assign({}, runCfg.post); run.inferWith = Object.assign({}, runCfg.inferWith);
    dry.status = 'idle'; dry.rows = []; dry.log = []; dry.error = null;   // sleap-app: a Start clears the dry run's result
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
    if (run.status === 'completed') {
        scanTrainedRuns();   // the new runs become [Trained] entries
        await postTrainingInference(false);
    }
}

function joinRunDir(root, name) {
    const sep = String(root).indexOf('\\') !== -1 && String(root).indexOf('/') === -1 ? '\\' : '/';
    return String(root).replace(/[\\/]+$/, '') + sep + name;
}

/** The config + data a dry run checked, to say when it no longer matches. */
function dryRunKey() {
    return JSON.stringify([runModels().map(function (x) {
        const m = x.model;
        return [m.id, m.name, x.views, m.modelType, getConfigSlots(m.modelType).map(function (s) { return [slotValue(m, s), m.hp[s]]; }), m.anchorPart];
    }), includedSelections().map(function (s) { return viewKey(s.sessionIndex, s.cameraName); }), local.runsRoot]);
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
    const xs = runModels();
    const multi = xs.length > 1;
    const parts = uniqueRunParts(xs.map(function (x) { return x.model; }));
    const stamp = formatRunTimestamp();
    run.status = 'running'; run.error = null; run.log = []; run.errorTail = []; run.modelDirs = [];
    run.groups = xs.map(modelSnapshot); run.trainedNodes = currentNodeNames(); postRun.status = null; postRun.message = null; postSeq++;
    run.remote = isRemoteRun(); run.post = Object.assign({}, runCfg.post); run.inferWith = Object.assign({}, runCfg.inferWith);
    dry.status = 'idle'; dry.rows = []; dry.log = []; dry.error = null;   // sleap-app: a Start clears the dry run's result
    run.cancelled = false; run.stopRequested = false; run.startedAt = Date.now(); run.endedAt = null; run.note = null;
    // Plan every model first (data + configs), so nothing is sent if one of them cannot be built.
    const plans = [];
    try {
        for (const x of xs) {
            const m = x.model;
            const slots = getConfigSlots(m.modelType);
            const sels = modelSelections(x);
            const built = buildTrainingLabels(sels, { split: { overfit: true } });
            const bytes = await trainingSlpBytes(built.train);
            const check = payloadCheck(bytes.byteLength);
            if (check.level === 'refuse') throw new Error(check.message + ' Train fewer views per model (Edit models…).');
            if (check.level === 'warn' && !(await askConfirm(check.message + ' Send it?', { okLabel: 'Send' }))) {
                throw new Error('Not sent.');
            }
            const heads = slots.map(function (s) { return m.slots[s].head; });
            const runNames = heads.map(function (h) {
                return trainingRunName({ timestamp: stamp, head: h, model: { name: parts.get(m.id) }, multi: multi, nFrames: built.stats.frames });
            });
            const configs = slots.map(function (s, i) { return configText(m, s, runNames[i]); });
            const spec = buildTrainSpec({
                configs: configs, modelTypes: heads, labelsContent: bytesToBase64(bytes),
                project: remote.tag(), outputDir: remote.outputDir(),
            });
            plans.push({ group: modelSnapshot(x), spec: spec, stats: built.stats, models: headRows(x, slots, runNames, multi) });
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
    if (run.status === 'completed') await postTrainingInference(true);
}

/** The project skeleton's node names (one skeleton is shared by every session). */
function currentNodeNames() { const sk = skeletonOf(); return sk ? sk.nodes.slice() : []; }

function postTargetLabel(v) {
    const o = POST_TRAINING_TARGETS.find(function (x) { return x[0] === v; });
    return o ? o[1] : v;
}

/**
 * sleap-app's post-training inference: once every model trained, the Inference panel runs them on the
 * current session (`runTrainedModels`) with this panel's target and options. The Inference panel shows
 * the run (progress, log, Cancel, Fetch & Load); the status box here says how it went.
 */
async function postTrainingInference(remoteRun) {
    const p = run.post || runCfg.post;
    if (p.target === 'nothing') return;
    const seq = ++postSeq;
    postRun.remote = remoteRun;
    const tm = trainedModels(run.rows, run.groups);
    const plan = handoffPlan(tm.models, run.groups, run.inferWith || {});
    const skip = function (msg) {
        postRun.status = 'skipped'; postRun.message = msg;
        appendLog('\u2014 Post-training inference skipped: ' + msg);
        refresh();
    };
    if (!tm.models.length) return skip('no trained model reported its folder.');
    const sk = skeletonChangeProblem(run.trainedNodes, currentNodeNames());
    if (sk) return skip(sk);
    postRun.status = 'running'; postRun.message = null;
    appendLog('\u2014 Running inference (' + postTargetLabel(p.target) + ') with models: ' +
        plan.models.map(function (m) { return m.paths.join(' + ') + ' on ' + m.views.join(', '); }).join('; ') + '...');
    refresh();
    let r;
    try {
        r = await runTrainedModels({
            remote: remoteRun, pipeline: inferencePipelineFor(plan.modelType), models: plan.models, frameRange: p.target,
            sampleCount: p.sampleCount, excludeUserLabeled: p.skipUserLabeled, existingPredictions: p.existingPredictions,
        });
    } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
    }
    if (seq !== postSeq) return;   // a new run started meanwhile; the Inference panel still shows this one
    const left = (tm.incomplete.length ? ' No model folder for: ' + tm.incomplete.join(', ') + '.' : '') +
        (plan.skipped.length ? ' Not run (another model type; run it from the Inference panel): ' + plan.skipped.join(', ') + '.' : '');
    if (r.ok) {
        postRun.status = 'completed';
        postRun.message = (remoteRun ? 'Use Fetch & Load in the Inference panel once its jobs finish.' : '') + left || null;
        appendLog(remoteRun ? '\u2014 Inference submitted to the worker. Use Fetch & Load in the Inference panel.' : '\u2014 Predictions merged into project.');
    } else if (r.status === 'cancelled') {
        postRun.status = 'skipped'; postRun.message = 'Post-training inference cancelled.';
        appendLog('\u2014 Post-training inference cancelled.');
    } else if (r.skipped) {
        postRun.status = 'skipped'; postRun.message = (r.error || '') + left || null;
        appendLog('\u2014 Post-training inference skipped: ' + (r.error || ''));
    } else {
        postRun.status = 'error'; postRun.message = (r.error || 'Inference failed.') + left;
        appendLog('\u2014 Post-training inference failed: ' + (r.error || 'Inference failed.'));
    }
    refresh();
}

/**
 * View Metrics (`ui/training-metrics-dialog.js`): this run's models, then (locally) every trained run in the
 * runs folder. Files are read where the run went: the desktop's runs folder, or the worker over Connect.
 */
function openMetrics() {
    const rem = !!run.remote;
    const dirs = run.modelDirs.slice();
    if (!rem) local.trained.forEach(function (r) { if (dirs.indexOf(r.path) === -1) dirs.push(r.path); });
    const io = rem ? { exists: remote.workerFiles.exists, readText: remote.workerFiles.readText, parseYaml: function (t) { return YAML.parse(t); } } : {
        exists: function (p) { return fsApi.stat(p).then(function (st) { return !!(st && st.exists && st.isFile); }, function () { return false; }); },
        readText: async function (p) { return new TextDecoder().decode(await fsApi.readFile(p)); },
        parseYaml: function (t) { return YAML.parse(t); },
    };
    openTrainingMetricsDialog({
        runDirs: dirs, io: io,
        addModels: rem || !sn ? null : async function () { const d = await sn.pickModelDirectory('Add Trained Model(s)'); return d ? [d] : []; },
    });
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
    run.groups = []; run.trainedNodes = null;
    if (postRun.status !== 'running') { postRun.status = null; postRun.message = null; }
    if (!keepConfig) {
        models = defaultModels();
        runCfg = { unchecked: new Set(), post: Object.assign({}, POST_TRAINING_DEFAULTS), inferWith: {} };
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

// ---------------------------------------------------------------------------
// The Models modal's settings (`ui/training-models-modal.js`): one model's, and the run's
// ---------------------------------------------------------------------------

function modelTypeLabel(t) {
    const o = MODEL_TYPE_OPTIONS.find(function (x) { return x.value === t; });
    return o ? o.label : String(t || '');
}

/** "Medium RF" from "Preset: Centroid (Medium RF)"; a file's or trained run's own name otherwise. */
function slotShortName(c) {
    if (!c) return '?';
    const m = /^Preset: .*\((.+)\)$/.exec(c.name || '');
    return m ? m[1] : (c.name || c.filename || '?');
}

/** One line of a model's settings: its frames, configs, anchor, crop and epochs (the panel's cards and the modal's). */
function modelMeta(m, rc) {
    const frames = modelFrames(m, rc).length;
    const slots = getConfigSlots(m.modelType).filter(function (s) { return !!m.slots[s]; });
    const parts = [frames.toLocaleString('en-US') + ' labelled frame' + (frames === 1 ? '' : 's')];
    if (slots.length) parts.push(slots.map(function (s) { return slotShortName(m.slots[s]); }).join(' / '));
    if (cropsAround(m)) {
        if (m.anchorPart) parts.push(m.anchorPart);
        const info = cropInfo(m, rc);
        if (info) parts.push('crop ' + cropText(info, m, rc));
    }
    const epochs = [];
    slots.forEach(function (s) { const e = m.hp[s] && m.hp[s].maxEpochs; if (e != null && epochs.indexOf(e) === -1) epochs.push(e); });
    if (epochs.length) parts.push(epochs.join(' / ') + ' epochs');
    return parts.join(' · ');
}

/**
 * One model's settings, in the Models modal's side panel (sleap-app's Model Type & Configs and Hyperparameters
 * sections): `dm()` is the model shown (the modal's working copy), `rc()` the run settings edited with it.
 */
function buildModelSettings(box, f, dm, rc) {
    const sec = f.section(box, 'Model Type & Configs', true);
    f.selectField(sec, null, null, function () {
        const m = dm();
        if (!m) return [];
        const sk = skeletonOf();
        const compat = skeletonCompatibility(sk);
        const r = modelRecommendation(m, rc());
        const recType = r ? r.recommended : null;
        return MODEL_TYPE_OPTIONS.map(function (o) {
            const boxType = isBoxModelType(o.value);
            const edges = compat.disabledTypes.has(o.value);
            return [o.value, o.label + (boxType ? ' (needs box labels)' : edges ? ' (requires edges)' : '') +
                (recType === o.value && !boxType && !edges ? ' ★' : '') + (compat.warnings.has(o.value) ? ' ⚠' : ''), boxType || edges];
        });
    }, function () { const m = dm(); return m ? m.modelType : ''; }, function (v) { const m = dm(); if (m) setModelType(m, v); }, { id: 'trnModelType' });
    // The label sits above the select (sleap-app), with the long ⓘ.
    sec.insertBefore(f.fieldLabel('Model Type', MODEL_TYPE_HINT), sec.firstChild);
    const rec = el('p', 'trn-rec');
    rec.id = 'trnRecommendation';
    sec.appendChild(rec);
    const warnLine = el('p', 'trn-warnline');
    sec.appendChild(warnLine);
    const problem = el('p', 'inf-error-text');
    problem.id = 'trnPipelineProblem';
    sec.appendChild(problem);
    f.onRefresh(function () {
        const m = dm();
        if (!m) return;
        const r = modelRecommendation(m, rc());
        const compat = skeletonCompatibility(skeletonOf());
        rec.hidden = !r || compat.disabledTypes.has(m.modelType);
        if (r) {
            rec.innerHTML = '';
            rec.appendChild(icon('lightbulb'));
            const lab = (MODEL_TYPE_OPTIONS.find(function (o) { return o.value === r.recommended; }) || {}).label;
            rec.appendChild(document.createTextNode(' ' + (m.modelType === r.recommended ? r.reason : 'Recommended: ' + lab + ' — ' + r.reason)));
        }
        const w = compat.warnings.get(m.modelType);
        warnLine.textContent = w ? '⚠ ' + w : '';
        warnLine.hidden = !w;
        const p = pipelineProblem(m, rc());
        problem.textContent = p || '';
        problem.hidden = !p;
    });

    const slotsBox = el('div', 'trn-slots');
    sec.appendChild(slotsBox);
    let slotsKey = '';
    let slotsFor = null;          // the model OBJECT the block was built for (a split can make a new model with the same id)
    f.onRefresh(function () {
        const m = dm();
        if (!m) return;
        const slots = getConfigSlots(m.modelType);
        const key = slots.join(',') + '|' + slots.map(function (s) { return slotValue(m, s); }).join(',') + '|' + isRunning() + '|' + isRemoteRun() + '|' +
            local.trained.map(function (r) { return r.path; }).join(',') + '|' +
            slots.map(function (s) { const c = m.slots[s]; return c ? c.mode + ':' + (c.checkpoint || '') : ''; }).join(',');
        if (key === slotsKey && slotsFor === m) return;
        slotsKey = key;
        slotsFor = m;
        slotsBox.textContent = '';
        for (const slot of slots) {
            const fb = el('div', 'inf-block');
            fb.appendChild(f.fieldLabel(getSlotLabel(slot), 'Config file for this model in the pipeline. Pick a preset, or browse to a training_config.yaml (also one from a trained model) to reuse its settings.'));
            const sbox = el('div', 'trn-slot' + (m.slots[slot] ? ' trn-slot-set' : ''));
            sbox.dataset.slot = slot;
            const sel = el('select', 'inf-select');
            sel.id = 'trnSlot-' + slot;
            const cur = slotValue(m, slot);
            if (!cur) { const ph = el('option', null, 'Select training config file...'); ph.value = ''; sel.appendChild(ph); }
            for (const o of slotOptions(m, slot)) {
                const op = el('option', null, o[1]);
                op.value = o[0];
                sel.appendChild(op);
            }
            sel.value = cur;
            sel.disabled = isRunning();
            sel.addEventListener('change', function () {
                const v = sel.value;
                const mm = dm();
                if (!mm) return;
                if (v === '__browse__') { sel.value = cur; browseConfig(mm, slot); return; }
                if (v.indexOf('preset:') === 0) {
                    const p = BASELINE_PROFILES.find(function (x) { return 'preset:' + x.filename === v; });
                    if (p) setSlotConfig(mm, slot, p.content, p.label, p.filename, true);
                }
                if (v.indexOf('trained:') === 0) { selectTrainedRun(mm, slot, v.slice(8)); return; }
                refresh();
            });
            sbox.appendChild(sel);
            const c = m.slots[slot];
            sbox.appendChild(el('div', 'trn-slot-meta', c ? 'head: ' + c.head + (c.mode === 'finetune' ? ' · fine-tune from ' + baseName(c.checkpoint || '?')
                : c.mode === 'resume' ? ' · resume ' + baseName(c.checkpoint || '?') : '') : 'or drop a YAML config here'));
            sbox.addEventListener('dragover', function (e) { e.preventDefault(); sbox.classList.add('trn-slot-drag'); });
            sbox.addEventListener('dragleave', function () { sbox.classList.remove('trn-slot-drag'); });
            sbox.addEventListener('drop', function (e) {
                e.preventDefault(); sbox.classList.remove('trn-slot-drag');
                const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                const mm = dm();
                if (file && mm && !isRunning()) readConfigFile(mm, slot, file);
            });
            fb.appendChild(sbox);
            slotsBox.appendChild(fb);
        }
    });
    const filled = el('div', 'trn-ok-note', 'Auto-filled from config files. All fields are editable.');
    sec.appendChild(f.shownIf(filled, function () { const m = dm(); return !!m && hasAllConfigs(m); }));
    const note = el('p', 'inf-error-text');
    sec.appendChild(note);
    f.onRefresh(function () { note.textContent = run.note || ''; note.hidden = !run.note; });

    const hsec = f.section(box, 'Hyperparameters', true);
    const none = el('p', 'inf-muted', 'Upload config file(s) above to see hyperparameters.');
    hsec.appendChild(f.shownIf(none, function () { const m = dm(); return !m || !hasAllConfigs(m); }));
    const body = el('div', 'inf-sub0');
    hsec.appendChild(f.shownIf(body, function () { const m = dm(); return !!m && hasAllConfigs(m); }));

    // sleap-app AnchorPartField: each node with how often it is visible in this model's labels, and the eye that
    // previews the crop on this model's views; LUC3D adds the crop's size under it.
    const anchor = f.selectField(body, 'Anchor Part', ANCHOR_HINT, function () {
        const m = dm();
        const names = analysis.nodeNames || [];
        const frames = m ? modelFrames(m, rc()) : [];
        return anchorChoices(names, frames.length ? nodeVisibility(frames, names.length) : null);
    }, function () { const m = dm(); return m ? m.anchorPart || '' : ''; }, function (v) { const m = dm(); if (m) m.anchorPart = v || null; }, { id: 'trnAnchor' });
    f.shownIf(anchor, function () { return cropsAround(dm()); });
    const eye = el('button', 'trn-eye');
    eye.type = 'button';
    eye.id = 'trnCropPreview';
    eye.addEventListener('click', function () { crop.preview = !crop.preview; refresh(); });
    anchor.appendChild(eye);
    anchor.classList.add('trn-anchor-row');
    const cropRow = el('div', 'inf-row');
    cropRow.id = 'trnCrop';
    cropRow.appendChild(f.fieldLabel('Crop Size', CROP_HINT));
    const cropVal = el('span', 'trn-crop-size');
    cropRow.appendChild(cropVal);
    body.appendChild(cropRow);
    const cropWarn = el('div', 'trn-crop-warn');
    cropWarn.id = 'trnCropWarnings';
    body.appendChild(cropWarn);
    let warnKey = '';
    f.onRefresh(function () {
        const m = dm();
        const on = cropsAround(m);
        cropRow.hidden = !on;
        if (!on) crop.preview = false;
        const info = on ? cropInfo(m, rc()) : null;
        if (!info) crop.preview = false;
        cropVal.textContent = cropText(info, m, rc());
        eye.innerHTML = railIconSvg(crop.preview ? 'eye-off' : 'eye');
        eye.title = crop.preview ? 'Hide crop preview' : 'Preview crop on canvas';
        eye.setAttribute('aria-label', eye.title);
        eye.setAttribute('aria-pressed', crop.preview ? 'true' : 'false');
        eye.disabled = !info || isRunning();
        const warnings = info ? info.warnings : [];
        cropWarn.hidden = !warnings.length;
        if (warnings.join('\n') !== warnKey) {
            warnKey = warnings.join('\n');
            cropWarn.textContent = '';
            warnings.forEach(function (w) { cropWarn.appendChild(el('p', 'trn-warnline', w)); });
        }
    });

    const tabs = el('div', 'trn-seg trn-tabs');
    body.appendChild(tabs);
    f.onRefresh(function () {
        const m = dm();
        if (!m) return;
        const slots = getConfigSlots(m.modelType);
        tabs.hidden = slots.length < 2;
        const key = slots.join(',');
        if (tabs.dataset.key !== key) {
            tabs.dataset.key = key;
            tabs.textContent = '';
            for (const slot of slots) {
                const b = button(getSlotLabel(slot).replace(' Config', ''), 'trn-seg-btn');
                b.dataset.slot = slot;
                b.addEventListener('click', function () { const mm = dm(); if (mm) mm.activeTab = slot; refresh(); });
                tabs.appendChild(b);
            }
        }
        for (const b of tabs.children) b.setAttribute('aria-pressed', b.dataset.slot === m.activeTab ? 'true' : 'false');
    });
    function hp() { const m = dm(); return m ? m.hp[m.activeTab] || m.hp[firstSlot(m)] || null : null; }
    f.numField(body, 'Max Epochs', MAX_EPOCHS_HINT, function () { const h = hp(); return h ? h.maxEpochs : null; },
        function (v) { const h = hp(); if (h) h.maxEpochs = v; }, { min: 1, max: 1000, integer: true, id: 'trnMaxEpochs' });
    f.numField(body, 'Batch Size', BATCH_SIZE_HINT, function () { const h = hp(); return h ? h.batchSize : null; },
        function (v) { const h = hp(); if (h) h.batchSize = v; }, { min: 1, max: 512, integer: true, id: 'trnBatchSize' });
    f.selectField(body, 'Rotation Augmentation', ROTATION_HINT, ROTATION_OPTIONS, function () { const h = hp(); return h ? h.rotationPreset : 'off'; },
        function (v) { const h = hp(); if (h) h.rotationPreset = v; }, { id: 'trnRotation' });
    const custom = f.numField(body, 'Rotation (± degrees)', null, function () { const h = hp(); return h ? h.rotationCustomAngle : null; },
        function (v) { const h = hp(); if (h) h.rotationCustomAngle = v; }, { min: 0, max: 180, integer: true });
    f.shownIf(custom, function () { const h = hp(); return !!h && h.rotationPreset === 'custom'; });
    f.check(body, 'Scale Augmentation', SCALE_HINT, function () { const h = hp(); return !!h && h.scaleEnabled; },
        function (v) { const h = hp(); if (h) h.scaleEnabled = v; });

    // sleap-app: "Full Configuration..." once there are configs; not while a run goes.
    const full = button('Full Configuration...', 'btn btn-sm trn-fullcfg', 'settings-2');
    full.id = 'trnFullConfig';
    full.addEventListener('click', function () { openFullConfig(dm(), null, rc()); });
    box.appendChild(f.shownIf(full, function () {
        const m = dm();
        return !!m && getConfigSlots(m.modelType).some(function (s) { return !!m.slots[s]; });
    }));
    f.onRefresh(function () { full.disabled = isRunning(); });
}

/** Labelled frames and instances of one camera, over every session. */
function viewStats(view) {
    let frames = 0, instances = 0;
    for (const s of projectSessions()) {
        if (sessionViews(s.index, s.session).indexOf(view) === -1) continue;
        const c = labelCount(s.index, view);
        frames += c.frames; instances += c.instances;
    }
    return { frames: frames, instances: instances };
}

/**
 * The run's settings, in the Models modal's "Run settings" fold: which sessions' views train (and where each
 * video is), the validation split (every model), where models go, and post-training inference. `rc()` is the run
 * settings edited (the modal's copy), `wm()` its models.
 */
function buildRunSettings(box, f, rc, wm) {
    // Training data: sessions × views
    box.appendChild(f.fieldLabel('Training data', 'The labelled frames of every checked view train the models it is in: your own instances only (predictions are not), ' +
        'with identities as tracks. Your current edits are used; nothing has to be saved first.'));
    const list = el('div', 'trn-views');
    list.id = 'trnViews';
    box.appendChild(list);
    const summary = el('p', 'inf-muted');
    summary.id = 'trnDataSummary';
    box.appendChild(summary);
    let listKey = '';
    f.onRefresh(function () {
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
                    checked: !rc().unchecked.has(viewKey(s.index, view)),
                    worker: isRemoteRun() ? (remote && remote.connected() ? remote.videoStatus(s.index, view) : '')
                        : (local.resolving && !localVideo(s.index, view) ? 'finding it on disk…' : localVideo(s.index, view) || 'not found among the files you opened'),
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
                    if (cb.checked) rc().unchecked.delete(k); else rc().unchecked.add(k);
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
        for (const sel of includedSelections(rc())) { const c = labelCount(sel.sessionIndex, sel.cameraName); frames += c.frames; inst += c.instances; vids++; }
        summary.textContent = frames.toLocaleString('en-US') + ' labelled frame' + (frames === 1 ? '' : 's') + ' · ' +
            inst.toLocaleString('en-US') + ' user instance' + (inst === 1 ? '' : 's') + ' · ' + vids + ' video' + (vids === 1 ? '' : 's');
    });

    // Validation split (every model)
    const vs = el('div', 'inf-block');
    vs.appendChild(f.fieldLabel('Validation split', 'A fraction of each model’s labelled frames is held out to measure its validation loss.'));
    box.appendChild(vs);
    f.numField(vs, 'Validation Fraction', null, function () {
        for (const m of wm()) { const v = runValidationFraction(m); if (v != null) return v; }
        return 0.1;
    }, function (v) { for (const m of wm()) for (const s of Object.keys(m.hp)) m.hp[s].validationFraction = v; }, { min: 0.01, max: 0.5, step: 0.01, id: 'trnValFraction' });
    const vnote = el('p', 'inf-muted');
    vs.appendChild(vnote);
    f.onRefresh(function () {
        vnote.textContent = isRemoteRun()
            ? 'On a worker, sleap-nn picks the validation frames at random, so another camera’s view of a validation moment can be in training.'
            : 'All views of one moment stay on the same side.';
    });

    // Output folder on the worker
    const outRow = el('div', 'inf-block');
    outRow.id = 'trnOutput';
    outRow.appendChild(f.fieldLabel('Output folder', 'Where the worker puts the trained models: a models folder inside this folder, one run folder per model.'));
    const outLine = el('div', 'trn-pathrow');
    const outPath = el('span', 'trn-path');
    outLine.appendChild(outPath);
    const outChange = button('Change…', 'btn btn-sm inf-btn-outline');
    outChange.addEventListener('click', function () { remote.chooseOutputDir(); });
    outLine.appendChild(outChange);
    outRow.appendChild(outLine);
    box.appendChild(f.shownIf(outRow, function () { return isRemoteRun() && !!remote && remote.connected(); }));

    // Runs folder (local): picked once per app run; read-only to the app (checkpoints are pickles).
    const runsRow = el('div', 'inf-block');
    runsRow.id = 'trnRunsFolder';
    runsRow.appendChild(f.fieldLabel('Runs folder', 'Where trained models go: one run folder per model. The app reads this folder but never writes in it ' +
        '(only sleap-nn does), so pick a folder for models only, such as a models folder next to the project.'));
    const runsLine = el('div', 'trn-pathrow');
    const runsPath = el('span', 'trn-path');
    runsLine.appendChild(runsPath);
    const runsChoose = button('Choose…', 'btn btn-sm inf-btn-outline');
    runsChoose.id = 'trnRunsChoose';
    runsChoose.addEventListener('click', chooseRunsFolder);
    runsLine.appendChild(runsChoose);
    runsRow.appendChild(runsLine);
    const runsNote = el('p', 'inf-muted');
    runsRow.appendChild(runsNote);
    box.appendChild(f.shownIf(runsRow, function () { return !isRemoteRun(); }));
    f.onRefresh(function () {
        runsPath.textContent = local.runsRoot || (lastRunsFolder() ? 'choose again: ' + lastRunsFolder() : 'none chosen');
        runsChoose.disabled = isRunning();
        runsNote.textContent = local.runsRoot && local.existingRuns
            ? local.existingRuns.toLocaleString('en-US') + ' trained run' + (local.existingRuns === 1 ? '' : 's') + ' already there.' : '';
        runsNote.hidden = !runsNote.textContent;
    });
    f.onRefresh(function () {
        if (!remote) return;
        outPath.textContent = remote.outputChecking() ? 'Checking…' : (remote.outputDir() ? remote.outputDir() + '/models' : 'none: choose a folder');
        outChange.disabled = isRunning();
    });

    // Post-training inference (sleap-app: Post-Training Inference Target in the Data section; Skip user labeled frames
    // and Existing predictions sit in its Full Configuration dialog, here under the target).
    const post = el('div', 'inf-block');
    post.id = 'trnPost';
    post.appendChild(f.fieldLabel('Post-Training Inference Target', POST_TRAINING_TARGET_HINT + ' A view several models train gets the one picked in the Views table.'));
    box.appendChild(post);
    f.selectField(post, null, null, POST_TRAINING_TARGETS, function () { return rc().post.target; },
        function (v) { rc().post.target = v; }, { id: 'trnPostTarget' });
    f.shownIf(f.numField(post, 'Sample count', 'How many frames to randomly sample for post-training inference. Every view runs on the same frames.',
        function () { return rc().post.sampleCount; }, function (v) { rc().post.sampleCount = v; }, { min: 1, integer: true, id: 'trnPostSamples' }),
    function () { return rc().post.target === 'random'; });
    const postOpts = el('div', 'trn-post-opts');
    post.appendChild(postOpts);
    f.check(postOpts, 'Skip user labeled frames', 'Do not run inference on frames that already have your labels.',
        function () { return rc().post.skipUserLabeled; }, function (v) { rc().post.skipUserLabeled = v; }).id = 'trnPostSkipUser';
    f.selectField(postOpts, 'Existing predictions', 'Predictions already in the project: Replace them on the frames inferred again, ' +
        'Keep them (the new ones are added), or Clear all first. Your own labels are never touched.',
    [['replace', 'Replace'], ['keep', 'Keep'], ['clear_all', 'Clear all']],
    function () { return rc().post.existingPredictions; }, function (v) { rc().post.existingPredictions = v; }, { id: 'trnPostExisting' });
    f.shownIf(postOpts, function () { return rc().post.target !== 'nothing'; });
}

function firstSlot(m) { return getConfigSlots(m.modelType)[0]; }

/** The modal's footer line: what stands in the way of its models, else a count. */
function modalStatus(work) {
    const rc = work.runCfg;
    const avail = includedViewNames(rc);
    if (!work.models.length) return { warn: true, text: 'No models yet: + New model, or start from a split above.' };
    const p = modelProblems(work.models, avail);
    if (p.empty.length) return { warn: true, text: '“' + p.empty[0].name + '” has no labelled view to train on.' };
    for (const m of work.models) {
        const named = work.models.length > 1 ? m.name + ': ' : '';
        const pp = pipelineProblem(m, rc);
        if (pp) return { warn: true, text: named + pp };
        if (!hasAllConfigs(m)) return { warn: true, text: named + 'pick a config for every part of the pipeline.' };
    }
    if (p.unused.length) {
        let frames = 0;
        p.unused.forEach(function (v) { frames += viewStats(v).frames; });
        return { warn: true, text: p.unused.join(', ') + (p.unused.length === 1 ? ' trains no model: its ' : ' train no model: their ') +
            frames.toLocaleString('en-US') + ' labelled frame' + (frames === 1 ? '' : 's') + ' go unused.' };
    }
    let jobs = 0;
    runModels(work.models, rc).forEach(function (x) { jobs += getConfigSlots(x.model.modelType).length; });
    const n = work.models.length;
    return { warn: false, text: 'Every labelled view trains a model · ' + n + ' model' + (n === 1 ? '' : 's') + ' · ' +
        jobs + ' training job' + (jobs === 1 ? '' : 's') };
}

let drawerForm = null;
let runForm = null;
let modalWork = null;             // the Models modal's working copy while it is open

/**
 * Open the Models modal on a copy of the models and the run settings; Apply hands the copy back.
 * @param {{modelId?: string, run?: boolean}} [o] the model to show, or the Run settings fold
 */
function openModelsEditor(o) {
    const oo = o || {};
    if (!YAML || isRunning() || trainingModelsModal()) return;
    analyze(false);
    const work = { models: structuredClone(models), runCfg: structuredClone(runCfg) };
    modalWork = work;
    const busy = function () { return isRunning() || dry.status === 'running'; };
    drawerForm = createPanelForm({ isBusy: busy, refresh: refresh });
    runForm = createPanelForm({ isBusy: busy, refresh: refresh });
    const df = drawerForm, rf = runForm;
    openTrainingModelsModal({
        work: work,
        allViews: allViewNames,
        available: function () { return includedViewNames(work.runCfg); },
        viewStats: viewStats,
        newModel: function (list, p, template) { return newTrainingModel(list, p, template); },
        typeLabel: function (m) { return modelTypeLabel(m.modelType); },
        metaText: function (m) { return modelMeta(m, work.runCfg); },
        status: function () { return modalStatus(work); },
        buildDrawer: function (container, selected) { buildModelSettings(container, df, selected, function () { return work.runCfg; }); },
        buildRunSettings: function (container) { buildRunSettings(container, rf, function () { return work.runCfg; }, function () { return work.models; }); },
        refreshForms: function (sel) {
            work.models.forEach(function (m) { if (!hasAllConfigs(m)) ensureSlots(m); autoModelType(m, work.runCfg); });
            crop.model = sel || null;
            df.runRefreshers();
            rf.runRefreshers();
            syncCropPreview();
        },
        isBusy: busy,
        onApply: function (w) {
            models = w.models;
            runCfg = w.runCfg;
            dry.key = '';
        },
        onClose: function () {
            drawerForm = null; runForm = null; modalWork = null;
            crop.preview = false; crop.model = null;
            syncCropPreview();
            refresh();
        },
        initialModelId: oo.modelId || null,
        openRun: !!oo.run,
    });
}

// ---------------------------------------------------------------------------
// The panel: a summary of the models and the run (the settings are in the Models modal)
// ---------------------------------------------------------------------------

/** Each model's views and settings, Edit models…, and what stands in the way. */
function buildSummarySection(top) {
    const head = el('div', 'trn-sum-head');
    const count = el('span', 'inf-label inf-caps');
    count.id = 'trnModelCount';
    head.appendChild(count);
    const edit = button('Edit models…', 'btn btn-sm inf-btn-outline', 'settings-2');
    edit.id = 'trnEditModels';
    edit.addEventListener('click', function () { openModelsEditor({}); });
    head.appendChild(edit);
    top.appendChild(head);
    const cards = el('div', 'trn-sum-cards');
    cards.id = 'trnModelCards';
    top.appendChild(cards);
    const probs = el('div', 'trn-sum-problems');
    probs.id = 'trnProblems';
    top.appendChild(probs);
    let key = '';
    form.onRefresh(function () {
        const avail = includedViewNames();
        count.textContent = 'Models · ' + models.length;
        edit.disabled = isRunning() || !YAML;
        const rows = models.map(function (m) {
            return { m: m, views: modelViews(m, avail), type: modelTypeLabel(m.modelType), meta: modelMeta(m) };
        });
        const k = JSON.stringify(rows.map(function (r) { return [r.m.id, r.m.name, r.m.color, r.views, r.type, r.meta, r.m.auto]; })) + isRunning();
        if (k !== key) {
            key = k;
            cards.textContent = '';
            rows.forEach(function (r) {
                const c = el('div', 'trn-sum-card');
                c.dataset.model = r.m.id;
                const t = el('div', 'trn-sum-cardtop');
                const sw = el('span', 'inf-mm-swatch');
                sw.style.background = r.m.color;
                t.appendChild(sw);
                t.appendChild(el('span', 'trn-sum-name', r.m.name));
                t.appendChild(el('span', 'trn-mm-badge', r.type));
                const pen = button('', 'inf-mm-icon trn-sum-edit', 'pencil');
                pen.title = 'Edit ' + r.m.name;
                pen.setAttribute('aria-label', pen.title);
                pen.disabled = isRunning();
                pen.addEventListener('click', function () { openModelsEditor({ modelId: r.m.id }); });
                t.appendChild(pen);
                c.appendChild(t);
                const tags = el('div', 'trn-sum-tags');
                if (!r.views.length) tags.appendChild(el('span', 'trn-sum-none', 'no labelled views'));
                r.views.forEach(function (v) { tags.appendChild(el('span', 'trn-sum-tag', v)); });
                c.appendChild(tags);
                c.appendChild(el('div', 'trn-sum-meta', r.meta));
                cards.appendChild(c);
            });
            if (!rows.length) cards.appendChild(el('p', 'inf-muted', 'No models: Edit models… to add one.'));
        }
        // What stands in the way: views in no model (a warning), models that cannot train (Start says why).
        probs.textContent = '';
        const p = modelProblems(models, avail);
        if (p.unused.length) {
            let frames = 0;
            p.unused.forEach(function (v) { frames += viewStats(v).frames; });
            probs.appendChild(el('p', 'trn-warnline', '⚠ ' + p.unused.join(', ') + (p.unused.length === 1 ? ' is in no model: its ' : ' are in no model: their ') +
                frames.toLocaleString('en-US') + ' labelled frame' + (frames === 1 ? '' : 's') + ' go unused.'));
        }
        models.forEach(function (m) {
            const pp = pipelineProblem(m);
            if (pp) probs.appendChild(el('p', 'inf-error-text', (models.length > 1 ? m.name + ': ' : '') + pp));
        });
        probs.hidden = !probs.children.length;
    });
}

/** The run's settings in one glance, and the way to them (the modal's Run settings). */
function buildRunSummary(top) {
    const head = el('div', 'trn-sum-head');
    head.appendChild(el('span', 'inf-label inf-caps', 'Run'));
    const edit = button('Edit', 'btn btn-sm inf-btn-ghost');
    edit.id = 'trnEditRun';
    edit.addEventListener('click', function () { openModelsEditor({ run: true }); });
    head.appendChild(edit);
    top.appendChild(head);
    const kv = el('div', 'trn-sum-kv');
    kv.id = 'trnRunSummary';
    top.appendChild(kv);
    form.onRefresh(function () {
        edit.disabled = isRunning() || !YAML;
        let vf = null;
        for (const m of models) { vf = runValidationFraction(m); if (vf != null) break; }
        const p = runCfg.post;
        const rows = [
            ['Validation', (vf == null ? '—' : Math.round(vf * 100) + '% of each model’s frames') + (isRemoteRun() ? ', picked at random' : '')],
            ['Afterwards', p.target === 'nothing' ? 'no inference' : 'inference on ' + (p.target === 'random' ? p.sampleCount.toLocaleString('en-US') + ' random frames' : postTargetLabel(p.target).toLowerCase())],
            isRemoteRun() ? ['Output', remote && remote.outputDir() ? remote.outputDir() + '/models' : 'no folder on the worker yet']
                : ['Runs folder', local.runsRoot || 'none chosen'],
        ];
        kv.textContent = '';
        rows.forEach(function (r) {
            kv.appendChild(el('span', 'trn-sum-k', r[0]));
            kv.appendChild(el('span', 'trn-sum-v', r[1]));
        });
    });
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
    buildPostInferenceBox(top);
    // sleap-app: View Metrics once a run completed (the models' evaluation on their validation frames).
    const metrics = button('View Metrics', 'btn btn-sm inf-btn-outline trn-metrics-btn', 'chart-line');
    metrics.id = 'trnViewMetrics';
    metrics.addEventListener('click', openMetrics);
    top.appendChild(form.shownIf(metrics, function () { return run.status === 'completed' && run.modelDirs.length > 0; }));
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

/** sleap-app's post-training inference box: status, message, and the way to the Inference panel. */
function buildPostInferenceBox(top) {
    const box = el('div', 'trn-dry-box trn-post');
    box.id = 'trnPostInference';
    const head = el('div', 'trn-dry-head');
    const headIcon = el('span', 'inf-icon');
    const headText = el('span');
    head.appendChild(headIcon); head.appendChild(headText);
    box.appendChild(head);
    const msg = el('div', 'trn-post-msg');
    box.appendChild(msg);
    const show = button('Show Inference panel', 'btn btn-sm inf-btn-outline', 'zap');
    show.id = 'trnPostShow';
    show.addEventListener('click', function () { showInferencePanel(); });
    box.appendChild(show);
    top.appendChild(form.shownIf(box, function () { return !!postRun.status; }));
    form.onRefresh(function () {
        const S = {
            running: ['loader-circle', postRun.remote ? 'Submitting post-training inference to the worker\u2026' : 'Running post-training inference\u2026 (progress in the Inference panel)', 'inf-spin'],
            completed: ['circle-check', postRun.remote ? 'Post-training inference submitted.' : 'Predictions merged into the project.', 'inf-ok'],
            error: ['circle-x', 'Post-training inference failed.', 'inf-bad'],
            skipped: ['circle-alert', 'Post-training inference skipped.', 'inf-warnc'],
        }[postRun.status];
        if (!S) return;
        box.classList.toggle('trn-post-error', postRun.status === 'error');
        headIcon.className = 'inf-icon ' + S[2];
        headIcon.innerHTML = railIconSvg(S[0]);
        headText.textContent = S[1];
        msg.textContent = postRun.message || '';
        msg.hidden = !msg.textContent;
        show.hidden = postRun.status === 'skipped';
    });
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
    let rowEls = [];
    form.onRefresh(function () {
        const running = isRunning();
        // Several models: the rows go under a header per model, each row naming its head only.
        const grouped = run.groups.length > 1;
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
        const shape = run.rows.map(function (r) { return r.label + '|' + r.status; }).join(',') + '|' + grouped;
        if (rowsBox.dataset.shape !== shape) {
            rowsBox.dataset.shape = shape;
            rowsBox.textContent = '';
            fills.clear();
            rowEls = [];
            let lastGroup = null;
            run.rows.forEach(function (r, i) {
                if (grouped && r.groupId !== lastGroup) {
                    lastGroup = r.groupId;
                    const g = run.groups.find(function (x) { return x.id === r.groupId; });
                    if (g) {
                        const gh = el('div', 'trn-group-head');
                        gh.dataset.model = g.id;
                        const sw = el('span', 'inf-mm-swatch');
                        sw.style.background = g.color;
                        gh.appendChild(sw);
                        gh.appendChild(el('span', 'trn-group-name', g.name));
                        gh.appendChild(el('span', 'trn-group-views', g.views.length + ' view' + (g.views.length === 1 ? '' : 's')));
                        gh.title = g.views.join(', ');
                        rowsBox.appendChild(gh);
                    }
                }
                const row = el('div', 'trn-row' + (r.status === 'completed' && running ? ' trn-row-done' : '') + (grouped ? ' trn-row-grouped' : ''));
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
                rowEls[i] = row;
                fills.set(i, { fill: fill, last: 0 });
            });
        }
        run.rows.forEach(function (r, i) {
            const row = rowEls[i];
            if (!row) return;
            row.querySelector('.trn-row-text').textContent = rowText(grouped ? Object.assign({}, r, { label: headLabel(r.head) }) : r, i, run.rows.length, running);
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

    buildSummarySection(top);
    form.sep(top);
    buildRunSummary(top);
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
    // sleap-app auto-selects the recommendation for a model whose type the user has not picked.
    models.forEach(function (m) { autoModelType(m); });
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
        models = defaultModels();
    } catch (e) {
        run.note = 'Could not load the training presets: ' + ((e && e.message) || e);
    }
    panelRefresh();
    detectEnvironment();
    return true;
}

/** Test/automation hook: show the panel. */
export function showTrainingPanel() { return showPanelTab(TRAINING_TAB_ID); }

/** For tests: open Full Configuration of a model (default the first), as its button in the Models modal does. */
export function _openTrainingConfig(tab, modelId) {
    const m = modelId ? models.find(function (x) { return x.id === modelId; }) : models[0];
    openFullConfig(m, tab);
}

/** Open the Models modal (Edit models…): `{modelId}` shows that model's settings, `{run: true}` the Run settings. */
export function openTrainingModels(o) { openModelsEditor(o); }

/** For tests: rescan the runs folder's trained runs now. */
export function _scanTrainedRuns() { return scanTrainedRuns(); }

/** For tests: the live config and run state (read-only use). */
export function _trainingState() {
    const m0 = models[0] || null;
    // `cfg`: the model on screen: the Models modal's (its working copy) while it is open, else the first model.
    const mm = trainingModelsModal();
    const shown = modalWork ? ((mm && mm.selected()) || modalWork.models[0] || null) : m0;
    return { cfg: shown, models: models, runCfg: runCfg, work: modalWork, run: run, analysis: analysis, groups: runModels().map(modelSnapshot), selections: includedSelections(),
        remote: remote && remote._state(), monitorIndex: monitorIndex,
        local: { runsRoot: local.runsRoot, videos: Object.fromEntries(local.videos), token: local.token, trained: local.trained }, dry: dry, backendRemote: isRemoteRun(),
        post: runCfg.post, postRun: postRun, crop: m0 ? cropInfo(m0) : null, cropPreview: crop.preview };
}

/** For tests: replace the models with the given splits (`[{name, views}]`, as the modal's Start from row makes them). */
export function _setTrainingModels(parts) {
    const list = [];
    (parts || []).forEach(function (p) { list.push(newTrainingModel(list, p)); });
    models = list;
    runCfg.inferWith = {};
    refresh();
    return models.map(function (m) { return m.id; });
}
/** For tests: recompute the label analysis now. */
export function _trainingAnalyze() { analyze(true); panelRefresh(); }
