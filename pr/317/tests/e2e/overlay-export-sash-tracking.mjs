/**
 * overlay-export-sash-tracking.mjs — the two properties of the composition dock's
 * resize gesture that `overlay-export-sash-distribute.mjs` structurally CANNOT see.
 *
 * That file drags sash 0 of a flat axis, where "share with the far side" and "share
 * with every tile" are the same arithmetic — every tile is beyond sash 0. So it went
 * green while the shipped gesture had two defects a user hit immediately:
 *
 *  1. THE HANDLE DID NOT FOLLOW THE CURSOR. A sash sits at the running sum of the
 *     sizes before it, so a mode that also shrinks the tiles BEFORE the sash slides
 *     the handle out from under the pointer. Measured on a 4-tile axis with an 80px
 *     drag: the sash moved 80 / 53 / 26 px for sash 0 / 1 / 2 — 100% / 66% / 33%
 *     tracking. The sizes were right and it still read as broken. Only sash 0 tracked,
 *     which is exactly the sash the other test drags.
 *
 *  2. ROW DIVIDERS MOVED ONE COLUMN. dockview nests a 4+ camera grid column-major, so
 *     row heights are per-column and independent: dragging a row divider left the
 *     other columns where they were and the grid drifted ragged, with no gesture
 *     anywhere able to straighten it. Needs 5 cameras to reproduce; the other test
 *     deliberately uses 3 and asserts the axis is FLAT, so it can never reach this.
 *
 * Both are geometric, so they are asserted as arithmetic on measured pixels rather
 * than by eye.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8151);

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

    const seedAndOpen = async (n) => {
        await page.goto(`http://localhost:${PORT}/index.html`);
        await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
        await page.evaluate(async (cams) => {
            const pd = await import('/pose/pose-data.js');
            const AS = await import('/ui/app-state.js');
            const { Skeleton, Camera, Session, FrameGroup } = pd;
            const names = Array.from({ length: cams }, (_, i) => 'c' + (i + 1));
            const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
            const list = names.map((nm, i) => new Camera(
                nm, K, [0, 0, 0, 0, 0], [100 * (i + 1), 0, 0], [0.1 * (i + 1), 0.2, 0.3], [640, 480]));
            const s = new Session(list, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'TrackTest');
            s.addFrameGroup(new FrameGroup(0));
            AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
            AS.state.totalFrames = 1; AS.state.currentFrame = 0; AS.state.fps = 30;
            AS.state.triangulationResults = new Map();
            AS.state.views = names.map(nm => ({
                name: nm, decoder: null, canvas: null, ctx: null,
                overlayCanvas: null, overlayCtx: null, videoWidth: 640, videoHeight: 480,
            }));
        }, n);
        await page.evaluate(async () => {
            const M = await import('/ui/overlay-export-modal.js');
            M.showOverlayExportModal();
        });
        await page.waitForTimeout(2500);
    };

    // Tiles keyed by view name, so a nested grid can be reasoned about by row/column
    // instead of by DOM order.
    const tiles = () => page.evaluate(() => {
        const out = {};
        document.querySelectorAll('#ovDock [data-view-name]').forEach(el => {
            const r = el.getBoundingClientRect();
            out[el.getAttribute('data-view-name')] = {
                x: Math.round(r.left), y: Math.round(r.top),
                w: Math.round(r.width), h: Math.round(r.height),
            };
        });
        return out;
    });

    const sashAt = (i) => page.evaluate((idx) => {
        const el = document.querySelectorAll('#ovDock .dv-sash')[idx];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
            vertical: r.height > r.width,
            cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
            len: Math.round(r.height > r.width ? r.height : r.width),
        };
    }, i);

    // Grab OFF-CENTRE along the bar: a full-length sash's exact midpoint can land on a
    // crossing where a perpendicular sash wins the hit-test (a dockview quirk, not ours).
    const dragSash = async (i, d) => {
        const s = await sashAt(i);
        if (!s) return null;
        const gx = s.vertical ? s.cx : s.cx - Math.round(s.len * 0.25);
        const gy = s.vertical ? s.cy - Math.round(s.len * 0.25) : s.cy;
        await page.mouse.move(gx, gy);
        await page.mouse.down();
        // Several steps: the handler recomputes from its pointerdown snapshot each move,
        // so intermediate positions must not accumulate.
        for (const f of [0.25, 0.5, 0.75, 1.0]) {
            await page.mouse.move(s.vertical ? gx + d * f : gx, s.vertical ? gy : gy + d * f);
        }
        await page.mouse.up();
        await page.waitForTimeout(400);
        const after = await sashAt(i);
        return { before: s, after, moved: s.vertical ? after.cx - s.cx : after.cy - s.cy };
    };

    // ---- 1. the handle tracks the cursor on EVERY sash -----------------------
    console.log('\n-- flat axis of four: does the handle follow the cursor? --');
    const D = 80;
    const order = ['c1', 'c2', 'c3', '__3d__'];
    for (const k of [0, 1, 2]) {
        await seedAndOpen(3);
        const nSash = await page.evaluate(() => document.querySelectorAll('#ovDock .dv-sash').length);
        if (k === 0) check(nSash === 3, `three sashes between four tiles (got ${nSash})`);
        const before = await tiles();
        const r = await dragSash(k, D);
        const after = await tiles();

        check(r !== null && Math.abs(r.moved - D) <= 3,
            `sash ${k}: dragged ${D}px, handle moved ${r && r.moved}px — stays under the cursor`);
        check(Math.abs((after[order[k]].w - before[order[k]].w) - D) <= 3,
            `sash ${k}: the dragged tile changed 1:1 (got ${after[order[k]].w - before[order[k]].w})`);
        // The tiles BEFORE the sash are what must not move — that is the same statement
        // as the handle tracking, checked independently on the pixels.
        for (let j = 0; j < k; j++) {
            check(Math.abs(after[order[j]].w - before[order[j]].w) <= 2,
                `sash ${k}: tile ${order[j]} (before the sash) did not move`);
        }
        // …and everything beyond it shares, evenly, whenever there is more than one.
        const far = order.slice(k + 1);
        const shares = far.map(nm => after[nm].w - before[nm].w);
        check(shares.every(s => s < -2), `sash ${k}: every tile beyond it gave room (${shares.join(', ')})`);
        if (far.length > 1) {
            check(Math.max(...shares) - Math.min(...shares) <= 3,
                `sash ${k}: they gave EQUAL shares (${shares.join(', ')})`);
        }
        const sumBefore = order.reduce((a, nm) => a + before[nm].w, 0);
        const sumAfter = order.reduce((a, nm) => a + after[nm].w, 0);
        check(Math.abs(sumAfter - sumBefore) <= 3, `sash ${k}: axis total held (${sumBefore} -> ${sumAfter})`);
    }

    // ---- 2. a row divider moves the whole row, across every column -----------
    console.log('\n-- 5 cameras (nested grid): does a row divider keep the grid straight? --');
    await seedAndOpen(5);
    const g0 = await tiles();
    // Preconditions, so this cannot silently stop testing the grid.
    check(Object.keys(g0).length === 6, `six tiles (5 cameras + 3D), got ${Object.keys(g0).length}`);
    const rows = new Set(Object.values(g0).map(t => t.y));
    check(rows.size === 2, `the seed really is a 2-ROW grid, not a flat axis (distinct tops: ${rows.size})`);
    check(g0.c1.y < g0.c4.y && g0.c2.y < g0.c5.y,
        'c1/c4 and c2/c5 are stacked, i.e. two columns of two');
    check(g0.c3.h > g0.c1.h + 100 && g0.__3d__.h > g0.c1.h + 100,
        'c3 and the 3D tile span the FULL height — they have no row boundary to move');

    // The horizontal sashes are the row dividers; find the first one.
    const hIdx = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('#ovDock .dv-sash'));
        return all.findIndex(el => {
            const r = el.getBoundingClientRect();
            return r.width > r.height;
        });
    });
    check(hIdx >= 0, `found a horizontal row divider (sash #${hIdx})`);

    const R = 80;
    const rr = await dragSash(hIdx, R);
    const g1 = await tiles();
    check(rr !== null && Math.abs(rr.moved - R) <= 3,
        `the row divider tracks the cursor too (dragged ${R}, moved ${rr && rr.moved})`);
    // THE assertion: before the fix this read c1:+80 c4:-80 with c2/c5 untouched.
    check(Math.abs((g1.c1.h - g0.c1.h) - R) <= 3, `c1 grew by ${R} (got ${g1.c1.h - g0.c1.h})`);
    check(Math.abs((g1.c2.h - g0.c2.h) - R) <= 3,
        `c2 — a DIFFERENT column — grew by the same ${R} (got ${g1.c2.h - g0.c2.h})`);
    check(Math.abs((g1.c4.h - g0.c4.h) + R) <= 3, `c4 gave up ${R} (got ${g1.c4.h - g0.c4.h})`);
    check(Math.abs((g1.c5.h - g0.c5.h) + R) <= 3,
        `c5 gave up the same ${R}, so the row stayed straight (got ${g1.c5.h - g0.c5.h})`);
    check(g1.c1.h === g1.c2.h && g1.c4.h === g1.c5.h,
        `the grid is still ALIGNED: top row ${g1.c1.h}/${g1.c2.h}, bottom ${g1.c4.h}/${g1.c5.h}`);
    // Full-height tiles must be left alone rather than split by a boundary they lack.
    check(Math.abs(g1.c3.h - g0.c3.h) <= 2 && Math.abs(g1.__3d__.h - g0.__3d__.h) <= 2,
        'the full-height c3 and 3D tiles were untouched');
    // Widths must not drift: this gesture is purely vertical.
    check(['c1', 'c2', 'c3', '__3d__', 'c4', 'c5'].every(nm => Math.abs(g1[nm].w - g0[nm].w) <= 2),
        'no width changed — a row drag stays on its own axis');

    // ---- 3. a column divider still resizes columns, not single videos --------
    // Guards the propagation from over-reaching: the ROOT axis has no siblings, so a
    // column drag must move the whole column (both its videos) and nothing else.
    const vIdx = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('#ovDock .dv-sash'));
        return all.findIndex(el => {
            const r = el.getBoundingClientRect();
            return r.height > r.width;
        });
    });
    const g2before = await tiles();
    const vr = await dragSash(vIdx, 60);
    const g2 = await tiles();
    check(vr !== null && Math.abs(vr.moved - 60) <= 3,
        `a column divider tracks the cursor (moved ${vr && vr.moved})`);
    check(Math.abs((g2.c1.w - g2before.c1.w) - 60) <= 3 && Math.abs((g2.c4.w - g2before.c4.w) - 60) <= 3,
        `both videos in column 1 widened together (c1 ${g2.c1.w - g2before.c1.w}, c4 ${g2.c4.w - g2before.c4.w})`);
    check(['c1', 'c2', 'c3', '__3d__', 'c4', 'c5'].every(nm => Math.abs(g2[nm].h - g2before[nm].h) <= 2),
        'no height changed — the row propagation did not fire on a column drag');

    console.log('');
    check(errs.length === 0, 'no page errors / console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}

console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
