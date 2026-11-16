/**
 * ui/connect/loss-plot.js — the loss curve of the job viewer's Monitor tab.
 *
 * Port of sleap-app's use of src/components/monitors/LossPlot.tsx @ 683a159 by JobViewerDialog: batch loss
 * scatter, epoch train / val lines, best-val ring, log-y axis, the same empty-state texts.
 *
 * LUCID changes:
 *  - a plain `<canvas>` (no uPlot), coloured from the theme's CSS variables;
 *  - controls: Log scale, Ignore outliers, Batches (200 / 1000 / 5000 / All), Reset zoom (drag zooms the
 *    batch axis, double-click resets), PNG / CSV export (`downloadBytes`), a hover tooltip;
 *  - a one-line title (epoch / loss / best val): wall-clock metrics do not exist for a replayed job.
 */

import { downloadBytes } from '../../import-export/file-io.js';
import { el, button } from './dom.js';

/** Cap on drawn batch dots (a 20k-point scatter is not legible and costs a frame). */
const MAX_BATCH_DOTS = 2000;

function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** The y range of `values` (sleap-app `computeYRange`, bounded): log-aware, optionally trimmed to Tukey fences. */
function lossYRange(values, o) {
    const finite = values.filter(function (v) { return Number.isFinite(v); });
    const vals = o.logScale ? finite.filter(function (v) { return v > 0; }).map(Math.log10) : finite;
    if (!vals.length) return null;
    vals.sort(function (a, b) { return a - b; });
    let lo = vals[0], hi = vals[vals.length - 1];
    if (o.ignoreOutliers && vals.length >= 4) {
        const q1 = quantile(vals, 0.25), q3 = quantile(vals, 0.75), iqr = q3 - q1;
        lo = Math.max(q1 - 1.5 * iqr, lo);
        hi = Math.min(q3 + 1.5 * iqr, hi);
    }
    const pad = hi > lo ? (hi - lo) * 0.02 : (o.logScale ? 0.05 : Math.max(Math.abs(lo) * 0.05, 1e-6));
    lo -= pad; hi += pad;
    return o.logScale ? [Math.pow(10, lo), Math.pow(10, hi)] : [lo, hi];
}

/** Round tick values over [min, max]: decades when `log`, else 1-2-5 steps. */
function lossTicks(min, max, log) {
    const out = [];
    if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return out;
    if (log) {
        for (let e = Math.ceil(Math.log10(min)); e <= Math.floor(Math.log10(max)) && out.length < 40; e++) out.push(Math.pow(10, e));
        return out;
    }
    const raw = (max - min) / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map(function (m) { return m * mag; }).find(function (s) { return s >= raw; });
    for (let v = Math.ceil(min / step) * step, n = 0; v <= max && n < 40; v += step, n++) out.push(v);
    return out;
}

function fmt(v) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    return (a >= 1000 || a < 0.001) ? v.toExponential(0) : String(Math.round(v * 10000) / 10000);
}

/** CSV of the per-epoch loss curve (sleap-app `lossCsv`): `epoch,train_loss,val_loss`, 1-based epochs, trailing newline. */
function lossCsv(epochSamples) {
    const rows = ['epoch,train_loss,val_loss'];
    epochSamples.forEach(function (s) {
        rows.push((s.epoch + 1) + ',' + (s.trainLoss == null ? '' : String(s.trainLoss)) + ',' + (s.valLoss == null ? '' : String(s.valLoss)));
    });
    return rows.join('\n') + '\n';
}

/** The one-line title: epoch is `model.epoch` (completed epochs, sleap-app's `Training Epoch ${epoch + 1}`), best epoch 1-based. */
export function lossTitle(m) {
    const last = m.epochSamples[m.epochSamples.length - 1];
    const parts = ['Epoch ' + m.epoch + ' / ' + m.maxEpochs];
    if (last && last.trainLoss != null) parts.push('train loss ' + last.trainLoss.toFixed(4));
    if (last && last.valLoss != null) parts.push('val loss ' + last.valLoss.toFixed(4));
    if (m.bestValLoss != null) parts.push('best val ' + m.bestValLoss.toFixed(4) + (m.metrics && m.metrics.bestValEpoch != null ? ' @ epoch ' + (m.metrics.bestValEpoch + 1) : ''));
    return parts.join(' \u00b7 ');
}

