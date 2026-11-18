/**
 * ui/memory-panel.js — the Memory panel (`#tabMemory`, right-edge rail): the
 * page's JavaScript heap over the last five minutes, V8's limit for
 * JavaScript objects as a reference line, and what the project holds.
 *
 * The line is named "JS object limit", not "heap limit": `jsHeapSizeLimit`
 * caps JavaScript objects only, while `usedJSHeapSize` also counts typed-array
 * memory, which sits outside that cap. A big project reads well above the line
 * and is fine (05mice after Track All: 5.6 GB used, objects under 1.9 GB).
 *
 * It reads the heap once a second from the moment the app starts, panel open
 * or not, so opening it shows the last five minutes, a run done with it
 * closed included. A reading is `performance.memory` (Chrome/Edge) into the
 * ring: ~6 µs, the same on the demo and on a 5.7 GB 8-camera project.
 * Everything else happens ONLY while its body is on screen (`isPanelOnScreen`,
 * ui/panel-rail.js; folded, closed, the info panel hidden or Define Planes
 * open, it is not): the redraw of one small SVG and the project counts (a few
 * Map sizes, `projectCounts`) — never a walk over frames, so it cannot freeze
 * playback, Track All or Triangulate All.
 *
 * Where the page is cross-origin isolated it also asks
 * `performance.measureUserAgentSpecificMemory()` (the whole page, workers
 * included) every 10 s while on screen, one call at a time; a refused call
 * hides its rows for good. Never while closed: Chrome forces a full garbage
 * collection to answer when none comes within ~20 s (~140 ms on a big
 * project). The deployed site sends no COOP/COEP headers, so this stays off
 * there; `python3 server.py --isolated` sends them.
 *
 * Chrome 157 reports the heap live on an ordinary page. Older Chrome
 * (Playwright's Chromium 153) without `--enable-precise-memory-info` rounds it
 * to one of 100 sizes and refreshes it every 20 minutes; the panel says so
 * (`isBucketizedHeap`).
 *
 * Each reading also notes what was running: the progress card's title (or
 * its message), `loadingCardText` in ui/loading-overlay.js, the one place
 * every long job (Track All, Triangulate All, loads, saves) reports. A run is
 * a shaded band on the plot with its name along the top (`runSpans`,
 * `placeRunLabels`), and the band's tooltip gives its length and peak.
 *
 * The samples live in a ring in memory (`MemoryRing`): nothing goes to the
 * `.slp` or `localStorage`. Test hook: `window.__lucidMemoryPanel`.
 */
import { onPanelRailChange, isPanelOnScreen } from './panel-rail.js?v=35646fe2a8aa';
import { setInfoTip, ICON_INFO } from './info-tip.js?v=35646fe2a8aa';
import { state } from './app-state.js?v=35646fe2a8aa';
import { loadingCardText } from './loading-overlay.js?v=35646fe2a8aa';
import {
    MEMORY_SAMPLE_MS, MEMORY_WINDOW_MS, UA_MEMORY_EVERY_MS,
    MemoryRing, readHeap, summarizeUaMemory, projectCounts, formatMB, plotGeometry,
    runName, runSpans, placeRunLabels, formatDuration,
} from './memory-plot.js?v=35646fe2a8aa';

const TAB = 'tabMemory';
const PLOT_W = 260;
const PLOT_H = 90;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Rows of run names along the top of the plot. */
const RUN_LABEL_LANES = 2;

export const MEMORY_INFO_TEXT =
    'Chrome\'s count of this page\'s memory: JavaScript objects plus typed arrays (most of a big project\'s keypoints), but the dashed limit caps the objects only, so the line can go well above it without trouble. ' +
    'It leaves out web workers (Track All, the Triangulate pool, the image check), video decoding, and Chrome\'s GPU and other processes: Chrome\'s Task Manager (Shift+Esc) shows those.';

const ring = new MemoryRing();
let _timer = null;
/** The panel's body is on screen: draw, and ask for the whole page. */
let _onScreen = false;
let _uaBusy = false;
let _uaLastAt = -Infinity;
let _ua = null; // { bytes, workers, t }
/** The browser refused the call (Playwright's Chromium does, isolated or not): stop asking, hide its rows. */
let _uaRefused = false;
let _els = null;
let _samplesTaken = 0;

