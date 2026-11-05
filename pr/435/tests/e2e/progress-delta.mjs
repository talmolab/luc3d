/**
 * progress-delta.mjs — every progress bar lights up the stretch it just gained
 * (ui/progress-delta.js).
 *
 * When a bar moves forward, the length it added on that update is drawn in a
 * brighter shade of the bar's colour (a `.progress-delta` tint over the fill,
 * with a short white flash as it appears) and stays lit until the next update.
 * Driven on the two kinds of fill the app has, in the real app:
 *
 *   1. The loading overlay's bar (Track All, Triangulate All, Save, …) — a
 *      full-width fill scaled with `transform`:
 *      - the tint covers exactly the gained stretch (0→30%, then 30→55%);
 *      - it is brighter than the fill around it, measured from pixels of a
 *        real screenshot, and flashes white as it appears (its `::after`
 *        opacity, from the computed style, then back to 0);
 *      - its leading edge moves WITH the fill's while the fill glides (sampled
 *        every frame of the transition), rather than running ahead of it;
 *      - none is shown when the bar moves back, starts a new stage (snaps), or
 *        the overlay is hidden.
 *   2. The video-loading panel's bars (`ui/loading-progress-modal.js`) — a
 *      `width` fill: same stretch, and the tint grows with that fill's own
 *      transition (120 ms linear), read from its computed style.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8141);
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 500)));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    // The tint's box, as a fraction of its track, plus its state.
    await page.evaluate(() => {
        window.__delta = (track) => {
            const d = track.querySelector('.progress-delta');
            if (!d) return null;
            const t = track.getBoundingClientRect(), r = d.getBoundingClientRect();
            return {
                on: d.classList.contains('is-on'), opacity: getComputedStyle(d).opacity,
                left: (r.left - t.left) / t.width, right: (r.right - t.left) / t.width,
                transition: d.style.transition,
            };
        };
    });
    const settle = () => page.waitForTimeout(400);

    // ---- 1. loading overlay ----
    const ov = (fn, ...a) => page.evaluate(async ([fn, a]) => {
        const lo = await import('/ui/loading-overlay.js');
        lo[fn](...a);
    }, [fn, a]);
    const ovDelta = () => page.evaluate(() => window.__delta(document.querySelector('#loadingProgress .loading-progress-track')));

    await ov('showLoadingProgress', 'Working', 0, 100, { title: 'Test' });
    await settle();
    let d = await ovDelta();
    check(!d || !d.on, 'overlay: a bar that has just appeared shows no gained stretch', d);

    await ov('showLoadingProgress', 'Working', 30, 100);
    await settle();
    d = await ovDelta();
    check(d && d.on && Math.abs(d.left) < 0.005 && Math.abs(d.right - 0.30) < 0.005,
        'overlay: 0% → 30% lights up exactly 0–30%', d);
    check(d && /transform 250ms linear/.test(d.transition), 'overlay: the tint grows with the fill\'s own transition (250 ms linear)', d);

    // brightness from a real screenshot: tinted stretch vs plain fill
    // the flash: the tint's ::after, read from the computed style just after the update and once it is over
    const flash = await page.evaluate(async () => {
        const lo = await import('/ui/loading-overlay.js');
        lo.showLoadingProgress('Working', 55, 100);
        const d = document.querySelector('#loadingProgress .progress-delta');
        const at = () => parseFloat(getComputedStyle(d, '::after').opacity);
        await new Promise(r => requestAnimationFrame(r));
        const start = at();
        await new Promise(r => setTimeout(r, 1000));
        return { start, end: at() };
    });
    await page.waitForTimeout(100);
    const steadyShot = await page.locator('#loadingProgress').screenshot();
    d = await ovDelta();
    check(d && d.on && Math.abs(d.left - 0.30) < 0.005 && Math.abs(d.right - 0.55) < 0.005,
        'overlay: 30% → 55% lights up exactly 30–55% (the previous stretch is no longer lit)', d);
    const lum = await page.evaluate(async ([b]) => {
        const img = async (b64) => { const i = new Image(); i.src = 'data:image/png;base64,' + b64; await i.decode(); return i; };
        const read = async (b64) => {
            const i = await img(b64), c = document.createElement('canvas');
            c.width = i.width; c.height = i.height;
            const x = c.getContext('2d'); x.drawImage(i, 0, 0);
            const y = Math.floor(i.height / 2);
            const L = (fx) => { const p = x.getImageData(Math.floor(fx * i.width), y, 1, 1).data; return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]; };
            return { fill: L(0.15), delta: L(0.45), empty: L(0.8) };
        };
        return { steady: await read(b) };
    }, [steadyShot.toString('base64')]);
    check(lum.steady.delta > lum.steady.fill + 25, 'overlay: the gained stretch is brighter than the rest of the fill', lum.steady);
    check(flash.start > 0.3 && flash.end === 0, 'overlay: it flashes white as it appears, then settles (flash opacity ' +
        flash.start.toFixed(2) + ' → ' + flash.end + ')', flash);
    check(lum.steady.fill > lum.steady.empty, 'overlay: (sanity) the fill is brighter than the empty track', lum.steady);

    // the tint's leading edge follows the fill's while it glides
    const sync = await page.evaluate(async () => {
        const lo = await import('/ui/loading-overlay.js');
        const track = document.querySelector('#loadingProgress .loading-progress-track');
        const fill = document.getElementById('loadingProgressFill');
        lo.showLoadingProgress('Working', 90, 100);
        const t = track.getBoundingClientRect(), out = [];
        const t0 = performance.now();
        while (performance.now() - t0 < 300) {
            await new Promise(r => requestAnimationFrame(r));
            const f = fill.getBoundingClientRect(), d = track.querySelector('.progress-delta').getBoundingClientRect();
            out.push({ fill: (f.right - t.left) / t.width, delta: (d.right - t.left) / t.width });
        }
        return out;
    });
    const moving = sync.filter(s => s.fill > 0.56 && s.fill < 0.89);
    const worst = Math.max(...sync.map(s => Math.abs(s.fill - s.delta)));
    check(moving.length >= 3 && worst < 0.02,
        `overlay: the tint's edge moves with the fill's (${moving.length} frames mid-glide, worst gap ${(worst * 100).toFixed(2)}% of the bar)`, sync.slice(0, 8));

    await ov('showLoadingProgress', 'Working', 40, 100);
    await settle();
    d = await ovDelta();
    check(d && !d.on, 'overlay: moving back lights nothing', d);
    await ov('showLoadingProgress', 'Next stage', 10, 50, { step: 2, steps: 2 });
    await settle();
    d = await ovDelta();
    check(d && !d.on, 'overlay: a new stage (the bar snaps) lights nothing', d);
    await ov('showLoadingProgress', 'Next stage', 20, 50, { step: 2, steps: 2 });
    await settle();
    d = await ovDelta();
    check(d && d.on && Math.abs(d.left - 0.2) < 0.005 && Math.abs(d.right - 0.4) < 0.005,
        'overlay: the new stage then lights its own gains (20–40%)', d);
    await ov('hideLoading');
    d = await ovDelta();
    check(d && !d.on, 'overlay: hiding the overlay clears it', d);

    // ---- 2. the video-loading panel (a width fill) ----
    const lpm = await page.evaluate(async () => {
        const { getLoadingProgressModal } = await import('/ui/loading-progress-modal.js');
        const m = getLoadingProgressModal({ title: 'Loading videos' });
        m.reset();
        const id = m.addTask({ label: 'cam0.mp4' });
        m.show();
        m.updateTask(id, { phase: 'mp4box', ratio: 0 });
        await new Promise(r => setTimeout(r, 300));
        m.updateTask(id, { phase: 'mp4box', ratio: 0.5 });    // 5% + 85% x 0.5 = 47.5%
        await new Promise(r => setTimeout(r, 300));
        const wrap = document.querySelector('.lpm-bar-wrap');
        const out = { a: window.__delta(wrap) };
        m.updateTask(id, { phase: 'mp4box', ratio: 1 });      // 90%
        await new Promise(r => setTimeout(r, 300));
        out.b = window.__delta(wrap);
        m.dismiss();
        return out;
    });
    check(lpm.a && lpm.a.on && Math.abs(lpm.a.left - 0.05) < 0.005 && Math.abs(lpm.a.right - 0.475) < 0.005,
        'video panel: 5% → 47.5% lights up exactly that stretch', lpm.a);
    check(lpm.b && lpm.b.on && Math.abs(lpm.b.left - 0.475) < 0.005 && Math.abs(lpm.b.right - 0.9) < 0.005,
        'video panel: then 47.5% → 90%', lpm.b);
    check(lpm.b && /transform 120ms linear/.test(lpm.b.transition),
        'video panel: the tint grows with that bar\'s own width transition (120 ms linear)', lpm.b);
} catch (e) {
    console.error('FATAL', e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
