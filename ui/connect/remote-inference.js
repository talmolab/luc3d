/**
 * ui/connect/remote-inference.js — the remote branch of the Inference panel:
 * run sleap-nn on a paired SLEAP Connect worker, one `track` job per view of the
 * current session, then Fetch & Load the predictions back.
 *
 * Port of the remote branch of sleap-app `src/stores/inferenceStore.ts`
 * (`startInference(config, remoteOpts)`, `pendingRemoteMerge`,
 * `mergeRemoteResults`) and of `RemoteOutputFolder.tsx`, with the Inference
 * panel's remote widgets (Models "Browse Worker", the data path, the "Fetch &
 * Load Results" button). The DOM-free decisions live in
 * `pose/connect/remote-inference-plan.js`; this file does the I/O and the DOM.
 *
 * Flow: the Backend picker selects + connects a worker; Models are picked ON
 * the worker (`remote-file-browser.js`); each view's video is placed on the
 * worker by path rules (`pathRulesFor`), the worker's shared folders and
 * `fs.stat` (Locate on worker… records a rule); Run submits one job per view,
 * all sharing one `run`, each with an explicit `output_path` in the output
 * folder (remembered per worker per project, `setOutputDir`); progress is read
 * from each job's event stream; Fetch & Load downloads each completed job
 * (`fetchResultBlobOn` with the `fs.read` fallback, since the worker's blob port
 * sends no CORS headers) and merges it through `mergeViewPredictions` with the
 * "Existing predictions" mode recorded on the job when it was submitted (`mergeMode`, like sleap-app's
 * `pendingRemoteMerge.mode`; a job without one uses the panel's current mode), then `markJobFetched`. Completed,
 * unfetched jobs of this project survive a reload in the store's tracked jobs,
 * so the button is offered again.
 *
 * Run is blocked (with the reason under the button) until every CHECKED view has its video on the
 * worker (sleap-app's PathResolutionDialog blocks Submit until all paths resolve), and a finished run
 * must be Dismissed before the next (sleap-app's `!isDone`). Progress shows the frame count, percent,
 * fps and ETA (summed / maximum over the running jobs), "Initializing..." before the first progress,
 * and a log with the echoed spec(s) (`$ Remote (N videos): …`), the submit / fetch lines and each
 * job's worker output (`[cam1] …`), with Expand and Copy Log.
 *
 * LUCID changes: one job per view (see the plan module); a result of another
 * session is refused until that session is current; the output folder must
 * already exist (the protocol has no mkdir); a progress card shows the fetch.
 *
 * Exports: createRemoteInference.
 */
import { useConnectStore, pathRulesFor } from '../../pose/connect/store.js';
import { shallowEqual } from '../../pose/connect/mini-store.js';
import { createJobStream } from '../../pose/connect/job-stream.js';
import { lucidProjectTag } from '../../pose/connect/project-tag.js';
import { defaultOutputDir } from '../../pose/connect/remote-output-dir.js';
import { formatRunTimestamp, formatDuration } from '../../pose/connect/timestamp.js';
import {
    VIDEO_EXTENSIONS, resolveViewVideos, describeViewStatus, inferLocateRule, planRemoteRun, pendingFetches,
    lastProgress, lastErrorLine, sessionRootOf, unresolvedViews, progressFromLine,
} from '../../pose/connect/remote-inference-plan.js';
import { openRemoteFileBrowser } from './remote-file-browser.js';
import { state } from '../app-state.js';
import { mergeViewPredictions } from '../inference-merge.js';
import { railIconSvg } from '../panel-rail-icons.js';
import { noteProgress, resetProgress } from '../progress-delta.js';
import { formatEta } from '../inference-args.js';
import { showLoading, showLoadingProgress, hideLoading } from '../loading-overlay.js';

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}
function icon(name, cls) {
    const s = el('span', 'inf-icon' + (cls ? ' ' + cls : ''));
    s.innerHTML = railIconSvg(name);
    return s;
}
function basename(p) { return String(p).split(/[\\/]/).pop(); }
const LOG_TAIL = 12;

/** The open project as the Connect tag sees it: the file's name and every session's folder name (the Inference panel's `getProjectInfo`). */
export function openProjectInfo() {
    return {
        fileName: state.slpFileHandle ? state.slpFileHandle.name : null,
        sessionFolders: (state.sessions || []).map(function (s) { return s.name; }),
    };
}

/**
 * Download one completed track job's predictions from its worker (the blob, or `fs.read` of the job's
 * `output_path` when the blob port is unreachable from a page).
 *
 * @param {string} workerId
 * @param {string} jobId
 * @param {{ name?: string, onProgress?: (done: number, total: number) => void }} [o]  `onProgress` may throw to cancel.
 * @returns {Promise<{ file: File, outPath: string | undefined, detail: any }>}
 */
export async function fetchJobPredictions(workerId, jobId, o) {
    o = o || {};
    const st = useConnectStore.getState();
    const detail = await st.jobDetail(workerId, jobId);
    const ref = detail.result && detail.result.blobs && detail.result.blobs.predictions;
    if (!ref) throw new Error('the worker reported no predictions file for this job');
    const outPath = detail.spec && detail.spec.output_path;
    const bytes = await st.fetchResultBlobOn(workerId, ref, {
        fsFallback: outPath ? { path: outPath, onProgress: o.onProgress } : undefined,
    });
    return { file: new File([bytes], (o.name || jobId) + '.predictions.slp'), outPath: outPath, detail: detail };
}

