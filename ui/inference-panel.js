/**
 * ui/inference-panel.js — the Inference panel: run sleap-nn on every camera
 * view of the open session (locally on the desktop app, or on a paired SLEAP
 * Connect worker), then bring the predictions back.
 *
 * A replica of sleap-app's Inference panel (`InferencePanel.tsx`, its store
 * `inferenceStore.ts` and `BackendPicker.tsx`) in LUCID's vanilla JS: the same
 * sections in the same order (Track only, Pipeline, Models, Data, Inference,
 * Tracking, Post-processing, Remote), the same defaults, labels, hints and
 * progress / log / Copy Log / Dismiss block. What LUCID changes:
 *   - one run = one sleap-nn job PER VIEW (`ui/inference-jobs.js`), all views
 *     with the SAME models for now (a per-view model slot exists in the config);
 *   - the Data section adds "Views": which views run, and each one's video
 *     on disk, found from the files the user OPENED (the desktop app records
 *     what was picked in the file dialogs, `lucidDesktop.fs.pathOfFile`), or
 *     the path the .slp recorded; Choose folder… is the fallback (each view's
 *     video matched by path and size, `ui/inference-video-paths.js`);
 *   - lazy-loaded views are blocked for now (`viewInferenceBlocker`, TEMPORARY);
 *   - targets are per session (all views share frame numbers), and LUCID has
 *     no suggestions, so "Suggested frames" is not offered;
 *   - Track only needs a per-view .slp input and is shown but not available;
 *     cross-view tracking is LUCID's Track ▸ All frames;
 *   - no Full Configuration window: every setting it holds is in the panel;
 *   - Backend (`ui/connect/backend-picker.js`, sleap-app's BackendPicker):
 *     Local (desktop with sleap-nn) or a paired worker. Remote runs, the worker
 *     file browser, path rules and Fetch & Load live in
 *     `ui/connect/remote-inference.js` (+ `pose/connect/remote-inference-plan.js`);
 *     Models / Views / the run block swap to their remote versions. With no
 *     local sleap-nn (the web app, a desktop build without it) the panel is
 *     remote-only, as sleap-app's browser build is.
 *
 * Loaded on every build: `pose/initialization.js` imports it dynamically after
 * the rail exists. The local paths talk to native code only through
 * `window.lucidDesktop` (src-tauri/js/lucid-desktop.js), looked up inside
 * `setupInferencePanel` and never on the web; it imports no desktop code.
 */
import { state } from './app-state.js';
import { registerPanelRailPanel, showPanelTab } from './panel-rail.js';
import { railIconSvg } from './panel-rail-icons.js';
import { setInfoTip } from './info-tip.js';
import { noteProgress, resetProgress } from './progress-delta.js';
import {
    defaultInferenceConfig, INFERENCE_DEFAULTS, targetFrames, sampleFrames, pickInferenceSubcommand,
    parseProgressLine, formatDuration, formatEta, framesToSpec,
} from './inference-args.js';
import { planInferenceJobs, runJobQueue, joinPath, viewInferenceBlocker } from './inference-jobs.js';
import { matchViewVideos, isVideoName } from './inference-video-paths.js';
import { mergeViewPredictions } from './inference-merge.js';
import { createRemoteInference } from './connect/remote-inference.js';
import { createBackendPicker } from './connect/backend-picker.js';

export const INFERENCE_TAB_ID = 'tabInference';

const PIPELINE_OPTIONS = [
    { value: 'top-down', label: 'Top-Down', desc: 'Two models: centroid + centered instance.' },
    { value: 'bottom-up', label: 'Bottom-Up', desc: 'Single model with confidence maps + PAFs.' },
    { value: 'single-animal', label: 'Single Animal', desc: 'Single confidence map model.' },
    { value: 'top-down-id', label: 'Top-Down + ID', desc: 'Top-down with identity classification.' },
    { value: 'bottom-up-id', label: 'Bottom-Up + ID', desc: 'Bottom-up with identity classification.' },
];
const DEVICE_OPTIONS = [['auto', 'Auto'], ['cuda', 'CUDA (GPU)'], ['cpu', 'CPU'], ['mps', 'MPS (Apple Silicon)']];
const RUNTIME_OPTIONS = [['auto', 'Auto'], ['onnx', 'ONNX'], ['tensorrt', 'TensorRT']];
const TARGET_OPTIONS = [
    ['custom', 'Custom range'],
    ['video', 'Entire session (all views)'],
    ['frame', 'Current frame'],
    ['random', 'Random sample'],
    ['user_labeled', 'User labeled frames'],
    ['predicted', 'Frames with predictions'],
];
const EXISTING_DESC = {
    clear_all: 'Remove all existing predictions first, then add the new ones.',
    keep: 'Add new predictions on top of existing ones (may duplicate).',
    replace: 'Replace predictions on re-inferred frames; keep your labels.',
};
const INFO_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/>' +
    '<path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
const LOG_MAX = 5000;
const LOG_TAIL = 12;
const LISTING_MAX_DEPTH = 4;

/** Backends a run can go to: this machine (desktop with sleap-nn) or a paired SLEAP Connect worker. */
export const INFERENCE_BACKENDS = [{ id: 'local', label: 'Local (this machine)' }, { id: 'remote', label: 'SLEAP Connect worker' }];

let sn = null;      // window.lucidDesktop.sleapNn
let fsApi = null;   // window.lucidDesktop.fs
let pane = null;
const cfg = defaultInferenceConfig();
let noMaxInstances = true;
let noMaxTracks = true;
const env = { checked: false, sleapNn: null, gpu: null, error: null };
const videos = {
    root: null, session: null, byView: {}, scanning: false, error: null,
    manual: false, autoKey: null, autoBusy: false, unselected: new Set(),
};
const run = {
    status: 'idle', error: null, progress: null, log: [], stderrTail: [], startedAt: null, endedAt: null,
    jobIndex: 0, jobCount: 0, view: null, pendingMerges: [], cancelled: false, merging: false,
};
const refreshers = [];
let elapsedTimer = null;
// Backend: 'remote' = a paired SLEAP Connect worker (the only backend where there is no local
// sleap-nn: the web app, or the desktop app without it); null = the default for this build.
const backend = { remote: null };
let remote = null;      // ui/connect/remote-inference.js controller

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function hintBtn(text) {
    const b = el('button', 'plane-section-info inf-hint');
    b.type = 'button';
    b.innerHTML = INFO_SVG;
    setInfoTip(b, text);
    return b;
}

function icon(name, cls) {
    const s = el('span', 'inf-icon' + (cls ? ' ' + cls : ''));
    s.innerHTML = railIconSvg(name);
    return s;
}

function isRunning() { return run.status === 'running' || (remote !== null && isRemote() && remote.isRunning()); }
function isDone() { return run.status === 'completed' || run.status === 'error' || run.status === 'cancelled'; }

/** Re-evaluate visibility / disabled state of every control. */
function refresh() {
    refreshers.forEach(function (f) { f(); });
    if (remote) { remote.sync(); remote.refreshUi(); }
}
function onRefresh(f) { refreshers.push(f); }

function fieldLabel(label, hint) {
    const s = el('span', 'inf-label', label);
    if (hint) s.appendChild(hintBtn(hint));
    return s;
}

/** sleap-app `Section`: a fold with a chevron (a <details>, so it is keyboard-native). */
function section(parent, title, defaultOpen) {
    const d = el('details', 'inf-section');
    d.open = !!defaultOpen;
    const s = el('summary', 'inf-section-title');
    s.appendChild(el('span', 'inf-chevron'));
    s.appendChild(el('span', null, title));
    d.appendChild(s);
    const body = el('div', 'inf-section-body');
    d.appendChild(body);
    parent.appendChild(d);
    return body;
}

function sep(parent) { parent.appendChild(el('div', 'inf-sep')); }

