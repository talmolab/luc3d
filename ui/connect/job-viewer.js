/**
 * ui/connect/job-viewer.js — the per-job replay + live viewer of the Connect window's Jobs tab.
 *
 * Port of sleap-app src/components/connect/JobViewerDialog.tsx @ 683a159 (§4b.6): a dialog for ANY
 * job on a paired worker, with the label and the stream's status in the header ("Replayed from the
 * worker's history; per-epoch timing for earlier epochs isn't available." / "Replayed from the
 * worker's history."), a Monitor / Logs toggle (an inference job has no loss curve, so only its
 * logs, no toggle), Stop Early + Cancel on the right while the job runs (only when `canStop`,
 * which a view-only job of another project never gets; an inference job has no Stop Early), the
 * worker's failure detail in red for a failed / canceled job, the loss plot (`loss-plot.js`) or
 * the log terminal (Copy, "Errors only", "Wrap", "No log output." / "No error lines.", error /
 * best / section lines coloured by `logLineClassName`). Stop / Cancel confirm with
 * `endJobConfirm` and send `cancelJobOn(workerId, jobId, mode)`; a failure toasts "Failed to stop
 * training early" / "Failed to cancel job". The log and the epochs come from
 * `pose/connect/job-stream.js` (`createJobStream`), the non-React core of `useJobStream`.
 *
 * LUCID changes: vanilla DOM scrim + card (`.cj-*`), closes on Esc (nested above the Connect window,
 * so Esc closes this first) and on the scrim / the X; Tab stays inside; `data-shortcut-modal`
 * keeps app hotkeys off the view behind. Resume on reconnect (sleap-app's `useJobStream` effect):
 * the viewer subscribes to the store's link status for its worker and calls the stream's
 * `resume()` when it returns to "connected", so a worker that restarts keeps the viewer live. The
 * log follows its end while the reader is at the end (a browser `pre` does not do that for free).
 * Copy writes through `navigator.clipboard` and falls back to a hidden textarea.
 *
 * Exports: openJobViewer.
 */
import { useConnectStore } from '../../pose/connect/store.js';
import { createJobStream } from '../../pose/connect/job-stream.js';
import { isErrorLine, logLineClassName } from '../../pose/connect/process-log.js';
import { endJobConfirm } from '../../pose/connect/job-groups.js';
import { toTrainingStatus } from '../../pose/connect/worker-ui-helpers.js';
import { askConfirm } from '../ask.js';
import { notify } from './notify.js';
import { railIconSvg } from '../panel-rail-icons.js';
import { createLossPlot } from './loss-plot.js';
import { layerAbove } from './layers.js';

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

/** Tailwind class names of `logLineClassName` mapped to the Connect window's own. */
function logClass(line) {
    const c = logLineClassName(line);
    return c === 'text-green-400' ? 'cj-log-best' : c === 'text-destructive' ? 'cj-log-err' : c === 'text-yellow-400' ? 'cj-log-mark' : '';
}

