/**
 * test-html5-seek-tolerance.js — High-fps frame-stepping bug (issue #89)
 *
 * `OnDemandVideoDecoder._getFrameHTML5` guarded its seek with a FIXED tolerance:
 *
 *     if (Math.abs(currentTime - time) > 0.01) { ...seek... }
 *
 * 10 ms is fine at 30 fps (33 ms/frame) but at 400 fps (2.5 ms/frame) the band
 * spans ~4 frames, so requests for adjacent frames never re-seek and the
 * display freezes — only ~every 4th step advanced. (Note: the HTML5 path is the
 * ONLY live frame-extraction path; `_mp4Initialized` is never set true, so the
 * WebCodecs branch is dead code. See loading/video.js:294-298.)
 *
 * Fix: tolerance = half a frame period (0.5 / fps), which always re-seeks for
 * adjacent frames while still short-circuiting a redundant request for the
 * frame already displayed.
 *
 * Strategy (mirrors test-switchsource-mp4box-await.js):
 *   - Instantiate OnDemandVideoDecoder directly.
 *   - Stub `_videoEl` with a `currentTime` getter/setter that records every
 *     assignment (= one real seek) and fires a synthetic "seeked" event.
 *   - Stub `_offCtx.drawImage` and a global `createImageBitmap` so
 *     `_getFrameHTML5` runs to completion without a real canvas/video.
 *   - Drive getFrame() across consecutive frames and count the seeks.
 *
 * Pre-fix: stepping frames 1→2→3 at 400 fps records 0 seeks (all inside the
 *   10 ms band) — the frame stays frozen.
 * Post-fix: each adjacent frame records a distinct seek (3 total).
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;

    // Resolved at test-execution time (after the browser's module bridge runs).
    function getDecoderClass() {
        if (typeof OnDemandVideoDecoder === 'function') return OnDemandVideoDecoder;
        if (typeof window !== 'undefined' && typeof window.OnDemandVideoDecoder === 'function') {
            return window.OnDemandVideoDecoder;
        }
        throw new Error('OnDemandVideoDecoder not loaded into sandbox');
    }

    // Stub <video> element. `currentTime` is a getter/setter: each assignment
    // records the value (one real seek) and asynchronously fires the "seeked"
    // listener that _getFrameHTML5's seekPromise awaits.
    function makeStubVideoEl() {
        var seekedListeners = [];
        var el = {
            readyState: 2, // HAVE_CURRENT_DATA — skips the canplay wait branch
            _ct: 0,
            seeks: [],     // every currentTime assignment, in order
            addEventListener: function (evt, cb) {
                if (evt === 'seeked') seekedListeners.push(cb);
            },
            removeEventListener: function () {},
        };
        Object.defineProperty(el, 'currentTime', {
            get: function () { return el._ct; },
            set: function (v) {
                el._ct = v;
                el.seeks.push(v);
                var fns = seekedListeners.splice(0);
                setTimeout(function () { fns.forEach(function (f) { f(); }); }, 0);
            },
        });
        return el;
    }

    // Build a decoder wired for the HTML5 path with the given fps.
    function makeDecoder(DecoderClass, fps, frameCount) {
        var decoder = new DecoderClass({ cacheSize: 200 });
        decoder._fps = fps;
        decoder._videoReady = true;
        decoder._mp4Initialized = false;
        decoder.samples = new Array(frameCount);
        decoder.cache = new Map();
        decoder._html5SeekLock = null;
        decoder._videoEl = makeStubVideoEl();
        decoder._offCanvas = { width: 8, height: 8 };
        decoder._offCtx = { drawImage: function () {} };
        return decoder;
    }

    // Run `fn` with a stubbed global createImageBitmap, restoring afterward so
    // the real browser implementation is left untouched for other suites.
    async function withStubbedBitmap(fn) {
        var g = (typeof globalThis !== 'undefined') ? globalThis
            : (typeof window !== 'undefined' ? window : this);
        var had = Object.prototype.hasOwnProperty.call(g, 'createImageBitmap');
        var orig = g.createImageBitmap;
        g.createImageBitmap = function () {
            return Promise.resolve({ width: 8, height: 8, close: function () {} });
        };
        try {
            return await fn();
        } finally {
            if (had) g.createImageBitmap = orig;
            else { try { delete g.createImageBitmap; } catch (e) { g.createImageBitmap = undefined; } }
        }
    }

    describe('Issue #89: HTML5 seek tolerance scales with frame rate', function () {
        it('re-seeks for every adjacent frame at 400 fps (no frozen frames)', async function () {
            var decoder = makeDecoder(getDecoderClass(), 400, 1000);

            await withStubbedBitmap(async function () {
                // Frame 0 sits at currentTime 0 (no seek needed). Then step
                // through three adjacent frames; each must trigger its own seek.
                await decoder.getFrame(0);
                await decoder.getFrame(1);
                await decoder.getFrame(2);
                await decoder.getFrame(3);
            });

            assertEqual(
                decoder._videoEl.seeks.length,
                3,
                'At 400 fps, stepping frames 1→2→3 must record 3 distinct seeks ' +
                '(one per frame). Observed ' + decoder._videoEl.seeks.length + '. ' +
                'A count of 0 means the fixed 10 ms tolerance swallowed every ' +
                'adjacent-frame seek (the frozen-frame bug, loading/video.js).'
            );
        });

        it('still advances for adjacent frames at 30 fps (no regression)', async function () {
            var decoder = makeDecoder(getDecoderClass(), 30, 1000);

            await withStubbedBitmap(async function () {
                await decoder.getFrame(10);
                await decoder.getFrame(11);
            });

            assertEqual(
                decoder._videoEl.seeks.length,
                2,
                'At 30 fps, stepping frame 10→11 must record 2 distinct seeks. ' +
                'Observed ' + decoder._videoEl.seeks.length + '.'
            );
        });

        it('short-circuits a redundant request for the frame already displayed', async function () {
            var decoder = makeDecoder(getDecoderClass(), 30, 1000);

            await withStubbedBitmap(async function () {
                await decoder.getFrame(10); // 1 seek lands us on frame 10
                decoder.cache.clear();      // bypass the cache so getFrame re-evaluates the guard
                await decoder.getFrame(10); // already on this frame → no new seek
            });

            assertEqual(
                decoder._videoEl.seeks.length,
                1,
                'Re-requesting the current frame must NOT seek again ' +
                '(half-frame tolerance short-circuit). Observed ' +
                decoder._videoEl.seeks.length + ' seeks.'
            );
        });
    });
})();
