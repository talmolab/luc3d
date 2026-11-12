/**
 * ui/connect/connect-panel.js — the Connect rail panel (remote GPU workers).
 *
 * Port of sleap-app src/components/panels/ConnectPanel.tsx @ 683a159, section for section: Open Connect
 * window, the connection-error box, the paired-worker cards, Pair a new worker / the pairing form, "This
 * device: …". All logic is the store's and `pose/connect/pairing-plan.js`.
 *
 * LUCID changes:
 *  - vanilla DOM; the pairing form is built once and kept (typing survives a repaint), `form.reset()`
 *    standing in for sleap-app's unmount whenever it is hidden;
 *  - the Open button calls the `openConnectWindow` handed in; Forget confirms through `ui/ask.js`.
 */
import { useConnectStore } from '../../pose/connect/store.js';
import { forgetWorkerConfirm } from '../../pose/connect/worker-ui-helpers.js';
import { preferredTransport } from '../../pose/connect/pairing-plan.js';
import { irohTransportAvailable, transportLabel } from '../../pose/connect/transport.js';
import { shallowEqual } from '../../pose/connect/mini-store.js';
import { getClientIdentity } from '../../pose/connect/identity.js';
import { askConfirm } from '../ask.js';
import { createPairWorkerForm } from './pair-worker-form.js';
import { el, button, icon } from './dom.js';

/** Forget after the user confirms (forgetWorker.ts `forgetWorkerWithConfirm`). Resolves whether it was forgotten. */
const forgetting = new Set();
export async function forgetWorkerWithConfirm(nodeId) {
    // A double click (or a second click while the in-app confirm is open) asks once.
    if (forgetting.has(nodeId)) return false;
    forgetting.add(nodeId);
    try { return await forgetConfirmed(nodeId); } finally { forgetting.delete(nodeId); }
}

async function forgetConfirmed(nodeId) {
    const store = useConnectStore.getState();
    const worker = store.pairedWorkers.find(function (w) { return w.nodeId === nodeId; });
    if (!worker) return false;
    const req = forgetWorkerConfirm(worker);
    if (!(await askConfirm(req.message, { title: req.title, okLabel: req.confirmLabel }))) return false;
    await store.forgetWorker(nodeId);
    return true;
}

/**
 * @param {{openConnectWindow?: () => void}} [opts]
 * @returns {{el: HTMLElement, dispose: () => void}}
 */
