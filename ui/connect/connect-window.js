/**
 * ui/connect/connect-window.js — the Connect window.
 *
 * Port of sleap-app src/components/connect/ConnectDialog.tsx @ 683a159: a full-window overlay (92vw x 90vh,
 * resizable from its bottom-right corner) listing every paired worker and the jobs on it, opened from the
 * Connect panel's "Open Connect window", a RemoteRunCard's "Run again" / "Open in Connect", a job-finished
 * toast's "Open", or View > Connect Window. Header: "Connect", "Your workers and the jobs on them",
 * Refresh, close. Left column (320 px): Paired workers (top 45%, `createWorkerList`) over the picked
 * worker's queue (`createSidebarQueue`), each scrolling on its own. Right: the picked worker's name, the
 * Jobs / Data access tabs, the Devices button, Forget; or "Pair a worker to see its jobs here.".
 *
 * The worker picked here is LOCAL to this window: it never changes the store's `selectedWorkerId` (the app's
 * Backend). It defaults to that worker when paired, else the first, and is re-picked if the pick is forgotten.
 * On open every paired worker's info is refreshed in parallel; Refresh does the same and bumps `refreshToken`,
 * which the queue, Devices and the open tab watch to refetch now rather than on their next poll; re-pairing
 * an unpaired worker bumps it too. Closing releases the idle connections opened just to fill the window
 * (`releaseIdleConnections`). A queue card's click switches to the Jobs tab and asks it to scroll to that run
 * (`focusRun {key, nonce}`); a Stop Early / Cancel run from the queue bumps `refreshToken`.
 *
 * The tab bodies are agents B and C's components, mounted through the shared factory contract
 * (`createWorkerJobs`, `createWorkerDataAccess`: `(container, props) -> {update, destroy}`).
 *
 * LUCID changes: vanilla DOM; Esc closes the window (a popover, menu or dialog above it takes the Esc first);
 * the overlay is a `data-shortcut-modal` (app shortcuts stay off the views behind it) with Tab trapped in the
 * card; a click on the dim area closes it (as Radix does); focus returns to where it was. A worker paired while
 * the window is open gets its info refreshed here (sleap-app's comment says its card does, but nothing does).
 * z-index sits under the toasts (so a "finished" toast shows over it, as does one raised from a dialog opened
 * from the window), under the file browser / viewer / merge dialog / wizard, and under a progress card
 * (`.loading-overlay`, raised to 10100 by `body:has(.cw-scrim …)` so Fetch & Load's card shows over the window)
 * and the ask dialogs (20000), which stay above the toasts.
 *
 * Known difference: confirms go through `ui/ask.js`, which outside the desktop shell is `window.confirm(message)`
 * (a repo-wide convention, left alone). sleap-app's titles ("Remove this run from <worker>?"), the red destructive
 * button and the "Keep running" / "Keep queued" / "Keep training" cancel labels are dropped there (the texts
 * themselves are identical); the desktop shell's `lucidDesktop.confirm` shows them. Esc layering between the
 * window and the dialogs above it is `ui/connect/layers.js` (`layerAbove`).
 *
 * Exports: openConnectWindow({workerId?}), closeConnectWindow, isConnectWindowOpen.
 */
import { useConnectStore } from '../../pose/connect/store.js';
import { shallowEqual } from '../../pose/connect/mini-store.js';
import { railIconSvg } from '../panel-rail-icons.js';
import { createWorkerList } from './worker-list.js';
import { createSidebarQueue } from './sidebar-queue.js';
import { createWorkerDevicesButton } from './worker-devices.js';
import { createWorkerJobs } from './worker-jobs.js';
import { createWorkerDataAccess } from './worker-data-access.js';
import { forgetWorkerWithConfirm } from './connect-panel.js';

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function icon(name, cls) {
    const s = el('span', 'connect-icon' + (cls ? ' ' + cls : ''));
    s.innerHTML = railIconSvg(name);
    return s;
}

let current = null;

export function isConnectWindowOpen() {
    return !!current;
}

