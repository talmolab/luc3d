/**
 * test-switchsource-mp4box-await.js — Bug A: OnDemandVideoDecoder.switchSource
 * does not await _initMp4box, so when a session switch happens to a video with
 * a non-30fps frame rate, callers race the un-awaited mp4box init and read
 * the stale 30-fps estimate (`samples.length === duration * 30`) instead of
 * the real mp4 sample count.
 *
 * Real-world repro: opening emg-project.slp and switching A36-1 -> AT006 ->
 * AT013 yielded state.totalFrames = 215633 (30 * 7188) instead of the correct
 * 179694 (~25 fps * 7188).
 *
 * Strategy:
 *   - Instantiate OnDemandVideoDecoder directly.
 *   - Stub `_videoEl` (so `canplay` fires immediately and width/height/duration
 *     are deterministic), `_offCanvas`, and override `_initMp4box` to be async:
 *     it resolves on a setTimeout(..., 0) AFTER setting `samples` to the real
 *     mp4 sample count (2500 = 25 fps * 100 s).
 *   - Call `await decoder.switchSource(mockFile)`.
 *   - Assert `decoder.samples.length === 2500`.
 *
 * Pre-fix: switchSource fires `_initMp4box` without awaiting; it returns
 *   before the stub has a chance to overwrite `samples`, so the test sees
 *   the 30-fps estimate (3000) instead of 2500.
 * Post-fix: switchSource awaits `_initMp4box`, samples.length === 2500.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;

    // OnDemandVideoDecoder is resolved at test-execution time, not
    // registration time. The browser runner loads test files as classic
    // <script> tags, which execute BEFORE the <script type="module"> that
    // bridges video.js's exports onto window — so a top-level typeof check
    // here would always see the symbol as missing in the browser. By
    // resolving inside `it()` (which runs from runAll() after the bridge
    // has executed), both Node and browser sandboxes find it.
    function getDecoderClass() {
        if (typeof OnDemandVideoDecoder === 'function') return OnDemandVideoDecoder;
        if (typeof window !== 'undefined' && typeof window.OnDemandVideoDecoder === 'function') {
            return window.OnDemandVideoDecoder;
        }
        throw new Error('OnDemandVideoDecoder not loaded into sandbox');
    }

    // -- Helpers --

    // Build a stub <video> element whose addEventListener resolves the
    // "canplay" promise immediately (microtask). Width/height/duration
    // values are taken from the parameter object.
    function makeStubVideoEl(opts) {
        var el = {
            videoWidth: opts.width,
            videoHeight: opts.height,
            duration: opts.duration,
            src: '',
            error: null,
            readyState: 4,
            addEventListener: function (evt, cb, options) {
                if (evt === 'canplay') {
                    setTimeout(cb, 0);
                }
                // 'error' listener: never fires in this test
            },
            removeEventListener: function () {},
            muted: false,
            playsInline: false,
            preload: '',
        };
        return el;
    }

    function makeStubOffCanvas(w, h) {
        return { width: w, height: h, getContext: function () { return {}; } };
    }

    describe('Bug A: OnDemandVideoDecoder.switchSource awaits _initMp4box', function () {
        it('samples.length reflects the real mp4 sample count, not the 30-fps estimate', async function () {
            var DecoderClass = getDecoderClass();
            var decoder = new DecoderClass({ cacheSize: 60, lookahead: 10 });

            // Pre-seed the fields that init() would normally set, so we can
            // jump straight to switchSource without going through init().
            var WIDTH = 640;
            var HEIGHT = 480;
            var DURATION = 100;            // 100 seconds
            var REAL_FRAME_COUNT = 2500;   // 25 fps * 100 s (real mp4 count)
            var ESTIMATE_FRAME_COUNT = 3000; // 30 fps * 100 s (HTML5 fallback)

            decoder._videoEl = makeStubVideoEl({ width: WIDTH, height: HEIGHT, duration: DURATION });
            decoder._offCanvas = makeStubOffCanvas(WIDTH, HEIGHT);
            decoder._offCtx = {};
            decoder.cache = new Map();
            decoder.fileSize = 1;
            decoder.sourceType = 'file';

            // Override _initMp4box: async, resolves on next tick after
            // overwriting samples to the real count. If switchSource awaits
            // _initMp4box, samples.length === REAL_FRAME_COUNT by the time
            // switchSource returns. If it doesn't await, samples.length is
            // still ESTIMATE_FRAME_COUNT (the 30-fps estimate).
            decoder._initMp4box = function () {
                var self = this;
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        self.samples = new Array(REAL_FRAME_COUNT);
                        resolve();
                    }, 0);
                });
            };

            // Mock file source. Browsers' real URL.createObjectURL (called
            // inside switchSource) strictly validates the argument and
            // rejects plain objects, so we use a real File. The Node sandbox
            // (tests/run-node.js) does not expose File and stubs
            // URL.createObjectURL as a no-op that accepts anything, so a
            // plain duck-typed object is fine there.
            var mockFile;
            if (typeof File === 'function') {
                mockFile = new File([new Uint8Array(1024)], 'mock.mp4', { type: 'video/mp4' });
            } else {
                mockFile = { name: 'mock.mp4', size: 1024 };
            }

            await decoder.switchSource(mockFile);

            assertEqual(
                decoder.samples.length,
                REAL_FRAME_COUNT,
                'After switchSource resolves, samples.length must equal the real ' +
                'mp4 sample count (' + REAL_FRAME_COUNT + '). Observed: ' +
                decoder.samples.length + '. If samples.length === ' +
                ESTIMATE_FRAME_COUNT + ', switchSource did not await ' +
                '_initMp4box (Bug A: loading/video.js:788).'
            );
        });
    });
})();
