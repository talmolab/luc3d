/**
 * test-session-switch-frame-reset.js — Bug B: frame index not resetting on
 * session switch.
 *
 * Bug spec.
 *   When the user switches from session A (currently on frame n) to session B,
 *   session B should open at frame 0 (user-facing "frame 1"). Actual behaviour:
 *   session B opens at frame n. Cause is a global `state.currentFrame` that
 *   isn't reset synchronously when the session-switch handler fires — its
 *   reset is deferred inside `setTimeout(..., 50)` in
 *   `ui/sessions-panes.js#switchSession`.
 *
 * Strategy.
 *   Load the real `switchSession` body from `ui/sessions-panes.js`, extract
 *   the function via brace-walking, then evaluate it inside a closure with
 *   all external dependencies stubbed. Observe `state.currentFrame`
 *   immediately after `await switchSession(newIdx)` resolves.
 *
 *   Source loading is environment-aware:
 *     - Node (via `tests/run-node.js`): uses the sandbox-injected
 *       `__readSource` helper.
 *     - Browser (via `tests/test-runner.html`): uses synchronous XHR (the
 *       only synchronous fetch primitive) so describe/it can register tests
 *       before TestFramework.runAll() is called.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;

    function loadSource() {
        if (typeof __readSource === 'function') {
            // Node path — see tests/run-node.js
            return __readSource('ui/sessions-panes.js');
        }
        if (typeof XMLHttpRequest !== 'undefined') {
            // Browser path — synchronous XHR so we can extract the function
            // body before TestFramework.runAll() is invoked.
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
        describe('Bug B: session switch frame reset', function () {
            it('failed to load sessions-panes.js: ' + e.message, function () {
                throw e;
            });
        });
        return;
    }

    // Extract `export async function switchSession(newIdx) { ... }` body
    // by walking braces from the function's opening `{`.
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

    function makeSession(name, lastFrame) {
        return {
            name: name,
            lastFrame: lastFrame,                  // undefined for fresh session
            totalFrames: 0,
            fps: 30,
            triangulationResults: new Map(),
            videoFileIndices: [],
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

    function makeStubState(sessionA, sessionB) {
        return {
            currentFrame: 0,
            totalFrames: 100,
            fps: 30,
            isPlaying: false,
            triangulationResults: new Map(),
            sessions: [sessionA, sessionB],
            activeSessionIdx: 0,
            session: sessionA,
            videoFiles: [],
            views: [],
            decoderPool: [],
        };
    }

    function makeStubPaneManager() {
        return {
            clearAll: function () {},
            addAllViewsAsGrid: function () {},
        };
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

    describe('Bug B: session switch frame reset', function () {
        it('switching to a fresh second session resets state.currentFrame to 0', async function () {
            // Two sessions: both fresh (no prior `lastFrame` saved).
            var sessionA = makeSession('SessionA', undefined);
            var sessionB = makeSession('SessionB', undefined);

            var state = makeStubState(sessionA, sessionB);
            // User is on frame 25 of sessionA.
            state.currentFrame = 25;

            var stubs = {
                state: state,
                timeline: null,
                viewport3d: null,
                videoController: null,
                paneManager: makeStubPaneManager(),
                setVideoController: function () {},
                OnDemandVideoDecoder: function () {},
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
                // Real setTimeout — the bug is precisely that the production
                // code defers the frame reset inside one of these.
                setTimeout: setTimeout,
            };

            var switchSession = buildSwitchSession(stubs);

            // Switch from sessionA (frame 25) to sessionB (fresh).
            await switchSession(1);

            // Spec: state.currentFrame should be 0 after switching.
            // Production code defers the reset inside setTimeout(..., 50);
            // immediately after `await switchSession` returns it is still 25,
            // i.e. the leak from sessionA. That is Bug B.
            assertEqual(
                state.currentFrame, 0,
                'After switching to fresh session, state.currentFrame should be 0 ' +
                '(current value is the leaked frame from previous session — Bug B)'
            );
        });
    });
})();
