/**
 * test-switchsession-progress-wiring.js — Feature: switchSession must wire a
 * per-decoder onProgress callback through to each pool slot's switchSource
 * (and init() for newly-created slots).
 *
 * Per prompts.md "Per-video loading progress modal" → "Switch-session
 * integration": when switchSession runs the parallel decoder swap, every
 * decoder (one per camera) must emit at least one progress event, and every
 * decoder must complete with at least one { phase: 'mp4box', ratio: 1 } event
 * by the time switchSession resolves. The modal will collect these to
 * populate one row per camera.
 *
 * Strategy mirrors test-switchsession-parallel-decoders.js:
 *   - Brace-walk switchSession from ui/sessions-panes.js.
 *   - Stub all dependencies; run via new Function(...).
 *   - Pre-populate state.decoderPool with stub decoders whose switchSource
 *     resolves a callback ONLY from places switchSession itself can have
 *     written to (opts.onProgress arg, or decoder.onProgress / _onProgress
 *     attached just-in-time during the switch). To prevent the test from
 *     passing for the wrong reason, we explicitly do NOT pre-attach a
 *     decoder.onProgress before switchSession runs — the production code
 *     must do the wiring itself.
 *
 * Pre-fix: switchSession does not pass any callback to switchSource and
 * does not attach one to the decoder, so the stub's switchSource finds
 * `cb === null` and emits no events. All slotEvents arrays stay empty,
 * and assertions fail.
 *
 * Design ambiguity: the prompt is non-committal about whether onProgress
 * is passed per-call (e.g. as a second argument to switchSource) vs
 * attached on the decoder. The decoder-side test
 * (test-decoder-onprogress.js) pins construction-time onProgress; this
 * test accepts either route. See "open questions" at end.
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
        describe('switchSession: per-decoder onProgress wiring', function () {
            it('failed to load sessions-panes.js: ' + e.message, function () { throw e; });
        });
        return;
    }

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

    /**
     * Build a stub decoder whose switchSource resolves a callback from
     * any route the implementation might use:
     *   1. opts.onProgress (per-call argument)
     *   2. decoder.onProgress (attached on the decoder object)
     *   3. decoder._onProgress (attached privately)
     *
     * If no callback is found, the stub emits nothing — making the
     * empty-slotEvents the failure signal that switchSession isn't wiring
     * onProgress.
     *
     * `slotEvents` is the per-slot event log the test inspects.
     */
    function makeStubDecoder(id, slotEvents) {
        var decoder = {
            id: id,
            videoTrack: { video: { width: 640, height: 480 } },
            samples: new Array(100),
            // Intentionally NOT pre-set. Production code must attach this
            // (or pass opts.onProgress) for events to flow.
            // onProgress: undefined,
            // _onProgress: undefined,
            switchSource: function (file, opts) {
                // Resolve callback at call time — read fresh from decoder.
                var cb = null;
                if (opts && typeof opts.onProgress === 'function') {
                    cb = opts.onProgress;
                } else if (typeof decoder.onProgress === 'function') {
                    cb = decoder.onProgress;
                } else if (typeof decoder._onProgress === 'function') {
                    cb = decoder._onProgress;
                }

                return new Promise(function (resolve) {
                    setTimeout(function () {
                        if (cb) {
                            // Mirror the events into the per-slot log AND
                            // fire the production callback (so the modal
                            // gets them too if a future test extends this).
                            var emit = function (ev) {
                                slotEvents.push(ev);
                                cb(ev);
                            };
                            emit({ phase: 'canplay', ratio: 0 });
                            emit({ phase: 'canplay', ratio: 1 });
                            emit({ phase: 'mp4box', ratio: 0.5 });
                            emit({ phase: 'mp4box', ratio: 1 });
                        }
                        resolve();
                    }, 5);
                });
            },
        };
        return decoder;
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

    describe('switchSession: per-decoder onProgress wiring', function () {
        it('passes an onProgress callback into every decoder pool slot; every camera completes with mp4box ratio:1', async function () {
            // Per-slot event logs; the test inspects each independently.
            var slot0Events = [];
            var slot1Events = [];

            var d0 = makeStubDecoder('d0', slot0Events);
            var d1 = makeStubDecoder('d1', slot1Events);

            var sessionA = makeSession('SessionA', []);
            var sessionB = makeSession('SessionB', [0, 1]);

            var videoFiles = [
                { file: { name: 'cam0.mp4' }, sessionIdx: 1, decoder: null },
                { file: { name: 'cam1.mp4' }, sessionIdx: 1, decoder: null },
            ];

            var state = {
                currentFrame: 0,
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

            var timeline = {
                _session: sessionA,
                _zoom: 1,
                _scrollFrame: 0,
                _maxZoom: function () { return 10; },
                setData: function (sess) { this._session = sess; },
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
            await switchSession(1);

            // For every camera in the new session, onProgress must have
            // been invoked at least once. If switchSession doesn't wire
            // onProgress, the stubs find cb === null and slotEvents is [].
            assertTrue(
                slot0Events.length >= 1,
                'Slot 0 (camera "cam0.mp4"): expected at least one onProgress ' +
                'event after switchSession resolves; got 0. switchSession is ' +
                'not passing an onProgress callback into the decoder.'
            );
            assertTrue(
                slot1Events.length >= 1,
                'Slot 1 (camera "cam1.mp4"): expected at least one onProgress ' +
                'event after switchSession resolves; got 0. switchSession is ' +
                'not passing an onProgress callback into the decoder.'
            );

            // Each slot must complete with at least one mp4box ratio:1 event.
            var slot0Done = slot0Events.filter(function (e) {
                return e && e.phase === 'mp4box' && e.ratio === 1;
            });
            var slot1Done = slot1Events.filter(function (e) {
                return e && e.phase === 'mp4box' && e.ratio === 1;
            });
            assertTrue(
                slot0Done.length >= 1,
                'Slot 0: expected at least one { phase: "mp4box", ratio: 1 } ' +
                'completion event by the time switchSession resolves. Got: ' +
                JSON.stringify(slot0Events)
            );
            assertTrue(
                slot1Done.length >= 1,
                'Slot 1: expected at least one { phase: "mp4box", ratio: 1 } ' +
                'completion event by the time switchSession resolves. Got: ' +
                JSON.stringify(slot1Events)
            );

            // Distinguishability: each slot's callback must fire
            // independently. Confirm by asserting both slots' arrays each
            // contain exactly one ratio:1 (their own decoder's completion);
            // a single-shared-callback design that lacks per-slot routing
            // would land both events in one log.
            assertEqual(
                slot0Done.length, 1,
                'Slot 0 should receive exactly one mp4box ratio:1 event ' +
                '(its own decoder\'s completion). Multiple/zero suggests ' +
                'callbacks are not slot-distinguished.'
            );
            assertEqual(
                slot1Done.length, 1,
                'Slot 1 should receive exactly one mp4box ratio:1 event ' +
                '(its own decoder\'s completion). Multiple/zero suggests ' +
                'callbacks are not slot-distinguished.'
            );
        });
    });
})();
