// ui/detection-filter-preview.js — the Tracking Wizard's "what these filters
// would remove" readout.
//
// Sits under the three detection-filter fields (min visible nodes, min
// instance score, min mean node score) and says, per camera and over the
// tracked cameras, what share of the loaded detections each filter removes at
// the value being typed, how many the three remove together and how many fail
// more than one. A low camera's detections can score far below the others', so
// a value that is harmless for most cameras can empty one of them — the
// per-camera rows are the point, and a camera losing far more than the rest is
// flagged, per filter and overall (`flagOutlierCameras`).
//
// Below that, per camera, how each of the three quantities is spread, with the
// bars each filter removes in orange — so a cut can be seen against the data
// it cuts.
//
// The session is walked ONCE, one camera per task after the modal is up
// (`collectDetectionStatsAsync`), so opening the wizard costs nothing; every
// edit afterwards is a pass over typed arrays (`countDetectionFilters`).

import {
    collectDetectionStatsAsync,
    countDetectionFilters,
    detectionHistograms,
    flagOutlierCameras,
} from '../pose/detection-filter-stats.js?v=a8a08ce625b2';

const HIST_BINS = 10;

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
 *   getValues: () => {minVisibleNodes: number, minInstanceScore: number, minMeanNodeScore: number},
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

    const root = el('div', 'dfp');
    root.setAttribute('data-testid', 'detection-filter-preview');
    root.appendChild(el('div', 'dfp-title', 'What these filters would remove'));
    const body = el('div', 'dfp-body');
    root.appendChild(body);

    function message(text, cls) {
        body.textContent = '';
        body.appendChild(el('div', 'dfp-note' + (cls ? ' ' + cls : ''), text));
    }

    function values() {
        const v = opts.getValues() || {};
        return {
            minVisibleNodes: Number(v.minVisibleNodes) || 0,
            minInstanceScore: Number(v.minInstanceScore) || 0,
            minMeanNodeScore: Number(v.minMeanNodeScore) || 0,
        };
    }

    // The three filters, in the order of their fields: the count column, how
    // a camera's missing data is tagged in it, and its histogram.
    const FILTERS = [
        { key: 'failVisible', head: 'Too few nodes', hist: 'visible' },
        { key: 'failScore', head: 'Low instance score', hist: 'score',
          missing: function (r) { return r.predicted > 0 && r.predictedWithScore === 0; },
          tag: 'no scores',
          tip: 'This camera\'s predictions carry no instance scores (all 0), so any minimum above 0 removes every one of them.' },
        { key: 'failNodeScore', head: 'Low mean node score', hist: 'nodeScore',
          missing: function (r) { return r.predicted > 0 && r.withNodeScores === 0; },
          tag: 'no node scores',
          tip: 'This camera\'s predictions carry no node scores, so the mean node score filter removes none of them.' },
    ];

    function renderFilters(counts, v) {
        const t = counts.total;
        const nCams = counts.perCamera.filter(function (r) { return r.included; }).length;
        body.appendChild(el('div', 'dfp-note',
            'Out of ' + fmtCount(t.detections) + ' detections in ' + nCams + ' tracked camera' + (nCams === 1 ? '' : 's') +
            ' of this session. Updates as you type; nothing is removed until you track.'));

        const table = el('table', 'dfp-table dfp-filters');
        const head = el('tr');
        ['Camera', 'Detections'].concat(FILTERS.map(function (f) { return f.head; }), ['Removed', 'Fail 2+'])
            .forEach(function (h) { head.appendChild(el('th', null, h)); });
        head.lastChild.title = 'Detections failing more than one filter.';
        table.appendChild(el('thead')).appendChild(head);
        const tb = el('tbody');
        table.appendChild(tb);

        // A camera losing far more than the rest — to each filter, and overall.
        const flagSets = {};
        FILTERS.concat([{ key: 'removed' }]).forEach(function (f) {
            flagSets[f.key] = new Set(flagOutlierCameras(counts.perCamera, f.key).map(function (x) { return x.name; }));
        });

        function row(r, isTotal) {
            const isFlagged = !isTotal && flagSets.removed.has(r.name);
            const tr = el('tr', isTotal ? 'dfp-total' : (r.included ? (isFlagged ? 'dfp-flagged' : '') : 'dfp-excluded'));
            tr.setAttribute('data-camera', isTotal ? '' : r.name);
            const name = el('td', 'dfp-cam', isTotal ? 'All tracked cameras' : r.name);
            if (!isTotal && !r.included) name.appendChild(el('span', 'dfp-tag', 'excluded'));
            if (isFlagged) name.appendChild(el('span', 'dfp-tag dfp-tag-warn', 'loses far more'));
            tr.appendChild(name);
            tr.appendChild(el('td', 'dfp-num', fmtCount(r.detections)));
            FILTERS.forEach(function (f) {
                const td = shareCell(r[f.key], r.detections);
                td.setAttribute('data-filter', f.key);
                if (!isTotal && flagSets[f.key].has(r.name)) td.classList.add('dfp-cell-flag');
                if (!isTotal && f.missing && f.missing(r)) {
                    const tag = el('span', 'dfp-tag dfp-tag-warn', f.tag);
                    tag.title = f.tip;
                    td.appendChild(tag);
                }
                tr.appendChild(td);
            });
            const rm = shareCell(r.removed, r.detections);
            rm.classList.add('dfp-removed');
            tr.appendChild(rm);
            tr.appendChild(shareCell(r.failsMultiple, r.detections));
            tb.appendChild(tr);
        }
        counts.perCamera.forEach(function (r) { row(r, false); });
        if (counts.perCamera.length > 1) row(t, true);
        body.appendChild(table);

        const flags = flagOutlierCameras(counts.perCamera, 'removed');
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
        if (stats.totals.predicted > 0 && !stats.hasNodeScores) {
            body.appendChild(el('div', 'dfp-note dfp-warn',
                'The loaded predictions carry no node scores, so the mean node score filter cannot remove any of them.'));
        }
    }

    // One small bar chart; `below(b)` says whether bin b is removed.
    function histogram(bins, below, label) {
        const hist = el('div', 'dfp-hist');
        let max = 0;
        for (let b = 0; b < bins.length; b++) if (bins[b] > max) max = bins[b];
        for (let b = 0; b < bins.length; b++) {
            const bar = el('span', 'dfp-bar' + (below(b) ? ' dfp-bar-below' : ''));
            bar.style.height = (max ? Math.max(bins[b] ? 8 : 0, 100 * bins[b] / max) : 0) + '%';
            bar.title = label(b) + ': ' + fmtCount(bins[b]);
            hist.appendChild(bar);
        }
        return hist;
    }

    function renderDistributions(v, counts) {
        const sec = el('div', 'dfp-dist');
        sec.appendChild(el('div', 'dfp-subtitle', 'How the detections are spread'));
        sec.appendChild(el('div', 'dfp-note',
            'Orange bars fall below the minimum you set, so tracking would drop those detections. ' +
            'Mean node score is the average of a detection\'s node scores over every node of the skeleton, ' +
            'a missing node counting as 0 (sleap-nn\'s "mean node score", as 0.3 computes it; 0.2 averaged the found nodes only).'));
        const table = el('table', 'dfp-table dfp-dist-table');
        const head = el('tr');
        ['Camera', 'Visible nodes (0 → ' + hists.maxNodes + ')', 'Instance score (0 → 1)', 'Mean node score (0 → 1)']
            .forEach(function (h) { head.appendChild(el('th', null, h)); });
        table.appendChild(el('thead')).appendChild(head);
        const tb = el('tbody');
        table.appendChild(tb);
        const nb = HIST_BINS;
        const unitBelow = function (min) { return function (b) { return min > 0 && (b + 1) / nb <= min + 1e-9; }; };
        const unitLabel = function (b) { return (b / nb).toFixed(1) + '–' + ((b + 1) / nb).toFixed(1); };
        hists.cameras.forEach(function (h, i) {
            const r = counts.perCamera[i];
            const tr = el('tr', r.included ? '' : 'dfp-excluded');
            tr.setAttribute('data-camera', h.name);
            tr.appendChild(el('td', 'dfp-cam', h.name));
            const cells = [
                { d: h.visible, below: function (b) { return b < v.minVisibleNodes; }, label: function (b) { return b + ' nodes'; },
                  med: function (m) { return String(Math.round(m * 10) / 10); }, none: 'no detections', key: 'visible' },
                { d: h.score, below: unitBelow(v.minInstanceScore), label: unitLabel,
                  med: function (m) { return m.toFixed(2); }, none: 'no scores', key: 'score' },
                { d: h.nodeScore, below: unitBelow(v.minMeanNodeScore), label: unitLabel,
                  med: function (m) { return m.toFixed(2); }, none: 'no node scores', key: 'nodeScore' },
            ];
            cells.forEach(function (c) {
                const td = el('td', 'dfp-dist-cell');
                td.setAttribute('data-hist', c.key);
                if (!c.d.count) { td.textContent = c.none; tr.appendChild(td); return; }
                td.appendChild(histogram(c.d.bins, c.below, c.label));
                const med = el('span', 'dfp-median', c.med(c.d.median));
                med.title = 'Median';
                td.appendChild(med);
                tr.appendChild(td);
            });
            tb.appendChild(tr);
        });
        sec.appendChild(table);
        body.appendChild(sec);
    }

    function update() {
        if (disposed || !stats) return;
        body.textContent = '';
        if (stats.n === 0) {
            message('This session has no detections, so the filters have nothing to remove.');
            return;
        }
        const v = values();
        const counts = countDetectionFilters(stats, v, included);   // the one pass over every detection
        renderFilters(counts, v);
        renderDistributions(v, counts);
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
                hists = detectionHistograms(s, HIST_BINS);
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
