#!/usr/bin/env node
/**
 * smoothing-wiki-figures.mjs — the luc3d-docs Temporal Smoothing page's three step
 * figures, drawn with the Settings figure's own sketches, so they run LUC3D's real
 * filter and use its colours (`.smooth-fig` in styles.css).
 *
 * Run: node scripts/smoothing-wiki-figures.mjs <luc3d-docs>/docs/assets/smoothing
 * What the captions claim is checked by tests/test-smoothing-figure-steps.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSketch, gapSketch, TRACE_FRAMES } from '../ui/smoothing-windows-figure.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2];
if (!outDir) { console.error('usage: smoothing-wiki-figures.mjs <output folder>'); process.exit(1); }

const SPIKE_FRAME = TRACE_FRAMES.spike, FAST_FRAME = TRACE_FRAMES.fast;

const FIGURES = [
    {
        file: 'median-steps.svg', stage: 'median', title: 'Median window, four steps',
        desc: 'The same made-up trace at no median, then windows of 1, 3 and 11 frames.',
        steps: [
            { title: 'Off', window: 0, frame: SPIKE_FRAME,
                text: 'The 3D as triangulated, with its jitter, a one-frame spike and a fast real move.' },
            { title: '1 frame', window: 1, frame: SPIKE_FRAME,
                text: 'A window of one frame holds only the frame itself, so nothing changes: the green line lies on the grey one.' },
            { title: '3 frames', window: 3, frame: SPIKE_FRAME,
                text: 'All it takes to remove the spike: a one-frame spike cannot be the middle of three values. The fast move survives.' },
            { title: '11 frames', window: 11, frame: FAST_FRAME,
                text: 'Too long: the fast move fills under half of the window, so it is never the middle value, and it is flattened.' },
        ],
    },
    {
        file: 'gaussian-steps.svg', stage: 'gaussian', title: 'Gaussian window, four steps',
        desc: 'The output of a 3-frame median at no Gaussian, then windows of 1, 5 and 15 frames.',
        medianWindow: 3,
        steps: [
            { title: 'Off', window: 0, frame: FAST_FRAME,
                text: 'The output of a 3-frame median, which is what the Gaussian takes in. The spike is gone and some jitter is left.' },
            { title: '1 frame', window: 1, frame: FAST_FRAME,
                text: 'A window of one frame holds only the frame itself, so nothing changes: the blue line lies on the green one.' },
            { title: '5 frames', window: 5, frame: FAST_FRAME,
                text: 'The smallest window that smooths: the jitter eases and the fast move keeps most of its height.' },
            { title: '15 frames', window: 15, frame: FAST_FRAME,
                text: 'Too long: the line is smooth, but averaging with the frames around it damps the fast move to under half its height.' },
        ],
    },
];

// The gaps figure, smoothed by a 3-frame median and a 9-frame Gaussian throughout.
const GAPS = {
    file: 'gaps-steps.svg', title: 'Gaps and segments, three steps',
    desc: 'A made-up trace with absences of 2, 7 and 6 frames, at three settings of Max gap and Minimum segment length.',
    windows: { median: 3, gaussian: 9 },
    steps: [
        { title: 'Max gap 5, minimum segment 5 (the defaults)', maxGap: 5, minSegment: 5,
            text: 'The 2-frame absence stays a hole. The 7- and 6-frame ones split the trace into three segments, and no window crosses them. The 3-frame segment is shorter than the minimum, so it is left as it is.' },
        { title: 'Minimum segment 2', maxGap: 5, minSegment: 2,
            text: 'The 3-frame segment is now filtered. Its two ends have no room for a window, so only its middle frame can change.' },
        { title: 'Max gap 7', maxGap: 7, minSegment: 5,
            text: 'Every absence is now a hole, so the trace is one segment. The missing frames are still not filled in. Windows skip over them, so the first frame after the 6-frame absence averages only itself and later frames, and lands ahead of the fast movement there.' },
    ],
};

/** The `.smooth-fig .sf-*` rules of styles.css, with the theme's colours filled in. */
function figureCss() {
    const css = fs.readFileSync(path.join(repoRoot, 'styles.css'), 'utf8');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    const vars = new Map([...root.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    const rules = [...css.matchAll(/^\.smooth-fig (\.sf-[\w.-]+) \{([^}]*)\}/gm)]
        .filter((m) => !m[1].startsWith('.sf-key') && !/sf-play/.test(m[1]));
    return rules.map((m) => m[1] + '{' + m[2].trim().replace(/var\((--[\w-]+)\)/g, (_, v) => {
        if (!vars.has(v)) throw new Error('unknown colour ' + v);
        return vars.get(v);
    }) + '}').join('\n');
}

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&#39;');

/** Words into lines of at most `max` characters. */
function wrap(text, max) {
    const lines = [''];
    text.split(' ').forEach((w) => {
        const last = lines[lines.length - 1];
        if (last && (last + ' ' + w).length > max) lines.push(w);
        else lines[lines.length - 1] = last ? last + ' ' + w : w;
    });
    return lines;
}

/** One legend swatch, 16 wide, centred on (x + 8, y), drawn with the sketch's own classes. */
function swatch(key, x, y) {
    const mid = x + 8, line = (cls) => `<line x1="${x}" y1="${y}" x2="${x + 16}" y2="${y}" class="${cls}"/>`;
    const bar = (cls) => `<line x1="${mid}" y1="${y - 4}" x2="${mid}" y2="${y + 4}" class="${cls}"/>`;
    const dot = (r, cls) => `<circle cx="${mid}" cy="${y}" r="${r}" class="${cls}"/>`;
    switch (key) {
    case 'true': return line('sf-true');
    case 'raw': return line('sf-raw-line') + dot(3.4, 'sf-raw');
    case 'spike': return dot(2.2, 'sf-spike');
    case 'med': return line('sf-in-median') + dot(2.2, 'sf-med');
    case 'out': return line('sf-out') + dot(2.2, 'sf-out-node');
    case 'band': return `<rect x="${x + 2}" y="${y - 4}" width="12" height="8" class="sf-band"/>`;
    case 'rank': return bar('sf-rank');
    case 'rank-mid': return bar('sf-rank sf-rank-mid');
    case 'weight': return bar('sf-weight');
    case 'out-line': return line('sf-out');
    case 'left': return line('sf-out sf-left');
    case 'hole': return `<rect x="${x + 2}" y="${y - 4}" width="12" height="8" class="sf-absent"/>`;
    case 'split': return `<rect x="${x + 2}" y="${y - 4}" width="12" height="8" class="sf-absent sf-absent-split"/>`;
    case 'seg': return `<rect x="${x + 1}" y="${y - 2.5}" width="14" height="5" rx="2" class="sf-seg"/>`;
    case 'seg-short': return `<rect x="${x + 1}" y="${y - 2.5}" width="14" height="5" rx="2" class="sf-seg sf-seg-short"/>`;
    default: throw new Error('no swatch for ' + key);
    }
}

const PANEL_W = 320, PAD = 10, CHART_W = 300, CHART_H = 140, GAP = 12, LINE = 13;

function panel(fig, step, x, y, h) {
    const s = stageSketch(fig.stage, step.window, { medianWindow: fig.medianWindow, frame: step.frame });
    const lines = wrap(step.text, 54);
    let o = `<rect x="${x + 0.5}" y="${y + 0.5}" width="${PANEL_W - 1}" height="${h - 1}" rx="8" class="panel"/>`;
    o += `<text x="${x + PAD}" y="${y + 19}" class="step">${esc(step.title)}</text>`;
    lines.forEach((l, i) => { o += `<text x="${x + PAD}" y="${y + 35 + i * LINE}" class="cap">${esc(l)}</text>`; });
    const chartY = y + 35 + 3 * LINE - 2;
    o += s.svg.replace('<svg ', `<svg x="${x + PAD}" y="${chartY}" width="${CHART_W}" height="${CHART_H}" `);
    // The legend, in the space above the trace's low end.
    const widest = Math.max(...s.keys.map((k) => k[1].length));
    const lx = x + PAD + CHART_W + 4 - 20 - widest * 4.9;
    s.keys.forEach((k, i) => {
        if (k[2]) return;
        const ly = chartY + 3 + i * 10;
        o += swatch(k[0], lx, ly) + `<text x="${lx + 20}" y="${ly + 3}" class="key">${esc(k[1])}</text>`;
    });
    return o;
}

/** The gaps figure: its wide sketches stacked, with one legend at the bottom. */
function gapsFigure(fig) {
    const W = 2 * PANEL_W + GAP, chartW = W - 2 * PAD, chartH = chartW * 140 / 600;
    const legendH = 44;
    let y = 0, body = '';
    fig.steps.forEach((st) => {
        const s = gapSketch({ ...fig.windows, maxGap: st.maxGap, minSegment: st.minSegment });
        const lines = wrap(st.text, 112);
        const chartY = y + 35 + (lines.length - 1) * LINE + 6;
        const h = chartY - y + chartH + PAD;
        body += `<rect x="0.5" y="${y + 0.5}" width="${W - 1}" height="${h - 1}" rx="8" class="panel"/>`
            + `<text x="${PAD}" y="${y + 19}" class="step">${esc(st.title)}</text>`
            + lines.map((l, i) => `<text x="${PAD}" y="${y + 35 + i * LINE}" class="cap">${esc(l)}</text>`).join('')
            + s.svg.replace('<svg ', `<svg x="${PAD}" y="${chartY}" width="${chartW}" height="${chartH}" `);
        y += h + GAP;
    });
    const keys = gapSketch({ ...fig.windows, maxGap: 5, minSegment: 5 }).keys, colW = (W - 2 * PAD) / 4;
    body += `<rect x="0.5" y="${y + 0.5}" width="${W - 1}" height="${legendH - 1}" rx="8" class="panel"/>`
        + keys.map((k, i) => {
            const lx = PAD + (i % 4) * colW, ly = y + 15 + (i >> 2) * 15;
            return swatch(k[0], lx, ly) + `<text x="${lx + 20}" y="${ly + 3}" class="key">${esc(k[1])}</text>`;
        }).join('');
    return svgDoc(fig, W, y + legendH, body);
}

function svgDoc(fig, W, H, body) {
    const css = figureCss() + `
.panel{fill:#1a1a1a;stroke:#3a3a3a}
.step{font-size:14px;font-weight:600;fill:#e0e0e0}
.cap{font-size:11px;fill:#aaaaaa}
.key{font-size:9px;fill:#aaaaaa}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
<title id="t">${esc(fig.title)}</title>
<desc id="d">${esc(fig.desc)}</desc>
<style>
${css}
</style>
${body}
</svg>
`;
}

function figure(fig) {
    const panelH = 35 + 3 * LINE - 2 + CHART_H + PAD;
    const W = 2 * PANEL_W + GAP, H = 2 * panelH + GAP;
    const body = fig.steps.map((st, i) => panel(fig, st, (i % 2) * (PANEL_W + GAP), (i >> 1) * (panelH + GAP), panelH)).join('\n');
    return svgDoc(fig, W, H, body);
}

fs.mkdirSync(outDir, { recursive: true });
FIGURES.forEach((fig) => {
    const file = path.join(outDir, fig.file);
    fs.writeFileSync(file, figure(fig));
    console.log('wrote ' + file);
});
fs.writeFileSync(path.join(outDir, GAPS.file), gapsFigure(GAPS));
console.log('wrote ' + path.join(outDir, GAPS.file));
