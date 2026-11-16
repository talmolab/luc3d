/**
 * ui/connect/worker-jobs.js — the Connect window's Jobs tab: every job on a worker, this project's runs
 * pinned first (★) and live, others view-only.
 *
 * Port of sleap-app src/components/connect/WorkerJobs.tsx @ 683a159 (§4b.4), string for string: search,
 * "+ New job", one card per run (chip, times, Cancel run, Remove), a row per job with Watch live / View /
 * Logs / Stop Early / Cancel / Run again / Fetch & Load by the same rules (`pose/connect/job-groups.js`).
 * Polls every 10 s; run cards repaint only when their signature changes (scroll, focus and search
 * survive); a `focusRun` scrolls to a run and rings it.
 *
 * LUCID changes:
 *  - "this project" = `lucidProjectTag(openProjectInfo())`; a tracked job shows its view after the title;
 *  - Run again is hidden on a failed TRAIN job (Inference-only wizard);
 *  - Fetch & Load connects first when needed, then `loadJobPredictions`; confirms via `ui/ask.js`.
 */
import { useConnectStore } from '../../pose/connect/store.js';
import { lucidProjectTag } from '../../pose/connect/project-tag.js';
import {
    isManagedJob, siblingJobIds, jobTitle, canDeleteRun, deleteRunMessage, statusChipFor, jobStatusChip,
    jobTimeLabel, groupTimeLabel, groupJobs, jobMatches, isActiveGroup, unfinishedJobs, cancelRunConfirm,
    endJobConfirm,
} from '../../pose/connect/job-groups.js';
import { DEFAULT_POLL_MS } from '../../pose/connect/worker-ui-helpers.js';
import { askConfirm } from '../ask.js';
import { railIconSvg } from '../panel-rail-icons.js';
import { notify } from './notify.js';
import { openJobViewer } from './job-viewer.js';
import { loadJobPredictions } from './merge-predictions-dialog.js';
import { openProjectInfo } from './remote-inference.js';
import * as wizard from './new-job-wizard.js';
import { el, button, errMsg } from './dom.js';

function confirmOpts(req) { return { title: req.title, okLabel: req.confirmLabel, cancelLabel: req.cancelLabel }; }

/**
 * The seed "Run again" opens the wizard with: the run's own config, from every sibling model's job
 * detail (sleap-app `seedWizardFromRun`). The wizard's own `seedWizardFromRun` (it owns the YAML
 * parser `seedFromJobSpec` needs) is used when it exports one; otherwise the raw spec is the seed.
 * Resolves null when no labels path or no config can be read.
 */
async function seedFromRun(workerId, ids) {
    const jobDetail = useConnectStore.getState().jobDetail;
    if (typeof wizard.seedWizardFromRun === 'function') return wizard.seedWizardFromRun(jobDetail, workerId, ids);
    const details = await Promise.all(ids.map(function (id) { return jobDetail(workerId, id); }));
    const configContents = [], modelTypes = [];
    details.forEach(function (d) {
        const spec = d.spec || {};
        (spec.config_contents || []).forEach(function (c) { configContents.push(c); });
        (spec.model_types || []).forEach(function (m) { modelTypes.push(m); });
    });
    const labelsPath = details[0] && details[0].labelsPath;
    if (!labelsPath || !configContents.length) return null;
    return { labelsPath: labelsPath, spec: { config_contents: configContents, model_types: modelTypes } };
}

/** The seed of a non-train job: its data file. Null when the worker reports none. */
async function seedFromFile(workerId, jobId) {
    const d = await useConnectStore.getState().jobDetail(workerId, jobId);
    return d && d.labelsPath ? { labelsPath: d.labelsPath, modelType: '', configs: [] } : null;
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   workerId: string, workerLabel?: string, refreshToken?: number,
 *   focusRun?: {key: string, nonce: number} | null,
 *   pollIntervalMs?: number,
 *   setIntervalImpl?: (cb: () => void, ms: number) => unknown,
 *   clearIntervalImpl?: (h: unknown) => void,
 * }} props
 * @returns {{ update: (p: object) => void, destroy: () => void, refresh: () => Promise<void> }}
 */
