/**
 * seekbar-ticks.mjs — the time ruler under the transport seekbar
 * (ui/seekbar-ticks.js) in the real app. The tick choice itself is unit-tested
 * in tests/test-seekbar-ticks.mjs.
 *
 * Asserted:
 *  1. A 30-minute, 60 fps recording gets a labelled ruler: times in order, one
 *     constant "nice" step, each label centred on its tick — "00:00" too, which
 *     hangs left of the bar but clear of the transport buttons — no two labels
 *     touching, the rest within the bar.
 *  2. Layout: the ruler sits under the track, inside the controls bar.
 *  3. A click ON a label seeks to that time (the ruler is part of the
 *     seekbar), to within the half pixel a mouse position is rounded to; and
 *     hovering a label shows the seekbar tooltip.
 *  4. Longer recordings get longer steps; a wider bar gets shorter ones —
 *     and a bar resize re-lays the ruler by itself, with no frame update.
 *  5. Editing the FPS pill re-times it; fps 0 and an empty project clear it.
 *  6. Stepping frames never touches the ruler's DOM.
 *  7. It still fits at 640 px, "00:00" still clear of the buttons.
 *
 * Run: node tests/e2e/seekbar-ticks.mjs     (SHOT_DIR=… to save screenshots)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8271);
const SHOT_DIR = process.env.SHOT_DIR || '';
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

// "mm:ss" / "h:mm:ss" / "mm:ss.d" -> seconds
const parseLabel = (s) => s.split(':').reduce((acc, p) => acc * 60 + parseFloat(p), 0);
// "mm:ss.mmm" / "h:mm:ss.mmm" (the readout) -> seconds
const parseReadout = parseLabel;

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const setProject = (total, fps) => page.evaluate(async ([total, fps]) => {
        const s = window.__lucid.state;
        s.totalFrames = total; s.fps = fps;
        (await import('./ui/frame-readout.js')).refreshReadoutTotals();
    }, [total, fps]);
    const ruler = () => page.evaluate(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
        const q = (sel) => document.querySelector(sel);
        return {
            bar: box(q('#seekbar')), track: box(q('.seekbar-track')), ruler: box(q('#seekbarRuler')),
            controls: box(q('.controls-bar')), status: box(q('.status-bar')),
            transport: box(q('.transport-controls')), fps: box(q('.fps-pill')),
            majors: [...document.querySelectorAll('.seekbar-tick.is-major')].map(e => { const b = box(e); return (b.left + b.right) / 2; }),
            minors: document.querySelectorAll('.seekbar-tick:not(.is-major)').length,
            labels: [...document.querySelectorAll('.seekbar-tick-label')].map(e => ({ text: e.textContent, ...box(e) })),
        };
    });
    const stepOf = (labels) => labels.length > 1 ? parseLabel(labels[1].text) - parseLabel(labels[0].text) : 0;
    const setBarWidth = (minWidthPx) => page.evaluate(async (w) => {
        document.querySelector('.frame-display').style.minWidth = w ? w + 'px' : '';
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));   // let the ResizeObserver deliver
    }, minWidthPx);

    // ---- 1. a 30 min, 60 fps recording ----------------------------------------------
    await setProject(108000, 60);
    let r = await ruler();
    const texts = r.labels.map(l => l.text);
    check(r.labels.length >= 4, `labels drawn: ${texts.join(' ')} (bar ${r.bar.width.toFixed(0)} px)`);
    check(texts[0] === '00:00', 'the first label is 00:00');
    check(Math.abs((r.labels[0].left + r.labels[0].right) / 2 - r.bar.left) < 0.5, '  centred on the bar\'s start, like every other label on its tick');
    check(r.labels[0].left >= r.transport.right + 2,
        `  and clear of the transport buttons (${(r.labels[0].left - r.transport.right).toFixed(1)} px)`);
    const step = stepOf(r.labels);
    check([60, 120, 300, 600].includes(step), `a nice step: ${step} s`);
    check(r.labels.every((l, i) => Math.abs(parseLabel(l.text) - i * step) < 1e-9), '  the same step all along');
    check(r.majors.length >= r.labels.length && r.minors > 0, `${r.majors.length} major ticks, ${r.minors} minor ticks`);
    {
        // Each label at the position its time maps to: time * fps / (total - 1).
        let worst = 0;
        r.labels.forEach((l, i) => {
            const x = r.bar.left + parseLabel(l.text) * 60 / (108000 - 1) * r.bar.width;
            const tickX = r.majors[i];
            const labelX = (l.left + l.right) / 2;
            worst = Math.max(worst, Math.abs(tickX - x), Math.abs(labelX - x));
        });
        check(worst < 1, `every label and its tick sit at the time's position (worst ${worst.toFixed(2)} px)`);
    }
    {
        let minGap = Infinity;
        for (let i = 1; i < r.labels.length; i++) minGap = Math.min(minGap, r.labels[i].left - r.labels[i - 1].right);
        check(minGap >= 8, `no two labels touch (smallest gap ${minGap.toFixed(1)} px)`);
    }
    check(r.labels.slice(1).every(l => l.left >= r.bar.left - 0.5 && l.right <= r.bar.right + 0.5), 'every later label is within the bar');

    // ---- 2. layout ------------------------------------------------------------------
    check(r.ruler.top >= r.track.bottom, `the ruler is under the track (${r.track.bottom.toFixed(1)} -> ${r.ruler.top.toFixed(1)})`);
    const labelBottom = Math.max(...r.labels.map(l => l.bottom));
    check(r.ruler.top >= r.controls.top && labelBottom <= r.controls.bottom - 4,
        `the ruler fits in the controls bar (${r.ruler.top.toFixed(0)}–${labelBottom.toFixed(0)} in ${r.controls.top.toFixed(0)}–${r.controls.bottom.toFixed(0)})`);
    check(labelBottom <= r.status.top, 'and stays above the status bar');
    if (SHOT_DIR) {
        await page.evaluate(() => { const s = window.__lucid.state; s.currentFrame = 60257; });
        await page.evaluate(async () => (await import('./ui/ui-wiring.js')).updateSeekbar(60257));
        await page.screenshot({ path: path.join(SHOT_DIR, 'seekbar-ticks-1400.png'), clip: { x: 0, y: r.controls.top - 4, width: 1400, height: r.controls.bottom - r.controls.top + 8 } });
    }

    // ---- 3. click a label: it seeks there; hover: the tooltip -----------------------
    const pxSec = (108000 - 1) / 60 / r.bar.width;     // seconds per pixel
    for (const l of r.labels.slice(1, 4)) {
        const x = Math.round((l.left + l.right) / 2), y = Math.round((l.top + l.bottom) / 2);
        await page.mouse.move(x, y);
        const tipShown = await page.evaluate(() => !document.getElementById('seekbarTooltip').hidden);
        await page.mouse.down(); await page.mouse.up();
        const shown = await page.evaluate(() => document.getElementById('currentTime').textContent);
        const err = Math.abs(parseReadout(shown) - parseLabel(l.text));
        check(tipShown, `hovering the "${l.text}" label shows the seekbar tooltip`);
        check(err <= pxSec + 1 / 60, `clicking it seeks to ${shown} (${err.toFixed(3)} s off; a pixel is ${pxSec.toFixed(3)} s)`);
    }
    await page.mouse.move(10, 10);

    // ---- 4. longer recording -> longer step; wider bar -> shorter step ---------------
    const steps = [];
    for (const [total, fps] of [[300, 30], [36000, 30], [108000, 60], [324000, 30]]) {
        await setProject(total, fps);
        steps.push(stepOf((await ruler()).labels));
    }
    check(steps.every((s, i) => i === 0 || s > steps[i - 1]),
        `10 s / 20 min / 30 min / 3 h step ${steps.join(' / ')} s — longer videos, longer steps`);
    const longest = await ruler();
    check(longest.labels.some(l => /^\d:\d\d:\d\d$/.test(l.text)), `hours read h:mm:ss: ${longest.labels.map(l => l.text).join(' ')}`);

    await setProject(108000, 60);
    const wide = await ruler();
    await setBarWidth(600);   // the frame readout grows; the bar shrinks — no frame update
    const narrow = await ruler();
    check(narrow.bar.width < wide.bar.width - 300, `precondition: the bar shrank (${wide.bar.width.toFixed(0)} -> ${narrow.bar.width.toFixed(0)} px)`);
    check(stepOf(narrow.labels) > stepOf(wide.labels),
        `a resize alone re-lays the ruler: step ${stepOf(wide.labels)} -> ${stepOf(narrow.labels)} s`);
    check(narrow.labels.every(l => l.right <= narrow.bar.right + 0.5), '  and keeps every label within the bar');
    await setBarWidth(0);

    // ---- 5. FPS pill re-times it; fps 0 and no frames clear it -----------------------
    await setProject(36000, 30);                                // 20 min
    const before = stepOf((await ruler()).labels);
    await page.dblclick('#fpsDisplay');
    await page.fill('.fps-pill input', '300');                  // 2 min
    await page.keyboard.press('Enter');
    const after = await ruler();
    check(stepOf(after.labels) < before, `FPS 30 -> 300 re-times the ruler: step ${before} -> ${stepOf(after.labels)} s (${after.labels.map(l => l.text).join(' ')})`);
    await setProject(36000, 0);
    r = await ruler();
    check(r.labels.length === 0 && r.majors.length === 0 && r.minors === 0, 'fps 0: no ruler');
    await setProject(0, 30);
    r = await ruler();
    check(r.labels.length === 0 && r.majors.length === 0, 'no frames: no ruler');

    // ---- 6. frame steps never touch the ruler ---------------------------------------
    await setProject(108000, 60);
    const mutations = await page.evaluate(async () => {
        const { updateSeekbar } = await import('./ui/ui-wiring.js');
        let n = 0;
        const mo = new MutationObserver(recs => { n += recs.length; });
        mo.observe(document.getElementById('seekbarRuler'), { childList: true, subtree: true, attributes: true, characterData: true });
        for (let f = 1000; f < 1200; f++) updateSeekbar(f);
        await new Promise(r => setTimeout(r, 50));
        mo.disconnect();
        return n;
    });
    check(mutations === 0, `200 frame steps made ${mutations} ruler mutations (want 0)`);

    // ---- 7. narrow window -----------------------------------------------------------
    await page.setViewportSize({ width: 640, height: 700 });
    await page.waitForTimeout(150);
    r = await ruler();
    const lb = Math.max(...r.labels.map(l => l.bottom));
    check(r.labels.length >= 2 && r.labels.slice(1).every(l => l.left >= r.bar.left - 0.5 && l.right <= r.bar.right + 0.5),
        `640 px: ${r.labels.map(l => l.text).join(' ')} within a ${r.bar.width.toFixed(0)} px bar`);
    check(r.labels[0].left >= r.transport.right + 2,
        `  "00:00" clear of the transport buttons (${(r.labels[0].left - r.transport.right).toFixed(1)} px)`);
    check(lb <= r.controls.bottom && r.ruler.top >= r.controls.top, '  and inside the controls bar');
    check(r.bar.left >= r.transport.right && r.bar.right <= r.fps.left, '  between the transport buttons and the FPS pill');
    if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'seekbar-ticks-640.png'), clip: { x: 0, y: r.controls.top - 4, width: 640, height: r.controls.bottom - r.controls.top + 8 } });

    check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
} catch (e) {
    console.error(e); fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
