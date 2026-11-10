/**
 * ui/connect/new-job-wizard.js — the New job wizard (Inference only).
 *
 * Port of sleap-app src/components/connect/NewJobWizard.tsx @ 683a159 (§5b.2):
 * "New job on <worker>" / "Starts a job on data that already lives on this
 * worker.", the Train | Inference job-kind choice, the Models list (every
 * finished training run on the worker, plus "Browse model folder on <worker>…";
 * chosen folders show as removable chips), "Inference on" (target + sample
 * count), the summary box, Cancel / "Add to queue" ("Adding…"), the success card
 * ("Added to <worker>'s queue." Add another / Done) and the toasts "Added to
 * <worker> queue" / "Couldn't submit inference job". The Inference helpers it
 * shares with sleap-app live in `pose/connect/worker-ui-helpers.js`
 * (`groupCompletedRuns`, `labelPastRuns`, `WORKER_FILE_INFERENCE_TARGETS`) and
 * the spec building in `pose/connect/new-job-plan.js`.
 *
 * LUCID changes:
 *  - TRAINING is out of scope for LUCID, so Train is shown disabled (sleap-app
 *    always offers it) with a one-line note, and the Train path (config starting
 *    points, Edit hyperparameters, post-train inference, the training config
 *    dialog) is not ported. `RemoteDataSummary`, `RemoteOutputFolder` and
 *    `HiddenVideosDialog` belong to the Training panel's remote mode, not to this
 *    wizard, so they are not ported either.
 *  - A Data source choice: "This project" runs the current session through the
 *    Inference panel's own remote run (one `track` job per view, explicit
 *    `output_path`, the panel's frame choice, merge mode and project/session/camera
 *    tags; the results come back with Fetch & Load Results in the panel or the Jobs
 *    tab); the models picked here replace the panel's model list for that run
 *    (`runRemoteInferenceWithModels`, `ui/inference-panel.js`). That run reads the selected Backend only
 *    (views, mounts, path rules, output folder), so for a worker that is not the Backend the wizard selects
 *    it for the run, says so on the project line, and selects the previous Backend again afterwards
 *    (nothing to restore when none was selected). "A file on <worker>"
 *    is sleap-app's flow: a worker `.slp` (labels) or a worker VIDEO (a plain track
 *    job with no LUCID view tag; save or merge its results later from the Jobs tab).
 *  - A worker `.slp`'s structure is not read (no summary line, no missing-video
 *    check, no "Locate on worker…" for its videos, no "Random sample"): sleap-app's
 *    `workerLabels.ts` reads it with sleap-io's `readSlpStreaming` over a
 *    `RangeSource`, which needs SharedArrayBuffer, and LUCID's page is not
 *    cross-origin isolated. The worker reads the file's videos itself.
 *  - vanilla DOM modal (scrim + card, Esc closes, Tab trapped, `data-shortcut-modal`).
 *
 * Exports: openNewJobWizard, seedWizardFromRun, groupCompletedRuns, labelPastRuns,
 * WORKER_FILE_INFERENCE_TARGETS.
 *
 * Opened from `ui/connect/worker-jobs.js` ("+ New job", "Run again").
 */
import { useConnectStore } from '../../pose/connect/store.js';
import {
    WORKER_FILE_INFERENCE_TARGETS, basename, groupCompletedRuns, labelPastRuns,
} from '../../pose/connect/worker-ui-helpers.js';
import { timeAgo } from '../../pose/connect/timestamp.js';
import {
    VIDEO_EXTENSIONS, buildWorkerFileSpecs, fileSourceBlocker, inferenceTargetsFor,
    seedWizardFromRun, workerFileKind,
} from '../../pose/connect/new-job-plan.js';
import { INFERENCE_DEFAULTS } from '../inference-args.js';
import { state as appState } from '../app-state.js';
import { openRemoteFileBrowser } from './remote-file-browser.js';
import { notify } from './notify.js';
import { layerAbove } from './layers.js';