export function createConnectPanel(opts) {
    opts = opts || {};
    const root = el('div', 'connect-panel');
    let showPairForm = useConnectStore.getState().pairedWorkers.length === 0;
    let connectingId = null;
    let deviceId = null;

    const form = createPairWorkerForm({
        showCancel: !showPairForm,
        onPaired: function () { showPairForm = false; render(); },
        onCancel: function () { showPairForm = false; render(); },
    });
    // sleap-app unmounts the form when it is hidden, so it starts blank when shown again.
    let formShown = true;

    // Static frame, so a repaint never rebuilds the pairing form (or what is typed in it).
    const openBtn = button('connect-btn connect-btn-outline connect-full');
    openBtn.id = 'connectOpenWindow';
    openBtn.append(icon('external-link'), 'Open Connect window');
    openBtn.addEventListener('click', function () { if (opts.openConnectWindow) opts.openConnectWindow(); });

    const errBox = el('div', 'connect-errbox');
    errBox.id = 'connectError';
    const workersHost = el('div', 'connect-workers');
    workersHost.id = 'connectWorkers';
    const divider = el('div', 'connect-sep');
    const pairHost = el('div', 'connect-pair-host');
    const addBtn = button('connect-btn connect-btn-outline connect-full', 'Pair a new worker');
    addBtn.id = 'connectPairNew';
    addBtn.addEventListener('click', function () { showPairForm = true; render(); });
    const deviceLine = el('p', 'connect-device');
    deviceLine.id = 'connectDevice';

    root.append(openBtn, errBox, workersHost, divider, pairHost, deviceLine);

    async function handleConnect(nodeId, transport) {
        connectingId = nodeId;
        render();
        try {
            await useConnectStore.getState().connectToWorker(nodeId, transport ? { transport: transport } : undefined);
        } catch (e) {
            // connectionError already reflects the failure
        } finally {
            connectingId = null;
            render();
        }
    }

    function workerCard(w, s, irohAvailable) {
        const isSelected = s.selectedWorkerId === w.nodeId;
        const isConnected = isSelected && s.connectionStatus === 'connected';
        const isReconnecting = isSelected && s.connectionStatus === 'reconnecting';
        const isConnecting = connectingId === w.nodeId || (isSelected && s.connectionStatus === 'connecting');
        // How to reach it, picked for the user (see `preferredTransport`).
        const route = preferredTransport(w, irohAvailable);

        const card = el('div', 'connect-worker' + (isConnected || isReconnecting ? ' active' : ''));
        card.dataset.nodeId = w.nodeId;
        const head = el('div', 'connect-worker-head');
        head.appendChild(el('span', 'connect-dot ' + (isConnected ? 'on' : isReconnecting ? 'warn' : '')));
        const name = el('span', 'connect-worker-name', w.label);
        head.appendChild(name);
        const forget = button('connect-icon-btn connect-forget', undefined, 'Forget this worker');
        forget.setAttribute('aria-label', 'Forget this worker');
        forget.appendChild(icon('trash-2'));
        forget.addEventListener('click', function () { void forgetWorkerWithConfirm(w.nodeId); });
        head.appendChild(forget);
        card.appendChild(head);

        card.appendChild(el('div', 'connect-worker-id',
            w.nodeId.slice(0, 16) + '…' + (w.addrs[0] ? ' · ' + w.addrs[0] : '')));
        if (isConnected && s.activeTransport) {
            card.appendChild(el('div', 'connect-worker-line connect-via', 'Connected via ' + transportLabel(s.activeTransport)));
        }
        if (w.unpairedAt) {
            card.appendChild(el('div', 'connect-worker-line connect-bad connect-unpaired',
                'Unpaired by this worker — re-pair with a new code to use it again.'));
        }
        if (isReconnecting) {
            card.appendChild(el('div', 'connect-worker-line connect-warn connect-reconnecting',
                'Reconnecting…' + (s.activeTransport ? ' via ' + transportLabel(s.activeTransport) : '')));
        }

        const actions = el('div', 'connect-worker-actions');
        if (isConnected || isReconnecting) {
            const b = button('connect-btn connect-btn-outline connect-full connect-disconnect');
            b.append(icon('unplug'), 'Disconnect');
            b.addEventListener('click', function () { useConnectStore.getState().disconnect(); });
            actions.appendChild(b);
        } else {
            const b = button('connect-btn connect-btn-primary connect-full connect-connect');
            b.disabled = isConnecting || route === null;
            if (route === null) b.title = "This worker can't be reached from here: pair it again with a new code.";
            b.appendChild(icon(isConnecting ? 'loader-circle' : 'plug', isConnecting ? 'connect-spin' : ''));
            b.append(isConnecting ? 'Connecting…' : 'Connect');
            b.addEventListener('click', function () { if (route) void handleConnect(w.nodeId, route); });
            actions.appendChild(b);
        }
        card.appendChild(actions);
        return card;
    }

    /** @returns {{id: string, role: string}|null} the worker-card control holding focus. */
    function focusedWorkerControl() {
        const a = document.activeElement;
        if (!a || !workersHost.contains(a)) return null;
        const card = a.closest('.connect-worker');
        const role = a.classList.contains('connect-forget') ? 'forget' : 'action';
        return card ? { id: card.dataset.nodeId, role: role } : null;
    }

    // While Connect is "Connecting…" its button is disabled and cannot hold focus,
    // so the wish to focus this card's action button outlives that repaint.
    let wantFocus = null;
    let restoring = false;
    function restoreWorkerFocus(key) {
        wantFocus = key;
        if (!key) return;
        const card = Array.from(workersHost.querySelectorAll('.connect-worker')).find(function (c) { return c.dataset.nodeId === key.id; });
        if (!card) { wantFocus = null; return; }
        const target = key.role === 'forget'
            ? card.querySelector('.connect-forget')
            : card.querySelector('.connect-connect:not(:disabled), .connect-disconnect');
        if (!target) return;
        restoring = true;
        try { target.focus(); } finally { restoring = false; }
        wantFocus = null;
    }
    // Focus the user moves elsewhere on purpose ends the wish.
    document.addEventListener('focusin', function () { if (!restoring) wantFocus = null; });
    document.addEventListener('pointerdown', function () { wantFocus = null; }, true);

    // ConnectPanel.tsx:33-39: the pair form closes ONCE, the first time a paired worker is seen
    // (one paired in another window, via storage sync); a form the user reopens is never auto-closed.
    let autoClosed = useConnectStore.getState().pairedWorkers.length > 0;

    function render() {
        const s = useConnectStore.getState();
        if (!autoClosed && s.pairedWorkers.length > 0) {
            autoClosed = true;
            showPairForm = false;
        }
        const irohAvailable = irohTransportAvailable();

        errBox.hidden = !(s.connectionStatus === 'error' && s.connectionError);
        errBox.textContent = errBox.hidden ? '' : s.connectionError;

        // Keyboard use: a repaint replaces the focused button, so remember which
        // one (card + role) and focus its counterpart afterwards.
        const focusKey = focusedWorkerControl() || wantFocus;
        workersHost.textContent = '';
        workersHost.hidden = s.pairedWorkers.length === 0;
        if (s.pairedWorkers.length > 0) {
            const label = el('label', 'connect-caps', 'Paired workers (' + s.pairedWorkers.length.toLocaleString('en-US') + ')');
            workersHost.appendChild(label);
            s.pairedWorkers.forEach(function (w) { workersHost.appendChild(workerCard(w, s, irohAvailable)); });
        }

        restoreWorkerFocus(focusKey);

        // With no worker paired the form is all there is to show (sleap-app: `showPairForm || none paired`).
        form.setShowCancel(s.pairedWorkers.length > 0);
        const wantForm = showPairForm || s.pairedWorkers.length === 0;
        if (formShown && !wantForm) form.reset();
        formShown = wantForm;
        const want = wantForm ? form.el : addBtn;
        if (pairHost.firstChild !== want || pairHost.childNodes.length !== 1) {
            pairHost.textContent = '';
            pairHost.appendChild(want);
        }

        deviceLine.hidden = !deviceId;
        deviceLine.textContent = deviceId ? 'This device: ' + deviceId.slice(0, 16) + '…' : '';
    }

    // This device's own identity, for transparency/debugging; never typed in
    // (pairing sends it automatically).
    getClientIdentity().then(function (identity) { deviceId = identity.nodeId; render(); }, function () {});

    const unsub = useConnectStore.subscribeSelector(function (s) {
        return {
            pairedWorkers: s.pairedWorkers,
            selectedWorkerId: s.selectedWorkerId,
            connectionStatus: s.connectionStatus,
            connectionError: s.connectionError,
            activeTransport: s.activeTransport,
        };
    }, function () {
        render();
    }, shallowEqual);

    render();
    return { el: root, dispose: unsub };
}
