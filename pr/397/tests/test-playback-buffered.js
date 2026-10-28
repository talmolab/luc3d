/**
 * test-playback-buffered.js — buffered, video-led mediabunny playback
 * (issue #115 follow-up: "the tracking leads the video during playback")
 *
 * When every view has a mediabunny backend, VideoController plays back off a
 * read-ahead decode buffer instead of the native <video> element. The loop is
 * VIDEO-LED: it advances only to a frame decoded in the cache of EVERY view and
 * paints that frame's video bitmap AND its pose overlay for the SAME index in
 * one synchronous pass — so the overlay can NEVER lead the video. These tests
 * pin that invariant with a mock backend whose `cache`/`prefetch` we control.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var beforeEach = TF.beforeEach;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;
    var assertFalse = TF.assertFalse;

    // Buffered mediabunny playback is OPT-IN (default is the native path), so
    // the behavior tests below run with the opt-in flag set. `withFlag` saves
    // and restores window.LUCID_PLAYBACK_BACKEND around a (possibly async) test
    // body so the setting never leaks to other tests/files.
    function withFlag(val, fn) {
        return async function () {
            var prev = (typeof window !== 'undefined') ? window.LUCID_PLAYBACK_BACKEND : undefined;
            if (typeof window !== 'undefined') window.LUCID_PLAYBACK_BACKEND = val;
            try { return await fn.apply(this, arguments); }
            finally { if (typeof window !== 'undefined') window.LUCID_PLAYBACK_BACKEND = prev; }
        };
    }

    // A mock mediabunny backend. `prefetch(s,e)` synchronously fills the LRU
    // cache with tagged bitmaps unless `stall` is set (simulates a decode that
    // never completes → underrun). Each cached "bitmap" carries its frame index
    // so a mock ctx.drawImage can report which frame's video was actually shown.
    function mockBackend(numFrames, opts) {
        opts = opts || {};
        return {
            cache: new Map(),
            cacheSize: 30,
            numFrames: numFrames,
            frameCount: numFrames,
            prefetchCalls: [],
            prefetch: function (s, e) {
                this.prefetchCalls.push([s, e]);
                if (!opts.stall) {
                    for (var i = s; i <= e; i++) {
                        if (!this.cache.has(i)) this.cache.set(i, { __frame: i });
                    }
                }
                return Promise.resolve();
            },
            close: function () {},
        };
    }

    // Build a view whose decoder carries a mediabunny backend; the main ctx's
    // drawImage is instrumented to record the drawn frame index.
    function mockMbView(name, numFrames, drawnLog, opts) {
        var canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 48;
        var overlay = document.createElement('canvas');
        overlay.width = 64; overlay.height = 48;
        var ctx = canvas.getContext('2d');
        ctx.drawImage = function (bmp) {
            drawnLog.push(bmp && typeof bmp.__frame === 'number' ? bmp.__frame : null);
        };
        return {
            name: name,
            decoder: { _fps: 30, _mbBackend: mockBackend(numFrames, opts), pauseNative: function () {} },
            canvas: canvas, ctx: ctx,
            overlayCanvas: overlay, overlayCtx: overlay.getContext('2d'),
            videoWidth: 64, videoHeight: 48,
        };
    }

    function makeState(views, total) {
        return { views: views, currentFrame: 0, totalFrames: total, fps: 30, isPlaying: false };
    }

    // Run real rAF ticks for ~ms, then resolve.
    function runFor(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    var canRAF = (typeof requestAnimationFrame === 'function') && (typeof VideoController !== 'undefined');

    describe('Buffered playback: dispatch', function () {
        it('uses the buffered path when opted in (LUCID_PLAYBACK_BACKEND="buffered")',
            withFlag('buffered', function () {
                if (!canRAF) return;
                var drawn = [];
                var v = mockMbView('cam0', 200, drawn);
                var state = makeState([v], 200);
                var overlayFrames = [];
                var ctrl = new VideoController(state, {
                    drawOverlays: function (f) { overlayFrames.push(f); },
                    updateSeekbar: function () {},
                });
                ctrl.startPlayback();
                assertTrue(state.isPlaying, 'playing');
                // The buffered path records _bufViews; the native path never does.
                assertTrue(!!ctrl._bufViews, 'buffered path selected (_bufViews set)');
                ctrl.stopPlayback();
            }));

        it('defaults to the native path (no opt-in flag) even with mediabunny backends',
            withFlag(undefined, function () {
                if (!canRAF) return;
                var drawn = [];
                var v = mockMbView('cam0', 200, drawn);
                var state = makeState([v], 200);
                var ctrl = new VideoController(state, { drawOverlays: function () {}, updateSeekbar: function () {} });
                ctrl.startPlayback();
                assertTrue(!ctrl._bufViews, 'native path is the default (no _bufViews)');
                ctrl.stopPlayback();
            }));

        it('falls back to the native path when a view lacks a mediabunny backend (even opted in)',
            withFlag('buffered', function () {
                if (!canRAF) return;
                var drawn = [];
                var mb = mockMbView('cam0', 200, drawn);
                // A second view with a plain (non-mediabunny) decoder.
                var plainCanvas = document.createElement('canvas');
                var plain = {
                    name: 'cam1',
                    decoder: {
                        _fps: 30, samples: new Array(200), videoTrack: null,
                        seekNativeSettled: function () { return Promise.resolve(); },
                        seekNative: function () {}, playNative: function () {}, pauseNative: function () {},
                        drawCurrentFrame: function () {}, getCurrentFrameIndex: function () { return 0; },
                    },
                    canvas: plainCanvas, ctx: plainCanvas.getContext('2d'),
                    overlayCanvas: plainCanvas, overlayCtx: plainCanvas.getContext('2d'),
                    videoWidth: 64, videoHeight: 48,
                };
                var state = makeState([mb, plain], 200);
                var ctrl = new VideoController(state, { drawOverlays: function () {}, updateSeekbar: function () {} });
                ctrl.startPlayback();
                assertTrue(!ctrl._bufViews, 'native path selected (no _bufViews) when a view lacks mediabunny');
                ctrl.stopPlayback();
            }));
    });

    describe('Buffered playback: overlay is locked to the video frame (never leads)', function () {
        beforeEach(function () { if (typeof window !== 'undefined') window.LUCID_PLAYBACK_BACKEND = 'buffered'; });
        it('paints the pose overlay for the SAME index as the video bitmap', async function () {
            if (!canRAF) return;
            var drawn = [];              // video frame index per drawImage
            var pairs = [];              // [videoFrame, overlayFrame] per paint
            var recording = true;
            var v = mockMbView('cam0', 300, drawn);
            var state = makeState([v], 300);
            var ctrl = new VideoController(state, {
                drawOverlays: function (f) {
                    // paint() draws the video bitmap for `f` immediately before this.
                    if (recording) pairs.push([drawn.length ? drawn[drawn.length - 1] : null, f]);
                },
                updateSeekbar: function () {},
            });
            ctrl.startPlayback();
            await runFor(120);
            recording = false;   // ignore the final settle draw fired by stopPlayback
            ctrl.stopPlayback();

            assertTrue(pairs.length >= 1, 'advanced at least one frame during playback');
            for (var i = 0; i < pairs.length; i++) {
                assertEqual(pairs[i][1], pairs[i][0],
                    'overlay frame ' + pairs[i][1] + ' must equal the drawn video frame ' + pairs[i][0]
                    + ' (overlay must never lead the video)');
            }
            // And frames advance monotonically (no going backwards).
            for (var j = 1; j < pairs.length; j++) {
                assertTrue(pairs[j][1] >= pairs[j - 1][1], 'frames are non-decreasing');
            }
        });

        it('keeps two views on the same index (multi-view sync)', async function () {
            if (!canRAF) return;
            var d0 = [], d1 = [];
            var recording = true;
            var v0 = mockMbView('cam0', 300, d0);
            var v1 = mockMbView('cam1', 300, d1);
            var state = makeState([v0, v1], 300);
            var overlayAt = [];
            var ctrl = new VideoController(state, {
                drawOverlays: function (f) { if (recording) overlayAt.push(f); },
                updateSeekbar: function () {},
            });
            ctrl.startPlayback();
            await runFor(120);
            recording = false;   // ignore the final settle draw fired by stopPlayback
            ctrl.stopPlayback();

            // Every paint drew BOTH views' bitmap for the overlay's frame.
            assertTrue(overlayAt.length >= 1, 'advanced');
            assertEqual(d0.length, d1.length, 'both views drew the same number of frames');
            for (var i = 0; i < overlayAt.length; i++) {
                assertEqual(d0[i], overlayAt[i], 'view0 bitmap index matches overlay index');
                assertEqual(d1[i], overlayAt[i], 'view1 bitmap index matches overlay index');
            }
        });
    });

    describe('Buffered playback: underrun holds instead of leading', function () {
        beforeEach(function () { if (typeof window !== 'undefined') window.LUCID_PLAYBACK_BACKEND = 'buffered'; });
        it('never advances the overlay past a frame whose video is not yet decoded', async function () {
            if (!canRAF) return;
            var drawn = [];
            var recording = true;
            // stall: prefetch is called but never fills the cache → permanent underrun.
            var v = mockMbView('cam0', 300, drawn, { stall: true });
            var state = makeState([v], 300);
            var overlayFrames = [];
            var ctrl = new VideoController(state, {
                drawOverlays: function (f) { if (recording) overlayFrames.push(f); },
                updateSeekbar: function () {},
            });
            ctrl.startPlayback();
            await runFor(120);
            recording = false;   // ignore the final settle draw fired by stopPlayback
            ctrl.stopPlayback();

            // No frame ever decoded → nothing painted → overlay never advanced
            // (it held, it did NOT run ahead of the video).
            assertEqual(overlayFrames.length, 0,
                'with no decoded frames the overlay must not advance (no leading)');
            assertEqual(state.currentFrame, 0, 'stayed on the start frame under underrun');
        });
    });

    describe('Buffered playback: producer & cleanup', function () {
        beforeEach(function () { if (typeof window !== 'undefined') window.LUCID_PLAYBACK_BACKEND = 'buffered'; });
        it('prefetches frames AHEAD of the playhead', async function () {
            if (!canRAF) return;
            var drawn = [];
            var v = mockMbView('cam0', 400, drawn);
            var state = makeState([v], 400);
            var ctrl = new VideoController(state, { drawOverlays: function () {}, updateSeekbar: function () {} });
            ctrl.startPlayback();
            await runFor(120);
            var calls = v.decoder._mbBackend.prefetchCalls;
            ctrl.stopPlayback();

            assertTrue(calls.length >= 1, 'prefetch was called');
            var maxEnd = calls.reduce(function (m, c) { return Math.max(m, c[1]); }, -1);
            // Read-ahead window W ~ fps(30); we should have decoded well past the
            // handful of frames actually shown in ~120ms.
            assertTrue(maxEnd >= 10, 'prefetch reached ahead of the playhead (maxEnd=' + maxEnd + ')');
        });

        it('enlarges the backend cache during playback and restores it on stop', async function () {
            if (!canRAF) return;
            var drawn = [];
            var v = mockMbView('cam0', 400, drawn);
            var original = v.decoder._mbBackend.cacheSize;   // 30
            var state = makeState([v], 400);
            var ctrl = new VideoController(state, { drawOverlays: function () {}, updateSeekbar: function () {} });
            ctrl.startPlayback();
            assertTrue(v.decoder._mbBackend.cacheSize > original,
                'cacheSize enlarged for the read-ahead window (' + v.decoder._mbBackend.cacheSize + ' > ' + original + ')');
            await runFor(40);
            ctrl.stopPlayback();
            assertEqual(v.decoder._mbBackend.cacheSize, original, 'cacheSize restored on stop');
        });

        it('stops cleanly at the last frame', async function () {
            if (!canRAF) return;
            var drawn = [];
            var v = mockMbView('cam0', 8, drawn);   // tiny clip: 8 frames
            var state = makeState([v], 8);
            state.currentFrame = 0;
            var stopped = null;
            var ctrl = new VideoController(state, {
                drawOverlays: function () {}, updateSeekbar: function () {},
                onPlaybackStateChange: function (p) { stopped = !p; },
            });
            ctrl.startPlayback();
            await runFor(200);   // plenty of time to reach frame 7 at 30fps
            assertFalse(state.isPlaying, 'playback stopped at the end');
            assertTrue(state.currentFrame <= 7, 'did not run past the last frame');
        });
    });

    // The behavior describes above set the opt-in flag via beforeEach; clear it
    // so the setting doesn't leak into subsequent test files.
    describe('Buffered playback: opt-in flag cleanup', function () {
        it('clears LUCID_PLAYBACK_BACKEND', function () {
            if (typeof window !== 'undefined') window.LUCID_PLAYBACK_BACKEND = undefined;
            assertTrue(true);
        });
    });
})();