/** sleap-app `Check`. `get`/`set` read and write the value; `disabledIf` adds to "running". */
function check(parent, label, hint, get, set, disabledIf) {
    const l = el('label', 'inf-check');
    const box = el('input');
    box.type = 'checkbox';
    box.addEventListener('change', function () { set(box.checked); refresh(); });
    l.appendChild(box);
    l.appendChild(document.createTextNode(label));
    if (hint) l.appendChild(hintBtn(hint));
    parent.appendChild(l);
    onRefresh(function () {
        box.checked = !!get();
        box.disabled = isRunning() || !!(disabledIf && disabledIf());
    });
    return l;
}

/** sleap-app `NumField` / `NullableNumField`: label left, a small number box right; commits on change. */
function numField(parent, label, hint, get, set, o) {
    o = o || {};
    const row = el('div', 'inf-row');
    row.appendChild(fieldLabel(label, hint));
    const input = el('input', 'inf-num');
    input.type = 'number';
    if (o.min != null) input.min = o.min;
    if (o.max != null) input.max = o.max;
    input.step = o.step != null ? o.step : (o.integer ? 1 : 'any');
    if (o.placeholder) input.placeholder = o.placeholder;
    input.addEventListener('change', function () {
        const raw = input.value.trim();
        if (raw === '' && o.nullable) { set(null); refresh(); return; }
        let n = Number(raw);
        if (!Number.isFinite(n)) { refresh(); return; }
        if (o.integer) n = Math.round(n);
        if (o.min != null) n = Math.max(o.min, n);
        if (o.max != null) n = Math.min(o.max, n);
        set(n);
        refresh();
    });
    row.appendChild(input);
    parent.appendChild(row);
    onRefresh(function () {
        const v = get();
        if (document.activeElement !== input) input.value = v == null ? '' : String(v);
        input.disabled = isRunning() || !!(o.disabledIf && o.disabledIf());
    });
    return row;
}

/** sleap-app `Select` (+ optional label on the left for the compact rows). */
function selectField(parent, label, hint, options, get, set, o) {
    o = o || {};
    const row = el('div', label ? 'inf-row' : 'inf-block');
    if (label) row.appendChild(fieldLabel(label, hint));
    const sel = el('select', 'inf-select' + (label ? ' inf-select-sm' : ''));
    sel.addEventListener('change', function () { set(sel.value); refresh(); });
    row.appendChild(sel);
    parent.appendChild(row);
    let lastKey = '';
    onRefresh(function () {
        const opts = (typeof options === 'function' ? options() : options);
        const key = opts.map(function (x) { return x[0] + '\u0000' + x[1]; }).join('\u0001');
        if (key !== lastKey) {
            sel.textContent = '';
            opts.forEach(function (x) {
                const op = el('option', null, x[1]);
                op.value = x[0];
                sel.appendChild(op);
            });
            lastKey = key;
        }
        sel.value = get();
        sel.disabled = isRunning() || !!(o.disabledIf && o.disabledIf());
    });
    return row;
}

function shownIf(node, pred) {
    onRefresh(function () { node.hidden = !pred(); });
    return node;
}

// ---------------------------------------------------------------------------
// Session facts
// ---------------------------------------------------------------------------

/** The session's cameras: those shown as views first (in view order), then the rest. */
function sessionViews() {
    const s = state.session;
    if (!s) return [];
    const cams = s.cameras.map(function (c) { return c.name; });
    const shown = (state.views || []).map(function (v) { return v.name; })
        .filter(function (n) { return cams.indexOf(n) !== -1; });
    return shown.concat(cams.filter(function (n) { return shown.indexOf(n) === -1; }));
}

function videoFileOf(view) {
    return (state.videoFiles || []).find(function (vf) { return vf.assignedCamera === view; }) || null;
}

function frameCountOf(view) {
    const vf = videoFileOf(view);
    return (vf && vf.frameCount) || state.totalFrames || 0;
}

/** view -> Set of frames holding an instance of `type` ('user'|'predicted'), lazy store included. */
function framesWithType(type) {
    const out = new Map();
    const add = function (cam, f) {
        if (!out.has(cam)) out.set(cam, new Set());
        out.get(cam).add(f);
    };
    const s = state.session;
    if (!s) return out;
    if (s.lazyLoader && typeof s.lazyLoader.forEachInstanceRow === 'function') {
        s.lazyLoader.forEachInstanceRow(function (cam, frameIdx, trk, info) {
            if (info && info.type === type) add(cam, frameIdx);
        });
    }
    // Resident frames also hold edits the store does not have yet.
    for (const [frameIdx, fg] of s.frameGroups) {
        for (const [cam, list] of fg.instances) {
            if (list.some(function (i) { return i && i.type === type; })) add(cam, frameIdx);
        }
        for (const [cam, list] of fg.unlinkedInstances) {
            if (list.some(function (u) { return u && u.instance && u.instance.type === type; })) add(cam, frameIdx);
        }
    }
    return out;
}

function customRangeError() {
    if (cfg.frameRange !== 'custom') return null;
    const s = Number(cfg.frameStart), e = Number(cfg.frameEnd);
    // sleap-app checks the range against its one video. A session has several views and the range applies to
    // each (frames past a shorter view's end are dropped, `perViewFrames`), so it must fit the LONGEST view
    // that will run: the checked ones, or every view when none is checked.
    const checked = sessionViews().filter(function (v) { return !videos.unselected.has(v); });
    const n = Math.max.apply(null, [0].concat((checked.length ? checked : sessionViews()).map(frameCountOf)));
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < 0) return 'Invalid range';
    if (s > e) return 'Start must be less than end';
    if (n > 0 && (s >= n || e >= n)) {
        return 'Range must be 0–' + (n - 1).toLocaleString('en-US') + ' (' + n.toLocaleString('en-US') + ' frames in this session)';
    }
    return null;
}

// ---------------------------------------------------------------------------
// Videos on disk
// ---------------------------------------------------------------------------

async function listVideos(root) {
    const out = [];
    async function walk(dir, rel, depth) {
        let entries;
        try { entries = await fsApi.listDir(dir); } catch (e) { if (depth === 0) throw e; return; }
        for (const e of entries) {
            if (e.name.charAt(0) === '.') continue;
            const childRel = rel ? rel + '/' + e.name : e.name;
            if (e.kind === 'directory') {
                if (depth < LISTING_MAX_DEPTH && e.name !== 'predictions') await walk(joinPath(dir, e.name), childRel, depth + 1);
            } else if (isVideoName(e.name)) {
                out.push({ rel: childRel, size: e.size });
            }
        }
    }
    await walk(root, '', 0);
    return out;
}

