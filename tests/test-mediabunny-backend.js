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

    // Run `fn` with window.LUCID_VIDEO_BACKEND set to `val`, then restore.
    function withFlag(val, fn) {
        var g = (typeof window !== 'undefined') ? window : globalThis;
        var had = Object.prototype.hasOwnProperty.call(g, 'LUCID_VIDEO_BACKEND');
        var prev = g.LUCID_VIDEO_BACKEND;
        if (val === undefined) { try { delete g.LUCID_VIDEO_BACKEND; } catch (e) { g.LUCID_VIDEO_BACKEND = undefined; } }
        else g.LUCID_VIDEO_BACKEND = val;
        try { return fn(); }
        finally {
            if (had) g.LUCID_VIDEO_BACKEND = prev;
            else { try { delete g.LUCID_VIDEO_BACKEND; } catch (e) { g.LUCID_VIDEO_BACKEND = undefined; } }
        }
    }

    describe('Issue #115: mediabunny backend opt-in flag', function () {
        it('_mediabunnyEnabled() honors window.LUCID_VIDEO_BACKEND', function () {
            var d = makeDecoder();
            withFlag('mediabunny', function () { assertTrue(d._mediabunnyEnabled(), "'mediabunny' → enabled"); });
            withFlag('MediaBunny', function () { assertTrue(d._mediabunnyEnabled(), 'case-insensitive'); });
            withFlag('html5', function () { assertFalse(d._mediabunnyEnabled(), "'html5' → disabled"); });
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
