/**
 * ui/training-monitor.js — the Training Monitor: one model's live loss curves, opened from its
 * progress row in the Training panel.
 *
 * Port of sleap-app `src/components/monitors/LossViewerDialog.tsx` @ c97c6a5: title "Training
 * Monitor — <model>", the runtime lines (`pose/training-metrics.js`, bold numbers as sleap-app's
 * `renderTitleLine`), the loss plot, the error output of a failed run, and Stop Early / Cancel pinned
 * at the bottom while the shown model is the one training.
 *
 * LUCID changes:
 *  - the plot is LUCID's canvas port of `LossPlot.tsx` (`ui/connect/loss-plot.js`, the Connect job
 *    viewer's), drawn in LUCID's colours rather than on sleap-app's white plot;
 *  - vanilla DOM card (Esc / ✕ / scrim close, Tab trapped, `data-shortcut-modal`); it redraws on
 *    the panel's refresh, at most every 250 ms;
 *  - the validation / train images (`VizImageViewer`): local runs only (`readFile`), read from the
 *    run folder's `viz/` while sleap-nn writes them (it deletes them when the run ends unless
 *    `keep_viz`); a worker's run folder is not reachable from the page.
 */
import { createLossPlot } from './connect/loss-plot.js?v=d8c111d6b6c2';
import { trapModal } from './connect/layers.js?v=d8c111d6b6c2';
import { el, button } from './panel-form.js?v=d8c111d6b6c2';
import { rowRuntimeLines } from '../pose/training-metrics.js?v=d8c111d6b6c2';

let open = null;

/** Wrap numbers (ints, decimals, mm:ss, exponents) in <strong> (sleap-app `renderTitleLine`). */
function titleLine(text) {
    const d = el('div');
    String(text).split(/(\d+:\d+|\d+\.\d+e[-+]?\d+|\d+(?:\.\d+)?)/g).forEach(function (p) {
        if (/^(?:\d+:\d+|\d+\.\d+e[-+]?\d+|\d+(?:\.\d+)?)$/.test(p)) d.appendChild(el('strong', null, p));
        else if (p) d.appendChild(document.createTextNode(p));
    });
    return d;
}

/**
 * Open the monitor (one at a time; opening another model replaces the shown one).
 * @param {{
 *   row: () => Object,              // the model's progress row (`emptyModelProgress` shape + times)
 *   runStatus: () => string,        // 'running' | 'completed' | 'error' | 'idle'
 *   isActive: () => boolean,        // the shown model is the one training now
 *   errorLines: () => string[],
 *   onStopEarly: () => void, onCancel: () => void,
 *   readFile?: ((path: string) => Promise<Uint8Array>) | null,   // local runs: the viz images
 * }} o
 * @returns {{update: () => void, close: () => void}}
 */