function uaMemoryAvailable() {
    return !_uaRefused && typeof self !== 'undefined' && self.crossOriginIsolated === true &&
        typeof performance.measureUserAgentSpecificMemory === 'function';
}

/** Ask for the whole page's memory at most every 10 s, one call in flight. */
function maybeMeasureUa(now) {
    if (_uaBusy || !uaMemoryAvailable() || now - _uaLastAt < UA_MEMORY_EVERY_MS) return;
    _uaBusy = true;
    _uaLastAt = now;
    performance.measureUserAgentSpecificMemory().then(function (r) {
        const s = summarizeUaMemory(r);
        if (s) _ua = { bytes: s.bytes, workers: s.workers, t: performance.now() };
    }).catch(function () {
        // A refusal (SecurityError) will not change on this page: keep the heap view only.
        _uaRefused = true;
        _ua = null;
    }).then(function () { _uaBusy = false; });
}

function sample() {
    const now = performance.now();
    const heap = readHeap(performance);
    if (_onScreen) maybeMeasureUa(now);
    // A whole-page reading older than 30 s is not drawn as current.
    const ua = _ua && now - _ua.t < 30000 ? _ua.bytes : NaN;
    ring.push({
        t: now,
        used: heap ? heap.used : NaN,
        total: heap ? heap.total : NaN,
        limit: heap ? heap.limit : NaN,
        ua: ua,
        run: runName(loadingCardText()),
    });
    _samplesTaken++;
    if (_onScreen) render(heap, now);
}

function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
}

function render(heap, now) {
    if (!_els) return;
    const e = _els;
    e.unavailable.hidden = !!heap;
    e.heapBody.hidden = !heap;
    if (heap) {
        setText(e.now, formatMB(heap.used));
        setText(e.total, formatMB(heap.total));
        setText(e.limit, formatMB(heap.limit));
        e.coarse.hidden = !heap.bucketized;
        const g = plotGeometry(ring.toArray(), { width: PLOT_W, height: PLOT_H, now: now, windowMs: MEMORY_WINDOW_MS, limit: heap.limit });
        setText(e.peak, formatMB(g.peak));
        e.usedPath.setAttribute('d', g.usedPath);
        e.uaPath.setAttribute('d', g.uaPath);
        if (g.limitY != null) {
            e.limitLine.setAttribute('y1', g.limitY.toFixed(1));
            e.limitLine.setAttribute('y2', g.limitY.toFixed(1));
            e.limitLine.removeAttribute('visibility');
        } else {
            e.limitLine.setAttribute('visibility', 'hidden');
        }
        setText(e.scale, formatMB(g.yMax));
        renderRuns(e, now);
    }
    const uaShown = uaMemoryAvailable();
    e.uaRow.hidden = !uaShown;
    e.uaWorkersRow.hidden = !uaShown;
    e.legendUa.hidden = !uaShown;
    if (uaShown) {
        setText(e.ua, _ua ? formatMB(_ua.bytes) : 'measuring…');
        setText(e.uaWorkers, _ua ? formatMB(_ua.workers) : '–');
    }

    const c = projectCounts(state.sessions && state.sessions.length ? state.sessions : (state.session ? [state.session] : []));
    setText(e.resident, c.sessions
        ? c.resident.toLocaleString('en-US') + ' of ' + c.frames.toLocaleString('en-US') + (c.lazy ? ' (lazy)' : '')
        : '–');
    setText(e.groups, c.sessions ? c.groupFrames.toLocaleString('en-US') : '–');
    setText(e.sessions, c.sessions.toLocaleString('en-US'));
}

