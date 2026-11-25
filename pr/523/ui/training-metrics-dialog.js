/**
 * ui/training-metrics-dialog.js — View Metrics: sleap-app's "Metrics for Trained Models" table
 * (`src/components/dialogs/ModelMetricsDialog.tsx`, classic SLEAP `MetricsTableDialog`) and its detailed view
 * (`DetailedModelMetricsDialog.tsx`: the labelled scalar list and a per-node distance boxplot).
 *
 * Rows come from `pose/training-model-metrics.js` (`buildModelMetricsRow`): each run folder's
 * `metrics.{split}.0.json` and `training_config.yaml`, read through `host.io` (local: the desktop's read-only
 * runs folder; a worker: `fs.stat` / `fs.read` over Connect). The `.npz` files are never read (pickles).
 *
 * LUCID changes: one card at a time stacked over the panel (vanilla DOM, Esc / Close / scrim, `trapModal`,
 * `data-shortcut-modal`, one scroller each); "Add Trained Model(s)…" only where a folder can be picked
 * (desktop); the boxplot is drawn with the theme's colours.
 */
import { buildModelMetricsRow, labeledMetrics, computeNodeBoxplots, distanceAxisMax, runDirName } from '../pose/training-model-metrics.js?v=e37e05d05839';
import { trapModal } from './connect/layers.js?v=e37e05d05839';
import { el, button } from './panel-form.js?v=e37e05d05839';

const COLUMNS = ['Path', 'Timestamp', 'Model Type', 'Architecture', 'OKS mAP', 'Vis Precision', 'Vis Recall', 'Dist 95%', 'Dist 75%', 'Dist Avg'];
const SVG_NS = 'http://www.w3.org/2000/svg';

let open = null;

/** The open table, or null. */
export function trainingMetricsDialog() { return open; }

function fmt(v, digits) {
    return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits == null ? 4 : digits) : '—';
}

/** A card over the page: `{scrim, card, body, foot, close}`. */
function card(id, title, subtitle, onClose, cls) {
    const scrim = el('div', 'tmd-scrim');
    scrim.id = id;
    scrim.setAttribute('data-shortcut-modal', '1');
    const c = el('div', 'tmd-card' + (cls ? ' ' + cls : ''));
    c.setAttribute('role', 'dialog');
    c.setAttribute('aria-modal', 'true');
    const head = el('div', 'tmd-head');
    const h = el('h2', 'tmd-title', title);
    h.id = id + 'Title';
    c.setAttribute('aria-labelledby', h.id);
    head.appendChild(h);
    if (subtitle) head.appendChild(el('p', 'tmd-sub', subtitle));
    c.appendChild(head);
    const body = el('div', 'tmd-body');
    c.appendChild(body);
    const foot = el('div', 'tmd-foot');
    c.appendChild(foot);
    scrim.appendChild(c);
    document.body.appendChild(scrim);
    const trap = trapModal(scrim, c, { onEscape: function () { close(); } });
    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        trap.release();
        trap.restoreFocus();
        scrim.remove();
        if (onClose) onClose();
    }
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });
    return { scrim: scrim, card: c, body: body, foot: foot, close: close };
}

/**
 * @param {{
 *   runDirs: string[],                                   the run folders to show first (this run's models)
 *   io: {exists: (p) => Promise<boolean>, readText: (p) => Promise<string>, parseYaml: (t) => any},
 *   addModels?: (() => Promise<string[]>) | null,       "Add Trained Model(s)…" (null: not offered)
 * }} host
 */
