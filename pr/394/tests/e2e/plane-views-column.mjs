/**
 * plane-views-column.mjs — the Planes table says how much of the 2D work is
 * done, and nothing else.
 *
 * The row used to carry three unlabelled marks besides the name:
 *
 *   ▸ 8   Ground   5 +4   3D   ✕
 *
 * and a user reading it could not tell what any of them meant. `+4` looked like
 * an addition (`4 +4` on a four-cornered wall reads as nine) when it meant "of
 * which 4 are shared"; `3D` was two letters in a box in a column with no header;
 * and the mono `8` beside the caret was a THIRD view count with nothing saying
 * it was the placed one.
 *
 * All three are gone, replaced by one column that answers the question a user
 * actually has while annotating: **how many views have I done?**
 *
 *   ▸   Ground   5   2/4   ✕
 *
 * The distinction that makes it worth having is ANNOTATED vs PLACED.
 * `Triangulate` reprojects a plane into the views it was never placed on, so
 * afterwards it is placed everywhere; those corners are the solve's own output
 * and are excluded from the next solve as evidence. Counting them would make
 * the fraction read full the moment you triangulate and never say anything
 * again — so §3 places a plane on a third view with ONLY derived corners and
 * asserts the count does not move. That case is the whole point of the column.
 *
 * Run: node plane-views-column.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8249);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // A FOUR-camera session, so the denominator is not the same number as
    // anything else on the row and a wrong one cannot pass by coincidence.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Camera, Session, Skeleton } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = ['camA', 'camB', 'camC', 'camD'].map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.25 * i, 0], [25 * i, 0, 0], [640, 480]));
        const session = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'S1');
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 10;
        AS.state.views = cams.map(c => ({
            name: c.name, videoWidth: 640, videoHeight: 480, canvas: null,
        }));
    });

    const row = () => page.evaluate(() => {
        const tr = document.querySelector('#planeSkeletonsTable tbody tr');
        if (!tr) return null;
        return {
            cells: [...tr.children].map(td => td.textContent.trim()),
            views: tr.children[3] ? tr.children[3].textContent.trim() : null,
            viewsTitle: tr.children[3] ? tr.children[3].getAttribute('title') : null,
            nodesTitle: tr.children[2] ? tr.children[2].getAttribute('title') : null,
        };
    });
    const headers = () => page.evaluate(() =>
        [...document.querySelectorAll('#planeSkeletonsTable thead th')].map(th => th.textContent.trim()));

    // =========================================================
    console.log('\n--- 1. The three unlabelled marks are gone ---');
    // =========================================================
    await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        if (!P.planeState.active) P.togglePlaneMode();
        for (const n of ['c1', 'c2', 'c3', 'c4']) {
            document.getElementById('planeNodeNameInput').value = n;
            document.getElementById('btnAddPlaneNode').click();
        }
        const model = P.planeModel();
        const ground = P.createPlane('Ground');
        const wall = P.createPlane('right wall');
        // Every node in BOTH planes, so every one of them is shared — the
        // state that used to render "4 +4".
        model.pool.nodes.forEach(nd => { ground.addNode(nd.id); wall.addNode(nd.id); });
        P.refreshPlanePanel();
    });
    await page.waitForTimeout(300);

    const marks = await page.evaluate(() => ({
        shared: document.querySelectorAll('#planeSkeletonsTable .plane-shared-count').length,
        solved: document.querySelectorAll('#planeSkeletonsTable .plane-solved-badge').length,
        placedCount: document.querySelectorAll('#planeSkeletonsTable .plane-placed-count').length,
        caret: document.querySelectorAll('#planeSkeletonsTable .plane-caret').length,
        expanderText: (() => {
            const b = document.querySelector('#planeSkeletonsTable .plane-expander');
            return b ? b.textContent.trim() : null;
        })(),
    }));
    check(marks.shared === 0, 'no "+N" shared-node badge — "4 +4" read as nine');
    check(marks.solved === 0, 'no "3D" badge');
    check(marks.placedCount === 0, 'no bare placed-view count beside the caret');
    check(marks.caret === 2, 'the caret itself survives, one per row');
    check(marks.expanderText === '▶',
        'and the expander is the caret and nothing else: ' + JSON.stringify(marks.expanderText));

    // The shared count is not lost, it moved into words.
    const r0 = await row();
    check(/4 of them shared/.test(r0.nodesTitle || ''),
        'the Nodes cell still says how many are shared, in words: ' +
        JSON.stringify(r0.nodesTitle));

    // =========================================================
    console.log('\n--- 2. The Views column counts HAND-PLACED views ---');
    // =========================================================
    const hdr = await headers();
    check(hdr.length === 5, 'the table has five columns');
    check(/^Views/.test(hdr[3]), 'the fourth is Views: ' + JSON.stringify(hdr[3]));

    check(r0.views === '0/4',
        'a plane placed nowhere is 0 of the session\'s 4 views (got ' + r0.views + ')');

    // Place Ground on two views and hand-place its corners there.
    await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const ground = model.planes[0];
        // The real drop path: `placePlane` with a drop point seeds a ring of
        // hand-placed corners, exactly as dragging the row onto a view does.
        ['camA', 'camB'].forEach((cam, v) => {
            model.placePlane(ground, cam, 300 + v * 20, 240, 640, 480);
        });
        P.refreshPlanePanel();
    });
    await page.waitForTimeout(250);
    const r1 = await row();
    check(r1.views === '2/4', 'annotating it on two views reads 2/4 (got ' + r1.views + ')');
    check(/Hand-annotated on 2 of 4/.test(r1.viewsTitle || ''),
        'and the cell says so in words: ' + JSON.stringify(r1.viewsTitle));

    // =========================================================
    console.log('\n--- 3. A REPROJECTED view does not count ---');
    // =========================================================
    // The case the whole column exists for. Place the plane on a third view
    // whose corners are all derived — the shape Triangulate leaves behind —
    // and the fraction must not move.
    const derived = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const ground = model.planes[0];
        model.placePlane(ground, 'camC', 320, 240, 640, 480);
        const inst = model.getInstance('camC');
        model.pool.nodes.forEach((nd, i) => inst.setNodeDerived(i, true));
        P.refreshPlanePanel();
        return {
            placed: model.placedViews(ground).length,
            allDerived: model.pool.nodes.every((nd, i) => inst.isNodeDerived(i)),
        };
    });
    check(derived.allDerived === true, 'camC\'s corners are all marked derived');
    check(derived.placed === 3, 'and the plane IS placed on three views now');
    const r2 = await row();
    check(r2.views === '2/4',
        'but the fraction stays 2/4 — a reprojected corner is the solve\'s own ' +
        'output, not annotation (got ' + r2.views + ')');

    // Drag one of those corners and it becomes real annotation.
    await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        model.getInstance('camC').setNodeDerived(0, false);
        P.refreshPlanePanel();
    });
    await page.waitForTimeout(200);
    check((await row()).views === '3/4',
        'un-deriving ONE corner there makes the view count — the same test ' +
        '`triangulatePlane` uses to pick contributing views');

    // =========================================================
    console.log('\n--- 4. No calibration means no denominator to report ---');
    // =========================================================
    const noCal = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const P = await import('/ui/plane-definition.js');
        const keep = AS.state.session;
        AS.state.session = null;
        P.refreshPlanePanel();
        const tr = document.querySelector('#planeSkeletonsTable tbody tr');
        const out = {
            views: tr.children[3].textContent.trim(),
            title: tr.children[3].getAttribute('title'),
        };
        AS.state.session = keep;
        P.refreshPlanePanel();
        return out;
    });
    check(noCal.views === '—',
        'a dash, not "0/0" — there are no views to have annotated (got ' +
        JSON.stringify(noCal.views) + ')');
    check(/No calibration/.test(noCal.title || ''), 'and the tooltip says why');

    // =========================================================
    console.log('\n--- 5. The column explains itself in an ⓘ ---');
    // =========================================================
    const info = await page.evaluate(() => {
        const el = document.getElementById('planeViewsInfo');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return {
            text: el.dataset.infotip || '',
            title: el.getAttribute('title'),
            aria: el.getAttribute('aria-label'),
            hasIcon: !!el.querySelector('svg'),
            inHeader: !!el.closest('th'),
            w: b.width, h: b.height,
        };
    });
    check(info !== null, 'the Views header has an ⓘ');
    check(info.inHeader === true, 'in the header cell itself');
    check(info.hasIcon === true, 'drawn with the ⓘ glyph');
    check(info.w > 0 && info.h > 0, 'and it has a box to hover');
    check(/hand-annotated/i.test(info.text), 'whose text defines the fraction');
    // Deliberately ONE sentence. A tip long enough to need reading is a tip
    // nobody reads, and this one covers a table column, not a whole feature.
    // The reprojected-corners caveat lives on the CELL's tooltip, beside the
    // number it qualifies, and is pinned by §2 and §3 as behaviour.
    check(info.text.length < 120,
        'and stays short — ' + info.text.length + ' chars: ' + JSON.stringify(info.text));
    check((info.text.match(/\./g) || []).length <= 1, 'one sentence, not a paragraph');
    check(info.title === null, 'with no native title to say it a second time');
    check(!!info.aria, 'while aria-label keeps it reachable');

    // Scroll the header up the panel before hovering. Left where this synthetic
    // session puts it, the Planes table sits at the very bottom of the panel,
    // under the timeline's resize handle — the pointer would land on the handle
    // and the section would fail for a reason that has nothing to do with the ⓘ.
    const box = await page.evaluate(() => {
        const th = document.getElementById('planeViewsInfo').closest('th');
        th.scrollIntoView({ block: 'center' });
        const b = document.getElementById('planeViewsInfo').getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    await page.waitForTimeout(150);
    const onTop = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return !!(el && el.closest && el.closest('#planeViewsInfo'));
    }, [box.x + box.w / 2, box.y + box.h / 2]);
    check(onTop === true, 'the ⓘ is the topmost element at its own centre');
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
    await page.waitForTimeout(200);
    const shown = await page.evaluate(() => {
        const t = document.getElementById('infoTip');
        return t && !t.hidden ? t.textContent : null;
    });
    check(shown !== null && /hand-annotated/i.test(shown), 'hovering it shows the tip');
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2 + 300);
    await page.waitForTimeout(200);
    check((await page.evaluate(() => document.getElementById('infoTip').hidden)) === true,
        'and leaving puts it away');

    // =========================================================
    console.log('\n--- 6. The header fits — no ellipsis ---');
    // =========================================================
    // `table-layout: fixed` means a `<th>` narrower than its text silently
    // becomes "VIEWS…", and the ⓘ costs 19px the word does not know about.
    const fit = await page.evaluate(() => {
        const ths = [...document.querySelectorAll('#planeSkeletonsTable thead th')];
        return ths.map(th => ({
            text: th.textContent.trim(),
            clipped: th.scrollWidth > th.clientWidth + 1,
        }));
    });
    fit.forEach(f => {
        if (!f.text) return;
        check(f.clipped === false, `the "${f.text}" header is not clipped`);
    });

    console.log(`\n${fails === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${fails} CHECK(S) FAILED`}`);
} catch (e) {
    console.error('FATAL', e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