/**
 * Fetch & Load: for each tracked job (`{workerId, jobId, camera, ...}`) download its predictions and merge them into
 * view `camera` of the open session through `mergeFile(file, camera, mode)`, then `markJobFetched`. Shows the loading
 * overlay per job (MB progress), Esc cancels, and a job that fails stays pending (its camera is in `failures`).
 * Shared by the Inference panel's "Fetch & Load Results" and the Connect window's Jobs tab.
 *
 * @param {Array<{workerId: string, jobId: string, camera: string}>} jobs
 * @param {{ mode: string | ((job: any) => string), mergeFile?: (file: File, view: string, mode: string) => Promise<{instances: number, frames: number, deleted: number}>, onLog?: (line: string) => void }} o
 * @returns {Promise<{ loaded: number, failures: string[], cancelled: boolean }>}
 */
export async function fetchAndLoadJobs(jobs, o) {
    const mergeFile = o.mergeFile || mergeViewPredictions;
    const appendLog = o.onLog || function () {};
    const st = useConnectStore.getState();
    let cancelled = false;
    const onKey = function (e) { if (e.key === 'Escape') { cancelled = true; e.preventDefault(); e.stopPropagation(); } };
    document.addEventListener('keydown', onKey, true);
    const failures = [];
    let loaded = 0;
    try {
        for (let i = 0; i < jobs.length && !cancelled; i++) {
            const j = jobs[i];
            const opts = { title: 'Fetch & Load Results', step: i + 1, steps: jobs.length, unit: 'MB' };
            try {
                showLoading('Fetching ' + j.camera + '…', opts);
                const mb = function (b) { return Math.round(b / 1048576 * 10) / 10; };
                const got = await fetchJobPredictions(j.workerId, j.jobId, {
                    name: j.camera,
                    onProgress: function (done, total) {
                        if (cancelled) throw new Error('Cancelled');
                        showLoadingProgress('Fetching ' + j.camera, mb(done), mb(total), opts);
                    },
                });
                if (cancelled) break;
                showLoading('Loading ' + j.camera + ' predictions…', opts);
                const mode = typeof o.mode === 'function' ? o.mode(j) : o.mode;
                const r = await mergeFile(got.file, j.camera, mode);
                st.markJobFetched(j.jobId);
                loaded++;
                appendLog('✓ ' + j.camera + ': ' + r.instances.toLocaleString('en-US') + ' predicted instances on ' + r.frames.toLocaleString('en-US') +
                    ' frames' + (r.deleted ? ' (' + r.deleted.toLocaleString('en-US') + ' old removed)' : '') + (got.outPath ? ' ← ' + basename(got.outPath) : ''));
            } catch (e) {
                if (cancelled) break;
                failures.push(j.camera);
                appendLog('✗ ' + j.camera + ': ' + ((e && e.message) || e));
            }
        }
    } finally {
        document.removeEventListener('keydown', onKey, true);
        hideLoading();
    }
    return { loaded: loaded, failures: failures, cancelled: cancelled };
}

/**
 * @param {{
 *   getConfig: () => Record<string, any>,
 *   getSession: () => any,
 *   viewDescriptors: () => Array<{view: string, fileName?: string, relPath?: string, videoPath?: string, absPath?: string, frameCount: number, blocker: string | null, checked: boolean}>,
 *   setViewChecked: (view: string, on: boolean) => void,
 *   framesFor: (views: string[]) => Array<{view: string, framesSpec: string | null}>,
 *   getProjectInfo: () => {fileName: string | null, sessionFolders: string[]},
 *   mergeFile: (file: File, view: string, mode: string) => Promise<{instances: number, frames: number, deleted: number}>,
 *   getMode: () => string,
 *   openLogDialog?: (lines: string[]) => void,
 *   onChange: () => void,
 * }} host
 */
