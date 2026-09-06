/**
 * visibility-settings-roundtrip.mjs — the session-scoped Visibility-panel
 * settings, in the real app, end to end.
 *
 * `contrast-slider-roundtrip.mjs` is the same shape of test for video CONTRAST.
 * This one covers what followed it — per-camera video BRIGHTNESS and ROTATION
 * and the timeline HIDDEN SETS — and pins the parts only the real app can show:
 *
 *  1. The Visibility ▸ Video Brightness and Video Rotation tables drive the
 *     PER-SESSION store, not the transient view. Brightness used to live on
 *     `view._brightness`; `state.views` is rebuilt from scratch on every session
 *     switch, so that silently reset. The session-switch assertions in step 3
 *     are what a "just stash it on the view" implementation fails.
 *  2. Rotation is the one setting here that is not display-only — the renderer
 *     and hit-testing read `view.rotation`. So a reopen must not merely restore
 *     the number into the session and the table: `restoreViewRotation` has to
 *     put it back on the VIEW, or the video loads visibly un-rotated while the
 *     panel claims otherwise. Step 3 asserts the view field, not just the store.
 *  3. Editing any of them marks the project unsaved (they are project state
 *     now, not browser-local display preferences).
 *  4. Save -> reopen carries every setting back per session through BOTH
 *     writers, the eager `buildSlpLabelsAllViews` + `saveSlpToBytes` path and
 *     the streaming `saveAllSessionsStreaming` path, reopened via the real
 *     `parseSlpViaSleapIO` adapter the importer reads.
 *  5. A project nobody adjusted writes NONE of the keys, so untouched projects
 *     keep producing identical bytes (`tests/e2e/save-golden-digest.mjs`).
 *  6. The writer adds ONLY its own keys — every other `metadata.lucid` field
 *     survives untouched.
 *
 * Run: node visibility-settings-roundtrip.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8189);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
    // 1 + 2 + 3 — the tables, the view field, dirty flag, session switch
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
        // globally-keyed) store leaks one session's value into the other.
        const s1 = makeSession('S1', ['camA', 'camB']);
        const s2 = makeSession('S2', ['camA', 'camB']);

        function activate(session) {
            AS.state.session = session;
            AS.state.activeSessionIdx = AS.state.sessions.indexOf(session);
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

        const bTable = document.getElementById('visVideoBrightnessTable');
        const rTable = document.getElementById('visVideoRotationTable');
        const bSliders = () => Array.from(bTable.querySelectorAll('input[type=range]'));
        const rSliders = () => Array.from(rTable.querySelectorAll('input[type=range]'));
        const rNums = () => Array.from(rTable.querySelectorAll('input[type=number]'));
        const filters = () => AS.state.views.map(v => (v.canvas ? v.canvas.style.filter : '<no canvas>'));
        const viewRotations = () => AS.state.views.map(v => v.rotation);

        function drive(el, value) {
            el.value = String(value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const out = {};
        out.brightnessRows = bTable.children.length;
        out.rotationRows = rTable.children.length;
        out.rotationSliderShape = rSliders().map(s => ({ min: s.min, max: s.max, step: s.step, value: s.value }));

        // ---- brightness, link OFF ----
        document.getElementById('visVideoBrightnessLink').checked = false;
        drive(bSliders()[0], 150);
        out.brightFilters = filters();
        out.brightStore = JSON.parse(JSON.stringify(s1.videoBrightness));
        out.dirtyAfterBrightness = { global: AS.state.isDirty, session: !!s1.isDirty, title: document.title };

        // brightness composes with contrast rather than erasing it
        vf.setSessionContrast(s1, 'camA', -50);
        sp.applyVideoFilters(AS.state.views[0]);
        out.composedFilter = AS.state.views[0].canvas.style.filter;
        vf.setSessionContrast(s1, 'camA', 0);
        sp.applyVideoFilters(AS.state.views[0]);

        // back to the default removes the entry entirely
        drive(bSliders()[0], 100);
        out.brightZeroKeys = Object.keys(s1.videoBrightness);

        // ---- brightness, link ON ----
        document.getElementById('visVideoBrightnessLink').checked = true;
        drive(bSliders()[0], 60);
        out.brightLinkedStore = JSON.parse(JSON.stringify(s1.videoBrightness));
        out.brightLinkedSliders = bSliders().map(s => s.value);

        // ---- rotation ----
        AS.state.isDirty = false;
        drive(rSliders()[1], 90);
        out.rotStore = JSON.parse(JSON.stringify(s1.videoRotation));
        out.rotViewField = viewRotations();
        out.rotNumInput = rNums().map(n => n.value);
        out.dirtyAfterRotation = AS.state.isDirty;
        // rotation is per-camera, NOT linked — camA must be untouched
        out.rotOnlyOneCamera = Object.keys(s1.videoRotation);

        // ---- timeline hidden sets ----
        const tv = window.TimelineVisibility;
        tv.toggleCameraVisibility(s1, 'camB');
        tv.toggleTrackVisibility(s1, 'track_0');
        out.hiddenAfterToggle = {
            cams: Array.from(s1._hiddenCameras),
            tracks: Array.from(s1._hiddenTracks),
        };

        // =============================================================
        // session switch — views are thrown away and rebuilt
        // =============================================================
        activate(s2);
        await new Promise(r => requestAnimationFrame(r));
        out.s2Filters = filters();
        out.s2BrightSliders = bSliders().map(s => s.value);
        out.s2RotSliders = rSliders().map(s => s.value);
        out.s2ViewRotations = viewRotations();

        // edit s2 so we can prove the two sessions stay independent
        document.getElementById('visVideoBrightnessLink').checked = false;
        drive(bSliders()[0], 20);
        drive(rSliders()[0], -45);
        out.s2Stores = {
            brightness: JSON.parse(JSON.stringify(s2.videoBrightness)),
            rotation: JSON.parse(JSON.stringify(s2.videoRotation)),
        };
        out.s1StoresAfterS2Edit = {
            brightness: JSON.parse(JSON.stringify(s1.videoBrightness)),
            rotation: JSON.parse(JSON.stringify(s1.videoRotation)),
        };

        // ---- and back ----
        activate(s1);
        await new Promise(r => requestAnimationFrame(r));
        out.backFilters = filters();
        out.backBrightSliders = bSliders().map(s => s.value);
        out.backRotSliders = rSliders().map(s => s.value);
        // THE assertion for rotation: the rebuilt view objects must carry it.
        out.backViewRotations = viewRotations();
        out.backHidden = {
            cams: Array.from(s1._hiddenCameras),
            tracks: Array.from(s1._hiddenTracks),
        };

        return out;
    });

    console.log('\n-- 1. the tables render from the session --');
    check(ui.brightnessRows === 2, `one brightness row per view (got ${ui.brightnessRows})`);
    check(ui.rotationRows === 2, `one rotation row per view (got ${ui.rotationRows})`);
    check(eq(ui.rotationSliderShape[0], { min: '-179', max: '180', step: '1', value: '0' }),
        `rotation slider spans -179..180 (got ${JSON.stringify(ui.rotationSliderShape[0])})`);

    console.log('\n-- 2. brightness --');
    check(eq(ui.brightFilters, ['brightness(1.5)', '']),
        `a brightness edit lands on the real canvas (got ${JSON.stringify(ui.brightFilters)})`);
    check(eq(ui.brightStore, { camA: 150 }), `stored per session (got ${JSON.stringify(ui.brightStore)})`);
    check(ui.composedFilter === 'brightness(1.5) contrast(0.5)',
        `composes with contrast instead of erasing it (got "${ui.composedFilter}")`);
    check(eq(ui.brightZeroKeys, []), `back to 100% removes the entry (got ${JSON.stringify(ui.brightZeroKeys)})`);
    check(eq(ui.brightLinkedStore, { camA: 60, camB: 60 }),
        `"Select All Videos" writes every camera (got ${JSON.stringify(ui.brightLinkedStore)})`);
    check(eq(ui.brightLinkedSliders, ['60', '60']), 'and every slider follows');

    console.log('\n-- 3. rotation --');
    check(eq(ui.rotStore, { camB: 90 }), `stored per session (got ${JSON.stringify(ui.rotStore)})`);
    check(eq(ui.rotViewField, [undefined, 90]) || eq(ui.rotViewField, [0, 90]),
        `and mirrored onto view.rotation for the renderer (got ${JSON.stringify(ui.rotViewField)})`);
    check(eq(ui.rotNumInput, ['0', '90']), 'the number input tracks the slider');
    check(eq(ui.rotOnlyOneCamera, ['camB']), 'rotation is per-camera, not linked across views');

    console.log('\n-- 4. unsaved state --');
    check(ui.dirtyAfterBrightness.global === true, 'a brightness edit sets state.isDirty');
    check(ui.dirtyAfterBrightness.session === true, 'and the per-session dirty flag');
    check(ui.dirtyAfterBrightness.title.indexOf('•') === 0,
        `and the title dot (got "${ui.dirtyAfterBrightness.title}")`);
    check(ui.dirtyAfterRotation === true, 'a rotation edit sets state.isDirty too');

    console.log('\n-- 5. hidden sets --');
    check(eq(ui.hiddenAfterToggle.cams, ['camB']), 'toggling a camera hides it');
    check(eq(ui.hiddenAfterToggle.tracks, ['track_0']), 'toggling a track hides it');

    console.log('\n-- 6. per-session, across a session switch --');
    check(eq(ui.s2Filters, ['', '']),
        `session 2 starts clean despite sharing camera names (got ${JSON.stringify(ui.s2Filters)})`);
    check(eq(ui.s2BrightSliders, ['100', '100']), 'session 2 brightness sliders start at the default');
    check(eq(ui.s2RotSliders, ['0', '0']), 'session 2 rotation sliders start at 0');
    check(eq(ui.s2ViewRotations, [0, 0]),
        `session 2's rebuilt views carry no rotation (got ${JSON.stringify(ui.s2ViewRotations)})`);
    check(eq(ui.s1StoresAfterS2Edit.brightness, { camA: 60, camB: 60 }),
        `editing session 2 does not touch session 1's brightness (got ${JSON.stringify(ui.s1StoresAfterS2Edit.brightness)})`);
    check(eq(ui.s1StoresAfterS2Edit.rotation, { camB: 90 }),
        `nor its rotation (got ${JSON.stringify(ui.s1StoresAfterS2Edit.rotation)})`);
    check(eq(ui.backFilters, ['brightness(0.6)', 'brightness(0.6)']),
        `switching back restores session 1's filters (got ${JSON.stringify(ui.backFilters)})`);
    check(eq(ui.backBrightSliders, ['60', '60']), 'the brightness table repopulates from the session');
    check(eq(ui.backRotSliders, ['0', '90']), 'the rotation table repopulates from the session');
    check(eq(ui.backViewRotations, [0, 90]),
        `and rotation is restored onto the REBUILT view objects, not just the table (got ${JSON.stringify(ui.backViewRotations)})`);
    check(eq(ui.backHidden.cams, ['camB']) && eq(ui.backHidden.tracks, ['track_0']),
        'the hidden sets survive the switch');

    // =================================================================
    // 7 + 8 + 9 — save / reopen round trip, both writers
    // =================================================================
    const rt = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const fileio = await import('/import-export/file-io.js');
        const saveLoad = await import('/import-export/save-load.js');
        const lazyMod = await import('/loading/sio-lazy-loader.js');
        const vfmod = await import('/ui/video-filters.js');
        const vmeta = await import('/import-export/visibility-metadata.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;
        const NODES = 4;
        const skelOf = () => new Skeleton('skeleton',
            Array.from({ length: NODES }, (_, i) => 'n' + i),
            Array.from({ length: NODES - 1 }, (_, i) => [i, i + 1]));

        // Two sessions with DISTINCT camera names (so a mix-up is visible) and
        // deliberately different settings, including both rotation signs, both
        // brightness extremes, and cameras left at the default.
        const SPECS = [
            { name: 'sessA', cams: ['a_cam0', 'a_cam1', 'a_cam2'], fx: 1000, nFrames: 4,
              brightness: { a_cam0: 200, a_cam1: 0 },      // a_cam2 stays 100
              rotation: { a_cam0: 90, a_cam2: -179 },      // a_cam1 stays 0
              hiddenCameras: ['a_cam1'],
              hiddenTracks: ['t0'],
              hiddenIdentities: ['id0'] },
            { name: 'sessB', cams: ['b_cam0', 'b_cam1'], fx: 2000, nFrames: 3,
              brightness: { b_cam1: 45 },
              rotation: { b_cam0: 180 },
              hiddenCameras: [],
              hiddenTracks: ['t0'],
              hiddenIdentities: [] },
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
            for (const cn of Object.keys(spec.brightness)) {
                vfmod.setSessionBrightness(session, cn, spec.brightness[cn]);
            }
            for (const cn of Object.keys(spec.rotation)) {
                vfmod.setSessionRotation(session, cn, spec.rotation[cn]);
            }
            session._hiddenCameras = new Set(spec.hiddenCameras);
            session._hiddenTracks = new Set(spec.hiddenTracks);
            session._hiddenIdentities = new Set(spec.hiddenIdentities);
            return session;
        }

        function viewsFor(spec) {
            return spec.cams.map(cn => ({ name: cn, videoWidth: 256, videoHeight: 256, frameCount: spec.nFrames }));
        }
        function videoFilesFor(spec) {
            return spec.cams.map(cn => ({ name: cn, assignedCamera: cn, videoPath: cn + '.mp4' }));
        }

        // Every metadata.lucid key a writer emits that this feature must NOT
        // disturb — invariant 2 of import-export/visibility-metadata.js.
        const FOREIGN_KEYS = ['sessionName', 'trustTracks', 'frameIdentityMap',
            'identities', 'skeleton', 'tracks'];

        // Reopen through the real adapter the importer reads, then ingest exactly
        // as import-export/slp-import.js does.
        async function reopen(bytes, filename) {
            const slpData = await fileio.parseSlpViaSleapIO(new File([bytes], filename), () => {});
            const perSession = [];
            for (let si = 0; si < (slpData.sessions || []).length; si++) {
                const sd = slpData.sessions[si];
                const lucid = (sd.metadata && sd.metadata.lucid) || {};
                const fresh = new Session([], skelOf(), ['t0'], 'reopened' + si);
                vmeta.readVisibilityMetadata(fresh, lucid);
                const present = {};
                for (const k of vmeta.VISIBILITY_METADATA_KEYS) {
                    if (Object.prototype.hasOwnProperty.call(lucid, k)) present[k] = lucid[k];
                }
                const foreign = {};
                for (const k of FOREIGN_KEYS) {
                    foreign[k] = Object.prototype.hasOwnProperty.call(lucid, k);
                }
                perSession.push({
                    sessionName: lucid.sessionName || null,
                    present: present,
                    presentKeys: Object.keys(present).sort(),
                    foreignKeysIntact: foreign,
                    restored: {
                        brightness: JSON.parse(JSON.stringify(fresh.videoBrightness)),
                        rotation: JSON.parse(JSON.stringify(fresh.videoRotation)),
                        hiddenCameras: Array.from(fresh._hiddenCameras).sort(),
                        hiddenTracks: Array.from(fresh._hiddenTracks).sort(),
                        hiddenIdentities: Array.from(fresh._hiddenIdentities).sort(),
                    },
                });
            }
            return { nSessions: (slpData.sessions || []).length, perSession };
        }

        const out = {};

        // ---- (a) EAGER writer ----
        {
            const sessions = SPECS.map(buildSession);
            AS.state.sessions = sessions;
            AS.state.session = sessions[0];
            AS.state.activeSessionIdx = 0;
            AS.state.views = SPECS.flatMap(viewsFor);
            AS.state.videoFiles = SPECS.flatMap(videoFilesFor);
            const labels = fileio.buildSlpLabelsAllViews(sessions[0], viewsFor(SPECS[0]), videoFilesFor(SPECS[0]));
            const bytes = await window.SleapIO.saveSlpToBytes(labels);
            out.eager = await reopen(bytes, 'eager.slp');
        }

        // ---- (b) untouched project must write NO key at all ----
        {
            const plain = buildSession({
                ...SPECS[0], name: 'plain',
                brightness: {}, rotation: {},
                hiddenCameras: [], hiddenTracks: [], hiddenIdentities: [],
            });
            const labels = fileio.buildSlpLabelsAllViews(plain, viewsFor(SPECS[0]), videoFilesFor(SPECS[0]));
            const bytes = await window.SleapIO.saveSlpToBytes(labels);
            out.untouched = await reopen(bytes, 'untouched.slp');
        }

        // ---- (c) STREAMING writer over both sessions ----
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
        }

        out.specs = SPECS;
        out.declaredKeys = vmeta.VISIBILITY_METADATA_KEYS;
        return out;
    });

    /** What `reopen()` should report for one spec. */
    function expectedFor(spec) {
        return {
            brightness: spec.brightness,
            rotation: spec.rotation,
            hiddenCameras: spec.hiddenCameras.slice().sort(),
            hiddenTracks: spec.hiddenTracks.slice().sort(),
            hiddenIdentities: spec.hiddenIdentities.slice().sort(),
        };
    }

    console.log('\n-- 7. eager writer (buildSlpLabelsAllViews + saveSlpToBytes) --');
    check(rt.eager.nSessions === 1, `one session in the file (got ${rt.eager.nSessions})`);
    if (rt.eager.perSession[0]) {
        const e = rt.eager.perSession[0];
        const want = expectedFor(rt.specs[0]);
        check(eq(e.present.videoBrightness, want.brightness),
            `brightness on disk, defaults omitted (got ${JSON.stringify(e.present.videoBrightness)})`);
        check(eq(e.present.videoRotation, want.rotation),
            `rotation on disk, defaults omitted (got ${JSON.stringify(e.present.videoRotation)})`);
        check(eq(e.present.hiddenCameras, want.hiddenCameras),
            `hidden cameras on disk (got ${JSON.stringify(e.present.hiddenCameras)})`);
        check(eq(e.present.hiddenTracks, want.hiddenTracks),
            `hidden tracks on disk (got ${JSON.stringify(e.present.hiddenTracks)})`);
        check(eq(e.present.hiddenIdentities, want.hiddenIdentities),
            `hidden identities on disk (got ${JSON.stringify(e.present.hiddenIdentities)})`);
        check(eq(e.restored, want), `everything restores into a fresh Session (got ${JSON.stringify(e.restored)})`);
        check(Object.values(e.foreignKeysIntact).every(Boolean),
            `every other metadata.lucid key survived (got ${JSON.stringify(e.foreignKeysIntact)})`);
    }

    console.log('\n-- 8. streaming writer (saveAllSessionsStreaming) --');
    if (rt.streamErr) {
        check(false, 'saveAllSessionsStreaming threw: ' + rt.streamErr.slice(0, 300));
    } else {
        check(rt.streaming.nSessions === 2, `both sessions in the file (got ${rt.streaming.nSessions})`);
        for (let i = 0; i < rt.specs.length; i++) {
            const got = rt.streaming.perSession[i];
            const want = expectedFor(rt.specs[i]);
            check(!!got && eq(got.restored, want),
                `session ${i} restores its own settings (want ${JSON.stringify(want)}, got ${got ? JSON.stringify(got.restored) : 'missing'})`);
        }
        const names = rt.streaming.perSession.map(p => p.sessionName);
        check(eq(names, ['sessA', 'sessB']), `sessions kept their order/identity (got ${JSON.stringify(names)})`);
        // sessB has no hidden cameras / identities — those keys must be absent
        // rather than written as empty arrays.
        const b = rt.streaming.perSession[1];
        check(!!b && eq(b.presentKeys, ['hiddenTracks', 'videoBrightness', 'videoRotation']),
            `a partially-default session writes only the keys it needs (got ${b ? JSON.stringify(b.presentKeys) : 'missing'})`);
    }

    console.log('\n-- 9. untouched project writes nothing --');
    const u = rt.untouched.perSession[0];
    check(!!u && eq(u.presentKeys, []),
        `NONE of the ${rt.declaredKeys.length} visibility keys are written when everything is at its default (got ${u ? JSON.stringify(u.presentKeys) : 'missing'})`);
    check(!!u && Object.keys(u.restored.brightness).length === 0
              && Object.keys(u.restored.rotation).length === 0
              && u.restored.hiddenCameras.length === 0,
        'and it reopens with empty stores');
    check(!!u && Object.values(u.foreignKeysIntact).every(Boolean),
        'while still carrying every other metadata.lucid key');

    console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} check(s)`);
    await browser.close();
    browser = null;
    process.exitCode = fails === 0 ? 0 : 1;
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
}