export function openTrainingMonitor(o) {
    if (open) open.close();
    const scrim = el('div', 'trn-mon-scrim');
    scrim.id = 'trnMonitor';
    scrim.setAttribute('data-shortcut-modal', '1');
    const card = el('div', 'trn-mon');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const head = el('div', 'trn-mon-head');
    const title = el('span', 'trn-mon-title');
    title.id = 'trnMonTitle';
    const x = button('', 'trn-mon-x', 'x');
    x.setAttribute('aria-label', 'Close');
    head.appendChild(title); head.appendChild(x);
    card.setAttribute('aria-labelledby', 'trnMonTitle');
    const body = el('div', 'trn-mon-body');
    const errBox = el('div', 'trn-errout');
    errBox.appendChild(el('span', 'inf-label', 'Training error output (sleap-nn)'));
    const errPre = el('pre', 'inf-log');
    errBox.appendChild(errPre);
    const runtime = el('div', 'trn-mon-runtime');
    runtime.id = 'trnMonRuntime';
    const plotHost = el('div', 'trn-mon-plot');
    body.appendChild(errBox); body.appendChild(runtime); body.appendChild(plotHost);
    // Validation / train prediction images (sleap-nn: <run>/viz/{validation,train}.NNNN.png, 0-based).
    const viz = el('div', 'trn-mon-viz');
    viz.id = 'trnMonViz';
    const vizHead = el('div', 'trn-mon-vizhead');
    const vizTabs = el('div', 'trn-seg');
    let vizKind = 'validation';
    [['validation', 'Validation'], ['train', 'Train']].forEach(function (k) {
        const b = button(k[1], 'trn-seg-btn');
        b.dataset.kind = k[0];
        b.addEventListener('click', function () { vizKind = k[0]; vizShown = ''; paint(); });
        vizTabs.appendChild(b);
    });
    const vizLabel = el('span', 'trn-mon-vizlabel');
    vizHead.appendChild(vizTabs); vizHead.appendChild(vizLabel);
    const vizImg = el('img', 'trn-mon-vizimg');
    vizImg.alt = 'Sample predictions of the shown epoch';
    const vizEmpty = el('div', 'trn-mon-vizempty');
    viz.appendChild(vizHead); viz.appendChild(vizImg); viz.appendChild(vizEmpty);
    body.appendChild(viz);
    let vizShown = '', vizUrl = null, vizBusy = false;
    const foot = el('div', 'trn-mon-foot');
    const stop = button('Stop Early', 'btn btn-sm trn-stop');
    stop.id = 'trnMonStopEarly';
    const cancel = button('Cancel', 'btn btn-sm inf-btn-danger');
    cancel.id = 'trnMonCancel';
    foot.appendChild(stop); foot.appendChild(cancel);
    card.appendChild(head); card.appendChild(body); card.appendChild(foot);
    scrim.appendChild(card);
    document.body.appendChild(scrim);

    const plot = createLossPlot(plotHost, { height: 320, titleLines: false });
    const trap = trapModal(scrim, card, { onEscape: function () { close(); } });
    let last = 0, pending = null, closed = false;

    function paint() {
        if (closed) return;
        last = Date.now();
        const r = o.row();
        if (!r) return;
        const st = o.runStatus();
        title.textContent = 'Training Monitor — ' + r.label;
        runtime.textContent = '';
        if (r.epochSamples.length || r.status === 'running') rowRuntimeLines(r, Date.now()).forEach(function (l) { runtime.appendChild(titleLine(l)); });
        plot.update({ model: r, status: r.status === 'running' ? 'running' : st });
        paintViz(r);
        const errs = st === 'error' ? o.errorLines() : [];
        errBox.hidden = errs.length === 0;
        errPre.textContent = errs.join('\n');
        foot.hidden = !o.isActive();
    }
    function paintViz(r) {
        viz.hidden = !o.readFile || !r.runDir;
        if (viz.hidden) return;
        for (const b of vizTabs.children) b.setAttribute('aria-pressed', b.dataset.kind === vizKind ? 'true' : 'false');
        const last = r.epochSamples.length ? r.epochSamples[r.epochSamples.length - 1].epoch : null;
        if (last == null) { vizLabel.textContent = ''; vizImg.hidden = true; vizEmpty.textContent = 'Images appear after the first epoch.'; vizEmpty.hidden = false; return; }
        const name = vizKind + '.' + String(last).padStart(4, '0') + '.png';
        vizLabel.textContent = name;
        if (name === vizShown || vizBusy) return;
        vizBusy = true;
        const sep = String(r.runDir).indexOf('\\') !== -1 && String(r.runDir).indexOf('/') === -1 ? '\\' : '/';
        o.readFile(r.runDir + sep + 'viz' + sep + name).then(function (bytes) {
            if (closed) return;
            if (vizUrl) URL.revokeObjectURL(vizUrl);
            vizUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
            vizImg.src = vizUrl;
            vizImg.hidden = false;
            vizEmpty.hidden = true;
            vizShown = name;
        }, function () {
            if (closed) return;
            vizImg.hidden = true;
            vizEmpty.textContent = 'No image for this epoch (sleap-nn removes them when a run ends, unless it keeps them).';
            vizEmpty.hidden = false;
            vizShown = name;
        }).then(function () { vizBusy = false; });
    }

    function update() {
        if (closed) return;
        const wait = 250 - (Date.now() - last);
        if (wait <= 0) { paint(); return; }
        if (!pending) pending = setTimeout(function () { pending = null; paint(); }, wait);
    }
    function close() {
        if (closed) return;
        closed = true;
        if (pending) clearTimeout(pending);
        trap.release();
        trap.restoreFocus();
        plot.destroy();
        if (vizUrl) URL.revokeObjectURL(vizUrl);
        scrim.remove();
        if (open === api) open = null;
    }
    x.addEventListener('click', close);
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });
    stop.addEventListener('click', function () { o.onStopEarly(); });
    cancel.addEventListener('click', function () { o.onCancel(); });
    const api = { update: update, close: close, isOpen: function () { return !closed; } };
    open = api;
    paint();
    x.focus();
    return api;
}

/** The open monitor, or null. */
export function trainingMonitor() { return open; }
