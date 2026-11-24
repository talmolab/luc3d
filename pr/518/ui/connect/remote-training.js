/**
 * ui/connect/remote-training.js — the Training panel's remote backend: where each (session, view)
 * video is on the worker, the output folder, and submitting / stopping / cancelling `train` jobs.
 *
 * Port of the remote branch of sleap-app `src/stores/trainingStore.ts` `startTraining`,
 * `stopTraining` / `cancelTraining` (`connectStore.stopJob` / `cancelJob`) and
 * `src/components/connect/RemoteOutputFolder.tsx` @ c97c6a5. Planning: `pose/connect/remote-training-plan.js`.
 *
 * LUCID changes:
 *  - videos of EVERY included session are placed (one `resolveViewVideos` per session, the same
 *    rules / shared folders / `fs.stat` as remote inference); one Locate on worker… per session
 *    root records a rule for the whole root (`inferLocateRule`);
 *  - the output folder is chosen as for remote inference (`defaultOutputDir`); the worker puts
 *    the run folders in `<output folder>/models/`;
 *  - Stop Early sends `jobs.cancel {mode:"stop"}` to the running train job only (the run carries
 *    on with the next model, as locally); Cancel sends `mode:"cancel"` to every active train job
 *    of this run.
 */
import { useConnectStore, pathRulesFor } from '../../pose/connect/store.js?v=150232616334';
import { lucidProjectTag } from '../../pose/connect/project-tag.js?v=150232616334';
import { defaultOutputDir } from '../../pose/connect/remote-output-dir.js?v=150232616334';
import { VIDEO_EXTENSIONS, resolveViewVideos, describeViewStatus, inferLocateRule, sessionRootOf } from '../../pose/connect/remote-inference-plan.js?v=150232616334';
import { openRemoteFileBrowser } from './remote-file-browser.js?v=150232616334';

function S() { return useConnectStore.getState(); }

/**
 * @param {{
 *   sessions: () => Array<{index: number, session: Object}>,
 *   viewDescriptors: (sessionIndex: number) => Array<{view: string, fileName: string, fileSize: number|null, relPath: string, videoPath: string}>,
 *   getProjectInfo: () => {fileName: string|null, sessionFolders: string[]},
 *   onChange: () => void,
 * }} host
 */
