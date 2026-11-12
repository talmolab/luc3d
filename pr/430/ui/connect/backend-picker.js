/**
 * ui/connect/backend-picker.js — "Backend: Local | <worker>" in the Inference panel's Remote section.
 *
 * Port of sleap-app src/components/common/BackendPicker.tsx @ 683a159 (same strings, incl. its
 * "A inference job" grammar; same pure helpers). Picking a worker selects + connects it; Local turns remote off.
 *
 * LUCID changes:
 *  - vanilla DOM re-rendered from a store selector;
 *  - Local is disabled on desktop without sleap-nn and absent on the web (remote is the only backend);
 *  - never shows a blank / disabled Local: "Select a worker…", or on the web with nothing paired
 *    sleap-app's empty-state text.
 */
import { useConnectStore } from '../../pose/connect/store.js?v=82449baaa3c2';
import { shallowEqual } from '../../pose/connect/mini-store.js?v=82449baaa3c2';
import { transportLabel } from '../../pose/connect/transport.js?v=82449baaa3c2';
import { setInfoTip } from '../info-tip.js?v=82449baaa3c2';
import { el, button } from './dom.js?v=82449baaa3c2';

const LOCAL_VALUE = '__local__';

/** The select's value, derived from the panel's own remote / worker state. */
function backendSelectValue(remoteEnabled, selectedWorkerId) {
    return remoteEnabled && selectedWorkerId ? selectedWorkerId : LOCAL_VALUE;
}

/** Pure decision behind picking a value. */
function resolveBackendChange(value) {
    if (value === LOCAL_VALUE) return { remoteEnabled: false, workerIdToConnect: null };
    return { remoteEnabled: true, workerIdToConnect: value };
}

/** The status line's words (BackendPicker.tsx). */
function connectionStatusText(status, error) {
    return status === 'connected' ? 'Connected'
        : status === 'connecting' ? 'Connecting…'
            : status === 'reconnecting' ? 'Reconnecting…'
                : status === 'error' ? 'Connection failed' + (error ? ': ' + error : '')
                    : 'Not connected';
}

/**
 * @param {{
 *   jobLabel: string,
 *   localAvailable: () => boolean,        // sleap-nn on this machine
 *   localListed: () => boolean,           // show a Local option at all (desktop)
 *   remoteEnabled: () => boolean,
 *   onRemoteEnabledChange: (on: boolean) => void,
 *   hintButton?: (text: string) => HTMLElement,
 * }} o
 * @returns {{el: HTMLElement, refresh: () => void, dispose: () => void}}
 */