export function createWorkerJobs(container, props) {
    let p = Object.assign({ refreshToken: 0, focusRun: null }, props);
    const setIntervalImpl = p.setIntervalImpl || function (cb, ms) { return setInterval(cb, ms); };
    const clearIntervalImpl = p.clearIntervalImpl || function (h) { clearInterval(h); };
    const pollMs = p.pollIntervalMs || DEFAULT_POLL_MS;
    const S = function () { return useConnectStore.getState(); };

    let jobs = [], loading = true, error = null, query = '';
    let busyJobId = null, highlightKey = null, highlightTimer = 0, findTimer = 0;
    let cancelingRuns = new Set();
    let viewer = null;
    let destroyed = false;
    let pollHandle = null;
    let fetchSeq = 0;
    let lastFocusKey = null;
    /** run key -> {el, sig} */
    const cards = new Map();

    const root = el('div', 'cj-jobs');
    const top = el('div', 'cj-jobs-top');
    const search = el('input', 'cj-input');
    search.type = 'text'; search.id = 'cjJobsSearch';
    search.placeholder = 'Search labels file, job id, run id, or model';
    search.setAttribute('aria-label', 'Search jobs');
    const newBtn = button('connect-btn connect-btn-primary cj-btn-new', '+ New job');
    newBtn.id = 'cjNewJob';
    top.append(search, newBtn);
    const errBox = el('div', 'connect-errbox cj-jobs-err');
    const note = el('p', 'cj-muted');
    const list = el('div', 'cj-jobs-list');
    root.append(top, errBox, note, list);
    container.appendChild(root);

    function label() { return p.workerLabel || p.workerId; }
    function myProjectId() { return lucidProjectTag(openProjectInfo()).id; }
    function trackedFor() { return S().trackedJobs.filter(function (j) { return j.workerId === p.workerId; }); }

    // ------------------------------------------------------------------ data
    async function refresh() {
        const mine = ++fetchSeq;
        const wid = p.workerId;
        try {
            const result = await S().listJobs(wid);
            if (destroyed || mine !== fetchSeq || wid !== p.workerId) return;
            jobs = result; error = null;
        } catch (err) {
            if (destroyed || mine !== fetchSeq || wid !== p.workerId) return;
            error = errMsg(err);
        } finally {
            if (!destroyed && mine === fetchSeq) { loading = false; render(); }
        }
    }

    function startPoll() {
        if (pollHandle !== null) clearIntervalImpl(pollHandle);
        pollHandle = setIntervalImpl(function () { void refresh(); }, pollMs);
    }

    // ------------------------------------------------------------------ actions
    function openViewerFor(job, initialView) {
        if (viewer) viewer.close();
        const tracked = new Set(trackedFor().map(function (j) { return j.jobId; }));
        viewer = openJobViewer({
            workerId: p.workerId, jobId: job.jobId, label: jobTitle(job), kind: job.kind,
            initialView: job.kind === 'track' ? 'logs' : initialView,
            canStop: isManagedJob(job, myProjectId(), tracked),
            onClose: function () { viewer = null; },
        });
    }

    async function endJob(job, mode) {
        const req = endJobConfirm(jobTitle(job), mode, job.state === 'queued');
        if (!(await askConfirm(req.message, confirmOpts(req)))) return;
        try {
            await S().cancelJobOn(p.workerId, job.jobId, mode);
            await refresh();
        } catch (err) {
            notify.error(mode === 'stop' ? 'Failed to stop training early' : 'Failed to cancel job', { description: errMsg(err) });
        }
    }

    async function cancelRun(group) {
        const unfinished = unfinishedJobs(group);
        if (unfinished.length === 0) return;
        const req = cancelRunConfirm(group);
        if (!(await askConfirm(req.message, confirmOpts(req)))) return;
        cancelingRuns = new Set(cancelingRuns).add(group.key);
        render();
        try {
            for (let i = 0; i < unfinished.length; i++) await S().cancelJobOn(p.workerId, unfinished[i].jobId, 'cancel');
        } catch (err) {
            cancelingRuns = new Set(cancelingRuns); cancelingRuns.delete(group.key);
            notify.error('Failed to cancel run', { description: errMsg(err) });
        } finally {
            await refresh();
        }
    }

    async function deleteRun(group) {
        const ok = await askConfirm(deleteRunMessage(group.jobs), {
            title: 'Remove this run from ' + label() + '?', okLabel: 'Remove', cancelLabel: 'Cancel',
        });
        if (!ok) return;
        try {
            await S().deleteJobsOn(p.workerId, group.jobs.map(function (j) { return j.jobId; }));
            await refresh();
        } catch (err) {
            notify.error('Failed to remove run', { description: errMsg(err) });
        }
    }

    async function fetchLoad(job) {
        busyJobId = job.jobId; render();
        try {
            if (S().selectedWorkerId !== p.workerId) await S().connectToWorker(p.workerId);
            await loadJobPredictions({ workerId: p.workerId, jobId: job.jobId, mine: job.project ? job.project.id === myProjectId() : false });
        } catch (err) {
            notify.error('Fetch & Load failed', { description: errMsg(err) });
        } finally {
            busyJobId = null; if (!destroyed) render();
        }
    }

    async function runAgain(job) {
        busyJobId = job.jobId; render();
        try {
            // A track job has no model_types to infer from: the seed is its data file (what the wizard uses).
            const seeded = job.kind === 'train' ? await seedFromRun(p.workerId, siblingJobIds(jobs, job))
                : await seedFromFile(p.workerId, job.jobId);
            if (!seeded) { notify.error("Couldn't read that job's configuration."); return; }
            await openWizard(seeded);
        } catch (err) {
            notify.error("Couldn't read that job's configuration.", { description: errMsg(err) });
        } finally {
            busyJobId = null; if (!destroyed) render();
        }
    }

    async function openWizard(seed) {
        try {
            await wizard.openNewJobWizard({ workerId: p.workerId, workerLabel: label(), seed: seed || null, onSubmitted: function () { void refresh(); } });
        } finally {
            if (!destroyed) void refresh();
        }
    }

    // ------------------------------------------------------------------ rendering
    function btn(text, cls, act, jobId, onClick, disabled) {
        const b = button('connect-btn connect-btn-outline cj-btn ' + (cls || ''), text);
        b.dataset.act = act; b.dataset.fk = act + ':' + (jobId || '');
        if (disabled) b.disabled = true;
        b.addEventListener('click', onClick);
        return b;
    }

    function chipEl(chip, state) {
        return el('span', 'cj-chip cj-chip-' + (['queued', 'running', 'completed', 'failed', 'canceled'].indexOf(state) === -1 ? 'queued' : state), chip.text);
    }

    function jobRow(job, ctx) {
        const managed = isManagedJob(job, ctx.myId, ctx.tracked);
        const chip = jobStatusChip(job);
        const run = job.run && job.run.count > 1 ? 'run ' + (job.run.index + 1) + '/' + job.run.count : null;
        const canWatch = job.state === 'running';
        const canView = job.state === 'completed' || job.state === 'failed' || job.state === 'canceled';
        const canCancel = managed && job.state === 'running';
        const canStopEarly = canCancel && job.kind !== 'track';
        const canFetch = job.kind === 'track' && job.state === 'completed';
        // sleap-app offers Run again on a failed TRAIN job (it re-seeds the training wizard). LUCID cannot train, so
        // it is hidden there and offered on a failed job of ours that is not a train job (opens the Inference wizard).
        const canRunAgain = managed && job.kind !== 'train' && job.state === 'failed';
        const trackedJob = ctx.trackedById.get(job.jobId);

        const row = el('div', 'cj-job');
        row.dataset.jobId = job.jobId;
        const head = el('div', 'cj-row');
        const t = el('span', 'cj-job-title', jobTitle(job));
        if (job.postInference) t.appendChild(el('span', 'cj-muted cj-after', '→ inference'));
        head.appendChild(t);
        if (trackedJob && trackedJob.camera) head.appendChild(el('span', 'cj-muted cj-cam', '· ' + trackedJob.camera));
        if (run) head.appendChild(el('span', 'cj-muted cj-tag', run));
        const sid = el('span', 'cj-mono cj-short', job.jobId.slice(0, 8)); sid.title = job.jobId;
        head.appendChild(sid);
        head.appendChild(chipEl(chip, job.state));
        const tl = jobTimeLabel(job);
        if (tl) head.appendChild(el('span', 'cj-muted cj-time', tl));
        row.appendChild(head);
        if (job.modelName) row.appendChild(el('div', 'cj-mono cj-muted cj-model', job.modelName));
        if (job.state === 'failed' && job.error) row.appendChild(el('pre', 'cj-failure', job.error.split('\n')[0]));

        const acts = el('div', 'cj-acts');
        if (canWatch) acts.appendChild(btn('Watch live', '', 'watch', job.jobId, function () { openViewerFor(job, 'monitor'); }));
        if (canView) acts.appendChild(btn('View', '', 'view', job.jobId, function () { openViewerFor(job, 'monitor'); }));
        acts.appendChild(btn('Logs', '', 'logs', job.jobId, function () { openViewerFor(job, 'logs'); }));
        if (canStopEarly) acts.appendChild(btn('Stop Early', 'cj-stop', 'stop', job.jobId, function () { void endJob(job, 'stop'); }));
        if (canCancel) acts.appendChild(btn('Cancel', 'cj-cancel', 'cancel', job.jobId, function () { void endJob(job, 'cancel'); }));
        if (canRunAgain) acts.appendChild(btn('Run again', '', 'again', job.jobId, function () { void runAgain(job); }, busyJobId === job.jobId));
        if (canFetch) {
            const f = btn(busyJobId === job.jobId ? 'Fetching…' : 'Fetch & Load', 'connect-btn-primary', 'fetch', job.jobId, function () { void fetchLoad(job); }, busyJobId === job.jobId);
            f.classList.remove('connect-btn-outline');
            acts.appendChild(f);
        }
        row.appendChild(acts);
        return row;
    }

    function groupSig(group, ctx) {
        return JSON.stringify([
            group.key, group.mine, group.title, group.labelsName, group.project && group.project.name, group.status,
            groupTimeLabel(group), cancelingRuns.has(group.key), highlightKey === group.key, p.workerLabel,
            group.jobs.map(function (j) {
                const tr = ctx.trackedById.get(j.jobId);
                return [j.jobId, j.state, j.queuePosition, jobTimeLabel(j), j.modelName, j.error, j.postInference, j.kind,
                    j.run && j.run.index, j.run && j.run.count, isManagedJob(j, ctx.myId, ctx.tracked), busyJobId === j.jobId, tr && tr.camera];
            }),
        ]);
    }

    function buildCard(group, ctx) {
        const card = el('div', 'cj-run' + (group.mine ? ' mine' : '') + (highlightKey === group.key ? ' cj-hl' : ''));
        card.dataset.runKey = group.key;
        const head = el('div', 'cj-row cj-run-head');
        if (group.mine) head.appendChild(el('span', 'cj-star', '★'));
        const titles = el('div', 'cj-run-titles');
        titles.appendChild(el('div', 'cj-run-title', group.title));
        titles.appendChild(el('div', 'cj-muted cj-run-sub',
            (group.labelsName || '—') + (!group.mine ? ' · ' + (group.project && group.project.name ? 'from ' + group.project.name : 'other project') : '')));
        head.appendChild(titles);
        head.appendChild(chipEl(statusChipFor(group.status), group.status));
        const tl = groupTimeLabel(group);
        if (tl) head.appendChild(el('span', 'cj-muted cj-time', tl));
        const sid = el('span', 'cj-mono cj-short', group.key.slice(0, 8)); sid.title = 'Run ' + group.key;
        head.appendChild(sid);
        const canCancelRun = isActiveGroup(group) && group.jobs.some(function (j) { return isManagedJob(j, ctx.myId, ctx.tracked); });
        if (canCancelRun) {
            const c = btn(cancelingRuns.has(group.key) ? 'Canceling…' : 'Cancel run', 'cj-cancel', 'cancelrun', group.key, function () { void cancelRun(group); }, cancelingRuns.has(group.key));
            head.appendChild(c);
        }
        if (canDeleteRun(group.jobs)) {
            const d = button('connect-icon-btn cj-trash', undefined, 'Remove this run');
            d.setAttribute('aria-label', 'Remove this run');
            d.dataset.fk = 'trash:' + group.key;
            d.innerHTML = railIconSvg('trash-2');
            d.addEventListener('click', function () { void deleteRun(group); });
            head.appendChild(d);
        }
        card.appendChild(head);
        const rows = el('div', 'cj-jobrows');
        group.jobs.forEach(function (j) { rows.appendChild(jobRow(j, ctx)); });
        card.appendChild(rows);
        return card;
    }

    function render() {
        if (destroyed) return;
        const myId = myProjectId();
        const tracked = new Set(trackedFor().map(function (j) { return j.jobId; }));
        const trackedById = new Map(trackedFor().map(function (j) { return [j.jobId, j]; }));
        const ctx = { myId: myId, tracked: tracked, trackedById: trackedById };
        const groups = groupJobs(jobs, myId);
        const visible = query.trim() ? groups.filter(function (g) { return g.jobs.some(function (j) { return jobMatches(j, query); }); }) : groups;

        errBox.textContent = error || '';
        errBox.style.display = error ? '' : 'none';
        // "Canceling…" ends once nothing of the run is left running or queued.
        if (cancelingRuns.size) {
            const active = new Set(groups.filter(isActiveGroup).map(function (g) { return g.key; }));
            const next = new Set(Array.from(cancelingRuns).filter(function (k) { return active.has(k); }));
            if (next.size !== cancelingRuns.size) cancelingRuns = next;
        }
        note.textContent = loading && jobs.length === 0 ? 'Loading jobs…' : groups.length === 0 ? 'No jobs yet.' : visible.length === 0 ? 'No jobs match.' : '';
        note.style.display = note.textContent ? '' : 'none';

        const keep = new Set(visible.map(function (g) { return g.key; }));
        Array.from(cards.keys()).forEach(function (k) {
            if (!keep.has(k)) { cards.get(k).el.remove(); cards.delete(k); }
        });
        visible.forEach(function (group, i) {
            const sig = groupSig(group, ctx);
            let c = cards.get(group.key);
            if (!c || c.sig !== sig) {
                const fk = document.activeElement && c && c.el.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
                const fresh = buildCard(group, ctx);
                if (c) c.el.replaceWith(fresh);
                c = { el: fresh, sig: sig };
                cards.set(group.key, c);
                if (fk) { const again = fresh.querySelector('[data-fk="' + CSS.escape(fk) + '"]'); if (again && !again.disabled) again.focus(); }
            }
            if (list.children[i] !== c.el) list.insertBefore(c.el, list.children[i] || null);
        });
    }

    function find(key, tries) {
        const target = Array.from(list.querySelectorAll('[data-run-key]')).find(function (n) { return n.dataset.runKey === key; });
        if (target) {
            if (target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
            highlightKey = key; render();
            clearTimeout(highlightTimer);
            highlightTimer = setTimeout(function () { highlightKey = null; render(); }, 1800);
        } else if (tries < 20 && !destroyed) {
            findTimer = setTimeout(function () { find(key, tries + 1); }, 100);
        }
    }

    function focusRun(fr) {
        if (!fr) return;
        const k = fr.key + '#' + fr.nonce;
        if (k === lastFocusKey) return;
        lastFocusKey = k;
        // A search that could hide the run is cleared first.
        query = ''; search.value = ''; render();
        clearTimeout(findTimer);
        find(fr.key, 0);
    }

    // ------------------------------------------------------------------ wiring
    search.addEventListener('input', function () { query = search.value; render(); });
    newBtn.addEventListener('click', function () { void openWizard(null); });
    const unsubTracked = useConnectStore.subscribeSelector(function (s) { return s.trackedJobs; }, function () { render(); });

    render();
    void refresh();
    startPoll();
    if (p.focusRun) focusRun(p.focusRun);

    return {
        refresh: refresh,
        update: function (next) {
            const prev = p;
            p = Object.assign({}, p, next);
            if (p.workerId !== prev.workerId) {
                // Only a worker switch blanks the list.
                loading = true; jobs = []; error = null; cancelingRuns = new Set();
                if (viewer) viewer.close();
                cards.forEach(function (c) { c.el.remove(); }); cards.clear();
                render(); void refresh(); startPoll();
            } else if (p.refreshToken !== prev.refreshToken) {
                void refresh(); startPoll();
            } else if (p.workerLabel !== prev.workerLabel) {
                render();
            }
            if (p.focusRun !== prev.focusRun) focusRun(p.focusRun);
        },
        destroy: function () {
            destroyed = true;
            if (pollHandle !== null) clearIntervalImpl(pollHandle);
            pollHandle = null;
            clearTimeout(highlightTimer); clearTimeout(findTimer);
            unsubTracked();
            if (viewer) viewer.close();
            root.remove();
        },
    };
}
