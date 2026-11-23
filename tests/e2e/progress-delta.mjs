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
 *        every frame of the glide), rather than running ahead of it;
 *      - a BURST of updates (videos finishing together, faster than the
 *        250 ms glide): every frame, the fill's edge, the playhead and the
 *        tint's edge agree, the tint never floats ahead of the fill, and the
 *        bar reaches the last value within one glide of it (it used to trail
 *        the percentage by a third of the bar, the playhead by more, with the
 *        tint drawn as a block further on);
 *      - none is shown when the bar moves back, starts a new stage (snaps), or
 *        the overlay is hidden.
 *   2. The video-loading panel's bars (`ui/loading-progress-modal.js`) — a
 *      `width` fill: same stretch, and the tint grows in one glide with the
 *      fill, as long as that fill's own transition (120 ms).
 */
import { startServer, launchBrowser, waitForAnimations, ANIMATING_IN_PAGE } from './lib/harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 500)));
    if (!c) fails++;
};

let browser;
try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    // The tint's box, as a fraction of its track, plus its state.
    // `__animating()` / `__settled()`: whether a CSS transition or finite
    // animation runs (the fills glide, the tint flashes), and a wait for none,
    // for the waits inside `evaluate`.
    await page.evaluate((ANIMATING) => {
        window.__animating = new Function('return ' + ANIMATING);
        window.__settled = async () => {
            const t0 = performance.now();
            while (window.__animating() && performance.now() - t0 < 10000) await new Promise(r => requestAnimationFrame(r));
        };
        window.__delta = (track) => {
            const d = track.querySelector('.progress-delta');
            if (!d) return null;
            const t = track.getBoundingClientRect(), r = d.getBoundingClientRect();
            return {
                on: d.classList.contains('is-on'), opacity: getComputedStyle(d).opacity,
                left: (r.left - t.left) / t.width, right: (r.right - t.left) / t.width,
            };
        };
        // The glides running on the fill and on its tint just after an update: their lengths (ms).
        window.__glides = (fill) => [fill, fill.parentNode.querySelector('.progress-delta')].map(el =>
            el.getAnimations().filter(a => a.constructor === Animation).map(a => a.effect.getTiming().duration));
    }, ANIMATING_IN_PAGE);
    const settle = () => waitForAnimations(page);

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

    await page.waitForTimeout(300);   // a pause longer than the longest glide, so the next one is a full 250 ms
    const glides30 = await page.evaluate(async () => {
        const lo = await import('/ui/loading-overlay.js');
        lo.showLoadingProgress('Working', 30, 100);
        return window.__glides(document.getElementById('loadingProgressFill'));
    });
    await settle();
    d = await ovDelta();
    check(d && d.on && Math.abs(d.left) < 0.005 && Math.abs(d.right - 0.30) < 0.005,
        'overlay: 0% → 30% lights up exactly 0–30%', d);
    check(glides30[0].length === 1 && glides30[1].length === 1 && glides30[0][0] === 250 && glides30[1][0] === 250,
        'overlay: after a pause, the fill and its tint glide together for the fill\'s own 250 ms', glides30);

    // brightness from a real screenshot: tinted stretch vs plain fill
    // the flash: the tint's ::after, read from the computed style just after the update and once it is over
    const flash = await page.evaluate(async () => {
        const lo = await import('/ui/loading-overlay.js');
        lo.showLoadingProgress('Working', 55, 100);
        const d = document.querySelector('#loadingProgress .progress-delta');
        const at = () => parseFloat(getComputedStyle(d, '::after').opacity);
        await new Promise(r => requestAnimationFrame(r));
        const start = at();
        await window.__settled();
        return { start, end: at() };
    });
    await settle();
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
        // Every frame until the glide is over (not a fixed time, which under
        // load or slowed animations ends mid-glide), then one more.
        const t0 = performance.now();
        let more = 1;
        while ((window.__animating() || more-- > 0) && performance.now() - t0 < 10000) {
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

    // A burst: updates every ~20 ms, and some in the same task, as videos finishing together send them.
    // Every frame: the fill's edge, the playhead's line and the tint's edge, as fractions of the track.
    const burst = await page.evaluate(async () => {
        const lo = await import('/ui/loading-overlay.js');
        lo.hideLoading();
        lo.showLoadingProgress('Loading videos', 0, 40, { unit: 'videos' });
        await window.__settled();
        const track = document.querySelector('#loadingProgress .loading-progress-track');
        const fill = document.getElementById('loadingProgressFill');
        const head = document.getElementById('loadingProgressHead');
        const t = track.getBoundingClientRect();
        const x = (px) => (px - t.left) / t.width;
        const out = [];
        let running = true;
        (async () => {
            while (running) {
                await new Promise(r => requestAnimationFrame(r));
                const delta = track.querySelector('.progress-delta');
                const f = fill.getBoundingClientRect(), h = head.getBoundingClientRect();
                const dr = delta && delta.classList.contains('is-on') ? delta.getBoundingClientRect() : null;
                out.push({ t: performance.now(), fill: x(f.right), head: x(h.left),
                    dL: dr ? x(dr.left) : null, dR: dr ? x(dr.right) : null,
                    pct: parseFloat(document.getElementById('loadingPct').textContent) / 100 });
            }
        })();
        let done = 0;
        while (done < 40) {
            const n = done % 5 === 4 ? 3 : 1;      // now and then three in the same task
            for (let k = 0; k < n && done < 40; k++) lo.showLoadingProgress('Loading videos', ++done, 40, { unit: 'videos' });
            await new Promise(r => setTimeout(r, 20));
        }
        const tEnd = performance.now();
        await window.__settled();
        await new Promise(r => requestAnimationFrame(r));
        running = false;
        await new Promise(r => requestAnimationFrame(r));
        return { out, tEnd };
    });
    const during = burst.out.filter(s => s.t < burst.tEnd);
    const gapHead = Math.max(...burst.out.map(s => Math.abs(s.fill - s.head)));
    const lit = burst.out.filter(s => s.dR != null);
    const gapTint = Math.max(...lit.map(s => Math.abs(s.dR - s.fill)));
    const ahead = Math.max(...lit.map(s => s.dL - s.fill));
    const lag = Math.max(...during.map(s => s.pct - s.fill));
    // the frames 250 ms (+ two frames) after the last update: the bar is at 100%
    const late = burst.out.filter(s => s.t > burst.tEnd + 300);
    check(during.length >= 10 && !(gapHead > 0.01),
        `overlay burst: the playhead stays on the fill's edge (${during.length} frames, worst gap ${(gapHead * 100).toFixed(2)}% of the bar)`, burst.out.slice(0, 6));
    check(lit.length >= 10 && !(gapTint > 0.01) && !(ahead > 0.005),
        `overlay burst: the lit stretch ends at the fill's edge and never floats ahead of it (worst gap ${(gapTint * 100).toFixed(2)}%, ahead ${(ahead * 100).toFixed(2)}%)`, lit.slice(0, 6));
    check(!(lag > 0.15),
        `overlay burst: the fill keeps up with the percentage (at most ${(lag * 100).toFixed(1)} points behind)`, during.slice(-6));
    check(late.length > 0 && late.every(s => Math.abs(s.fill - 1) < 0.005 && Math.abs(s.head - 1) < 0.005),
        'overlay burst: the bar and the playhead reach 100% within one glide of the last update', late.slice(0, 3));

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
        await window.__settled();
        m.updateTask(id, { phase: 'mp4box', ratio: 0.5 });    // 5% + 85% x 0.5 = 47.5%
        await window.__settled();
        const wrap = document.querySelector('.lpm-bar-wrap');
        const out = { a: window.__delta(wrap) };
        await new Promise(r => setTimeout(r, 200));            // longer than the bar's 120 ms, so the next glide is a full one
        m.updateTask(id, { phase: 'mp4box', ratio: 1 });      // 90%
        out.glides = window.__glides(wrap.querySelector('.lpm-bar'));
        await window.__settled();
        out.b = window.__delta(wrap);
        m.dismiss();
        return out;
    });
    check(lpm.a && lpm.a.on && Math.abs(lpm.a.left - 0.05) < 0.005 && Math.abs(lpm.a.right - 0.475) < 0.005,
        'video panel: 5% → 47.5% lights up exactly that stretch', lpm.a);
    check(lpm.b && lpm.b.on && Math.abs(lpm.b.left - 0.475) < 0.005 && Math.abs(lpm.b.right - 0.9) < 0.005,
        'video panel: then 47.5% → 90%', lpm.b);
    check(lpm.glides && lpm.glides[0].length === 1 && lpm.glides[1].length === 1 && lpm.glides[0][0] === 120 && lpm.glides[1][0] === 120,
        'video panel: the fill and its tint glide together for that bar\'s own 120 ms', lpm.glides);
} catch (e) {
    console.error('FATAL', e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