export function createRemoteInference(host) {
    const models = [];
    const views = { key: '', byView: {}, busy: false, error: null, token: 0 };
    const out = { key: '', dir: null, source: null, checking: false, note: null, token: 0 };
    const runIds = new Set();
    const log = [];
    const run = { startedAt: null, endedAt: null, error: null, submitting: false, fetching: false, cancelled: false };
    const streams = new Map();
    const jobLogs = new Map(); // jobId -> the worker's log lines, kept after its stream stops
    let preCount = 0; // log entries made while submitting (spec echo, submit lines): they come before the worker's lines
    const failHints = new Map(); // jobId -> the exception line of a failed job's log (the worker's detail is often just "exit code 1")
    const refreshers = [];
    let lastFrac = 0;

    function changed() { host.onChange(); }
    function refreshUi() { refreshers.forEach(function (f) { f(); }); }
    function onChange(f) { refreshers.push(f); }
    function appendLog(l) { log.push(String(l)); if (log.length > 2000) log.splice(0, log.length - 2000); }
    const S = function () { return useConnectStore.getState(); };

    // A new connection (a reconnect, a re-pick) is a new client: what was checked over the old one is redone.
    const clientIds = new WeakMap();
    let clientSeq = 0;
    function clientId() {
        const c = S()._client;
        if (!c) return 0;
        if (!clientIds.has(c)) clientIds.set(c, ++clientSeq);
        return clientIds.get(c);
    }
    function workerId() { return S().selectedWorkerId; }
    function connected() { return S().connectionStatus === 'connected' && !!workerId(); }
    function mountPaths() { return S().workerMounts.map(function (m) { return m.path; }); }
    function mountLabels() {
        const o = {};
        S().workerMounts.forEach(function (m) { if (m.label) o[m.path] = m.label; });
        return o;
    }
    function workerLabel(id) {
        const w = S().pairedWorkers.find(function (x) { return x.nodeId === id; });
        return w ? w.label : 'the worker';
    }
    function tag() {
        const p = host.getProjectInfo();
        return lucidProjectTag({ fileName: p.fileName, sessionFolders: p.sessionFolders });
    }
    function sessionRoot() {
        const s = host.getSession();
        return sessionRootOf(host.viewDescriptors(), s ? s.name : '');
    }

    // ----------------------------------------------------------------- views on the worker

    function resolveKey() {
        const s = host.getSession();
        const id = workerId();
        return [id, connected(), clientId(), mountPaths().join(','), JSON.stringify(pathRulesFor(id)), s ? s.name : '',
            host.viewDescriptors().map(function (d) { return d.view + ':' + (d.relPath || '') + ':' + (d.videoPath || '') + ':' + (d.absPath || ''); }).join('|')].join('\u0001');
    }

    function resolveViews() {
        const token = ++views.token;
        const s = host.getSession();
        views.busy = true; views.error = null;
        changed();
        resolveViewVideos(host.viewDescriptors(), {
            rules: pathRulesFor(workerId()), mounts: mountPaths(), sessionName: s ? s.name : '',
            stat: function (p) { return S().statWorkerPath(p); },
        }).then(function (res) {
            if (token !== views.token) return;
            views.byView = {};
            res.forEach(function (r) { views.byView[r.view] = r; });
        }, function (e) {
            if (token !== views.token) return;
            views.byView = {};
            views.error = 'Could not check the worker: ' + ((e && e.message) || e);
        }).then(function () { if (token === views.token) { views.busy = false; changed(); } });
    }

    async function locate(view) {
        const r = views.byView[view];
        if (!connected() || !r || !r.local) return;
        const picked = await openRemoteFileBrowser({
            workerId: workerId(), mounts: mountPaths(), mountLabels: mountLabels(), mode: 'file',
            fileFilter: VIDEO_EXTENSIONS, title: 'Locate ' + view + ' on the worker',
        });
        if (!picked) return;
        S().addPathRule(workerId(), inferLocateRule(r.local, picked, sessionRoot()));
        // The store change re-keys `sync()`, which resolves every view again.
    }

    // ----------------------------------------------------------------- output folder

    function outKey() {
        const id = workerId();
        const w = S().pairedWorkers.find(function (x) { return x.nodeId === id; });
        return [id, connected(), clientId(), tag().id, w && w.outputDirs ? w.outputDirs[tag().id] || '' : '', JSON.stringify(pathRulesFor(id)), mountPaths().join(',')].join('\u0001');
    }

    function resolveOutput() {
        const token = ++out.token;
        const id = workerId();
        const w = S().pairedWorkers.find(function (x) { return x.nodeId === id; });
        const chosen = w && w.outputDirs ? w.outputDirs[tag().id] : null;
        if (chosen) { out.dir = chosen; out.source = 'chosen'; out.checking = false; out.note = null; changed(); return; }
        out.checking = true; out.dir = null; out.source = null; out.note = null;
        changed();
        (async function () {
            const client = await S().clientFor(id);
            const facts = await client.fsMountsAndServeFolder();
            const info = host.getProjectInfo();
            const name = info.fileName || 'untitled.slp';
            const isDir = async function (p) {
                try { const st = await client.fsStat(p); return st.type === 'directory' && st.shared; } catch (e) { return false; }
            };
            let res = await defaultOutputDir({
                projectPath: sessionRoot() + '/' + name, projectName: name, rules: pathRulesFor(id),
                mounts: facts.mounts.map(function (m) { return m.path; }), serveFolder: facts.serveFolder, isSharedFolder: isDir,
            });
            // The worker does not create folders for an explicit output_path, so the folder must exist now.
            if (res && res.source === 'serve-folder' && !(await isDir(res.dir))) {
                res = facts.serveFolder && (await isDir(facts.serveFolder)) ? { dir: facts.serveFolder, source: 'serve-folder' } : null;
            }
            return res;
        })().then(function (res) {
            if (token !== out.token) return;
            out.dir = res ? res.dir : null; out.source = res ? res.source : null;
        }, function () {
            if (token !== out.token) return;
            out.dir = null; out.source = null;
        }).then(function () { if (token === out.token) { out.checking = false; changed(); } });
    }

    async function chooseOutputDir() {
        if (!connected()) return;
        const dir = await openRemoteFileBrowser({
            workerId: workerId(), mounts: mountPaths(), mountLabels: mountLabels(), mode: 'directory', title: 'Output folder on the worker',
        });
        if (dir) S().setOutputDir(workerId(), tag().id, dir);
    }
    function resetOutputDir() { if (workerId()) S().setOutputDir(workerId(), tag().id, null); }

    // ----------------------------------------------------------------- models

    async function addModel() {
        if (!connected()) return;
        const p = await openRemoteFileBrowser({
            workerId: workerId(), mounts: mountPaths(), mountLabels: mountLabels(), mode: 'directory', title: 'Select Model Directory on the worker',
        });
        if (p && models.indexOf(p) === -1) { models.push(p); changed(); }
    }

    // ----------------------------------------------------------------- jobs

    function myJobs() {
        const t = tag().id;
        return S().trackedJobs.filter(function (j) {
            return j.kind === 'track' && j.projectTag === t && j.camera !== undefined &&
                (j.state === 'active' || runIds.has(j.jobId) || ((j.fetchedAt === null || j.fetchedAt === undefined) && j.state === 'completed'));
        }).sort(function (a, b) { return a.submittedAt - b.submittedAt; });
    }
    function pending() { return pendingFetches(S().trackedJobs, { projectTagId: tag().id }); }

    function ensureStreams(jobs) {
        jobs.forEach(function (j) {
            if (j.state !== 'active' || streams.has(j.jobId)) return;
            streams.set(j.jobId, createJobStream(function () { return S().clientFor(j.workerId); }, j.jobId, { onUpdate: changed }));
        });
        streams.forEach(function (st, id) {
            const j = S().trackedJobs.find(function (x) { return x.jobId === id; });
            if (!j || j.state !== 'active') {
                const last = st.getState();
                if (last && last.log) jobLogs.set(id, last.log);
                if (j && j.state === 'failed' && !failHints.has(id)) {
                    const ss = st.getState();
                    const hint = ss ? lastErrorLine(ss.log) : null;
                    failHints.set(id, hint);
                    if (hint && runIds.has(id)) appendLog('\u2717 ' + j.camera + ': ' + hint);
                }
                st.stop(); streams.delete(id);
            }
        });
    }

    function jobInfo(j) {
        const st = streams.get(j.jobId);
        const ss = st ? st.getState() : null;
        const p = ss ? lastProgress(ss.log) : null;
        let text;
        if (j.state === 'completed') text = (j.fetchedAt != null) ? 'Loaded' : 'Done';
        else if (j.state === 'failed') text = 'Failed' + (j.error ? ': ' + j.error : '') + (failHints.get(j.jobId) ? ' \u2014 ' + failHints.get(j.jobId) : '');
        else if (j.state === 'canceled') text = 'Cancelled';
        else if (ss && ss.status === 'queued') text = 'Queued';
        else if (p && p.total > 0) {
            text = p.done.toLocaleString('en-US') + ' / ' + p.total.toLocaleString('en-US') + ' frames' +
                (p.rate > 0 ? ' · ' + p.rate.toFixed(1) + ' fps' : '') + (p.eta > 0 ? ' · ETA ' + formatEta(p.eta) : '');
        }
        else text = ss && ss.status === 'running' ? 'Running…' : 'Waiting…';
        const frac = j.state === 'completed' ? 1 : (p && p.total > 0 ? p.done / p.total : 0);
        return { text: text, frac: frac, progress: p && p.total > 0 && j.state === 'active' ? p : null, state: j.state };
    }

    /** The run's totals over its running jobs: frames, percent, fps (summed) and ETA (the longest). */
    function runTotals(infos) {
        let done = 0, total = 0, rate = 0, eta = 0, any = false;
        infos.forEach(function (i) {
            if (!i.progress) return;
            any = true; done += i.progress.done; total += i.progress.total; rate += i.progress.rate; eta = Math.max(eta, i.progress.eta);
        });
        return { any: any, done: done, total: total, rate: rate, eta: eta };
    }

    // ----------------------------------------------------------------- log

    function isProgressJson(l) { const t = String(l).trim(); return t.charAt(0) === '{' && progressFromLine(t) !== null; }
    /** The echoed spec and submit lines, then each job's worker output (`[cam1] …`), then what came after (fetch lines). */
    function fullLog() {
        const out = log.slice(0, Math.min(preCount, log.length));
        myJobs().forEach(function (j) {
            if (!runIds.has(j.jobId)) return;
            const st = streams.get(j.jobId);
            const ss = st ? st.getState() : null;
            (ss ? ss.log : jobLogs.get(j.jobId) || []).forEach(function (l) { if (!isProgressJson(l)) out.push('[' + j.camera + '] ' + l); });
        });
        return out.concat(log.slice(Math.min(preCount, log.length)));
    }
    function logTail() { return fullLog().join('\n').split('\n').slice(-LOG_TAIL); }

    function overall(jobs) {
        const active = jobs.some(function (j) { return j.state === 'active'; });
        if (run.submitting || active) return 'running';
        const mine = jobs.filter(function (j) { return runIds.has(j.jobId); });
        if (!mine.length) return jobs.length ? 'ready' : 'idle';
        if (mine.some(function (j) { return j.state === 'failed'; }) || run.error) return 'error';
        if (mine.every(function (j) { return j.state === 'canceled'; })) return 'cancelled';
        return 'completed';
    }

    // ----------------------------------------------------------------- run

    function isDone() { const o = overall(myJobs()); return o === 'completed' || o === 'error' || o === 'cancelled'; }
    function runnable() {
        return host.viewDescriptors().filter(function (d) {
            const r = views.byView[d.view];
            return d.checked && !d.blocker && r && r.visible;
        });
    }
    function whyNot() {
        if (!host.getSession()) return 'Open a session first.';
        if (!workerId()) return 'Connect to a worker in the Connect tab to start remote inference.';
        if (!connected()) return 'Connect to a worker in the Connect tab to start remote inference.';
        if (models.length === 0) return 'Add a model (Browse Worker).';
        if (views.busy) return 'Checking the worker…';
        const descs = host.viewDescriptors();
        if (descs.length && descs.every(function (x) { return x.blocker; })) return 'Inference on lazy-loaded views is not supported yet.';
        const un = unresolvedViews(descs, views.byView);
        if (un.length) return 'Not on the worker: ' + un.join(', ') + '. Locate on worker… or uncheck ' + (un.length > 1 ? 'them' : 'it') + ' (Data).';
        if (runnable().length === 0) return 'Check at least one view (Data).';
        if (!out.dir) return out.checking ? 'Checking the output folder…' : 'Choose an output folder on the worker (Data).';
        if (isDone()) return 'Dismiss the finished run to start another.';
        return '';
    }
    function isRunning() { return overall(myJobs()) === 'running'; }
    function canRun() { return !whyNot() && !isRunning() && !run.fetching; }
    function mergeModeOf(j) { return j.mergeMode || host.getMode(); }

    async function start() {
        if (!canRun()) return;
        const id = workerId();
        const session = host.getSession();
        run.error = null; run.cancelled = false; run.submitting = true; run.startedAt = Date.now(); run.endedAt = null;
        runIds.clear(); jobLogs.clear(); log.length = 0; preCount = 0; lastFrac = 0;
        changed();
        const jobsSubmitted = [];
        try {
            const st = S();
            const descs = host.viewDescriptors();
            const frames = host.framesFor(descs.map(function (d) { return d.view; }));
            const fmap = {};
            frames.forEach(function (f) { fmap[f.view] = f.framesSpec; });
            const dir = out.dir;
            const dstat = await st.statWorkerPath(dir);
            if (!dstat.exists || dstat.type === 'file') throw new Error('The output folder ' + dir + ' does not exist on the worker. Use Change… (Data) to pick another.');
            const pstat = await st.statWorkerPath(dir.replace(/\/+$/, '') + '/predictions').catch(function () { return { exists: false }; });
            const t = tag();
            const plan = planRemoteRun({
                config: host.getConfig(), session: session.name, outputDir: dir,
                hasPredictionsDir: !!(pstat.exists && pstat.type === 'directory'), stamp: formatRunTimestamp(), project: t, models: models.slice(),
                views: descs.map(function (d) {
                    const r = views.byView[d.view];
                    return {
                        view: d.view, workerPath: r && r.visible ? r.worker : null, framesSpec: fmap[d.view] === undefined ? null : fmap[d.view],
                        frameCount: d.frameCount, skip: d.blocker || (!d.checked ? 'not checked' : null),
                    };
                }),
            });
            plan.skipped.forEach(function (s) { appendLog('— ' + s.view + ' skipped: ' + s.reason); });
            if (plan.error) throw new Error(plan.error);
            appendLog('$ Remote' + (plan.jobs.length > 1 ? ' (' + plan.jobs.length + ' videos)' : '') + ': ' +
                JSON.stringify(plan.jobs.length > 1 ? plan.jobs.map(function (j) { return j.spec; }) : plan.jobs[0].spec, null, 2));
            const runId = (crypto.randomUUID ? crypto.randomUUID() : 'run-' + Date.now());
            for (let i = 0; i < plan.jobs.length; i++) {
                const j = plan.jobs[i];
                try {
                    const ids = await st.submitJobsOn(id, j.spec, {
                        source: 'window', sessionId: session.name, camera: j.view, projectTag: t.id, mergeMode: host.getMode(),
                        run: { id: runId, index: i, count: plan.jobs.length }, label: 'Inference · ' + j.view,
                    });
                    ids.forEach(function (x) { runIds.add(x); jobsSubmitted.push(x); });
                    appendLog('→ ' + j.view + ' submitted (' + ids[0] + ') → ' + j.outputPath);
                } catch (e) {
                    for (const x of jobsSubmitted) { try { await st.cancelJobOn(id, x, 'cancel'); } catch (e2) { /* best effort */ } }
                    throw new Error('Submitting ' + j.view + ' failed: ' + ((e && e.message) || e) +
                        (jobsSubmitted.length ? ' — the ' + jobsSubmitted.length + ' job(s) already submitted were cancelled.' : ''));
                }
            }
        } catch (e) {
            run.error = (e && e.message) || String(e);
            run.endedAt = Date.now();
            appendLog('✗ ' + run.error);
        } finally {
            run.submitting = false;
            preCount = log.length;
            changed();
        }
    }

    async function cancel() {
        run.cancelled = true;
        const st = S();
        for (const j of myJobs()) {
            if (j.state !== 'active') continue;
            try { await st.cancelJobOn(j.workerId, j.jobId, 'cancel'); } catch (e) { appendLog('Cancel failed for ' + j.camera + ': ' + ((e && e.message) || e)); }
        }
        changed();
    }

    function dismiss() {
        runIds.clear(); jobLogs.clear(); log.length = 0; preCount = 0; run.error = null; run.startedAt = null; run.endedAt = null; run.cancelled = false;
        changed();
    }

    // ----------------------------------------------------------------- Fetch & Load

    async function fetchAndLoad() {
        if (run.fetching) return;
        const session = host.getSession();
        const all = pending();
        if (!all.length) return;
        const mine = all.filter(function (j) { return session && j.sessionId === session.name; });
        if (!mine.length) {
            const names = Array.from(new Set(all.map(function (j) { return j.sessionId; })));
            run.error = 'These results are for ' + (names.length > 1 ? 'sessions ' : 'session ') + names.join(', ') +
                '. Switch to ' + (names.length > 1 ? 'one of them' : 'it') + ' first, then Fetch & Load Results.';
            appendLog('✗ ' + run.error);
            changed();
            return;
        }
        run.fetching = true; run.error = null;
        changed();
        let result = { loaded: 0, failures: [], cancelled: false };
        try {
            result = await fetchAndLoadJobs(mine, { mode: mergeModeOf, mergeFile: host.mergeFile, onLog: appendLog });
        } finally {
            run.fetching = false;
            const left = pending().length;
            if (result.cancelled) run.error = 'Cancelled: ' + result.loaded + ' of ' + mine.length + ' views loaded; the rest are still on the worker.';
            else if (result.failures.length) run.error = 'Could not load ' + result.failures.join(', ') + ' (see the log); they stay pending, press Fetch & Load Results to retry.';
            else if (left && !all.every(function (j) { return mine.indexOf(j) !== -1; })) {
                run.error = 'Loaded ' + result.loaded + ' view(s). The other results are for another session: switch to it to load them.';
            }
            changed();
        }
    }

    // ----------------------------------------------------------------- sync

    function sync() {
        if (!host.getSession()) return;
        ensureStreams(myJobs());
        if (!connected()) return;
        const k = resolveKey();
        if (k !== views.key) { views.key = k; resolveViews(); }
        const ok = outKey();
        if (ok !== out.key) { out.key = ok; resolveOutput(); }
    }

    useConnectStore.subscribeSelector(function (s) {
        return { t: s.trackedJobs, w: s.pairedWorkers, c: s.connectionStatus, s: s.selectedWorkerId, m: s.workerMounts, cl: s._client };
    }, function () { sync(); changed(); }, shallowEqual);

    // ----------------------------------------------------------------- UI

    function buildModels(parent) {
        const row = el('div', 'inf-right');
        const add = el('button', 'btn btn-sm inf-btn-outline');
        add.type = 'button'; add.id = 'infAddRemoteModel';
        add.append(icon('folder-open'), ' Browse Worker');
        add.addEventListener('click', addModel);
        row.appendChild(add);
        const empty = el('p', 'inf-muted');
        const list = el('div', 'inf-model-list');
        list.id = 'infRemoteModels';
        parent.append(row, empty, list);
        let lastSig = null;
        onChange(function () {
            const topDown = host.getConfig().pipeline === 'top-down' || host.getConfig().pipeline === 'top-down-id';
            // The panel re-evaluates every 2 s: repaint only when something shown changed, so a focused
            // button or a click in progress is not replaced under the user.
            const sig = JSON.stringify([connected(), isRunning(), topDown, models]);
            if (sig === lastSig) return;
            lastSig = sig;
            add.disabled = !connected() || isRunning();
            add.title = connected() ? '' : 'Connect to a worker first';
            empty.hidden = models.length > 0;
            empty.textContent = topDown ? 'Add two directories (centroid + centered-instance).' : 'Add a model directory.';
            list.textContent = '';
            models.forEach(function (p, i) {
                const item = el('div', 'inf-model');
                item.appendChild(icon('folder', 'inf-ok'));
                const name = el('span', 'inf-model-name', p);
                name.title = p;
                item.appendChild(name);
                const rm = el('button', 'inf-x');
                rm.type = 'button'; rm.innerHTML = railIconSvg('x'); rm.setAttribute('aria-label', 'Remove');
                rm.disabled = isRunning();
                rm.addEventListener('click', function () { models.splice(i, 1); changed(); });
                item.appendChild(rm);
                list.appendChild(item);
            });
        });
    }

    function buildViews(parent) {
        const note = el('p', 'inf-muted inf-path');
        note.id = 'infRemoteNote';
        const list = el('div', 'inf-view-list');
        list.id = 'infRemoteViews';
        const outRow = el('div', 'inf-block');
        const outHead = el('div', 'inf-row');
        outHead.appendChild(el('span', 'inf-label', 'Output folder'));
        const outBtns = el('span', 'inf-actions');
        const change = el('button', 'btn btn-sm inf-btn-outline');
        change.type = 'button'; change.id = 'infOutputChange';
        change.addEventListener('click', chooseOutputDir);
        const reset = el('button', 'btn btn-sm inf-btn-ghost', 'Reset');
        reset.type = 'button'; reset.id = 'infOutputReset';
        reset.addEventListener('click', resetOutputDir);
        outBtns.append(change, reset);
        outHead.appendChild(outBtns);
        const outPath = el('p', 'inf-muted inf-path');
        outPath.id = 'infOutputDir';
        outRow.append(outHead, outPath);
        parent.append(note, list, outRow);
        let lastSig = null;
        onChange(function () {
            const id = workerId();
            const running = isRunning();
            const sig = JSON.stringify([connected(), running, !!host.getSession(), views.error, views.busy, out.dir, out.source, out.checking,
                host.viewDescriptors().map(function (d) {
                    const r = views.byView[d.view];
                    return [d.view, d.blocker, d.checked, r ? [r.visible, r.worker, r.local, describeViewStatus(r)] : null];
                })]);
            if (sig === lastSig) return;
            lastSig = sig;
            note.textContent = !host.getSession() ? 'Open a session first.' : !connected() ? 'Connect to a worker to find each view’s video.'
                : views.error || (views.busy ? 'Checking the worker…' : '');
            note.hidden = !note.textContent;
            list.textContent = '';
            host.viewDescriptors().forEach(function (d) {
                const r = views.byView[d.view];
                const row = el('div', 'inf-view' + (d.blocker ? ' inf-view-blocked' : ''));
                row.setAttribute('data-view', d.view);
                const box = el('input'); box.type = 'checkbox';
                box.checked = !d.blocker && d.checked; box.disabled = running || !!d.blocker;
                box.addEventListener('change', function () { host.setViewChecked(d.view, box.checked); changed(); });
                const lab = el('label', 'inf-view-lab');
                lab.append(box, icon(!d.blocker && r && r.visible ? 'circle-check' : 'circle-alert',
                    !d.blocker && r && r.visible ? 'inf-ok' : (d.blocker ? 'inf-warnc' : 'inf-bad')), el('span', 'inf-view-name', d.view));
                const what = el('span', 'inf-view-file inf-view-why', d.blocker || (r ? describeViewStatus(r) : (connected() ? 'checking…' : '')));
                if (r && r.visible) what.title = r.worker;
                row.append(lab, what);
                if (!d.blocker && connected() && r && !r.visible && r.local) {
                    const loc = el('button', 'btn btn-sm inf-btn-outline inf-locate', 'Locate on worker…');
                    loc.type = 'button'; loc.disabled = running;
                    loc.addEventListener('click', function () { locate(d.view); });
                    row.appendChild(loc);
                }
                list.appendChild(row);
            });
            change.textContent = out.dir ? 'Change…' : 'Choose folder…';
            change.disabled = !connected() || running;
            reset.hidden = out.source !== 'chosen';
            outPath.textContent = !connected() ? '' : out.checking ? 'Checking…' : out.dir
                ? out.dir + (out.source === 'serve-folder' ? ' (the worker’s serve folder)' : '') : 'Pick a folder on the worker for the predictions.';
            outPath.hidden = !outPath.textContent;
            void id;
        });
    }

    function buildRun(parent) {
        const box = el('div', 'inf-progress');
        box.id = 'infRemoteRun';
        const head = el('div', 'inf-status');
        const sIcon = el('span', 'inf-icon'); const sText = el('span', 'inf-status-text'); const elapsed = el('span', 'inf-elapsed');
        head.append(sIcon, sText, elapsed);
        const rows = el('div', 'inf-view-list'); rows.id = 'infRemoteJobs';
        const bar = el('div', 'inf-bar'); const fill = el('div', 'inf-bar-fill'); bar.appendChild(fill);
        const counts = el('div', 'inf-counts'); counts.id = 'infRemoteCounts';
        const countL = el('span'); const countR = el('span'); counts.append(countL, countR);
        const stats = el('div', 'inf-stats'); stats.id = 'infRemoteStats';
        const errBox = el('div', 'inf-errbox'); errBox.id = 'infRemoteError';
        const actions = el('div', 'inf-actions');
        const cancelBtn = el('button', 'btn btn-sm inf-btn-danger'); cancelBtn.type = 'button'; cancelBtn.id = 'infRemoteCancel';
        cancelBtn.append(icon('x'), ' Cancel'); cancelBtn.addEventListener('click', cancel);
        const fetchBtn = el('button', 'btn btn-sm btn-primary'); fetchBtn.type = 'button'; fetchBtn.id = 'infFetchLoad';
        fetchBtn.addEventListener('click', fetchAndLoad);
        const dismissBtn = el('button', 'btn btn-sm inf-btn-outline', 'Dismiss'); dismissBtn.type = 'button'; dismissBtn.id = 'infRemoteDismiss';
        dismissBtn.addEventListener('click', dismiss);
        actions.append(cancelBtn, fetchBtn, dismissBtn);
        const logWrap = el('div');
        const logHead = el('div', 'inf-row');
        logHead.appendChild(el('span', 'inf-label', 'Log'));
        const expand = el('button', 'btn btn-sm inf-btn-ghost'); expand.type = 'button'; expand.id = 'infRemoteLogExpand';
        expand.append(icon('maximize-2'), ' Expand');
        expand.addEventListener('click', function () { if (host.openLogDialog) host.openLogDialog(fullLog()); });
        logHead.appendChild(expand);
        const logPre = el('pre', 'inf-log'); logPre.id = 'infRemoteLog';
        logPre.title = 'Click to open the full log';
        logPre.addEventListener('click', function () { if (host.openLogDialog) host.openLogDialog(fullLog()); });
        logWrap.append(logHead, logPre);
        const copyBtn = el('button', 'btn btn-sm inf-btn-outline'); copyBtn.type = 'button'; copyBtn.id = 'infRemoteLogCopy';
        copyBtn.append(icon('copy'), ' Copy Log');
        copyBtn.addEventListener('click', function () {
            if (navigator.clipboard) navigator.clipboard.writeText(fullLog().join('\n')).catch(function () { /* best effort */ });
        });
        box.append(head, rows, bar, counts, stats, errBox, actions, logWrap, copyBtn);
        parent.appendChild(box);
        const STATUS = {
            running: ['loader-circle', 'Running...', 'inf-spin'], completed: ['circle-check', 'Complete', 'inf-ok'],
            error: ['circle-x', 'Failed', 'inf-bad'], cancelled: ['circle-alert', 'Cancelled', 'inf-warnc'],
            ready: ['circle-check', 'Predictions ready', 'inf-ok'],
            idle: ['info', 'Nothing to load', 'inf-muted'],
        };
        let lastSig = null;
        onChange(function () {
            const jobs = myJobs();
            ensureStreams(jobs);
            const status = overall(jobs);
            const pend = pending();
            const infos = jobs.map(jobInfo);
            const sum = infos.reduce(function (a, i) { return a + i.frac; }, 0);
            const frac = jobs.length ? sum / jobs.length : 0;
            elapsed.textContent = run.startedAt ? formatDuration((run.endedAt || Date.now()) - run.startedAt) : '';
            if (frac < lastFrac) resetProgress(fill);
            fill.style.width = (frac * 100) + '%'; noteProgress(fill, frac); lastFrac = frac;
            // The panel re-evaluates every 2 s: rebuild the rows and buttons only when what they show
            // changed, so a focused button (or a click in progress) is not replaced under the user.
            const tot = runTotals(infos);
            const pct = tot.total > 0 ? tot.done / tot.total * 100 : 0;
            const countText = tot.any ? tot.done.toLocaleString('en-US') + ' / ' + tot.total.toLocaleString('en-US') + ' frames'
                : (status === 'running' ? 'Initializing...' : '');
            const pctText = pct > 0 ? pct.toFixed(1) + '%' : '';
            const statsText = tot.any ? [tot.rate > 0 ? tot.rate.toFixed(1) + ' fps' : '', tot.eta > 0 ? 'ETA ' + formatEta(tot.eta) : ''].filter(Boolean).join('   ') : '';
            const tail = logTail();
            const sig = JSON.stringify([status, run.fetching, run.submitting, run.error, !!run.startedAt, run.endedAt != null, pend.length,
                countText, pctText, statsText, tail, jobs.map(function (j, i) { return [j.camera, j.state, infos[i].text]; })]);
            if (sig === lastSig) return;
            lastSig = sig;
            box.hidden = status === 'idle' && !log.length && !run.error;
            const stt = STATUS[status] || STATUS.ready;
            sIcon.className = 'inf-icon ' + stt[2]; sIcon.innerHTML = railIconSvg(stt[0]);
            sText.textContent = run.fetching ? 'Fetching…' : stt[1];
            rows.textContent = '';
            jobs.forEach(function (j, i) {
                const r = el('div', 'inf-view'); r.dataset.view = j.camera; r.dataset.state = j.state;
                r.append(el('span', 'inf-view-name', j.camera), el('span', 'inf-view-file inf-view-why', infos[i].text));
                rows.appendChild(r);
            });
            bar.hidden = !jobs.length;
            countL.textContent = countText; countR.textContent = pctText; counts.hidden = !countText && !pctText;
            stats.textContent = statsText; stats.hidden = !statsText;
            errBox.textContent = run.error || ''; errBox.hidden = !run.error;
            cancelBtn.hidden = status !== 'running';
            cancelBtn.disabled = run.submitting;
            fetchBtn.hidden = !(pend.length && status !== 'running');
            fetchBtn.disabled = run.fetching;
            fetchBtn.textContent = run.fetching ? 'Fetching...' : 'Fetch & Load Results';
            dismissBtn.hidden = !(status === 'completed' || status === 'error' || status === 'cancelled' || status === 'ready' || run.error);
            const hasLog = fullLog().length > 0;
            logPre.textContent = tail.join('\n'); logWrap.hidden = !hasLog;
            copyBtn.hidden = !hasLog || status === 'running';
        });
        setInterval(function () { if (!box.hidden && isRunning()) refreshUi(); }, 1000);
    }

    return {
        models, buildModels, buildViews, buildRun, sync, start, cancel, fetchAndLoad, canRun, whyNot, isRunning, onChange, refreshUi,
        _state: function () { return { views: views, out: out, run: run, log: log, runIds: runIds, models: models }; },
    };
}