export { seedWizardFromRun, groupCompletedRuns, labelPastRuns, WORKER_FILE_INFERENCE_TARGETS };

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

let openWizard = null;

/**
 * Open the wizard on `workerId`. Resolves when it closes (Cancel, Done, Esc). A second call while one is
 * open returns the first one's promise.
 *
 * @param {{
 *   workerId: string,
 *   workerLabel: string,
 *   seed?: {labelsPath: string, modelType?: string, configs?: any[]} | null,
 * }} opts `seed` pre-fills the file ("Run again"); the user can still change everything.
 * @returns {Promise<void>}
 */
export function openNewJobWizard(opts) {
    if (openWizard) return openWizard;
    const workerId = opts.workerId;
    const workerLabel = opts.workerLabel;
    const seed = opts.seed || null;
    const S = function () { return useConnectStore.getState(); };

    openWizard = new Promise(function (resolve) {
        // ---- state ----
        const st = {
            source: seed && seed.labelsPath ? 'file' : (appState.session ? 'project' : 'file'),
            filePath: seed && seed.labelsPath ? seed.labelsPath : null,
            target: 'suggestions',
            start: 0,
            end: 999,
            mounts: [],
            completedRuns: [],
            selectedRunId: null,
            loadingRunModels: false,
            modelDirs: [],
            modelHeadTypes: [],
            submitting: false,
            justSubmitted: false,
            error: null,
        };
        let closed = false;

        // ---- skeleton ----
        const scrim = el('div', 'njw-scrim');
        scrim.id = 'newJobWizard';
        scrim.setAttribute('data-shortcut-modal', '1');
        const card = el('div', 'njw-card');
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-label', 'New job on ' + workerLabel);
        card.tabIndex = -1;
        scrim.appendChild(card);

        const header = el('div', 'njw-header');
        header.append(el('h3', 'njw-title', 'New job on ' + workerLabel), el('p', 'njw-desc', 'Starts a job on data that already lives on this worker.'));
        const form = el('div', 'njw-form');
        const done = el('div', 'njw-done');
        done.hidden = true;
        card.append(header, form, done);

        // job kind
        const kindRow = el('div', 'njw-kinds');
        const trainBtn = el('button', 'btn btn-sm njw-kind', 'Train');
        trainBtn.type = 'button'; trainBtn.id = 'njwKindTrain'; trainBtn.disabled = true;
        trainBtn.title = 'Training isn’t available in LUCID.';
        const infBtn = el('button', 'btn btn-sm njw-kind njw-on', 'Inference');
        infBtn.type = 'button'; infBtn.id = 'njwKindInference';
        kindRow.append(trainBtn, infBtn);
        const trainNote = el('p', 'njw-muted njw-note', 'Training isn’t available in LUCID: train with SLEAP, then run inference here.');
        trainNote.id = 'njwTrainNote';

        // data source
        const srcBox = el('div', 'njw-sect');
        srcBox.appendChild(el('p', 'njw-caps', 'Data'));
        const srcRow = el('div', 'njw-kinds');
        const srcProject = el('button', 'btn btn-sm njw-kind', 'This project');
        srcProject.type = 'button'; srcProject.id = 'njwSrcProject';
        const srcFile = el('button', 'btn btn-sm njw-kind', 'A file on ' + workerLabel);
        srcFile.type = 'button'; srcFile.id = 'njwSrcFile';
        srcRow.append(srcProject, srcFile);
        const srcDetail = el('div', 'njw-src-detail');
        // project detail
        const projLine = el('p', 'njw-muted'); projLine.id = 'njwProjectLine';
        // file detail
        const fileRow = el('div', 'njw-filerow');
        const filePathBox = el('div', 'njw-path'); filePathBox.id = 'njwFilePath';
        const browseFile = el('button', 'btn btn-sm njw-btn', 'Browse…');
        browseFile.type = 'button'; browseFile.id = 'njwBrowseFile';
        fileRow.append(el('div', 'njw-pathwrap'), browseFile);
        fileRow.firstChild.appendChild(filePathBox);
        const fileNote = el('p', 'njw-muted njw-note'); fileNote.id = 'njwFileNote';
        srcDetail.append(projLine, fileRow, fileNote);
        srcBox.append(srcRow, srcDetail);

        // models
        const modelsBox = el('div', 'njw-sect');
        modelsBox.appendChild(el('p', 'njw-caps', 'Models'));
        const runList = el('div', 'njw-stack'); runList.id = 'njwRuns';
        const browseModel = el('button', 'btn btn-sm njw-btn njw-wide', 'Browse model folder on ' + workerLabel + '…');
        browseModel.type = 'button'; browseModel.id = 'njwBrowseModel';
        const dirList = el('div', 'njw-stack'); dirList.id = 'njwModelDirs';
        modelsBox.append(runList, browseModel, dirList);

        // inference on
        const onBox = el('div', 'njw-sect');
        onBox.appendChild(el('p', 'njw-caps', 'Inference on'));
        const onRow = el('div', 'njw-onrow');
        const targetSel = el('select', 'njw-select'); targetSel.id = 'njwTarget';
        targetSel.setAttribute('aria-label', 'Inference on');
        const startIn = el('input', 'njw-num'); startIn.type = 'number'; startIn.min = '0'; startIn.step = '1'; startIn.id = 'njwStart';
        startIn.setAttribute('aria-label', 'First frame');
        const endIn = el('input', 'njw-num'); endIn.type = 'number'; endIn.min = '0'; endIn.step = '1'; endIn.id = 'njwEnd';
        endIn.setAttribute('aria-label', 'Last frame');
        const dash = el('span', 'njw-muted', '–');
        onRow.append(targetSel, startIn, dash, endIn);
        const onNote = el('p', 'njw-muted njw-note'); onNote.id = 'njwOnNote';
        onBox.append(onRow, onNote);

        // summary
        const summary = el('div', 'njw-summary'); summary.id = 'njwSummary';

        // errors + footer
        const errBox = el('p', 'njw-error'); errBox.id = 'njwError';
        const why = el('p', 'njw-muted njw-note'); why.id = 'njwWhy';
        const foot = el('div', 'njw-foot');
        const cancel = el('button', 'btn njw-btn', 'Cancel'); cancel.type = 'button'; cancel.id = 'njwCancel';
        const submit = el('button', 'btn btn-primary', 'Add to queue'); submit.type = 'button'; submit.id = 'njwSubmit';
        foot.append(cancel, submit);

        form.append(kindRow, trainNote, srcBox, modelsBox, onBox, summary, errBox, why, foot);

        // success card
        const okBox = el('div', 'njw-ok'); okBox.id = 'njwOk';
        const okFoot = el('div', 'njw-foot');
        const another = el('button', 'btn njw-btn', 'Add another'); another.type = 'button'; another.id = 'njwAnother';
        const doneBtn = el('button', 'btn btn-primary', 'Done'); doneBtn.type = 'button'; doneBtn.id = 'njwDone';
        okFoot.append(another, doneBtn);
        done.append(okBox, okFoot);

        // ---- helpers ----
        function kind() { return st.source === 'file' ? workerFileKind(st.filePath) : 'slp'; }
        function targets() { return st.source === 'file' ? inferenceTargetsFor(kind()) : []; }
        function ensureTarget() {
            const ts = targets();
            if (ts.length && !ts.some(function (t) { return t.value === st.target; })) st.target = ts[0].value;
        }
        function targetLabel() {
            const t = targets().find(function (x) { return x.value === st.target; });
            return t ? t.label.toLowerCase() : st.target;
        }
        function sessionViews() { return appState.session && appState.views ? appState.views : []; }
        function blocker() {
            if (st.submitting) return 'Adding…';
            if (st.source === 'project') {
                if (!appState.session) return 'Open a session first.';
                if (st.modelDirs.length === 0) return 'Add a model folder.';
                return '';
            }
            return fileSourceBlocker({
                path: st.filePath, modelDirs: st.modelDirs, target: st.target, start: st.start, end: st.end,
            });
        }
        function close() {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKey, true);
            scrim.remove();
            openWizard = null;
            resolve();
        }

        // ---- paint ----
        function paint() {
            ensureTarget();
            const isFile = st.source === 'file';
            srcProject.classList.toggle('njw-on', !isFile);
            srcFile.classList.toggle('njw-on', isFile);
            projLine.hidden = isFile; fileRow.hidden = !isFile; fileNote.hidden = !isFile;
            if (!isFile) {
                const n = sessionViews().length;
                const sel = S().selectedWorkerId;
                const prevW = sel && sel !== workerId ? S().pairedWorkers.find(function (w) { return w.nodeId === sel; }) : null;
                projLine.textContent = appState.session
                    ? appState.session.name + ' · ' + n.toLocaleString('en-US') + ' view' + (n === 1 ? '' : 's') +
                        ': one job per view, with the Inference panel’s views, frames and options. Fetch & Load Results brings the predictions back.' +
                        (sel !== workerId ? ' This runs through the Inference panel, so ' + workerLabel + ' becomes the Backend while the jobs are added' +
                            (prevW ? '; ' + prevW.label + ' is selected again afterwards.' : '.') : '')
                    : 'Open a session first.';
            } else {
                filePathBox.textContent = st.filePath || 'No file selected';
                const k = kind();
                fileNote.textContent = !st.filePath ? ''
                    : k === 'video' ? 'A video: runs a plain track job on it. Save or merge its results later from the Jobs tab.'
                        : k === 'slp' ? 'A labels file: its videos are read on ' + workerLabel + '. Its contents are not summarized here.'
                            : 'Pick a .slp or a video file.';
                fileNote.hidden = !fileNote.textContent;
            }

            // models
            runList.textContent = '';
            st.completedRuns.forEach(function (run) {
                const b = el('button', 'btn btn-sm njw-btn njw-wide njw-left' + (st.selectedRunId === run.runId ? ' njw-on' : ''),
                    run.modelTypes.join(' + ') + ' · ' + (basename(run.labelsPath) || '—') + ' · ' + timeAgo(run.createdAt));
                b.type = 'button'; b.disabled = st.loadingRunModels || st.submitting; b.dataset.runId = run.runId;
                b.addEventListener('click', function () { void chooseModelsFromRun(run); });
                runList.appendChild(b);
            });
            browseModel.disabled = st.submitting;
            dirList.textContent = '';
            st.modelDirs.forEach(function (dir) {
                const row = el('div', 'njw-chip');
                const name = el('span', 'njw-chip-name', dir); name.title = dir;
                const x = el('button', 'njw-x'); x.type = 'button'; x.setAttribute('aria-label', 'Remove ' + dir); x.textContent = '×';
                x.addEventListener('click', function () { removeModelDir(dir); });
                row.append(name, x);
                dirList.appendChild(row);
            });

            // inference on
            onBox.hidden = !isFile;
            if (isFile) {
                const ts = targets();
                if (targetSel.options.length !== ts.length || Array.from(targetSel.options).some(function (o, i) { return o.value !== ts[i].value; })) {
                    targetSel.textContent = '';
                    ts.forEach(function (t) { const o = el('option', null, t.label); o.value = t.value; targetSel.appendChild(o); });
                }
                targetSel.value = st.target;
                const range = st.target === 'range';
                startIn.hidden = !range; endIn.hidden = !range; dash.hidden = !range;
                onNote.textContent = st.filePath && kind() === 'slp'
                    ? 'Random sample isn’t offered: the file isn’t read here, so its frame counts are unknown.' : '';
                onNote.hidden = !onNote.textContent;
            }

            // summary
            summary.textContent = '';
            if (isFile ? !!st.filePath : !!appState.session) {
                const l1 = el('span', null, 'Inference · ' + st.modelDirs.length + ' model dir' + (st.modelDirs.length === 1 ? '' : 's'));
                const l2 = el('span', 'njw-mono njw-trunc', isFile ? (kind() === 'video' ? 'Video: ' : 'Labels: ') + st.filePath : 'Project: ' + appState.session.name);
                if (isFile) l2.title = (kind() === 'video' ? 'Video: ' : 'Labels: ') + st.filePath;
                const l3 = el('span', 'njw-muted', isFile ? 'On: ' + targetLabel() : 'On: the Inference panel’s frame choice');
                summary.append(l1, l2, l3);
                summary.hidden = false;
            } else summary.hidden = true;

            errBox.textContent = st.error || ''; errBox.hidden = !st.error;
            const b = blocker();
            submit.disabled = !!b;
            submit.textContent = st.submitting ? 'Adding…' : 'Add to queue';
            why.textContent = st.submitting ? '' : b; why.hidden = !why.textContent;
            cancel.disabled = false;
        }

        // ---- model bookkeeping (sleap-app's handlers) ----
        async function chooseModelsFromRun(run) {
            st.selectedRunId = run.runId; st.loadingRunModels = true; st.error = null; paint();
            try {
                const details = await Promise.all(run.jobIds.map(function (id) { return S().jobDetail(workerId, id); }));
                const dirs = details.map(function (d) { return d.result && d.result.model_dir; }).filter(function (d) { return !!d; });
                if (dirs.length !== run.jobIds.length) {
                    notify.error('Couldn\'t find this run\'s trained model(s).');
                    st.selectedRunId = null;
                    return;
                }
                st.modelDirs = dirs; st.modelHeadTypes = run.modelTypes;
            } catch (err) {
                notify.error('Couldn\'t read that job\'s configuration.', { description: err instanceof Error ? err.message : String(err) });
                st.selectedRunId = null;
            } finally {
                st.loadingRunModels = false; if (!closed) paint();
            }
        }
        function removeModelDir(path) {
            st.modelDirs = st.modelDirs.filter(function (d) { return d !== path; });
            st.selectedRunId = null; st.error = null; paint();
        }

        let mountsReady = Promise.resolve();
        async function browse(mode, fileFilter, title) {
            // LUCID: Browse clicked before fs.mounts answered would open the browser with "No shared folders".
            await mountsReady;
            const picked = await openRemoteFileBrowser({
                workerId: workerId, mounts: st.mounts.map(function (m) { return m.path; }), mountLabels: labelsOf(st.mounts),
                mode: mode, fileFilter: fileFilter, title: title,
            });
            return closed ? null : picked;
        }
        function labelsOf(ms) { const o = {}; ms.forEach(function (m) { if (m.label) o[m.path] = m.label; }); return o; }

        // ---- submit ----
        async function submitInference() {
            if (blocker()) return;
            st.submitting = true; st.error = null; paint();
            try {
                if (st.source === 'project') await submitProject(); else await submitFile();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                st.error = msg;
                notify.error('Couldn\'t submit inference job', { description: msg });
            } finally {
                st.submitting = false;
                if (!closed) paint();
            }
        }

        async function submitFile() {
            const specs = buildWorkerFileSpecs({
                path: st.filePath, modelDirs: st.modelDirs, headTypes: st.modelHeadTypes, target: st.target,
                start: st.start, end: st.end, defaults: INFERENCE_DEFAULTS,
            });
            if (!specs) throw new Error('Pick a .slp or a video file.');
            for (const spec of specs) await S().submitJobsOn(workerId, spec, { source: 'worker-file' });
            notify.success('Added to ' + workerLabel + ' queue', { description: 'Inference on ' + basename(st.filePath) });
            showDone('Added to ' + workerLabel + '’s queue.');
        }

        async function submitProject() {
            const s = S();
            // The panel's remote run works on the selected Backend only, so this worker is selected for the
            // run (the wizard says so) and the previous Backend is selected again once the jobs are submitted.
            const prev = s.selectedWorkerId;
            let r;
            try {
                if (s.selectedWorkerId !== workerId || s.connectionStatus !== 'connected') await s.selectWorker(workerId);
                const now = S();
                if (now.selectedWorkerId !== workerId || now.connectionStatus !== 'connected') {
                    throw new Error('Connect to ' + workerLabel + ' first.');
                }
                const mod = await import('../inference-panel.js');
                r = await mod.runRemoteInferenceWithModels(st.modelDirs.slice());
            } finally {
                if (prev && prev !== workerId) {
                    try { await S().selectWorker(prev); } catch (e) { /* the old Backend is gone: stay on this one */ }
                }
            }
            if (!r.ok) throw new Error(r.error);
            const n = r.jobs;
            notify.success('Added to ' + workerLabel + ' queue', { description: 'Inference on ' + appState.session.name + ' (' + n.toLocaleString('en-US') + ' view' + (n === 1 ? '' : 's') + ')' });
            showDone('Added to ' + workerLabel + '’s queue. Fetch & Load Results (Inference panel) brings the predictions back.');
        }

        function showDone(text) {
            st.justSubmitted = true;
            okBox.textContent = text;
            form.hidden = true; done.hidden = false;
            doneBtn.focus();
        }

        // ---- events ----
        trainBtn.addEventListener('click', function () { /* disabled */ });
        srcProject.addEventListener('click', function () { st.source = 'project'; st.error = null; paint(); });
        srcFile.addEventListener('click', function () { st.source = 'file'; st.error = null; paint(); });
        browseFile.addEventListener('click', async function () {
            const p = await browse('file', ['.slp'].concat(VIDEO_EXTENSIONS), 'Select a labels or video file on the worker');
            if (!p) return;
            st.filePath = p; st.error = null; ensureTarget(); paint();
        });
        browseModel.addEventListener('click', async function () {
            const p = await browse('directory', undefined, 'Select Model Directory on the worker');
            if (!p) return;
            if (st.modelDirs.indexOf(p) === -1) st.modelDirs = st.modelDirs.concat([p]);
            st.selectedRunId = null; st.error = null; paint();
        });
        targetSel.addEventListener('change', function () { st.target = targetSel.value; st.error = null; paint(); });
        startIn.addEventListener('input', function () { st.start = startIn.value === '' ? NaN : Number(startIn.value); paint(); });
        endIn.addEventListener('input', function () { st.end = endIn.value === '' ? NaN : Number(endIn.value); paint(); });
        startIn.value = String(st.start); endIn.value = String(st.end);
        cancel.addEventListener('click', close);
        submit.addEventListener('click', function () { void submitInference(); });
        doneBtn.addEventListener('click', close);
        another.addEventListener('click', function () {
            st.justSubmitted = false; st.error = null; form.hidden = false; done.hidden = true; paint();
        });
        scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });

        function focusables() {
            return Array.from(card.querySelectorAll('button, input, select, textarea, [tabindex]'))
                .filter(function (n) { return !n.disabled && n.tabIndex >= 0 && !n.closest('[hidden]') && n.offsetParent !== null; });
        }
        function onKey(e) {
            if (closed) return;
            // The worker file browser (or a confirm) on top owns Esc and Tab.
            if (document.getElementById('remoteFileBrowser') || layerAbove(scrim)) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key === 'Tab') {
                e.stopPropagation();
                const f = focusables();
                const a = document.activeElement;
                if (f.length === 0) { e.preventDefault(); card.focus(); return; }
                const first = f[0], last = f[f.length - 1];
                if (!card.contains(a) || a === card) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
                else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
            }
        }
        document.addEventListener('keydown', onKey, true);

        // ---- load ----
        document.body.appendChild(scrim);
        paint();
        card.focus();
        mountsReady = S().mountsFor(workerId).then(function (m) { if (!closed) { st.mounts = m; paint(); } }, function () { /* sleap-app ignores it */ });
        void S().listJobs(workerId).then(function (jobs) {
            if (closed) return;
            st.completedRuns = groupCompletedRuns(jobs).sort(function (a, b) { return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(); });
            paint();
        }, function () { /* sleap-app ignores it */ });
        // Test hook: the live state (read-only use).
        scrim._wizardState = st;
    });
    return openWizard;
}
