/**
 * test-decoder-pool-repeated-swap.js — Stress test: repeated decoder-pool
 * swaps must leave the pool in a clean, deterministic state, regardless of
 * how many swaps preceded the final one.
 *
 * Catches stability-review Issue #3 preemptively: when switchSession (or
 * the upcoming SLP-project-import flow) runs back-to-back without yielding
 * to the event loop, the decoder pool can accumulate stale callbacks,
 * out-of-date sample arrays, and slots from earlier sessions.
 *
 * Strategy (mirrors test-switchsession-parallel-decoders.js):
 *   - Brace-walk switchSession out of ui/sessions-panes.js.
 *   - Mock OnDemandVideoDecoder construction + decoder.init / switchSource
 *     to record their call order and resulting per-slot state.
 *   - Run the swap N=5 times back-to-back. The session schedule mixes
 *     2 / 4 / 2 / 3 / 4 cameras to catch pool-resize bugs.
 *   - After N swaps, assert:
 *       1. state.decoderPool length matches the LARGEST session in the
 *          schedule (4 cameras here) — pool never shrinks below this.
 *          Pool entries beyond the active session may be null.
 *       2. Slots 0..(activeCount-1) reflect the FINAL session only
 *          (decoder.id contains the final session's marker).
 *       3. No stale `_onProgress` callbacks from earlier sessions remain.
 *          For every active slot, _onProgress (if set) is the one wired
 *          during the LAST swap, not an earlier one.
 *       4. The internal state per slot reflects the last session: each
 *          active decoder has the new file's `fileSize` / `mp4boxFile`
 *          / `currentFrame` markers.
 *
 * Pre-fix: the repeated swap leaks stale state across iterations because
 * switchSession is not idempotent under fast successive calls. Either
 *   - state.decoderPool.length grows monotonically and the pool retains
 *     dead slots from the 4-cam sessions when the final session has 3 cams,
 *   - or _onProgress on slot N still points at an earlier session's modal
 *     task callback.
 * Both surface as one or more of the assertions below failing.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertTrue = TF.assertTrue;
    var assertEqual = TF.assertEqual;

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
        describe('decoder pool: repeated swap stability', function () {
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
     * Mock decoder used both as a pool-resident (state.decoderPool[i]) and
     * as a freshly-constructed-via-OnDemandVideoDecoder decoder. Records
     * its full mutation history into `mutationLog`.
     */
    function makeMockDecoder(label, mutationLog) {
        var dec = {
            id: label,
            videoTrack: { video: { width: 640, height: 480 } },
            samples: new Array(100),
            currentFrame: -1,
            fileSize: 0,
            mp4boxFile: null,
            _onProgress: null,
            onProgress: null,
            init: function (file) {
                this.fileSize = (file && file.size) || 1;
                this.mp4boxFile = { source: (file && file.name) || 'unknown' };
                this.currentFrame = 0;
                mutationLog.push({ kind: 'init', id: this.id, file: file && file.name });
                return Promise.resolve();
            },
            switchSource: function (file) {
                this.fileSize = (file && file.size) || 1;
                this.mp4boxFile = { source: (file && file.name) || 'unknown' };
                this.currentFrame = 0;
                mutationLog.push({ kind: 'switchSource', id: this.id, file: file && file.name });
                return Promise.resolve();
            },
        };
        return dec;
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

    describe('decoder pool: repeated swap stability', function () {
        it('N=6 back-to-back swaps leave the pool in the final session\'s state with no stale callbacks', async function () {
            var mutationLog = [];

            // Schedule of camera counts per swap: 2, 4, 2, 3, 4, 3.
            // - 2 -> 4 grows the pool to 4.
            // - 4 -> 2 leaves 2 stale pool slots (idx 2, 3).
            // - 2 -> 3 reuses slot 2 (fresh) but slot 3 stays stale.
            // - 3 -> 4 refreshes slot 3.
            // - 4 -> 3 leaves slot 3 stale again — and this is the END state
            //   the test inspects. The final swap is the 3-cam session; slot
            //   3 must be cleaned up (decoder closed or _onProgress nulled
            //   and mp4boxFile cleared) so it doesn't leak the previous
            //   session's callback/state.
            var camCounts = [2, 4, 2, 3, 4, 3];

            // Build sessions[0..N] with matching videoFileIndices ranges.
            // We allocate one videoFile per (sessionIdx, vfSlot) so each
            // session has its own files, never shared across sessions.
            var videoFiles = [];
            var sessions = [makeSession('S_init', [])]; // session 0: empty starting point
            for (var s = 0; s < camCounts.length; s++) {
                var n = camCounts[s];
                var vfIndices = [];
                for (var c = 0; c < n; c++) {
                    var vfIdx = videoFiles.length;
                    videoFiles.push({
                        file: { name: 's' + s + '_cam' + c + '.mp4', size: 1024 },
                        sessionIdx: s + 1,
                        decoder: null,
                    });
                    vfIndices.push(vfIdx);
                }
                sessions.push(makeSession('S_' + s, vfIndices));
            }

            // Start with an EMPTY pool. Each swap may grow it. The repeated-
            // swap end-state must match the reference "single-swap to the
            // final session from empty pool" end-state — otherwise pool slot
            // residue from earlier sessions is leaking through.
            var maxCams = Math.max.apply(null, camCounts);
            var decoderPool = [];

            var state = {
                currentFrame: 0,
                totalFrames: 100,
                fps: 30,
                isPlaying: false,
                triangulationResults: new Map(),
                sessions: sessions,
                activeSessionIdx: 0,
                session: sessions[0],
                videoFiles: videoFiles,
                views: [],
                decoderPool: decoderPool,
            };

            var timeline = {
                _session: sessions[0],
                _zoom: 1,
                _scrollFrame: 0,
                _maxZoom: function () { return 10; },
                setData: function (sess) { this._session = sess; },
                setTotalFrames: function () {},
                _clampScroll: function () {},
                redraw: function () {},
            };

            // OnDemandVideoDecoder constructor stub. Used only when an
            // existing pool slot is null AND switchSession constructs a new
            // decoder. With our 4-slot pre-seed and maxCams=4, every swap
            // should hit existing slots and NEVER call this constructor.
            // We still log every construction so we can flag unexpected
            // resizing.
            var constructedCount = 0;
            function OnDemandVideoDecoderStub(opts) {
                constructedCount++;
                var label = 'new-' + constructedCount;
                var dec = makeMockDecoder(label, mutationLog);
                // Echo the onProgress option onto the decoder (per the
                // current production wiring).
                if (opts && typeof opts.onProgress === 'function') {
                    dec._onProgress = opts.onProgress;
                    dec.onProgress = opts.onProgress;
                }
                this.id = label;
                this.videoTrack = dec.videoTrack;
                this.samples = dec.samples;
                // Bind to `this` (the wrapper) — not `dec` — so init() /
                // switchSource() mutate the wrapper's mp4boxFile /
                // currentFrame / fileSize directly. Otherwise the wrapper's
                // observable state (which the assertions below inspect)
                // never reflects the bound dec's mutations.
                this.init = dec.init;
                this.switchSource = dec.switchSource;
                this.currentFrame = dec.currentFrame;
                this.fileSize = dec.fileSize;
                this.mp4boxFile = dec.mp4boxFile;
            }

            var stubs = {
                state: state,
                timeline: timeline,
                viewport3d: null,
                videoController: null,
                paneManager: makeStubPaneManager(),
                setVideoController: function () {},
                OnDemandVideoDecoder: OnDemandVideoDecoderStub,
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

            // Run all swaps WITHOUT awaiting `await new Promise(r =>
            // setImmediate(r))` between them — just one switch's promise,
            // immediately followed by the next.
            for (var swap = 1; swap <= camCounts.length; swap++) {
                await switchSession(swap);
            }

            // After 6 swaps, the final session is sessions[6] which has
            // camCounts[5] = 3 cameras. Slot 3 (from earlier 4-cam swaps)
            // should be cleaned up — either removed from the pool or zeroed
            // out (mp4boxFile null, _onProgress null).
            var finalSession = sessions[camCounts.length]; // sessions[6]
            var finalCount = camCounts[camCounts.length - 1]; // 3

            // 1. Pool active region equals the final session's camera count.
            //    Pool length must equal finalCount exactly (the post-swap
            //    cleanup must trim or zero stale slots). This catches the
            //    bug where the pool grows monotonically and leaks slots.
            assertEqual(
                state.decoderPool.length, finalCount,
                'state.decoderPool.length (' + state.decoderPool.length +
                ') should equal the final session\'s camera count (' +
                finalCount + ') after the repeated swap sequence. The pool ' +
                'is leaking slots from earlier larger sessions across ' +
                'repeated swaps (stability-review Issue #3). Either trim ' +
                'the pool to finalCount or close-and-null the leftover slots.'
            );

            // 2. Final-session slot decoders reflect the FINAL session.
            //    Each active decoder's most-recent switchSource/init must
            //    have been with one of the final session's video files.
            //    We verify by looking at decoder.mp4boxFile.source which
            //    the mock sets each time.
            var finalNames = finalSession.videoFileIndices.map(function (vfIdx) {
                return videoFiles[vfIdx].file.name;
            });
            for (var k = 0; k < finalCount; k++) {
                var poolDec = state.decoderPool[k];
                assertTrue(
                    poolDec != null,
                    'state.decoderPool[' + k + '] should be a live decoder ' +
                    'after the final swap; got null.'
                );
                var src2 = poolDec.mp4boxFile && poolDec.mp4boxFile.source;
                assertTrue(
                    finalNames.indexOf(src2) >= 0,
                    'state.decoderPool[' + k + '] should reflect a video from ' +
                    'the FINAL session (one of ' + JSON.stringify(finalNames) +
                    '); got mp4boxFile.source = ' + JSON.stringify(src2) +
                    '. Stale state from an earlier session leaked through.'
                );
                // currentFrame must have been reset by the final init/switchSource.
                assertEqual(
                    poolDec.currentFrame, 0,
                    'state.decoderPool[' + k + '].currentFrame should reset ' +
                    'to 0 on the final swap; got ' + poolDec.currentFrame + '.'
                );
            }

            // 3. No stale _onProgress callbacks. For every active slot,
            //    its _onProgress (if set) must reference the latest swap's
            //    closure. We track this via the `swapId` captured on each
            //    callback — but since the production code's callback is a
            //    closure over `taskId`, we approximate by asserting the
            //    callback ISN'T one of the earlier swaps' captured refs.
            //
            //    To make this checkable, we'd need the production code to
            //    tag its callbacks. The pragmatic check available without
            //    tagging: assert that EVERY slot's _onProgress was assigned
            //    in the FINAL swap's mutation window. The mock decoders'
            //    init/switchSource log each call; the LAST entry for a
            //    given decoder.id should be from the final swap iteration.
            for (var k2 = 0; k2 < finalCount; k2++) {
                var dec = state.decoderPool[k2];
                var lastEntry = null;
                for (var mi = mutationLog.length - 1; mi >= 0; mi--) {
                    if (mutationLog[mi].id === dec.id) {
                        lastEntry = mutationLog[mi];
                        break;
                    }
                }
                assertTrue(
                    lastEntry != null,
                    'decoder ' + dec.id + ' at slot ' + k2 + ' has no init/' +
                    'switchSource entry in the mutation log — the final swap ' +
                    'did not touch this slot.'
                );
                assertTrue(
                    finalNames.indexOf(lastEntry.file) >= 0,
                    'Last mutation on slot ' + k2 + ' (decoder ' + dec.id +
                    ') was for file ' + JSON.stringify(lastEntry.file) + ', ' +
                    'which is not in the final session\'s files ' +
                    JSON.stringify(finalNames) + '. Stale callback / state ' +
                    'left over from an earlier swap.'
                );
            }

            // 4. New decoder construction must be bounded by maxCams.
            //    First-pass growth fills empty slots; once the pool reaches
            //    maxCams=4, subsequent swaps must reuse via switchSource
            //    rather than reconstructing. If constructedCount exceeds
            //    maxCams, the pool isn't being reused across swaps.
            assertTrue(
                constructedCount <= maxCams,
                'OnDemandVideoDecoder constructor was called ' +
                constructedCount + ' times across ' + camCounts.length +
                ' swaps; expected <= ' + maxCams + '. The pool is ' +
                'reconstructing decoders on every swap instead of reusing ' +
                'slots via switchSource.'
            );

            // 5. Internal mp4boxFile state per active slot must be a real
            //    object (not null) reflecting the final init/switchSource.
            for (var k3 = 0; k3 < finalCount; k3++) {
                var d = state.decoderPool[k3];
                assertTrue(
                    d.mp4boxFile != null,
                    'state.decoderPool[' + k3 + '].mp4boxFile should be set ' +
                    'after the final swap; got null. The final init/switchSource ' +
                    'did not run on this slot, OR the slot was wiped after.'
                );
                assertTrue(
                    d.fileSize > 0,
                    'state.decoderPool[' + k3 + '].fileSize should be > 0 ' +
                    'after the final swap; got ' + d.fileSize + '.'
                );
            }
        });
    });
})();