/** The runs' bands (SVG) and names (HTML over the plot, so the stretched SVG never distorts text). */
function renderRuns(e, now) {
    const spans = runSpans(ring.toArray(), { width: PLOT_W, now: now, windowMs: MEMORY_WINDOW_MS });
    const places = placeRunLabels(spans, PLOT_W, 6, RUN_LABEL_LANES);
    const key = spans.map(function (s) { return s.name + '@' + s.x0.toFixed(1) + '-' + s.x1.toFixed(1) + ':' + Math.round(s.peak / 1048576); }).join('|');
    if (key === e.runsKey) return;
    e.runsKey = key;
    e.runBands.textContent = '';
    e.runLabels.textContent = '';
    const pct = function (v) { return (v / PLOT_W * 100).toFixed(2) + '%'; };
    spans.forEach(function (s, i) {
        const tip = s.name + ' · ' + formatDuration(s.ms) + ' · peak ' + formatMB(s.peak);
        // Alternate shades, so two runs back to back read as two.
        const r = svgEl('rect', { class: 'memory-plot-run' + (i % 2 ? ' memory-plot-run-alt' : ''), x: s.x0.toFixed(1), y: 0, width: (s.x1 - s.x0).toFixed(1), height: PLOT_H });
        const t = svgEl('title', {});
        t.textContent = tip;
        r.appendChild(t);
        e.runBands.appendChild(r);
        const p = places[i];
        if (p.hidden) return;
        const l = document.createElement('span');
        l.className = 'memory-run-label';
        l.textContent = s.name;
        l.title = tip;
        if (p.align === 'left') l.style.left = pct(p.x);
        else l.style.right = pct(PLOT_W - p.x);
        l.style.maxWidth = pct(p.max);
        l.style.top = (2 + p.lane * 13) + 'px';
        e.runLabels.appendChild(l);
    });
}

/** Draw (and ask for the whole page) only while the panel's body is on screen; it draws at once on opening. */
export function syncMemorySampling() {
    const was = _onScreen;
    _onScreen = isPanelOnScreen(TAB);
    if (_onScreen && !was) render(readHeap(performance), performance.now());
}

function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
}

function row(parent, label, id) {
    const r = document.createElement('div');
    r.className = 'session-info-row';
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'value';
    v.id = id;
    v.textContent = '–';
    r.appendChild(l);
    r.appendChild(v);
    parent.appendChild(r);
    return { row: r, value: v };
}