/**
 * @param {HTMLElement} container
 * @param {{height?: number}} [props]
 * @returns {{ update: (p: {model: any, status: string}) => void, destroy: () => void }}
 */
export function createLossPlot(container, props) {
    const height = (props && props.height) || 200;
    let logScale = true, ignoreOutliers = false, batchesToShow = -1;
    let zoom = null;          // {x0, x1} on the batch axis, or null = whole range
    let scene = null;         // the last drawing: pixel points for the tooltip, the plot box, the x mapping
    let cur = null;

    const root = el('div', 'cj-loss');
    const title = el('div', 'cj-loss-title');
    const legend = el('div', 'cj-loss-legend');
    [['batch', 'Batch Training Loss'], ['train', 'Epoch Training Loss'], ['val', 'Epoch Validation Loss'], ['best', 'Best Validation Loss']].forEach(function (x) {
        const s = el('span', 'cj-loss-key');
        s.append(el('span', 'cj-loss-swatch ' + x[0]), x[1]);
        legend.appendChild(s);
    });
    const empty = el('div', 'cj-loss-empty');
    empty.style.height = height + 'px';
    const wrap = el('div', 'cj-loss-wrap');
    const canvas = el('canvas', 'cj-loss-canvas');
    canvas.style.height = height + 'px';
    const tip = el('div', 'cj-loss-tip');
    tip.hidden = true;
    const sel = el('div', 'cj-loss-sel');
    sel.hidden = true;
    wrap.append(canvas, sel, tip);
    const opts = el('div', 'cj-loss-opts');
    function check(label, on, set) {
        const l = el('label', 'cj-check');
        const i = el('input'); i.type = 'checkbox'; i.checked = on;
        i.addEventListener('change', function () { set(i.checked); draw(); });
        l.append(i, label);
        return l;
    }
    const batchLab = el('label', 'cj-check', 'Batches: ');
    const batchSel = el('select', 'cj-select cj-loss-batches');
    batchSel.setAttribute('aria-label', 'Batches to show');
    [['200', '200'], ['1000', '1000'], ['5000', '5000'], ['-1', 'All']].forEach(function (o) {
        const op = el('option', null, o[1]); op.value = o[0]; batchSel.appendChild(op);
    });
    batchSel.value = '-1';
    batchSel.addEventListener('change', function () { batchesToShow = Number(batchSel.value); draw(); });
    batchLab.appendChild(batchSel);
    function tool(text, tt, fn, id) {
        const b = button('connect-btn connect-btn-ghost cj-loss-tool', text, tt);
        b.id = id;
        b.addEventListener('click', fn);
        return b;
    }
    const tools = el('span', 'cj-loss-tools');
    tools.append(
        tool('Reset zoom', 'Reset zoom (drag on the plot to zoom in; double-click also resets)', function () { zoom = null; draw(); }, 'cjLossReset'),
        tool('PNG', 'Export the plot as a PNG image', exportPng, 'cjLossPng'),
        tool('CSV', 'Export the loss values as CSV', exportCsv, 'cjLossCsv'));
    opts.append(check('Log scale', true, function (v) { logScale = v; }), check('Ignore outliers', false, function (v) { ignoreOutliers = v; }), batchLab, tools);
    root.append(title, legend, empty, wrap, opts);
    container.appendChild(root);

    function fileBase() { return ((cur && cur.model && cur.model.label) || 'model').replace(/[\\/:*?"<>|]+/g, '_'); }
    function exportPng() {
        if (!cur) return;
        canvas.toBlob(function (blob) {
            if (!blob) return;
            blob.arrayBuffer().then(function (buf) { downloadBytes(new Uint8Array(buf), fileBase() + '-loss.png', 'image/png'); });
        }, 'image/png');
    }
    function exportCsv() {
        if (!cur) return;
        downloadBytes(new TextEncoder().encode(lossCsv(cur.model.epochSamples)), fileBase() + '-loss.csv', 'text/csv');
    }

    function color(name, fallback) {
        const v = getComputedStyle(canvas).getPropertyValue(name).trim();
        return v || fallback;
    }

    function draw() {
        if (!cur) return;
        const m = cur.model, running = cur.status === 'running';
        const hasData = m.batchSamples.length > 0 || m.epochSamples.length > 0;
        empty.style.display = hasData ? 'none' : '';
        wrap.style.display = hasData ? '' : 'none';
        legend.style.display = opts.style.display = hasData ? '' : 'none';
        tip.hidden = true;
        if (!hasData) {
            scene = null;
            title.textContent = running ? 'Waiting for first epoch\u2026' : 'No loss data';
            empty.textContent = running ? 'Loss curves will appear after the first epoch completes.' : 'No loss data was recorded for this model.';
            return;
        }
        title.textContent = lossTitle(m);

        const es = m.epochSize || 1;
        // "Batches": the last N batch dots (epoch points always stay), then at most MAX_BATCH_DOTS drawn.
        const bs = batchesToShow > 0 && m.batchSamples.length > batchesToShow ? m.batchSamples.slice(m.batchSamples.length - batchesToShow) : m.batchSamples;
        const step = Math.max(1, Math.ceil(bs.length / MAX_BATCH_DOTS));
        const batch = [];
        for (let i = 0; i < bs.length; i += step) batch.push([bs[i].globalBatch, bs[i].loss]);
        const lastB = bs[bs.length - 1];
        if (lastB && (!batch.length || batch[batch.length - 1][0] !== lastB.globalBatch)) batch.push([lastB.globalBatch, lastB.loss]);
        const train = [], val = [];
        m.epochSamples.forEach(function (e) {
            const x = (e.epoch + 1) * es;
            if (e.trainLoss != null) train.push([x, e.trainLoss]);
            if (e.valLoss != null) val.push([x, e.valLoss]);
        });
        const best = m.metrics && m.metrics.bestValEpoch != null && m.bestValLoss != null ? [(m.metrics.bestValEpoch + 1) * es, m.bestValLoss] : null;

        const all = batch.concat(train, val, best ? [best] : []).filter(function (p) { return Number.isFinite(p[0]); });
        const xs = all.map(function (p) { return p[0]; });
        let x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
        if (!(x1 > x0)) { x0 -= 1; x1 += 1; }
        const fullX = [x0, x1];
        if (zoom && zoom.x1 > zoom.x0) { x0 = zoom.x0; x1 = zoom.x1; }
        const yr = lossYRange(all.map(function (p) { return p[1]; }), { logScale: logScale, ignoreOutliers: ignoreOutliers }) || [logScale ? 0.001 : 0, 1];
        let y0 = yr[0], y1 = yr[1];
        if (!(y1 > y0)) { y1 = y0 * 1.1 || 1; }

        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth || 400;
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(height * dpr);
        const g = canvas.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const cTrain = color('--accent', '#667eea'), cVal = color('--warning-color', '#f39c12'), cBest = color('--success-color', '#2ecc71');
        const cText = color('--text-muted', '#777'), cGrid = color('--border-color', '#3a3a3a'), cBg = color('--bg-primary', '#1a1a1a');
        g.clearRect(0, 0, w, height);
        g.fillStyle = cBg; g.fillRect(0, 0, w, height);   // also fills the margins, so an exported PNG is not transparent
        const L = 44, R = 8, T = 6, B = 32;
        const pw = w - L - R, ph = height - T - B;
        const ty = function (v) {
            const f = logScale ? (Math.log10(Math.max(v, y0)) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0)) : (v - y0) / (y1 - y0);
            return T + ph * (1 - Math.min(1, Math.max(0, f)));
        };
        const tx = function (v) { return L + pw * (v - x0) / (x1 - x0); };
        g.font = '10px sans-serif'; g.fillStyle = cText; g.strokeStyle = cGrid; g.lineWidth = 1;
        g.textAlign = 'right'; g.textBaseline = 'middle';
        lossTicks(y0, y1, logScale).forEach(function (v) {
            const y = Math.round(ty(v)) + 0.5;
            g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
            g.fillText(fmt(v), L - 4, y);
        });
        g.textAlign = 'center'; g.textBaseline = 'top';
        lossTicks(x0, x1, false).forEach(function (v) { g.fillText(fmt(v), tx(v), T + ph + 4); });
        g.fillText('Batches', L + pw / 2, T + ph + 17);
        g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
        g.globalAlpha = 0.45; g.fillStyle = cTrain;
        batch.forEach(function (p) { g.beginPath(); g.arc(tx(p[0]), ty(p[1]), 1.5, 0, 6.2832); g.fill(); });
        g.globalAlpha = 1;
        [[train, cTrain], [val, cVal]].forEach(function (s) {
            if (!s[0].length) return;
            g.strokeStyle = s[1]; g.fillStyle = s[1]; g.lineWidth = 2;
            g.beginPath();
            s[0].forEach(function (p, i) { if (i) g.lineTo(tx(p[0]), ty(p[1])); else g.moveTo(tx(p[0]), ty(p[1])); });
            g.stroke();
            s[0].forEach(function (p) { g.beginPath(); g.arc(tx(p[0]), ty(p[1]), 3, 0, 6.2832); g.fill(); });
        });
        if (best) { g.strokeStyle = cBest; g.lineWidth = 2; g.beginPath(); g.arc(tx(best[0]), ty(best[1]), 5.5, 0, 6.2832); g.stroke(); }
        g.restore();
        // The legend swatches follow the same variables.
        root.style.setProperty('--cj-train', cTrain); root.style.setProperty('--cj-val', cVal); root.style.setProperty('--cj-best', cBest);

        // What the tooltip and the drag-zoom read back.
        const pts = [];
        [['Batch Training Loss', batch], ['Epoch Training Loss', train], ['Epoch Validation Loss', val], ['Best Validation Loss', best ? [best] : []]].forEach(function (s) {
            s[1].forEach(function (p) { if (p[0] >= x0 && p[0] <= x1) pts.push({ label: s[0], bx: p[0], v: p[1], px: tx(p[0]), py: ty(p[1]) }); });
        });
        canvas.__scene = scene = { L: L, T: T, pw: pw, ph: ph, x0: x0, x1: x1, fullX: fullX, pts: pts };
    }

    // ---- hover tooltip: the nearest drawn point (series, batch number, loss)
    function localX(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    let drag = null;
    canvas.addEventListener('mousemove', function (e) {
        if (!scene) return;
        const c = localX(e);
        if (drag) {
            drag.x = c[0];
            const a = Math.max(scene.L, Math.min(drag.x0px, drag.x)), b = Math.min(scene.L + scene.pw, Math.max(drag.x0px, drag.x));
            sel.hidden = false; sel.style.left = a + 'px'; sel.style.width = Math.max(0, b - a) + 'px'; sel.style.height = scene.ph + 'px'; sel.style.top = scene.T + 'px';
            tip.hidden = true;
            return;
        }
        let bestPt = null, bestD = 14 * 14;
        scene.pts.forEach(function (p) {
            const d = (p.px - c[0]) * (p.px - c[0]) + (p.py - c[1]) * (p.py - c[1]);
            if (d <= bestD) { bestD = d; bestPt = p; }
        });
        if (!bestPt) { tip.hidden = true; return; }
        tip.hidden = false;
        tip.textContent = bestPt.label + ' \u00b7 batch ' + Math.round(bestPt.bx).toLocaleString('en-US') + ' \u00b7 ' + bestPt.v.toPrecision(4);
        tip.style.left = Math.min(c[0] + 10, Math.max(0, canvas.clientWidth - 220)) + 'px';
        tip.style.top = Math.max(0, c[1] - 26) + 'px';
    });
    canvas.addEventListener('mouseleave', function () { tip.hidden = true; });
    canvas.addEventListener('mousedown', function (e) {
        if (!scene || e.button !== 0) return;
        const c = localX(e);
        drag = { x0px: c[0], x: c[0] };
    });
    function endDrag() {
        if (!drag) return;
        const d = drag; drag = null; sel.hidden = true;
        if (!scene || Math.abs(d.x - d.x0px) < 4) return;
        const toX = function (px) { return scene.x0 + (Math.max(scene.L, Math.min(scene.L + scene.pw, px)) - scene.L) / scene.pw * (scene.x1 - scene.x0); };
        const a = toX(Math.min(d.x0px, d.x)), b = toX(Math.max(d.x0px, d.x));
        if (b > a) { zoom = { x0: a, x1: b }; draw(); }
    }
    window.addEventListener('mouseup', endDrag);
    canvas.addEventListener('dblclick', function () { zoom = null; draw(); });

    const onResize = function () { draw(); };
    window.addEventListener('resize', onResize);

    return {
        update: function (p) { cur = p; draw(); },
        destroy: function () { window.removeEventListener('resize', onResize); window.removeEventListener('mouseup', endDrag); root.remove(); },
    };
}
