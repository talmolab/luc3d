/**
 * ui/memory-panel.js — the Memory panel (`#tabMemory`, right-edge rail): the
 * page's JavaScript heap over the last five minutes, the heap limit as a
 * reference line, and what the project holds.
 *
 * It samples once a second ONLY while its body is on screen
 * (`isPanelOnScreen`, ui/panel-rail.js): folded, closed, the info panel
 * hidden or Define Planes open, the timer is cleared and nothing runs. A
 * sample reads `performance.memory` (Chrome/Edge) and a few Map sizes
 * (`projectCounts`), then redraws one small SVG — never a walk over frames, so
 * it cannot freeze playback, Track All or Triangulate All.
 *
 * Where the page is cross-origin isolated it also asks
 * `performance.measureUserAgentSpecificMemory()` (the whole page, workers
 * included) every 10 s, one call at a time. LUCID sends no COOP/COEP headers,
 * so on the deployed site this stays off.
 *
 * Chrome without `--enable-precise-memory-info` rounds the heap to one of 100
 * sizes and refreshes it every 20 minutes; the panel says so (`isBucketizedHeap`).
 *
 * The samples live in a ring in memory (`MemoryRing`): nothing goes to the
 * `.slp` or `localStorage`. Test hook: `window.__lucidMemoryPanel`.
 */
import { onPanelRailChange, isPanelOnScreen } from './panel-rail.js';
import { setInfoTip, ICON_INFO } from './info-tip.js';
import { state } from './app-state.js';
import {
    MEMORY_SAMPLE_MS, MEMORY_WINDOW_MS, UA_MEMORY_EVERY_MS,
    MemoryRing, readHeap, summarizeUaMemory, projectCounts, formatMB, plotGeometry,
} from './memory-plot.js';

const TAB = 'tabMemory';
const PLOT_W = 260;
const PLOT_H = 90;
const SVG_NS = 'http://www.w3.org/2000/svg';

export const MEMORY_INFO_TEXT =
    'Chrome\'s JavaScript heap for this page; it also counts many typed arrays, which live outside the ~4 GB heap cap, so it can read above the limit. ' +
    'It leaves out web workers (Track All, the Triangulate pool, the image check), video decoding, and Chrome\'s GPU and other processes: Chrome\'s Task Manager (Shift+Esc) shows those.';

const ring = new MemoryRing();
let _timer = null;
let _uaBusy = false;
let _uaLastAt = -Infinity;
let _ua = null; // { bytes, workers, t }
let _els = null;
let _samplesTaken = 0;

function uaMemoryAvailable() {
    return typeof self !== 'undefined' && self.crossOriginIsolated === true &&
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
    }).catch(function () { /* refused (e.g. not isolated after all): keep the heap view */ })
        .then(function () { _uaBusy = false; });
}

function sample() {
    const now = performance.now();
    const heap = readHeap(performance);
    maybeMeasureUa(now);
    // A whole-page reading older than 30 s is not drawn as current.
    const ua = _ua && now - _ua.t < 30000 ? _ua.bytes : NaN;
    ring.push({
        t: now,
        used: heap ? heap.used : NaN,
        total: heap ? heap.total : NaN,
        limit: heap ? heap.limit : NaN,
        ua: ua,
    });
    _samplesTaken++;
    render(heap, now);
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
    }
    const uaShown = uaMemoryAvailable();
    e.uaRow.hidden = !uaShown;
    e.uaWorkersRow.hidden = !uaShown;
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

function start() {
    if (_timer) return;
    sample();
    _timer = setInterval(sample, MEMORY_SAMPLE_MS);
}

function stop() {
    if (!_timer) return;
    clearInterval(_timer);
    _timer = null;
}

/** Start or stop sampling to match whether the panel's body is on screen. */
export function syncMemorySampling() {
    if (isPanelOnScreen(TAB)) start();
    else stop();
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
    svg.appendChild(svgEl('line', { class: 'memory-plot-base', x1: 0, y1: PLOT_H, x2: PLOT_W, y2: PLOT_H }));
    const limitLine = svgEl('line', { class: 'memory-plot-limit', id: 'memoryLimitLine', x1: 0, x2: PLOT_W, y1: 0, y2: 0, visibility: 'hidden' });
    const uaPath = svgEl('path', { class: 'memory-plot-ua', id: 'memoryUaPath', d: '' });
    const usedPath = svgEl('path', { class: 'memory-plot-used', id: 'memoryUsedPath', d: '' });
    svg.appendChild(limitLine);
    svg.appendChild(uaPath);
    svg.appendChild(usedPath);
    body.appendChild(svg);

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
        '<span class="memory-key memory-key-limit"></span>heap limit';
    body.appendChild(legend);

    const coarse = document.createElement('div');
    coarse.className = 'memory-note';
    coarse.id = 'memoryCoarse';
    coarse.appendChild(document.createTextNode(
        'Chrome rounds this number and refreshes it only every 20 minutes. Start Chrome with '));
    const flag = document.createElement('code');
    flag.textContent = '--enable-precise-memory-info';
    coarse.appendChild(flag);
    coarse.appendChild(document.createTextNode(' for a live reading.'));
    coarse.hidden = true;
    body.appendChild(coarse);

    const peak = row(body, 'Peak (5 min)', 'memoryPeak');
    const total = row(body, 'Allocated', 'memoryTotal');
    const limit = row(body, 'Heap limit', 'memoryLimit');
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
        usedPath: usedPath, uaPath: uaPath, limitLine: limitLine, scale: scale,
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
    onPanelRailChange(syncMemorySampling);
    syncMemorySampling();
    if (typeof window !== 'undefined') {
        window.__lucidMemoryPanel = {
            isSampling: function () { return !!_timer; },
            samplesTaken: function () { return _samplesTaken; },
            samples: function () { return ring.toArray(); },
        };
    }
}
