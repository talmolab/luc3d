/**
 * test-slp-import-sequential.js — Feature: SLP project import loads sessions
 * SEQUENTIALLY (videos within a session may load in parallel, but session N+1
 * may not begin loading any of its videos until every video in session N has
 * completed).
 *
 * Per spec for "Progress modal on SLP project import":
 *   - On SLP project import, show progress for every session in the file.
 *   - Sessions load **sequentially**.
 *   - Videos within a session load **in parallel**.
 *
 * This test drives a fake 3-session project through the SLP-import-with-modal
 * entry point. Each fake decoder records a (sessionIdx, vfIdx, beginTs)
 * tuple when its switchSource (or init) starts, and an (endTs) when it
 * resolves. We then assert ordering:
 *
 *   - Every video in session 0 has end <= every begin in session 1.
 *   - Every video in session 1 has end <= every begin in session 2.
 *
 * The feature introduces a function we'll resolve at test time. The spec
 * is non-committal about the exact name (it's called out as "the
 * SLP-import-with-modal function the feature introduces"), so we accept
 * either of:
 *   - importSlpProjectWithProgress({...})
 *   - handleLoadSlpFileWithModal({...})
 * resolved from globals / window / module exports.
 *
 * Pre-fix: the function does not exist in any namespace, so getImporter()
 * throws and the test fails with "SLP-import-with-modal entry point not
 * available...".
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
                // sandbox: bare global lookup
                // eslint-disable-next-line no-eval
                var found = eval('typeof ' + n + " === 'function' ? " + n + ' : null');
                if (found) return found;
            } catch (_e) {}
        }
        throw new Error(
            'SLP-import-with-modal entry point not available. ' +
            'Expected one of: ' + names.join(', ') +
            ' to be exported from import-export/slp-import.js (or attached to ' +
            'window). The feature must introduce a function that drives ' +
            'session-by-session loading with a LoadingProgressModal.'
        );
    }

    /**
     * Build a fake decoder that records its switchSource (or init) begin/end
     * timestamps into the shared events array. Returns a stub object usable
     * in either the existing decoderPool slot or as a freshly-constructed
     * decoder.
     */
    function makeRecordingDecoder(sessionIdx, vfIdx, delayMs, events) {
        return {
            id: 'd-s' + sessionIdx + '-v' + vfIdx,
            videoTrack: { video: { width: 640, height: 480 } },
            samples: new Array(100),
            _onProgress: null,
            onProgress: null,
            init: function (file, opts) {
                var self = this;
                events.push({
                    type: 'begin', sessionIdx: sessionIdx, vfIdx: vfIdx, t: Date.now(),
                });
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        events.push({
                            type: 'end', sessionIdx: sessionIdx, vfIdx: vfIdx, t: Date.now(),
                        });
                        resolve();
                    }, delayMs);
                });
            },
            switchSource: function (file, opts) {
                var self = this;
                events.push({
                    type: 'begin', sessionIdx: sessionIdx, vfIdx: vfIdx, t: Date.now(),
                });
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        events.push({
                            type: 'end', sessionIdx: sessionIdx, vfIdx: vfIdx, t: Date.now(),
                        });
                        resolve();
                    }, delayMs);
                });
            },
        };
    }

    describe('SLP project import: sequential session loading', function () {
        it('session N+1 begins only after every video in session N has completed', async function () {
            var importer;
            try { importer = getImporter(); } catch (e) { throw e; }

            // Fake project: 3 sessions, 2 videos each. Stagger delays per
            // session so a sequential implementation has measurably non-overlapping
            // intervals, while a parallel-across-sessions implementation would
            // show overlap.
            var events = [];
            var DELAY_MS = 25;

            // Pre-build decoders the importer can pick up from a pool, OR
            // accept via a factory callback. The accepted shape of the
            // fake-project argument is permissive — we pass everything the
            // implementation might want.
            var sessions = [
                {
                    name: 'session_A',
                    videoFiles: [
                        { file: { name: 's0_cam0.mp4' } },
                        { file: { name: 's0_cam1.mp4' } },
                    ],
                    cameras: [],
                    skeleton: null,
                    frames: [],
                },
                {
                    name: 'session_B',
                    videoFiles: [
                        { file: { name: 's1_cam0.mp4' } },
                        { file: { name: 's1_cam1.mp4' } },
                    ],
                    cameras: [],
                    skeleton: null,
                    frames: [],
                },
                {
                    name: 'session_C',
                    videoFiles: [
                        { file: { name: 's2_cam0.mp4' } },
                        { file: { name: 's2_cam1.mp4' } },
                    ],
                    cameras: [],
                    skeleton: null,
                    frames: [],
                },
            ];

            // Per-(session, vf) decoder factory. The importer is allowed to
            // request decoders via this callback rather than going through
            // OnDemandVideoDecoder's constructor.
            function decoderFor(sessionIdx, vfIdx) {
                return makeRecordingDecoder(sessionIdx, vfIdx, DELAY_MS, events);
            }

            // The importer signature is not yet fixed; this test passes a
            // single fakeProject options bag containing every plausible field.
            await importer({
                sessions: sessions,
                decoderFactory: decoderFor,
                // For implementations that look at state.videoFiles instead
                // of a per-session videoFiles list:
                state: {
                    videoFiles: [].concat.apply([], sessions.map(function (s, si) {
                        return s.videoFiles.map(function (vf, vi) {
                            return { file: vf.file, sessionIdx: si, decoder: null };
                        });
                    })),
                    sessions: sessions,
                    decoderPool: [],
                    activeSessionIdx: 0,
                    currentFrame: 0,
                    triangulationResults: new Map(),
                },
            });

            // Sanity: 6 begin and 6 end events expected (3 sessions x 2 videos).
            var beginEvents = events.filter(function (e) { return e.type === 'begin'; });
            var endEvents = events.filter(function (e) { return e.type === 'end'; });
            assertTrue(
                beginEvents.length === 6 && endEvents.length === 6,
                'Expected 6 begin and 6 end events (3 sessions x 2 videos each); ' +
                'got ' + beginEvents.length + ' begin + ' + endEvents.length + ' end. ' +
                'The importer did not invoke the recording decoders for every ' +
                'session/video — check that decoderFactory is being called.'
            );

            // Sequential ordering: max(end_t for session N) <= min(begin_t for session N+1).
            for (var s = 0; s < 2; s++) {
                var endsThisSession = endEvents
                    .filter(function (e) { return e.sessionIdx === s; })
                    .map(function (e) { return e.t; });
                var beginsNextSession = beginEvents
                    .filter(function (e) { return e.sessionIdx === s + 1; })
                    .map(function (e) { return e.t; });
                assertTrue(
                    endsThisSession.length > 0 && beginsNextSession.length > 0,
                    'Session ' + s + ' has no end events or session ' + (s + 1) +
                    ' has no begin events — ordering check cannot run.'
                );
                var maxEnd = Math.max.apply(null, endsThisSession);
                var minBegin = Math.min.apply(null, beginsNextSession);
                assertTrue(
                    maxEnd <= minBegin,
                    'Session ' + (s + 1) + ' began loading at t=' + minBegin +
                    ' BEFORE session ' + s + ' finished (last end t=' + maxEnd +
                    '). Sessions must load sequentially: every video in ' +
                    'session N must complete before session N+1\'s first ' +
                    'video begins. Events trace: ' + JSON.stringify(events)
                );
            }
        });
    });
})();
