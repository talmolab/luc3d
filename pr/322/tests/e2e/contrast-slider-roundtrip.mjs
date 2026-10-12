/**
 * contrast-slider-roundtrip.mjs — the Video Contrast slider (issue #149) in the
 * real app, end to end.
 *
 * The unit suite (`tests/test-video-contrast.js`) pins the math and the
 * per-session store in isolation. This pins the parts only the real app can
 * show:
 *
 *  1. The Visibility ▸ Video Contrast table renders one −100…100 slider per view
 *     and a real `input` event lands the expected CSS filter on the real canvas —
 *     for NEGATIVE and POSITIVE values, and composed with brightness (they share
 *     `canvas.style.filter`, so a regression there silently erases one of them).
 *  2. Moving a slider marks the project unsaved.
 *  3. A session switch — `state.views` is rebuilt from scratch and every pane is
 *     recreated — restores each session's own contrast, because the value lives
 *     on the Session and not on the transient view object. This is the assertion
 *     that a "just stash it on the view" implementation fails.
 *  4. Save → reopen carries the values back per session, through BOTH writers:
 *     the eager `buildSlpLabelsAllViews` + `saveSlpToBytes` path and the
 *     streaming `saveAllSessionsStreaming` path, reopened via the real
 *     `parseSlpViaSleapIO` adapter the importer reads.
 *  5. A project nobody adjusted writes NO `videoContrast` key at all, so
 *     untouched projects keep producing identical bytes
 *     (`tests/e2e/save-golden-digest.mjs` must not move).
 *
 * Run: node contrast-slider-roundtrip.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8188);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;   // absent demo assets
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    // =================================================================
    // 1 + 2 + 3 — UI, canvas filter, dirty flag, session switch
    // =================================================================
    const ui = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const vf = await import('/ui/video-filters.js');
        const { Skeleton, Camera, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        function makeSession(name, camNames) {
            const cams = camNames.map((n, i) =>
                new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
            return new Session(cams, skel, ['track_0'], name);
        }
        // Two sessions that SHARE camera names — the case where a per-view (or
        // globally-keyed) store would leak one session's value into the other.
        const s1 = makeSession('S1', ['camA', 'camB']);
        const s2 = makeSession('S2', ['camA', 'camB']);

        function activate(session) {
            AS.state.session = session;
            AS.state.activeSessionIdx = AS.state.sessions.indexOf(session);
            // Mirror switchSession: views are thrown away and rebuilt, panes cleared.
            AS.paneManager.clearAll();
            AS.state.views = session.cameras.map(c => ({
                name: c.name, videoWidth: 640, videoHeight: 480, canvas: null,
            }));
            AS.state.videoFiles = session.cameras.map(c => ({ name: c.name, assignedCamera: c.name }));
            sp.populateViewStrip();
            AS.paneManager.addAllViewsAsGrid();
        }

        AS.state.sessions = [s1, s2];
        AS.state.isDirty = false;
        document.title = 'Lucid';
        activate(s1);
        await new Promise(r => requestAnimationFrame(r));

        const table = document.getElementById('visVideoContrastTable');
        const sliders = () => Array.from(table.querySelectorAll('input[type=range]'));
        const labels = () => Array.from(table.querySelectorAll('.vis-val')).map(e => e.textContent);
        const linkEl = document.getElementById('visVideoContrastLink');
        const filters = () => AS.state.views.map(v => (v.canvas ? v.canvas.style.filter : '<no canvas>'));

        const out = {};
        out.sectionOrder = (function () {
            // "below Video Brightness" — assert the DOM order of the three headings.
            const hs = Array.from(document.querySelectorAll('#tabVisibility h3')).map(h => h.textContent);
            return hs.filter(t => /^Video /.test(t));
        })();
        out.rowCount = table.children.length;
        out.viewCount = AS.state.views.length;
        out.canvasesReady = AS.state.views.every(v => !!v.canvas);
        out.linkDefaultOn = !!(linkEl && linkEl.checked);
        out.sliderShape = sliders().map(s => ({ min: s.min, max: s.max, step: s.step, value: s.value }));
        out.initialLabels = labels();
        out.initialFilters = filters();

        function drive(idx, value) {
            const s = sliders()[idx];
            s.value = String(value);
            s.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // ---- per-view (link OFF) ----
        linkEl.checked = false;
        drive(0, 60);
        out.posFilters = filters();
        out.posLabels = labels();
        out.posStore = JSON.parse(JSON.stringify(s1.videoContrast));
        out.dirtyAfterFirstEdit = { global: AS.state.isDirty, session: !!s1.isDirty, title: document.title };

        drive(0, -60);
        out.negFilters = filters();
        out.negLabels = labels();
        out.negStore = JSON.parse(JSON.stringify(s1.videoContrast));

        // ---- composed with brightness ----
        // Brightness is session-backed too (it used to sit on `view._brightness`,
        // which reset on every session switch) — so it is set through the same
        // per-session store contrast uses.
        vf.setSessionBrightness(s1, 'camA', 150);
        sp.applyVideoFilters(AS.state.views[0]);
        out.composedFilter = AS.state.views[0].canvas.style.filter;
        vf.setSessionBrightness(s1, 'camA', 100);
        sp.applyVideoFilters(AS.state.views[0]);
        out.uncomposedFilter = AS.state.views[0].canvas.style.filter;

        // ---- extremes ----
        drive(0, -100);
        out.minFilter = AS.state.views[0].canvas.style.filter;
        drive(0, 100);
        out.maxFilter = AS.state.views[0].canvas.style.filter;

        // ---- reset to 0 clears the stored entry AND the filter ----
        drive(0, 0);
        out.zeroFilter = AS.state.views[0].canvas.style.filter;
        out.zeroStoreKeys = Object.keys(s1.videoContrast);

        // ---- linked (link ON) applies to every view at once ----
        linkEl.checked = true;
        drive(0, -35);
        out.linkedFilters = filters();
        out.linkedLabels = labels();
        out.linkedSliderValues = sliders().map(s => s.value);
        out.linkedStore = JSON.parse(JSON.stringify(s1.videoContrast));

        // ---- session 2 gets its own values ----
        activate(s2);
        await new Promise(r => requestAnimationFrame(r));
        out.s2InitialFilters = filters();
        out.s2InitialSliders = sliders().map(s => s.value);
        document.getElementById('visVideoContrastLink').checked = false;
        drive(0, 80);
        out.s2Store = JSON.parse(JSON.stringify(s2.videoContrast));
        out.s1StoreAfterS2Edit = JSON.parse(JSON.stringify(s1.videoContrast));

        // ---- switch back: session 1's values must come back from the SESSION,
        //      on brand-new view objects and brand-new canvases ----
        activate(s1);
        await new Promise(r => requestAnimationFrame(r));
        out.backFilters = filters();
        out.backSliders = sliders().map(s => s.value);
        out.backLabels = labels();
        out.backViewsAreFresh = AS.state.views.every(v => v._contrast === undefined);

        // Expected strings, computed by the module itself, so this test states the
        // contract (session value -> filter) rather than re-deriving the math.
        out.expectBack = AS.state.views.map(v =>
            vf.buildVideoFilter(100, vf.getSessionContrast(s1, v.name)));
        return out;
    });

    console.log('\n-- 1. Visibility ▸ Video Contrast table --');
    check(JSON.stringify(ui.sectionOrder) === JSON.stringify(['Video Brightness', 'Video Contrast', 'Video Rotation']),
        `Contrast sits directly below Brightness (got ${JSON.stringify(ui.sectionOrder)})`);
    check(ui.rowCount === ui.viewCount && ui.viewCount === 2,
        `one row per view (${ui.rowCount} rows / ${ui.viewCount} views)`);
    check(ui.canvasesReady, 'both panes produced a real canvas');
    check(ui.linkDefaultOn, '"Select All Videos" defaults to on, like brightness');
    check(ui.sliderShape.every(s => s.min === '-100' && s.max === '100' && s.step === '1' && s.value === '0'),
        `sliders are -100..100 step 1 default 0 (got ${JSON.stringify(ui.sliderShape)})`);
    check(JSON.stringify(ui.initialLabels) === JSON.stringify(['0', '0']),
        `value labels start at 0 (got ${JSON.stringify(ui.initialLabels)})`);
    check(JSON.stringify(ui.initialFilters) === JSON.stringify(['', '']),
        `default 0 leaves style.filter empty (got ${JSON.stringify(ui.initialFilters)})`);

    console.log('\n-- 1b. positive / negative / composed --');
    check(ui.posFilters[0] === 'contrast(1.6)', `+60 -> contrast(1.6) (got "${ui.posFilters[0]}")`);
    check(ui.posFilters[1] === '', 'link OFF leaves the other view untouched');
    check(ui.posLabels[0] === '+60', `positive label is signed (got "${ui.posLabels[0]}")`);
    check(JSON.stringify(ui.posStore) === JSON.stringify({ camA: 60 }), `stored on the session (got ${JSON.stringify(ui.posStore)})`);
    check(ui.negFilters[0] === 'contrast(0.4)', `-60 -> contrast(0.4) (got "${ui.negFilters[0]}")`);
    check(ui.negLabels[0] === '-60', `negative label is signed (got "${ui.negLabels[0]}")`);
    check(JSON.stringify(ui.negStore) === JSON.stringify({ camA: -60 }), `negative value stored (got ${JSON.stringify(ui.negStore)})`);
    check(ui.composedFilter === 'brightness(1.5) contrast(0.4)',
        `brightness and contrast compose into one filter (got "${ui.composedFilter}")`);
    check(ui.uncomposedFilter === 'contrast(0.4)',
        `resetting brightness leaves contrast intact (got "${ui.uncomposedFilter}")`);
    check(ui.minFilter === 'contrast(0)', `-100 -> contrast(0), flat mid-grey (got "${ui.minFilter}")`);
    check(ui.maxFilter === 'contrast(2)', `+100 -> contrast(2) (got "${ui.maxFilter}")`);
    check(ui.zeroFilter === '', `back to 0 clears the filter (got "${ui.zeroFilter}")`);
    check(ui.zeroStoreKeys.length === 0, `back to 0 removes the stored entry (got ${JSON.stringify(ui.zeroStoreKeys)})`);

    console.log('\n-- 1c. "Select All Videos" --');
    check(JSON.stringify(ui.linkedFilters) === JSON.stringify(['contrast(0.65)', 'contrast(0.65)']),
        `link ON applies to every view (got ${JSON.stringify(ui.linkedFilters)})`);
    check(JSON.stringify(ui.linkedSliderValues) === JSON.stringify(['-35', '-35']), 'all sliders follow');
    check(JSON.stringify(ui.linkedLabels) === JSON.stringify(['-35', '-35']), 'all labels follow');
    check(JSON.stringify(ui.linkedStore) === JSON.stringify({ camA: -35, camB: -35 }),
        `both cameras stored (got ${JSON.stringify(ui.linkedStore)})`);

    console.log('\n-- 2. unsaved state --');
    check(ui.dirtyAfterFirstEdit.global === true, 'a contrast edit sets state.isDirty');
    check(ui.dirtyAfterFirstEdit.session === true, 'and the per-session dirty flag');
    check(ui.dirtyAfterFirstEdit.title.indexOf('•') === 0, `and the title dot (got "${ui.dirtyAfterFirstEdit.title}")`);

    console.log('\n-- 3. per-session, across a session switch --');
    check(JSON.stringify(ui.s2InitialFilters) === JSON.stringify(['', '']),
        `session 2 starts clean despite sharing camera names (got ${JSON.stringify(ui.s2InitialFilters)})`);
    check(JSON.stringify(ui.s2InitialSliders) === JSON.stringify(['0', '0']), 'session 2 sliders start at 0');
    check(JSON.stringify(ui.s2Store) === JSON.stringify({ camA: 80 }), `session 2 stores its own value (got ${JSON.stringify(ui.s2Store)})`);
    check(JSON.stringify(ui.s1StoreAfterS2Edit) === JSON.stringify({ camA: -35, camB: -35 }),
        `editing session 2 does not touch session 1 (got ${JSON.stringify(ui.s1StoreAfterS2Edit)})`);
    check(ui.backViewsAreFresh, 'the rebuilt views carry no per-view contrast field');
    check(JSON.stringify(ui.backFilters) === JSON.stringify(ui.expectBack),
        `switching back restores session 1's filters from the session (got ${JSON.stringify(ui.backFilters)})`);
    check(JSON.stringify(ui.backFilters) === JSON.stringify(['contrast(0.65)', 'contrast(0.65)']),
        'and they are the values session 1 actually had');
    check(JSON.stringify(ui.backSliders) === JSON.stringify(['-35', '-35']), 'the table repopulates from the session');
    check(JSON.stringify(ui.backLabels) === JSON.stringify(['-35', '-35']), 'labels repopulate too');

    // =================================================================
    // 4 + 5 — save / reopen round trip, both writers
    // =================================================================
    const rt = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const fileio = await import('/import-export/file-io.js');
        const saveLoad = await import('/import-export/save-load.js');
        const lazyMod = await import('/loading/sio-lazy-loader.js');
        const vfmod = await import('/ui/video-filters.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;
        const NODES = 4;
        const skelOf = () => new Skeleton('skeleton',
            Array.from({ length: NODES }, (_, i) => 'n' + i),
            Array.from({ length: NODES - 1 }, (_, i) => [i, i + 1]));

        // Two sessions with DISTINCT camera names (so a mix-up is visible) and
        // deliberately different contrast maps, including both signs, both
        // extremes, and one camera left at the default.
        const SPECS = [
            { name: 'sessA', cams: ['a_cam0', 'a_cam1', 'a_cam2'], fx: 1000, nFrames: 4,
              contrast: { a_cam0: 45, a_cam1: -100 } },                  // a_cam2 stays 0
            { name: 'sessB', cams: ['b_cam0', 'b_cam1'], fx: 2000, nFrames: 3,
              contrast: { b_cam0: -45, b_cam1: 100 } },
        ];

        function buildSession(spec) {
            const mtx = [[spec.fx, 0, 128], [0, spec.fx, 128], [0, 0, 1]];
            const cams = spec.cams.map((cn, ci) =>
                new Camera(cn, mtx, [0, 0, 0, 0, 0], [0, 0.1 * ci, 0], [10 * ci, 0, 0], [256, 256]));
            const session = new Session(cams, skelOf(), ['t0'], spec.name);
            const idA = session.addIdentity('id0').id;
            for (let f = 0; f < spec.nFrames; f++) {
                const fg = new FrameGroup(f); session.addFrameGroup(fg);
                const g = new InstanceGroup(f * 10 + 1, idA);
                for (const cn of spec.cams) {
                    const pts = Array.from({ length: NODES }, (_, k) => [50 + k + f, 60 + k + f]);
                    const inst = new Instance(pts, 0, 'predicted', 0.9);
                    g.addInstance(cn, inst); fg.addInstance(cn, inst);
                }
                g.points3d = Array.from({ length: NODES }, (_, k) => [k + f * 0.1, k * 2, spec.fx / 1000 + k]);
                session.instanceGroups.set(f, [g]);
            }
            for (const cn of Object.keys(spec.contrast)) {
                vfmod.setSessionContrast(session, cn, spec.contrast[cn]);
            }
            return session;
        }

        function viewsFor(spec) {
            return spec.cams.map(cn => ({ name: cn, videoWidth: 256, videoHeight: 256, frameCount: spec.nFrames }));
        }
        function videoFilesFor(spec) {
            return spec.cams.map(cn => ({ name: cn, assignedCamera: cn, videoPath: cn + '.mp4' }));
        }

        // Reopen through the real adapter the importer reads
        // (`earlyMeta.lucid.videoContrast`), then ingest exactly as
        // import-export/slp-import.js does.
        async function reopen(bytes, filename) {
            const slpData = await fileio.parseSlpViaSleapIO(new File([bytes], filename), () => {});
            const perSession = [];
            for (let si = 0; si < (slpData.sessions || []).length; si++) {
                const sd = slpData.sessions[si];
                const lucid = (sd.metadata && sd.metadata.lucid) || {};
                const fresh = new Session([], skelOf(), ['t0'], 'reopened' + si);
                const applied = vfmod.ingestVideoContrast(fresh, lucid.videoContrast);
                perSession.push({
                    sessionName: lucid.sessionName || null,
                    onDisk: lucid.videoContrast !== undefined ? lucid.videoContrast : null,
                    hasKey: Object.prototype.hasOwnProperty.call(lucid, 'videoContrast'),
                    applied: applied,
                    restored: JSON.parse(JSON.stringify(fresh.videoContrast)),
                });
            }
            return { nSessions: (slpData.sessions || []).length, perSession };
        }

        const out = {};

        // ---- (a) EAGER writer: buildSlpLabelsAllViews + saveSlpToBytes ----
        {
            const sessions = SPECS.map(buildSession);
            AS.state.sessions = sessions;
            AS.state.session = sessions[0];
            AS.state.activeSessionIdx = 0;
            AS.state.views = SPECS.flatMap(viewsFor);
            AS.state.videoFiles = SPECS.flatMap(videoFilesFor);
            // Multi-session eager save writes one Labels per session and merges;
            // save the first session on its own (the shape buildSlpBytes uses).
            const labels = fileio.buildSlpLabelsAllViews(sessions[0], viewsFor(SPECS[0]), videoFilesFor(SPECS[0]));
            const bytes = await window.SleapIO.saveSlpToBytes(labels);
            out.eager = await reopen(bytes, 'eager.slp');
            out.eagerExpected = SPECS[0].contrast;
        }

        // ---- (b) untouched project must write NO key at all ----
        {
            const plain = buildSession({ ...SPECS[0], name: 'plain', contrast: {} });
            const labels = fileio.buildSlpLabelsAllViews(plain, viewsFor(SPECS[0]), videoFilesFor(SPECS[0]));
            const bytes = await window.SleapIO.saveSlpToBytes(labels);
            out.untouched = await reopen(bytes, 'untouched.slp');
        }

        // ---- (c) STREAMING writer: saveAllSessionsStreaming over both sessions ----
        // Needs a real lazy loader per session, built from per-camera prediction
        // fixtures (the shape a real prediction import produces).
        async function perCamFixture(spec, camName, camIdx) {
            const mtx = [[spec.fx, 0, 128], [0, spec.fx, 128], [0, 0, 1]];
            const cam = new Camera(camName, mtx, [0, 0, 0, 0, 0], [0, 0.1 * camIdx, 0], [10 * camIdx, 0, 0], [256, 256]);
            const s = new Session([cam], skelOf(), ['t0'], spec.name);
            for (let f = 0; f < spec.nFrames; f++) {
                const fg = new FrameGroup(f); s.addFrameGroup(fg);
                const pts = Array.from({ length: NODES }, (_, k) => [50 + k + f, 60 + k + f]);
                fg.addInstance(camName, new Instance(pts, 0, 'predicted', 0.9));
            }
            const labels = fileio.buildSlpLabels(s, camName, false, {
                videoWidth: 256, videoHeight: 256, frameCount: spec.nFrames, videoPath: camName + '.mp4',
            });
            const bytes = await window.SleapIO.saveSlpToBytes(labels);
            return new File([bytes], camName + '.slp');
        }
        {
            const sessions = SPECS.map(buildSession);
            for (let i = 0; i < sessions.length; i++) {
                const loader = new SioLazyLoader();
                for (let ci = 0; ci < SPECS[i].cams.length; ci++) {
                    await loader.open(SPECS[i].cams[ci], await perCamFixture(SPECS[i], SPECS[i].cams[ci], ci));
                }
                sessions[i].lazyLoader = loader;
            }
            AS.state.sessions = sessions;
            AS.state.session = sessions[0];
            AS.state.activeSessionIdx = 0;
            AS.state.views = SPECS.flatMap(viewsFor);
            AS.state.videoFiles = SPECS.flatMap(videoFilesFor);
            let err = null, bytes = null;
            try { bytes = await saveLoad.saveAllSessionsStreaming(sessions); }
            catch (e) { err = String((e && e.stack) || e); }
            out.streamErr = err;
            if (!err) out.streaming = await reopen(bytes, 'streaming.slp');
            out.streamingExpected = SPECS.map(s => s.contrast);
        }

        return out;
    });

    console.log('\n-- 4a. eager writer (buildSlpLabelsAllViews + saveSlpToBytes) --');
    check(rt.eager.nSessions === 1, `one session in the file (got ${rt.eager.nSessions})`);
    if (rt.eager.perSession[0]) {
        const e = rt.eager.perSession[0];
        check(e.hasKey, 'metadata.lucid.videoContrast was written');
        check(JSON.stringify(e.onDisk) === JSON.stringify(rt.eagerExpected),
            `on-disk map matches, defaults omitted (got ${JSON.stringify(e.onDisk)})`);
        check(JSON.stringify(e.restored) === JSON.stringify(rt.eagerExpected),
            `restored into a fresh Session (got ${JSON.stringify(e.restored)})`);
        check(e.applied === 2, `both non-default cameras applied (got ${e.applied})`);
    }

    console.log('\n-- 4b. streaming writer (saveAllSessionsStreaming) --');
    if (rt.streamErr) {
        check(false, 'saveAllSessionsStreaming threw: ' + rt.streamErr.slice(0, 300));
    } else {
        check(rt.streaming.nSessions === 2, `both sessions in the file (got ${rt.streaming.nSessions})`);
        for (let i = 0; i < rt.streamingExpected.length; i++) {
            const got = rt.streaming.perSession[i];
            const want = rt.streamingExpected[i];
            check(!!got && JSON.stringify(got.onDisk) === JSON.stringify(want),
                `session ${i} on-disk map is its own (want ${JSON.stringify(want)}, got ${got ? JSON.stringify(got.onDisk) : 'missing'})`);
            check(!!got && JSON.stringify(got.restored) === JSON.stringify(want),
                `session ${i} restores its own values (got ${got ? JSON.stringify(got.restored) : 'missing'})`);
        }
        const names = rt.streaming.perSession.map(p => p.sessionName);
        check(JSON.stringify(names) === JSON.stringify(['sessA', 'sessB']),
            `sessions kept their order/identity (got ${JSON.stringify(names)})`);
    }

    console.log('\n-- 5. untouched project writes nothing --');
    const u = rt.untouched.perSession[0];
    check(!!u && u.hasKey === false,
        `no videoContrast key when every camera is at the default (got ${u ? JSON.stringify(u.onDisk) : 'missing'})`);
    check(!!u && Object.keys(u.restored).length === 0, 'and it reopens with an empty map');

    await browser.close();
    browser = null;
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
