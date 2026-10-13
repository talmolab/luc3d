/**
 * identity-gallery.mjs — the Track All summary's Identities section
 * (ui/identity-gallery.js, in ui/track-summary-modal.js), in the real app.
 *
 * Fixture: two animals tracked by the REAL tracker over three calibrated
 * cameras, 65 s at 30 fps. The "videos" are stand-in decoders that paint each
 * animal as a disc of its own colour (animal 0 red, animal 1 green) where its
 * keypoints are, so what a sample image shows is checkable by its pixels.
 * Asserted:
 *  1. Track All's summary has one row per identity, named, with five sample
 *     images, each captioned with its time and spread over the recording (one
 *     per fifth), from more than one camera.
 *  2. Every image in a row shows THAT row's animal (its centre pixel is one
 *     disc colour throughout), and the two rows show different animals.
 *  3. A map per row: its path drawn, a view selector listing the three cameras
 *     with a time key; choosing another camera redraws the maps and is kept for
 *     the session.
 *  3b. Resting the pointer on a sample shows it enlarged (320 px) beside the
 *     tile, inside the window, with the same animal and a caption naming the
 *     identity, time and camera; leaving hides it, and no native tooltip
 *     doubles it. Closing the box takes the preview with it.
 *  4. Clicking a sample closes the box and goes to its frame; so does clicking a
 *     point on a map (to a frame on that identity's path).
 *  5. Negative control — the identities swapped for the second half of the
 *     recording (an ID switch): the reopened summary's rows each show BOTH
 *     animals. This is what the section is for.
 *  6. Without videos the images say "no video" and the maps still draw the paths
 *     — and resting on one shows no preview.
 *
 * Run: node tests/e2e/identity-gallery.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8298);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('dialog', d => d.accept('2'));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    await page.evaluate(() => {
        // Fixture A of track-all-summary.mjs, plus stand-in videos: a black frame with a disc per
        // animal at the mean of its projected keypoints (animal 0 red, animal 1 green).
        window.__build = async (name, opts) => {
            opts = opts || {};
            const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
            const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
                'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
            const T = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
                Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
                Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
                Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
            const cam = (n, rvec, tvec) => new pd.Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
            const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
            const s = new pd.Session(CAMS, new pd.Skeleton('mouse', NODES, []), ['track_0', 'track_1'], name);
            const FRAMES = 65 * 30, SC = [0.05, 0.06];
            const truth = new Map(CAMS.map(c => [c.name, new Float32Array(FRAMES * 4)]));
            for (let f = 0; f < FRAMES; f++) {
                const fg = new pd.FrameGroup(f);
                [[-8, 0, 48], [8, 0, 48]].forEach((c0, ai) => {
                    const ctr = [c0[0] + 0.6 * Math.sin(f / 90 + ai), c0[1] + 0.6 * Math.cos(f / 70 + ai), c0[2]];
                    const h = f / 200 + ai * 2, ch = Math.cos(h), sh = Math.sin(h);
                    const pts3 = NODES.map(n => { const [x, y, z] = T[n].map(v => v * SC[ai]); return [ctr[0] + ch * x - sh * y, ctr[1] + sh * x + ch * y, ctr[2] + z]; });
                    CAMS.forEach(c => {
                        const pts2 = pts3.map(p => c.project(p));
                        fg.addInstance(c.name, new pd.Instance(pts2, ai, 'predicted', 1.0));
                        const t = truth.get(c.name);
                        t[f * 4 + 2 * ai] = pts2.reduce((a, p) => a + p[0], 0) / pts2.length;
                        t[f * 4 + 2 * ai + 1] = pts2.reduce((a, p) => a + p[1], 0) / pts2.length;
                    });
                });
                s.addFrameGroup(fg);
            }
            const decoder = (camName) => ({
                samples: { length: FRAMES },
                getFrame: async (f) => {
                    const cv = new OffscreenCanvas(640, 480), ctx = cv.getContext('2d'), t = truth.get(camName);
                    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 640, 480);
                    [['#ff0000', 0], ['#00ff00', 1]].forEach(([col, ai]) => {
                        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(t[f * 4 + 2 * ai], t[f * 4 + 2 * ai + 1], 45, 0, 2 * Math.PI); ctx.fill();
                    });
                    return cv.transferToImageBitmap();
                },
            });
            AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
            AS.state.totalFrames = FRAMES; AS.state.currentFrame = 0; AS.state.fps = 30;
            AS.state.views = opts.noVideo ? [] : CAMS.map(c => ({ name: c.name, decoder: decoder(c.name), videoWidth: 640, videoHeight: 480 }));
            AS.state.triangulationResults = new Map();
            if (AS.timeline) { AS.timeline.setTotalFrames(FRAMES); AS.timeline.setData(s); }
            return FRAMES;
        };
        // What the section shows: per row, each image's frame, camera, caption and centre-pixel colour.
        window.__colorAt = (c) => {
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let red = 0, green = 0;
            for (let i = 0; i < d.length; i += 4) { if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) red++; else if (d[i + 1] > 200 && d[i] < 60 && d[i + 2] < 60) green++; }
            const total = c.width * c.height;
            return red > 0.05 * total && red > 3 * green ? "red" : green > 0.05 * total && green > 3 * red ? "green" : "other";
        };
        // The hover preview, if shown: where it is, what it shows, and the tile it is for.
        window.__zoom = () => {
            const z = document.getElementById('identityGalleryZoom');
            if (!z || getComputedStyle(z).display === 'none') return null;
            const r = z.getBoundingClientRect(), c = z.querySelector('canvas'), cr = c.getBoundingClientRect();
            return { frame: +z.dataset.frame, caption: z.querySelector('.identity-gallery-zoom-caption').textContent,
                inOverlay: !!z.closest('#trackSummaryOverlay'), size: Math.round(cr.width), color: window.__colorAt(c),
                rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, vw: innerWidth, vh: innerHeight };
        };
        window.__gallery = () => {
            const g = document.getElementById('identityGallery');
            if (!g) return null;
            // the disc colour covering most of the image (the keypoint dots are a few pixels)
            const colorAt = window.__colorAt;
            return {
                view: (document.getElementById('identityGalleryView') || {}).value,
                options: Array.from(document.querySelectorAll('#identityGalleryView option')).map(o => o.value),
                key: !!g.querySelector('.identity-gallery-key-bar'),
                rows: Array.from(g.querySelectorAll('.identity-gallery-row')).map(r => ({
                    id: r.dataset.identity, name: r.querySelector('.identity-gallery-name').textContent,
                    tiles: Array.from(r.querySelectorAll('.identity-gallery-tile')).map(t => {
                        const c = t.querySelector('canvas');
                        return { frame: +t.dataset.frame, camera: t.dataset.camera, caption: t.querySelector('figcaption').textContent,
                            color: c ? colorAt(c) : null, blank: (t.querySelector('.identity-gallery-blank') || {}).textContent || '' };
                    }),
                    mapPoints: +((r.querySelector('.identity-gallery-map canvas') || { dataset: {} }).dataset.points || 0),
                })),
            };
        };
    });
    const settled = () => page.waitForFunction(() => {
        const g = document.getElementById('identityGallery');
        return g && g.querySelectorAll('.identity-gallery-tile.is-pending').length === 0 && g.querySelectorAll('.identity-gallery-map canvas').length > 0;
    }, null, { timeout: 30000 });

    // ---- 1. + 2. Track All -> one row per identity, five images of its own animal ----------
    const FRAMES = await page.evaluate(async () => { const n = await window.__build('A'); (await import('/pose/tracker.js')).setTrackerNumAnimals(2); return n; });
    await page.click('#tbTrackAll');
    await page.waitForSelector('#trackSummaryOverlay', { timeout: 60000 });
    await settled();
    let g = await page.evaluate(() => window.__gallery());
    check(g && g.rows.length === 2 && g.rows.map(r => r.name).join(',') === 'id_0,id_1', `one row per identity: ${g && g.rows.map(r => r.name)}`);
    for (const r of g.rows) {
        const fr = r.tiles.map(t => t.frame);
        check(r.tiles.length === 5 && r.tiles.every(t => t.color && t.color !== 'other'), `${r.name}: five images drawn (${r.tiles.map(t => t.color)})`);
        check(fr.every((f, i) => f >= FRAMES * i / 5 - 1 && f < FRAMES * (i + 1) / 5 + 1), `${r.name}: one per fifth of the recording (${fr})`);
        check(r.tiles.every(t => /^\d+:\d\d$/.test(t.caption)), `${r.name}: each captioned with its time (${r.tiles.map(t => t.caption)})`);
        check(new Set(r.tiles.map(t => t.camera)).size >= 2, `${r.name}: from more than one camera (${r.tiles.map(t => t.camera)})`);
        check(new Set(r.tiles.map(t => t.color)).size === 1, `${r.name}: every image shows the same animal (${r.tiles[0].color})`);
    }
    check(g.rows[0].tiles[0].color !== g.rows[1].tiles[0].color, 'the two rows show different animals');

    // ---- 3. maps, the view selector, the key ----------------------------------------------
    check(g.rows.every(r => r.mapPoints > 100), `a path drawn on every row's map (${g.rows.map(r => r.mapPoints)} points)`);
    check(JSON.stringify(g.options) === JSON.stringify(['c0', 'c1', 'c2']) && g.options.includes(g.view) && g.key,
        `a view selector with the three cameras (on ${g.view}) and a time key`);
    const other = g.options.find(o => o !== g.view);
    const before = await page.evaluate(() => document.querySelector('.identity-gallery-map canvas').toDataURL());
    await page.selectOption('#identityGalleryView', other);
    await page.waitForFunction((b) => { const c = document.querySelector('.identity-gallery-map canvas'); return c && c.toDataURL() !== b; }, before, { timeout: 10000 });
    check(true, `choosing ${other} redraws the maps`);
    check(await page.evaluate(() => window.__lucid.state.session._galleryView), `…and is kept for the session`);

    // ---- 3b. resting on a sample enlarges it ---------------------------------------------------
    const tileSel = (row, n) => `#identityGallery .identity-gallery-row[data-identity="${g.rows[row].id}"] .identity-gallery-tile:nth-of-type(${n})`;
    check(await page.evaluate(() => Array.from(document.querySelectorAll('#identityGallery .identity-gallery-tile')).every(t => !t.title)),
        'a drawn sample has no native tooltip (the preview says it)');
    check(await page.evaluate(() => window.__zoom()) === null, 'no preview before the pointer rests on a sample');
    await page.hover(tileSel(0, 2));
    let z = await page.evaluate(() => window.__zoom());
    const t02 = g.rows[0].tiles[1];
    const tileBox = await page.$eval(tileSel(0, 2), e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
    check(z && z.inOverlay && z.size === 320, `resting on a sample shows it enlarged, 320 px, in the summary's overlay (${z && z.size})`);
    check(z && z.frame === t02.frame && z.color === t02.color, `…the same sample: frame ${z && z.frame} (tile ${t02.frame}), animal ${z && z.color} (tile ${t02.color})`);
    check(z && z.caption.includes(g.rows[0].name) && z.caption.includes(t02.caption) && z.caption.includes(t02.camera),
        `…captioned with identity, time and camera ("${z && z.caption}")`);
    check(z && (z.rect.left >= tileBox.right || z.rect.right <= tileBox.left) && z.rect.left >= 0 && z.rect.right <= z.vw && z.rect.top >= 0 && z.rect.bottom <= z.vh,
        '…beside the tile, not over it, and inside the window');
    await page.hover(tileSel(1, 5));
    z = await page.evaluate(() => window.__zoom());
    check(z && z.frame === g.rows[1].tiles[4].frame && z.color === g.rows[1].tiles[4].color, `moving to another sample shows that one (${z && z.frame})`);
    await page.mouse.move(5, 5);
    check(await page.evaluate(() => window.__zoom()) === null, 'leaving the sample hides the preview');
    await page.hover(tileSel(0, 1));
    await page.keyboard.press('Escape');
    check(!(await page.$('#trackSummaryOverlay')) && !(await page.$('#identityGalleryZoom')), 'closing the box takes the preview with it');
    await page.evaluate(async () => (await import('/ui/track-summary-modal.js')).reopenTrackSummary(window.__lucid.state.session));
    await settled();

    // ---- 4. a click on a sample, and on a map point, goes there -----------------------------
    const target = g.rows[1].tiles[2].frame;
    await page.click(`#identityGallery .identity-gallery-row[data-identity="${g.rows[1].id}"] .identity-gallery-tile:nth-of-type(3)`);
    await page.waitForFunction((f) => window.__lucid.state.currentFrame === f, target, { timeout: 10000 }).catch(() => {});
    check(!(await page.$('#trackSummaryOverlay')) && (await page.evaluate(() => window.__lucid.state.currentFrame)) === target,
        `clicking a sample closes the box and goes to its frame (${target})`);
    // reopen (ID Switches tab), then click the middle of row 1's path
    await page.evaluate(async () => (await import('/ui/track-summary-modal.js')).reopenTrackSummary(window.__lucid.state.session));
    await settled();
    const hit = await page.evaluate(async () => {
        const G = await import('/ui/identity-gallery.js');
        const s = window.__lucid.state.session, cam = s.cameras.find(c => c.name === document.getElementById('identityGalleryView').value);
        const id = s.identities[0].id, tr = G.identityTracks(s).get(id), p = G.projectTrack(tr, cam, G.MAP_MAX_POINTS, 60);
        const c = document.querySelector('.identity-gallery-row .identity-gallery-map canvas'), rect = c.getBoundingClientRect();
        const k = Math.floor(p.frames.length / 2), cw = parseFloat(c.style.width), chh = parseFloat(c.style.height);
        return { x: rect.left + p.uv[2 * k] * cw / 640, y: rect.top + p.uv[2 * k + 1] * chh / 480, frames: Array.from(tr.frames) };
    });
    await page.mouse.click(hit.x, hit.y);
    await page.waitForFunction(() => !document.getElementById('trackSummaryOverlay'), null, { timeout: 5000 }).catch(() => {});
    const at = await page.evaluate(() => window.__lucid.state.currentFrame);
    check(!(await page.$('#trackSummaryOverlay')) && hit.frames.includes(at), `clicking a point on a map closes the box and goes to a frame on that path (${at})`);

    // ---- 5. negative control: an ID switch halfway -> each row shows both animals -----------
    await page.evaluate(() => {
        const s = window.__lucid.state.session, half = window.__lucid.state.totalFrames / 2;
        const [a, b] = s.identities.map(i => i.id);
        s.instanceGroups.forEach((groups, f) => { if (f >= half) groups.forEach(gr => { gr.identityId = gr.identityId === a ? b : gr.identityId === b ? a : gr.identityId; }); });
    });
    await page.evaluate(async () => (await import('/ui/track-summary-modal.js')).reopenTrackSummary(window.__lucid.state.session));
    await settled();
    g = await page.evaluate(() => window.__gallery());
    check(g.rows.every(r => new Set(r.tiles.map(t => t.color)).size === 2),
        `after an ID switch halfway, each row shows BOTH animals: ${g.rows.map(r => r.name + ' ' + r.tiles.map(t => t.color[0]).join('')).join(' · ')}`);
    await page.keyboard.press('Escape');

    // ---- 6. no videos ---------------------------------------------------------------------
    await page.evaluate(async () => { await window.__build('noVideo', { noVideo: true }); await (await import('/pose/tracker.js')).trackAll(); });
    await page.waitForSelector('#trackSummaryOverlay', { timeout: 60000 });
    await settled();
    g = await page.evaluate(() => window.__gallery());
    check(g.rows.length === 2 && g.rows.every(r => r.tiles.every(t => t.blank === 'no video' && !t.color)), 'without videos the images say "no video"');
    check(g.rows.every(r => r.mapPoints > 100), '…and the maps still draw the paths');
    await page.hover('#identityGallery .identity-gallery-row .identity-gallery-tile:nth-of-type(2)');
    check(await page.evaluate(() => window.__zoom()) === null, '…and resting on one shows no preview (nothing to enlarge)');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
}
console.log(fails ? `\nFAIL — ${fails} check(s) failed` : '\nPASS');
process.exit(fails ? 1 : 0);
