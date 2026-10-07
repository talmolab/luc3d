/**
 * frame-readout.mjs — the controls bar's frame readout (ui/frame-readout.js)
 * in the real app: "time / duration" above "frame / total", with thousands
 * separators.
 *
 * Asserted:
 *  1. Totals: "36,000" frames and a "20:00.000" duration at 30 fps.
 *  2. A seekbar click shows the frame with a separator and its start time —
 *     and the readout then says exactly what the seekbar tooltip said before
 *     the click, so the two can never disagree.
 *  3. Layout: the time row sits above the frame row, the two slashes are in one
 *     vertical line, and the readout fits in the controls bar without running
 *     into the transport buttons — at desktop width and at 640 px.
 *  4. The inline frame editor (double-click) accepts "12,345", the way the
 *     readout displays it.
 *  5. Editing the FPS pill re-times the readout; fps 0 shows placeholders.
 *
 * Run: node tests/e2e/frame-readout.mjs     (SHOT_DIR=… to save screenshots)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8264);
const SHOT_DIR = process.env.SHOT_DIR || '';
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const readout = () => page.evaluate(() => {
        const q = (id) => document.getElementById(id);
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        const seps = [...document.querySelectorAll('.frame-display .frame-sep')].map(box);
        return {
            time: q('currentTime').textContent, duration: q('totalTime').textContent,
            frame: q('currentFrame').textContent, total: q('totalFrames').textContent,
            timeBox: box(q('currentTime')), frameBox: box(q('currentFrame')), seps,
            display: box(document.querySelector('.frame-display')),
            bar: box(document.querySelector('.controls-bar')),
            transport: box(document.querySelector('.transport-controls')),
        };
    });
    const setProject = (total, fps) => page.evaluate(async ([total, fps]) => {
        const s = window.__lucid.state;
        s.totalFrames = total; s.fps = fps;
        (await import('./ui/frame-readout.js')).refreshReadoutTotals();
    }, [total, fps]);
    const fmt = (sec) => {   // mm:ss.mmm, as formatTimestamp (under an hour)
        const ms = Math.round(sec * 1000);
        return String(Math.floor(ms / 60000)).padStart(2, '0') + ':' +
            String(Math.floor(ms / 1000) % 60).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0');
    };
    const layoutChecks = (r, label) => {
        const centres = r.seps.map(b => (b.left + b.right) / 2);
        check(r.seps.length === 2 && Math.abs(centres[0] - centres[1]) < 0.5,
            `${label}: the two slashes are in one vertical line (${centres.map(c => c.toFixed(1)).join(' / ')})`);
        check(r.timeBox.bottom <= r.frameBox.top + 0.5, `${label}: the time row is above the frame row`);
        check(Math.abs(r.timeBox.right - r.frameBox.right) < 0.5, `${label}: current time and current frame share a right edge`);
        check(r.display.top >= r.bar.top && r.display.bottom <= r.bar.bottom,
            `${label}: the readout fits in the controls bar (${r.display.top.toFixed(0)}–${r.display.bottom.toFixed(0)} in ${r.bar.top.toFixed(0)}–${r.bar.bottom.toFixed(0)})`);
        check(r.display.right <= r.transport.left, `${label}: it does not run into the transport buttons`);
    };

    // ---- 1. totals ------------------------------------------------------------------
    let r = await readout();
    check(r.time === '00:00.000' && r.duration === '00:00.000', `startup: "${r.time} / ${r.duration}"`);
    await setProject(36000, 30);
    r = await readout();
    check(r.total === '36,000', `total frames "${r.total}"`);
    check(r.duration === '20:00.000', `duration "${r.duration}" (36,000 / 30 fps)`);

    // ---- 2. a seekbar click; the readout repeats the tooltip ------------------------
    const bar = await page.evaluate(() => {
        const b = document.getElementById('seekbar').getBoundingClientRect();
        return { left: b.left, width: b.width, y: b.top + b.height / 2 };
    });
    for (const frac of [0.1065, 0.5, 0.913]) {
        const x = Math.round(bar.left + frac * bar.width);
        await page.mouse.move(x - 1, bar.y);
        await page.mouse.move(x, bar.y);
        const tip = await page.evaluate(() => document.getElementById('seekbarTooltip').textContent);
        await page.mouse.down(); await page.mouse.up();
        r = await readout();
        const idx = await page.evaluate(() => window.__lucid.state.currentFrame);
        check(r.frame === (idx + 1).toLocaleString('en-US') && /,/.test(r.frame),
            `at ${(frac * 100).toFixed(1)}%: frame "${r.frame}" has its separator`);
        check(r.time === fmt(idx / 30), `  and its time is the frame's start, "${r.time}"`);
        check(tip === `Frame ${r.frame} · ${r.time}`, `  and the readout repeats the tooltip ("${tip}")`);
    }
    await page.mouse.move(bar.left, bar.y - 300);

    // ---- 3. layout ------------------------------------------------------------------
    layoutChecks(await readout(), '1400 px');
    if (SHOT_DIR) {
        const d = (await readout()).display;
        await page.screenshot({ path: path.join(SHOT_DIR, 'frame-readout.png'), clip: { x: 0, y: d.top - 14, width: 520, height: d.bottom - d.top + 28 } });
    }

    // ---- 4. the frame editor accepts what the readout shows -------------------------
    await page.dblclick('#currentFrame');
    await page.fill('#currentFrame input', '12,345');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 12344, { timeout: 3000 }).catch(() => {});
    r = await readout();
    check(r.frame === '12,345' && r.time === '06:51.467', `typing "12,345" seeks there: "${r.time}" / "${r.frame}"`);

    // ---- 5. FPS re-times it; fps 0 shows placeholders -------------------------------
    await page.dblclick('#fpsDisplay');
    await page.fill('.fps-pill input', '60');
    await page.keyboard.press('Enter');
    r = await readout();
    check(r.duration === '10:00.000' && r.time === '03:25.733',
        `FPS 60 re-times both: "${r.time} / ${r.duration}"`);
    check(r.frame === '12,345' && r.total === '36,000', '  and leaves the frames alone');
    await setProject(36000, 0);
    r = await readout();
    check(r.time === '--:--.---' && r.duration === '--:--.---' && r.frame === '12,345',
        `fps 0: "${r.time} / ${r.duration}" over "${r.frame} / ${r.total}"`);
    await setProject(36000, 30);

    // ---- 3b. narrow window ----------------------------------------------------------
    await page.setViewportSize({ width: 640, height: 700 });
    await page.waitForTimeout(150);
    layoutChecks(await readout(), '640 px');

    check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
} catch (e) {
    console.error(e); fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
