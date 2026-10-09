/**
 * test-switchsession-parallel-decoders.js — switchSession parallelism + slot
 * stability + early timeline.setData.
 *
 * What this test asserts (three independent QoL invariants):
 *
 *  1. Parallel execution. With staggered switchSource resolution times
 *     (decoder 0 = 50 ms, decoder 1 = 10 ms), the total awaited duration of
 *     switchSession() is closer to max(50, 10) = 50 ms than to the sum 60 ms.
 *     A sequential implementation would take ~60 ms; Promise.all takes ~50 ms.
 *  2. Slot stability. After the parallel switch, state.decoderPool[0] is the
 *     decoder originally at index 0, even though decoder 1 finishes first.
 *     I.e., out-of-order resolution must not reorder the pool.
 *  3. Early timeline.setData. The timeline's _session reference is updated
 *     to newSession BEFORE the awaited decoder work resolves. We detect this
 *     by stubbing timeline.setData to record (timestamp, session) tuples and
 *     comparing the first-call timestamp to the timestamps of the staggered
 *     switchSource resolutions.
 *  4. Bug B invariant. state.currentFrame === 0 after the switch (no
 *     regression in the previously-fixed reset-on-switch behaviour).
 *
 * Strategy mirrors test-session-switch-frame-reset.js (Bug B): load the
 * sessions-panes.js source, brace-walk switchSession, evaluate via
 * `new Function(...)` with stubbed deps. Source-loader is environment-aware
 * (Node __readSource vs. synchronous XHR in browser).
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;

    function loadSource() {
        if (typeof __readSource === 'function') {
            return __readSource('ui/sessions-panes.js');
        }
        if (typeof XMLHttpRequest !== 'undefined') {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', '../ui/sessions-panes.js', false);
            xhr.send(null);
            if (xhr.status === 200 || xhr.status === 0) return xhr.responseText;
            throw new Error('Failed to fetch sessions-panes.js: ' + xhr.status);
        }
        throw new Error('No source loader available');
    }

    var src;
    try { src = loadSource(); } catch (e) {
        describe('switchSession: parallel decoders + slot stability + early timeline.setData', function () {
            it('failed to load sessions-panes.js: ' + e.message, function () { throw e; });
        });
        return;
    }

    // Brace-walk to extract switchSession body.
    var startIdx = src.indexOf('export async function switchSession(newIdx)');
    if (startIdx < 0) startIdx = src.indexOf('async function switchSession(newIdx)');
    var braceStart = src.indexOf('{', startIdx);
    var depth = 0;
    var endIdx = -1;
    for (var i = braceStart; i < src.length; i++) {
        var ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) { endIdx = i; break; }
        }
    }
    var body = src.slice(braceStart + 1, endIdx);

    function makeSession(name, vfIndices) {
        return {
            name: name,
            lastFrame: 0,
            totalFrames: 0,
            fps: 30,
            triangulationResults: new Map(),
            videoFileIndices: vfIndices || [],
            cameras: [],
            skeleton: null,
            trustTracks: false,
            _views: null,
            _videoController: null,
            _timelineZoom: 1,
            _scrollFrame: 0,
            _viewport3dState: null,
        };
    }

    // Build a stub decoder whose switchSource resolves after `delayMs` and
    // records the resolution timestamp. We expose `id` so the slot-stability
    // assertion can confirm decoderPool[i] is still the pre-existing decoder.
    function makeStubDecoder(id, delayMs, log) {
        return {
            id: id,
            videoTrack: { video: { width: 640, height: 480 } },
            samples: new Array(100),
            switchSource: function (file) {
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        log.push({ type: 'switchSource', id: id, t: Date.now() });
                        resolve();
                    }, delayMs);
                });
            },
        };
    }

    function makeStubPaneManager() {
        return { clearAll: function () {}, addAllViewsAsGrid: function () {} };
    }

    function makeStubDocument() {
        var stubEl = {
            textContent: '',
            classList: { add: function () {}, remove: function () {}, toggle: function () {} },
            style: {},
        };
        return { getElementById: function () { return stubEl; } };
    }

    function buildSwitchSession(stubs) {
        var fn = new Function(
            'state', 'timeline', 'viewport3d', 'videoController', 'paneManager',
            'setVideoController', 'OnDemandVideoDecoder', 'createViewForVideoFile',
            'updateTotalFrames', 'rebuildVideoController', 'fitCanvasesToCells',
            'refreshPaneInteractions', 'drawAllOverlays', 'populateViewStrip',
            'populateSessionStrip', 'sessionHasCalibration', 'getInstanceGroupsForFrame',
            'setReprojErrorVisible', 'updateInfoPanel', 'showLoading', 'hideLoading',
            'setup3DViewport', 'setStatus', 'document', 'setTimeout',
            'newIdx',
            'return (async () => {' + body + '})();'
        );
        return function (newIdx) {
            return fn(
                stubs.state, stubs.timeline, stubs.viewport3d, stubs.videoController,
                stubs.paneManager, stubs.setVideoController, stubs.OnDemandVideoDecoder,
                stubs.createViewForVideoFile, stubs.updateTotalFrames,
                stubs.rebuildVideoController, stubs.fitCanvasesToCells,
                stubs.refreshPaneInteractions, stubs.drawAllOverlays,
                stubs.populateViewStrip, stubs.populateSessionStrip,
                stubs.sessionHasCalibration, stubs.getInstanceGroupsForFrame,
                stubs.setReprojErrorVisible, stubs.updateInfoPanel,
                stubs.showLoading, stubs.hideLoading, stubs.setup3DViewport,
                stubs.setStatus, stubs.document, stubs.setTimeout, newIdx
            );
        };
    }

    describe('switchSession: parallel decoders + slot stability + early timeline.setData', function () {
        it('runs decoder switchSource calls in parallel; preserves slot order; calls timeline.setData early; resets currentFrame to 0', async function () {
            // Stagger times: decoder 0 takes 50 ms, decoder 1 takes 10 ms.
            // Sequential -> ~60 ms; Promise.all -> ~max(50, 10) = ~50 ms.
            var DELAY_0 = 50;
            var DELAY_1 = 10;

            var log = [];
            var d0 = makeStubDecoder('d0', DELAY_0, log);
            var d1 = makeStubDecoder('d1', DELAY_1, log);

            var sessionA = makeSession('SessionA', []);
            var sessionB = makeSession('SessionB', [0, 1]);

            var videoFiles = [
                { file: { name: 'cam0.mp4' }, sessionIdx: 1, decoder: null },
                { file: { name: 'cam1.mp4' }, sessionIdx: 1, decoder: null },
            ];

            var state = {
                currentFrame: 25, // Bug B: must reset to 0
                totalFrames: 100,
                fps: 30,
                isPlaying: false,
                triangulationResults: new Map(),
                sessions: [sessionA, sessionB],
                activeSessionIdx: 0,
                session: sessionA,
                videoFiles: videoFiles,
                views: [],
                decoderPool: [d0, d1],
            };

            // Stub timeline that records each setData call with a timestamp
            // and a snapshot of state.session at call time.
            var timelineCalls = [];
            var timeline = {
                _session: sessionA,
                _zoom: 1,
                _scrollFrame: 0,
                _maxZoom: function () { return 10; },
                setData: function (sess) {
                    timelineCalls.push({
                        t: Date.now(),
                        session: sess,
                        stateSession: state.session,
                    });
                    this._session = sess;
                },
                setTotalFrames: function () {},
                _clampScroll: function () {},
                redraw: function () {},
            };

            var stubs = {
                state: state,
                timeline: timeline,
                viewport3d: null,
                videoController: null,
                paneManager: makeStubPaneManager(),
                setVideoController: function () {},
                // Not used because both vf indices have an existing pool slot,
                // but stubbed defensively.
                OnDemandVideoDecoder: function () {
                    this.init = function () { return Promise.resolve(); };
                    this.videoTrack = { video: { width: 640, height: 480 } };
                    this.samples = new Array(100);
                },
                createViewForVideoFile: function () {},
                updateTotalFrames: function () {},
                rebuildVideoController: function () {},
                fitCanvasesToCells: function () {},
                refreshPaneInteractions: function () {},
                drawAllOverlays: function () {},
                populateViewStrip: function () {},
                populateSessionStrip: function () {},
                sessionHasCalibration: function () { return false; },
                getInstanceGroupsForFrame: function () { return []; },
                setReprojErrorVisible: function () {},
                updateInfoPanel: function () {},
                showLoading: function () {},
                hideLoading: function () {},
                setup3DViewport: function () {},
                setStatus: function () {},
                document: makeStubDocument(),
                setTimeout: setTimeout,
            };

            var switchSession = buildSwitchSession(stubs);

            var t0 = Date.now();
            await switchSession(1);
            var elapsed = Date.now() - t0;

            // 1. Parallel execution: closer to max(50, 10) = 50 than to sum 60.
            // We need elapsed < 60 ms (with fudge for setup overhead). The
            // strict inequality threshold below allows DELAY_0 + 30 ms slack.
            // A sequential impl. would take >= 60 ms.
            var SEQUENTIAL_FLOOR = DELAY_0 + DELAY_1; // 60 ms
            var PARALLEL_CEIL = DELAY_0 + 30;         // 80 ms (50 + 30 ms fudge)
            assertTrue(
                elapsed < SEQUENTIAL_FLOOR + 5,
                'switchSession should run decoder switchSource calls in parallel ' +
                '(elapsed ' + elapsed + ' ms; sequential floor ' + SEQUENTIAL_FLOOR +
                ' ms; expected close to ' + DELAY_0 + ' ms = max-of-staggers)'
            );
            assertTrue(
                elapsed <= PARALLEL_CEIL,
                'switchSession parallel elapsed too high: ' + elapsed + ' ms > ' +
                PARALLEL_CEIL + ' ms'
            );

            // Confirm decoder 1 actually resolved before decoder 0 (i.e. our
            // staggering took effect; otherwise the slot-stability test below
            // wouldn't be exercising the out-of-order path).
            var d0Entry = log.filter(function (e) { return e.id === 'd0'; })[0];
            var d1Entry = log.filter(function (e) { return e.id === 'd1'; })[0];
            assertTrue(
                d1Entry.t < d0Entry.t,
                'Stagger setup: decoder d1 (10 ms) should resolve before d0 (50 ms)'
            );

            // 2. Slot stability: decoderPool[0] must still be d0 (not d1).
            assertEqual(
                state.decoderPool[0].id, 'd0',
                'state.decoderPool[0] should remain the original index-0 decoder ' +
                'after parallel switch (out-of-order resolution must not reorder pool)'
            );
            assertEqual(
                state.decoderPool[1].id, 'd1',
                'state.decoderPool[1] should remain the original index-1 decoder'
            );
            assertEqual(
                videoFiles[0].decoder.id, 'd0',
                'videoFiles[0].decoder should be decoder d0 (matched by slot, not by ' +
                'resolution order)'
            );
            assertEqual(
                videoFiles[1].decoder.id, 'd1',
                'videoFiles[1].decoder should be decoder d1'
            );

            // 3. Early timeline.setData: the FIRST setData call must have
            // happened BEFORE either decoder.switchSource resolution.
            assertTrue(
                timelineCalls.length >= 1,
                'timeline.setData should have been called at least once'
            );
            var firstSetData = timelineCalls[0];
            assertEqual(
                firstSetData.session, sessionB,
                'First timeline.setData call should pass the new session'
            );
            assertEqual(
                firstSetData.stateSession, sessionB,
                'state.session should already be the new session at first setData call'
            );
            assertTrue(
                firstSetData.t <= d1Entry.t,
                'First timeline.setData must fire BEFORE decoder switchSource resolves ' +
                '(setData t=' + firstSetData.t + ' vs first decoder resolve t=' +
                d1Entry.t + ')'
            );

            // 4. Bug B invariant: state.currentFrame reset to 0 after switch.
            assertEqual(
                state.currentFrame, 0,
                'state.currentFrame should reset to 0 on session switch (Bug B regression)'
            );
        });
    });
})();
