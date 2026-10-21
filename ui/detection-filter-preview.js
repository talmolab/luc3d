// ui/detection-filter-preview.js — the Tracking Wizard's "what these filters
// would remove" readout.
//
// Sits under the two detection-filter fields (min visible nodes, min instance
// score) and says, per camera and over the tracked cameras, what share of the
// loaded detections each filter removes at the value being typed, how many the
// two remove together and how many fail both. A low camera's detections can
// score far below the others', so a value that is harmless for most cameras
// can empty one of them — the per-camera rows are the point.
//
// Below that, the distribution of each camera's mean per-point confidence, with
// a preview-only threshold: LUCID has no such filter, but sleap-nn's inference
// filter on it is what removed most of a low camera's detections in our data.
//
// The session is walked ONCE, one camera per task after the modal is up
// (`collectDetectionStatsAsync`), so opening the wizard costs nothing; every
// edit afterwards is a pass over typed arrays (`countDetectionFilters`).

import {
    collectDetectionStatsAsync,
    countDetectionFilters,
    meanPointScoreHistograms,
    flagOutlierCameras,
} from '../pose/detection-filter-stats.js';

const HIST_BINS = 10;
const DEFAULT_PREVIEW_MPS = 0.75;

function fmtCount(n) { return Number(n).toLocaleString('en-US'); }

/** "12.3%", "<0.1%" for a nonzero sliver, "0%" for none, "—" with no denominator. */
export function fmtShare(part, whole) {
    if (!whole) return '—';
    if (!part) return '0%';
    const p = 100 * part / whole;
    if (p < 0.1) return '<0.1%';
    if (p > 99.9 && part < whole) return '>99.9%';
    return (p >= 99.95 ? '100' : p.toFixed(1)) + '%';
}