function viewDescriptors() {
    return sessionViews().map(function (view) {
        const vf = videoFileOf(view);
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

async function chooseVideoFolder() {
    let root;
    try {
        root = await fsApi.pickDirectory('Folder with this session\u2019s videos');
    } catch (e) { videos.error = e.message; refresh(); return; }
    if (!root) return;
    await scanVideoFolder(root);
}

async function scanVideoFolder(root) {
    videos.scanning = true;
    videos.error = null;
    refresh();
    try {
        const listing = await listVideos(root);
        const m = matchViewVideos(viewDescriptors(), listing);
        const byView = {};
        Object.keys(m).forEach(function (v) {
            byView[v] = m[v].rel ? { path: joinPath(root, m[v].rel), rel: m[v].rel } : { error: m[v].error };
        });
        videos.root = root;
        videos.session = state.session;
        videos.byView = byView;
        videos.manual = true;
    } catch (e) {
        videos.error = 'Could not read the folder: ' + e.message;
    } finally {
        videos.scanning = false;
        refresh();
    }
}

function isAbsolutePath(p) { return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(String(p || '')); }
function dirnameOf(p) { return String(p).replace(/[\\/][^\\/]*$/, ''); }
function relLabel(path, root) {
    if (root && path.indexOf(root) === 0) return path.slice(root.length).replace(/^[\\/]/, '');
    return basename(path);
}

/**
 * Each view's video path from what the user already OPENED (the session
 * folder, the project's video prompt, a video file): the desktop app records
 * what was picked in those dialogs (`lucidDesktop.fs.pathOfFile`), else the
 * path the .slp / session recorded, if that file is one the app may read and
 * has the same size. Runs again only when the session, its views or their
 * Files change; a folder chosen by hand (Choose folder…) wins.
 */
async function autoResolveVideos() {
    const s = state.session;
    if (!s || !fsApi || videos.autoBusy || videos.manual) return;
    const views = sessionViews();
    const key = views.map(function (v) {
        const vf = videoFileOf(v);
        const f = vf && vf.file;
        return v + '\u0000' + (f ? f.name + ':' + f.size + ':' + (f.webkitRelativePath || '') : '') + '\u0000' + (vf ? vf.videoPath || '' : '');
    }).join('\u0001');
    if (videos.session === s && videos.autoKey === key) return;
    videos.autoBusy = true;
    try {
        const byView = {};
        let root = null;
        for (const v of views) {
            const vf = videoFileOf(v);
            const f = vf && vf.file;
            let hit = null;
            if (f && typeof fsApi.pathOfFile === 'function') hit = await fsApi.pathOfFile(f);
            if (!hit && vf && isAbsolutePath(vf.videoPath)) {
                try {
                    const st = await fsApi.stat(vf.videoPath);
                    if (st && st.isFile && (!f || Number(st.size) === f.size)) hit = { path: vf.videoPath, root: null };
                } catch (e) { /* not readable by the app */ }
            }
            if (hit) {
                byView[v] = { path: hit.path, root: hit.root };
                if (!root && hit.root) root = hit.root;
            } else {
                byView[v] = { error: 'not found among the files you opened' };
            }
        }
        if (state.session !== s || videos.manual) return;
        const first = views.map(function (v) { return byView[v]; }).find(function (m) { return m && m.path; });
        videos.root = root || (first ? dirnameOf(first.path) : null);
        Object.keys(byView).forEach(function (v) {
            if (byView[v].path) byView[v].rel = relLabel(byView[v].path, videos.root);
        });
        videos.byView = byView;
        videos.session = s;
        videos.autoKey = key;
    } finally {
        videos.autoBusy = false;
        refresh();
    }
}

/** Forget a mapping made for another session. */
function syncVideosToSession() {
    if (videos.session && videos.session !== state.session) {
        videos.root = null; videos.session = null; videos.byView = {}; videos.error = null;
        videos.manual = false; videos.autoKey = null; videos.unselected = new Set();
    }
}

/** Views a run would actually start: checked, not blocked, with a video on disk. */
function runnableViews() {
    return sessionViews().filter(function (v) {
        return !videos.unselected.has(v) && !viewInferenceBlocker(state.session, v) &&
            videos.byView[v] && videos.byView[v].path;
    });
}

function mappedViewCount() { return runnableViews().length; }

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

async function detectEnvironment() {
    if (!sn) { env.checked = true; refresh(); return; }
    env.error = null;
    try { env.sleapNn = await sn.detectSleapNn(); } catch (e) { env.sleapNn = null; env.error = e.message; }
    try { env.gpu = await sn.detectGpu(); } catch (e) { env.gpu = null; }
    env.checked = true;
    refresh();
}

function sleapNnAvailable() { return !!(sn && env.sleapNn && env.sleapNn.available); }

/** Whether this run goes to a worker: the only choice without a local sleap-nn, else the Backend picker's. */
function isRemote() { return !sn ? true : backend.remote === true; }

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function appendLog(line) {
    const s = String(line).replace(/[\r\n]+$/, '');
    if (!s.trim()) return;
    run.log.push(s);
    if (run.log.length > LOG_MAX) run.log.splice(0, run.log.length - LOG_MAX);
}

/** macOS prints duplicate-ObjC-class warnings for cv2/av on every sleap-nn start; not the cause of anything. */
function isNoise(line) { return /^objc\[\d+\]: Class /.test(line); }

function failureMessage(view, code) {
    const tail = run.stderrTail.filter(function (l) { return l.trim() && !isNoise(l); });
    const last = tail.length ? tail[tail.length - 1].trim() : '';
    return 'Inference failed on ' + view + (code != null ? ' (exit code ' + code + ')' : '') + (last ? ': ' + last : '');
}

function basename(p) { return String(p).split(/[\\/]/).pop(); }

async function mergeJob(job) {
    const bytes = await fsApi.readFile(job.outputPath);
    const file = new File([bytes], basename(job.outputPath));
    const r = await mergeViewPredictions(file, job.view, cfg.existingPredictions);
    appendLog('✓ ' + job.view + ': ' + r.instances.toLocaleString('en-US') + ' predicted instances on ' +
        r.frames.toLocaleString('en-US') + ' frames' + (r.deleted ? ' (' + r.deleted.toLocaleString('en-US') + ' old removed)' : '') +
        ' ← ' + basename(job.outputPath));
}

function perViewFrames(views) {
    const ctx = { currentFrame: state.currentFrame || 0 };
    const need = cfg.frameRange;
    const users = (need === 'user_labeled' || cfg.excludeUserLabeled) ? framesWithType('user') : null;
    const preds = need === 'predicted' ? framesWithType('predicted') : null;
    let sampled = null;
    if (need === 'random') {
        const n = Math.max.apply(null, [0].concat(views.map(frameCountOf)));
        sampled = sampleFrames(n, Math.max(1, cfg.sampleCount));
    }
    return views.map(function (view) {
        const c = Object.assign({}, ctx, {
            sampledFrames: sampled,
            labeledFrames: users && users.get(view) ? Array.from(users.get(view)) : [],
            predictedFrames: preds && preds.get(view) ? Array.from(preds.get(view)) : [],
        });
        let frames = targetFrames(cfg, c);
        const n = frameCountOf(view);
        if (cfg.excludeUserLabeled && users && users.get(view) && users.get(view).size) {
            const skip = users.get(view);
            if (frames == null) {
                frames = [];
                for (let i = 0; i < n; i++) frames.push(i);
            }
            frames = frames.filter(function (f) { return !skip.has(f); });
        }
        if (frames != null && n > 0) frames = frames.filter(function (f) { return f < n; });
        return { view: view, videoPath: videos.byView[view] && videos.byView[view].path, frames: frames };
    });
}

async function startInference() {
    syncVideosToSession();
    run.status = 'running'; run.error = null; run.progress = null; run.log = []; run.stderrTail = [];
    run.startedAt = Date.now(); run.endedAt = null; run.cancelled = false; run.pendingMerges = [];
    run.jobIndex = 0; run.jobCount = 0; run.view = null;
    startElapsed();
    refresh();
    try {
        const outputDir = joinPath(videos.root, 'predictions');
        sessionViews().forEach(function (v) {
            if (runnableViews().indexOf(v) !== -1) return;
            const why = viewInferenceBlocker(state.session, v) || (videos.unselected.has(v) ? 'not checked'
                : (videos.byView[v] && videos.byView[v].error) || 'no video file on disk');
            appendLog('\u2014 ' + v + ' skipped: ' + why);
        });
        const plan = planInferenceJobs(cfg, perViewFrames(runnableViews()), {
            outputDir: outputDir,
            subcommand: pickInferenceSubcommand(env.sleapNn && env.sleapNn.version),
        });
        plan.skipped.forEach(function (s) { appendLog('— ' + s.view + ' skipped: ' + s.reason); });
        if (plan.jobs.length === 0) throw new Error('No view has a video on disk and frames to run');
        try { await fsApi.makeDir(outputDir); } catch (e) {
            const st = await fsApi.stat(outputDir).catch(function () { return null; });
            if (!st || !st.isDir) {
                throw new Error('cannot write ' + outputDir + ' (' + e.message + '). Use Choose folder\u2026 to pick the folder');
            }
        }
        run.jobCount = plan.jobs.length;
        const res = await runJobQueue(plan.jobs, runOneJob, {
            concurrency: 1,
            isCancelled: function () { return run.cancelled; },
            onStart: function (job) {
                run.jobIndex++; run.view = job.view; run.progress = null; run.stderrTail = [];
                appendLog('── View ' + run.jobIndex + ' of ' + run.jobCount + ': ' + job.view + ' ──');
                appendLog('$ sleap-nn ' + job.args.join(' '));
                refresh();
            },
            onDone: async function (job, ok, err) {
                if (!ok) {
                    if (run.cancelled) return;
                    run.error = err ? 'Failed to start inference: ' + err.message : failureMessage(job.view, job.exitCode);
                    return;
                }
                try { await mergeJob(job); } catch (e) {
                    run.pendingMerges.push(job);
                    run.error = 'Failed to load results for ' + job.view + ': ' + e.message;
                    appendLog('✗ ' + run.error);
                }
                refresh();
            },
        });
        if (run.cancelled) run.status = 'cancelled';
        else if (res.failed.length || run.pendingMerges.length) run.status = 'error';
        else run.status = 'completed';
    } catch (e) {
        run.status = 'error';
        run.error = run.error || ('Failed to start inference: ' + e.message);
    }
    run.endedAt = Date.now();
    stopElapsed();
    refresh();
}

async function runOneJob(job) {
    const ok = await sn.runPythonCommand('sleap-nn', job.args, function (ev) {
        if (!ev) return;
        if (ev.event === 'stdout') {
            const p = parseProgressLine(ev.data.line);
            if (p) run.progress = p;
            else appendLog(ev.data.line);
        } else if (ev.event === 'stderr') {
            appendLog(ev.data.line);
            run.stderrTail.push(ev.data.line);
            if (run.stderrTail.length > 25) run.stderrTail.shift();
        } else if (ev.event === 'finished') {
            job.exitCode = ev.data.code;
        }
        refreshProgress();
    }, { jobId: job.id });
    return ok === true;
}

async function cancelInference() {
    run.cancelled = true;
    try { await sn.cancel(); } catch (e) { appendLog('Cancel failed: ' + e.message); }
    refresh();
}

async function retryMerges() {
    run.merging = true;
    run.error = null;
    refresh();
    const left = [];
    for (const job of run.pendingMerges) {
        try { await mergeJob(job); } catch (e) {
            left.push(job);
            run.error = 'Failed to load results for ' + job.view + ': ' + e.message;
        }
    }
    run.pendingMerges = left;
    run.merging = false;
    if (!left.length && !run.error) run.status = 'completed';
    refresh();
}

function dismiss() {
    Object.assign(run, { status: 'idle', error: null, progress: null, log: [], stderrTail: [], startedAt: null,
        endedAt: null, jobIndex: 0, jobCount: 0, view: null, pendingMerges: [] });
    refresh();
}

function startElapsed() {
    stopElapsed();
    elapsedTimer = setInterval(refreshProgress, 1000);
}
function stopElapsed() { if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = null; }

let progressRefresh = null;
function refreshProgress() { if (progressRefresh) progressRefresh(); }

/** Run is enabled for the current backend. */
function runEnabled() {
    if (isRemote()) return !!remote && remote.canRun() && !customRangeError();
    return canRun();
}

function canRun() {
    syncVideosToSession();
    return !!state.session && sleapNnAvailable() && !isRunning() && !isDone() &&
        cfg.modelPaths.length > 0 && mappedViewCount() > 0 && !customRangeError();
}

// ---------------------------------------------------------------------------
// Log window (sleap-app LogTerminalDialog)
// ---------------------------------------------------------------------------

function openLogDialog(lines) {
    if (document.getElementById('infLogDialog')) return;
    const text = Array.isArray(lines) ? lines : run.log;
    const scrim = el('div', 'inf-log-scrim');
    scrim.id = 'infLogDialog';
    scrim.setAttribute('data-shortcut-modal', '1');
    const box = el('div', 'inf-log-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Inference log');
    const head = el('div', 'inf-log-head');
    head.appendChild(el('span', null, 'Inference log'));
    const close = el('button', 'btn btn-sm', 'Close');
    close.type = 'button';
    head.appendChild(close);
    const pre = el('pre', 'inf-log-full', text.join('\n'));
    box.appendChild(head);
    box.appendChild(pre);
    scrim.appendChild(box);
    document.body.appendChild(scrim);
    pre.scrollTop = pre.scrollHeight;
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); done(); } }
    function done() { document.removeEventListener('keydown', onKey, true); scrim.remove(); }
    close.addEventListener('click', done);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) done(); });
    document.addEventListener('keydown', onKey, true);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function buildPanel(root) {
    const top = el('div', 'inf-config');
    root.appendChild(top);

    // sleap-nn not detected
    const warn = el('div', 'inf-warn');
    warn.appendChild(el('p', 'inf-warn-title', 'sleap-nn not detected'));
    const warnText = el('p', null, 'Install it in a terminal, then click Re-check:');
    warn.appendChild(warnText);
    warn.appendChild(el('code', 'inf-code', 'uv tool install "sleap-nn[torch-cpu]" --torch-backend=auto'));
    warn.appendChild(el('p', 'inf-muted', 'With an NVIDIA GPU use torch-cuda130 instead of torch-cpu.'));
    const recheck = el('button', 'btn btn-sm', 'Re-check');
    recheck.type = 'button';
    recheck.addEventListener('click', function () { env.checked = false; refresh(); detectEnvironment(); });
    warn.appendChild(recheck);
    top.appendChild(shownIf(warn, function () { return !!sn && env.checked && !sleapNnAvailable(); }));

    // Track only (not available in LUCID yet)
    check(top, 'Track only',
        'Run tracking on instances already in the project without pose estimation. Not available in LUCID yet: ' +
        'use Track ▸ All frames to track across views.',
        function () { return false; }, function () {}, function () { return true; });
    sep(top);

    // Pipeline
    const pipe = section(top, 'Pipeline', true);
    selectField(pipe, null, null, PIPELINE_OPTIONS.map(function (o) { return [o.value, o.label]; }),
        function () { return cfg.pipeline; }, function (v) { cfg.pipeline = v; });
    const pipeDesc = el('p', 'inf-muted');
    pipe.appendChild(pipeDesc);
    onRefresh(function () {
        const o = PIPELINE_OPTIONS.find(function (x) { return x.value === cfg.pipeline; });
        pipeDesc.textContent = o ? o.desc : '';
    });
    sep(top);

    // Models
    const models = section(top, 'Models', true);
    const lm = el('div', 'inf-sub0');
    models.appendChild(shownIf(lm, function () { return !isRemote(); }));
    const rmBox = el('div', 'inf-sub0');
    models.appendChild(shownIf(rmBox, isRemote));
    remote.buildModels(rmBox);
    const addRow = el('div', 'inf-right');
    const add = el('button', 'btn btn-sm inf-btn-outline');
    add.type = 'button';
    add.id = 'infAddModel';
    add.appendChild(icon('folder-open'));
    add.appendChild(document.createTextNode(' Add'));
    add.addEventListener('click', async function () {
        try {
            const p = await sn.pickModelDirectory('Select Model Directory');
            if (p && cfg.modelPaths.indexOf(p) === -1) cfg.modelPaths.push(p);
        } catch (e) { appendLog('Add model failed: ' + e.message); }
        refresh();
    });
    addRow.appendChild(add);
    lm.appendChild(addRow);
    const modelsEmpty = el('p', 'inf-muted');
    lm.appendChild(modelsEmpty);
    const modelList = el('div', 'inf-model-list');
    lm.appendChild(modelList);
    const sameNote = el('p', 'inf-muted', 'Every view runs with these models.');
    lm.appendChild(sameNote);
    onRefresh(function () {
        add.disabled = isRunning();
        const topDown = cfg.pipeline === 'top-down' || cfg.pipeline === 'top-down-id';
        modelsEmpty.hidden = cfg.modelPaths.length > 0;
        modelsEmpty.textContent = topDown ? 'Add two directories (centroid + centered-instance).' : 'Add a model directory.';
        sameNote.hidden = cfg.modelPaths.length === 0;
        modelList.textContent = '';
        cfg.modelPaths.forEach(function (p, i) {
            const item = el('div', 'inf-model');
            item.appendChild(icon('folder', 'inf-ok'));
            const name = el('span', 'inf-model-name', basename(p));
            name.title = p;
            item.appendChild(name);
            const rm = el('button', 'inf-x');
            rm.type = 'button';
            rm.innerHTML = railIconSvg('x');
            rm.setAttribute('aria-label', 'Remove');
            rm.disabled = isRunning();
            rm.addEventListener('click', function () { cfg.modelPaths.splice(i, 1); refresh(); });
            item.appendChild(rm);
            modelList.appendChild(item);
        });
    });
    sep(top);

    // Data
    const data = section(top, 'Data', true);
    data.appendChild(el('span', 'inf-label', 'Inference Target'));
    selectField(data, null, null, TARGET_OPTIONS,
        function () { return cfg.frameRange; }, function (v) { cfg.frameRange = v; });
    shownIf(numField(data, 'Sample count', null, function () { return cfg.sampleCount; },
        function (v) { cfg.sampleCount = v; }, { min: 1, integer: true }),
    function () { return cfg.frameRange === 'random'; });
    const custom = el('div', 'inf-custom');
    const startIn = el('input', 'inf-num inf-grow');
    startIn.type = 'number'; startIn.min = 0; startIn.placeholder = 'Start';
    const endIn = el('input', 'inf-num inf-grow');
    endIn.type = 'number'; endIn.min = 0; endIn.placeholder = 'End';
    startIn.addEventListener('input', function () { cfg.frameStart = startIn.value === '' ? NaN : Number(startIn.value); refresh(); });
    endIn.addEventListener('input', function () { cfg.frameEnd = endIn.value === '' ? NaN : Number(endIn.value); refresh(); });
    const customRow = el('div', 'inf-custom-row');
    customRow.appendChild(startIn);
    customRow.appendChild(el('span', 'inf-muted', 'to'));
    customRow.appendChild(endIn);
    custom.appendChild(customRow);
    const customErr = el('p', 'inf-error-text');
    custom.appendChild(customErr);
    data.appendChild(shownIf(custom, function () { return cfg.frameRange === 'custom'; }));
    onRefresh(function () {
        if (document.activeElement !== startIn) startIn.value = Number.isFinite(cfg.frameStart) ? cfg.frameStart : '';
        if (document.activeElement !== endIn) endIn.value = Number.isFinite(cfg.frameEnd) ? cfg.frameEnd : '';
        const err = customRangeError();
        customErr.textContent = err || '';
        customErr.hidden = !err;
        startIn.classList.toggle('inf-invalid', !!err);
        endIn.classList.toggle('inf-invalid', !!err);
        startIn.disabled = endIn.disabled = isRunning();
    });

    // Views (LUCID-only rows): which views run, and each one's video on disk.
    const vd = el('div', 'inf-block');
    const vdHead = el('div', 'inf-row');
    vdHead.appendChild(fieldLabel('Views',
        'Each checked view runs with the models above. Its video is found among the files you opened; if one is missing, Choose folder\u2026 to pick the recording folder.'));
    const choose = el('button', 'btn btn-sm inf-btn-outline');
    choose.type = 'button';
    choose.id = 'infChooseVideos';
    choose.appendChild(icon('folder-open'));
    choose.appendChild(document.createTextNode(' Choose folder\u2026'));
    choose.addEventListener('click', chooseVideoFolder);
    vdHead.appendChild(choose);
    vd.appendChild(vdHead);
    const vdRoot = el('p', 'inf-muted inf-path');
    vdRoot.id = 'infVideoRoot';
    vd.appendChild(vdRoot);
    const vdList = el('div', 'inf-view-list');
    vdList.id = 'infViewVideos';
    vd.appendChild(vdList);
    data.appendChild(shownIf(vd, function () { return !isRemote(); }));
    const rv = el('div', 'inf-block');
    const rvHead = el('div', 'inf-row');
    rvHead.appendChild(fieldLabel('Views',
        'Each checked view runs with the models above. Its video is found on the worker through path rules; Locate on worker\u2026 once per session folder if it is not.'));
    rv.appendChild(rvHead);
    remote.buildViews(rv);
    data.appendChild(shownIf(rv, isRemote));
    onRefresh(function () {
        if (!fsApi) return;
        syncVideosToSession();
        autoResolveVideos();
        choose.disabled = isRunning() || videos.scanning || !state.session;
        vdRoot.textContent = videos.scanning ? 'Scanning\u2026' : (videos.error || (videos.root ? 'Predictions go to ' +
            joinPath(videos.root, 'predictions') : (state.session ? (videos.autoBusy ? 'Finding videos\u2026' : '') : 'Open a session first.')));
        vdRoot.hidden = !vdRoot.textContent;
        vdRoot.classList.toggle('inf-error-text', !!videos.error);
        vdList.textContent = '';
        sessionViews().forEach(function (v) {
            const m = videos.byView[v];
            const blocked = viewInferenceBlocker(state.session, v);
            const row = el('label', 'inf-view' + (blocked ? ' inf-view-blocked' : ''));
            row.setAttribute('data-view', v);
            const box = el('input');
            box.type = 'checkbox';
            box.checked = !blocked && !videos.unselected.has(v);
            box.disabled = isRunning() || !!blocked;
            box.addEventListener('change', function () {
                if (box.checked) videos.unselected.delete(v); else videos.unselected.add(v);
                refresh();
            });
            row.appendChild(box);
            const ok = !blocked && m && m.path;
            row.appendChild(icon(ok ? 'circle-check' : 'circle-alert', ok ? 'inf-ok' : (blocked ? 'inf-warnc' : 'inf-bad')));
            row.appendChild(el('span', 'inf-view-name', v));
            const what = el('span', 'inf-view-file inf-view-why',
                blocked || (m && m.path ? m.rel : (m ? m.error : (videos.autoBusy ? 'looking\u2026' : 'no video found'))));
            if (!blocked && m && m.path) what.title = m.path;
            row.appendChild(what);
            vdList.appendChild(row);
        });
    });

    check(data, 'Exclude user-labeled frames', null,
        function () { return cfg.excludeUserLabeled; }, function (v) { cfg.excludeUserLabeled = v; });
    const ep = el('div', 'inf-block');
    ep.appendChild(el('span', 'inf-label', 'Existing predictions'));
    data.appendChild(ep);
    selectField(ep, null, null, [['clear_all', 'Clear all'], ['replace', 'Replace'], ['keep', 'Keep']],
        function () { return cfg.existingPredictions; }, function (v) { cfg.existingPredictions = v; });
    const epDesc = el('p', 'inf-muted');
    ep.appendChild(epDesc);
    onRefresh(function () { epDesc.textContent = EXISTING_DESC[cfg.existingPredictions] + ' Applies per view.'; });
    sep(top);

    // Inference
    const inf = section(top, 'Inference', true);
    numField(inf, 'Batch size', null, function () { return cfg.batchSize; }, function (v) { cfg.batchSize = v; },
        { min: 1, max: 128, integer: true });
    // sleap-app shows Device and Runtime only for the local engine (`InferencePanel.tsx:888,900`): a remote spec carries neither.
    shownIf(selectField(inf, 'Device', null, DEVICE_OPTIONS, function () { return cfg.device; }, function (v) { cfg.device = v; }),
        function () { return !isRemote(); });
    shownIf(selectField(inf, 'Runtime',
        'Inference engine. ‘Auto’ lets sleap-nn choose. ‘ONNX’/‘TensorRT’ apply only to an exported model directory (model.onnx / model.trt).',
        function () { return RUNTIME_OPTIONS.filter(function (o) { return o[0] !== 'tensorrt' || env.gpu === 'cuda'; }); },
        function () { return cfg.runtime; }, function (v) { cfg.runtime = v; }), function () { return !isRemote(); });
    numField(inf, 'Peak threshold', null, function () { return cfg.peakThreshold; },
        function (v) { cfg.peakThreshold = v; }, { min: 0, max: 1, step: 0.05 });
    numField(inf, 'Max instances', null, function () { return cfg.maxInstances == null ? 0 : cfg.maxInstances; },
        function (v) { cfg.maxInstances = v; }, { min: 1, max: 100, integer: true, disabledIf: function () { return noMaxInstances; } });
    check(inf, 'No limit', null, function () { return noMaxInstances; }, function (v) {
        noMaxInstances = v;
        if (v) cfg.maxInstances = null;
        else if (cfg.maxInstances == null) cfg.maxInstances = 2;
    });
    const bu = el('div', 'inf-sub');
    bu.appendChild(el('div', 'inf-subtitle', 'Bottom-Up'));
    numField(bu, 'Max edge length ratio', 'Maximum edge length as a fraction of the image size when grouping parts.',
        function () { return cfg.maxEdgeLengthRatio; }, function (v) { cfg.maxEdgeLengthRatio = v; }, { min: 0, max: 1, step: 0.05 });
    numField(bu, 'Distance penalty weight', 'How strongly long connections are penalized when grouping parts.',
        function () { return cfg.distPenaltyWeight; }, function (v) { cfg.distPenaltyWeight = v; }, { min: 0, step: 0.1 });
    numField(bu, 'PAF samples', 'Points sampled along each candidate connection.',
        function () { return cfg.nPoints; }, function (v) { cfg.nPoints = v; }, { min: 1, integer: true });
    numField(bu, 'Min line score', 'Minimum part-affinity score for a connection to be kept.',
        function () { return cfg.minLineScores; }, function (v) { cfg.minLineScores = v; }, { min: 0, max: 1, step: 0.05 });
    inf.appendChild(shownIf(bu, function () { return cfg.pipeline === 'bottom-up' || cfg.pipeline === 'bottom-up-id'; }));
    sep(top);

    // Tracking
    const trk = section(top, 'Tracking', false);
    check(trk, 'Enable tracking',
        'Connect predicted instances across frames within each view. Tracks are named per view; Track ▸ All frames links views.',
        function () { return cfg.tracking; }, function (v) { cfg.tracking = v; });
    const tOn = el('div', 'inf-sub0');
    trk.appendChild(shownIf(tOn, function () { return cfg.tracking; }));
    selectField(tOn, 'Method',
        'Simple matches instances by similarity alone. Optical Flow predicts motion from pixel displacement. Kalman Filter predicts motion from a per-track velocity model.',
        [['simple', 'Simple'], ['flow', 'Optical Flow'], ['kalman', 'Kalman Filter']],
        function () { return cfg.trackerMethod; }, function (v) { cfg.trackerMethod = v; });
    selectField(tOn, 'Similarity', 'Metric for comparing instances across frames.',
        [['oks', 'OKS'], ['iou', 'IoU'], ['centroids', 'Centroid dist.'], ['euclidean_dist', 'Euclidean dist.']],
        function () { return cfg.similarityMethod; }, function (v) { cfg.similarityMethod = v; });
    selectField(tOn, 'Matching', 'Hungarian finds the globally optimal assignment; Greedy is faster but may be suboptimal.',
        [['hungarian', 'Hungarian'], ['greedy', 'Greedy']],
        function () { return cfg.matchingMethod; }, function (v) { cfg.matchingMethod = v; });
    numField(tOn, 'Window size', 'Number of past frames used as matching candidates.',
        function () { return cfg.trackingWindowSize; }, function (v) { cfg.trackingWindowSize = v; }, { min: 1, max: 100, integer: true });
    numField(tOn, 'Max tracks', 'Maximum number of simultaneous tracks; set to the number of animals if known.',
        function () { return cfg.maxTracks == null ? 0 : cfg.maxTracks; }, function (v) { cfg.maxTracks = v; },
        { min: 1, max: 100, integer: true, disabledIf: function () { return noMaxTracks; } });
    check(tOn, 'No limit', null, function () { return noMaxTracks; }, function (v) {
        noMaxTracks = v;
        if (v) cfg.maxTracks = null;
        else if (cfg.maxTracks == null) cfg.maxTracks = 2;
    });
    const adv = section(tOn, 'Advanced', false);
    numField(adv, 'Robust (quantile)', 'Between 0 and 1 uses a robust quantile similarity score; 1 uses the max.',
        function () { return cfg.robust; }, function (v) { cfg.robust = v; }, { min: 0, max: 1, step: 0.05 });
    check(adv, 'Connect single-frame breaks', 'With Max tracks set, reconnects a break where one track is lost and one spawned in the same frame.',
        function () { return cfg.connectSingleBreaks; }, function (v) { cfg.connectSingleBreaks = v; });
    numField(adv, 'Min match points', 'Minimum non-missing keypoints for a match candidate.',
        function () { return cfg.minMatchPoints; }, function (v) { cfg.minMatchPoints = v; }, { min: 0, integer: true });
    numField(adv, 'Min new-track points', 'Minimum non-missing keypoints before an unmatched instance starts a track.',
        function () { return cfg.minNewTrackPoints; }, function (v) { cfg.minNewTrackPoints = v; }, { min: 0, integer: true });
    selectField(adv, 'Scoring reduction', 'How several similarity scores for one track are combined.',
        [['mean', 'Mean'], ['max', 'Max'], ['robust_quantile', 'Robust quantile']],
        function () { return cfg.scoringReduction; }, function (v) { cfg.scoringReduction = v; });
    numField(adv, 'Target instance count', 'Instances to track per frame; needed by Kalman and Pre-cull. Empty = auto.',
        function () { return cfg.trackingTargetInstanceCount; }, function (v) { cfg.trackingTargetInstanceCount = v; },
        { min: 1, max: 100, integer: true, nullable: true, placeholder: 'Auto' });
    check(adv, 'Pre-cull to target', 'Before tracking, discard detections above the target count.',
        function () { return cfg.trackingPreCullToTarget; }, function (v) { cfg.trackingPreCullToTarget = v; });
    shownIf(numField(adv, 'Pre-cull IoU threshold', 'IoU used to remove overlapping instances above the target.',
        function () { return cfg.trackingPreCullIouThreshold; }, function (v) { cfg.trackingPreCullIouThreshold = v; },
        { min: 0, max: 1, step: 0.05 }), function () { return cfg.trackingPreCullToTarget; });
    numField(adv, 'Clean-up instance count', 'After tracking, cull instances above this count per frame. Empty = off.',
        function () { return cfg.trackingCleanInstanceCount; }, function (v) { cfg.trackingCleanInstanceCount = v; },
        { min: 1, max: 100, integer: true, nullable: true, placeholder: 'Disabled' });
    shownIf(numField(adv, 'Clean-up IoU threshold', 'IoU used when culling after tracking.',
        function () { return cfg.trackingCleanIouThreshold; }, function (v) { cfg.trackingCleanIouThreshold = v; },
        { min: 0, max: 1, step: 0.05 }), function () { return cfg.trackingCleanInstanceCount != null; });
    const flow = el('div', 'inf-sub0');
    flow.appendChild(el('div', 'inf-subtitle', 'Optical Flow'));
    numField(flow, 'Image scale', 'Scale images before optical flow; lower is faster but less precise.',
        function () { return cfg.flowImgScale; }, function (v) { cfg.flowImgScale = v; }, { min: 0.1, max: 2, step: 0.1 });
    numField(flow, 'Flow window size', 'Search window for optical flow; larger handles faster motion.',
        function () { return cfg.flowWindowSize; }, function (v) { cfg.flowWindowSize = v; }, { min: 3, max: 99, step: 2, integer: true });
    numField(flow, 'Pyramid levels', 'Image pyramid levels; more handle larger displacements.',
        function () { return cfg.flowMaxLevels; }, function (v) { cfg.flowMaxLevels = v; }, { min: 1, max: 10, integer: true });
    tOn.appendChild(shownIf(flow, function () { return cfg.trackerMethod === 'flow'; }));
    const kf = el('div', 'inf-sub0');
    kf.appendChild(el('div', 'inf-subtitle', 'Kalman Filter'));
    selectField(kf, 'Track features', 'Centroid moves the last pose with one filter per track; Keypoints runs one filter per node.',
        [['centroid', 'Centroid'], ['keypoints', 'Keypoints']],
        function () { return cfg.kfTrackFeatures; }, function (v) { cfg.kfTrackFeatures = v; });
    numField(kf, 'Init frame count', 'Warm-up frames before the Kalman filters are fit.',
        function () { return cfg.kfInitFrameCount; }, function (v) { cfg.kfInitFrameCount = v; }, { min: 1, integer: true });
    numField(kf, 'Reset gap size', 'Missed frames after which a track’s filter is reset.',
        function () { return cfg.kfResetGapSize; }, function (v) { cfg.kfResetGapSize = v; }, { min: 1, integer: true });
    kf.appendChild(fieldLabel('Tracked nodes (all if none checked)', 'Skeleton nodes the motion model tracks.'));
    const nodeList = el('div', 'inf-node-list');
    kf.appendChild(nodeList);
    onRefresh(function () {
        const names = state.session && state.session.skeleton ? state.session.skeleton.nodes : [];
        const key = names.join('\u0001');
        if (nodeList.dataset.key !== key) {
            nodeList.dataset.key = key;
            nodeList.textContent = '';
            if (!names.length) nodeList.appendChild(el('p', 'inf-muted', 'No skeleton loaded — all nodes used.'));
            names.forEach(function (n, i) {
                const l = el('label', 'inf-check');
                const b = el('input');
                b.type = 'checkbox';
                b.dataset.idx = i;
                b.addEventListener('change', function () {
                    const set = new Set(cfg.kfNodeIndices);
                    if (b.checked) set.add(i); else set.delete(i);
                    cfg.kfNodeIndices = Array.from(set).sort(function (a, c) { return a - c; });
                });
                l.appendChild(b);
                l.appendChild(document.createTextNode(n));
                nodeList.appendChild(l);
            });
        }
        nodeList.querySelectorAll('input').forEach(function (b) {
            b.checked = cfg.kfNodeIndices.indexOf(Number(b.dataset.idx)) !== -1;
            b.disabled = isRunning();
        });
    });
    tOn.appendChild(shownIf(kf, function () { return cfg.trackerMethod === 'kalman'; }));
    sep(top);

    // Post-processing
    const post = section(top, 'Post-processing', false);
    check(post, 'Filter overlapping instances', 'Remove duplicate detections that overlap a lot (greedy non-max suppression).',
        function () { return cfg.filterOverlapping; }, function (v) { cfg.filterOverlapping = v; });
    const fo = el('div', 'inf-sub0');
    selectField(fo, 'Method', 'IoU uses bounding boxes; OKS uses keypoint similarity.', [['iou', 'IoU'], ['oks', 'OKS']],
        function () { return cfg.filterMethod; }, function (v) { cfg.filterMethod = v; });
    numField(fo, 'Threshold', 'Overlap above which the lower-scoring instance is removed.',
        function () { return cfg.filterThreshold; }, function (v) { cfg.filterThreshold = v; }, { min: 0, max: 1, step: 0.05 });
    post.appendChild(shownIf(fo, function () { return cfg.filterOverlapping; }));
    post.appendChild(el('div', 'inf-sep'));
    [
        ['Min visible nodes', 'Minimum nodes', 'filterMinVisibleNodes', 1, { min: 0, integer: true },
            'Minimum number of visible keypoints an instance must have to be kept.'],
        ['Min visible node fraction', 'Minimum fraction', 'filterMinVisibleNodeFraction', 0.5, { min: 0, max: 1, step: 0.05 },
            'Minimum fraction of skeleton nodes that must be visible.'],
        ['Min mean node score', 'Minimum score', 'filterMinMeanNodeScore', 0.3, { min: 0, max: 1, step: 0.05 },
            'Minimum mean confidence across an instance’s visible nodes.'],
        ['Min instance score', 'Minimum score', 'filterMinInstanceScore', 0.3, { min: 0, max: 1, step: 0.05 },
            'Minimum overall instance confidence score.'],
        ['Min centroid distance', 'Distance (px)', 'filterMinCentroidDistance', 10, { min: 0, step: 1 },
            'Drop a centroid within this many pixels of a higher-scored one.'],
    ].forEach(function (t) {
        const key = t[2];
        check(post, t[0], t[5], function () { return cfg[key] != null; }, function (v) { cfg[key] = v ? t[3] : null; });
        shownIf(numField(post, t[1], null, function () { return cfg[key]; }, function (v) { cfg[key] = v; }, t[4]),
            function () { return cfg[key] != null; });
    });
    sep(top);

    // Remote: the Backend picker (Local | a paired SLEAP Connect worker), sleap-app's BackendPicker
    const remoteSec = section(top, 'Remote', !sn);
    const picker = createBackendPicker({
        jobLabel: 'inference job',
        localAvailable: function () { return !!sn; },
        localListed: function () { return typeof window !== 'undefined' && !!window.lucidDesktop; },
        remoteEnabled: isRemote,
        onRemoteEnabledChange: function (on) { backend.remote = on; refresh(); },
        hintButton: hintBtn,
    });
    remoteSec.appendChild(picker.el);
    onRefresh(picker.refresh);
    const envLine = el('p', 'inf-muted');
    envLine.id = 'infEnvLine';
    remoteSec.appendChild(envLine);
    onRefresh(function () {
        envLine.hidden = !sn;
        if (!sn) return;
        envLine.textContent = !env.checked ? 'Checking for sleap-nn…'
            : sleapNnAvailable() ? 'sleap-nn ' + (env.sleapNn.version || '') + (env.gpu ? ' · ' + env.gpu.toUpperCase() : '')
                : 'sleap-nn not found' + (env.error ? ': ' + env.error : '');
    });
    sep(top);

    // Run
    const runBtn = el('button', 'btn btn-primary inf-run');
    runBtn.type = 'button';
    runBtn.id = 'infRun';
    runBtn.appendChild(icon('play'));
    const runLabel = document.createTextNode(' Run Inference');
    runBtn.appendChild(runLabel);
    runBtn.addEventListener('click', function () {
        if (!runEnabled()) return;
        if (isRemote()) remote.start(); else startInference();
    });
    top.appendChild(runBtn);
    const runWhy = el('p', 'inf-muted');
    top.appendChild(runWhy);
    onRefresh(function () {
        runBtn.disabled = !runEnabled();
        runLabel.textContent = isRemote() ? ' Run Remote Inference' : ' Run Inference';
        const rwhy = isRemote() ? (customRangeError() || remote.whyNot()) : '';
        const why = isRemote() ? (isRunning() ? '' : rwhy) : isRunning() || isDone() ? '' : !state.session ? 'Open a session first.'
            : !sleapNnAvailable() ? '' : cfg.modelPaths.length === 0 ? 'Add a model.'
                : mappedViewCount() === 0 ? (sessionViews().some(function (v) { return viewInferenceBlocker(state.session, v); })
                    && sessionViews().every(function (v) { return viewInferenceBlocker(state.session, v); })
                    ? 'Inference on lazy-loaded views is not supported yet.'
                    : 'No checked view has its video on disk: Choose folder\u2026 (Data).') : '';
        runWhy.textContent = why;
        runWhy.hidden = !why;
    });

    // Progress (bottom)
    const prog = el('div', 'inf-progress');
    prog.id = 'infProgress';
    root.appendChild(shownIf(prog, function () { return run.status !== 'idle'; }));
    remote.buildRun(root);
    const head = el('div', 'inf-status');
    const statusIcon = el('span', 'inf-icon');
    const statusText = el('span', 'inf-status-text');
    const elapsed = el('span', 'inf-elapsed');
    head.appendChild(statusIcon); head.appendChild(statusText); head.appendChild(elapsed);
    prog.appendChild(head);
    const jobLine = el('div', 'inf-muted');
    prog.appendChild(jobLine);
    const bar = el('div', 'inf-bar');
    const fill = el('div', 'inf-bar-fill');
    bar.appendChild(fill);
    prog.appendChild(bar);
    const counts = el('div', 'inf-counts');
    const countL = el('span'), countR = el('span');
    counts.appendChild(countL); counts.appendChild(countR);
    prog.appendChild(counts);
    const stats = el('div', 'inf-stats');
    prog.appendChild(stats);
    const errBox = el('div', 'inf-errbox');
    prog.appendChild(errBox);
    const actions = el('div', 'inf-actions');
    const cancelBtn = el('button', 'btn btn-sm inf-btn-danger');
    cancelBtn.type = 'button';
    cancelBtn.id = 'infCancel';
    cancelBtn.appendChild(icon('x'));
    cancelBtn.appendChild(document.createTextNode(' Cancel'));
    cancelBtn.addEventListener('click', cancelInference);
    const loadBtn = el('button', 'btn btn-sm btn-primary');
    loadBtn.type = 'button';
    loadBtn.id = 'infLoadResults';
    loadBtn.addEventListener('click', retryMerges);
    actions.appendChild(cancelBtn); actions.appendChild(loadBtn);
    prog.appendChild(actions);
    const logHead = el('div', 'inf-row');
    logHead.appendChild(el('span', 'inf-label', 'Log'));
    const expand = el('button', 'btn btn-sm inf-btn-ghost');
    expand.type = 'button';
    expand.appendChild(icon('maximize-2'));
    expand.appendChild(document.createTextNode(' Expand'));
    expand.addEventListener('click', function () { openLogDialog(); });
    logHead.appendChild(expand);
    const logPre = el('pre', 'inf-log');
    logPre.id = 'infLog';
    logPre.title = 'Click to open the full log';
    logPre.addEventListener('click', function () { openLogDialog(); });
    const logWrap = el('div');
    logWrap.appendChild(logHead); logWrap.appendChild(logPre);
    prog.appendChild(logWrap);
    const bottom = el('div', 'inf-actions');
    const copyBtn = el('button', 'btn btn-sm inf-btn-outline');
    copyBtn.type = 'button';
    copyBtn.appendChild(icon('copy'));
    copyBtn.appendChild(document.createTextNode(' Copy Log'));
    copyBtn.addEventListener('click', function () {
        if (navigator.clipboard) navigator.clipboard.writeText(run.log.join('\n')).catch(function () {});
    });
    const dismissBtn = el('button', 'btn btn-sm inf-btn-outline', 'Dismiss');
    dismissBtn.type = 'button';
    dismissBtn.id = 'infDismiss';
    dismissBtn.addEventListener('click', dismiss);
    bottom.appendChild(copyBtn); bottom.appendChild(dismissBtn);
    prog.appendChild(bottom);

    let lastFrac = 0;
    progressRefresh = function () {
        const running = isRunning();
        const STATUS = {
            running: ['loader-circle', 'Running...', 'inf-spin'],
            completed: ['circle-check', 'Complete', 'inf-ok'],
            error: ['circle-x', 'Failed', 'inf-bad'],
            cancelled: ['circle-alert', 'Cancelled', 'inf-warnc'],
        }[run.status];
        if (STATUS) {
            statusIcon.className = 'inf-icon ' + STATUS[2];
            statusIcon.innerHTML = railIconSvg(STATUS[0]);
            statusText.textContent = STATUS[1];
        }
        elapsed.textContent = run.startedAt ? formatDuration((run.endedAt || Date.now()) - run.startedAt) : '';
        jobLine.textContent = run.jobCount ? 'View ' + run.jobIndex + ' of ' + run.jobCount + (run.view ? ': ' + run.view : '') : '';
        const p = run.progress;
        const pct = p && p.nTotal > 0 ? (p.nProcessed / p.nTotal) * 100 : 0;
        const frac = Math.max(0, Math.min(1, pct / 100));
        if (frac < lastFrac) resetProgress(fill);
        fill.style.width = (frac * 100) + '%';
        noteProgress(fill, frac);
        lastFrac = frac;
        countL.textContent = p ? p.nProcessed.toLocaleString('en-US') + ' / ' + p.nTotal.toLocaleString('en-US') + ' frames'
            : (running ? 'Initializing...' : '');
        countR.textContent = pct > 0 ? pct.toFixed(1) + '%' : '';
        stats.textContent = p ? [p.rate > 0 ? p.rate.toFixed(1) + ' fps' : '', p.eta > 0 ? 'ETA ' + formatEta(p.eta) : '']
            .filter(Boolean).join('   ') : '';
        errBox.textContent = run.error || '';
        errBox.hidden = !run.error;
        cancelBtn.hidden = !running;
        loadBtn.hidden = !(run.pendingMerges.length && !running);
        loadBtn.disabled = run.merging;
        loadBtn.textContent = run.merging ? 'Loading...' : 'Load Results';
        logWrap.hidden = run.log.length === 0;
        logPre.textContent = run.log.slice(-LOG_TAIL).join('\n');
        bottom.hidden = !isDone();
    };
    onRefresh(progressRefresh);
}

