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
                seekNativeSettled: function () { return Promise.resolve(); },
                seekNative: function () {}, playNative: function () {}, pauseNative: function () {},
                drawCurrentFrame: function () { log.fallbackDraws.push(name); return true; },
                getCurrentFrameIndex: function () { return script.clockIdx; },
                captureCurrentFrame: function () {
                    if (script.cap === false) return null;
                    var frame = { name: name, index: script.idx, closed: false,
                        close: function () { this.closed = true; } };
                    log.captured.push(frame);
                    return { frame: frame, index: script.idx };
                },
            };
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
