/**
 * info-tip.mjs — the ⓘ explanation appears beside the POINTER.
 *
 * It used to go to `setStatus`, which paints it in the status bar at the
 * bottom-left of the window: the furthest point on screen from the icon just
 * clicked, and a bar that also carries save results and errors. This pins the
 * replacement, and the three ways a cursor-anchored tooltip goes wrong:
 *
 *  1. It shows NEAR THE CURSOR, and follows it — not in the status bar.
 *  2. It is clamped INSIDE the viewport. Every info icon in this app lives in
 *     the right-hand panel, close enough to the edge that a tip placed blindly
 *     to the right of the pointer would hang off it.
 *  3. It lives and dies with the HOVER — leaving the icon dismisses it even
 *     when the icon was clicked. A click only guarantees one is showing (what a
 *     tap needs, since there is no hover on touch); it buys no extra time. The
 *     mouse-click path and the keyboard-focus path must not overlap, or a click
 *     marks the tip keyboard-held and it outlives the pointer after all.
 *
 * Plus: it works through DELEGATION, so an info button rendered into a panel
 * that rebuilds its rows keeps working without being re-wired.
 *
 * Run: node info-tip.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8234);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        if (!P.planeState.active) P.togglePlaneMode();
        // The ⓘ lives in the Nodes TABLE header, and that table is only
        // rendered once there is a node — an empty pool shows "No nodes yet"
        // instead. So mint one, or the button exists in the DOM with no box.
        const input = document.getElementById('planeNodeNameInput');
        input.value = 'corner';
        document.getElementById('btnAddPlaneNode').click();
        P.refreshPlanePanel();
    });
    await page.waitForTimeout(250);

    const tip = () => page.evaluate(() => {
        const el = document.getElementById('infoTip');
        if (!el) return { exists: false };
        const r = el.getBoundingClientRect();
        return {
            exists: true,
            shown: !el.hidden,
            text: el.textContent,
            left: r.left, top: r.top, right: r.right, bottom: r.bottom,
            w: r.width, h: r.height,
        };
    });
    const statusText = () => page.evaluate(() => {
        const el = document.getElementById('statusText') ||
            document.querySelector('.status-bar .status-text');
        return el ? el.textContent : null;
    });

    const btn = await page.$('#planePinInfo');
    check(btn !== null, 'the Pinned column has its ⓘ button');
    const box = await btn.boundingBox();
    check(box !== null && box.width > 0, 'and it is actually on screen');

    console.log('\n--- 1. Hover shows it, beside the pointer ---');
    check((await tip()).shown !== true, 'nothing is showing to start with');

    const statusBefore = await statusText();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(120);
    const t1 = await tip();
    check(t1.shown === true, 'hovering the ⓘ shows the tip');
    check(/unlocked/i.test(t1.text) && /plane-locked/i.test(t1.text),
        'with the pin explanation in it: ' + JSON.stringify(t1.text.slice(0, 60)));
    // THE regression. The text must not be sent to the status bar any more.
    check(await statusText() === statusBefore,
        'and the status bar is untouched — that is the bug being fixed');

    // Near the pointer: within a small radius of the icon it was summoned from,
    // not parked in a corner of the window.
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const dx = Math.min(Math.abs(t1.left - cx), Math.abs(t1.right - cx));
    const dy = Math.min(Math.abs(t1.top - cy), Math.abs(t1.bottom - cy));
    check(dx < 60 && dy < 60,
        'the tip sits beside the cursor (dx ' + Math.round(dx) + ', dy ' + Math.round(dy) + ')');

    console.log('\n--- 2. It stays inside the viewport ---');
    // The plane panel is the far right of the window, so a tip placed blindly
    // to the RIGHT of the pointer would hang off the edge. It has to flip.
    const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    check(t1.right <= vp.w, 'its right edge is on screen (' +
        Math.round(t1.right) + ' <= ' + vp.w + ')');
    check(t1.left >= 0 && t1.top >= 0 && t1.bottom <= vp.h,
        'and so are the other three');
    check(t1.left < cx, 'it flipped to the LEFT of the pointer, rather than being clipped');
    check(t1.w <= 262, 'and wraps rather than running out as one long line: ' + Math.round(t1.w));

    console.log('\n--- 3. Leaving hides it ---');
    await page.mouse.move(400, 400);
    await page.waitForTimeout(120);
    check((await tip()).shown === false, 'moving away puts it back');

    console.log('\n--- 4. A CLICK does not outlive the hover ---');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(120);
    // Clicking must still SHOW it: on a touch device the tap is the only way
    // in, since there is no hover to have shown it already. The regression this
    // guards is that focusin also fires on a mouse click — without the
    // `:focus-visible` gate the click marked the tip keyboard-held, and it then
    // outlived the pointer, which is exactly what must not happen.
    check((await tip()).shown === true, 'clicking the ⓘ shows it');

    await page.mouse.move(500, 500);
    await page.waitForTimeout(120);
    check((await tip()).shown === false,
        'and moving off the icon STILL dismisses it — a click buys it no extra life');

    // The same, with the pointer travelling a short distance rather than
    // jumping: a mousemove that lands off the icon has to dismiss too, or the
    // tip survives until the pointer happens to enter some other element.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(100);
    check((await tip()).shown === true, 'clicked, showing again');
    await page.mouse.move(box.x - 40, box.y + box.height / 2, { steps: 6 });
    await page.waitForTimeout(120);
    check((await tip()).shown === false, 'a slow drift off the icon dismisses it as well');

    console.log('\n--- 5. Esc and an outside click also dismiss ---');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(100);
    check((await tip()).shown === true, 'hovering, showing');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check((await tip()).shown === false, 'Esc closes it without moving the pointer');

    await page.mouse.move(600, 600);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(100);
    check((await tip()).shown === true, 'and re-entering brings it back');
    await page.mouse.click(420, 420);
    await page.waitForTimeout(100);
    check((await tip()).shown === false, 'a click anywhere else closes it');

    console.log('\n--- 6. `title` is gone, the text is still announced ---');
    // Leaving `title` on would surface the NATIVE tooltip a second later,
    // saying the same sentence in a second place.
    const attrs = await page.evaluate(() => {
        const b = document.getElementById('planePinInfo');
        return {
            title: b.getAttribute('title'),
            aria: b.getAttribute('aria-label'),
            data: b.dataset.infotip,
        };
    });
    check(attrs.title === null, 'no title attribute — no second, native tooltip');
    check(typeof attrs.aria === 'string' && attrs.aria.length > 10,
        'but an aria-label carries the text for a screen reader');
    check(attrs.data === attrs.aria, 'and the tip text is the same sentence');

    console.log('\n--- 7. It works by DELEGATION, so a rebuilt panel keeps it ---');
    // The plane panel re-renders its tables constantly. An info button wired at
    // creation time would need re-wiring by every renderer; this asserts a
    // brand-new element, never passed to any setup call, is served too.
    const fresh = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        P.createPlane('floor');
        P.refreshPlanePanel();
        const b = document.createElement('button');
        b.id = 'tmpInfoProbe';
        b.dataset.infotip = 'a brand new icon nobody wired';
        b.style.cssText = 'position:fixed;left:300px;top:300px;width:16px;height:16px;z-index:99999;';
        document.body.appendChild(b);
        return document.getElementById('planePinInfo').dataset.infotip;
    });
    check(typeof fresh === 'string' && fresh.length > 10,
        'the pin ⓘ still carries its text after a repaint');
    await page.mouse.move(308, 308);
    await page.waitForTimeout(120);
    const t3 = await tip();
    check(t3.shown === true && t3.text === 'a brand new icon nobody wired',
        'and an element created afterwards is served with no wiring at all: ' +
        JSON.stringify({ shown: t3.shown, text: t3.text }));
    await page.evaluate(() => document.getElementById('tmpInfoProbe').remove());

    console.log(fails === 0 ? '\nPASS — 0 failure(s)' : `\nFAIL — ${fails} failure(s)`);
} catch (err) {
    console.log('  ✗ threw: ' + (err && err.message ? err.message : String(err)));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