export function createBackendPicker(o) {
    const root = el('div', 'backend-picker');
    const label = el('label', 'inf-label inf-caps', 'Backend');
    if (o.hintButton) {
        label.appendChild(o.hintButton('Run this ' + o.jobLabel + ' on this machine, or send it to a paired sleap-connect worker.'));
    } else {
        setInfoTip(label, 'Run this ' + o.jobLabel + ' on this machine, or send it to a paired sleap-connect worker.');
    }
    const select = el('select', 'inf-select');
    select.id = 'infBackend';
    select.setAttribute('aria-label', 'Backend');
    const emptyText = el('p', 'inf-muted');
    emptyText.id = 'infBackendEmpty';
    emptyText.textContent = 'Connect to a worker in the Connect tab to start remote inference.';
    const pairHint = el('p', 'inf-muted');
    pairHint.id = 'infBackendPairHint';
    const status = el('div', 'backend-status');
    status.id = 'infBackendStatus';
    const dot = el('span', 'connect-dot');
    const statusText = el('span', 'backend-status-text');
    const via = el('span', 'backend-via');
    via.setAttribute('data-testid', 'backend-transport');
    const connectBtn = button('btn btn-sm inf-btn-outline backend-connect', 'Connect');
    connectBtn.id = 'infBackendConnect';
    connectBtn.addEventListener('click', function () {
        const id = useConnectStore.getState().selectedWorkerId;
        if (id) Promise.resolve(useConnectStore.getState().selectWorker(id)).catch(function () { /* connectionError shows it */ });
    });
    status.append(dot, statusText, via, connectBtn);
    const banner = el('div', 'backend-reattach');
    banner.id = 'infReattach';
    root.append(label, select, emptyText, pairHint, status, banner);

    function render() {
        const s = useConnectStore.getState();
        const remote = o.remoteEnabled();
        const localUsable = o.localListed() && o.localAvailable();
        const listKey = (o.localListed() ? (o.localAvailable() ? 'L' : 'l') : '-') + '|' +
            s.pairedWorkers.map(function (w) { return w.nodeId + '\u0000' + w.label; }).join('\u0001');
        if (select.dataset.key !== listKey) {
            select.dataset.key = listKey;
            select.textContent = '';
            if (o.localListed()) {
                const op = el('option', null, 'Local (this machine)');
                op.value = LOCAL_VALUE;
                if (!o.localAvailable()) { op.disabled = true; op.title = 'sleap-nn not detected'; }
                select.appendChild(op);
            }
            s.pairedWorkers.forEach(function (w) {
                const op = el('option', null, w.label);
                op.value = w.nodeId;
                select.appendChild(op);
            });
            // No usable Local: an empty choice says what to do instead of showing a blank / a disabled Local.
            if (!localUsable) {
                const op = el('option', null, 'Select a worker…');
                op.value = '';
                op.disabled = true;
                select.insertBefore(op, select.firstChild);
            }
        }
        const picked = s.selectedWorkerId && s.pairedWorkers.some(function (w) { return w.nodeId === s.selectedWorkerId; }) ? s.selectedWorkerId : '';
        const want = localUsable ? backendSelectValue(remote, s.selectedWorkerId) : (remote ? picked : '');
        const webEmpty = !o.localListed() && s.pairedWorkers.length === 0;
        select.hidden = webEmpty;
        emptyText.hidden = !webEmpty;
        select.value = want;
        if (select.value !== want) select.selectedIndex = -1;

        // render() also runs on the panel's 2 s refresh: write text/buttons only when they change, so a click
        // on "Cancel it" or a text selection is not replaced under the user.
        const setText = function (node, t) { if (node.textContent !== t) node.textContent = t; };
        pairHint.hidden = s.pairedWorkers.length > 0;
        setText(pairHint, 'Pair with a worker in the Connect tab to run a ' + o.jobLabel + ' remotely.');

        const showStatus = remote && !!s.selectedWorkerId;
        status.hidden = !showStatus;
        if (showStatus) {
            dot.className = 'connect-dot ' + (s.connectionStatus === 'connected' ? 'on' : s.connectionStatus === 'connecting' ? 'busy'
                : s.connectionStatus === 'reconnecting' ? 'warn' : '');
            setText(statusText, connectionStatusText(s.connectionStatus, s.connectionError));
            const live = s.connectionStatus === 'connected' || s.connectionStatus === 'connecting' || s.connectionStatus === 'reconnecting';
            setText(via, s.activeTransport && live ? 'via ' + transportLabel(s.activeTransport) : '');
            via.hidden = !via.textContent;
            connectBtn.hidden = !(s.connectionStatus === 'disconnected' || s.connectionStatus === 'error');
        }

        const rj = s.reattachableJob;
        banner.hidden = !(remote && rj);
        const bannerKey = remote && rj ? rj.jobId + '\u0000' + rj.state : '';
        if (banner.dataset.key !== bannerKey) {
            banner.dataset.key = bannerKey;
            banner.textContent = '';
            if (remote && rj) {
                const p = el('p', 'backend-reattach-text');
                p.append('A ' + o.jobLabel + ' (');
                p.appendChild(el('code', 'inf-code', rj.jobId));
                p.append(') is still ');
                p.appendChild(el('b', null, rj.state));
                p.append(' on this worker from a previous session.');
                const cancel = button('btn btn-sm inf-btn-outline', 'Cancel it');
                cancel.id = 'infReattachCancel';
                cancel.addEventListener('click', function () { useConnectStore.getState().cancelJob(); });
                banner.append(p, cancel);
            }
        }
    }

    select.addEventListener('change', function () {
        const effect = resolveBackendChange(select.value);
        o.onRemoteEnabledChange(effect.remoteEnabled);
        if (effect.workerIdToConnect) {
            Promise.resolve(useConnectStore.getState().selectWorker(effect.workerIdToConnect)).catch(function () { /* connectionError shows it */ });
        }
        render();
    });

    const unsub = useConnectStore.subscribeSelector(function (s) {
        return {
            pairedWorkers: s.pairedWorkers, selectedWorkerId: s.selectedWorkerId, connectionStatus: s.connectionStatus,
            connectionError: s.connectionError, activeTransport: s.activeTransport, reattachableJob: s.reattachableJob,
        };
    }, render, shallowEqual);

    render();
    return { el: root, refresh: render, dispose: unsub };
}
