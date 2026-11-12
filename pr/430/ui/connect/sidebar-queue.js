/**
 * ui/connect/sidebar-queue.js — the Connect window's sidebar queue.
 *
 * Port of sleap-app src/components/connect/SidebarQueue.tsx @ 683a159: the picked worker's runs in progress
 * and waiting (`createQueueRunList`), polled every 10 s (`refreshToken` refetches now). A failed run of
 * yours from the last day stays, red, until clicked (cleared runs: localStorage
 * `lucid-connect-dismissed-failed-runs`). Rules: `pose/connect/job-groups.js`, `worker-ui-helpers.js`.
 *
 * LUCID changes:
 *  - "my project" = `lucidProjectTag` of the open project, not a path;
 *  - confirms via `ui/ask.js`, toasts via `notify.js`; a response after a worker switch is dropped.
 */
import { useConnectStore } from '../../pose/connect/store.js?v=82449baaa3c2';
import { groupJobs, isManagedJob, jobTitle, endJobConfirm, queueRunEntries, unfinishedJobs, cancelRunConfirm } from '../../pose/connect/job-groups.js?v=82449baaa3c2';
import {
    failedRunShown, loadDismissedFailedRuns, saveDismissedFailedRuns, DEFAULT_POLL_MS,
} from '../../pose/connect/worker-ui-helpers.js?v=82449baaa3c2';
import { lucidProjectTag } from '../../pose/connect/project-tag.js?v=82449baaa3c2';
import { askConfirm } from '../ask.js?v=82449baaa3c2';
import { state } from '../app-state.js?v=82449baaa3c2';
import { notify } from './notify.js?v=82449baaa3c2';
import { createQueueRunList } from './worker-queue.js?v=82449baaa3c2';
import { el } from './dom.js?v=82449baaa3c2';

function storage() {
    try { return window.localStorage; } catch (e) { return null; }
}

/** The open project's tag id (what jobs submitted from here carry), as the Inference panel computes it. */
function currentProjectId() {
    return lucidProjectTag({
        fileName: state.slpFileHandle ? state.slpFileHandle.name : null,
        sessionFolders: (state.sessions || []).map(function (s) { return s.name; }),
    }).id;
}

/**
 * @param {HTMLElement} container
 * @param {{workerId: string, workerLabel: string, refreshToken: number, onChanged: () => void,
 *   onOpenRun: (runKey: string) => void, pollIntervalMs?: number,
 *   setIntervalImpl?: (cb: () => void, ms: number) => unknown, clearIntervalImpl?: (h: unknown) => void}} props
 */
