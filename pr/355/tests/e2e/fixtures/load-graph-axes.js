/**
 * load-graph-axes.js — where the load graph's axis labels and ticks actually render
 * (ui/load-graph.js `createLoadGraph`), for the three e2e tests that show the
 * graph: tests/e2e/id-switch-image-check.mjs (the image check's dialog),
 * triangulate-all-cpu-load.mjs and track-all-cpu-load.mjs (the loading overlay).
 *
 * Served over the dev http server and `import()`ed from inside the page. It
 * measures the TEXT (a Range over each label), not the label's box: the y labels
 * are zero-height boxes, so only the glyphs say whether "100%" is drawn level
 * with the line a 100% load is drawn at.
 */

/**
 * @param {Element} box  the graph's container (class `load-graph`)
 * @returns {{ok: boolean, why: string, y: object[], x: object[], ticks: object[]}}
 *   y: each label's text, the offset of its centre from its level (px), and its gap to the plot;
 *   x: each label's text, its top below the plot, and its left / right relative to the plot's;
 *   ticks: each tick's box relative to the plot. Every tick points OUT of the plot (MATLAB's
 *   TickDir 'out'): a y tick at its label's level, running left from the plot's left edge; an x
 *   tick under the plot's left / right edge, running down — and every label clears its tick.
 */
export function loadGraphAxes(box) {
    const svg = box.querySelector('svg'), r = svg.getBoundingClientRect();
    const pad = +svg.querySelector('g').getAttribute('transform').match(/translate\(0 ([\d.]+)\)/)[1];
    // the levels the series are drawn at: the plot inset `pad` inside the SVG's 1 px border
    const level = { '100%': r.top + 1 + pad, '50%': (r.top + r.bottom) / 2, '0%': r.bottom - 1 - pad };
    const text = (el) => { const g = document.createRange(); g.selectNodeContents(el); return g.getBoundingClientRect(); };
    const y = Array.from(box.querySelectorAll('.load-graph-y span')).map((s) => {
        const b = text(s);
        return { t: s.textContent, off: (b.top + b.bottom) / 2 - level[s.textContent], gap: r.left - b.right, h: b.height };
    });
    const x = Array.from(box.querySelectorAll('.load-graph-x span')).map((s) => {
        const b = text(s);
        return { t: s.textContent, below: b.top - r.bottom, left: b.left - r.left, right: b.right - r.right, h: b.height };
    });
    const T = 4;                                          // LOAD_GRAPH_TICK
    const ticks = Array.from(box.querySelectorAll('.load-graph-tick')).map((el) => {
        const b = el.getBoundingClientRect();
        return { left: b.left - r.left, right: b.right - r.left, top: b.top - r.top, bottom: b.bottom - r.top, w: b.width, h: b.height };
    });
    const why = [];
    const near = (a, b) => Math.abs(a - b) <= 0.5;
    const yT = ticks.filter((t) => t.w > t.h), xT = ticks.filter((t) => t.h > t.w);
    ['100%', '50%', '0%'].forEach((name) => {
        const at = level[name] - r.top;
        if (!yT.some((t) => near((t.top + t.bottom) / 2, at) && near(t.right, 0) && near(t.w, T)))
            why.push('no ' + T + ' px tick out from the left edge at ' + name);
    });
    if (!xT.some((t) => near(t.left, 0) && near(t.top, r.height) && near(t.h, T))) why.push('no tick out under the left edge (60 s ago)');
    if (!xT.some((t) => near(t.right, r.width) && near(t.top, r.height) && near(t.h, T))) why.push('no tick out under the right edge (now)');
    if (ticks.length !== 5) why.push(ticks.length + ' ticks, not 5');
    if (y.map((l) => l.t).join() !== '100%,50%,0%') why.push('y labels ' + y.map((l) => l.t).join());
    y.forEach((l) => {
        if (!(Math.abs(l.off) <= 1)) why.push(l.t + ' is ' + l.off.toFixed(2) + ' px off its level');
        if (!(l.gap >= T + 1 && l.gap <= T + 6)) why.push(l.t + ' is ' + l.gap.toFixed(1) + ' px from the plot (its tick is ' + T + ')');
        if (!(l.h > 0)) why.push(l.t + ' has no text');
    });
    if (x.map((l) => l.t).join() !== '60 s ago,now') why.push('x labels ' + x.map((l) => l.t).join());
    if (x.length === 2) {
        if (!x.every((l) => l.below >= T + 1 && l.below <= T + 6)) why.push('x labels not just under their ticks');
        if (!(Math.abs(x[0].left) <= 1)) why.push('"60 s ago" not at the plot\'s left edge');
        if (!(Math.abs(x[1].right) <= 1)) why.push('"now" not at the plot\'s right edge');
    }
    return { ok: why.length === 0, why: why.join('; '), y, x, ticks };
}
