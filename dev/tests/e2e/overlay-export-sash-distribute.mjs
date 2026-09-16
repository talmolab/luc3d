/**
 * overlay-export-sash-distribute.mjs — dragging a sash in the "Export Video
 * Overlays" composition dock must share the change with EVERY tile on that axis.
 *
 * dockview 6.6.1 hands a sash drag's whole delta to the ONE tile on the other side
 * of the sash and only spills further when that neighbour hits its 100px minimum
 * (`Splitview.resize`). With three or more tiles on an axis the far tiles never
 * move at all. Nothing configures this — `proportionalLayout` governs container
 * resize (and is hardcoded + explicitly "not supported" in `updateOptions`),
 * `distributeViewSizes()` equalises everything and is not on any public API, and
 * `LayoutPriority` only reorders the same spill list and cannot reach a sash drag.
 * So the modal takes the gesture over with a capture-phase listener.
 *
 * That makes this test the only thing standing between the feature and two
 * failure modes that both look plausible in code review:
 *   - the delta lands on one neighbour again (the pre-fix behaviour), and
 *   - the "fix" equalises every tile on release, throwing away the composition and
 *     making the dock effectively un-resizable. Asserted directly by dragging
 *     TWICE and requiring the first drag's asymmetry to survive.
 *
 * The dock geometry IS the exported frame (`captureLayout` reads the tile rects),
 * so this is a correctness test, not a cosmetic one.
 *
 * TWO THINGS THIS FILE CANNOT SEE — see `overlay-export-sash-tracking.mjs`:
 *   - It drags **sash 0**, where "share with the tiles beyond the sash" and "share
 *     with every tile on the axis" are the same arithmetic (everything is beyond
 *     sash 0). So it stayed green through a shipped mode whose handle did not follow
 *     the cursor on any OTHER sash (measured 66% and 33% tracking).
 *   - It asserts its axis is FLAT (3 cameras on purpose), so it never reaches the
 *     nested column grid a 4+ camera seed builds, where row dividers used to move a
 *     single column and leave the grid ragged.
 * Both files are needed; neither subsumes the other.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8149);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // THREE calibrated cameras, so the seed is 3 video tiles in a row plus the 3D
    // tile docked to their right — a single horizontal axis of exactly four leaves.
    // That matters: `seedLayoutPlan` puts 4+ cameras into a multi-ROW grid, which
    // nests the splitviews into axes of two, and an axis of two is deliberately left
    // to dockview (with two tiles "evenly" IS the neighbour). A nested seed also
    // squeezes tiles onto their 100px minimum, which is a different code path.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Session, FrameGroup } = pd;
        const names = ['c1', 'c2', 'c3'];
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = names.map((n, i) => new Camera(
            n, K, [0, 0, 0, 0, 0], [100 * (i + 1), 0, 0], [0.1 * (i + 1), 0.2, 0.3], [640, 480]));
        const s = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'SashTest');
        s.addFrameGroup(new FrameGroup(0));
        AS.state.sessions = [s];
        AS.state.activeSessionIdx = 0;
        AS.state.session = s;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;
        AS.state.fps = 30;
        AS.state.triangulationResults = new Map();
        AS.state.views = names.map(n => ({
            name: n, decoder: null, canvas: null, ctx: null,
            overlayCanvas: null, overlayCtx: null, videoWidth: 640, videoHeight: 480,
        }));
    });

    await page.evaluate(async () => {
        const M = await import('/ui/overlay-export-modal.js');
        M.showOverlayExportModal();
    });
    await page.waitForTimeout(2500);

    const widths = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('#ovDock [data-view-name]'))
            .map(el => ({ n: el.getAttribute('data-view-name'), r: el.getBoundingClientRect() }))
            .sort((a, b) => a.r.left - b.r.left)
            .map(t => ({ n: t.n, w: Math.round(t.r.width) })));

    const before = await widths();
    check(before.length === 4, `four tiles on one axis (got ${before.length}: ${before.map(t => t.n + ':' + t.w).join(' ')})`);
    // Preconditions this test rests on, asserted so it cannot silently stop testing
    // the thing it exists for:
    //  - 3+ leaves on the axis, since an axis of two is left to dockview on purpose;
    //  - all four side by side, i.e. genuinely ONE axis and not a nested grid;
    //  - nobody already on the 100px minimum, or the distribution has no room to move.
    check(before.length >= 3, 'at least three tiles, or the distribution is untestable');
    const lefts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#ovDock [data-view-name]'))
            .map(el => Math.round(el.getBoundingClientRect().left)));
    check(new Set(lefts).size === lefts.length,
        `all four tiles are on ONE horizontal axis, not a nested grid (lefts ${lefts.join(', ')})`);
    check(before.every(t => t.w > 130),
        `no tile starts pinned at its 100px minimum (widths ${before.map(t => t.w).join(', ')})`);

    const sash = await page.evaluate(() => {
        const s = document.querySelectorAll('#ovDock .dv-sash');
        if (!s.length) return null;
        const r = s[0].getBoundingClientRect();
        return { count: s.length, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    check(sash !== null && sash.count === 3, `three sashes between four tiles (got ${sash && sash.count})`);

    // ---- drag 1 -------------------------------------------------------------
    const D = 60;
    await page.mouse.move(sash.x, sash.y);
    await page.mouse.down();
    // Several steps: the handler recomputes from its pointerdown snapshot each
    // move, so an intermediate position must not accumulate.
    for (const f of [0.3, 0.6, 1.0]) await page.mouse.move(sash.x + D * f, sash.y);
    await page.mouse.up();
    await page.waitForTimeout(600);

    const after = await widths();
    const delta = after.map((t, i) => t.w - before[i].w);
    check(Math.abs(delta[0] - D) <= 3,
        `the tile dragged towards grew by the full ${D}px (got ${delta[0]})`);
    // THE assertion: every other tile absorbs an equal share. Pre-fix this reads
    // [+60, -60, 0, 0] and the last two checks fail.
    const share = -D / (before.length - 1);
    check(delta.slice(1).every(d => Math.abs(d - share) <= 3),
        `the other three each gave up ~${share.toFixed(0)}px (got ${delta.slice(1).join(', ')})`);
    check(delta.slice(1).every(d => d < -5),
        `the FAR tiles moved too — not just the adjacent one (got ${delta.slice(1).join(', ')})`);
    const sumBefore = before.reduce((a, t) => a + t.w, 0);
    const sumAfter = after.reduce((a, t) => a + t.w, 0);
    check(Math.abs(sumAfter - sumBefore) <= 3,
        `the axis total is unchanged, so the dock box did not drift (${sumBefore} -> ${sumAfter})`);

    // ---- drag 2: the composition must NOT snap back to equal -----------------
    // This is the regression that a naive "redistribute on layout change" fix
    // produces: every drag equalises everything and the dock becomes un-resizable.
    const sash2 = await page.evaluate(() => {
        const s = document.querySelectorAll('#ovDock .dv-sash');
        const r = s[2].getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(sash2.x, sash2.y);
    await page.mouse.down();
    await page.mouse.move(sash2.x + 40, sash2.y);
    await page.mouse.up();
    await page.waitForTimeout(600);

    const third = await widths();
    check(third[0].w > third[1].w + 20,
        `the first drag's asymmetry survived the second drag — the dock is still ` +
        `resizable, not equalised (widths ${third.map(t => t.n + ':' + t.w).join(' ')})`);
    const spread = Math.max(...third.map(t => t.w)) - Math.min(...third.map(t => t.w));
    check(spread > 20, `tiles are genuinely unequal after two drags (spread ${spread}px)`);

    // ---- drag 3: pulling an edge IN shrinks that tile, others grow evenly ----
    // The mirror direction. Before it existed every drag GREW one tile (a left drag
    // on sash k grew tile k+1), so "make this video smaller and share the room out"
    // was not expressible by any gesture. Same handle, opposite sign.
    const preShrink = await widths();
    const sash0 = await page.evaluate(() => {
        const r = document.querySelectorAll('#ovDock .dv-sash')[0].getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const S = 45;
    await page.mouse.move(sash0.x, sash0.y);
    await page.mouse.down();
    for (const f of [0.4, 0.8, 1.0]) await page.mouse.move(sash0.x - S * f, sash0.y);
    await page.mouse.up();
    await page.waitForTimeout(600);

    const postShrink = await widths();
    const sDelta = postShrink.map((t, i) => t.w - preShrink[i].w);
    check(Math.abs(sDelta[0] + S) <= 3,
        `pulling tile 0's edge in SHRANK it by ${S}px (got ${sDelta[0]})`);
    check(sDelta.slice(1).every(d => d > 5),
        `and the other three GREW rather than one of them absorbing it all (got ${sDelta.slice(1).join(', ')})`);
    const shrinkShare = S / (preShrink.length - 1);
    check(sDelta.slice(1).every(d => Math.abs(d - shrinkShare) <= 3),
        `each gained ~${shrinkShare.toFixed(0)}px, evenly (got ${sDelta.slice(1).join(', ')})`);
    check(Math.abs(postShrink.reduce((a, t) => a + t.w, 0) - preShrink.reduce((a, t) => a + t.w, 0)) <= 3,
        'the axis total still holds through a shrink');

    // ---- the export follows the new geometry --------------------------------
    // captureLayout() reads the live rects, so a stitched export must be sized from
    // the dock as it now stands. Proves the drag reached the output, not just CSS.
    const promised = await page.evaluate(async () => {
        const L = await import('/ui/overlay-export-layout.js');
        const dr = document.getElementById('ovDock').getBoundingClientRect();
        const el = document.getElementById('ovRes');
        el.value = '480';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        const dr2 = document.getElementById('ovDock').getBoundingClientRect();
        return L.outputSizeFor(dr2.width / dr2.height, '480');
    });
    await page.evaluate(() => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('ovMode', 'stitched');
    });
    await page.waitForTimeout(400);
    const dl = page.waitForEvent('download', { timeout: 120000 });
    await page.evaluate(() => {
        Array.from(document.querySelectorAll('button'))
            .find(b => /^Export/i.test(b.textContent.trim())).click();
    });
    const download = await dl;
    const fs = await import('node:fs/promises');
    const tmp = path.join(repoRoot, 'tests', 'e2e', `.tmp-sash-${process.pid}.mp4`);
    await download.saveAs(tmp);
    const buf = await fs.readFile(tmp);
    await fs.unlink(tmp).catch(() => {});
    const avcDims = (b) => {
        const needle = Buffer.from('avc1', 'latin1');
        for (let at = b.indexOf(needle); at >= 0; at = b.indexOf(needle, at + 1)) {
            const body = at + 4;
            if (body + 28 > b.length) break;
            if (!b.slice(body, body + 6).every(x => x === 0)) continue;
            if (b.readUInt16BE(body + 6) !== 1) continue;
            return { width: b.readUInt16BE(body + 24), height: b.readUInt16BE(body + 26) };
        }
        return null;
    };
    const dims = avcDims(buf);
    check(dims && dims.width === promised.width && dims.height === promised.height,
        `the export is sized from the resized dock (got ${dims && dims.width}x${dims && dims.height}, ` +
        `dock promised ${promised.width}x${promised.height})`);

    console.log('');
    check(errs.length === 0, 'no page errors / console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}

console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
