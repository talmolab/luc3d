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
    describe('Playback: overlay follows the presented frame (rVFC mediaTime), not the clock', function () {
        it('draws the overlay for the presented frame even when currentTime leads', async function () {
            if (typeof VideoController === 'undefined') return;
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
        });
    });

    // The definitive fix: when a mediabunny backend is present, playback draws
    // the video AND the pose overlay from the SAME frame index (wall-clock
    // driven), so they can never desync regardless of decode timing.
    describe('Playback: unified mediabunny source draws video + overlay for the same frame', function () {
        it('video frame index === overlay frame index (cannot desync)', async function () {
            if (typeof VideoController === 'undefined') return;
            var drawnVideoFrame = null, overlayFrame = null;
            var decoder = {
                _fps: 60,
                _mbBackend: { prefetch: function () {} },   // presence selects the unified path
                getFrame: function (n) { return Promise.resolve({ __frame: n }); },
                pauseNative: function () {},
            };
            var view = {
                name: 'cam1', decoder: decoder,
                canvas: { width: 64, height: 64 },
                ctx: { drawImage: function (bmp) { drawnVideoFrame = bmp.__frame; } },
                overlayCanvas: { width: 64, height: 64 },
                overlayCtx: { clearRect: function () {} },
                videoWidth: 64, videoHeight: 64,
            };
            var state = { views: [view], currentFrame: 600, totalFrames: 20000, fps: 60, isPlaying: false, speedMultiplier: 1 };
            var ctrl = new VideoController(state, {
                drawOverlays: function (f) { overlayFrame = f; },
                updateSeekbar: function () {},
            });

            ctrl.startPlayback();
            // Let a few rAF ticks + their getFrame/overlay microtasks settle.
            await new Promise(function (r) { setTimeout(r, 80); });
            ctrl.stopPlayback();

            assertTrue(drawnVideoFrame !== null, 'a video frame was drawn');
            assertTrue(overlayFrame !== null, 'an overlay frame was drawn');
            assertEqual(drawnVideoFrame, overlayFrame,
                'video and overlay are drawn for the SAME frame — unified source cannot desync');
            assertTrue(overlayFrame >= 600, 'wall clock advanced from the start frame');
        });
    });
})();
