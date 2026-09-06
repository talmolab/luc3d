/**
 * test-slp-import-parallel-videos.js — Feature: within a single session being
 * imported, all videos load IN PARALLEL.
 *
 * Per spec for "Progress modal on SLP project import":
 *   - Sessions load sequentially; videos within a session load in parallel.
 *
 * Test: drive a 1-session, 3-video import through the (new) SLP-import-with-
 * modal entry point. Each fake decoder records a begin-timestamp when its
 * switchSource/init starts. Assert: all three decoders begin within a tight
 * window (1 ms) — i.e., they were dispatched in the same microtask tick.
 *
 * Pattern after test-switchsession-parallel-decoders.js (which pins this
 * invariant for switchSession). For SLP project import, the spec requires
 * the same Promise.all-style fan-out per session.
 *
 * Pre-fix: the importer function does not exist; getImporter() throws and
 * the test fails. Even if a partial implementation exists that loads
 * sequentially per video, the begin-spread assertion below catches it.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertTrue = TF.assertTrue;

    function getImporter() {
        var names = [
            'importSlpProjectWithProgress',
            'handleLoadSlpFileWithModal',
            'handleLoadSlpProjectWithProgress',
        ];
        for (var i = 0; i < names.length; i++) {
            var n = names[i];
            if (typeof globalThis !== 'undefined' && typeof globalThis[n] === 'function') {
                return globalThis[n];
            }
            // eslint-disable-next-line no-undef
            if (typeof window !== 'undefined' && typeof window[n] === 'function') {
                // eslint-disable-next-line no-undef
                return window[n];
            }
            try {
                // eslint-disable-next-line no-eval
                var found = eval('typeof ' + n + " === 'function' ? " + n + ' : null');
                if (found) return found;
            } catch (_e) {}
        }
        throw new Error(
            'SLP-import-with-modal entry point not available. ' +
            'Expected one of: ' + names.join(', ') + '.'
        );
    }

    /**
     * Decoder that records begin-time when its async work starts. The work
     * itself takes `delayMs` and is otherwise inert.
     */
    function makeRecordingDecoder(vfIdx, delayMs, beginLog) {
        return {
            id: 'd-' + vfIdx,
            videoTrack: { video: { width: 640, height: 480 } },
            samples: new Array(100),
            init: function (file) {
                beginLog.push({ vfIdx: vfIdx, t: Date.now() });
                return new Promise(function (resolve) {
                    setTimeout(resolve, delayMs);
                });
            },
            switchSource: function (file) {
                beginLog.push({ vfIdx: vfIdx, t: Date.now() });
                return new Promise(function (resolve) {
                    setTimeout(resolve, delayMs);
                });
            },
        };
    }

    describe('SLP project import: parallel videos within a session', function () {
        it('all videos in a session begin loading within the same microtask tick', async function () {
            var importer;
            try { importer = getImporter(); } catch (e) { throw e; }

            // Staggered delays — only the BEGIN times matter for this test;
            // we expect parallel dispatch, so all begins should be within
            // a tight window. The 50/10/30 ms variance in the actual loads
            // would cause sequential begins to spread across ~60 ms.
            var beginLog = [];
            var DELAY_0 = 50;
            var DELAY_1 = 10;
            var DELAY_2 = 30;

            var d0 = makeRecordingDecoder(0, DELAY_0, beginLog);
            var d1 = makeRecordingDecoder(1, DELAY_1, beginLog);
            var d2 = makeRecordingDecoder(2, DELAY_2, beginLog);

            // Single session, 3 videos.
            var sessions = [
                {
                    name: 'session_A',
                    videoFiles: [
                        { file: { name: 'cam0.mp4' } },
                        { file: { name: 'cam1.mp4' } },
                        { file: { name: 'cam2.mp4' } },
                    ],
                    cameras: [],
                    skeleton: null,
                    frames: [],
                },
            ];

            function decoderFor(sessionIdx, vfIdx) {
                return [d0, d1, d2][vfIdx];
            }

            await importer({
                sessions: sessions,
                decoderFactory: decoderFor,
                state: {
                    videoFiles: sessions[0].videoFiles.map(function (vf, vi) {
                        return { file: vf.file, sessionIdx: 0, decoder: null };
                    }),
                    sessions: sessions,
                    decoderPool: [],
                    activeSessionIdx: 0,
                    currentFrame: 0,
                    triangulationResults: new Map(),
                },
            });

            // Three begin events expected.
            assertTrue(
                beginLog.length === 3,
                'Expected 3 begin events (3 videos in 1 session); got ' +
                beginLog.length + '. Trace: ' + JSON.stringify(beginLog)
            );

            // Spread between the first and last begin must be tight.
            // A parallel Promise.all dispatch has all callbacks fire in
            // the same microtask tick (spread ~0 ms). A sequential
            // implementation would space them by ~delay (>= 10 ms).
            var times = beginLog.map(function (e) { return e.t; });
            var minT = Math.min.apply(null, times);
            var maxT = Math.max.apply(null, times);
            var spread = maxT - minT;
            var SPREAD_LIMIT_MS = 5; // tight bound; well under min(DELAY_*) = 10 ms
            assertTrue(
                spread <= SPREAD_LIMIT_MS,
                'Videos within a session must dispatch in parallel — all 3 ' +
                'decoder begins should fire in the same microtask tick. ' +
                'Observed spread: ' + spread + ' ms (limit ' + SPREAD_LIMIT_MS +
                ' ms). A spread >= ' + Math.min(DELAY_0, DELAY_1, DELAY_2) +
                ' ms indicates sequential dispatch. Trace: ' +
                JSON.stringify(beginLog)
            );
        });
    });
})();
