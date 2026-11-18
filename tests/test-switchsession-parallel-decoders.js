/**
 * test-switchsession-parallel-decoders.js — switchSession parallelism + slot
 * stability + early timeline.setData.
 *
 * What this test asserts (three independent QoL invariants):
 *
 *  1. Parallel execution, proven by ORDER, not by wall-clock time. Each stub
 *     decoder logs a 'start' event when switchSource is called and a
 *     'resolve' event when its promise settles (decoder 0 after 50 ms,
 *     decoder 1 after 10 ms). Decoder 1's switchSource must START before
 *     decoder 0's RESOLVES; a sequential implementation (await each in turn)
 *     cannot do that. (An earlier version timed the call against a 60 ms
 *     sequential floor with a 5 ms margin and flaked on loaded CI runners.)
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
 * `new Function(...)` with stubbed deps. The source is read with synchronous
 * XHR.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;

    function loadSource() {
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

    // Build a stub decoder whose switchSource logs a 'start' event when it is
    // called and a 'resolve' event (with timestamp) when it resolves after
    // `delayMs`. The log's ORDER is what proves parallelism. We expose `id`
    // so the slot-stability assertion can confirm decoderPool[i] is still the
    // pre-existing decoder.
    function makeStubDecoder(id, delayMs, log) {
        return {
            id: id,
            videoTrack: { video: { width: 640, height: 480 } },
            samples: new Array(100),
            switchSource: function (file) {
                log.push({ type: 'start', id: id, t: Date.now() });
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        log.push({ type: 'resolve', id: id, t: Date.now() });
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
            // Parallel: d0 start, d1 start, d1 resolve, d0 resolve.
            // Sequential: d0 start, d0 resolve, d1 start, d1 resolve.
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

            function logIndex(type, id) {
                for (var k = 0; k < log.length; k++) {
                    if (log[k].type === type && log[k].id === id) return k;
                }
                return -1;
            }
            var d0Start = logIndex('start', 'd0');
            var d1Start = logIndex('start', 'd1');
            var d0Resolve = logIndex('resolve', 'd0');
            var d1Resolve = logIndex('resolve', 'd1');
            var order = log.map(function (e) { return e.id + ':' + e.type; }).join(', ');
            assertTrue(
                d0Start >= 0 && d1Start >= 0 && d0Resolve >= 0 && d1Resolve >= 0,
                'both decoders should have been switched and resolved (log: ' + order + ')'
            );

            // 1. Parallel execution: decoder 1's switchSource started before
            // decoder 0's resolved. A sequential implementation awaits d0
            // first, so d1 could only start after d0 resolved.
            assertTrue(
                d1Start < d0Resolve,
                'switchSession should run decoder switchSource calls in parallel: ' +
                'd1 must start before d0 resolves (log: ' + order + ')'
            );

            // Hang guard only (not a parallelism check): the stubs take 50 ms.
            assertTrue(
                elapsed < 500,
                'switchSession took ' + elapsed + ' ms with 50 ms stub decoders'
            );

            // Confirm decoder 1 actually resolved before decoder 0 (i.e. our
            // staggering took effect; otherwise the slot-stability test below
            // wouldn't be exercising the out-of-order path).
            var d0Entry = log[d0Resolve];
            var d1Entry = log[d1Resolve];
            assertTrue(
                d1Resolve < d0Resolve,
                'Stagger setup: decoder d1 (10 ms) should resolve before d0 (50 ms) ' +
                '(log: ' + order + ')'
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
