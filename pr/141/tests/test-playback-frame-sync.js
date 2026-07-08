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
})();