/** Build the panel's body into `#tabMemory` (empty in index.html). */
function build(pane) {
    pane.textContent = '';
    const heapSec = document.createElement('div');
    heapSec.className = 'info-section';
    const h = document.createElement('h3');
    h.className = 'memory-heading';
    h.appendChild(document.createTextNode('JavaScript heap'));
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'info-tip-btn';
    info.id = 'memoryInfo';
    info.innerHTML = ICON_INFO;
    setInfoTip(info, MEMORY_INFO_TEXT);
    h.appendChild(info);
    heapSec.appendChild(h);

    const unavailable = document.createElement('div');
    unavailable.className = 'memory-note';
    unavailable.id = 'memoryUnavailable';
    unavailable.textContent = 'Not available in this browser: only Chrome and Edge report the page\'s memory.';
    unavailable.hidden = true;
    heapSec.appendChild(unavailable);

    const body = document.createElement('div');
    body.id = 'memoryHeapBody';
    const readout = document.createElement('div');
    readout.className = 'memory-readout';
    const now = document.createElement('span');
    now.className = 'memory-now';
    now.id = 'memoryNow';
    now.textContent = '–';
    const nowLabel = document.createElement('span');
    nowLabel.className = 'memory-now-label';
    nowLabel.textContent = 'used';
    readout.appendChild(now);
    readout.appendChild(nowLabel);
    body.appendChild(readout);

    const svg = svgEl('svg', {
        id: 'memoryPlot', class: 'memory-plot', viewBox: '0 0 ' + PLOT_W + ' ' + PLOT_H,
        preserveAspectRatio: 'none', role: 'img', 'aria-label': 'JavaScript heap used over the last five minutes',
    });
    const runBands = svgEl('g', { id: 'memoryRunBands' });
    svg.appendChild(runBands);
    svg.appendChild(svgEl('line', { class: 'memory-plot-base', x1: 0, y1: PLOT_H, x2: PLOT_W, y2: PLOT_H }));
    const limitLine = svgEl('line', { class: 'memory-plot-limit', id: 'memoryLimitLine', x1: 0, x2: PLOT_W, y1: 0, y2: 0, visibility: 'hidden' });
    const uaPath = svgEl('path', { class: 'memory-plot-ua', id: 'memoryUaPath', d: '' });
    const usedPath = svgEl('path', { class: 'memory-plot-used', id: 'memoryUsedPath', d: '' });
    svg.appendChild(limitLine);
    svg.appendChild(uaPath);
    svg.appendChild(usedPath);
    // The plot and the runs' names over it (HTML: the SVG is stretched to the panel's width).
    const plotWrap = document.createElement('div');
    plotWrap.className = 'memory-plot-wrap';
    plotWrap.appendChild(svg);
    const runLabels = document.createElement('div');
    runLabels.className = 'memory-run-labels';
    runLabels.id = 'memoryRunLabels';
    plotWrap.appendChild(runLabels);
    body.appendChild(plotWrap);

    const axis = document.createElement('div');
    axis.className = 'memory-axis';
    const a0 = document.createElement('span'); a0.textContent = '−5 min';
    const aMid = document.createElement('span');
    aMid.appendChild(document.createTextNode('top '));
    const scale = document.createElement('span'); scale.id = 'memoryScale'; scale.textContent = '–';
    aMid.appendChild(scale);
    const a1 = document.createElement('span'); a1.textContent = 'now';
    axis.appendChild(a0); axis.appendChild(aMid); axis.appendChild(a1);
    body.appendChild(axis);

    const legend = document.createElement('div');
    legend.className = 'memory-legend';
    legend.innerHTML = '<span class="memory-key memory-key-used"></span>used' +
        '<span class="memory-key memory-key-limit"></span>JS object limit' +
        '<span class="memory-legend-ua" id="memoryLegendUa" hidden>' +
        '<span class="memory-key memory-key-ua"></span>whole page, workers too</span>';
    body.appendChild(legend);
    const legendUa = legend.querySelector('#memoryLegendUa');

    const coarse = document.createElement('div');
    coarse.className = 'memory-note';
    coarse.id = 'memoryCoarse';
    coarse.appendChild(document.createTextNode(
        'This browser rounds this number and refreshes it only every 20 minutes. Update Chrome ' +
        '(157 reports it live), or start it with '));
    const flag = document.createElement('code');
    flag.textContent = '--enable-precise-memory-info';
    coarse.appendChild(flag);
    coarse.appendChild(document.createTextNode('.'));
    coarse.hidden = true;
    body.appendChild(coarse);

    const peak = row(body, 'Peak (5 min)', 'memoryPeak');
    const total = row(body, 'Allocated', 'memoryTotal');
    const limit = row(body, 'JS object limit', 'memoryLimit');
    const ua = row(body, 'Whole page, workers too', 'memoryUa');
    const uaWorkers = row(body, 'of which workers', 'memoryUaWorkers');
    ua.row.hidden = true;
    uaWorkers.row.hidden = true;
    heapSec.appendChild(body);
    pane.appendChild(heapSec);

    const projSec = document.createElement('div');
    projSec.className = 'info-section';
    const h2 = document.createElement('h3');
    h2.textContent = 'Project';
    projSec.appendChild(h2);
    const resident = row(projSec, 'Frames in memory', 'memoryResident');
    const groups = row(projSec, 'Frames with groups', 'memoryGroups');
    const sessions = row(projSec, 'Sessions', 'memorySessions');
    pane.appendChild(projSec);

    return {
        unavailable: unavailable, heapBody: body, now: now, coarse: coarse,
        usedPath: usedPath, uaPath: uaPath, limitLine: limitLine, scale: scale, legendUa: legendUa,
        runBands: runBands, runLabels: runLabels, runsKey: null,
        peak: peak.value, total: total.value, limit: limit.value,
        ua: ua.value, uaRow: ua.row, uaWorkers: uaWorkers.value, uaWorkersRow: uaWorkers.row,
        resident: resident.value, groups: groups.value, sessions: sessions.value,
    };
}

/** Build the panel and follow the rail. Call once, after `setupPanelRail`. */
export function setupMemoryPanel() {
    const pane = document.getElementById(TAB);
    if (!pane) return;
    _els = build(pane);
    if (!_timer) {
        sample();
        _timer = setInterval(sample, MEMORY_SAMPLE_MS);
    }
    onPanelRailChange(syncMemorySampling);
    syncMemorySampling();
    if (typeof window !== 'undefined') {
        window.__lucidMemoryPanel = {
            isSampling: function () { return !!_timer; },
            isDrawing: function () { return _onScreen; },
            samplesTaken: function () { return _samplesTaken; },
            samples: function () { return ring.toArray(); },
        };
    }
}