function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    }
    fallbackCopy(text);
    return Promise.resolve();
}
function fallbackCopy(text) {
    const t = el('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing to do */ }
    t.remove();
}

/**
 * @param {{
 *   workerId: string, jobId: string, label: string,
 *   initialView: 'monitor' | 'logs', kind?: 'train' | 'track',
 *   canStop: boolean, onClose?: () => void,
 * }} props
 * @returns {{ el: HTMLElement, close: () => void, stream: any }}
 */
export function openJobViewer(props) {
    const showMonitor = props.kind !== 'track';
    let view = showMonitor ? props.initialView : 'logs';
    let errorsOnly = false, wrap = true;
    let closed = false;

    const scrim = el('div', 'cj-scrim');
    scrim.setAttribute('data-shortcut-modal', '1');
    const card = el('div', 'cj-card cj-viewer');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', props.label);
    card.tabIndex = -1;

    const head = el('div', 'cj-card-head');
    const titleRow = el('div', 'cj-card-title');
    const titleText = el('span', 'cj-card-title-text', props.label);
    const statusText = el('span', 'cj-card-status');
    const close = el('button', 'cj-card-x');
    close.type = 'button'; close.setAttribute('aria-label', 'Close'); close.title = 'Close';
    close.innerHTML = railIconSvg('x');
    titleRow.append(titleText, statusText, close);
    const desc = el('p', 'cj-card-desc', showMonitor
        ? "Replayed from the worker's history; per-epoch timing for earlier epochs isn't available."
        : "Replayed from the worker's history.");
    head.append(titleRow, desc);

    const bar = el('div', 'cj-viewer-bar');
    const monBtn = el('button', 'connect-btn cj-btn', 'Monitor'); monBtn.type = 'button';
    const logBtn = el('button', 'connect-btn cj-btn', 'Logs'); logBtn.type = 'button';
    const ends = el('div', 'cj-viewer-ends');
    const stopBtn = el('button', 'connect-btn connect-btn-outline cj-btn cj-stop', 'Stop Early'); stopBtn.type = 'button';
    const cancelBtn = el('button', 'connect-btn connect-btn-outline cj-btn cj-cancel', 'Cancel'); cancelBtn.type = 'button';
    ends.append(stopBtn, cancelBtn);
    if (showMonitor) bar.append(monBtn, logBtn);
    bar.appendChild(ends);

    const detail = el('p', 'cj-viewer-detail');
    const monitorHost = el('div', 'cj-viewer-monitor');
    const logHost = el('div', 'cj-viewer-logs');
    const tools = el('div', 'cj-viewer-tools');
    const copyBtn = el('button', 'connect-btn connect-btn-outline cj-btn', 'Copy'); copyBtn.type = 'button';
    function check(label, on, set) {
        const l = el('label', 'cj-check');
        const i = el('input'); i.type = 'checkbox'; i.checked = on;
        i.addEventListener('change', function () { set(i.checked); paintLog(true); });
        l.append(i, label);
        return l;
    }
    tools.append(copyBtn, check('Errors only', false, function (v) { errorsOnly = v; }), check('Wrap', true, function (v) { wrap = v; pre.classList.toggle('nowrap', !wrap); }));
    const pre = el('pre', 'cj-viewer-pre');
    logHost.append(tools, pre);
    card.append(head, bar, detail, monitorHost, logHost);
    scrim.appendChild(card);

    const plot = createLossPlot(monitorHost, { height: 200 });

    // ---- live stream
    const stream = createJobStream(function () { return useConnectStore.getState().clientFor(props.workerId); }, props.jobId, {
        label: props.label,
        onUpdate: function () { paint(); },
    });
    // A worker that restarts: re-subscribe from the last applied seq once the link is back.
    const unsub = useConnectStore.subscribeSelector(
        function (s) { return s.connections && s.connections[props.workerId] ? s.connections[props.workerId].status : null; },
        function (now, prev) { if (now === 'connected' && prev !== 'connected' && !closed) void stream.resume(); },
    );

    function lines() {
        const log = stream.getState().log;
        return errorsOnly ? log.filter(isErrorLine) : log;
    }

    let lastLogKey = '';
    function paintLog(force) {
        const ls = lines();
        const s = stream.getState();
        const key = ls.length + '|' + (ls.length ? ls[ls.length - 1] : '') + '|' + errorsOnly + '|' + s.progressTail;
        if (!force && key === lastLogKey) return;
        lastLogKey = key;
        const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
        pre.textContent = '';
        if (ls.length === 0) {
            pre.appendChild(el('span', 'cj-muted', errorsOnly ? 'No error lines.' : 'No log output.'));
        } else {
            const frag = document.createDocumentFragment();
            ls.forEach(function (line) { frag.appendChild(el('div', logClass(line), line)); });
            pre.appendChild(frag);
        }
        if (atEnd || force) pre.scrollTop = pre.scrollHeight;
    }

    function paint() {
        if (closed) return;
        const s = stream.getState();
        statusText.textContent = s.status;
        const running = s.status === 'running';
        ends.style.display = props.canStop && running ? '' : 'none';
        stopBtn.style.display = props.kind !== 'track' ? '' : 'none';
        const showDetail = !!s.detail && (s.status === 'failed' || s.status === 'canceled');
        detail.style.display = showDetail ? '' : 'none';
        if (showDetail) detail.textContent = s.detail;
        monBtn.classList.toggle('connect-btn-primary', view === 'monitor');
        monBtn.classList.toggle('connect-btn-outline', view !== 'monitor');
        logBtn.classList.toggle('connect-btn-primary', view === 'logs');
        logBtn.classList.toggle('connect-btn-outline', view !== 'logs');
        monitorHost.style.display = view === 'monitor' ? '' : 'none';
        logHost.style.display = view === 'logs' ? '' : 'none';
        if (view === 'monitor') plot.update({ model: s.model, status: toTrainingStatus(s.status) });
        else paintLog(false);
    }

    monBtn.addEventListener('click', function () { view = 'monitor'; paint(); });
    logBtn.addEventListener('click', function () { view = 'logs'; paint(); paintLog(true); });
    copyBtn.addEventListener('click', function () { void copyText(lines().join('\n')); });

    async function handleEnd(mode) {
        const req = endJobConfirm(props.label, mode, false);
        const ok = await askConfirm(req.message, { title: req.title, okLabel: req.confirmLabel, cancelLabel: req.cancelLabel });
        if (!ok) return;
        try {
            await useConnectStore.getState().cancelJobOn(props.workerId, props.jobId, mode);
        } catch (err) {
            notify.error(mode === 'stop' ? 'Failed to stop training early' : 'Failed to cancel job', {
                description: err instanceof Error ? err.message : String(err),
            });
        }
    }
    stopBtn.addEventListener('click', function () { void handleEnd('stop'); });
    cancelBtn.addEventListener('click', function () { void handleEnd('cancel'); });

    // ---- close / keys
    function doClose() {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        unsub();
        stream.stop();
        plot.destroy();
        scrim.remove();
        if (prevFocus && prevFocus.isConnected) { try { prevFocus.focus(); } catch (e) { /* gone */ } }
        if (props.onClose) props.onClose();
    }
    function focusables() {
        return Array.from(card.querySelectorAll('button, input, select, textarea, [tabindex]'))
            .filter(function (n) { return !n.disabled && n.tabIndex >= 0 && n.offsetParent !== null; });
    }
    function onKey(e) {
        if (closed || layerAbove(scrim)) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); doClose(); return; }
        if (e.key === 'Tab') {
            e.stopPropagation();
            const f = focusables(), a = document.activeElement;
            if (!f.length) { e.preventDefault(); card.focus(); return; }
            const first = f[0], last = f[f.length - 1];
            if (!card.contains(a) || a === card) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
            else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
        }
    }
    close.addEventListener('click', doClose);
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) doClose(); });
    document.addEventListener('keydown', onKey, true);

    const prevFocus = document.activeElement;
    document.body.appendChild(scrim);
    paint();
    if (view === 'logs') paintLog(true);
    card.focus();
    return { el: scrim, close: doClose, stream: stream };
}