export function closeConnectWindow() {
    if (current) current.close();
}

/**
 * Open the window (a second call while open just brings focus back, optionally picking `workerId`).
 * @param {{workerId?: string}} [opts]
 */
export function openConnectWindow(opts) {
    opts = opts || {};
    if (current) {
        current.pick(opts.workerId);
        current.focus();
        return;
    }
    current = mountWindow(opts);
}

function mountWindow(opts) {
    const S = function () { return useConnectStore.getState(); };
    const returnFocus = document.activeElement;

    let pickedWorkerId = null;
    let tab = 'jobs';
    let refreshToken = 0;
    let refreshing = false;
    let focusRun = null;
    let closed = false;
    let prevUnpairedAt;
    const knownWorkers = new Set();

    // --------------------------------------------------------------- DOM
    const scrim = el('div', 'cw-scrim');
    scrim.id = 'connectWindow';
    scrim.setAttribute('data-shortcut-modal', '1');
    const card = el('div', 'cw-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'cwTitle');
    card.setAttribute('aria-describedby', 'cwDesc');
    card.tabIndex = -1;

    const head = el('div', 'cw-head');
    const title = el('h2', 'cw-title', 'Connect');
    title.id = 'cwTitle';
    const desc = el('span', 'cw-desc', 'Your workers and the jobs on them');
    desc.id = 'cwDesc';
    const refreshBtn = el('button', 'connect-btn connect-btn-ghost cw-btn-sm cw-refresh');
    refreshBtn.type = 'button';
    refreshBtn.id = 'cwRefresh';
    const refreshIcon = icon('refresh-cw');
    refreshBtn.append(refreshIcon, document.createTextNode('Refresh'));
    const closeBtn = el('button', 'connect-icon-btn cw-close');
    closeBtn.type = 'button';
    closeBtn.id = 'cwClose';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.appendChild(icon('x'));
    head.append(title, desc, refreshBtn, closeBtn);

    const body = el('div', 'cw-body');
    const side = el('div', 'cw-side');
    const sideTop = el('div', 'cw-side-top');
    const sideQueue = el('div', 'cw-side-queue');
    side.append(sideTop, sideQueue);

    const main = el('div', 'cw-main');
    const mainHead = el('div', 'cw-main-head');
    const workerName = el('span', 'cw-worker-name');
    workerName.id = 'cwWorkerName';
    const tabs = el('div', 'cw-tabs');
    tabs.setAttribute('role', 'tablist');
    const tabBtns = {};
    [['jobs', 'Jobs'], ['data', 'Data access']].forEach(function (t) {
        const b = el('button', 'cw-tab', t[1]);
        b.type = 'button';
        b.id = 'cwTab-' + t[0];
        b.setAttribute('role', 'tab');
        b.dataset.tab = t[0];
        b.addEventListener('click', function () { setTab(t[0]); });
        tabBtns[t[0]] = b;
        tabs.appendChild(b);
    });
    const devicesHost = el('span', 'cw-devices-host');
    const forgetBtn = el('button', 'connect-btn connect-btn-ghost cw-btn-sm cw-forget');
    forgetBtn.type = 'button';
    forgetBtn.id = 'cwForget';
    forgetBtn.title = 'Remove this worker from the app and unpair this device there';
    forgetBtn.append(icon('trash-2'), document.createTextNode('Forget'));
    forgetBtn.addEventListener('click', function () { if (pickedWorkerId) void forgetWorkerWithConfirm(pickedWorkerId); });
    mainHead.append(workerName, tabs, devicesHost, forgetBtn);
    const content = el('div', 'cw-content');
    content.id = 'cwContent';
    const emptyMain = el('div', 'cw-main-empty', 'Pair a worker to see its jobs here.');
    emptyMain.id = 'cwEmpty';
    main.append(mainHead, content, emptyMain);

    body.append(side, main);
    card.append(head, body);
    scrim.appendChild(card);
    document.body.appendChild(scrim);

    // --------------------------------------------------------------- state helpers
    function picked() {
        return S().pairedWorkers.find(function (w) { return w.nodeId === pickedWorkerId; }) || null;
    }

    function fallbackPick() {
        const s = S();
        return s.pairedWorkers.some(function (w) { return w.nodeId === s.selectedWorkerId; })
            ? s.selectedWorkerId : (s.pairedWorkers[0] ? s.pairedWorkers[0].nodeId : null);
    }

    function refreshAllInfo() {
        // Refresh every paired worker's info in parallel so cards show live specs / busy state right away.
        return Promise.all(S().pairedWorkers.map(function (w) {
            return Promise.resolve().then(function () { return S().refreshWorkerInfo(w.nodeId); }).catch(function () { /* the card shows the error */ });
        }));
    }

    // --------------------------------------------------------------- components
    const list = createWorkerList(sideTop, { selectedId: pickedWorkerId, onSelect: pick });
    let queue = null;
    let devices = null;
    let tabComp = null;
    let tabCompKind = null;
    let mountedWorkerId = null;

    function setTab(next) {
        if (tab === next) return;
        tab = next;
        syncMain();
    }

    function pick(id) {
        if (!id || id === pickedWorkerId) return;
        if (!S().pairedWorkers.some(function (w) { return w.nodeId === id; })) return;
        pickedWorkerId = id;
        syncAll();
    }

    function bump() {
        refreshToken += 1;
        syncAll();
    }

    function openRun(key) {
        tab = 'jobs';
        focusRun = { key: key, nonce: (focusRun ? focusRun.nonce : 0) + 1 };
        syncAll();
    }

    function queueProps(w) {
        return { workerId: w.nodeId, workerLabel: w.label, refreshToken: refreshToken, onChanged: bump, onOpenRun: openRun };
    }

    function tabProps(w) {
        return tab === 'jobs'
            ? { workerId: w.nodeId, workerLabel: w.label, refreshToken: refreshToken, focusRun: focusRun }
            : { workerId: w.nodeId, refreshToken: refreshToken };
    }

    function syncMain() {
        const w = picked();
        main.classList.toggle('empty', !w);
        mainHead.hidden = !w;
        content.hidden = !w;
        emptyMain.hidden = !!w;
        sideQueue.hidden = !w;
        if (!w) {
            if (queue) { queue.destroy(); queue = null; }
            if (devices) { devices.destroy(); devices = null; }
            if (tabComp) { tabComp.destroy(); tabComp = null; tabCompKind = null; }
            mountedWorkerId = null;
            return;
        }
        workerName.textContent = w.label;
        workerName.title = w.label;
        Object.keys(tabBtns).forEach(function (k) {
            tabBtns[k].classList.toggle('on', k === tab);
            tabBtns[k].setAttribute('aria-selected', k === tab ? 'true' : 'false');
        });
        if (queue) queue.update(queueProps(w)); else queue = createSidebarQueue(sideQueue, queueProps(w));
        const dp = { workerId: w.nodeId, workerLabel: w.label, refreshToken: refreshToken };
        if (devices) devices.update(dp); else devices = createWorkerDevicesButton(devicesHost, dp);
        // A tab body is per tab (sleap-app unmounts the other one); a different worker keeps the same body, updated.
        if (tabComp && tabCompKind !== tab) { tabComp.destroy(); tabComp = null; }
        const tp = tabProps(w);
        if (tabComp) tabComp.update(tp);
        else {
            tabComp = tab === 'jobs' ? createWorkerJobs(content, tp) : createWorkerDataAccess(content, tp);
            tabCompKind = tab;
        }
        mountedWorkerId = w.nodeId;
    }

    function syncAll() {
        list.update({ selectedId: pickedWorkerId, onSelect: pick });
        syncMain();
    }

    // --------------------------------------------------------------- store follow
    function onWorkers() {
        if (closed) return;
        const s = S();
        // The pick was forgotten (or none yet): re-pick.
        if (!pickedWorkerId || !s.pairedWorkers.some(function (w) { return w.nodeId === pickedWorkerId; })) pickedWorkerId = fallbackPick();
        // A worker paired while the window is open: fill its info in now.
        s.pairedWorkers.forEach(function (w) {
            if (!knownWorkers.has(w.nodeId)) {
                knownWorkers.add(w.nodeId);
                if (opened) void Promise.resolve().then(function () { return S().refreshWorkerInfo(w.nodeId); }).catch(function () {});
            }
        });
        // Re-pairing an unpaired worker: reload its panes now rather than leaving the "unpaired" errors up.
        const pw = picked();
        const unpairedAt = pw ? pw.unpairedAt : undefined;
        const reloaded = !!(prevUnpairedAt && !unpairedAt && pw && pw.nodeId === prevWorkerForUnpaired);
        prevUnpairedAt = unpairedAt;
        prevWorkerForUnpaired = pw ? pw.nodeId : null;
        if (reloaded) refreshToken += 1;
        syncAll();
    }
    let prevWorkerForUnpaired = null;
    let opened = false;

    const unsubWorkers = useConnectStore.subscribeSelector(
        function (s) { return { workers: s.pairedWorkers, selected: s.selectedWorkerId }; },
        onWorkers, shallowEqual);

    // --------------------------------------------------------------- refresh / close
    refreshBtn.addEventListener('click', async function () {
        refreshing = true;
        refreshBtn.disabled = true;
        refreshIcon.classList.add('connect-spin');
        refreshToken += 1;
        syncAll();
        try { await refreshAllInfo(); } finally {
            refreshing = false;
            if (!closed) { refreshBtn.disabled = false; refreshIcon.classList.remove('connect-spin'); }
        }
    });

    function close() {
        if (closed) return;
        closed = true;
        current = null;
        document.removeEventListener('keydown', onKey);
        unsubWorkers();
        list.destroy();
        if (queue) queue.destroy();
        if (devices) devices.destroy();
        if (tabComp) tabComp.destroy();
        scrim.remove();
        try { S().releaseIdleConnections(); } catch (e) { /* closing anyway */ }
        if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
    }
    closeBtn.addEventListener('click', close);

    // A press that starts and ends on the dim area closes (so dragging the resize corner out of it does not).
    let downOnScrim = false;
    scrim.addEventListener('mousedown', function (e) { downOnScrim = e.target === scrim; });
    scrim.addEventListener('mouseup', function (e) { if (downOnScrim && e.target === scrim) close(); downOnScrim = false; });

    // Bubble phase: a popover, menu or dialog above the window handles (and swallows) its own Esc first.
    function onKey(e) {
        if (e.key === 'Escape') {
            if (e.defaultPrevented) return;
            e.preventDefault();
            close();
            return;
        }
        if (e.key === 'Tab') {
            const a = document.activeElement;
            if (a && a !== document.body && !card.contains(a)) return; // a popover / dialog above owns Tab
            const f = Array.prototype.filter.call(card.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'), function (n) {
                return !n.disabled && n.offsetParent !== null;
            });
            if (f.length === 0) { e.preventDefault(); card.focus(); return; }
            const first = f[0], last = f[f.length - 1];
            if (!card.contains(a) || a === card) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
            else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
        }
    }
    document.addEventListener('keydown', onKey);

    // --------------------------------------------------------------- start
    S().pairedWorkers.forEach(function (w) { knownWorkers.add(w.nodeId); });
    pickedWorkerId = opts.workerId && S().pairedWorkers.some(function (w) { return w.nodeId === opts.workerId; }) ? opts.workerId : fallbackPick();
    prevWorkerForUnpaired = pickedWorkerId;
    const p0 = picked();
    prevUnpairedAt = p0 ? p0.unpairedAt : undefined;
    syncAll();
    opened = true;
    void refreshAllInfo();
    card.focus();

    return {
        close: close,
        focus: function () { if (!card.contains(document.activeElement)) card.focus(); },
        pick: function (id) { if (id) pick(id); },
    };
}