/**
 * Add the Inference panel when this is the desktop app with sleap-nn in the
 * build. Resolves to true when it was added.
 */
export async function setupInferencePanel() {
    if (pane) return false;
    // Local sleap-nn: the desktop app only (`window.lucidDesktop`), and only when it is in the build.
    // Without it (the web app, or a desktop build without sleap-nn) the panel is remote-only.
    const d = typeof window !== 'undefined' ? window.lucidDesktop : null;
    if (d && d.sleapNn && d.fs) {
        try {
            const st = await d.sleapNn.status();
            if (st && st.available) { sn = d.sleapNn; fsApi = d.fs; }
        } catch (e) { /* remote only */ }
    }
    remote = createRemoteInference({
        getConfig: function () { return cfg; },
        getSession: function () { return state.session; },
        viewDescriptors: function () {
            return viewDescriptors().map(function (v) {
                const m = videos.byView[v.view];
                return Object.assign({}, v, {
                    absPath: m && m.path ? m.path : '',
                    frameCount: frameCountOf(v.view),
                    blocker: viewInferenceBlocker(state.session, v.view),
                    checked: !videos.unselected.has(v.view),
                });
            });
        },
        setViewChecked: function (v, on) { if (on) videos.unselected.delete(v); else videos.unselected.add(v); },
        framesFor: function (vs) {
            return perViewFrames(vs).map(function (x) { return { view: x.view, framesSpec: x.frames == null ? null : framesToSpec(x.frames) }; });
        },
        getProjectInfo: function () {
            return { fileName: state.slpFileHandle ? state.slpFileHandle.name : null,
                sessionFolders: (state.sessions || []).map(function (s) { return s.name; }) };
        },
        mergeFile: function (file, view, mode) { return mergeViewPredictions(file, view, mode); },
        getMode: function () { return cfg.existingPredictions; },
        openLogDialog: function (lines) { openLogDialog(lines); },
        onChange: refresh,
    });
    pane = el('div', 'inference-panel');
    buildPanel(pane);
    if (!registerPanelRailPanel({ tab: INFERENCE_TAB_ID, label: 'Inference', icon: 'zap' }, pane)) {
        pane = null;
        return false;
    }
    // A session loaded or switched since the last look: re-evaluate.
    pane.addEventListener('pointerenter', refresh);
    pane.addEventListener('focusin', function (e) { if (e.target === pane) refresh(); });
    // A session opened while the panel is showing (there is no event for it): re-evaluate every 2 s.
    setInterval(function () { if (pane && pane.offsetParent !== null && !document.hidden) refresh(); }, 2000);
    refresh();
    detectEnvironment();
    return true;
}

/** Test/automation hook: show the panel. */
export function showInferencePanel() { return showPanelTab(INFERENCE_TAB_ID); }

/** For tests: the live config and run state (read-only use). */
export function _inferenceState() { return { cfg: cfg, run: run, videos: videos, env: env, defaults: INFERENCE_DEFAULTS }; }