export function createRemoteTraining(host) {
    const views = { byKey: {}, busy: false, error: null, token: 0, key: '' };
    const out = { dir: null, source: null, checking: false, token: 0, key: '' };
    const run = { startedAt: 0, cancelled: false };
    let clientSeq = 0;
    const clientIds = new WeakMap();

    function changed() { host.onChange(); }
    function workerId() { return S().selectedWorkerId; }
    function connected() { return S().connectionStatus === 'connected' && !!workerId(); }
    function clientId() {
        const c = S()._client;
        if (!c) return 0;
        if (!clientIds.has(c)) clientIds.set(c, ++clientSeq);
        return clientIds.get(c);
    }
    function mountPaths() { return S().workerMounts.map(function (m) { return m.path; }); }
    function mountLabels() {
        const o = {};
        S().workerMounts.forEach(function (m) { if (m.label) o[m.path] = m.label; });
        return o;
    }
    function tag() {
        const p = host.getProjectInfo();
        return lucidProjectTag({ fileName: p.fileName, sessionFolders: p.sessionFolders });
    }
    function key(sIdx, view) { return sIdx + ':' + view; }

    // ----------------------------------------------------------------- videos on the worker

    function resolveKey() {
        const id = workerId();
        return [id, connected(), clientId(), mountPaths().join(','), JSON.stringify(pathRulesFor(id)),
            host.sessions().map(function (s) {
                return s.index + '=' + host.viewDescriptors(s.index).map(function (d) { return d.view + ':' + (d.relPath || '') + ':' + (d.videoPath || ''); }).join(',');
            }).join('|')].join('\u0001');
    }

    function resolveViews() {
        const token = ++views.token;
        views.busy = true; views.error = null;
        changed();
        const id = workerId();
        Promise.all(host.sessions().map(function (s) {
            const descs = host.viewDescriptors(s.index);
            return resolveViewVideos(descs, {
                rules: pathRulesFor(id), mounts: mountPaths(), sessionName: s.session.name,
                stat: function (p) { return S().statWorkerPath(p); },
            }).then(function (res) { return { index: s.index, res: res }; });
        })).then(function (all) {
            if (token !== views.token) return;
            views.byKey = {};
            all.forEach(function (x) { x.res.forEach(function (r) { views.byKey[key(x.index, r.view)] = r; }); });
        }, function (e) {
            if (token !== views.token) return;
            views.byKey = {};
            views.error = 'Could not check the worker: ' + ((e && e.message) || e);
        }).then(function () { if (token === views.token) { views.busy = false; changed(); } });
    }

    /** The worker path of a (session, view)'s video, once found there. */
    function workerVideo(sIdx, view) {
        const r = views.byKey[key(sIdx, view)];
        return r && r.visible ? r.worker : null;
    }
    /** The short status line of a (session, view): its worker path, or why it has none. */
    function videoStatus(sIdx, view) {
        if (!connected()) return '';
        const r = views.byKey[key(sIdx, view)];
        if (!r) return views.busy ? 'checking on the worker…' : '';
        return describeViewStatus(r);
    }
    function canLocate(sIdx, view) {
        const r = views.byKey[key(sIdx, view)];
        return connected() && !!r && !r.visible && !!r.local;
    }

    async function locate(sIdx, view) {
        const r = views.byKey[key(sIdx, view)];
        if (!connected() || !r || !r.local) return;
        const sess = host.sessions().find(function (s) { return s.index === sIdx; });
        const picked = await openRemoteFileBrowser({
            workerId: workerId(), mounts: mountPaths(), mountLabels: mountLabels(), mode: 'file',
            fileFilter: VIDEO_EXTENSIONS, title: 'Locate ' + view + ' on the worker',
        });
        if (!picked) return;
        const root = sessionRootOf(host.viewDescriptors(sIdx), sess ? sess.session.name : '');
        S().addPathRule(workerId(), inferLocateRule(r.local, picked, root));
        // The rule change re-keys `sync()`, which places every view again.
    }

    // ----------------------------------------------------------------- output folder

    function outKey() {
        const id = workerId();
        const w = S().pairedWorkers.find(function (x) { return x.nodeId === id; });
        return [id, connected(), clientId(), tag().id, w && w.outputDirs ? w.outputDirs[tag().id] || '' : '',
            JSON.stringify(pathRulesFor(id)), mountPaths().join(',')].join('\u0001');
    }

    function firstSessionRoot() {
        const s = host.sessions()[0];
        return s ? sessionRootOf(host.viewDescriptors(s.index), s.session.name) : 'session';
    }

    function resolveOutput() {
        const token = ++out.token;
        const id = workerId();
        const w = S().pairedWorkers.find(function (x) { return x.nodeId === id; });
        const chosen = w && w.outputDirs ? w.outputDirs[tag().id] : null;
        if (chosen) { out.dir = chosen; out.source = 'chosen'; out.checking = false; changed(); return; }
        out.checking = true; out.dir = null; out.source = null;
        changed();
        (async function () {
            const client = await S().clientFor(id);
            const facts = await client.fsMountsAndServeFolder();
            const info = host.getProjectInfo();
            const name = info.fileName || 'untitled.slp';
            const isDir = async function (p) {
                try { const st = await client.fsStat(p); return st.type === 'directory' && st.shared; } catch (e) { return false; }
            };
            return defaultOutputDir({
                projectPath: firstSessionRoot() + '/' + name, projectName: name, rules: pathRulesFor(id),
                mounts: facts.mounts.map(function (m) { return m.path; }), serveFolder: facts.serveFolder, isSharedFolder: isDir,
            });
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

    /** Re-check what changed (worker, rules, sessions): call from the panel's refresh. */
    function sync() {
        if (!connected()) {
            if (views.key !== '') { views.key = ''; views.byKey = {}; views.error = null; }
            if (out.key !== '') { out.key = ''; out.dir = null; out.source = null; }
            return;
        }
        const k = resolveKey();
        if (k !== views.key) { views.key = k; resolveViews(); }
        const ok = outKey();
        if (ok !== out.key) { out.key = ok; resolveOutput(); }
    }

    // ----------------------------------------------------------------- jobs

    function activeTrainJobs() {
        const id = workerId();
        return S().trackedJobs.filter(function (j) {
            return j.workerId === id && j.kind === 'train' && j.state === 'active' && (j.submittedAt || 0) >= run.startedAt;
        });
    }

    /** Begin a run: jobs submitted from now on belong to it. */
    function beginRun() { run.startedAt = Date.now() - 1; run.cancelled = false; }

    /**
     * Submit one group's spec and wait for its last model (the store splits it per model).
     * @returns {Promise<{success: boolean, modelDir?: string, error?: string, jobId?: string}>}
     */
    function submitGroup(spec, cb) {
        return S().submitJob(spec, function (line, progress) { cb.onLog(line, progress); }, {
            onTelemetry: cb.onTelemetry,
            onModelComplete: cb.onModelComplete,
            projectTag: tag().id,
        });
    }

    /** Stop Early: the running train job only; sleap-nn saves the model and the run goes on. */
    async function stopCurrent() {
        const jobs = activeTrainJobs();
        if (!jobs.length) return false;
        const j = jobs[jobs.length - 1];
        await S().cancelJobOn(j.workerId, j.jobId, 'stop');
        return true;
    }

    /** Cancel: every active train job of this run, at once. */
    async function cancelAll() {
        run.cancelled = true;
        for (const j of activeTrainJobs()) {
            try { await S().cancelJobOn(j.workerId, j.jobId, 'cancel'); } catch (e) { /* the job may have ended meanwhile */ }
        }
    }

    /** Why a remote run cannot start, or ''. */
    function whyNot() {
        if (!workerId()) return 'Select a worker';
        if (!connected()) return S().connectionStatus === 'connecting' ? 'Connecting to the worker…' : 'Connect to the worker first';
        if (views.busy) return 'Checking video visibility on the worker...';
        if (views.error) return views.error;
        if (out.checking) return 'Checking the output folder on the worker…';
        return '';
    }

    return {
        sync: sync, connected: connected, workerId: workerId, tag: tag,
        workerVideo: workerVideo, videoStatus: videoStatus, canLocate: canLocate, locate: locate,
        outputDir: function () { return out.dir; }, outputSource: function () { return out.source; },
        outputChecking: function () { return out.checking; },
        chooseOutputDir: chooseOutputDir, resetOutputDir: resetOutputDir,
        beginRun: beginRun, submitGroup: submitGroup, stopCurrent: stopCurrent, cancelAll: cancelAll,
        cancelled: function () { return run.cancelled; }, whyNot: whyNot,
        _state: function () { return { views: views, out: out, run: run }; },
    };
}
