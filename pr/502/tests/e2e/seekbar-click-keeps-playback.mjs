/**
 * seekbar-click-keeps-playback.mjs — a click or drag on the transport seekbar
 * leaves the video playing or paused, whichever it was.
 *
 * A scrub always stops playback (`VideoController.scrubToFrame`: the play loop
 * and the scrub must not fight over the frame), and the seekbar used to leave
 * it there — clicking the bar of a PLAYING video paused it at the new spot.
 * The bar now resumes on release (`resumeAfterScrub`), once the scrub has
 * landed. Asserted through real mouse events on #seekbar:
 *
 *  1. Paused + click: lands on the clicked frame and STAYS paused.
 *  2. Playing + click: plays on FROM the clicked frame (every shown view's
 *     native seek went there, then played), and the frame keeps advancing.
 *  3. Playing + drag: paused while the button is held (the scrub shows the
 *     frames), playing again from the release point.
 *  4. Two quick clicks on a playing video, the second before the first one's
 *     resume has started (decodes slowed down): still playing, from the
 *     SECOND click — the pending resume counts as "playing".
 *  5. A step (ArrowRight) inside that same window cancels the resume: paused.
 *  6. `resumeAfterScrub(prepare)` waits for `prepare` (how a lazy project
 *     hydrates the frames ahead, as Play does) before playing.
 *  7. Video-less project (skeleton + 3D, timer-driven playback): a click on
 *     the bar while playing keeps playing from there; paused stays paused.
 *
 * Fake decoders: frame f paints rgb(f % 256, 40 * viewIndex, 7), and while
 * "playing" a decoder's index advances with wall-clock time at 30 fps.
 *
 * Run: node tests/e2e/seekbar-click-keeps-playback.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8213);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;   // absent demo assets
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    const N = 3000;
    const CAMS = ['camA', 'camB'];

    // A 2-camera session, every view backed by a fake decoder.
    await page.evaluate(async ({ camNames, N }) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const cams = camNames.map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
        const session = new Session(cams, skel, ['track_0'], 'S1');

        window.__decodeDelay = 0;   // ms per getFrame — section 4/5 widen the resume window
        function fakeDecoder(vi) {
            const src = document.createElement('canvas');
            src.width = 64; src.height = 48;
            const sctx = src.getContext('2d');
            const d = {
                samples: new Array(N), _fps: 30, _videoReady: true,
                playing: false, pos: 0, t0: 0, seeks: [],
                async getFrame(f) {
                    if (window.__decodeDelay) await new Promise(r => setTimeout(r, window.__decodeDelay));
                    sctx.fillStyle = `rgb(${f % 256},${40 * vi},7)`;
                    sctx.fillRect(0, 0, 64, 48);
                    return createImageBitmap(src);
                },
                drawCurrentFrame(ctx, w, h) {
                    ctx.fillStyle = `rgb(${d.getCurrentFrameIndex() % 256},${40 * vi},7)`;
                    ctx.fillRect(0, 0, w, h);
                    return true;
                },
                getCurrentFrameIndex() {
                    if (!d.playing) return d.pos;
                    return Math.min(N - 1, d.pos + Math.floor((performance.now() - d.t0) * 30 / 1000));
                },
                seekNativeSettled(f) { d.seeks.push(f); d.pos = f; return Promise.resolve(); },
                playNative() { d.playing = true; d.t0 = performance.now(); },
                pauseNative() { if (d.playing) d.pos = d.getCurrentFrameIndex(); d.playing = false; },
                releaseFrames() {},
            };
            return d;
        }

        AS.state.sessions = [session];
        AS.state.session = session;
        AS.state.activeSessionIdx = 0;
        AS.state.totalFrames = N;
        AS.state.fps = 30;
        AS.state.currentFrame = 0;
        AS.state.views = cams.map((c, i) => ({
            name: c.name, videoWidth: 640, videoHeight: 480, canvas: null, decoder: fakeDecoder(i),
        }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        AS.state.viewMode = 'grid';
        AS.state.singleViewIndex = 0;
        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();

        // The frame the last press / drag position on the bar names, from the
        // event's own clientX and ui-wiring's frameAtFraction rounding.
        const bar = document.getElementById('seekbar');
        const frameOf = (e) => {
            const r = bar.getBoundingClientRect();
            return Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (N - 1));
        };
        window.__barFrame = null;
        bar.addEventListener('mousedown', (e) => { window.__barFrame = frameOf(e); }, true);
        document.addEventListener('mousemove', (e) => { if (e.buttons & 1) window.__barFrame = frameOf(e); }, true);
        await new Promise(r => requestAnimationFrame(r));
    }, { camNames: CAMS, N });

    const wait = (ms) => page.evaluate(ms => new Promise(r => setTimeout(r, ms)), ms);
    // The controller is idle: no scrub in flight or queued, no resume pending.
    const settle = () => page.evaluate(async () => {
        const vc = window.__lucid.videoController;
        for (let i = 0; i < 300; i++) {
            await new Promise(r => requestAnimationFrame(r));
            if (!vc._isSeeking && vc._scrubTarget === null && !vc.resumePending) break;
        }
        await new Promise(r => setTimeout(r, 60));
    });
    const snap = () => page.evaluate(() => {
        const AS = window.__lucid;
        return {
            frame: AS.state.currentFrame,
            playing: AS.state.isPlaying,
            pending: !!AS.videoController.resumePending,
            button: document.getElementById('btnPlay').textContent,
            views: AS.state.views.filter(v => v.decoder)
                .map(v => ({ playing: v.decoder.playing, seeks: v.decoder.seeks.slice() })),
        };
    });
    const clearSeeks = () => page.evaluate(() => { for (const v of window.__lucid.state.views) v.decoder.seeks.length = 0; });

    // Page x for a fraction along the bar, and the frame a press there seeks to
    // (same rounding as ui-wiring's frameAtFraction).
    const bar = await page.evaluate(() => {
        const r = document.getElementById('seekbar').getBoundingClientRect();
        return { left: r.left, width: r.width, y: r.top + r.height / 2 };
    });
    const at = (frac) => Math.round(bar.left + frac * bar.width);
    const barFrame = () => page.evaluate(() => window.__barFrame);
    const click = async (frac) => {
        await page.mouse.move(at(frac), bar.y);
        await page.mouse.down();
        await page.mouse.up();
        return barFrame();
    };
    const play = async () => {
        await page.evaluate(() => window.__lucid.videoController.startPlayback());
        await wait(200);
    };
    const pause = async () => {
        await page.evaluate(() => window.__lucid.videoController.pausePlayback());
        await settle();
    };

    const PLAY_ICON = '▶', PAUSE_ICON = '❚❚';
    await settle();

    // =================================================================
    // 1 — paused + click: lands there, stays paused
    // =================================================================
    let f = await click(0.5);
    await settle();
    let s = await snap();
    check(s.frame === f, `paused click: lands on frame ${f} (at ${s.frame})`);
    check(!s.playing && s.views.every(v => !v.playing), 'paused click: still paused, no view playing');
    check(s.button === PLAY_ICON, `paused click: the button still shows Play (${JSON.stringify(s.button)})`);

    // =================================================================
    // 2 — playing + click: plays on from the clicked frame
    // =================================================================
    await play();
    s = await snap();
    check(s.playing && s.views.every(v => v.playing), 'precondition: playing');
    await clearSeeks();
    f = await click(0.2);
    await settle();
    s = await snap();
    check(s.playing, `playing click: still playing after the click (isPlaying ${s.playing})`);
    check(s.views.every(v => v.playing), 'playing click: every shown view plays');
    check(s.views.every(v => v.seeks[v.seeks.length - 1] === f),
        `playing click: every view's playback started at the clicked frame ${f} (seeks ${JSON.stringify(s.views.map(v => v.seeks))})`);
    check(s.button === PAUSE_ICON, `playing click: the button shows Pause (${JSON.stringify(s.button)})`);
    const f0 = s.frame;
    await wait(400);
    s = await snap();
    check(s.frame > f0 && s.frame >= f && s.frame < f + 60,
        `playing click: the frame advances from ${f} (${f0} -> ${s.frame})`);

    // =================================================================
    // 3 — playing + drag: paused while held, playing from the release point
    // =================================================================
    s = await snap();
    check(s.playing, 'precondition: playing before the drag');
    await clearSeeks();
    const a = at(0.3), b = at(0.7);
    await page.mouse.move(a, bar.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
        await page.mouse.move(a + (b - a) * i / 8, bar.y);
        await wait(30);
    }
    const released = await barFrame();
    await wait(150);
    s = await snap();
    check(!s.playing && s.views.every(v => !v.playing), 'drag: paused while the button is held');
    await page.mouse.up();
    await settle();
    s = await snap();
    check(s.playing && s.views.every(v => v.playing), 'drag: playing again after the release');
    check(s.views.every(v => v.seeks[v.seeks.length - 1] === released),
        `drag: playback restarted at the release frame ${released} (seeks ${JSON.stringify(s.views.map(v => v.seeks))})`);

    // =================================================================
    // 4 — two quick clicks while playing: still playing, from the second
    // =================================================================
    await page.evaluate(() => { window.__decodeDelay = 250; });
    await clearSeeks();
    const f1 = await click(0.4);
    s = await snap();
    check(!s.playing && s.pending, `slow decode: between the clicks the resume is pending (playing ${s.playing}, pending ${s.pending})`);
    const f2 = await click(0.6);
    await settle();
    s = await snap();
    check(s.playing && s.views.every(v => v.playing), 'two quick clicks: still playing');
    check(s.views.every(v => v.seeks.length === 1 && v.seeks[0] === f2),
        `two quick clicks: one restart, at the SECOND click's frame ${f2}, not ${f1} (seeks ${JSON.stringify(s.views.map(v => v.seeks))})`);

    // =================================================================
    // 5 — a step inside the resume window cancels it
    // =================================================================
    await click(0.5);
    s = await snap();
    check(s.pending, 'step: the resume is pending before the step');
    await page.evaluate(() => document.body.focus());
    await page.keyboard.press('ArrowRight');
    await settle();
    await wait(300);
    s = await snap();
    check(!s.playing && !s.pending && s.views.every(v => !v.playing),
        `step during the resume window: paused (playing ${s.playing}, pending ${s.pending})`);
    await page.evaluate(() => { window.__decodeDelay = 0; });

    // =================================================================
    // 6 — resumeAfterScrub waits for `prepare`
    // =================================================================
    const r6 = await page.evaluate(async () => {
        const vc = window.__lucid.videoController;
        let preparedAt = null;
        vc.scrubToFrame(1234);
        vc.resumeAfterScrub(frame => new Promise(r => { preparedAt = frame; setTimeout(r, 250); }));
        await new Promise(r => setTimeout(r, 120));
        const during = window.__lucid.state.isPlaying;
        await new Promise(r => setTimeout(r, 400));
        const after = window.__lucid.state.isPlaying;
        return { preparedAt, during, after };
    });
    check(r6.preparedAt === 1234, `prepare is handed the frame the scrub landed on (${r6.preparedAt})`);
    check(!r6.during, 'prepare: not playing while prepare is still running');
    check(r6.after, 'prepare: playing once prepare resolved');
    await pause();

    // =================================================================
    // 7 — video-less project: timer-driven playback keeps going too
    // =================================================================
    await page.evaluate(async () => {
        const AS = window.__lucid;
        for (const v of AS.state.views) v.decoder = null;
        await new Promise(r => requestAnimationFrame(r));
    });
    check(!(await page.evaluate(async () => (await import('/ui/app-state.js')).hasRealVideo())), 'precondition: no real video');
    await page.click('#btnPlay');
    await wait(150);
    s = await snap();
    check(s.playing, 'no video: Play starts the timer playback');
    f = await click(0.25);
    await wait(300);
    s = await snap();
    check(s.playing, `no video, playing click: still playing (isPlaying ${s.playing})`);
    check(s.frame > f && s.frame < f + 30, `no video, playing click: advancing from ${f} (at ${s.frame})`);
    await page.click('#btnPlay');
    await wait(100);
    s = await snap();
    check(!s.playing, 'no video: Play again pauses (one press — no stale timer)');
    f = await click(0.75);
    await wait(300);
    s = await snap();
    check(!s.playing && s.frame === f, `no video, paused click: paused at ${f} (at ${s.frame}, playing ${s.playing})`);

    await browser.close();
} catch (e) {
    console.log('  ✗ threw:', e && e.message ? e.message : String(e));
    fails++;
    if (browser) await browser.close().catch(() => {});
} finally {
    server.kill();
}

console.log(fails === 0 ? '\nseekbar-click-keeps-playback: PASS' : `\nseekbar-click-keeps-playback: FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
