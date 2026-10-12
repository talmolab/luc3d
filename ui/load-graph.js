/**
 * ui/load-graph.js — how busy a long operation keeps the CPU (and the GPU), for
 * its progress UI: a busy clock its threads report to, the rolling load meter,
 * the "CPU: 12 cores · load 7%" line, and a small graph of the last minute.
 *
 * Used by the image ID-switch check's progress dialog (ui/id-switch-modal.js:
 * CPU and GPU) and by the loading overlay (ui/loading-overlay.js `setLoadingCpu`:
 * the CPU alone — Triangulate All and Track All, which never touch the GPU).
 *
 * No browser API reports the CPU's or a GPU's utilisation, so every load here is
 * the operation's OWN busy time — the threads it can clock — as a share of the
 * hardware. Other apps are never in it, and each line's tooltip says so.
 *
 * No imports, and nothing touches the DOM at load time: ui/image-embedder.js
 * imports this, and that module is also loaded by the crop and model workers.
 */

/** How far back a load looks (ms). */
export const LOAD_WINDOW_MS = 5000;

/**
 * A rolling load. Fed `(now, busyMs)` — cumulative busy milliseconds of ONE
 * resource (for the CPU: thread-ms / cores) — it returns the percentage of the
 * last `windowMs` spent busy, or null until it has 0.5 s of history.
 */
export function createLoadMeter(windowMs) {
    const w = windowMs > 0 ? windowMs : LOAD_WINDOW_MS, hist = [];
    return function (now, busyMs) {
        hist.push({ t: now, busy: busyMs });
        while (hist.length > 2 && now - hist[1].t >= w) hist.shift();   // oldest sample still spanning the window
        const dt = now - hist[0].t;
        return dt >= 500 ? 100 * Math.min(1, Math.max(0, (busyMs - hist[0].busy) / dt)) : null;
    };
}

/**
 * Busy time summed over several threads, for a CPU load: `begin(lane)` when a
 * thread gets work and `end(lane)` when one piece of it is done — they nest per
 * lane, since a worker can hold several queued jobs — `close(lane)` for a thread
 * that is gone (all lanes with no argument), and `ms()` the total so far. Spans
 * still open count up to now, so a seconds-long run shows while it runs, not all
 * at once when it ends. A lane is any key (a worker's record, 'main'). `now` is
 * injectable for tests.
 */
export function createBusyClock(now) {
    const clock = now || function () { return performance.now(); }, open = new Map();
    let done = 0;
    const stop = function (lane, o) { done += clock() - o.since; open.delete(lane); };
    return {
        begin: function (lane) { const o = open.get(lane); if (o) o.depth++; else open.set(lane, { depth: 1, since: clock() }); },
        end: function (lane) { const o = open.get(lane); if (o && --o.depth <= 0) stop(lane, o); },
        close: function (lane) {
            if (arguments.length) { const o = open.get(lane); if (o) stop(lane, o); }
            else open.forEach(function (o, l) { stop(l, o); });
        },
        ms: function () { const t = clock(); let s = done; open.forEach(function (o) { s += t - o.since; }); return s; },
    };
}

/**
 * A CPU line: `{text, title, load}`. "CPU: 12 cores · load 7%" — `cores` is
 * `navigator.hardwareConcurrency` (logical processors), `load` (null: not
 * measured yet) the share of ALL of them kept busy over the last LOAD_WINDOW_MS,
 * so one saturated thread on 12 cores reads 8%. `counts` completes the tooltip's
 * "kept busy over the last 5 s by …": what the operation can clock.
 */
export function formatCpuLoad(cores, load, counts) {
    const n = cores > 0 ? Math.round(cores) : 0, shown = load == null ? null : load;
    return {
        text: 'CPU' + (n ? ': ' + n + ' core' + (n === 1 ? '' : 's') : '') + (shown == null ? '' : ' · load ' + Math.round(shown) + '%'),
        title: shown == null ? '' : 'The share of the CPU' + (n ? '\'s ' + n + ' cores' : '') + ' kept busy over the last ' +
            Math.round(LOAD_WINDOW_MS / 1000) + ' s by ' + counts + '. Browsers do not report the CPU\'s total load, so other apps are not included.',
        load: shown,
    };
}

/** The cores a CPU load is shared by (0: unknown). */
export function cpuCores() {
    return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0;
}

/** How far back the load graph reaches (ms). */
export const LOAD_GRAPH_SPAN_MS = 60000;

/**
 * One series of the load graph, as SVG path data: `samples` `[{t, v}]`
 * (performance.now() ms, percent; oldest first; `v` null = not measured, which
 * breaks the line) placed by TIME — `now` at the right edge, `now - spanMs` at
 * the left — and 0-100% from the bottom to the top of a `w` x `h` box. By time
 * rather than by index because the samples are not evenly spaced: they come from
 * a 1 s timer on a main thread that long work blocks for seconds at a time. A
 * lone point is a zero-length segment, which the round line cap draws as a dot.
 * Points left of the box are kept so the line enters from its edge; the SVG
 * clips them.
 */
export function loadGraphPath(samples, now, spanMs, w, h) {
    let d = '', run = 0, last = '';
    const flush = function () { if (run === 1) d += 'L' + last; run = 0; };
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (s.v == null || !isFinite(s.v)) { flush(); continue; }
        const x = w - w * (now - s.t) / spanMs, y = h - h * Math.min(100, Math.max(0, s.v)) / 100;
        last = x.toFixed(1) + ' ' + y.toFixed(1);
        d += (run ? 'L' : 'M') + last;
        run++;
    }
    flush();
    return d;
}