export function openTrainingMetricsDialog(host) {
    if (open) open.close();
    let dirs = Array.from(new Set(host.runDirs || []));
    let rows = [];
    let loading = false;
    let seq = 0;

    const k = card('trnMetrics', 'Metrics for Trained Models', 'Evaluation metrics for trained models. Click a row for detailed metrics.', function () { open = null; });
    const table = el('table', 'tmd-table');
    const thead = el('thead');
    const hr = el('tr');
    COLUMNS.forEach(function (c) { hr.appendChild(el('th', null, c)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    table.appendChild(tbody);
    k.body.appendChild(table);

    const add = button('Add Trained Model(s)…', 'btn btn-sm inf-btn-outline', 'folder-open');
    add.id = 'tmdAdd';
    add.hidden = !host.addModels;
    add.addEventListener('click', async function () {
        let picked = [];
        try { picked = await host.addModels(); } catch (e) { picked = []; }
        if (picked && picked.length) { dirs = Array.from(new Set(dirs.concat(picked))); load(); }
    });
    const closeBtn = button('Close', 'btn btn-sm');
    closeBtn.addEventListener('click', function () { k.close(); });
    k.foot.appendChild(add);
    k.foot.appendChild(closeBtn);

    function draw() {
        tbody.textContent = '';
        if (!rows.length) {
            const tr = el('tr');
            const td = el('td', 'tmd-empty', loading ? 'Loading…' : 'No trained models. Use “Add Trained Model(s)…” to add a run folder.');
            td.colSpan = COLUMNS.length;
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
        }
        rows.forEach(function (row) {
            const s = row.summary || {};
            const tr = el('tr', 'tmd-row');
            tr.tabIndex = 0;
            tr.dataset.path = row.path;
            const name = el('td', 'tmd-mono tmd-path', (row.error ? '⚠ ' : '') + runDirName(row.path));
            name.title = row.path + (row.error ? '\n' + row.error : '');
            tr.appendChild(name);
            [row.timestamp || '—', row.modelType || '—', row.architecture || '—'].forEach(function (t) { tr.appendChild(el('td', 'tmd-nowrap', t)); });
            [s.oksMAP, s.visPrecision, s.visRecall, s.distP95, s.distP75, s.distAvg].forEach(function (v) { tr.appendChild(el('td', 'tmd-mono tmd-num', fmt(v))); });
            tr.addEventListener('click', function () { openDetail(row); });
            tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') openDetail(row); });
            tbody.appendChild(tr);
        });
    }

    async function load() {
        const my = ++seq;
        loading = true;
        draw();
        const built = await Promise.all(dirs.map(function (d) { return buildModelMetricsRow(d, host.io); }));
        if (my !== seq || !open) return;
        rows = built;
        loading = false;
        draw();
    }

    open = { close: k.close, rows: function () { return rows; }, reload: load };
    load();
    closeBtn.focus();
    return open;
}

/** sleap-app DetailedModelMetricsDialog: the run's metrics as a list, and node distances as boxplots. */
function openDetail(row) {
    const k = card('trnMetricsDetail', row.runName || runDirName(row.path), row.path, null, 'tmd-card-detail');
    if (row.error) k.body.appendChild(el('p', 'tmd-error', 'Could not read this run’s metrics: ' + row.error));
    const m = row.metrics;
    if (!m) k.body.appendChild(el('p', 'tmd-empty', 'This run has no metrics file (metrics.val.0.json). sleap-nn writes it when training ends.'));
    if (m && m.distance && m.distance.dists.length) {
        const perNode = m.distance.perNode !== false;
        k.body.appendChild(el('h3', 'tmd-h3', perNode ? 'Distance between ground truth and prediction, per node (px)'
            : 'Distance between ground truth and predicted centroids (px)'));
        k.body.appendChild(boxplotSvg(computeNodeBoxplots(m.distance.dists, perNode ? row.nodeNames : ['centroid']), distanceAxisMax(m.distance.dists)));
    }
    const list = labeledMetrics(m);
    if (list.length) {
        const dl = el('dl', 'tmd-list');
        list.forEach(function (x) {
            dl.appendChild(el('dt', null, x.label));
            dl.appendChild(el('dd', 'tmd-mono', Number.isInteger(x.value) ? x.value.toLocaleString('en-US') : fmt(x.value)));
        });
        k.body.appendChild(dl);
    }
    const closeBtn = button('Close', 'btn btn-sm');
    closeBtn.addEventListener('click', function () { k.close(); });
    k.foot.appendChild(closeBtn);
    closeBtn.focus();
}

/** Horizontal boxplots, one row per node: whiskers min–p95, box q1–q3, median line (sleap-app's layout). */
function boxplotSvg(stats, xmax) {
    const rowH = 22, left = 120, right = 16, top = 8, axisH = 26, width = 640;
    const h = top + stats.length * rowH + axisH;
    const x = function (v) { return left + (Math.max(0, Math.min(xmax, v)) / xmax) * (width - left - right); };
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + h);
    svg.setAttribute('class', 'tmd-box');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Node distance boxplot (ground truth vs prediction)');
    const mk = function (tag, attrs, text, parent) {
        const n = document.createElementNS(SVG_NS, tag);
        Object.keys(attrs).forEach(function (a) { n.setAttribute(a, attrs[a]); });
        if (text != null) n.textContent = text;
        (parent || svg).appendChild(n);
        return n;
    };
    for (let t = 0; t <= xmax; t += Math.max(1, Math.round(xmax / 5))) {
        mk('line', { x1: x(t), x2: x(t), y1: top, y2: h - axisH, class: 'tmd-grid' });
        mk('text', { x: x(t), y: h - 8, 'text-anchor': 'middle', class: 'tmd-tick' }, String(t));
    }
    stats.forEach(function (b, i) {
        const cy = top + i * rowH + rowH / 2;
        const g = mk('g', { class: 'tmd-node-row' });
        mk('text', { x: left - 8, y: cy + 4, 'text-anchor': 'end', class: 'tmd-node' }, b.node, g);
        if (!b.count) { mk('text', { x: left + 4, y: cy + 4, class: 'tmd-tick' }, 'no data', g); return; }
        mk('title', {}, b.node + ': median ' + b.median.toFixed(2) + ' px, IQR ' + b.q1.toFixed(2) + '–' + b.q3.toFixed(2) +
            ', 95% ' + b.p95.toFixed(2) + ' (' + b.count.toLocaleString('en-US') + ')', g);
        mk('line', { x1: x(b.min), x2: x(b.p95), y1: cy, y2: cy, class: 'tmd-whisker' }, null, g);
        mk('rect', { x: x(b.q1), y: cy - 7, width: Math.max(1, x(b.q3) - x(b.q1)), height: 14, class: 'tmd-iqr' }, null, g);
        mk('line', { x1: x(b.median), x2: x(b.median), y1: cy - 7, y2: cy + 7, class: 'tmd-median' }, null, g);
    });
    return svg;
}
