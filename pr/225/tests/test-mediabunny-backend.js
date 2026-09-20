/**
 * test-mediabunny-backend.js — opt-in frame-accurate video backend (issue #115)
 *
 * HTML5 `<video>.currentTime` seeking is not frame-accurate, so the pose overlay
 * could sit on a stale video frame. `OnDemandVideoDecoder` can route `getFrame`
 * through sleap-io.js's frame-accurate `MediaBunnyVideoBackend` when
 * `LUCID_VIDEO_BACKEND === 'mediabunny'`.
 *
 * These tests exercise the INTEGRATION WIRING (flag detection, getFrame routing
 * + fallback, close) with a stubbed backend — the frame-accuracy of the decode
 * itself is a WebCodecs/hardware concern that a headless DOM-less runner can't
 * validate (headless software decode is itself frame-inaccurate).
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;
    var assertFalse = TF.assertFalse;

    function getDecoderClass() {
        if (typeof OnDemandVideoDecoder === 'function') return OnDemandVideoDecoder;
        if (typeof window !== 'undefined' && typeof window.OnDemandVideoDecoder === 'function') {
            return window.OnDemandVideoDecoder;
        }
        throw new Error('OnDemandVideoDecoder not loaded into sandbox');
    }

    // A decoder wired for the getFrame path without any real video/DOM.
    function makeDecoder() {
        var decoder = new (getDecoderClass())({ cacheSize: 10 });
        decoder.samples = new Array(100); // frame-count carrier (bounds check)
        decoder.cache = new Map();
        decoder._mp4Initialized = false;
        decoder._videoReady = true;
        return decoder;
    }

    // Run `fn` with the backend flag set to `val` (undefined = truly unset),
    // controlling BOTH window and localStorage so the ambient per-origin
    // localStorage value (the test-runner shares the app's origin) can't leak
    // in. Restores both afterward.
    function withFlag(val, fn) {
        var g = (typeof window !== 'undefined') ? window : globalThis;
        var hadWin = Object.prototype.hasOwnProperty.call(g, 'LUCID_VIDEO_BACKEND');
        var prevWin = g.LUCID_VIDEO_BACKEND;
        var hasLS = (typeof localStorage !== 'undefined');
        var prevLS = null;
        try { prevLS = hasLS ? localStorage.getItem('LUCID_VIDEO_BACKEND') : null; } catch (e) { hasLS = false; }
        if (hasLS) { try { localStorage.removeItem('LUCID_VIDEO_BACKEND'); } catch (e) {} }
        if (val === undefined) { try { delete g.LUCID_VIDEO_BACKEND; } catch (e) { g.LUCID_VIDEO_BACKEND = undefined; } }
        else g.LUCID_VIDEO_BACKEND = val;
        try { return fn(); }
        finally {
            if (hadWin) g.LUCID_VIDEO_BACKEND = prevWin;
            else { try { delete g.LUCID_VIDEO_BACKEND; } catch (e) { g.LUCID_VIDEO_BACKEND = undefined; } }
            if (hasLS) {
                try {
                    if (prevLS === null) localStorage.removeItem('LUCID_VIDEO_BACKEND');
                    else localStorage.setItem('LUCID_VIDEO_BACKEND', prevLS);
                } catch (e) {}
            }
        }
    }

    describe('Issue #115: mediabunny backend is default-on with an html5 opt-out', function () {
        it('_mediabunnyEnabled() defaults ON and only html5/legacy opts out', function () {
            var d = makeDecoder();
            // Default (flag unset) must be ON — the fix has to work on any origin
            // (e.g. a PR preview) without a per-origin localStorage flag.
            withFlag(undefined, function () { assertTrue(d._mediabunnyEnabled(), 'default (unset) → enabled'); });
            withFlag('mediabunny', function () { assertTrue(d._mediabunnyEnabled(), "'mediabunny' → enabled"); });
            withFlag('html5', function () { assertFalse(d._mediabunnyEnabled(), "'html5' → disabled (opt-out)"); });
            withFlag('HTML5', function () { assertFalse(d._mediabunnyEnabled(), 'opt-out is case-insensitive'); });
            withFlag('legacy', function () { assertFalse(d._mediabunnyEnabled(), "'legacy' → disabled (opt-out)"); });
        });
    });

    describe('Issue #115: getFrame routing through the mediabunny backend', function () {
        it('returns the mediabunny frame when the backend has it', async function () {
            var d = makeDecoder();
            var htmlCalls = 0;
            d._getFrameHTML5 = function () { htmlCalls++; return Promise.resolve({ src: 'html5' }); };
            d._mbBackend = { getFrame: function (i) { return Promise.resolve({ src: 'mb', i: i }); } };

            var frame = await d.getFrame(7);
            assertEqual(frame.src, 'mb', 'frame came from the mediabunny backend');
            assertEqual(frame.i, 7, 'for the requested index');
            assertEqual(htmlCalls, 0, 'HTML5 path not used when mediabunny returns a frame');
        });

        it('falls back to HTML5 when the backend returns null', async function () {
            var d = makeDecoder();
            d._getFrameHTML5 = function () { return Promise.resolve({ src: 'html5' }); };
            d._mbBackend = { getFrame: function () { return Promise.resolve(null); } };

            var frame = await d.getFrame(7);
            assertEqual(frame.src, 'html5', 'null from mediabunny → HTML5 fallback');
        });

        it('falls back to HTML5 when the backend throws', async function () {
            var d = makeDecoder();
            d._getFrameHTML5 = function () { return Promise.resolve({ src: 'html5' }); };
            d._mbBackend = { getFrame: function () { return Promise.reject(new Error('decode fail')); } };

            var frame = await d.getFrame(7);
            assertEqual(frame.src, 'html5', 'mediabunny error → HTML5 fallback (no throw)');
        });

        it('uses HTML5 directly when no backend is attached (default)', async function () {
            var d = makeDecoder();
            var used = null;
            d._getFrameHTML5 = function () { used = 'html5'; return Promise.resolve({ src: 'html5' }); };
            // d._mbBackend stays null (constructor default)
            var frame = await d.getFrame(7);
            assertEqual(frame.src, 'html5', 'no backend → HTML5');
            assertEqual(used, 'html5', 'HTML5 path invoked');
        });

        // Regression: getFrame() used to check the shared this.cache BEFORE
        // trying the mediabunny backend. That cache is ALSO written by
        // _getFrameHTML5 (real addToCache). So a frame that EVER fell through
        // to HTML5 once — a transient decode hiccup, mediabunny not ready
        // yet, anything — got permanently cached, and every FUTURE request
        // for that exact index (even a single, deliberate, non-racing
        // re-visit) returned the stale, frame-INACCURATE HTML5 bitmap
        // forever, never retrying mediabunny again for that index. Reported
        // live as "frame seeking is definitely pulling the wrong frame, no
        // doubt about it" even on single deliberate taps (no concurrency).
        it('does not let a cached HTML5 fallback permanently shadow mediabunny once it recovers', async function () {
            var d = makeDecoder();
            var mbShouldFail = true;
            var mbCallCount = 0;
            d._mbBackend = {
                getFrame: function (i) {
                    mbCallCount++;
                    return Promise.resolve(mbShouldFail ? null : { src: 'mb', i: i });
                },
            };
            // Real addToCache behavior (unlike the plain-stub HTML5 mocks
            // above) — this is the exact mechanism that poisons this.cache.
            d._getFrameHTML5 = function (i) {
                var bitmap = { src: 'html5', i: i };
                this.addToCache(i, bitmap);
                return Promise.resolve(bitmap);
            };

            var first = await d.getFrame(7); // mediabunny fails → HTML5 fallback, cached
            assertEqual(first.src, 'html5', 'first call falls through to HTML5 as expected');

            mbShouldFail = false; // mediabunny "recovers"
            var second = await d.getFrame(7); // same index, single deliberate re-request
            assertEqual(second.src, 'mb', 'second request for the SAME index gets the correct mediabunny frame, not the stale cached HTML5 one');
            assertEqual(mbCallCount, 2, 'mediabunny was retried on the second request — the cache never short-circuited past it');
        });
    });

    describe('Issue #115 followup: concurrent getFrame() calls serialize into the mediabunny backend', function () {
        it('never has more than one call into _mbBackend.getFrame in flight at once', async function () {
            var d = makeDecoder();
            var activeCalls = 0;
            var maxConcurrent = 0;
            d._mbBackend = {
                getFrame: function (i) {
                    activeCalls++;
                    maxConcurrent = Math.max(maxConcurrent, activeCalls);
                    return new Promise(function (resolve) {
                        setTimeout(function () {
                            activeCalls--;
                            resolve({ src: 'mb', i: i });
                        }, 10);
                    });
                },
            };

            // Rapid arrow-key stepping fires overlapping getFrame() calls without
            // awaiting the previous one (ui-wiring.js's arrow handler doesn't
            // await videoController.seekToFrame()) — reproduce that here.
            var results = await Promise.all([0, 1, 2, 3, 4].map(function (i) { return d.getFrame(i); }));

            assertEqual(maxConcurrent, 1, 'at most one call into the backend in flight at a time');
            for (var i = 0; i < results.length; i++) {
                assertEqual(results[i].i, i, 'call ' + i + ' resolved with its own requested frame index, not a racing one');
            }
        });

        it('preserves call order even when later calls would otherwise decode faster', async function () {
            var d = makeDecoder();
            var order = [];
            d._mbBackend = {
                getFrame: function (i) {
                    return new Promise(function (resolve) {
                        setTimeout(function () { order.push(i); resolve({ src: 'mb', i: i }); }, (5 - i) * 5);
                    });
                },
            };
            // Even though later-requested frames (3, 4) have SHORTER simulated
            // decode latency than earlier ones (0, 1), the lock forces strict
            // call-order execution — this is what prevents an out-of-order
            // completion from painting a stale frame over a newer one.
            await Promise.all([0, 1, 2, 3, 4].map(function (i) { return d.getFrame(i); }));
            assertEqual(order.join(','), '0,1,2,3,4', 'backend calls execute strictly in call order despite varying simulated latency');
        });
    });

    describe('Issue #115: close() releases the mediabunny backend', function () {
        it('calls backend.close() and clears the reference', function () {
            var d = makeDecoder();
            var closed = 0;
            d._videoEl = null;            // skip HTML5 element teardown
            d.decoder = null;
            d._mbBackend = { close: function () { closed++; } };

            d.close();
            assertEqual(closed, 1, 'backend.close() called once');
            assertTrue(d._mbBackend === null, 'backend reference cleared');
        });
    });
})();
