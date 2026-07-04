/**
 * test-sleap-loading.js — unit tests for the sleap-io.js video-loading backend.
 *
 * Covers the decoder-factory backend selection and SleapVideoDecoder's drop-in
 * parity with the legacy OnDemandVideoDecoder. The sleap backend streams via
 * WebCodecs from bounded slices / HTTP Range and uses NO HTML5 <video> element
 * — the fix for the "Aw Snap" out-of-memory crash when loading large videos
 * (esp. from server mounts, where a <video> element buffers the whole file).
 *
 * The real decode + streaming behavior (Range requests, actual frame decode) is
 * exercised in a real browser by tests/e2e/sleap-video-streaming.mjs.
 *
 * Bridged globals: createVideoDecoder, DEFAULT_VIDEO_BACKEND (decoder-factory),
 * SleapVideoDecoder (sleap-video-adapter), OnDemandVideoDecoder (video.js).
 */
(function () {
    const { describe, it, beforeEach, assert, assertEqual, assertTrue, assertFalse } = TestFramework;

    var LS_KEY = 'LUCID_VIDEO_BACKEND';
    function clearOverride() { try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ } }
    function setOverride(v) { try { localStorage.setItem(LS_KEY, v); } catch (e) { /* ignore */ } }

    // ---------------------------------------------------------------
    // decoder-factory backend selection (first match wins:
    //   opts.backend → forceSleap → forceLegacy → localStorage → default)
    // ---------------------------------------------------------------
    describe('Sleap loading — decoder-factory backend selection', function () {
        beforeEach(function () { clearOverride(); });

        it('default backend is "sleap" (the integration goal)', function () {
            assertEqual(DEFAULT_VIDEO_BACKEND, 'sleap', 'build default is sleap');
            assertTrue(createVideoDecoder({}) instanceof SleapVideoDecoder,
                'no opts + no override → sleap decoder');
            clearOverride();
        });

        it('explicit opts.backend selects the backend', function () {
            assertTrue(createVideoDecoder({ backend: 'sleap' }) instanceof SleapVideoDecoder, 'backend:sleap');
            assertTrue(createVideoDecoder({ backend: 'legacy' }) instanceof OnDemandVideoDecoder, 'backend:legacy');
        });

        it('forceSleap / forceLegacy flags select the backend', function () {
            assertTrue(createVideoDecoder({ forceSleap: true }) instanceof SleapVideoDecoder, 'forceSleap');
            assertTrue(createVideoDecoder({ forceLegacy: true }) instanceof OnDemandVideoDecoder, 'forceLegacy');
        });

        it('localStorage LUCID_VIDEO_BACKEND flips the default at runtime (no code change)', function () {
            setOverride('legacy');
            assertTrue(createVideoDecoder({}) instanceof OnDemandVideoDecoder, 'override → legacy');
            setOverride('sleap');
            assertTrue(createVideoDecoder({}) instanceof SleapVideoDecoder, 'override → sleap');
            clearOverride();
        });

        it('explicit opts beat the localStorage override', function () {
            setOverride('legacy');
            assertTrue(createVideoDecoder({ backend: 'sleap' }) instanceof SleapVideoDecoder, 'opts.backend beats override');
            assertTrue(createVideoDecoder({ forceSleap: true }) instanceof SleapVideoDecoder, 'forceSleap beats override');
            clearOverride();
        });

        it('an invalid override is ignored (falls back to the default)', function () {
            setOverride('banana');
            assertTrue(createVideoDecoder({}) instanceof SleapVideoDecoder, 'garbage override → default sleap');
            clearOverride();
        });
    });

    // ---------------------------------------------------------------
    // SleapVideoDecoder drop-in parity + the memory-fix property
    // ---------------------------------------------------------------
    describe('Sleap loading — SleapVideoDecoder drop-in parity', function () {
        it('exposes the shared decoder interface', function () {
            var s = new SleapVideoDecoder({});
            ['init', 'getFrame', 'close', '_emitProgress'].forEach(function (m) {
                assertEqual(typeof s[m], 'function', 'SleapVideoDecoder.' + m + ' is a function');
            });
        });

        it('shares the core method surface with the legacy decoder', function () {
            var legacy = new OnDemandVideoDecoder({});
            var sleap = new SleapVideoDecoder({});
            ['init', 'getFrame', 'close'].forEach(function (m) {
                assertEqual(typeof legacy[m], 'function', 'legacy has ' + m);
                assertEqual(typeof sleap[m], 'function', 'sleap has ' + m);
            });
        });

        it('exposes the metadata fields the app reads', function () {
            var s = new SleapVideoDecoder({});
            assertTrue(Array.isArray(s.samples), '.samples is an array');
            assertTrue(Array.isArray(s.keyframeIndices), '.keyframeIndices is an array');
            assertEqual(typeof s._fps, 'number', '._fps is a number');
        });

        it('honors cacheSize / lookahead / onProgress options', function () {
            var calls = [];
            var s = new SleapVideoDecoder({ cacheSize: 7, lookahead: 3, onProgress: function (e) { calls.push(e); } });
            assertEqual(s.cacheSize, 7, 'cacheSize wired');
            assertEqual(s.lookahead, 3, 'lookahead wired');
            s._emitProgress({ phase: 'test' });
            assertEqual(calls.length, 1, 'onProgress callback fired via _emitProgress');
        });

        it('getFrame rejects out-of-range indices without decoding', async function () {
            var s = new SleapVideoDecoder({});
            // samples is empty before init → any index is out of range → null
            var frame = await s.getFrame(0);
            assertTrue(frame === null || frame === undefined, 'out-of-range frame returns null (no crash)');
        });

        it('uses NO HTML5 <video> element — the memory-fix property', function () {
            var s = new SleapVideoDecoder({});
            assertTrue(s._videoEl === null,
                'sleap decoder keeps _videoEl null (no whole-file <video> preload → no OOM on large/server files)');
        });
    });
})();
