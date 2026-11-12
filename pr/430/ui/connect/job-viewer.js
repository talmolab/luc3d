/**
 * ui/connect/job-viewer.js — the per-job replay + live viewer of the Jobs tab.
 *
 * Port of sleap-app src/components/connect/JobViewerDialog.tsx @ 683a159 (§4b.6): label + stream status,
 * Monitor / Logs (an inference job has only logs), Stop Early / Cancel while it runs (`canStop`), the
 * failure detail, the loss plot (`loss-plot.js`) or the log (Copy, Errors only, Wrap). The stream is
 * `pose/connect/job-stream.js`.
 *
 * LUCID changes:
 *  - vanilla DOM scrim + card; Esc / scrim / X close, Tab trapped (`trapModal`), `data-shortcut-modal`;
 *  - resumes the stream when its worker's link comes back; the log follows its end while read there;
 *  - Copy falls back to a hidden textarea.
 */
import { useConnectStore } from '../../pose/connect/store.js?v=82449baaa3c2';
import { createJobStream } from '../../pose/connect/job-stream.js?v=82449baaa3c2';
import { isErrorLine, logLineClassName } from '../../pose/connect/process-log.js?v=82449baaa3c2';
import { endJobConfirm } from '../../pose/connect/job-groups.js?v=82449baaa3c2';
import { toTrainingStatus } from '../../pose/connect/worker-ui-helpers.js?v=82449baaa3c2';
import { askConfirm } from '../ask.js?v=82449baaa3c2';
import { notify } from './notify.js?v=82449baaa3c2';
import { railIconSvg } from '../panel-rail-icons.js?v=82449baaa3c2';
import { createLossPlot } from './loss-plot.js?v=82449baaa3c2';
import { trapModal } from './layers.js?v=82449baaa3c2';
import { el, button } from './dom.js?v=82449baaa3c2';

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
    const close = button('cj-card-x', undefined, 'Close');
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = railIconSvg('x');
    titleRow.append(titleText, statusText, close);
    const desc = el('p', 'cj-card-desc', showMonitor
        ? "Replayed from the worker's history; per-epoch timing for earlier epochs isn't available."
        : "Replayed from the worker's history.");
    head.append(titleRow, desc);

    const bar = el('div', 'cj-viewer-bar');
    const monBtn = button('connect-btn cj-btn', 'Monitor'); 
    const logBtn = button('connect-btn cj-btn', 'Logs'); 
    const ends = el('div', 'cj-viewer-ends');
    const stopBtn = button('connect-btn connect-btn-outline cj-btn cj-stop', 'Stop Early'); 
    const cancelBtn = button('connect-btn connect-btn-outline cj-btn cj-cancel', 'Cancel'); 
    ends.append(stopBtn, cancelBtn);
    if (showMonitor) bar.append(monBtn, logBtn);
    bar.appendChild(ends);

    const detail = el('p', 'cj-viewer-detail');
    const monitorHost = el('div', 'cj-viewer-monitor');
    const logHost = el('div', 'cj-viewer-logs');
    const tools = el('div', 'cj-viewer-tools');
    const copyBtn = button('connect-btn connect-btn-outline cj-btn', 'Copy'); 
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
        trap.release();
        unsub();
        stream.stop();
        plot.destroy();
        scrim.remove();
        trap.restoreFocus();
        if (props.onClose) props.onClose();
    }
    close.addEventListener('click', doClose);
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) doClose(); });
    const trap = trapModal(scrim, card, { onEscape: doClose, focusable: function (n) { return n.offsetParent !== null; } });
    document.body.appendChild(scrim);
    paint();
    if (view === 'logs') paintLog(true);
    card.focus();
    return { el: scrim, close: doClose, stream: stream };
}
