/**
 * settings-modal-geometry.mjs — the Settings modal is resizable, draggable and
 * remembers where it was left; the Tracking Wizard's tables grow instead of
 * scrolling inside a scroll.
 *
 * Two connected complaints. The card opened at a fixed 880x620 and could not be
 * made bigger, and inside it the Node Weights table was a 240px box with its own
 * `overflow-y: auto` — a scrollbar inside `.settings-panel-container`'s
 * scrollbar. The wheel did different things a few pixels apart, and rows past
 * the cap were invisible with no hint that the window could simply be made
 * taller, because it could not.
 *
 * So the fix has to be checked as one thing: the panel is the ONE scroller in
 * the card, the tables render every row, and widening the modal reflows them
 * into more columns (which is what actually makes a long skeleton fit).
 *
 * Run: node tests/e2e/settings-modal-geometry.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8257);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 300)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // An 18-node skeleton over 8 cameras: long enough that the old 240px cap hid
    // most of it, which is the condition the reporter was in.
    const NODE_COUNT = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Session } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const NODES = ['Nose', 'Ear_L', 'Ear_R', 'TTI', 'Head', 'TailTip', 'Trunk', 'Tail_0',
            'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right', 'Hand_left', 'Hand_right',
            'Hip_left', 'Hip_right', 'Foot_left', 'Foot_right'];
        const CAMS = ['back', 'backL', 'mid', 'midL', 'side', 'sideL', 'top', 'topL'];
        const cams = CAMS.map(n => new Camera(n, K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]));
        const session = new Session(cams, new Skeleton('sk', NODES, [[0, 1], [1, 2]]), ['track_0'], 'Wizard');
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 10;
        localStorage.removeItem('lucid.modalGeometry.v1');
        return NODES.length;
    });

    const openModal = () => page.evaluate(async () => {
        const m = await import('/ui/settings-modal.js');
        m.showSettingsModal('wizard');
        await new Promise(r => requestAnimationFrame(r));
        await new Promise(r => requestAnimationFrame(r));
    });
    const closeModal = () => page.evaluate(async () => {
        const btn = document.querySelector('.settings-btn-cancel');
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 60));
    });
    // Tolerates a missing card so a regression reports as failed assertions
    // rather than a crash that hides the ones after it.
    const rect = () => page.evaluate(() => {
        const card = document.querySelector('.settings-modal');
        if (!card) return { x: NaN, y: NaN, w: NaN, h: NaN, missing: true };
        const r = card.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    });

    // ---- 1. No scroll inside a scroll --------------------------------------
    await openModal();
    const scrollers = await page.evaluate(() => {
        const card = document.querySelector('.settings-modal');
        const out = [];
        card.querySelectorAll('*').forEach(function (el) {
            const cs = getComputedStyle(el);
            const scrollY = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
            if (scrollY && el.scrollHeight > el.clientHeight + 1) {
                out.push(el.className || el.tagName);
            }
        });
        return out;
    });
    check(scrollers.length === 1 && String(scrollers[0]).indexOf('settings-panel-container') >= 0,
        `exactly one thing in the card scrolls, and it is the panel (${JSON.stringify(scrollers)})`);

    const lists = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.settings-node-weight-list')).map(function (l) {
            const cs = getComputedStyle(l);
            return {
                overflowY: cs.overflowY,
                maxHeight: cs.maxHeight,
                clipped: l.scrollHeight > l.clientHeight + 1,
                rows: l.querySelectorAll('.settings-node-weight-row').length,
            };
        });
    });
    check(lists.length === 2, `both wizard tables present (${lists.length})`);
    check(lists.every(l => l.overflowY === 'visible' && l.maxHeight === 'none'),
        `neither table is a scroll box any more (${JSON.stringify(lists.map(l => [l.overflowY, l.maxHeight]))})`);
    check(lists.every(l => !l.clipped),
        `and neither clips its own content (${JSON.stringify(lists.map(l => l.clipped))})`);
    check(lists[0].rows === NODE_COUNT,
        `every one of the ${NODE_COUNT} skeleton nodes is rendered (got ${lists[0].rows})`);

    // ---- 2. The sections fold ----------------------------------------------
    const sections = await page.evaluate(() => Array.from(document.querySelectorAll('.settings-section'))
        .map(d => ({
            title: d.querySelector('.settings-section-title').textContent,
            count: d.querySelector('.settings-section-count') ? d.querySelector('.settings-section-count').textContent : null,
            open: d.open,
            tag: d.tagName,
        })));
    check(sections.length === 3 && sections.every(s => s.tag === 'DETAILS' && s.open),
        `three <details> sections, all open by default (${JSON.stringify(sections.map(s => [s.title, s.open]))})`);
    check(sections.length === 3 &&
        sections[0].count === String(NODE_COUNT) && sections[1].count === '8',
        `each carries its row count (${JSON.stringify(sections.map(s => s.count))})`);

    const folded = await page.evaluate(async () => {
        const panel = document.querySelector('.settings-panel-container');
        const d = document.querySelector('.settings-section');
        if (!d) return null;
        const before = panel.scrollHeight;
        d.querySelector('summary').click();
        await new Promise(r => requestAnimationFrame(r));
        return { before: before, after: panel.scrollHeight, open: d.open };
    });
    check(folded && folded.open === false && folded.after < folded.before,
        `folding Node Weights shortens the panel (${folded ? folded.before + ' -> ' + folded.after + 'px' : 'no foldable section'})`);
    await page.evaluate(() => {
        const sm = document.querySelector('.settings-section summary');
        if (sm) sm.click();
    });

    // ---- 3. Widening reflows the table into more columns --------------------
    const columnsAt = (w) => page.evaluate(async (width) => {
        const card = document.querySelector('.settings-modal');
        card.style.width = width + 'px';
        await new Promise(r => requestAnimationFrame(r));
        const list = document.querySelector('.settings-node-weight-list');
        // Count distinct row left-offsets — that IS the column count.
        const xs = new Set(Array.from(list.querySelectorAll('.settings-node-weight-row'))
            .map(r => Math.round(r.getBoundingClientRect().left)));
        return xs.size;
    }, w);
    const narrowCols = await columnsAt(880);
    const wideCols = await columnsAt(1300);
    check(wideCols > narrowCols,
        `widening the modal gives the table more columns (${narrowCols} at 880px -> ${wideCols} at 1300px)`);

    // ---- 4. Resizable, and the size is remembered ---------------------------
    const resizeStyle = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.settings-modal')).resize);
    check(resizeStyle === 'both', `the card carries a resize grip (resize: ${resizeStyle})`);

    await page.evaluate(async () => {
        const card = document.querySelector('.settings-modal');
        card.style.width = '1180px';
        card.style.height = '800px';
        await new Promise(r => setTimeout(r, 300));  // past the persist debounce
    });
    const sized = await rect();
    await closeModal();

    let stored = await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem('lucid.modalGeometry.v1')); } catch (e) { return null; }
    });
    check(stored && stored.settings && stored.settings.w === sized.w && stored.settings.h === sized.h,
        `the size is written to localStorage on close (${JSON.stringify(stored && stored.settings)})`);

    await openModal();
    let reopened = await rect();
    check(reopened.w === sized.w && reopened.h === sized.h,
        `reopening restores the size (${reopened.w}x${reopened.h}, wanted ${sized.w}x${sized.h})`);

    // ---- 5. Draggable by the header, and the position is remembered ---------
    const header = await page.evaluate(() => {
        const h = document.querySelector('.settings-modal-header');
        if (!h) return null;
        const r = h.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    check(!!header, 'the modal is open, with a header to drag by');
    const beforeDrag = await rect();
    await page.mouse.move(header ? header.x : 0, header ? header.y : 0);
    await page.mouse.down();
    await page.mouse.move((header ? header.x : 0) - 80, (header ? header.y : 0) - 30, { steps: 8 });
    await page.mouse.up();
    const afterDrag = await rect();
    check(afterDrag.x === beforeDrag.x - 80 && afterDrag.y === beforeDrag.y - 30,
        `dragging the header moves the card by exactly the pointer delta ` +
        `(${beforeDrag.x},${beforeDrag.y} -> ${afterDrag.x},${afterDrag.y})`);

    await closeModal();
    await openModal();
    reopened = await rect();
    check(reopened.x === afterDrag.x && reopened.y === afterDrag.y,
        `reopening restores the position too (${reopened.x},${reopened.y})`);

    // The × sits inside the drag handle; grabbing it must not start a drag.
    const beforeCloseDrag = await rect();
    const closeBox = await page.evaluate(() => {
        const el = document.querySelector('.settings-modal-close');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.move(closeBox ? closeBox.x : 0, closeBox ? closeBox.y : 0);
    await page.mouse.down();
    await page.mouse.move((closeBox ? closeBox.x : 0) - 60, (closeBox ? closeBox.y : 0) + 40, { steps: 6 });
    const duringCloseDrag = await rect();
    await page.mouse.up();
    check(duringCloseDrag.x === beforeCloseDrag.x && duringCloseDrag.y === beforeCloseDrag.y,
        `dragging from the × does not move the card (${duringCloseDrag.x},${duringCloseDrag.y})`);
    await page.evaluate(() => {
        const o = document.querySelector('.settings-overlay');
        if (o) o.remove();
    });

    // ---- 6. A remembered rect is clamped back into a smaller window ---------
    await page.evaluate(() => {
        localStorage.setItem('lucid.modalGeometry.v1',
            JSON.stringify({ settings: { x: 2400, y: 1300, w: 2000, h: 1400 } }));
    });
    await openModal();
    const clamped = await rect();
    const vp = page.viewportSize();
    check(clamped.x >= 0 && clamped.y >= 0 &&
        clamped.x + clamped.w <= vp.width + 1 && clamped.y + clamped.h <= vp.height + 1,
        `a rect remembered from a bigger screen is pulled fully back into view ` +
        `(${JSON.stringify(clamped)} in ${vp.width}x${vp.height})`);
    await closeModal();

    check(errs.length === 0, `no page/console errors (got ${JSON.stringify(errs)})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