export function createSidebarQueue(container, props) {
    let p = props;
    let jobs = [];
    let error = null;
    let dismissed = loadDismissedFailedRuns(storage());
    let seq = 0;
    let handle = null;
    let pollKey = null;
    let destroyed = false;

    const root = el('section', 'cw-sq');
    root.setAttribute('data-cw', 'sidebar-queue');
    const head = el('div', 'cw-sq-head');
    const title = el('span', 'connect-caps cw-sq-title');
    const count = el('span', 'cw-sq-count');
    head.append(title, count);
    const scroller = el('div', 'cw-sq-scroll');
    const errLine = el('p', 'cw-sq-error');
    errLine.id = 'cwQueueError';
    const listHost = el('div', 'cw-sq-list');
    scroller.append(errLine, listHost);
    root.append(head, scroller);
    container.appendChild(root);

    function trackedJobIds() {
        return new Set(useConnectStore.getState().trackedJobs
            .filter(function (j) { return j.workerId === p.workerId; })
            .map(function (j) { return j.jobId; }));
    }

    function entries() {
        const myProjectId = currentProjectId();
        const tracked = trackedJobIds();
        const manages = function (group) { return group.jobs.some(function (j) { return isManagedJob(j, myProjectId, tracked); }); };
        return queueRunEntries(groupJobs(jobs, myProjectId), {
            showFailed: function (group) { return failedRunShown(group, manages(group)); },
            dismissed: dismissed,
        });
    }

    const list = createQueueRunList(listHost, {
        entries: [], canManage: canManage, onOpen: handleOpen, onStopEarly: handleStopEarly, onCancelRun: handleCancelRun,
    });

    function canManage(group) {
        const myProjectId = currentProjectId();
        const tracked = trackedJobIds();
        return group.jobs.some(function (j) { return isManagedJob(j, myProjectId, tracked); });
    }

    function render() {
        const es = entries();
        title.textContent = 'Queue on ' + p.workerLabel;
        title.title = 'Queue on ' + p.workerLabel;
        count.textContent = es.length > 0 ? es.length.toLocaleString('en-US') + ' run' + (es.length === 1 ? '' : 's') : '';
        errLine.textContent = error || '';
        errLine.hidden = !error;
        listHost.hidden = !!error;
        list.update({ entries: es, canManage: canManage, onOpen: handleOpen, onStopEarly: handleStopEarly, onCancelRun: handleCancelRun });
    }

    async function refresh() {
        const mine = ++seq;
        const workerId = p.workerId;
        try {
            const next = await useConnectStore.getState().listJobs(workerId);
            if (destroyed || mine !== seq || workerId !== p.workerId) return;
            jobs = next;
            error = null;
        } catch (err) {
            if (destroyed || mine !== seq || workerId !== p.workerId) return;
            error = err instanceof Error ? err.message : String(err);
        }
        render();
    }

    function startPolling() {
        const set = p.setIntervalImpl || function (cb, ms) { return setInterval(cb, ms); };
        stopPolling();
        void refresh();
        handle = { h: set(function () { void refresh(); }, p.pollIntervalMs || DEFAULT_POLL_MS), clear: p.clearIntervalImpl || function (h) { clearInterval(h); } };
    }

    function stopPolling() {
        if (handle) { handle.clear(handle.h); handle = null; }
    }

    function handleOpen(entry) {
        if (entry.status === 'failed') {
            dismissed = new Set(dismissed).add(entry.group.key);
            saveDismissedFailedRuns(storage(), dismissed);
            render();
        }
        p.onOpenRun(entry.group.key);
    }

    async function handleStopEarly(job) {
        const req = endJobConfirm(jobTitle(job), 'stop', false);
        if (!(await askConfirm(req.message, { title: req.title, okLabel: req.confirmLabel, cancelLabel: req.cancelLabel }))) return;
        try {
            await useConnectStore.getState().cancelJobOn(p.workerId, job.jobId, 'stop');
        } catch (err) {
            notify.error('Failed to stop training early', { description: err instanceof Error ? err.message : String(err) });
        }
        p.onChanged();
    }

    async function handleCancelRun(group) {
        const req = cancelRunConfirm(group);
        if (!(await askConfirm(req.message, { title: req.title, okLabel: req.confirmLabel, cancelLabel: req.cancelLabel }))) return;
        try {
            for (const job of unfinishedJobs(group)) await useConnectStore.getState().cancelJobOn(p.workerId, job.jobId, 'cancel');
        } catch (err) {
            notify.error('Failed to cancel run', { description: err instanceof Error ? err.message : String(err) });
        }
        p.onChanged();
    }

    const unsub = useConnectStore.subscribeSelector(
        function (s) { return s.trackedJobs; },
        function () { if (!destroyed) render(); });

    function keyOf(props2) { return props2.workerId + '\u0001' + props2.refreshToken + '\u0001' + (props2.pollIntervalMs || ''); }

    pollKey = keyOf(p);
    render();
    startPolling();

    return {
        update: function (next) {
            const workerChanged = next.workerId !== p.workerId;
            p = next;
            if (workerChanged) { jobs = []; error = null; ++seq; }
            if (keyOf(p) !== pollKey) { pollKey = keyOf(p); render(); startPolling(); } else render();
        },
        destroy: function () {
            destroyed = true;
            stopPolling();
            unsub();
            list.destroy();
            root.remove();
        },
    };
}