/** The graph, in CSS px: as tall as two 12 px lines of text. The series are plotted LOAD_GRAPH_PAD inside the
 *  top and bottom edges, so a load of 0% or 100% is not half clipped. */
export const LOAD_GRAPH_W = 104, LOAD_GRAPH_H = 34, LOAD_GRAPH_PAD = 2;

/**
 * The load graph, built into `box` (which gets class `load-graph`): the last
 * LOAD_GRAPH_SPAN_MS of samples, newest at the right edge, 0-100% bottom to
 * top, a hairline at 50%, a CPU and a GPU series (styles.css: `--load-cpu`,
 * `--load-gpu`). It keeps its space while hidden (`show(false)` is visibility),
 * so a dialog does not jump when it appears. Hovering shows a cursor, a dot per
 * series and a readout above the graph — "12 s ago · CPU 7% · GPU 80%" — for the
 * MEASURED sample nearest the pointer (the first tick's are not yet), kept
 * current as the graph moves under a still pointer.
 * @returns {{show: function(boolean), push: function(number, ?number, ?number), clear: function()}}
 */
export function createLoadGraph(box) {
    const W = LOAD_GRAPH_W, H = LOAD_GRAPH_H, plotH = H - 2 * LOAD_GRAPH_PAD;
    box.classList.add('load-graph');
    box.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
        'aria-label="Load over the last ' + Math.round(LOAD_GRAPH_SPAN_MS / 1000) + ' s">' +
        '<line class="load-graph-grid" x1="0" x2="' + W + '" y1="' + H / 2 + '" y2="' + H / 2 + '"></line>' +
        '<line class="load-graph-cursor" y1="0" y2="' + H + '"></line>' +
        '<g transform="translate(0 ' + LOAD_GRAPH_PAD + ')">' +
        '<path class="load-graph-line is-cpu"></path><path class="load-graph-line is-gpu"></path>' +
        '<circle class="load-graph-dot is-cpu" r="2.5"></circle><circle class="load-graph-dot is-gpu" r="2.5"></circle></g></svg>' +
        '<div class="load-graph-tip" hidden></div>';
    const svg = box.querySelector('svg'), tip = box.querySelector('.load-graph-tip'), cursor = svg.querySelector('.load-graph-cursor');
    const paths = { cpu: svg.querySelector('path.is-cpu'), gpu: svg.querySelector('path.is-gpu') };
    const dots = { cpu: svg.querySelector('circle.is-cpu'), gpu: svg.querySelector('circle.is-gpu') };
    let samples = [], now = 0, hoverX = null;
    const yOf = function (v) { return plotH - plotH * Math.min(100, Math.max(0, v)) / 100; };
    const drawHover = function () {
        let s = null;
        if (hoverX != null) {
            const t = now - LOAD_GRAPH_SPAN_MS * (1 - hoverX / W);
            samples.forEach(function (q) {
                if ((q.cpu != null || q.gpu != null) && (!s || Math.abs(q.t - t) < Math.abs(s.t - t))) s = q;
            });
        }
        const x = s ? (W - W * (now - s.t) / LOAD_GRAPH_SPAN_MS).toFixed(1) : '0';
        cursor.classList.toggle('is-on', !!s);
        cursor.setAttribute('x1', x); cursor.setAttribute('x2', x);
        ['cpu', 'gpu'].forEach(function (k) {
            const on = !!s && s[k] != null;
            dots[k].classList.toggle('is-on', on);
            if (on) { dots[k].setAttribute('cx', x); dots[k].setAttribute('cy', yOf(s[k]).toFixed(1)); }
        });
        tip.hidden = !s;
        if (!s) return;
        const ago = Math.round((now - s.t) / 1000), parts = [ago ? ago + ' s ago' : 'now'];
        if (s.cpu != null) parts.push('CPU ' + Math.round(s.cpu) + '%');
        if (s.gpu != null) parts.push('GPU ' + Math.round(s.gpu) + '%');
        tip.textContent = parts.join(' · ');
    };
    const draw = function () {
        ['cpu', 'gpu'].forEach(function (k) {
            paths[k].setAttribute('d', loadGraphPath(samples.map(function (q) { return { t: q.t, v: q[k] }; }),
                now, LOAD_GRAPH_SPAN_MS, W, plotH));
        });
        drawHover();
    };
    svg.addEventListener('pointermove', function (e) {
        const r = svg.getBoundingClientRect();
        hoverX = r.width ? Math.min(W, Math.max(0, (e.clientX - r.left) * W / r.width)) : null;
        drawHover();
    });
    svg.addEventListener('pointerleave', function () { hoverX = null; drawHover(); });
    return {
        show: function (on) { box.classList.toggle('is-on', !!on); },
        /** One sample at time `t`, in percent (null: not measured, or no such series). */
        push: function (t, cpu, gpu) {
            now = t;
            samples.push({ t: t, cpu: cpu == null ? null : cpu, gpu: gpu == null ? null : gpu });
            // keep one sample left of the edge, so the line still enters from it
            while (samples.length > 1 && samples[1].t < now - LOAD_GRAPH_SPAN_MS) samples.shift();
            draw();
        },
        /** Forget every sample (a new operation in a reused element). */
        clear: function () { samples = []; hoverX = null; draw(); },
    };
}

/**
 * Write a load line: its text and tooltip, and — when it has a series in the
 * graph (`series`) — the legend key in that series' colour (`.load-line.has-series`;
 * the element carries `.is-cpu` or `.is-gpu`).
 */
export function setLoadLine(el, text, title, series) {
    el.textContent = text;
    el.classList.toggle('has-series', !!series && !!text);
    if (title) el.title = title; else el.removeAttribute('title');
}