// One sentence per flagged camera — "sideC loses 13.7% of its detections,
// against 0% for the other cameras (median)" — and, given the total's share,
// that the total row hides it.
function outlierNote(flags, verb, qualifier, totalShare) {
    if (!flags.length) return null;
    const parts = flags.map(function (f) {
        return f.name + ' ' + verb + ' ' + fmtShare(f.share, 1) + qualifier + ', against ' +
            fmtShare(f.othersMedian, 1) + ' for the other cameras (median)';
    });
    let text = parts.join('; ') + '.';
    if (totalShare != null) text += ' The total (' + fmtShare(totalShare, 1) + ') hides this.';
    return el('div', 'dfp-note dfp-warn dfp-outlier-note', text);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

// A table cell reading "12.3% (1,234)"; the count is muted.
function shareCell(part, whole) {
    const td = el('td', 'dfp-num');
    td.appendChild(document.createTextNode(fmtShare(part, whole)));
    if (whole && part) td.appendChild(el('span', 'dfp-count', ' (' + fmtCount(part) + ')'));
    return td;
}

/**
 * @param {{
 *   session: Object|null,
 *   getValues: () => {minVisibleNodes: number, minInstanceScore: number},
 *   isCameraIncluded?: (name: string) => boolean,
 * }} opts
 * @returns {{root: HTMLElement, update: () => void, start: () => Promise<void>, dispose: () => void}}
 *   `start()` begins the one walk of the session (idempotent; resolves when the
 *   counts are on screen).
 */
export function buildDetectionFilterPreview(opts) {
    const session = opts.session || null;
    const included = opts.isCameraIncluded || function () { return true; };
    let stats = null;
    let hists = null;
    let disposed = false;
    let previewMps = DEFAULT_PREVIEW_MPS;

    const root = el('div', 'dfp');
    root.setAttribute('data-testid', 'detection-filter-preview');
    root.appendChild(el('div', 'dfp-title', 'What these filters would remove'));
    const body = el('div', 'dfp-body');
    root.appendChild(body);

    function message(text, cls) {
        body.textContent = '';
        body.appendChild(el('div', 'dfp-note' + (cls ? ' ' + cls : ''), text));
    }

    function renderFilters(counts) {
        const v = opts.getValues();
        const t = counts.total;
        const nCams = counts.perCamera.filter(function (r) { return r.included; }).length;
        body.appendChild(el('div', 'dfp-note',
            'Out of ' + fmtCount(t.detections) + ' detections in ' + nCams + ' tracked camera' + (nCams === 1 ? '' : 's') +
            ' of this session. Updates as you type; nothing is removed until you track.'));

        const table = el('table', 'dfp-table dfp-filters');
        const head = el('tr');
        ['Camera', 'Detections', 'Too few nodes', 'Low instance score', 'Removed', 'Fail both'].forEach(function (h) {
            head.appendChild(el('th', null, h));
        });
        table.appendChild(el('thead')).appendChild(head);
        const tb = el('tbody');
        table.appendChild(tb);

        // The camera(s) losing far more than the rest: what the total hides.
        const flags = flagOutlierCameras(counts.perCamera, 'removed');
        const flagged = new Set(flags.map(function (f) { return f.name; }));

        function row(r, isTotal) {
            const isFlagged = !isTotal && flagged.has(r.name);
            const tr = el('tr', isTotal ? 'dfp-total' : (r.included ? (isFlagged ? 'dfp-flagged' : '') : 'dfp-excluded'));
            tr.setAttribute('data-camera', isTotal ? '' : r.name);
            const name = el('td', 'dfp-cam', isTotal ? 'All tracked cameras' : r.name);
            if (!isTotal && !r.included) name.appendChild(el('span', 'dfp-tag', 'excluded'));
            if (isFlagged) name.appendChild(el('span', 'dfp-tag dfp-tag-warn', 'loses far more'));
            tr.appendChild(name);
            tr.appendChild(el('td', 'dfp-num', fmtCount(r.detections)));
            tr.appendChild(shareCell(r.failVisible, r.detections));
            const sc = shareCell(r.failScore, r.detections);
            sc.classList.add('dfp-score');
            if (!isTotal && r.predicted > 0 && r.predictedWithScore === 0) {
                const tag = el('span', 'dfp-tag dfp-tag-warn', 'no scores');
                tag.title = 'This camera\'s predictions carry no instance scores (all 0), so any minimum above 0 removes every one of them.';
                sc.appendChild(tag);
            }
            tr.appendChild(sc);
            const rm = shareCell(r.removed, r.detections);
            rm.classList.add('dfp-removed');
            tr.appendChild(rm);
            tr.appendChild(shareCell(r.failsBoth, r.detections));
            tb.appendChild(tr);
        }
        counts.perCamera.forEach(function (r) { row(r, false); });
        if (counts.perCamera.length > 1) row(t, true);
        body.appendChild(table);
        const note = outlierNote(flags, 'loses', ' of its detections', t.detections ? t.removed / t.detections : null);
        if (note) body.appendChild(note);

        // Scores the file never had: say so, rather than let a column of
        // numbers read as a verdict.
        if (stats.totals.predicted > 0 && !stats.hasInstanceScores) {
            body.appendChild(el('div', 'dfp-note dfp-warn',
                'The loaded predictions have no instance scores (every one is 0). ' +
                (v.minInstanceScore > 0
                    ? 'At a minimum above 0 the instance-score filter removes every predicted detection.'
                    : 'Leave the minimum instance score at 0, or it removes every predicted detection.')));
        }
    }

    function renderPointScores() {
        const sec = el('div', 'dfp-mps');
        sec.appendChild(el('div', 'dfp-subtitle', 'Mean point confidence (preview only — not a filter)'));
        body.appendChild(sec);
        if (!stats.hasPointScores) {
            sec.appendChild(el('div', 'dfp-note dfp-warn',
                'The loaded predictions carry no per-point confidence, so its distribution cannot be shown.'));
            return;
        }
        const ctl = el('label', 'dfp-mps-ctl');
        ctl.appendChild(document.createTextNode('Share below '));
        const input = el('input', 'settings-num-input dfp-mps-input');
        input.type = 'number'; input.min = '0'; input.max = '1'; input.step = '0.05';
        input.value = String(previewMps);
        input.setAttribute('aria-label', 'Preview mean point confidence threshold');
        input.addEventListener('input', function () {
            const x = parseFloat(input.value);
            if (isFinite(x)) { previewMps = Math.max(0, Math.min(1, x)); renderMpsTable(); }
        });
        ctl.appendChild(input);
        sec.appendChild(ctl);
        sec.appendChild(el('div', 'dfp-note',
            'LUCID does not filter on this. A detection\'s mean point confidence is the average of its keypoints\' scores, a missing keypoint counting as 0 (as sleap-nn 0.3 computes it; 0.2 averaged the found keypoints only); ' +
            'sleap-nn can drop detections below a minimum of it before LUCID ever sees them, which hits a camera whose values sit low hardest.'));
        const holder = el('div');
        sec.appendChild(holder);

        function renderMpsTable() {
            holder.textContent = '';
            const counts = countDetectionFilters(stats, { minMeanPointScore: previewMps }, included);
            const mpsFlags = flagOutlierCameras(counts.perCamera, 'failMeanPointScore', 'withPointScores');
            const mpsFlagged = new Set(mpsFlags.map(function (f) { return f.name; }));
            const table = el('table', 'dfp-table dfp-mps-table');
            const head = el('tr');
            ['Camera', 'Median', 'Distribution (0 → 1)', 'Below ' + previewMps].forEach(function (h) { head.appendChild(el('th', null, h)); });
            table.appendChild(el('thead')).appendChild(head);
            const tb = el('tbody');
            table.appendChild(tb);
            hists.forEach(function (h, i) {
                const r = counts.perCamera[i];
                const isFlagged = mpsFlagged.has(h.name);
                const tr = el('tr', r.included ? (isFlagged ? 'dfp-flagged' : '') : 'dfp-excluded');
                tr.setAttribute('data-camera', h.name);
                const nameTd = el('td', 'dfp-cam', h.name);
                if (isFlagged) nameTd.appendChild(el('span', 'dfp-tag dfp-tag-warn', 'far more below'));
                tr.appendChild(nameTd);
                if (!h.count) {
                    tr.appendChild(el('td', 'dfp-num', '—'));
                    const td = el('td', null, 'no point scores');
                    td.colSpan = 2;
                    tr.appendChild(td);
                    tb.appendChild(tr);
                    return;
                }
                tr.appendChild(el('td', 'dfp-num', h.median.toFixed(2)));
                const histTd = el('td');
                const hist = el('div', 'dfp-hist');
                let max = 0;
                for (let b = 0; b < h.bins.length; b++) if (h.bins[b] > max) max = h.bins[b];
                for (let b = 0; b < h.bins.length; b++) {
                    const bar = el('span', 'dfp-bar' + ((b + 1) / h.bins.length <= previewMps + 1e-9 ? ' dfp-bar-below' : ''));
                    bar.style.height = (max ? Math.max(h.bins[b] ? 8 : 0, 100 * h.bins[b] / max) : 0) + '%';
                    bar.title = (b / h.bins.length).toFixed(1) + '–' + ((b + 1) / h.bins.length).toFixed(1) + ': ' + fmtCount(h.bins[b]);
                    hist.appendChild(bar);
                }
                histTd.appendChild(hist);
                tr.appendChild(histTd);
                tr.appendChild(shareCell(r.failMeanPointScore, r.withPointScores));
                tb.appendChild(tr);
            });
            holder.appendChild(table);
            const note = outlierNote(mpsFlags, 'has', ' below ' + previewMps, null);
            if (note) holder.appendChild(note);
        }
        renderMpsTable();
    }

    function update() {
        if (disposed || !stats) return;
        body.textContent = '';
        if (stats.n === 0) {
            message('This session has no detections, so the filters have nothing to remove.');
            return;
        }
        const v = opts.getValues();
        renderFilters(countDetectionFilters(stats, {
            minVisibleNodes: v.minVisibleNodes, minInstanceScore: v.minInstanceScore,
        }, included));
        renderPointScores();
    }

    // The walk starts when the wizard is first SHOWN (`start`), not when the
    // modal is built: Settings opened for a keyboard shortcut should not walk
    // a large lazy project's whole store in the background.
    let ready = null;
    message(session ? 'Counting detections…' : 'Load a session to see how many detections these filters remove.');
    function start() {
        if (ready) return ready;
        if (!session) return (ready = Promise.resolve());
        ready = collectDetectionStatsAsync(session, { isCancelled: function () { return disposed; } })
            .then(function (s) {
                if (!s || disposed) return;
                stats = s;
                hists = meanPointScoreHistograms(s, HIST_BINS);
                update();
            })
            .catch(function (e) {
                console.warn('[detection-filter-preview] could not count detections', e);
                if (!disposed) message('Could not count the loaded detections.', 'dfp-warn');
            });
        return ready;
    }

    return {
        root: root,
        update: update,
        start: start,
        dispose: function () { disposed = true; },
    };
}
