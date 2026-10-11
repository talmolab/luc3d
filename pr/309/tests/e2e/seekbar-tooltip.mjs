/**
 * seekbar-tooltip.mjs — the transport seekbar's hover tooltip (#142) in the
 * real app.
 *
 * Asserted with real mouse events:
 *  1. Hovering shows "Frame N · mm:ss.mmm" for the point under the cursor, and
 *     it follows the pointer.
 *  2. The frame named is EXACTLY the frame a click there seeks to (checked by
 *     clicking and reading the `#currentFrame` readout).
 *  3. During a drag the tooltip keeps updating even after the pointer leaves
 *     the bar, and disappears on release outside it.
 *  4. Leaving the bar hides it; it is never shown with nothing to seek
 *     through; with fps 0 the timestamp is left out.
 *  5. It is visible on top — not hidden behind the timeline above the bar —
 *     and stays within the bar's horizontal extent at both ends.
 *  6. Moving over the bar reads NO layout (so hovering during playback adds no
 *     forced layout to the frame), yet the cached geometry follows a bar
 *     resize that happens under a stationary pointer.
 *
 * Run: node tests/e2e/seekbar-tooltip.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8263);
const SHOT_DIR = process.env.SHOT_DIR || '';
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const tipState = () => page.evaluate(() => {
        const t = document.getElementById('seekbarTooltip');
        if (!t) return { exists: false };
        const r = t.getBoundingClientRect();
        const bar = document.getElementById('seekbar').getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        // The bubble is pointer-events:none (it must not eat the hover), and
        // elementFromPoint skips such elements — lift that just for the probe.
        t.style.pointerEvents = 'auto';
        const top = document.elementFromPoint(cx, cy);
        t.style.pointerEvents = '';
        return {
            exists: true, hidden: t.hidden, text: t.textContent,
            left: r.left, right: r.right, centre: cx, bottom: r.bottom,
            barLeft: bar.left, barRight: bar.right, barTop: bar.top,
            onTop: !!top && (top === t || t.contains(top)),
        };
    });
    const bar = await page.evaluate(() => {
        const r = document.getElementById('seekbar').getBoundingClientRect();
        return { left: r.left, width: r.width, y: r.top + r.height / 2 };
    });
    // Whole-pixel x (Playwright's mouse lands on integers), and the frame the
    // app maps that x to — the scrub handler's own formula.
    const xAt = (fraction) => Math.round(bar.left + fraction * bar.width);
    const frameAt = (x, total) => Math.round(Math.max(0, Math.min(1, (x - bar.left) / bar.width)) * (total - 1));
    const label = (idx) => 'Frame ' + (idx + 1).toLocaleString('en-US');

    // ---- 4a. nothing to seek through: never shown ------------------------------
    await page.evaluate(() => { window.__lucid.state.totalFrames = 0; });
    await page.mouse.move(xAt(0.5), bar.y);
    let t = await tipState();
    check(t.exists, 'the tooltip element is installed on #seekbar');
    check(t.hidden, 'with no frames, hovering shows nothing');

    // A project with frames but no video: 1,000 frames at 30 fps.
    await page.evaluate(() => {
        const s = window.__lucid.state;
        s.totalFrames = 1000; s.fps = 30; s.currentFrame = 0;
        document.getElementById('totalFrames').textContent = '1000';
    });

    // ---- 1. hover shows the frame under the cursor, and follows it ----------------
    await page.mouse.move(xAt(0.25) + 1, bar.y);
    await page.mouse.move(xAt(0.25), bar.y);
    t = await tipState();
    const f25 = frameAt(xAt(0.25), 1000);
    const ts25 = (() => { const ms = Math.round(f25 / 30 * 1000); return '00:' + String(Math.floor(ms / 1000)).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0'); })();
    check(!t.hidden && t.text === `${label(f25)} · ${ts25}`, `hover at 25% shows "${t.text}" (expected "${label(f25)} · ${ts25}")`);
    check(Math.abs(t.centre - xAt(0.25)) < 1.5, 'the bubble is centred on the cursor');
    check(t.bottom <= t.barTop, 'the bubble sits above the bar');
    check(t.onTop, 'the bubble is on top (not hidden behind the timeline)');
    if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'seekbar-tooltip.png'), clip: { x: 0, y: bar.y - 80, width: 1400, height: 110 } });

    await page.mouse.move(xAt(0.6), bar.y);
    t = await tipState();
    check(t.text.startsWith(label(frameAt(xAt(0.6), 1000)) + ' ·'), `follows the pointer to 60%: "${t.text}"`);

    // ---- 6. layout-free while moving ------------------------------------------------
    // Playback draws every refresh; a hover handler that read layout would force a
    // synchronous layout into the frame. Count every layout read during a run of
    // moves whose text keeps the same length (frames 101..999 at 30 fps).
    await page.mouse.move(xAt(0.3), bar.y);
    await page.evaluate(() => {
        window.__layoutReads = 0;
        const bump = () => { window.__layoutReads++; };
        const gbcr = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function () { bump(); return gbcr.call(this); };
        for (const prop of ['offsetWidth', 'offsetHeight', 'offsetLeft', 'offsetTop', 'clientWidth']) {
            const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop) || Object.getOwnPropertyDescriptor(Element.prototype, prop);
            const owner = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop) ? HTMLElement.prototype : Element.prototype;
            Object.defineProperty(owner, prop, { configurable: true, get() { bump(); return d.get.call(this); } });
        }
    });
    for (let i = 0; i <= 20; i++) await page.mouse.move(xAt(0.3 + i * 0.02), bar.y);
    const reads = await page.evaluate(() => window.__layoutReads);
    t = await tipState();   // (tipState itself reads layout — after the count)
    check(reads === 0, `21 hover moves made ${reads} layout reads (want 0)`);
    check(t.text.startsWith(label(frameAt(xAt(0.7), 1000)) + ' ·'), `and still tracked the pointer: "${t.text}"`);

    // The cached rect must not go stale: resize the bar while the pointer stays
    // on it (as the frame counter gaining a digit does), then check the tooltip
    // still names the frame a click lands on.
    await page.evaluate(() => { document.querySelector('.frame-display').style.minWidth = '260px'; });
    await page.waitForTimeout(100);   // let the ResizeObserver deliver
    const bar2 = await page.evaluate(() => { const r = document.getElementById('seekbar').getBoundingClientRect(); return { left: r.left, width: r.width }; });
    check(bar2.width < bar.width - 50, `precondition: the bar shrank (${bar.width.toFixed(0)} -> ${bar2.width.toFixed(0)} px)`);
    {
        const x = Math.round(bar2.left + 0.5 * bar2.width);
        await page.mouse.move(x, bar.y);
        const shown = (await tipState()).text.match(/^Frame ([\d,]+)/)[1].replace(/,/g, '');
        await page.mouse.down(); await page.mouse.up();
        const landed = await page.evaluate(() => document.getElementById('currentFrame').textContent.replace(/,/g, ''));
        check(shown === landed, `after the bar resized under the pointer, tooltip said ${shown}, click landed on ${landed}`);
    }
    await page.evaluate(() => { document.querySelector('.frame-display').style.minWidth = ''; });
    await page.mouse.move(xAt(0.5), bar.y - 200);
    await page.waitForTimeout(100);

    // ---- 2. it names the frame a click seeks to ------------------------------------
    for (const frac of [0.137, 0.5, 0.913]) {
        await page.mouse.move(xAt(frac), bar.y);
        const shown = (await tipState()).text.match(/^Frame ([\d,]+)/)[1].replace(/,/g, '');
        await page.mouse.down(); await page.mouse.up();
        const landed = await page.evaluate(() => document.getElementById('currentFrame').textContent.replace(/,/g, ''));
        check(shown === landed, `at ${(frac * 100).toFixed(1)}% the tooltip said ${shown}, a click landed on ${landed}`);
    }

    // ---- 5. clamped at the ends ------------------------------------------------------
    await page.mouse.move(xAt(0.001), bar.y);
    t = await tipState();
    check(t.left >= t.barLeft - 0.5, 'at the far left the bubble does not hang off the bar');
    check(t.text.startsWith(label(frameAt(xAt(0.001), 1000)) + ' ·'), `far left reads the frame a click there seeks to: "${t.text}"`);
    const xRight = Math.floor(bar.left + bar.width) - 1;
    await page.mouse.move(xRight, bar.y);
    t = await tipState();
    check(t.right <= t.barRight + 0.5, 'at the far right the bubble does not hang off the bar');
    check(t.text.startsWith(label(frameAt(xRight, 1000)) + ' ·'), `far right reads the frame a click there seeks to: "${t.text}"`);

    // ---- 4b. leaving hides it ----------------------------------------------------------
    await page.mouse.move(xAt(0.5), bar.y - 200);
    check((await tipState()).hidden, 'moving off the bar hides it');

    // ---- 3. drag: keeps updating off the bar, hides on release outside ------------------
    await page.mouse.move(xAt(0.2), bar.y);
    await page.mouse.down();
    await page.mouse.move(xAt(0.7), bar.y - 150, { steps: 4 });   // dragged up, off the bar
    t = await tipState();
    check(!t.hidden && t.text.startsWith(label(frameAt(xAt(0.7), 1000)) + ' ·'),
        `while dragging off the bar it tracks the scrub frame: "${t.text}"`);
    await page.mouse.up();
    check((await tipState()).hidden, 'releasing off the bar hides it');

    // ---- 4c. fps 0: no timestamp ----------------------------------------------------------
    await page.evaluate(() => { window.__lucid.state.fps = 0; });
    await page.mouse.move(xAt(0.5), bar.y);
    t = await tipState();
    check(t.text === label(frameAt(xAt(0.5), 1000)), `fps 0 leaves the timestamp out: "${t.text}"`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
