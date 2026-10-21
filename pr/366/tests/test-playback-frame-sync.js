/**
 * test-playback-frame-sync.js — overlay/video frame sync during playback
 * (issue #115 follow-up)
 *
 * During playback the loop draws each view's video via `drawCurrentFrame` (the
 * actual displayed <video> frame) and the pose overlay for
 * `decoder.getCurrentFrameIndex()`. The <video> displays the frame whose
 * presentation interval [i/fps, (i+1)/fps) contains `currentTime`, i.e.
 * `floor(currentTime * fps)`. Using `round` overshoots by one past a frame's
 * midpoint, so the pose overlay ran ONE FRAME AHEAD of the video (visible during
 * playback and when paused). The frame-accurate mediabunny backend exposed this
 * because stepping is now exact. Fix: `getCurrentFrameIndex` uses `floor`.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;

    function getDecoderClass() {
        if (typeof OnDemandVideoDecoder === 'function') return OnDemandVideoDecoder;
        if (typeof window !== 'undefined' && typeof window.OnDemandVideoDecoder === 'function') {
            return window.OnDemandVideoDecoder;
        }
        throw new Error('OnDemandVideoDecoder not loaded into sandbox');
    }
    function dec(fps, currentTime) {
        var d = new (getDecoderClass())({});
        d._fps = fps;
        d._videoEl = { currentTime: currentTime };
        return d;
    }

    describe('Playback: getCurrentFrameIndex matches the displayed frame (floor, not round)', function () {
        it('does not overshoot past a frame midpoint (overlay must not lead the video)', function () {
            // 60fps: frame 600 occupies [10.0, 10.0167). A currentTime in the
            // second half of that interval still shows frame 600.
            assertEqual(dec(60, 10.009).getCurrentFrameIndex(), 600,
                'mid-frame stays on the displayed frame (round gave 601 — overlay one ahead)');
            assertEqual(dec(60, 10.016).getCurrentFrameIndex(), 600,
                'near the end of frame 600 is still frame 600');
        });

        it('is exact at frame boundaries and at zero', function () {
            assertEqual(dec(60, 10.0).getCurrentFrameIndex(), 600, 'boundary → that frame');
            assertEqual(dec(60, 0).getCurrentFrameIndex(), 0, 'time 0 → frame 0');
        });

        it('advances exactly one frame per frame period', function () {
            var d = dec(60, 0);
            d._videoEl.currentTime = 0;             assertEqual(d.getCurrentFrameIndex(), 0);
            d._videoEl.currentTime = 1 / 60 + 1e-4; assertEqual(d.getCurrentFrameIndex(), 1);
            d._videoEl.currentTime = 2 / 60 + 1e-4; assertEqual(d.getCurrentFrameIndex(), 2);
            d._videoEl.currentTime = 599 / 60 + 1e-4; assertEqual(d.getCurrentFrameIndex(), 599);
        });

        it('returns 0 with no video element', function () {
            var d = new (getDecoderClass())({});
            d._fps = 60; d._videoEl = null;
            assertEqual(d.getCurrentFrameIndex(), 0);
        });
    });

    // seekNativeSettled waits for the seek to settle before play() so playback
    // isn't left stuck after scrubbing (issue #115 followup).
    describe('Playback: seekNativeSettled waits for the seek before resolving', function () {
        function stubVideoEl(startTime) {
            var listeners = [];
            var el = {
                _ct: startTime || 0,
                seeks: [],
                addEventListener: function (evt, cb) { if (evt === 'seeked') listeners.push(cb); },
                removeEventListener: function () {},
                fireSeeked: function () { listeners.splice(0).forEach(function (f) { f(); }); },
            };
            Object.defineProperty(el, 'currentTime', {
                get: function () { return el._ct; },
                set: function (v) { el._ct = v; el.seeks.push(v); },
            });
            return el;
        }

        it('resolves only AFTER the seeked event when a seek is needed', async function () {
            var d = new (getDecoderClass())({});
            d._fps = 60;
            var el = stubVideoEl(0);
            d._videoEl = el;

            var resolved = false;
            var p = d.seekNativeSettled(600).then(function () { resolved = true; });
            // It set currentTime (a real seek) but must NOT resolve until 'seeked'.
            assertEqual(el.seeks.length, 1, 'issued the seek');
            await Promise.resolve();
            assertEqual(resolved, false, 'does not resolve before the seeked event');
            el.fireSeeked();
            await p;
            assertEqual(resolved, true, 'resolves once the seek settles');
        });

        it('resolves immediately (no seek) when already on the frame', async function () {
            var d = new (getDecoderClass())({});
            d._fps = 60;
            var el = stubVideoEl(600 / 60);   // already at frame 600
            d._videoEl = el;
            await d.seekNativeSettled(600);
            assertEqual(el.seeks.length, 0, 'no redundant seek when already on the frame');
        });

        it('resolves when there is no video element', async function () {
            var d = new (getDecoderClass())({});
            d._fps = 60; d._videoEl = null;
            await d.seekNativeSettled(10);   // must not hang / throw
            assertTrue(true, 'resolved with no video element');
        });
    });

    // The real fix for "tracking leads the video during playback": drive the
    // overlay from the ACTUALLY PRESENTED frame (requestVideoFrameCallback's
    // metadata.mediaTime), not the <video>.currentTime clock (which leads the
    // painted frame by the decode/compositor latency).
    // This loop is now OPT-IN (`window.LUCID_PLAYBACK_LOOP='rvfc'`); the
    // default is the per-refresh VideoFrame loop tested below.
    describe('Playback (opt-in rvfc loop): overlay follows the presented frame (rVFC mediaTime), not the clock', function () {
        it('draws the overlay for the presented frame even when currentTime leads', async function () {
            if (typeof VideoController === 'undefined') return;
            var prevLoop = window.LUCID_PLAYBACK_LOOP;
            window.LUCID_PLAYBACK_LOOP = 'rvfc';
            try {
            var overlayFrame = null;
            var vfcb = null;
            var videoEl = {
                currentTime: 10.02,   // clock is AHEAD — this is frame 601 @60fps
                playbackRate: 1,
                requestVideoFrameCallback: function (cb) { vfcb = cb; return 1; },
                cancelVideoFrameCallback: function () {},
                addEventListener: function () {}, removeEventListener: function () {},
            };
            var decoder = {
                _videoEl: videoEl, _fps: 60, samples: new Array(20000), videoTrack: null,
                seekNativeSettled: function () { return Promise.resolve(); },
                seekNative: function () {}, playNative: function () {}, pauseNative: function () {},
                drawCurrentFrame: function () {},
                getCurrentFrameIndex: function () { return Math.floor(videoEl.currentTime * 60 + 1e-6); },
            };
            var canvas = document.createElement('canvas');
            var view = {
                name: 'cam1', decoder: decoder, canvas: canvas, ctx: canvas.getContext('2d'),
                overlayCanvas: canvas, overlayCtx: canvas.getContext('2d'), videoWidth: 640, videoHeight: 480,
            };
            var state = { views: [view], currentFrame: 600, totalFrames: 20000, fps: 60, isPlaying: false };
            var ctrl = new VideoController(state, {
                drawOverlays: function (f) { overlayFrame = f; },
                updateSeekbar: function () {},
            });

            ctrl.startPlayback();
            await new Promise(function (r) { setTimeout(r, 0); });   // seek settles → rVFC registered
            assertTrue(typeof vfcb === 'function', 'a requestVideoFrameCallback was registered');

            // The presented frame's mediaTime is 10.0 (frame 600) even though the
            // clock (currentTime) is already at 10.02 (frame 601).
            vfcb(0, { mediaTime: 10.0, presentedFrames: 1 });
            assertEqual(overlayFrame, 600,
                'overlay uses the PRESENTED frame (mediaTime→600), not the leading clock (601)');
            ctrl.stopPlayback();
            } finally { window.LUCID_PLAYBACK_LOOP = prevLoop; }
        });
    });

    // Default native loop: every display refresh, capture each view's current
    // frame as a VideoFrame (`decoder.captureCurrentFrame`), draw exactly that
    // frame, and overlay EACH VIEW at its own captured index (drawOverlays'
    // 2nd arg). Measured motivation: driving everything off the primary's
    // rVFC let Chrome's (random, ~60–120 Hz) presentation rate for that one
    // off-page <video> cap the whole UI, and left the other views' overlays
    // up to 3–4 frames off their video (tests/e2e/_bench-playback.mjs).
    describe('Playback (default refresh loop): per-view captured frames', function () {
        function nextFrames(n) {
            return new Promise(function (res) {
                var k = 0;
                (function tick() { if (++k > n) return res(); requestAnimationFrame(tick); })();
            });
        }
        // A view whose decoder hands out fake captures. `script.idx` is the
        // index the NEXT capture reports; `script.cap=false` makes capture fail.
        function makeView(name, script, log) {
            var el = { currentTime: 0, ended: false, playbackRate: 1,
                addEventListener: function () {}, removeEventListener: function () {} };
            var decoder = {
                _videoEl: el, _fps: 60, samples: new Array(1000), videoTrack: null,
                // Capture-path tests: timestamps already judged usable
                // (judgeVideoFrameTimestamps); the fallback has its own tests.
                _vfTimestamps: ('tsMode' in script) ? script.tsMode : 'ok',
                seekNativeSettled: function () { return Promise.resolve(); },
                seekNative: function () {}, playNative: function () {}, pauseNative: function () {},
                drawCurrentFrame: function () { log.fallbackDraws.push(name); return true; },
                getCurrentFrameIndex: function () { return script.clockIdx; },
                captureCurrentFrame: function () {
                    if (script.cap === false) return null;
                    var ts = script.tsFromClock ? el.currentTime * 1e6
                        : script.frozenTs != null ? script.frozenTs : script.idx / 60 * 1e6;
                    var frame = { name: name, index: script.idx, timestamp: ts, closed: false,
                        close: function () { this.closed = true; } };
                    log.captured.push(frame);
                    return { frame: frame, index: Math.round(ts / 1e6 * 60) };
                },
            };
            if (script.rvfc) {
                el.requestVideoFrameCallback = function (cb) { script.rvfcCb = cb; return 1; };
                el.cancelVideoFrameCallback = function () { script.rvfcCancelled = true; };
            }
            return {
                name: name, decoder: decoder, videoWidth: 64, videoHeight: 48,
                canvas: { width: 64, height: 48 },
                ctx: { drawImage: function (img) { log.drawn.push(img); } },
                overlayCanvas: { width: 64, height: 48 },
                overlayCtx: { clearRect: function () {} },
            };
        }
        function setup(scripts, drawOverlays) {
            var log = { captured: [], drawn: [], fallbackDraws: [], overlays: [] };
            var views = scripts.map(function (sc, i) { return makeView('cam' + i, sc, log); });
            var state = { views: views, currentFrame: 0, totalFrames: 1000, fps: 60, isPlaying: false };
            var ctrl = new VideoController(state, {
                drawOverlays: drawOverlays || function (f, vf) { log.overlays.push({ f: f, vf: vf }); },
                updateSeekbar: function () {},
            });
            return { ctrl: ctrl, state: state, views: views, log: log };
        }
        function canRun() {
            return typeof VideoController !== 'undefined' && typeof requestAnimationFrame === 'function'
                && window.LUCID_PLAYBACK_LOOP !== 'rvfc';
        }

        it('draws each view with exactly its captured frame and overlays it at that frame', async function () {
            if (!canRun()) return;
            var a = { idx: 100 }, b = { idx: 102 };
            var t = setup([a, b]);
            t.ctrl.startPlayback();
            await nextFrames(3);
            t.ctrl.stopPlayback();
            assertTrue(t.log.overlays.length >= 1, 'overlay drawn');
            var o = t.log.overlays[0];
            assertEqual(o.f, 100, 'shared frame = primary view\'s captured frame');
            assertEqual(o.vf.cam0, 100, 'cam0 overlaid at its own captured frame');
            assertEqual(o.vf.cam1, 102, 'cam1 overlaid at ITS captured frame, not the primary\'s');
            assertEqual(t.state.currentFrame, 100, 'state.currentFrame follows the primary');
            assertTrue(t.log.drawn.length >= 2 && t.log.drawn.every(function (d) { return d.index === (d.name === 'cam0' ? 100 : 102); }),
                'the canvas got the very VideoFrame whose index the overlay used');
            assertTrue(t.log.captured.every(function (c) { return c.closed; }), 'every captured VideoFrame was closed');
        });

        it('keeps every view on the shared scheduled frame; redraws when it advances', async function () {
            if (!canRun()) return;
            var a = { idx: 10 }, b = { idx: 10 };
            var t = setup([a, b]);
            t.ctrl.startPlayback();
            await nextFrames(6);
            assertEqual(t.log.overlays.length, 1, 'unchanged frames are drawn once');
            b.idx = 11;   // the second camera runs AHEAD of the primary
            await nextFrames(6);
            assertEqual(t.log.overlays.length, 1, 'a view ahead of the schedule is held (cameras stay in step)');
            a.idx = 11;   // the primary catches up
            await nextFrames(6);
            var n = t.log.overlays.length;   // before stopPlayback's own settle redraw
            t.ctrl.stopPlayback();
            assertEqual(n, 2, 'redrawn once the scheduled frame advances');
            assertEqual(t.log.overlays[1].vf.cam0, 11, 'primary at 11');
            assertEqual(t.log.overlays[1].vf.cam1, 11, 'second view at the same frame');
            assertTrue(t.log.captured.every(function (c) { return c.closed; }), 'held and skipped captures are all closed');
        });

        // Safari 27 / Firefox 157: `new VideoFrame(video).timestamp` is 0 or a
        // constant during playback (measured, tests/e2e/_probe-capabilities).
        // The loop must notice and stop trusting it, or playback freezes.
        it('unusable VideoFrame timestamps: stops capturing, draws the <video>, overlays at the clock', async function () {
            if (!canRun()) return;
            var a = { idx: 0, frozenTs: 0, clockIdx: 0, tsMode: undefined };
            var t = setup([a]);
            var el = t.views[0].decoder._videoEl;
            t.ctrl.startPlayback();
            for (var k = 0; k < 12; k++) {          // the clock advances, the timestamp doesn't
                a.clockIdx = 100 + k * 2; el.currentTime = a.clockIdx / 60;
                await nextFrames(1);
            }
            var capturedSoFar = t.log.captured.length;
            a.clockIdx = 140; el.currentTime = 140 / 60;
            await nextFrames(3);
            var lastOv = t.log.overlays[t.log.overlays.length - 1];
            t.ctrl.stopPlayback();
            assertEqual(t.views[0].decoder._vfTimestamps, 'bad', 'timestamps judged unusable');
            assertEqual(t.log.captured.length, capturedSoFar, 'no more VideoFrame captures once judged unusable');
            assertTrue(t.log.fallbackDraws.length > 0, 'painted via drawCurrentFrame');
            assertEqual(lastOv.vf.cam0, 140, 'overlay follows the clock');
            assertTrue(t.log.captured.every(function (c) { return c.closed; }), 'judging captures were closed');
        });

        it('usable VideoFrame timestamps: judged ok and the captured frame keeps being painted', async function () {
            if (!canRun()) return;
            var a = { idx: 0, tsMode: undefined };
            var t = setup([a]);
            var el = t.views[0].decoder._videoEl;
            t.ctrl.startPlayback();
            for (var k = 0; k < 12; k++) { a.idx = 100 + k * 2; el.currentTime = a.idx / 60; await nextFrames(1); }
            var drawnBefore = t.log.drawn.length;
            a.idx = 140; el.currentTime = 140 / 60;
            await nextFrames(3);
            t.ctrl.stopPlayback();
            assertEqual(t.views[0].decoder._vfTimestamps, 'ok', 'timestamps judged usable');
            assertTrue(t.log.drawn.length > drawnBefore, 'captured VideoFrames are painted');
        });

        it('fallback takes the frame index from requestVideoFrameCallback mediaTime', async function () {
            if (!canRun()) return;
            var a = { idx: 0, tsMode: 'bad', clockIdx: 5, rvfc: true };
            var t = setup([a]);
            t.ctrl.startPlayback();
            await nextFrames(2);
            assertTrue(typeof a.rvfcCb === 'function', 'rVFC registered for the fallback view');
            assertEqual(t.log.fallbackDraws.length, 0, 'nothing drawn before the first callback');
            a.rvfcCb(performance.now(), { mediaTime: 299 / 60, presentedFrames: 1 });   // first: not trusted
            a.rvfcCb(performance.now(), { mediaTime: 300 / 60, presentedFrames: 2 });
            await nextFrames(2);
            var lastOv = t.log.overlays[t.log.overlays.length - 1];
            t.ctrl.stopPlayback();
            // Firefox projects a coalesced callback forward (≤ 100 ms → ≤ 6 frames at 60 fps).
            var isGecko = /\bFirefox\//.test(navigator.userAgent);
            assertTrue(isGecko ? (lastOv.vf.cam0 >= 300 && lastOv.vf.cam0 <= 306) : lastOv.vf.cam0 === 300,
                'overlay at the rVFC frame (got ' + lastOv.vf.cam0 + '), not the clock (5)');
            assertTrue(a.rvfcCancelled === true, 'fallback rVFC cancelled on stop');
        });

        // Safari: after the pre-play seek, drawImage(<video>) keeps painting the
        // PRE-seek picture until Safari presents a new frame, while the clock
        // has moved on — the clock overlaid frame 279 on a picture of frame 66
        // (verify/pause-xb.html). Until its first callback a fallback view is
        // left on the paused frame its canvas already shows.
        it('fallback view: not drawn before its first rVFC, and overlaid at the paused frame (not the clock) meanwhile', async function () {
            if (!canRun()) return;
            var a = { idx: 100 }, b = { tsMode: 'bad', clockIdx: 500, rvfc: true };
            var t = setup([a, b]);
            t.state.currentFrame = 100;
            t.ctrl.startPlayback();
            await nextFrames(2);
            a.idx = 101;
            await nextFrames(3);
            var o = t.log.overlays[t.log.overlays.length - 1];
            assertTrue(!!o, 'the capturing view drew');
            assertEqual(t.log.fallbackDraws.length, 0, 'the fallback view was not drawn yet');
            assertEqual(o.vf.cam1, 100, 'fallback view overlaid at the paused start frame (got ' + o.vf.cam1 + '), not the clock (500)');
            b.rvfcCb(performance.now(), { mediaTime: 101 / 60, presentedFrames: 1 });
            b.rvfcCb(performance.now(), { mediaTime: 102 / 60, presentedFrames: 2 });
            await nextFrames(2);
            o = t.log.overlays[t.log.overlays.length - 1];
            t.ctrl.stopPlayback();
            assertTrue(t.log.fallbackDraws.indexOf('cam1') >= 0, 'drawn once its frame is known');
            var isGecko = /\bFirefox\//.test(navigator.userAgent);
            assertTrue(isGecko ? o.vf.cam1 >= 102 : o.vf.cam1 === 102, 'then overlaid at its rVFC frame (got ' + o.vf.cam1 + ')');
        });

        // Safari: the first callback after the pre-play seek carries the
        // PRE-seek frame's metadata (measured: 541 over a picture of 210).
        // Per-picture rVFC views are painted inside the callback, and only
        // once the reported frame has changed.
        it('per-picture rVFC: the first callback is not trusted; later ones are painted in the callback itself', async function () {
            if (!canRun()) return;
            if (/\bFirefox\//.test(navigator.userAgent)) return;   // Firefox's callbacks are coalesced
            var a = { tsMode: 'bad', clockIdx: 211, rvfc: true };
            var t = setup([a]);
            t.state.currentFrame = 211;
            t.ctrl.startPlayback();
            await nextFrames(2);
            a.rvfcCb(performance.now(), { mediaTime: 541 / 60, presentedFrames: 1 });   // stale
            await nextFrames(2);
            assertEqual(t.log.fallbackDraws.length, 0, 'the stale first callback is not painted');
            assertEqual(t.log.overlays.length, 0, 'nor overlaid');
            a.rvfcCb(performance.now(), { mediaTime: 212 / 60, presentedFrames: 2 });
            assertEqual(t.log.fallbackDraws.length, 1, 'painted synchronously, inside the callback');
            await nextFrames(2);
            var o = t.log.overlays[t.log.overlays.length - 1];
            t.ctrl.stopPlayback();
            assertEqual(o.vf.cam0, 212, 'overlaid at that frame');
        });

        // Safari 27: `new VideoFrame(<video>).timestamp` is 0 or the clock,
        // never the captured frame's — a clock reading can pass judging while
        // the picture lags — so WebKit never captures, not even to judge.
        it('WebKit: never creates a VideoFrame from the <video>; draws it at its rVFC frame', async function () {
            if (!canRun()) return;
            var desc = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
            Object.defineProperty(navigator, 'userAgent', { configurable: true,
                value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15' });
            try {
                var a = { idx: 40, tsMode: undefined, clockIdx: 40, rvfc: true };
                var t = setup([a]);
                t.ctrl.startPlayback();
                await nextFrames(4);
                a.rvfcCb(performance.now(), { mediaTime: 40 / 60, presentedFrames: 1 });
                a.rvfcCb(performance.now(), { mediaTime: 41 / 60, presentedFrames: 2 });
                await nextFrames(2);
                var o = t.log.overlays[t.log.overlays.length - 1];
                t.ctrl.stopPlayback();
                assertEqual(t.log.captured.length, 0, 'no VideoFrame was ever created');
                assertEqual(t.views[0].decoder._vfTimestamps, 'bad', 'marked unusable up front');
                assertTrue(t.log.fallbackDraws.length > 0, 'the <video> is drawn directly');
                assertEqual(o.vf.cam0, 41, 'overlaid at the rVFC frame');
            } finally {
                delete navigator.userAgent;
                if (desc) Object.defineProperty(navigator, 'userAgent', desc);
            }
        });

        // A timestamp that equals currentTime to the microsecond while off the
        // frame grid is the clock (Safari's, when it isn't 0) — it "agrees"
        // with the clock perfectly while the picture lags.
        it('a VideoFrame timestamp that IS the clock is judged unusable', async function () {
            if (!canRun()) return;
            var a = { idx: 0, tsMode: undefined, tsFromClock: true, clockIdx: 0 };
            var t = setup([a]);
            var el = t.views[0].decoder._videoEl;
            t.ctrl.startPlayback();
            for (var k = 0; k < 12; k++) {
                el.currentTime = (100 + k * 2 + 0.37) / 60; a.clockIdx = 100 + k * 2;
                await nextFrames(1);
            }
            t.ctrl.stopPlayback();
            assertEqual(t.views[0].decoder._vfTimestamps, 'bad', 'clock-valued timestamps rejected');
        });

        it('falls back to drawCurrentFrame + the clock index when capture is unavailable', async function () {
            if (!canRun()) return;
            var a = { cap: false, clockIdx: 42 };
            var t = setup([a]);
            t.ctrl.startPlayback();
            await nextFrames(3);
            t.ctrl.stopPlayback();
            assertTrue(t.log.fallbackDraws.length >= 1, 'drawCurrentFrame used');
            assertEqual(t.log.overlays[0].vf.cam0, 42, 'overlay at getCurrentFrameIndex()');
        });

        it('stops when the primary video ends', async function () {
            if (!canRun()) return;
            var a = { idx: 5 };
            var t = setup([a]);
            t.ctrl.startPlayback();
            await nextFrames(2);
            assertTrue(t.state.isPlaying, 'playing');
            t.views[0].decoder._videoEl.ended = true;
            await nextFrames(2);
            assertEqual(t.state.isPlaying, false, 'stopped at end of video');
        });

        it('releases every captured frame even if drawing the overlay throws', async function () {
            if (!canRun()) return;
            var a = { idx: 1 };
            var t;
            var origErr = console.error; console.error = function () {};
            try {
                t = setup([a], function () { throw new Error('boom'); });
                t.ctrl.startPlayback();
                await nextFrames(2);
                a.idx = 2;
                await nextFrames(2);
                t.ctrl.stopPlayback();
            } finally { console.error = origErr; }
            assertTrue(t.log.captured.length >= 2, 'kept capturing after the error (loop survived)');
            assertTrue(t.log.captured.every(function (c) { return c.closed; }), 'no VideoFrame leaked');
        });
    });
    // Firefox fires requestVideoFrameCallback ~24x/s ("coalesced"), so which
    // frame drawImage(<video>) paints between callbacks has to be inferred.
    // Simulated on Firefox 157's measured semantics (verify/ff-cbrel.mjs,
    // verify/ff-phase.mjs): frames queue with due times T_k = T0 + k/fps and
    // drawImage paints the last one due at the instant of the call; a callback
    // at refresh V reports the next frame with expectedDisplayTime = V+P when
    // that one falls due by V+P, else the frame already due, with
    // expectedDisplayTime = V. Draws happen 0.3-5 ms into each refresh.
    describe('CoalescedFrameClock: the frame Firefox paints between coalesced callbacks', function () {
        function rng(seed) { return function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
        function run(fps, hz, seed, opts) {
            opts = opts || {};
            var r = rng(seed), P = 1000 / hz, rate = fps / 1000;
            var T0 = 1000 + r() * 50, refreshes = opts.refreshes || 1200;
            var truthAt = function (t) { return Math.floor((t - T0) * rate + (t >= (opts.jumpAt || Infinity) ? opts.jumpBy : 0)); };
            var every = Math.max(1, Math.round(hz / 24));
            var clock = new CoalescedFrameClock();
            var res = { n: 0, certain: 0, certainWrong: 0, wrong: 0, drawnWrong: 0, oldWrong: 0, runs: {}, afterJumpWrong: 0 };
            var shown = null, skips = 0, seq = [], last = null;
            for (var k = 0; k < refreshes; k++) {
                var V = 2000 + k * P;
                if (k % every === 0) {
                    var due = truthAt(V);
                    var nextDue = T0 + (due + 1 - (V >= (opts.jumpAt || Infinity) ? opts.jumpBy : 0)) / rate;
                    if (nextDue <= V + P) { clock.observe(V, due + 1, V + P, rate, P); last = { m: due + 1, at: V }; }
                    else { clock.observe(V, due, V, rate, P); last = { m: due, at: V }; }
                }
                var t = V + 0.3 + r() * 4.7, truth = truthAt(t);
                var ans = clock.frameAt(t, 0);
                if (!ans) continue;
                res.n++;
                if (ans.certain) { res.certain++; if (ans.index !== truth) res.certainWrong++; }
                if (ans.index !== truth) res.wrong++;
                // the previous estimate: round(mediaTime + time since the callback)
                if (Math.round(last.m + (V - last.at) * rate) !== truth) res.oldWrong++;
                // the loop's policy (VideoController): skip an uncertain refresh
                // when a frame spans ~2+ refreshes and the next refresh would be
                // certain, at most twice running (the canvas keeps the frame it
                // shows — before the first draw, the paused one); never step
                // backwards
                var nxt = (!ans.certain && ans.step != null && ans.step <= 0.55 && skips < 2) ? clock.frameAt(t + P, 0) : null;
                if (nxt && nxt.certain) skips++;
                else {
                    skips = 0;
                    if (shown == null || ans.index > shown) {
                        shown = ans.index;
                        // a jump ahead is adopted once a second callback confirms it
                        if (ans.index !== truth) { res.drawnWrong++; if (opts.jumpAt && V > opts.jumpAt + 2 * every * P) res.afterJumpWrong++; }
                    }
                }
                seq.push(shown);
            }
            var run1 = 1;
            for (var i = 1; i < seq.length; i++) {
                if (seq[i] === seq[i - 1]) run1++; else { if (i > 20) res.runs[run1] = (res.runs[run1] || 0) + 1; run1 = 1; }
            }
            return res;
        }
        it('a CERTAIN answer is always the painted frame', function () {
            if (typeof CoalescedFrameClock === 'undefined') return;
            [[60, 120], [60, 119.88], [60, 60], [59.94, 60], [150, 120], [30, 60], [30, 120], [25, 60]].forEach(function (c) {
                for (var s = 1; s <= 4; s++) {
                    var res = run(c[0], c[1], s * 7919);
                    assertEqual(res.certainWrong, 0, c[0] + ' fps / ' + c[1] + ' Hz seed ' + s + ': ' + res.certainWrong + ' of ' + res.certain + ' certain answers wrong');
                }
            });
        });
        it('60 fps on 120 Hz: every drawn frame exact and shown exactly 2 refreshes; the old projection was not', function () {
            if (typeof CoalescedFrameClock === 'undefined') return;
            for (var s = 1; s <= 4; s++) {
                var res = run(60, 120, s * 104729);
                assertTrue(res.certain / res.n > 0.45, 'certain on ' + (100 * res.certain / res.n).toFixed(0) + '% of refreshes');
                assertEqual(res.drawnWrong, 0, 'every frame the loop draws is the painted one');
                assertEqual(Object.keys(res.runs).join(','), '2', 'each frame held exactly 2 refreshes (got ' + JSON.stringify(res.runs) + ')');
                assertTrue(res.oldWrong / res.n > 0.15, 'negative control: round(mediaTime + elapsed) is wrong on '
                    + (100 * res.oldWrong / res.n).toFixed(0) + '% of refreshes');
            }
        });
        it('one refresh per frame (60 Hz): the midpoint guess is drawn, without holds from skipping', function () {
            if (typeof CoalescedFrameClock === 'undefined') return;
            var res = run(60, 60, 31337);
            assertTrue(res.drawnWrong / res.n < 0.05, 'drawn wrong on ' + (100 * res.drawnWrong / res.n).toFixed(1) + '% of refreshes');
            assertEqual(Object.keys(res.runs).join(','), '1', 'a new frame every refresh (got ' + JSON.stringify(res.runs) + ')');
        });
        it('follows a jump in the frame clock (seek, stall) within a few callbacks', function () {
            if (typeof CoalescedFrameClock === 'undefined') return;
            var res = run(60, 120, 4242, { jumpAt: 4000, jumpBy: 37 });
            assertEqual(res.certainWrong, 0, 'no certain answer wrong, across the jump');
            assertEqual(res.afterJumpWrong, 0, 'every frame drawn once the jump is confirmed is the painted one');
        });
        // The first callback of a playback reports the PAUSED start frame as
        // already due: on screen because of the pause, not the frame clock
        // (measured 1-20 ms outside the bound it would imply, either side).
        it('a callback re-reporting a frame (the paused start frame, a stall) says nothing; a rate change starts over', function () {
            if (typeof CoalescedFrameClock === 'undefined') return;
            var c = new CoalescedFrameClock(), P = 1000 / 120;
            assertEqual(c.frameAt(1000, 0), null, 'no callback yet');
            c.observe(1000, 60, 1000, 0.06, P);
            assertEqual(c.frameAt(1001, 0), null, 'the start frame reported as due: still unknown');
            c.observe(1041.67, 63, 1050, 0.06, P);          // next frame, due by the next refresh
            var a = c.frameAt(1052, 0);
            assertTrue(a && a.index === 63, 'known from a new frame (got ' + (a && a.index) + ')');
            c.observe(1100, 50, 1100, 0.03, P);             // half speed: starts over...
            assertEqual(c.frameAt(1101, 0), null, '...and knows nothing until a new frame');
            c.observe(1141.67, 52, 1150, 0.03, P);
            a = c.frameAt(1152, 0);
            assertTrue(a && a.index === 52, 'then follows the new rate (got ' + (a && a.index) + ')');
        });
        // Measured with 8 HEVC cameras: one callback reports a frame ~10 ahead
        // (448 -> 460 -> 452 within 80 ms) that is never painted.
        it('a lone callback ~10 frames AHEAD is ignored; a confirmed jump ahead is followed', function () {
            if (typeof CoalescedFrameClock === 'undefined') return;
            var P = 1000 / 120, rate = 0.06, T0 = 1000.3;   // frame k due at T0 + k/rate
            function feed(c, V, shift) {                     // a truthful callback at refresh V
                var due = Math.floor((V - T0) * rate) + shift, nextDue = T0 + (due + 1 - shift) / rate;
                if (nextDue <= V + P) c.observe(V, due + 1, V + P, rate, P); else c.observe(V, due, V, rate, P);
            }
            var truth = function (t, shift) { return Math.floor((t - T0) * rate) + shift; };
            var c = new CoalescedFrameClock(), k, V;
            for (k = 0; k < 40; k += 5) feed(c, 2000 + k * P, 0);
            V = 2000 + 40 * P;
            var before = c.frameAt(V + 2, 0);
            c.observe(V, truth(V, 0) + 10, V, rate, P);       // bogus
            var a = c.frameAt(V + 2, 0);
            assertEqual(a.index, before.index, 'the bogus callback does not move the estimate');
            assertEqual(a.certain, false, 'but nothing is certain until the next callback');
            feed(c, 2000 + 45 * P, 0);
            for (var dt = 0; dt < 8; dt += 0.5) {
                a = c.frameAt(2000 + 45 * P + dt, 0);
                if (a.certain) assertEqual(a.index, truth(2000 + 45 * P + dt, 0), 'after the next, truthful callback');
            }
            // a REAL jump ahead (the queue skipped 12 frames): followed once confirmed
            for (k = 50; k <= 60; k += 5) feed(c, 2000 + k * P, 12);
            var certainSeen = 0;
            for (dt = 0; dt < 16; dt += 0.5) {
                a = c.frameAt(2000 + 60 * P + dt, 0);
                if (!a.certain) continue;
                certainSeen++;
                assertEqual(a.index, truth(2000 + 60 * P + dt, 12), 'a confirmed jump is followed');
            }
            assertTrue(certainSeen > 0, 'and certain again');
        });
        it('the reported frame going BACK (seek, decoder glitch) forgets the clock', function () {
            if (typeof CoalescedFrameClock === 'undefined') return;
            var c = new CoalescedFrameClock(), P = 1000 / 120;
            c.observe(1000, 60, 1000 + P, 0.06, P);
            c.observe(1041.67, 63, 1041.67, 0.06, P);
            assertTrue(c.frameAt(1050, 0) != null, 'known');
            c.observe(1083.33, 55, 1083.33, 0.06, P);
            assertEqual(c.frameAt(1090, 0), null, 'unknown after the jump back');
        });
    });

    // PlaybackSchedule: which frame SHOULD be on screen each refresh. Simulates
    // the real failure: a free-running video clock sampled once per refresh by
    // captures that are randomly up to one refresh stale (plus timing jitter).
    // Naive sampling (show whatever was captured) then holds frames for an
    // irregular number of refreshes; the schedule must give the ideal cadence.
    describe('PlaybackSchedule: regular cadence from jittery captures', function () {
        function rng(seed) { return function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
        // Returns per-refresh shown index for `refreshes` refreshes.
        function simulate(opts) {
            var hz = opts.hz, fps = opts.fps, n = opts.refreshes;
            var period = 1000 / hz, rate = fps / 1000, rnd = rng(opts.seed || 7);
            var sched = new PlaybackSchedule(), out = [], naive = [];
            for (var k = 0; k < n; k++) {
                var now = 1000 + k * period;
                var clockMs = now + (opts.clockOffsetMs || 0) + (rnd() - 0.5) * 2;   // ±1 ms timing jitter
                var drift = 1 + (opts.drift || 0);
                var stale = rnd() * period;                                          // up to one refresh stale
                var pos = (clockMs - stale - 1000) * rate * drift + (opts.startFrame || 100);
                if (opts.seekAt != null && k >= opts.seekAt) pos += opts.seekBy;
                var cap = Math.floor(pos);
                out.push(sched.update(now, cap, rate));
                naive.push(cap);
            }
            return { out: out, naive: naive };
        }
        function runs(seq, from) {
            var r = [], run = 1;
            for (var i = from + 1; i < seq.length; i++) {
                if (seq[i] === seq[i - 1]) run++; else { r.push(run); run = 1; }
            }
            return r.slice(1);   // drop the first (truncated) run
        }
        function steps(seq, from) {
            var d = [];
            for (var i = from + 1; i < seq.length; i++) d.push(seq[i] - seq[i - 1]);
            return d;
        }

        it('60 fps on 120 Hz: every frame held exactly 2 refreshes (naive sampling is not)', function () {
            if (typeof PlaybackSchedule === 'undefined') return;
            var sim = simulate({ hz: 120, fps: 60, refreshes: 1200 });
            var r = runs(sim.out, 60);
            var bad = r.filter(function (x) { return x !== 2; }).length;
            assertEqual(bad, 0, 'scheduled: all frames held 2 refreshes (' + r.length + ' frames)');
            var rn = runs(sim.naive, 60);
            var badNaive = rn.filter(function (x) { return x !== 2; }).length;
            assertTrue(badNaive > rn.length * 0.1, 'naive sampling of the same clock is irregular (' + badNaive + '/' + rn.length + ') — the test has teeth');
        });

        it('follows a seek within a refresh and tracks a drifting clock', function () {
            if (typeof PlaybackSchedule === 'undefined') return;
            var sim = simulate({ hz: 120, fps: 60, refreshes: 600, seekAt: 300, seekBy: 500 });
            assertTrue(Math.abs(sim.out[301] - sim.naive[301]) <= 1, 'jumped with the seek');
            var d = simulate({ hz: 120, fps: 60, refreshes: 6000, drift: 0.002, seed: 5 });
            var worst = 0;
            for (var i = 60; i < d.out.length; i++) worst = Math.max(worst, Math.abs(d.out[i] - d.naive[i]));
            assertTrue(worst <= 2, 'stays within 2 frames of the video over 50 s at 0.2% drift (worst ' + worst + ')');
        });
    });

    describe('pickScheduledFrame', function () {
        it('holds until the schedule moves on, then advances to the newer frame closest to it', function () {
            if (typeof pickScheduledFrame === 'undefined') return;
            assertEqual(pickScheduledFrame(10, 9, null, 10), 'cap', 'capture on target');
            assertEqual(pickScheduledFrame(10, 10, null, 11), 'shown', 'schedule not past the shown frame: hold');
            assertEqual(pickScheduledFrame(11, 10, 11, 12), 'pending', 'held frame reaches its slot');
            assertEqual(pickScheduledFrame(12, 10, null, 11), 'cap', 'late video: show the newest available');
            assertEqual(pickScheduledFrame(10, 9, null, 11), 'cap',
                'target frame never captured: advance to the next one rather than hold the old frame');
            assertEqual(pickScheduledFrame(10, 9, null, 9), 'shown', 'nothing newer: hold');
            assertEqual(pickScheduledFrame(5, null, null, 7), 'cap', 'nothing shown yet: only candidate');
        });
    });

    // End to end (pure): schedule + per-view pick + one held frame — the loop's
    // logic minus the DOM — fed by captures modelled on what Chrome actually
    // hands back for an off-page <video> (measured from the benchmark's raw
    // timelines: ~half a refresh stale, timing jitter σ ≈ 0.1 frame; 60 fps
    // captures on a 120 Hz display advance 0/1 and essentially never skip).
    // The display is 120.5 Hz (as measured), so the video/refresh phase drifts
    // through every value, like real hardware.
    describe('Scheduled per-view selection vs naive sampling (calibrated captures)', function () {
        function rng(seed) { return function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
        function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
        function play(hz, fps, n, seed, naive) {
            var period = 1000 / hz, rate = fps / 1000, r = rng(seed);
            var sched = new PlaybackSchedule(), shown = null, pending = null, out = [];
            for (var k = 0; k < n; k++) {
                var now = 1000 + k * period;
                var cap = Math.floor((now - 1000 - 0.5 * period) * rate + 100 + gauss(r) * 0.1);
                if (naive) { out.push(cap); continue; }
                var target = sched.update(now, cap, rate);
                var pick = pickScheduledFrame(target, shown, pending, cap);
                if (pick === 'cap') shown = cap; else if (pick === 'pending') shown = pending;
                if (pending != null && pending <= shown) pending = null;
                if (cap > shown && (pending == null || cap < pending)) pending = cap;
                out.push(shown);
            }
            return out;
        }
        // % of frames NOT on screen for an ideal number of refreshes.
        function irregularPct(seq, ideal) {
            var run = 1, n = 0, bad = 0;
            for (var i = 121; i < seq.length; i++) {
                if (seq[i] === seq[i - 1]) { run++; continue; }
                n++; if (ideal.indexOf(run) < 0) bad++; run = 1;
            }
            return 100 * bad / n;
        }
        it('60 fps on a 120.5 Hz display: regular 2-refresh frames; naive sampling is not', function () {
            if (typeof PlaybackSchedule === 'undefined') return;
            for (var seed = 1; seed <= 4; seed++) {
                // 120.5/60 is not exactly 2: one 3-refresh frame per ~125 is inherent (0.8%).
                var sch = irregularPct(play(120.5, 60, 4800, seed), [2]);
                var nai = irregularPct(play(120.5, 60, 4800, seed, true), [2]);
                assertTrue(sch < 1.5, 'seed ' + seed + ': scheduled irregular ' + sch.toFixed(1) + '%');
                assertTrue(nai > 10, 'seed ' + seed + ': naive irregular ' + nai.toFixed(1) + '% (teeth)');
            }
        });
        it('150 fps on a 120.5 Hz display: a new frame (+1/+2) every refresh', function () {
            if (typeof PlaybackSchedule === 'undefined') return;
            for (var seed = 1; seed <= 4; seed++) {
                var sch = irregularPct(play(120.5, 150.1, 4800, seed), [1]);
                assertTrue(sch < 1, 'seed ' + seed + ': held refreshes ' + sch.toFixed(2) + '%');
            }
        });
        it('60 fps on a 60 Hz display: +1 every refresh', function () {
            if (typeof PlaybackSchedule === 'undefined') return;
            for (var seed = 1; seed <= 4; seed++) {
                var sch = irregularPct(play(60, 60, 2400, seed), [1]);
                assertTrue(sch < 0.5, 'seed ' + seed + ': irregular ' + sch.toFixed(2) + '%');
            }
        });

        // EXACT rate ratios (60 fps on a true 120 Hz panel, 150 on 120…) keep
        // the video/refresh phase CONSTANT, so a badly placed anchor never
        // drifts away: frame boundaries sitting on refresh instants + µs
        // timestamp jitter flipped frames between 1 and 3 refreshes for a whole
        // playback (seen in a real run). Every starting phase must be fine.
        function playExact(hz, fps, n, seed, startFrac) {
            var period = 1000 / hz, rate = fps / 1000, r = rng(seed);
            var sched = new PlaybackSchedule(), shown = null, pending = null, out = [];
            for (var k = 0; k < n; k++) {
                var now = 1000 + k * period + (r() - 0.5) * 0.1;   // ±50 µs timestamp jitter
                var cap = Math.floor((1000 + k * period - 1000 - 0.5 * period) * rate + 100 + startFrac + gauss(r) * 0.1);
                var target = sched.update(now, cap, rate);
                var pick = pickScheduledFrame(target, shown, pending, cap);
                if (pick === 'cap') shown = cap; else if (pick === 'pending') shown = pending;
                if (pending != null && pending <= shown) pending = null;
                if (cap > shown && (pending == null || cap < pending)) pending = cap;
                out.push(shown);
            }
            return out;
        }
        it('exact 2:1 (60 fps on 120 Hz): regular for every starting phase', function () {
            if (typeof PlaybackSchedule === 'undefined') return;
            for (var ph = 0; ph < 1; ph += 0.125) {
                var sch = irregularPct(playExact(120, 60, 2400, 7, ph), [2]);
                assertTrue(sch < 0.5, 'start phase ' + ph + ': irregular ' + sch.toFixed(2) + '%');
            }
        });
        it('video at least as fast as the display: shows the newest capture, exactly like naive sampling', function () {
            if (typeof PlaybackSchedule === 'undefined') return;
            [[60, 60], [60, 59.94], [120, 150], [60, 150.1], [120.5, 120]].forEach(function (c) {
                var hz = c[0], fps = c[1], period = 1000 / hz, rate = fps / 1000, r = rng(13);
                var sched = new PlaybackSchedule(), same = true;
                for (var k = 0; k < 1200; k++) {
                    var cap = Math.floor((k * period - 0.5 * period) * rate + 100 + gauss(r) * 0.1);
                    var target = sched.update(1000 + k * period, cap, rate);
                    if (k > 8 && target !== cap) { same = false; break; }
                }
                assertTrue(same, hz + ' Hz / ' + fps + ' fps: target === capture');
            });
        });
    });
})();
