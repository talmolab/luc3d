/**
 * _bench-playback.mjs — PLAYBACK SMOOTHNESS benchmark on a real multi-camera
 * project, run HEADED in real Google Chrome.
 *
 * Why real Chrome and not Playwright's bundled Chromium: the real recordings are
 * HEVC, and the bundled Chromium has no proprietary codecs — native <video>
 * playback (the default playback path) would not decode at all.
 *
 * Why headed: headless Chrome has no real display, no vsync and no compositor
 * presentation, so rAF cadence, rVFC presentation and dropped-frame counts are
 * meaningless there. This must be measured on a real screen.
 *
 * What it does:
 *   1. Loads the per-camera session folder (calibration.toml + one Camera dir per view, each with an mp4 + slp)
 *      through the real folder loader, as DISK-BACKED Files (a webkitdirectory
 *      <input>), never fetched into memory.
 *   2. Brings the project to the state the user plays back in: if no instance
 *      group carries 3D, runs Triangulate All via the same routing the toolbar
 *      uses (ui/ui-wiring.js `triangulateAllDropdown`).
 *   3. Runs one or more playback SCENARIOS from the same start frame. Each
 *      scenario is the app's real native playback path (VideoController
 *      .startPlayback), with harness-side instrumentation only — NO app code is
 *      modified; the harness wraps `videoController.callbacks.drawOverlays` and
 *      each `decoder.drawCurrentFrame` instance method to time them.
 *        full       — as the user sees it: user + predicted + reprojections.
 *        noReproj   — Visibility ▸ Reprojections unchecked.
 *        noOverlay  — overlay drawing replaced by a no-op (video copy only).
 *   4. Captures a Chrome performance trace of a separate `full` pass (tracing
 *      perturbs timing, so the metrics pass is never the traced pass).
 *
 * Per scenario it reports:
 *   - rAF frame-time distribution (median / p95 / p99 / max, count > 33 ms),
 *     alongside an idle baseline so the display refresh (ProMotion 120 Hz vs
 *     60 Hz) is visible.
 *   - The APP's draw cadence: draw-to-draw interval distribution and the
 *     overlay frame-index step histogram (+1 = smooth, +2/+3 = a video frame the
 *     overlay never showed, 0 = repainted the same frame, <0 = went backwards).
 *   - Per-video getVideoPlaybackQuality() deltas (total / dropped / corrupted).
 *   - Inter-view drift: at every app draw, each secondary <video>'s own
 *     currentTime-derived frame vs the frame index being overlaid on it.
 *   - Per-draw cost of video canvas copies and overlay drawing; how many drawn
 *     frames hit the lazy re-triangulation path in drawAllOverlays.
 *   - Long tasks and Long Animation Frames (with script attribution).
 *
 * Output: verify/playback-bench/<LABEL>-<timestamp>/{summary.json,trace.json}
 * (verify/ is gitignored). Open trace.json in DevTools ▸ Performance ▸ Load.
 *
 * Not a test (needs the real dataset + a display). Usage:
 *     node tests/e2e/_bench-playback.mjs
 *   env:
 *     DATASET=<dir>          session folder (default: the HardFight_1kModels set)
 *     LABEL=baseline         run label used in the output folder name
 *     SCENARIOS=full,noReproj,noOverlay,noInfo,no3d,lean,rvfc
 *         overlayOnly = the same per-view overlay canvas drawing, minus
 *         drawAllOverlays' 10 Hz aux tail (info panel, status-bar counters,
 *         timeline) — isolates the overlay canvases' GPU cost;
 *         noInfo = info panel hidden; no3d = 3D viewer hidden; lean = both
 *         (user-reachable UI states, not code changes); domVideos = full with
 *         the <video> elements attached to the page (tiny, near-transparent);
 *         trails<N> = full with Tracks ▸ Node Trails at N frames (e.g. trails100,
 *         trails500); every other scenario runs with trails off;
 *         rvfcLoop = full on the previous primary-rVFC loop
 *         (window.LUCID_PLAYBACK_LOOP='rvfc'); rafFallback = rVFC hidden;
 *         rvfc = full + rVFC
 *         observers on every video;
 *         idswitch = full with an ID Switches row selected whose interval
 *         covers the whole run, so the animated box in every view, the
 *         row's progress bar and its playhead all update every frame
 *     (append #N to repeat a scenario, e.g. full#2; append @<frame> to start
 *     that scenario somewhere other than START, e.g. full#2@40000 — a region
 *     no earlier scenario played reads COLD video, which is what a run from a
 *     network share is about)
 *     TRI=0                  skip the explicit Triangulate All (measures the
 *                            lazy per-frame re-solve path after Track All)
 *     START=3000             start frame for every scenario without an @<frame>
 *     SEEKS=0                after the scenarios, N paused random JUMPS (each
 *                            followed by STEPS single forward steps): time until
 *                            every view shows the frame (VideoController
 *                            .seekToFrame). Targets avoid every scenario's
 *                            played range, so each jump reads cold video.
 *     STEPS=5                forward steps after each jump
 *     SEED=12345             seed for the SEEKS targets (change it to get cold
 *                            targets on a second run against the same files)
 *     SEEK_TARGETS=f1,f2,…   explicit jump targets instead of seeded ones (e.g.
 *                            frames known to be unread on a network share)
 *     PREP=none              play the project as loaded: no Track All, no
 *                            Triangulate All (2D predictions only)
 *     SEEKS_FIRST=1          run the SEEKS test before the scenarios instead of
 *                            after (a fresh page rather than one that has
 *                            played every scenario)
 * Every scenario also samples the JS heap (performance.memory, 1 Hz) and the
 * number of RESIDENT frame groups (lazy projects hydrate as they play).
 *     WARMUP=2               seconds of playback discarded before measuring
 *     DUR=20                 measured seconds per scenario
 *     TRACE_SECS=8           seconds of the traced `full` pass (0 = no trace)
 *     RVFC_ALL=1             also attach an rVFC observer to every secondary
 *                            <video> (off by default: it may itself change how
 *                            Chrome services an off-DOM element)
 *     EXECUTABLE=<path>      Chromium-based browser binary to drive instead of
 *                            Chrome (e.g. /Applications/Brave Browser.app/
 *                            Contents/MacOS/Brave Browser)
 *     PORT=8123
 *     SPEED=1                playback speed multiplier
 *     EXCLUDE=<regex>        relative paths to leave out of the folder pick
 *                            (default: dotfiles and any troubleshooting/ dir)
 *
 * Reading the "screen" lines: a display shows at most its refresh rate in
 * images/s, so video faster than the display (e.g. 150 fps on 120 or 60 Hz) is
 * judged against the IDEAL cadence fps*speed/Hz per refresh, not against
 * "every frame". holds = a refresh that didn't advance (stall); big-jumps = an
 * advance beyond the ideal cadence (visible skip). "proj. 60Hz" resamples the
 * same run at every other refresh (both phases) — a projection, not a
 * measurement on a 60 Hz panel.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const DATASET = process.env.DATASET ||
    '/Users/soline/Documents/luc3d/LabMeetingPrep/Oline/20260605_133431-HardFight_1kModels';
const LABEL = process.env.LABEL || 'baseline';
const SCENARIOS = (process.env.SCENARIOS || 'full,noReproj,noOverlay,overlayOnly,noInfo,no3d,lean,rvfc').split(',').map(s => s.trim()).filter(Boolean);
const START = Number(process.env.START || 3000);
// `name@frame` — a per-scenario start frame.
const startOf = (name) => { const m = /@(\d+)$/.exec(name); return m ? Number(m[1]) : START; };
const SEEKS = Number(process.env.SEEKS || 0);
const STEPS = Number(process.env.STEPS ?? 5);
const SEEKS_FIRST = process.env.SEEKS_FIRST === '1';
const SEED = Number(process.env.SEED || 12345);
const SEEK_TARGETS = (process.env.SEEK_TARGETS || '').split(',').map(x => x.trim()).filter(Boolean).map(Number);
const PREP = process.env.PREP || 'full';
const WARMUP = Number(process.env.WARMUP || 2);
const DUR = Number(process.env.DUR || 20);
const TRACE_SECS = Number(process.env.TRACE_SECS ?? 8);
const RVFC_ALL = process.env.RVFC_ALL === '1';
const PORT = Number(process.env.PORT || 8123);
// Files the folder pick must NOT include (relative path regex): dotfiles and a
// stray `troubleshooting/` copy (the Mimica set keeps a duplicate .slp there,
// which would raise the per-camera SLP-choice modal).
const EXCLUDE = new RegExp(process.env.EXCLUDE || '(^|/)\\.|/troubleshooting/');
const SPEED = Number(process.env.SPEED || 1);
// VFPROBE=1: at every app draw, capture `new VideoFrame(<video>)` per view and
// compare ITS timestamp to the overlaid frame index — the true "which video
// frame is under this overlay" measure (the currentTime-based `drift` is a
// proxy). Off by default: it adds 1 capture per view per draw.
const VFPROBE = process.env.VFPROBE === '1';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = path.join(repoRoot, 'verify', 'playback-bench', `${LABEL}-${stamp}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const log = (m) => process.stdout.write(m + '\n');
const t00 = Date.now();
const el = () => ((Date.now() - t00) / 1000).toFixed(1) + 's';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!fs.existsSync(DATASET)) { console.error('DATASET not found: ' + DATASET); process.exit(2); }


// ---------------------------------------------------------------------------
// stats helpers (node side)
// ---------------------------------------------------------------------------
function dist(arr) {
    if (!arr.length) return { n: 0 };
    const s = Float64Array.from(arr).sort();
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
    let sum = 0; for (const v of s) sum += v;
    return {
        n: s.length, mean: +(sum / s.length).toFixed(2), median: +q(0.5).toFixed(2),
        p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2),
    };
}
const countOver = (arr, t) => arr.reduce((n, v) => n + (v > t ? 1 : 0), 0);

let browser;
const summary = {
    label: LABEL, dataset: DATASET, start: START, warmupS: WARMUP, durS: DUR,
    when: new Date().toISOString(), env: {}, scenarios: {}, trace: null,
};

// a visible browser window: one such run at a time across sessions (scripts/browser-lock.mjs)
const releaseBrowserLock = await acquireBrowserLock({ label: '_bench-playback' });
// The static server starts only once the lock is held: two queued runs on the
// default PORT used to collide — the waiting run's server failed to bind while
// the running one held the port, and found it gone when its turn came.
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await sleep(1200);
try {
    browser = await chromium.launch({
        // real Chrome (HEVC + hardware decode); EXECUTABLE=<path> drives another
        // Chromium-based browser instead (e.g. Brave) with a fresh profile.
        ...(process.env.EXECUTABLE ? { executablePath: process.env.EXECUTABLE } : { channel: 'chrome' }),
        headless: false,
        args: ['--window-size=1800,1120', '--window-position=0,0',
               '--enable-precise-memory-info'],
    });
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    page.on('pageerror', e => log(`  [${el()}] [pageerror] ` + String(e).slice(0, 300)));
    page.on('crash', () => log(`  [${el()}] *** RENDERER CRASHED ***`));
    page.on('dialog', async d => { log(`  [${el()}] [dialog] ${d.message().slice(0, 120)}`); await d.accept(process.env.NANIMALS || '3'); });
    page.on('console', m => {
        const t = m.text();
        if (/Playback (loop|started|stopped)|\[bench\]|error/i.test(t)) log(`  [${el()}] [console] ${t.slice(0, 220)}`);
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 30000 });
    summary.env = await page.evaluate(() => ({
        ua: navigator.userAgent, dpr: devicePixelRatio,
        inner: [innerWidth, innerHeight], screen: [screen.width, screen.height],
        hevc: (document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"') || 'no'),
    }));
    log(`[${el()}] app booted: ${JSON.stringify(summary.env)}`);

    // ---------------------------------------------------------------------
    // LOAD the per-camera folder, disk-backed.
    // ---------------------------------------------------------------------
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__benchDir';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
        // The loader can raise "Missing Camera Directories / Missing Video Files"
        // style popups; nothing clicks them under automation.
        window.__benchDismissed = [];
        window.__benchAutoDismiss = setInterval(() => {
            for (const b of document.querySelectorAll('button')) {
                const t = b.textContent.trim();
                if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) {
                    window.__benchDismissed.push(t); b.click();
                }
            }
        }, 300);
    });
    await page.setInputFiles('#__benchDir', DATASET);
    const nPicked = await page.evaluate(() => document.getElementById('__benchDir').files.length);
    log(`[${el()}] picked ${nPicked} files from ${path.basename(DATASET)}`);

    await page.evaluate((EXCLUDE_SRC) => {
        window.__benchLoad = { done: false, err: null, t0: performance.now(), ms: 0 };
        (async () => {
            try {
                const sl = await import('/loading/session-loader.js');
                const ex = new RegExp(EXCLUDE_SRC);
                const files = Array.from(document.getElementById('__benchDir').files)
                    .filter(f => !ex.test(f.webkitRelativePath || f.name));
                console.log('[bench] loading ' + files.length + ' files');
                await sl.handleLoadSessionFolderPerCamera(files, false);
                window.__benchLoad.done = true;
            } catch (e) { window.__benchLoad.err = String(e && e.stack || e).slice(0, 600); }
            window.__benchLoad.ms = Math.round(performance.now() - window.__benchLoad.t0);
        })();
    }, EXCLUDE.source);
    const loadDeadline = Date.now() + 10 * 60 * 1000;
    let lastModalLog = 0;
    for (;;) {
        const s = await page.evaluate(() => {
            const st = window.__lucid.state;
            const modals = Array.from(document.querySelectorAll('.modal, .modal-overlay, [role=dialog]'))
                .filter(m => m.offsetParent !== null).map(m => m.textContent.trim().replace(/\s+/g, ' ').slice(0, 160));
            return {
                ...window.__benchLoad,
                views: st.views.length, withDecoder: st.views.filter(v => v.decoder).length,
                hasSession: !!st.session, modals,
            };
        });
        if (s.err) throw new Error('load failed: ' + s.err);
        if (s.done) { log(`[${el()}] load done in ${s.ms} ms; views=${s.views} decoders=${s.withDecoder}`); break; }
        if (Date.now() > loadDeadline) throw new Error('load timed out: ' + JSON.stringify(s));
        if (s.modals.length && Date.now() - lastModalLog > 10000) {
            lastModalLog = Date.now();
            log(`  [${el()}] loading... open modal(s): ${JSON.stringify(s.modals)}`);
        }
        await sleep(1000);
    }

    const projState = () => page.evaluate(() => {
        const st = window.__lucid.state, s = st.session;
        let frames = 0, groups = 0, with3d = 0, withReproj = 0;
        if (s && s.instanceGroups) {
            for (const [, gs] of s.instanceGroups) {
                frames++;
                for (const g of gs) {
                    groups++;
                    if (g.points3d && g.points3d.length) with3d++;
                    if ((g.reprojections && Object.keys(g.reprojections).length) ||
                        (g.reprojectedInstances && g.reprojectedInstances.size)) withReproj++;
                }
            }
        }
        return {
            cameras: s ? s.cameras.map(c => c.name) : [],
            identities: s ? s.identities.length : 0, tracks: s ? s.tracks.length : 0,
            totalFrames: st.totalFrames, fps: st.fps, lazy: !!(s && s.lazyLoader),
            frameGroups: s ? s.frameGroups.size : 0,
            groupFrames: frames, groups, with3d, withReproj,
            decoderFps: st.views.filter(v => v.decoder).map(v => v.decoder._fps),
            mediabunny: st.views.filter(v => v.decoder).map(v => !!v.decoder._mbBackend),
            inDom: st.views.filter(v => v.decoder).map(v => !!(v.decoder._videoEl && v.decoder._videoEl.isConnected)),
        };
    });
    let ps = await projState();
    log(`[${el()}] project: ${JSON.stringify(ps)}`);

    // ---------------------------------------------------------------------
    // Bring the project to "has 3D + reprojections".
    // ---------------------------------------------------------------------
    // Raw per-camera predictions carry tracks but no cross-view identities, and
    // Triangulate All needs identity-linked groups — so Track All first, exactly
    // as a user would. Track All asks for the animal count via window.prompt(),
    // answered by the dialog handler (NANIMALS, default 3: ~95% of frames in
    // the HardFight set hold 3 instances per camera).
    if (PREP === 'none') log(`\n[${el()}] PREP=none — playing the project as loaded (no Track All / Triangulate All)`);
    if (PREP !== 'none' && ps.with3d === 0 && ps.identities === 0 && ps.groups === 0) {
        log(`\n[${el()}] no identities — running Track All (NANIMALS=${process.env.NANIMALS || 3})`);
        const r = await page.evaluate(async () => {
            const t = performance.now();
            try {
                const tr = await import('/pose/tracker.js');
                await tr.trackAll();
            } catch (e) { return { err: String(e && e.stack || e).slice(0, 500) }; }
            return { ms: Math.round(performance.now() - t) };
        });
        log(`[${el()}] Track All: ${JSON.stringify(r)}`);
        ps = await projState();
        log(`[${el()}] project: ${JSON.stringify(ps)}`);
    }
    // Track All triangulates, but caches reprojections only for the frame it
    // lands on — every other frame would hit drawAllOverlays' lazy re-solve
    // during the first playback pass and not during later ones, making the
    // scenarios incomparable. So unless TRI=0, Triangulate All explicitly (the
    // "Track All -> Triangulate All" user state); TRI=0 measures the lazy path.
    const wantTri = process.env.TRI !== '0' && ps.withReproj < ps.groups * 0.9;
    if (PREP !== 'none' && (ps.with3d === 0 || wantTri)) {
        log(`\n[${el()}] running Triangulate All (toolbar routing)`);
        const r = await page.evaluate(async () => {
            const st = window.__lucid.state;
            const t = performance.now();
            let route;
            try {
                if (st.session.identities.length > 0) {
                    route = 'groupByIdentityAndTriangulateAll(dlt)';
                    const em = await import('/ui/export-modals.js');
                    await em.groupByIdentityAndTriangulateAll('dlt');
                } else {
                    route = 'triangulateAllFrames(dlt)';
                    const tri = await import('/pose/triangulation.js');
                    await tri.triangulateAllFrames('dlt');
                }
            } catch (e) { return { route, err: String(e && e.stack || e).slice(0, 500) }; }
            return { route, ms: Math.round(performance.now() - t) };
        });
        log(`[${el()}] Triangulate All: ${JSON.stringify(r)}`);
        ps = await projState();
        log(`[${el()}] project: ${JSON.stringify(ps)}`);
    }
    summary.project = ps;
    if (ps.with3d === 0 && PREP !== 'none') log('  !! WARNING: still no 3D — reprojections will not be drawn; results will not reflect the user scenario');

    // Make sure the Visibility state is the user's: everything on.
    await page.evaluate(() => {
        for (const id of ['visUser', 'visPredicted', 'visReprojections']) {
            const c = document.getElementById(id); if (c && !c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }
        }
    });

    // ---------------------------------------------------------------------
    // In-page collector.
    // ---------------------------------------------------------------------
    await page.evaluate(async ({ RVFC_ALL, VFPROBE }) => {
        const B = window.__bench = {};
        // `overlayOnly` replays drawAllOverlays' per-view canvas work (same
        // modules, same options, ui/rendering.js's view loop) WITHOUT its 10 Hz
        // aux tail (updateFrameInfo / status-bar counters / timeline redraw) —
        // isolating the GPU/raster cost of the overlay canvases themselves.
        const [rmod, omod, tmod, smod] = await Promise.all([
            import('/ui/rendering.js'), import('/ui/overlays.js'),
            import('/pose/triangulation.js'), import('/ui/settings.js')]);
        B.overlayOnlyDraw = function (frameIdx) {
            const st = window.__lucid.state, session = st.session;
            if (!session) return;
            const frameGroup = session.getFrameGroup(frameIdx);
            const instanceGroups = tmod.getInstanceGroupsForFrame(frameIdx);
            const vis = rmod.getVisibilitySettings();
            for (const view of st.views) {
                if (!view.overlayCtx || !view.overlayCanvas) continue;
                const zs = view.zoom ? view.zoom.scale : 1;
                const cssW = view.overlayCanvas.offsetWidth;
                const displayW = cssW * zs;
                let ofg = null;
                if (frameGroup) {
                    ofg = { frameIdx: frameGroup.frameIdx, instances: {} };
                    for (const [cam, insts] of frameGroup.instances) ofg.instances[cam] = insts;
                }
                const viewUnlinked = [];
                if (frameGroup && (vis.showUser || vis.showPredicted)) {
                    for (const u of (frameGroup.getUnlinkedInstances(view.name) || [])) {
                        const t = u.instance.type || 'user';
                        if ((t === 'predicted' && vis.showPredicted) || (t !== 'predicted' && vis.showUser)) viewUnlinked.push(u);
                    }
                }
                omod.drawFrameOverlays(view.overlayCtx, view.name, ofg, instanceGroups, session, {
                    colorByIdentity: st.colorByIdentity, trailLength: st.trailLength, showLegend: false,
                    showUser: vis.showUser, showPredicted: vis.showPredicted, showReprojected: vis.showReprojected,
                    reprojNodeColor: vis.reprojNodeColor, showErrors: vis.showErrors,
                    userOpts: vis.userOpts, predictedOpts: vis.predictedOpts, reprojOpts: vis.reprojOpts,
                    videoWidth: view.videoWidth, videoHeight: view.videoHeight,
                    canvasWidth: view.overlayCanvas.width, canvasHeight: view.overlayCanvas.height,
                    labelDisplayScale: displayW > 0 ? view.overlayCanvas.width / displayW : 1,
                    labelRotation: Math.round(view.rotation || 0),
                    selectedInstanceGroup: null, selectedReprojected: false, selectedNodeIdx: -1,
                    hoveredNode: null, dragInfo: null, unlinkedInstances: viewUnlinked,
                    showUnlinkedBadge: vis.showUnlinkedBadge, assignmentSelectedIds: [], assignmentMode: false,
                    selectedUnlinkedId: null, editGroupTarget: null,
                    trackingExcluded: !smod.isCameraTracked(view.name),
                });
            }
        };
        const vc0 = () => window.__lucid.videoController;
        const liveViews = () => window.__lucid.state.views.filter(v => v.decoder && v.decoder._videoEl);

        // rAF sampler — runs independently of the app's loop.
        B.idleRaf = async (ms) => {
            const ts = [];
            await new Promise(res => {
                const t0 = performance.now();
                const f = (t) => { ts.push(t); if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(); };
                requestAnimationFrame(f);
            });
            const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
            return d;
        };

        B.install = (scenario) => {
            const vc = vc0();
            const views = liveViews();
            const fps = views[0].decoder._fps || window.__lucid.state.fps || 30;
            const R = B.rec = {
                scenario, fps, measuring: false,
                raf: [], rafWall: [],
                draws: [],          // {t, f, ovMs, vidMs, lazyTri, drift:[...]} while measuring
                longtasks: [], loaf: [],
                rvfc: views.map(() => []),
                q0: null, q1: null,
                origDraw: vc.callbacks.drawOverlays,
                origCopy: views.map(v => v.decoder.drawCurrentFrame),
                origCap: views.map(v => v.decoder.captureCurrentFrame),
                // <video> ran out of data ('waiting') / its fetch stopped
                // progressing ('stalled'): during warm-up and while measuring.
                waiting: views.map(() => 0), stalled: views.map(() => 0), warmWaiting: views.map(() => 0),
                // startPlayback -> first draw past the start frame (set by the runner)
                startup: { t0: null, startFrame: window.__lucid.state.currentFrame, firstAdvanceMs: null },
            };
            R.mediaOff = views.map((v, i) => {
                const vel = v.decoder._videoEl;
                const w = () => { if (R.measuring) R.waiting[i]++; else R.warmWaiting[i]++; };
                const s = () => { if (R.measuring) R.stalled[i]++; };
                vel.addEventListener('waiting', w); vel.addEventListener('stalled', s);
                return () => { vel.removeEventListener('waiting', w); vel.removeEventListener('stalled', s); };
            });
            let pendingVidMs = 0, pendingTlMs = 0, pendingSeekMs = 0, tlCalled = false;
            // Index of the VideoFrame actually painted into each view's canvas
            // this draw (refresh loop only; drawImage(<video>) has no timestamp).
            let drawnIdx = new Array(views.length).fill(null);
            // Timeline playhead redraw (instance method; throttled to ~10 Hz by
            // drawAllOverlays) and updateSeekbar (incl. the ~10 Hz 3D viewport
            // update) — timed so the periodic "aux" draws can be told apart.
            const tl = window.__lucid.timeline;
            R.origTl = tl && tl.setCurrentFrame;
            if (tl && R.origTl) {
                tl.setCurrentFrame = function () {
                    const t = performance.now();
                    const r = R.origTl.apply(this, arguments);
                    pendingTlMs += performance.now() - t;
                    tlCalled = true;   // flag by call: a fast-path blit can time as 0 ms
                    return r;
                };
            }
            // 3D viewer: how often its scene gets a new frame (setFrame), what
            // that costs, and how often / how expensively it renders.
            R.v3 = { setFrame: [], render: [] };
            const v3 = window.__lucid.viewport3d;
            if (v3) {
                R.origV3Set = v3.setFrame;
                v3.setFrame = function () {
                    const t = performance.now();
                    const r = R.origV3Set.apply(this, arguments);
                    if (R.measuring) R.v3.setFrame.push({ t, ms: performance.now() - t, f: window.__lucid.state.currentFrame });
                    return r;
                };
                if (v3.renderer) {
                    R.origV3Render = v3.renderer.render;
                    v3.renderer.render = function () {
                        const t = performance.now();
                        const r = R.origV3Render.apply(this, arguments);
                        if (R.measuring) R.v3.render.push({ t, ms: performance.now() - t });
                        return r;
                    };
                }
            }
            R.origSeek = vc.callbacks.updateSeekbar;
            vc.callbacks.updateSeekbar = function () {
                const t = performance.now();
                const r = R.origSeek.apply(this, arguments);
                const dt = performance.now() - t;
                pendingSeekMs += dt;
                const last = R.draws[R.draws.length - 1];
                if (last && last.seekMs === null) { last.seekMs = dt; pendingSeekMs = 0; }
                return r;
            };
            // Time each view's video copy (decoder instance method).
            views.forEach((v, i) => {
                const orig = R.origCopy[i];
                v.decoder.drawCurrentFrame = function (ctx, w, h) {
                    const t = performance.now();
                    const r = orig.call(this, ctx, w, h);
                    pendingVidMs += performance.now() - t;
                    return r;
                };
                // Default (refresh) loop: capture the VideoFrame + drawImage it.
                // Time the capture here; the canvas draw via the ctx below.
                if (R.origCap[i]) {
                    const oc = R.origCap[i];
                    v.decoder.captureCurrentFrame = function () {
                        const t = performance.now();
                        const r = oc.call(this);
                        pendingVidMs += performance.now() - t;
                        return r;
                    };
                }
                if (v.ctx && !v.ctx.__benchWrapped) {
                    const od = v.ctx.drawImage;
                    v.ctx.drawImage = function (img) {
                        if (typeof VideoFrame === 'function' && img instanceof VideoFrame) {
                            drawnIdx[i] = Math.round(img.timestamp / 1e6 * fps);
                        }
                        const t = performance.now();
                        const r = od.apply(this, arguments);
                        pendingVidMs += performance.now() - t;
                        return r;
                    };
                    v.ctx.__benchWrapped = od;
                }
            });
            // Wrap the overlay callback (the loop reads self.callbacks.drawOverlays each tick).
            const realDraw = scenario === 'noOverlay' ? function () {}
                : scenario === 'overlayOnly' ? B.overlayOnlyDraw : R.origDraw;
            vc.callbacks.drawOverlays = function (f, viewFrames) {
                const st = window.__lucid.state;
                let lazyTri = 0;
                const gs = st.session && st.session.instanceGroups && st.session.instanceGroups.get(f);
                if (gs) for (const g of gs) {
                    if (g.points3d && g.points3d.length &&
                        !(g.reprojectedInstances && g.reprojectedInstances.size) &&
                        !(g.reprojections && Object.keys(g.reprojections).length)) lazyTri++;
                }
                const t = performance.now();
                const r = realDraw.apply(this, arguments);
                const ovMs = performance.now() - t;
                if (!R.measuring && st.isPlaying && R.startup.t0 != null && R.startup.firstAdvanceMs == null &&
                    f > R.startup.startFrame) R.startup.firstAdvanceMs = performance.now() - R.startup.t0;
                if (R.measuring && st.isPlaying) {
                    const drift = [];
                    for (let i = 1; i < views.length; i++) {
                        drift.push(Math.round(views[i].decoder._videoEl.currentTime * fps) - f);
                    }
                    let vf = null;
                    if (VFPROBE && typeof VideoFrame === 'function') {
                        vf = [];
                        for (let i = 0; i < views.length; i++) {
                            try {
                                const fr = new VideoFrame(views[i].decoder._videoEl);
                                // vs THIS view's overlay frame (per-view in the
                                // refresh loop; the shared f otherwise)
                                const ov = viewFrames && viewFrames[views[i].name] != null ? viewFrames[views[i].name] : f;
                                vf.push(Math.round(fr.timestamp / 1e6 * fps) - ov);
                                fr.close();
                            } catch (e) { vf.push(null); }
                        }
                    }
                    // drawn: (frame painted into the canvas) - (frame overlaid), per view.
                    let drawn = null;
                    if (viewFrames) {
                        drawn = views.map((vv, i) => (drawnIdx[i] == null || viewFrames[vv.name] == null) ? null : drawnIdx[i] - viewFrames[vv.name]);
                    }
                    const vfr = viewFrames ? views.map(vv => viewFrames[vv.name]).filter(x => x != null) : null;
                    const spread = vfr && vfr.length ? Math.max(...vfr) - Math.min(...vfr) : null;
                    R.draws.push({ t, f, vf, drawn, spread, ovMs, vidMs: pendingVidMs, tlMs: pendingTlMs, seekMs: null,
                        aux: tlCalled, lazyTri,
                        // Lazy project + frame not hydrated: drawAllOverlays
                        // clears the overlay and returns, i.e. a BLANK overlay.
                        blank: !!(st.session && st.session.lazyLoader && !st.session.frameGroups.has(f)),
                        primaryCT: Math.round(views[0].decoder._videoEl.currentTime * fps) - f, drift });
                }
                pendingVidMs = 0; pendingTlMs = 0; tlCalled = false;
                drawnIdx = new Array(views.length).fill(null);
                return r;
            };
            // rAF sampler.
            const rafLoop = (t) => {
                if (!B.rec || B.rec !== R) return;
                if (R.measuring) { R.raf.push(t); R.rafWall.push(performance.now()); }
                requestAnimationFrame(rafLoop);
            };
            requestAnimationFrame(rafLoop);
            // Long tasks + LoAF.
            R.obsLT = new PerformanceObserver(list => {
                if (!R.measuring) return;
                for (const e of list.getEntries()) R.longtasks.push({ start: e.startTime, dur: e.duration });
            });
            R.obsLT.observe({ type: 'longtask', buffered: false });
            try {
                R.obsLoaf = new PerformanceObserver(list => {
                    if (!R.measuring) return;
                    for (const e of list.getEntries()) {
                        R.loaf.push({
                            start: e.startTime, dur: e.duration, blocking: e.blockingDuration,
                            renderStart: e.renderStart, styleLayoutStart: e.styleAndLayoutStart,
                            scripts: (e.scripts || []).map(s => ({
                                inv: s.invoker, type: s.invokerType, fn: s.sourceFunctionName,
                                url: (s.sourceURL || '').replace(/^.*\/\/[^/]+/, ''), dur: s.duration,
                                fsl: s.forcedStyleAndLayoutDuration,
                            })),
                        });
                    }
                });
                R.obsLoaf.observe({ type: 'long-animation-frame', buffered: false });
            } catch (e) { R.loafErr = String(e); }
            // Optional rVFC on every view (incl. primary — rVFC callbacks are per request, so this
            // does not interfere with the app's own chain on view 0).
            if (RVFC_ALL || scenario === 'rvfc') {
                views.forEach((v, i) => {
                    const vel = v.decoder._videoEl;
                    const cb = (now, md) => {
                        if (!B.rec || B.rec !== R) return;
                        if (R.measuring) R.rvfc[i].push({ now, mt: md.mediaTime, pf: md.presentedFrames, edt: md.expectedDisplayTime });
                        vel.requestVideoFrameCallback(cb);
                    };
                    vel.requestVideoFrameCallback(cb);
                });
            }
            return { views: views.map(v => v.name), fps, primary: views[0].name };
        };

        B.quality = () => liveViews().map(v => {
            const q = v.decoder._videoEl.getVideoPlaybackQuality();
            return { name: v.name, total: q.totalVideoFrames, dropped: q.droppedVideoFrames, corrupted: q.corruptedVideoFrames };
        });

        B.beginMeasure = () => {
            const R = B.rec, su = R.startup;
            if (su.t0 != null) {   // how far warm-up got vs. a clean start
                su.warmupMs = performance.now() - su.t0;
                su.warmupFrames = window.__lucid.state.currentFrame - su.startFrame;
                su.warmupExpected = Math.round(su.warmupMs / 1000 * R.fps * (window.__lucid.state.speedMultiplier || 1));
            }
            R.mem = [B.memNow()];
            R.memTimer = setInterval(() => R.mem.push(B.memNow()), 1000);
            R.q0 = B.quality(); R.t0 = performance.now(); R.measuring = true;
        };
        B.memNow = () => {
            const m = performance.memory || {}, st = window.__lucid.state, s = st.session;
            return { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit,
                     resident: s && s.frameGroups ? s.frameGroups.size : null,
                     // frames holding cached per-frame reprojection results
                     reprojFrames: st.triangulationResults ? st.triangulationResults.size : null };
        };
        B.endMeasure = () => {
            const R = B.rec;
            R.measuring = false; R.t1 = performance.now(); R.q1 = B.quality();
            clearInterval(R.memTimer); delete R.memTimer; R.mem.push(B.memNow());
            R.endFrame = window.__lucid.state.currentFrame;
            return true;
        };
        B.uninstall = () => {
            const R = B.rec; if (!R) return;
            const vc = vc0();
            vc.callbacks.drawOverlays = R.origDraw;
            vc.callbacks.updateSeekbar = R.origSeek;
            const v3u = window.__lucid.viewport3d;
            if (v3u && R.origV3Set) v3u.setFrame = R.origV3Set;
            if (v3u && v3u.renderer && R.origV3Render) v3u.renderer.render = R.origV3Render;
            if (R.origTl && window.__lucid.timeline) window.__lucid.timeline.setCurrentFrame = R.origTl;
            liveViews().forEach((v, i) => {
                if (R.origCopy[i]) v.decoder.drawCurrentFrame = R.origCopy[i];
                if (R.origCap && R.origCap[i]) v.decoder.captureCurrentFrame = R.origCap[i];
                if (v.ctx && v.ctx.__benchWrapped) { v.ctx.drawImage = v.ctx.__benchWrapped; delete v.ctx.__benchWrapped; }
            });
            try { R.obsLT.disconnect(); } catch (e) {}
            try { R.obsLoaf && R.obsLoaf.disconnect(); } catch (e) {}
            for (const off of (R.mediaOff || [])) off();
            delete R.mediaOff;
            B.rec = null;
            return R;
        };
    }, { RVFC_ALL, VFPROBE });

    // Baseline display cadence while idle (no playback).
    const idle = await page.evaluate(() => window.__bench.idleRaf(3000));
    summary.idleRaf = dist(idle);
    log(`\n[${el()}] idle rAF interval: ${JSON.stringify(summary.idleRaf)}  ` +
        `(=> display ~${(1000 / summary.idleRaf.median).toFixed(0)} Hz)`);

    // Returns how long the (paused) seek took to show `start` in every view.
    async function seekStart(start = START) {
        const ms = await page.evaluate(async (start) => {
            const vc = window.__lucid.videoController;
            if (window.__lucid.state.isPlaying) vc.stopPlayback();
            const t = performance.now();
            await vc.seekToFrame(start);
            return performance.now() - t;
        }, start);
        await sleep(1500);
        return ms;
    }

    async function runScenario(name, { trace = false, secs = DUR } = {}) {
        const start = startOf(name);
        log(`\n[${el()}] === scenario ${name}${trace ? ' (TRACED)' : ''} === (start frame ${start})`);
        const seekMs = await seekStart(start);
        name = name.replace(/@\d+$/, '');
        await page.evaluate((name) => {
            const c = document.getElementById('visReprojections');
            const want = name !== 'noReproj';
            if (c && c.checked !== want) { c.checked = want; c.dispatchEvent(new Event('change', { bubbles: true })); }
        }, name.replace(/-traced$|#.*$/, ''));
        const base = name.replace(/-traced$|#.*$/, '');
        // trails<N> = full, with Tracks ▸ Node Trails set to N frames (issue #102
        // presets 10/50/100/250/500). Every other scenario runs with trails OFF,
        // so a trails run cannot leak into the next one.
        const trailMatch = /^trails(\d+)$/.exec(base);
        await page.evaluate((n) => { window.__lucid.state.trailLength = n; }, trailMatch ? Number(trailMatch[1]) : 0);
        const hideInfo = base === 'noInfo' || base === 'lean';
        const hide3d = base === 'no3d' || base === 'lean';
        await page.evaluate(async ({ hideInfo, hide3d }) => {
            const pv = await import('/ui/panel-visibility.js');
            const uw = await import('/ui/ui-wiring.js');
            window.__benchRestore = [];
            if (hideInfo && pv.isInfoPanelVisible()) { uw.toggleInfoPanel(); window.__benchRestore.push('info'); }
            const v3 = window.__lucid.viewport3d;
            if (hide3d && v3 && v3._visible) { uw.toggle3DViewport(); window.__benchRestore.push('3d'); }
        }, { hideInfo, hide3d });
        if (hideInfo || hide3d) await sleep(500);
        // domVideos: put each (normally detached) <video> element on the page —
        // a 4x3 px, near-transparent box in the corner — for this run only.
        // Tests whether Chrome presents/schedules an ATTACHED video differently.
        // rafFallback: hide requestVideoFrameCallback from the <video> elements
        // so startPlayback takes the app's EXISTING rAF fallback loop (redraw
        // every display refresh, index from the primary's currentTime) instead
        // of the rVFC loop driven by the primary's presented frames.
        // rvfcLoop: the previous playback loop (opt-in flag), for A/B.
        await page.evaluate((on) => { window.LUCID_PLAYBACK_LOOP = on ? 'rvfc' : undefined; }, base === 'rvfcLoop');
        if (base === 'rafFallback') {
            await page.evaluate(() => {
                for (const v of window.__lucid.state.views) {
                    const el = v.decoder && v.decoder._videoEl;
                    if (el) el.requestVideoFrameCallback = undefined;
                }
            });
        }
        if (base === 'domVideos') {
            await page.evaluate(() => {
                const box = document.createElement('div');
                box.id = '__benchVidBox';
                box.style.cssText = 'position:fixed;left:0;bottom:0;display:flex;gap:1px;opacity:0.02;pointer-events:none;z-index:99999';
                for (const v of window.__lucid.state.views) {
                    const el = v.decoder && v.decoder._videoEl; if (!el) continue;
                    el.style.cssText = 'width:4px;height:3px';
                    box.appendChild(el);
                }
                document.body.appendChild(box);
            });
            await sleep(500);
        }
        // idswitch: a synthetic ID-switch result on the first two identities whose
        // row interval (lead-in .. 1 s after) covers warm-up + measurement, selected,
        // with the tab showing — the per-frame work the ID Switches review adds.
        if (base === 'idswitch') {
            const sel = await page.evaluate(async ({ START, W }) => {
                const S = window.__lucid.state, s = S.session, fps = S.fps || 30;
                const ids = (s.identities || []).slice(0, 2);
                if (ids.length < 2) return 'needs two identities';
                const flag = { frame: START + Math.round((W + 2) * fps), startFrame: START + Math.round(fps),
                               nameA: ids[0].name, nameB: ids[1].name, identityA: ids[0].id, identityB: ids[1].id,
                               score: -80, cue: 'size', kind: 'onset', switchBackAt: null, flagged: true, continues: false };
                const key = 'size:' + flag.frame + ':' + flag.nameA + ':' + flag.nameB;
                s._idSwitch = { results: { size: { ok: true, flags: [flag], changes: [], encounters: [{}], sampleHz: 15, step: 2, fps, fpsFromVideo: true } },
                                reviewed: new Set(), fixes: [], showRepeats: false, current: key };
                const M = await import('/ui/id-switch-modal.js');
                M.refreshIdSwitchPanel(s); M.openIdSwitchPanel(); M.updateIdSwitchProgress(S.currentFrame);
                const H = await import('/ui/id-switch-highlight.js');
                return { target: H.getIdSwitchHighlight(), bar: !!document.querySelector('#idSwitchPanel .id-switch-row.is-current .id-switch-phead') };
            }, { START: start, W: WARMUP + secs });
            log(`  idswitch: ${JSON.stringify(sel)}`);
            await sleep(500);
        }
        const info = await page.evaluate((n) => window.__bench.install(n), base);
        await page.evaluate((SPEED) => {
            window.__lucid.state.speedMultiplier = SPEED;
            window.__bench.rec.startup.t0 = performance.now();
            window.__lucid.videoController.startPlayback();
        }, SPEED);
        await sleep(WARMUP * 1000);
        let tracePath = null;
        if (trace) {
            tracePath = path.join(OUT_DIR, 'trace.json');
            await browser.startTracing(page, {
                path: tracePath, screenshots: false,
                categories: [
                    '-*', 'devtools.timeline', 'disabled-by-default-devtools.timeline',
                    'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-devtools.timeline.stack',
                    'v8.execute', 'blink.user_timing', 'toplevel', 'benchmark', 'cc', 'gpu', 'viz', 'media',
                    'disabled-by-default-v8.cpu_profiler', 'latencyInfo', 'loading', 'rail',
                    // GC: MajorGC/MinorGC (+ heap before/after) and V8's per-phase
                    // GC events, so `gc` in the trace summary can say how much of
                    // the main thread garbage collection takes.
                    'v8', 'disabled-by-default-v8.gc',
                ],
            });
        }
        await page.evaluate(() => window.__bench.beginMeasure());
        await sleep(secs * 1000);
        await page.evaluate(() => window.__bench.endMeasure());
        if (trace) await browser.stopTracing();
        const R = await page.evaluate(() => {
            const R = window.__bench.uninstall();
            window.__lucid.videoController.stopPlayback();
            // The status bar's project-wide counters are not recomputed during
            // playback; stopPlayback's final redraw must leave them correct.
            // Triangulated = frames with 3D over the WHOLE project
            // (`instanceGroups`), not the resident `frameGroups` window.
            {
                const s = window.__lucid.state.session;
                let tri = 0;
                for (const [, gs] of s.instanceGroups) if (gs.some(g => g.points3d)) tri++;
                const el = document.getElementById('statusTriangulatedFrames');
                R.statusBar = { expectedTriangulated: tri, shown: el ? el.textContent : null };
            }
            R.panels = {
                infoVisible: !(window.__benchRestore || []).includes('info'),
                viewer3dVisible: !!(window.__lucid.viewport3d && window.__lucid.viewport3d._visible),
            };
            delete R.origDraw; delete R.origCopy; delete R.origCap; delete R.origSeek; delete R.origTl; delete R.origV3Set; delete R.origV3Render; delete R.obsLT; delete R.obsLoaf;
            return R;
        });
        await page.evaluate(async () => {
            const uw = await import('/ui/ui-wiring.js');
            for (const k of (window.__benchRestore || [])) {
                if (k === 'info') uw.toggleInfoPanel();
                if (k === '3d') uw.toggle3DViewport();
            }
            window.__benchRestore = [];
            window.LUCID_PLAYBACK_LOOP = undefined;          // undo rvfcLoop
            const s = window.__lucid.state.session;
            if (s && s._idSwitch) { delete s._idSwitch; (await import('/ui/id-switch-modal.js')).refreshIdSwitchPanel(s); }   // undo idswitch
            for (const v of window.__lucid.state.views) {   // undo rafFallback's shadowing
                const el = v.decoder && v.decoder._videoEl;
                if (el && Object.prototype.hasOwnProperty.call(el, 'requestVideoFrameCallback')) delete el.requestVideoFrameCallback;
            }
            const box = document.getElementById('__benchVidBox');
            if (box) {   // detach the videos again (back to the app's normal state)
                for (const el of Array.from(box.children)) { el.style.cssText = ''; box.removeChild(el); }
                box.remove();
            }
        });
        return { info, R, tracePath, seekMs, start };
    }

    // What the SCREEN showed, refresh by refresh. The display can show at most
    // `hz` images/s, so 150 fps video at 1x must skip frames even when playback
    // is perfect: the ideal advance per refresh is fps*speed/hz (1.25 at 120 Hz
    // -> steps of 1,1,1,2; 2.5 at 60 Hz -> 2,3,2,3). So judge against THAT, not
    // against "every video frame". Each refresh slot on the vsync grid shows the
    // newest frame drawn before that refresh's rAF callback (rVFC callbacks run
    // before rAF in the same rendering step); a slot with no rAF (missed vsync)
    // repeats the previous image. `stride` 2 samples every other slot: a
    // PROJECTION of a 60 Hz display from a 120 Hz run (same draw timeline; a real
    // 60 Hz display would also halve the per-refresh work, so this is
    // conservative).
    function displayed(R, periodMs, stride, phase) {
        if (!R.raf.length || !R.draws.length) return null;
        const slots = [];
        let j = -1, lastF = null, lastSlot = -1;
        for (let k = 0; k < R.raf.length; k++) {
            while (j + 1 < R.draws.length && R.draws[j + 1].t <= R.rafWall[k]) j++;
            const slot = Math.round((R.raf[k] - R.raf[0]) / periodMs);
            for (let m = lastSlot + 1; m < slot; m++) slots.push(lastF);   // missed vsync: image held
            if (j >= 0) lastF = R.draws[j].f;
            slots.push(lastF);
            lastSlot = slot;
        }
        const seq = [];
        for (let i = phase; i < slots.length; i += stride) if (slots[i] != null) seq.push(slots[i]);
        const hz = 1000 / (periodMs * stride);
        const ideal = (R.fps * SPEED) / hz;
        const lo = Math.floor(ideal), hi = Math.ceil(ideal);
        const steps = {}; let holds = 0, bigJumps = 0, bigJumpFrames = 0, back = 0, onCadence = 0;
        for (let i = 1; i < seq.length; i++) {
            const d = seq[i] - seq[i - 1];
            const k = d < 0 ? '<0' : d >= hi + 3 ? '+' + (hi + 3) + '..' : '+' + d;
            steps[k] = (steps[k] || 0) + 1;
            if (d < 0) back++;
            else if (d < lo || (d === 0 && ideal > 0)) holds++;
            else if (d > hi) { bigJumps++; bigJumpFrames += d - hi; }
            else onCadence++;
        }
        const n = Math.max(1, seq.length - 1);
        // How many refreshes each shown frame stayed on screen. Ideal: the
        // display/content ratio r = hz / (fps*speed) rounded down/up (2,2,2…
        // for 60 fps on 120 Hz; 1,1,1… with regular skips for 150 fps). A
        // frame held 3 refreshes then the next for 1 is judder even though
        // every step is "on cadence".
        const r = hz / (R.fps * SPEED);
        const rr = Math.round(r);
        const idealRun = r < 1 ? [1] : Math.abs(r - rr) < 0.05 ? [rr] : [Math.floor(r), Math.ceil(r)];
        const runs = {}; let irregular = 0, nRuns = 0, run = 1;
        for (let i = 1; i <= seq.length; i++) {
            if (i < seq.length && seq[i] === seq[i - 1]) { run++; continue; }
            if (i > 1 || run > 0) {
                // skip the first and last (truncated) runs
                if (i - run > 0 && i < seq.length) {
                    nRuns++; const k = run >= 5 ? '5+' : String(run); runs[k] = (runs[k] || 0) + 1;
                    if (idealRun.indexOf(run) < 0) irregular++;
                }
            }
            run = 1;
        }
        return {
            idealFrameDuration: idealRun,
            frameDurations: runs,
            irregularDurationPct: +(100 * irregular / Math.max(1, nRuns)).toFixed(1),
            hz: +hz.toFixed(1), idealStep: +ideal.toFixed(3), idealSteps: lo === hi ? [lo] : [lo, hi],
            refreshes: seq.length, steps,
            onCadencePct: +(100 * onCadence / n).toFixed(1),
            holds,            // refresh showed the same (or too-little-advanced) image: a stall
            bigJumps,         // advanced more than the ideal cadence allows: a visible skip
            bigJumpFrames,
            backwards: back,
            newImagesPerSec: +((n - (steps['+0'] || 0)) / (seq.length / hz)).toFixed(1),
        };
    }

    function analyze(name, info, R) {
        const wall = (R.t1 - R.t0) / 1000;
        const rafD = []; for (let i = 1; i < R.raf.length; i++) rafD.push(R.raf[i] - R.raf[i - 1]);
        const drawD = []; for (let i = 1; i < R.draws.length; i++) drawD.push(R.draws[i].t - R.draws[i - 1].t);
        const steps = {}; let skippedFrames = 0, repeats = 0, backwards = 0;
        for (let i = 1; i < R.draws.length; i++) {
            const d = R.draws[i].f - R.draws[i - 1].f;
            const k = d >= 4 ? '+4..' : d < 0 ? '<0' : (d > 0 ? '+' : '') + d;
            steps[k] = (steps[k] || 0) + 1;
            if (d > 1) skippedFrames += d - 1;
            if (d === 0) repeats++;
            if (d < 0) backwards++;
        }
        // Attribute each overlay frame-skip to the cost of the draw before it.
        let skipAfterAux = 0, skipAfterExpensive = 0, skipEvents = 0;
        for (let i = 1; i < R.draws.length; i++) {
            if (R.draws[i].f - R.draws[i - 1].f <= 1) continue;
            skipEvents++;
            const p = R.draws[i - 1];
            if (p.aux) skipAfterAux++;
            if (p.ovMs + p.vidMs + (p.seekMs || 0) > 8) skipAfterExpensive++;
        }
        const advanced = R.draws.length ? R.draws[R.draws.length - 1].f - R.draws[0].f : 0;
        const quality = R.q1.map((q, i) => ({
            name: q.name,
            presented: q.total - R.q0[i].total,
            dropped: q.dropped - R.q0[i].dropped,
            corrupted: q.corrupted - R.q0[i].corrupted,
        }));
        // drift: per secondary view, distribution of (its frame - overlaid frame)
        const driftPerView = info.views.slice(1).map((vn, j) => {
            const vals = R.draws.map(d => d.drift[j]);
            const hist = {}; for (const v of vals) { const k = v > 3 ? '>3' : v < -3 ? '<-3' : String(v); hist[k] = (hist[k] || 0) + 1; }
            const abs = vals.map(Math.abs);
            return { view: vn, meanAbs: +(abs.reduce((a, b) => a + b, 0) / (abs.length || 1)).toFixed(2), maxAbs: Math.max(0, ...abs), hist };
        });
        const primaryCT = {}; for (const d of R.draws) { const k = String(d.primaryCT); primaryCT[k] = (primaryCT[k] || 0) + 1; }
        // LoAF attribution
        const byScript = {};
        let loafTotal = 0, loafBlocking = 0;
        for (const e of R.loaf) {
            loafTotal += e.dur; loafBlocking += e.blocking || 0;
            for (const s of e.scripts) {
                const k = `${s.type}:${s.inv} ${s.fn || ''} ${s.url || ''}`.trim();
                const o = byScript[k] || (byScript[k] = { n: 0, ms: 0, fslMs: 0 });
                o.n++; o.ms += s.dur; o.fslMs += s.fsl || 0;
            }
        }
        const loafTop = Object.entries(byScript).sort((a, b) => b[1].ms - a[1].ms).slice(0, 10)
            .map(([k, v]) => ({ script: k.slice(0, 160), n: v.n, ms: Math.round(v.ms), forcedStyleLayoutMs: Math.round(v.fslMs) }));
        const rvfc = R.rvfc.map((arr, i) => {
            if (!arr.length) return null;
            const iv = []; let pfGaps = 0, mtSkips = 0;
            for (let k = 1; k < arr.length; k++) {
                iv.push(arr[k].now - arr[k - 1].now);
                if (arr[k].pf - arr[k - 1].pf > 1) pfGaps += arr[k].pf - arr[k - 1].pf - 1;
                const df = Math.round((arr[k].mt - arr[k - 1].mt) * R.fps);
                if (df > 1) mtSkips += df - 1;
            }
            return { view: info.views[i], callbacks: arr.length, hz: +(arr.length / wall).toFixed(1),
                interval: dist(iv), presentedFrameGaps: pfGaps, mediaTimeSkippedFrames: mtSkips };
        }).filter(Boolean);

        return {
            wallS: +wall.toFixed(2),
            raf: { ...dist(rafD), over33: countOver(rafD, 33.4), over17: countOver(rafD, 17.0), hz: +(R.raf.length / wall).toFixed(1) },
            appDraws: {
                count: R.draws.length, hz: +(R.draws.length / wall).toFixed(1),
                interval: dist(drawD), over33: countOver(drawD, 33.4), over20: countOver(drawD, 20),
                frameSteps: steps, skippedVideoFramesInOverlay: skippedFrames,
                skipEvents, skipEventsAfterAuxDraw: skipAfterAux, skipEventsAfterDrawOver8ms: skipAfterExpensive, repeats, backwards,
                framesAdvanced: advanced, expectedFrames: Math.round(wall * R.fps),
                effectiveSpeed: +(advanced / (wall * R.fps)).toFixed(3),
                uniqueFramesShownPerSec: +((R.draws.length - repeats) / wall).toFixed(1),
            },
            cost: {
                overlayMs: dist(R.draws.map(d => d.ovMs)),
                videoCopyMs: dist(R.draws.map(d => d.vidMs)),
                // The ~10 Hz draws that also run updateFrameInfo + timeline redraw
                // (rendering.js AUX_UPDATE_MS) vs the plain per-frame draws.
                auxDraws: R.draws.filter(d => d.aux).length,
                overlayMsAux: dist(R.draws.filter(d => d.aux).map(d => d.ovMs)),
                overlayMsPlain: dist(R.draws.filter(d => !d.aux).map(d => d.ovMs)),
                timelineMsAux: dist(R.draws.filter(d => d.aux).map(d => d.tlMs)),
                seekbarMs: dist(R.draws.filter(d => d.seekMs != null).map(d => d.seekMs)),
                totalCallbackMs: dist(R.draws.map(d => d.ovMs + d.vidMs + (d.seekMs || 0))),
                drawsWithLazyRetriangulation: R.draws.filter(d => d.lazyTri > 0).length,
                lazyRetriangulatedGroups: R.draws.reduce((a, d) => a + d.lazyTri, 0),
            },
            videoQuality: quality,
            droppedTotal: quality.reduce((a, q) => a + q.dropped, 0),
            primaryCurrentTimeVsOverlaid: primaryCT,
            interViewDrift: driftPerView,
            longTasks: { count: R.longtasks.length, totalMs: Math.round(R.longtasks.reduce((a, e) => a + e.dur, 0)), ...(() => { const d = dist(R.longtasks.map(e => e.dur)); return { median: d.median, max: d.max }; })() },
            loaf: { count: R.loaf.length, totalMs: Math.round(loafTotal), blockingMs: Math.round(loafBlocking), err: R.loafErr || null, top: loafTop },
            rvfc,
            memory: (() => {
                const m = R.mem || []; if (!m.length || m[0].used == null) return null;
                const MB = (x) => Math.round(x / 1048576);
                const used = m.map(x => x.used);
                return { usedStartMB: MB(used[0]), usedEndMB: MB(used[used.length - 1]),
                         usedMaxMB: MB(Math.max(...used)), usedMinMB: MB(Math.min(...used)),
                         totalMaxMB: MB(Math.max(...m.map(x => x.total))), limitMB: MB(m[0].limit),
                         residentStart: m[0].resident, residentEnd: m[m.length - 1].resident,
                         reprojFramesStart: m[0].reprojFrames, reprojFramesEnd: m[m.length - 1].reprojFrames };
            })(),
            media: {   // per view: <video> 'waiting' (ran out of data) / 'stalled' events
                waiting: R.waiting, stalled: R.stalled, warmupWaiting: R.warmWaiting,
                waitingTotal: R.waiting.reduce((a, b) => a + b, 0),
                warmupWaitingTotal: R.warmWaiting.reduce((a, b) => a + b, 0),
            },
            startup: R.startup && {
                firstAdvanceMs: R.startup.firstAdvanceMs == null ? null : Math.round(R.startup.firstAdvanceMs),
                warmupMs: Math.round(R.startup.warmupMs || 0),
                warmupFrames: R.startup.warmupFrames, warmupExpected: R.startup.warmupExpected,
            },
            blankOverlayDraws: R.draws.filter(d => d.blank).length,
            // per view: (frame PAINTED into the canvas) - (frame overlaid on it)
            drawnVsOverlay: (() => {
                if (!R.draws.some(d => d.drawn)) return null;
                return info.views.map((vn, i) => {
                    let n = 0, exact = 0; const h = {};
                    for (const d of R.draws) {
                        const x = d.drawn && d.drawn[i]; if (x == null) continue;
                        n++; if (x === 0) exact++; const k = String(x); h[k] = (h[k] || 0) + 1;
                    }
                    return { view: vn, n, exactPct: +(100 * exact / Math.max(1, n)).toFixed(2), hist: h };
                });
            })(),
            // max - min of the per-view frames shown in one draw (cameras out of step)
            cameraSpread: (() => {
                const h = {}; let n = 0;
                for (const d of R.draws) { if (d.spread == null) continue; n++; const k = String(d.spread); h[k] = (h[k] || 0) + 1; }
                return n ? h : null;
            })(),
            // per view: (a FRESH VideoFrame capture taken after the draw) - (overlaid index)
            videoVsOverlay: (() => {
                if (!R.draws.length || !R.draws[0].vf) return null;
                return info.views.map((vn, i) => {
                    const h = {}; let n = 0, exact = 0, abs = 0;
                    for (const d of R.draws) {
                        const x = d.vf && d.vf[i]; if (x == null) continue;
                        n++; if (x === 0) exact++; abs += Math.abs(x);
                        const k = x > 4 ? '>4' : x < -4 ? '<-4' : String(x); h[k] = (h[k] || 0) + 1;
                    }
                    return { view: vn, exactPct: +(100 * exact / Math.max(1, n)).toFixed(1), meanAbs: +(abs / Math.max(1, n)).toFixed(2), hist: h };
                });
            })(),
            screen: (() => {
                const per = summary.idleRaf && summary.idleRaf.median ? summary.idleRaf.median : 8.33;
                const native = displayed(R, per, 1, 0);
                const p60a = per < 12 ? displayed(R, per, 2, 0) : null;
                const p60b = per < 12 ? displayed(R, per, 2, 1) : null;
                return { native, projected60: p60a, projected60altPhase: p60b };
            })(),
            viewer3d: (() => {
                const sf = R.v3 ? R.v3.setFrame : [], rn = R.v3 ? R.v3.render : [];
                const iv = []; for (let i = 1; i < sf.length; i++) iv.push(sf[i].t - sf[i - 1].t);
                const st = {}; for (let i = 1; i < sf.length; i++) {
                    const d = sf[i].f - sf[i - 1].f; const k = d >= 8 ? '+8..' : d < 0 ? '<0' : (d > 0 ? '+' : '') + d;
                    st[k] = (st[k] || 0) + 1;
                }
                return {
                    updates: sf.length, updateHz: +(sf.length / wall).toFixed(1),
                    updateInterval: dist(iv), updateMs: dist(sf.map(x => x.ms)), frameSteps: st,
                    renders: rn.length, renderHz: +(rn.length / wall).toFixed(1), renderMs: dist(rn.map(x => x.ms)),
                    renderMsTotal: Math.round(rn.reduce((a, x) => a + x.ms, 0)),
                };
            })(),
        };
    }

    function printScenario(name, a) {
        log(`  rAF        : ${a.raf.hz} Hz  median ${a.raf.median}  p95 ${a.raf.p95}  p99 ${a.raf.p99}  max ${a.raf.max} ms  | >33ms: ${a.raf.over33}  >17ms: ${a.raf.over17}  (n=${a.raf.n})`);
        log(`  app draws  : ${a.appDraws.hz} Hz  interval median ${a.appDraws.interval.median}  p95 ${a.appDraws.interval.p95}  max ${a.appDraws.interval.max} ms  | >20ms: ${a.appDraws.over20}  >33ms: ${a.appDraws.over33}`);
        log(`  frame steps: ${JSON.stringify(a.appDraws.frameSteps)}  skipped=${a.appDraws.skippedVideoFramesInOverlay} repeats=${a.appDraws.repeats} backwards=${a.appDraws.backwards}`);
        log(`  skip cause : ${a.appDraws.skipEvents} skip events; after an aux draw: ${a.appDraws.skipEventsAfterAuxDraw}; after a draw > 8 ms: ${a.appDraws.skipEventsAfterDrawOver8ms}`);
        log(`  advance    : ${a.appDraws.framesAdvanced}/${a.appDraws.expectedFrames} frames (speed ${a.appDraws.effectiveSpeed}x), unique frames shown ${a.appDraws.uniqueFramesShownPerSec}/s`);
        log(`  cost/draw  : overlay median ${a.cost.overlayMs.median} p95 ${a.cost.overlayMs.p95} max ${a.cost.overlayMs.max} ms | video copies median ${a.cost.videoCopyMs.median} p95 ${a.cost.videoCopyMs.p95} ms | lazy re-tri draws ${a.cost.drawsWithLazyRetriangulation}`);
        log(`  aux split  : ${a.cost.auxDraws} aux draws — overlay(aux) median ${a.cost.overlayMsAux.median} p95 ${a.cost.overlayMsAux.p95} max ${a.cost.overlayMsAux.max} [timeline ${a.cost.timelineMsAux.median}] | overlay(plain) median ${a.cost.overlayMsPlain.median} p95 ${a.cost.overlayMsPlain.p95} max ${a.cost.overlayMsPlain.max} | seekbar+3D p95 ${a.cost.seekbarMs.p95} max ${a.cost.seekbarMs.max} | whole callback median ${a.cost.totalCallbackMs.median} p95 ${a.cost.totalCallbackMs.p95}`);
        if (a.memory) log(`  JS heap    : used ${a.memory.usedStartMB} -> ${a.memory.usedEndMB} MB (min ${a.memory.usedMinMB}, max ${a.memory.usedMaxMB}; allocated max ${a.memory.totalMaxMB} of limit ${a.memory.limitMB} MB) | resident frame groups ${a.memory.residentStart} -> ${a.memory.residentEnd} | frames with cached reprojection results ${a.memory.reprojFramesStart} -> ${a.memory.reprojFramesEnd}`);
        if (a.startup) log(`  startup    : seek to start ${a.seekToStartMs != null ? Math.round(a.seekToStartMs) + ' ms' : '?'} | play -> first new frame ${a.startup.firstAdvanceMs} ms | warm-up advanced ${a.startup.warmupFrames}/${a.startup.warmupExpected} frames`);
        log(`  <video> wait: measured ${a.media.waitingTotal} 'waiting' (${a.media.waiting.join(' ')}), ${a.media.stalled.reduce((x, y) => x + y, 0)} 'stalled' | warm-up ${a.media.warmupWaitingTotal} 'waiting'`);
        log(`  dropped    : total ${a.droppedTotal} — ` + a.videoQuality.map(q => `${q.name.replace(/^Camera/, 'C')}:${q.dropped}/${q.presented}`).join(' '));
        {
            const sc = a.screen || {};
            const fmt = (lab, x) => x ? log(`  ${lab}: ${x.newImagesPerSec} new images/s, ideal step ${x.idealStep} (${x.idealSteps.join('/')}) | on-cadence ${x.onCadencePct}%  holds ${x.holds}  big-jumps ${x.bigJumps} (+${x.bigJumpFrames} fr)  back ${x.backwards} | steps ${JSON.stringify(x.steps)} | frame on screen (refreshes, ideal ${x.idealFrameDuration.join('/')}) ${JSON.stringify(x.frameDurations)} irregular ${x.irregularDurationPct}%`) : null;
            fmt(`screen ${sc.native ? sc.native.hz : '?'}Hz`, sc.native);
            fmt('proj. 60Hz ', sc.projected60);
            fmt('proj. 60Hz*', sc.projected60altPhase);
            if (a.drawnVsOverlay) log(`  painted/ovl: (frame painted into canvas - frame overlaid) ` + a.drawnVsOverlay.map(v => `${v.view}: ${v.exactPct}% exact of ${v.n}`).join('  '));
            if (a.cameraSpread) log(`  cam spread : (max - min frame across cameras per draw) ${JSON.stringify(a.cameraSpread)}`);
            if (a.videoVsOverlay) log(`  fresh/ovl  : (fresh capture after draw - frame overlaid) ` + a.videoVsOverlay.map(v => `${v.view}: ${v.exactPct}% exact, |${v.meanAbs}| ${JSON.stringify(v.hist)}`).join('  '));
            log(`  blank ovl  : ${a.blankOverlayDraws} draws hit a non-hydrated lazy frame (overlay cleared, nothing drawn)`);
        }
        log(`  primary ct : (currentTime frame - overlaid frame) ${JSON.stringify(a.primaryCurrentTimeVsOverlaid)}`);
        log(`  drift      : ` + a.interViewDrift.map(d => `${d.view.replace(/^Camera/, 'C')} |${d.meanAbs}| max ${d.maxAbs}`).join('  '));
        log(`  long tasks : ${a.longTasks.count} (total ${a.longTasks.totalMs} ms, max ${a.longTasks.max})  | LoAF ${a.loaf.count} (total ${a.loaf.totalMs} ms, blocking ${a.loaf.blockingMs} ms)`);
        for (const t of a.loaf.top.slice(0, 5)) log(`     LoAF ${String(t.ms).padStart(6)} ms  n=${t.n}  fsl=${t.forcedStyleLayoutMs}  ${t.script}`);
        { const v = a.viewer3d; log(`  3D viewer  : ${v.updateHz} updates/s (interval median ${v.updateInterval.median} p95 ${v.updateInterval.p95} ms), frame steps ${JSON.stringify(v.frameSteps)} | update cost median ${v.updateMs.median} p95 ${v.updateMs.p95} max ${v.updateMs.max} ms | ${v.renderHz} renders/s, render median ${v.renderMs.median} p95 ${v.renderMs.p95} ms (total ${v.renderMsTotal} ms)`); }
        for (const r of a.rvfc) log(`  rVFC ${r.view.replace(/^Camera/, 'C')}: ${r.hz} Hz  iv med ${r.interval.median} p95 ${r.interval.p95} max ${r.interval.max}  pfGaps ${r.presentedFrameGaps}  mtSkips ${r.mediaTimeSkippedFrames}`);
    }

    // DIAG3D=1: where are the 3D skeletons relative to the cameras and the 3D
    // view's camera? (Seeks to START, then fits the view like the app does.)
    if (process.env.DIAG3D === '1') {
        await seekStart();
        const d = await page.evaluate(() => {
            const vp = window.__lucid.viewport3d, st = window.__lucid.state;
            if (!vp) return { err: 'no viewport3d' };
            const box = (pts) => {
                if (!pts.length) return null;
                const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
                for (const p of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
                return { lo: lo.map(v => +v.toFixed(1)), hi: hi.map(v => +v.toFixed(1)) };
            };
            const cams = vp.cameras.map(c => vp._computeCameraPosition(c.rotationMatrix, c.tvec));
            const nodes = [];
            vp._skeletonGroup.traverse(o => { if (o.name && o.name.indexOf('node_') === 0) nodes.push([o.position.x, o.position.y, o.position.z]); });
            const groups = (st.session.instanceGroups.get(st.currentFrame) || []);
            const raw = groups.map(g => g.points3d ? Array.from(g.points3d).slice(0, 6).map(v => +(+v).toFixed(1)) : null);
            const before = { pos: vp.threeCamera.position.toArray().map(v => +v.toFixed(1)), target: vp.controls.target.toArray().map(v => +v.toFixed(1)) };
            const inView = () => {
                vp.threeCamera.updateMatrixWorld(); vp.threeCamera.updateProjectionMatrix();
                const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(vp.threeCamera.projectionMatrix, vp.threeCamera.matrixWorldInverse));
                return { nodes: nodes.filter(p => fr.containsPoint(new THREE.Vector3(p[0], p[1], p[2]))).length + '/' + nodes.length,
                         cams: cams.filter(p => fr.containsPoint(new THREE.Vector3(p[0], p[1], p[2]))).length + '/' + cams.length };
            };
            const inViewBefore = inView();
            vp.fitToScene();
            return {
                frame: st.currentFrame, sceneScale: vp._sceneScale, nodeSize: vp.skeletonNodeSize,
                groupsAtFrame: groups.length, rawPoints3dHead: raw,
                cameraBox: box(cams), skeletonBox: box(nodes), nNodes: nodes.length,
                viewBefore: before, inViewBefore,
                viewAfterFit: { pos: vp.threeCamera.position.toArray().map(v => +v.toFixed(1)), target: vp.controls.target.toArray().map(v => +v.toFixed(1)), near: vp.threeCamera.near, far: vp.threeCamera.far },
                inViewAfterFit: inView(),
            };
        });
        log(`\n[${el()}] DIAG3D: ${JSON.stringify(d, null, 1)}`);
        summary.diag3d = d;
    }

    // ---------------------------------------------------------------------
    // SEEKS: paused random jumps (+ forward steps), each into video no
    // scenario played — what a jump costs when the bytes are not cached.
    // ---------------------------------------------------------------------
    async function runSeeks() {
        log(`\n[${el()}] === seeks: ${SEEK_TARGETS.length || SEEKS} ${SEEK_TARGETS.length ? 'listed' : 'random'} jumps x ${STEPS} forward steps (paused) ===`);
        const playedS = SCENARIOS.map(n => [startOf(n), (WARMUP + DUR + 3) * SPEED]);
        const r = await page.evaluate(async ({ SEEKS, STEPS, playedS, SEED, SEEK_TARGETS }) => {
            const st = window.__lucid.state, vc = window.__lucid.videoController;
            const played = playedS.map(([a, secs]) => [a, a + Math.ceil(secs * (st.fps || 30))]);
            if (st.isPlaying) vc.stopPlayback();
            let seed = SEED; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
            const n = st.totalFrames, targets = SEEK_TARGETS.length ? SEEK_TARGETS.slice() : [];
            // spread over the file: one target per equal slice, avoiding played ranges (+-600 frames)
            for (let i = 0; i < (SEEK_TARGETS.length ? 0 : SEEKS); i++) {
                for (let tries = 0; tries < 50; tries++) {
                    const f = Math.floor((i + rnd()) / SEEKS * (n - STEPS - 2));
                    if (!played.some(([a, b]) => f > a - 600 && f < b + 600)) { targets.push(f); break; }
                }
            }
            const jumps = [], steps = [];
            for (const f of targets) {
                let t = performance.now(); await vc.seekToFrame(f); jumps.push({ f, ms: performance.now() - t });
                for (let k = 1; k <= STEPS; k++) {
                    t = performance.now(); await vc.seekToFrame(f + k); steps.push(performance.now() - t);
                }
                await new Promise(r => setTimeout(r, 300));
            }
            const m = performance.memory || {};
            return { jumps, steps, usedMB: Math.round((m.usedJSHeapSize || 0) / 1048576), resident: st.session.frameGroups.size };
        }, { SEEKS, STEPS, playedS, SEED, SEEK_TARGETS });
        summary.seeks = { order: SEEKS_FIRST ? 'before scenarios' : 'after scenarios', heapUsedMBAfter: r.usedMB, residentAfter: r.resident, jumps: r.jumps.map(j => ({ f: j.f, ms: Math.round(j.ms) })), jumpMs: dist(r.jumps.map(j => j.ms)), stepMs: dist(r.steps) };
        log(`  jump (all views show a random frame): ${JSON.stringify(summary.seeks.jumpMs)}`);
        log(`  jumps: ` + summary.seeks.jumps.map(j => `${j.f}:${j.ms}`).join(' '));
        log(`  step (+1 frame after a jump)        : ${JSON.stringify(summary.seeks.stepMs)}`);
        log(`  (${summary.seeks.order}; JS heap used after ${r.usedMB} MB, resident frame groups ${r.resident})`);
        fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
    }

    if (SEEKS > 0 && SEEKS_FIRST) await runSeeks();

    for (const name of SCENARIOS) {
        const { info, R, seekMs, start } = await runScenario(name);
        const a = analyze(name, info, R);
        a.seekToStartMs = seekMs;
        summary.scenarios[name] = { start, views: info.views, primary: info.primary, panels: R.panels, statusBar: R.statusBar, ...a };
        if (process.env.RAW === '1') {
            fs.writeFileSync(path.join(OUT_DIR, `raw-${name.replace(/[^a-z0-9#-]/gi, '_')}.json`), JSON.stringify({
                fps: R.fps, speed: SPEED, idleRafMedian: summary.idleRaf && summary.idleRaf.median,
                raf: R.raf, rafWall: R.rafWall,
                draws: R.draws.map(d => ({ t: d.t, f: d.f, spread: d.spread, drawn: d.drawn })),
            }));
        }
        log(`  panels     : ${JSON.stringify(R.panels)}`);
        {
            const sb = R.statusBar || {};
            const ok = sb.shown === `Triangulated: ${sb.expectedTriangulated}`;
            log(`  status bar : ${ok ? 'OK' : 'STALE'} after stop — shows "${sb.shown}", expected ${sb.expectedTriangulated}`);
            if (!ok) summary.statusBarStale = (summary.statusBarStale || 0) + 1;
        }
        printScenario(name, a);
        fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
    }

    if (SEEKS > 0 && !SEEKS_FIRST) await runSeeks();

    // ---------------------------------------------------------------------
    // Traced pass (separate, so tracing overhead never pollutes the metrics).
    // ---------------------------------------------------------------------
    if (TRACE_SECS > 0) {
        const { info, R, tracePath } = await runScenario('full-traced', { trace: true, secs: TRACE_SECS });
        const a = analyze('full-traced', info, R);
        summary.scenarios['full-traced'] = { views: info.views, ...a };
        printScenario('full-traced', a);
        summary.trace = { path: tracePath, ...analyzeTrace(tracePath) };
        log(`\n[${el()}] trace: ${tracePath} (${(fs.statSync(tracePath).size / 1e6).toFixed(1)} MB)`);
        log(JSON.stringify({ ...summary.trace, gc: undefined, cpuProfileSelfTop: undefined }, null, 1).slice(0, 6000));
        log(`  GC (main thread, inclusive): ${JSON.stringify(summary.trace.gc.main)}`);
        log(`  MajorGCs: ${JSON.stringify(summary.trace.gc.majorGCs)}`);
        log(`  CPU profile self time: ${JSON.stringify(summary.trace.cpuProfileSelfTop.slice(0, 20))}`);
    }
} catch (err) {
    console.error(`[${el()}] FATAL`, String(err && err.stack || err).slice(0, 1200));
    summary.fatal = String(err && err.stack || err).slice(0, 1200);
} finally {
    fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
    log(`\nsummary: ${path.join(OUT_DIR, 'summary.json')}`);
    if (browser && !process.env.KEEP_OPEN) { try { await browser.close(); } catch (e) {} }
    await releaseBrowserLock({ refocus: !process.env.KEEP_OPEN });
    server.kill();
}

// ---------------------------------------------------------------------------
// Trace analysis: per-thread busy time, renderer-main self time by event, JS
// function totals, and compositor frame outcomes (PipelineReporter states).
// ---------------------------------------------------------------------------
function analyzeTrace(p) {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ev = Array.isArray(raw) ? raw : raw.traceEvents;
    const threadName = new Map(), procName = new Map();
    for (const e of ev) {
        if (e.ph === 'M' && e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args.name);
        if (e.ph === 'M' && e.name === 'process_name') procName.set(e.pid, e.args.name);
    }
    let tMin = Infinity, tMax = -Infinity;
    const byThread = new Map();
    for (const e of ev) {
        if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
        tMin = Math.min(tMin, e.ts); tMax = Math.max(tMax, e.ts + e.dur);
        const k = `${e.pid}:${e.tid}`;
        let a = byThread.get(k); if (!a) byThread.set(k, a = []);
        a.push(e);
    }
    const windowMs = (tMax - tMin) / 1000;
    // busy = union of top-level X events per thread
    function busyAndSelf(list) {
        list.sort((x, y) => x.ts - y.ts || y.dur - x.dur);
        let busy = 0, curEnd = -Infinity;
        const self = new Map();
        const stack = [];
        for (const e of list) {
            while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
            const end = e.ts + e.dur;
            if (!stack.length) { if (e.ts >= curEnd) { busy += e.dur; curEnd = end; } else if (end > curEnd) { busy += end - curEnd; curEnd = end; } }
            if (stack.length) { const par = stack[stack.length - 1]; par.childDur += e.dur; }
            const node = { e, end, childDur: 0 };
            stack.push(node);
            node.flush = true;
            e.__node = node;
        }
        for (const e of list) {
            const n = e.__node; const s = Math.max(0, e.dur - n.childDur);
            let label = e.name;
            if (e.name === 'FunctionCall' && e.args && e.args.data) {
                const d = e.args.data;
                label = `FunctionCall ${d.functionName || '(anon)'} ${(d.url || '').replace(/^.*\/\/[^/]+/, '')}:${d.lineNumber ?? ''}`;
            }
            self.set(label, (self.get(label) || 0) + s);
            delete e.__node;
        }
        return { busy, self };
    }
    const threads = [];
    let mainKey = null, mainBusy = -1;
    for (const [k, list] of byThread) {
        const name = threadName.get(k) || '?';
        const pid = Number(k.split(':')[0]);
        const { busy, self } = busyAndSelf(list);
        threads.push({ k, name, proc: procName.get(pid) || '?', busyMs: +(busy / 1000).toFixed(1), self });
        if (name === 'CrRendererMain' && busy > mainBusy) { mainBusy = busy; mainKey = k; }
    }
    threads.sort((a, b) => b.busyMs - a.busyMs);
    const main = threads.find(t => t.k === mainKey);
    const mainTop = main ? [...main.self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
        .map(([n, us]) => ({ name: n.slice(0, 140), selfMs: +(us / 1000).toFixed(1) })) : [];
    // JS functions by inclusive FunctionCall time on main
    const fnIncl = new Map();
    for (const e of (byThread.get(mainKey) || [])) {
        if (e.name !== 'FunctionCall' || !e.args || !e.args.data) continue;
        const d = e.args.data;
        const k = `${d.functionName || '(anon)'} ${(d.url || '').replace(/^.*\/\/[^/]+/, '')}:${d.lineNumber ?? ''}`;
        const o = fnIncl.get(k) || { n: 0, us: 0 }; o.n++; o.us += e.dur; fnIncl.set(k, o);
    }
    const fnTop = [...fnIncl.entries()].sort((a, b) => b[1].us - a[1].us).slice(0, 15)
        .map(([k, o]) => ({ fn: k.slice(0, 140), n: o.n, inclMs: +(o.us / 1000).toFixed(1) }));
    // compositor frame outcomes
    const states = {}, reasons = {};
    for (const e of ev) {
        if (e.name !== 'PipelineReporter' || !e.args) continue;
        const r = e.args.chrome_frame_reporter || (e.args.data && e.args.data.chrome_frame_reporter);
        if (!r) continue;
        states[r.state] = (states[r.state] || 0) + 1;
        if (r.state && r.state !== 'STATE_PRESENTED_ALL' && r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    }
    const named = {};
    for (const e of ev) {
        if (/^(DroppedFrame|NeedsBeginFrameChanged|BeginFrame|DrawFrame|Commit|ActivateLayerTree|Screenshot|VideoFrameCompositor::|VideoRendererAlgorithm|PaintCanvasVideoRenderer|WebMediaPlayerImpl::Paint|VideoFrameSubmitter)/.test(e.name)) {
            named[e.name] = (named[e.name] || 0) + 1;
        }
    }
    return {
        windowMs: +windowMs.toFixed(0),
        threads: threads.slice(0, 18).map(t => ({ thread: t.name, proc: t.proc, busyMs: t.busyMs, busyPct: +(100 * t.busyMs / windowMs).toFixed(1) })),
        rendererMainSelfTop: mainTop,
        jsFunctionsInclusive: fnTop,
        pipelineReporterStates: states,
        pipelineReporterNonPresentedReasons: reasons,
        frameEventCounts: named,
        gc: gcSummary(ev, mainKey, threadName),
        cpuProfileSelfTop: cpuProfileSelf(ev, mainKey),
    };
}

// Garbage collection on the renderer main thread (and, separately, on V8's
// background threads, where concurrent marking runs). Every GC-named event is
// listed by name with its INCLUSIVE time — MajorGC contains V8.GC_* phases, so
// the rows overlap; read `MajorGC` + `MinorGC` for the total pause.
function gcSummary(ev, mainKey, threadName) {
    const isGc = (n) => /GC|Scavenge|MarkCompact|Mark-Compact|Sweep|Compactor/.test(n);
    const main = new Map(), bg = new Map();
    const majors = [];
    const open = new Map();   // B/E pairs
    const add = (m, name, us) => { const o = m.get(name) || { n: 0, ms: 0 }; o.n++; o.ms += us / 1000; m.set(name, o); };
    for (const e of ev) {
        if (!e.name || !isGc(e.name)) continue;
        const k = `${e.pid}:${e.tid}`;
        let dur = null;
        if (e.ph === 'X' && typeof e.dur === 'number') dur = e.dur;
        else if (e.ph === 'B') { open.set(k + e.name, e.ts); continue; }
        else if (e.ph === 'E') { const t = open.get(k + e.name); if (t == null) continue; open.delete(k + e.name); dur = e.ts - t; }
        if (dur == null) continue;
        if (k === mainKey) {
            add(main, e.name, dur);
            if (e.name === 'MajorGC' && e.args) majors.push({ ms: +(dur / 1000).toFixed(1), beforeMB: Math.round((e.args.usedHeapSizeBefore || 0) / 1048576), afterMB: Math.round((e.args.usedHeapSizeAfter || 0) / 1048576), type: e.args.type || null });
        } else add(bg, (threadName.get(k) || '?') + ' ' + e.name, dur);
    }
    const top = (m) => [...m.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 18).map(([name, o]) => ({ name, n: o.n, ms: +o.ms.toFixed(1) }));
    return { main: top(main), background: top(bg), majorGCs: majors.slice(0, 40) };
}

// Self time per JS function from the sampling CPU profiler's ProfileChunks
// (the main thread's profile = the one with the most samples). Includes V8's
// synthetic nodes — `(garbage collector)` is GC time as the profiler saw it.
function cpuProfileSelf(ev) {
    const profiles = new Map();   // id -> { nodes: Map, self: Map, samples }
    for (const e of ev) {
        if (e.name !== 'ProfileChunk' || !e.args || !e.args.data) continue;
        const id = `${e.pid}:${e.id}`;
        let p = profiles.get(id); if (!p) profiles.set(id, p = { nodes: new Map(), self: new Map(), samples: 0 });
        const cp = e.args.data.cpuProfile || {};
        for (const n of (cp.nodes || [])) p.nodes.set(n.id, n);
        const samples = cp.samples || [], deltas = e.args.data.timeDeltas || [];
        for (let i = 0; i < samples.length; i++) {
            const d = deltas[i] || 0;
            p.self.set(samples[i], (p.self.get(samples[i]) || 0) + d);
            p.samples++;
        }
    }
    let best = null; for (const p of profiles.values()) if (!best || p.samples > best.samples) best = p;
    if (!best) return [];
    const byFn = new Map();
    for (const [nid, us] of best.self) {
        const n = best.nodes.get(nid); const cf = (n && n.callFrame) || {};
        const k = `${cf.functionName || '(anon)'} ${(cf.url || '').replace(/^.*\/\/[^/]+/, '').replace(/\?.*$/, '')}:${cf.lineNumber ?? ''}`;
        byFn.set(k, (byFn.get(k) || 0) + us);
    }
    let total = 0; for (const v of byFn.values()) total += v;
    return [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
        .map(([fn, us]) => ({ fn: fn.slice(0, 140), selfMs: +(us / 1000).toFixed(1), pct: +(100 * us / Math.max(1, total)).toFixed(1) }));
}
