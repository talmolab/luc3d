/**
 * test-timeline-bugs.js - Regression tests for timeline bugs
 *
 * Bug Point 2 (SLP import — Prompt 95):
 *   Imported ungrouped user instances are NOT displayed in the timeline.
 *   Root cause: timeline.js _buildTrackSegments short-circuits user-instance
 *   scanning for any (trackIdx, cameraName) pair already handled by track
 *   occupancy data from the lazy H5 loader (.analysis.h5). Since user and
 *   predicted instances commonly share the same track indices (e.g. track_0),
 *   user frames are silently dropped.
 *
 * Bug Point 3 (Timeline real-time update — Prompt 66):
 *   Creating a user instance does not refresh the timeline. Grouping or
 *   running Track Frame does. Root cause: index.html's onUserInstanceCreated
 *   callback only records last-used points and never calls
 *   timeline.refreshTracks. Compounded by Point 2 since newly-added user
 *   instances always use trackIdx=0 (overlapping predicted track_0).
 *
 * These tests currently FAIL. After the Point 2 fix to timeline.js and the
 * Point 3 fix to index.html's callback wiring, they should PASS.
 */

(function () {
    const { describe, it, beforeEach, assert, assertEqual, assertTrue, assertFalse,
        assertNotNull, assertNull } = TestFramework;

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    function createContainer(width, height) {
        var div = document.createElement('div');
        div.style.width = (width || 800) + 'px';
        div.style.height = (height || 80) + 'px';
        div.style.position = 'fixed';
        div.style.top = '-9999px';
        div.style.left = '0';
        document.body.appendChild(div);
        return div;
    }

    function cleanup(timeline, container) {
        if (timeline) timeline.destroy();
        if (container && container.parentNode) container.remove();
    }

    function makeSession(cameraNames) {
        var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
        var cameras = cameraNames.map(function (name) {
            return new Camera(name,
                [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        });
        return new Session(cameras, skeleton, ['track_0']);
    }

    // Build an occupancy record as produced by the lazy H5 loader
    // (slp-import-worker.js via lazy mode, attached to session.trackOccupancy).
    function makeOccupancy(nFrames, nTracks, activeFramesPerTrack) {
        var data = new Uint8Array(nFrames * nTracks);
        for (var tr = 0; tr < nTracks; tr++) {
            var frames = activeFramesPerTrack[tr] || [];
            for (var i = 0; i < frames.length; i++) {
                data[frames[i] * nTracks + tr] = 1;
            }
        }
        return { data: data, nTracks: nTracks, nFrames: nFrames };
    }

    function getSegmentFrames(tl, camName, trackIdx) {
        var frames = new Set();
        for (var i = 0; i < tl._trackSegments.length; i++) {
            var seg = tl._trackSegments[i];
            if (seg.cameraName === camName && seg.trackIdx === trackIdx) {
                for (var s = 0; s < seg.segments.length; s++) {
                    for (var f = seg.segments[s].start; f <= seg.segments[s].end; f++) {
                        frames.add(f);
                    }
                }
            }
        }
        return frames;
    }

    function framesToString(frames) {
        return '[' + Array.from(frames).sort(function (a, b) { return a - b; }).join(',') + ']';
    }

    // ---------------------------------------------------------------
    // Point 2: imported user instances on tracks with predicted occupancy
    // ---------------------------------------------------------------

    describe('Timeline - Point 2: user instances hidden by predicted occupancy', function () {
        var container, tl;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 100 });
        });

        it('includes unlinked user instance frames on a track that also has predicted occupancy', function () {
            var session = makeSession(['cam1']);

            // Simulate imported predictions from .analysis.h5 — predictions for
            // cam1:track_0 at frames 5-9.
            session.trackOccupancy = new Map();
            session.trackOccupancy.set('cam1', makeOccupancy(100, 1, [[5, 6, 7, 8, 9]]));

            // Simulate imported user SLP — an unlinked user instance at frame 20
            // on cam1:track_0 (trackIdx=0, same as the predicted track).
            var userInst = new Instance([[100, 100], [200, 200]], 0, 'user', 1);
            session.addUnlinkedInstance(20, 'cam1', userInst);

            tl.setData(session);

            var frames = getSegmentFrames(tl, 'cam1', 0);
            assertTrue(frames.has(20),
                'User instance at frame 20 must appear in timeline segments for cam1:track_0. Actual frames: ' +
                framesToString(frames));

            cleanup(tl, container);
            tl = null;
        });

        it('includes linked user instance frames on a track that also has predicted occupancy', function () {
            var session = makeSession(['cam1']);

            session.trackOccupancy = new Map();
            session.trackOccupancy.set('cam1', makeOccupancy(100, 1, [[5, 6, 7, 8, 9]]));

            // Linked user instance at frame 30 (goes into fg.instances, not unlinkedInstances).
            var userInst = new Instance([[100, 100], [200, 200]], 0, 'user', 1);
            var fg = new FrameGroup(30);
            fg.addInstance('cam1', userInst);
            session.addFrameGroup(fg);

            tl.setData(session);

            var frames = getSegmentFrames(tl, 'cam1', 0);
            assertTrue(frames.has(30),
                'Linked user instance at frame 30 must appear in timeline segments for cam1:track_0. Actual: ' +
                framesToString(frames));

            cleanup(tl, container);
            tl = null;
        });

        it('preserves occupancy-derived frames alongside user-instance frames (no loss)', function () {
            var session = makeSession(['cam1']);

            session.trackOccupancy = new Map();
            session.trackOccupancy.set('cam1', makeOccupancy(100, 1, [[5, 6, 7, 8, 9]]));

            var userInst = new Instance([[100, 100], [200, 200]], 0, 'user', 1);
            session.addUnlinkedInstance(50, 'cam1', userInst);

            tl.setData(session);

            var frames = getSegmentFrames(tl, 'cam1', 0);

            // Both occupancy frames AND the user-instance frame must be present.
            for (var f = 5; f <= 9; f++) {
                assertTrue(frames.has(f),
                    'Occupancy frame ' + f + ' must still be present. Actual: ' + framesToString(frames));
            }
            assertTrue(frames.has(50),
                'User instance frame 50 must be present. Actual: ' + framesToString(frames));

            cleanup(tl, container);
            tl = null;
        });
    });

    // ---------------------------------------------------------------
    // Point 3: timeline not refreshed when user creates a new instance
    //
    // Point 3's root cause is that index.html's onUserInstanceCreated
    // callback only calls recordUserPoints — it never calls
    // timeline.refreshTracks. Since inline index.html code isn't directly
    // unit-testable, these tests exercise the end-to-end integration at
    // the InteractionManager + Timeline boundary, with the callback wired
    // the way index.html SHOULD wire it after the fix.
    //
    // The tests still fail currently because newly-created user instances
    // always use trackIdx=0, which typically collides with a predicted
    // track_0 in trackOccupancy — triggering Point 2's handledByOccupancy
    // short-circuit. This is the exact failure the user reports: creating
    // a user instance over a session with predictions does not update the
    // timeline, even when refreshTracks is called.
    // ---------------------------------------------------------------

    describe('Timeline - Point 3: refresh after creating new user instance', function () {
        var container, tl;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 100 });
        });

        it('reflects new user instance at unused frame when predicted occupancy exists on same track', function () {
            // Typical user workflow: a session has predictions for cam1:track_0 at frames
            // 10-20. The user jumps to frame 50 (empty) and presses Ctrl+I. The new user
            // instance lands on cam1:track_0 (trackIdx=0 is hardcoded in _addNewInstance).
            // Timeline should show frame 50 as a cam1:track_0 segment after refresh.
            var session = makeSession(['cam1', 'cam2']);
            var views = [
                { name: 'cam1', videoWidth: 640, videoHeight: 480 },
                { name: 'cam2', videoWidth: 640, videoHeight: 480 },
            ];

            session.trackOccupancy = new Map();
            session.trackOccupancy.set('cam1',
                makeOccupancy(100, 1, [[10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]]));

            tl.setData(session);

            // Wire InteractionManager using the EXPECTED Point 3 fix pattern:
            // onUserInstanceCreated must refresh the timeline. This is what index.html's
            // inline callback MUST do after the Point 3 fix.
            var mgr = new InteractionManager({
                getState: function () {
                    return { currentFrame: 50, session: session, views: views };
                },
                getInstanceGroups: function (frameIdx) {
                    return session.instanceGroups.get(frameIdx || 0) || [];
                },
                requestRedraw: function () {},
                onUserInstanceCreated: function (viewName, points) {
                    tl.refreshTracks(session);
                },
            });

            mgr.lastInteractedView = 'cam1';
            mgr._addNewInstance();

            var frames = getSegmentFrames(tl, 'cam1', 0);
            assertTrue(frames.has(50),
                'After _addNewInstance at frame 50, cam1:track_0 segments should include frame 50. Actual: ' +
                framesToString(frames));
            // Existing prediction frames should still be there too.
            assertTrue(frames.has(10),
                'Predicted occupancy frame 10 should still be present. Actual: ' + framesToString(frames));
            assertTrue(frames.has(20),
                'Predicted occupancy frame 20 should still be present. Actual: ' + framesToString(frames));

            cleanup(tl, container);
            tl = null;
        });

        it('reflects new user instance when predicted occupancy covers a different frame on same track', function () {
            // Another realistic scenario: predictions exist at frames 0-30 on cam1:track_0,
            // and the user creates a new user instance at frame 75 (beyond predictions).
            // Timeline must update the segment for cam1:track_0 to extend to frame 75.
            var session = makeSession(['cam1']);
            var views = [{ name: 'cam1', videoWidth: 640, videoHeight: 480 }];

            var predFrames = [];
            for (var i = 0; i <= 30; i++) predFrames.push(i);
            session.trackOccupancy = new Map();
            session.trackOccupancy.set('cam1', makeOccupancy(100, 1, [predFrames]));

            tl.setData(session);

            var mgr = new InteractionManager({
                getState: function () {
                    return { currentFrame: 75, session: session, views: views };
                },
                getInstanceGroups: function (frameIdx) {
                    return session.instanceGroups.get(frameIdx || 0) || [];
                },
                requestRedraw: function () {},
                onUserInstanceCreated: function (viewName, points) {
                    tl.refreshTracks(session);
                },
            });

            mgr.lastInteractedView = 'cam1';
            mgr._addNewInstance();

            var frames = getSegmentFrames(tl, 'cam1', 0);
            assertTrue(frames.has(75),
                'After _addNewInstance at frame 75, cam1:track_0 should include frame 75. Actual: ' +
                framesToString(frames));

            cleanup(tl, container);
            tl = null;
        });
    });

    // ---------------------------------------------------------------
    // Minimum segment width — short segments must remain visible in long videos.
    // Previously, a 1-frame segment in a 180k-frame video was ~0.004 px wide
    // and got dropped by `if (x1 <= x0) continue`. Enforce a minimum visible
    // width relative to the canvas width.
    // ---------------------------------------------------------------

    describe('Timeline - minimum segment draw width', function () {
        var container, tl;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 180000 });
            tl.resize();
        });

        it('exposes _computeSegmentDrawRect for testing draw widths', function () {
            assertTrue(typeof tl._computeSegmentDrawRect === 'function',
                'Timeline should expose _computeSegmentDrawRect(seg)');
            cleanup(tl, container);
            tl = null;
        });

        it('enforces minimum width for 1-frame segment in long video', function () {
            // 180k frames in the timeline → pxPerFrame << 1.
            // A 1-frame segment would be near 0 px wide → invisible / skipped.
            var rect = tl._computeSegmentDrawRect({ start: 5000, end: 5000 });
            assertNotNull(rect, 'Rect must not be null for in-view segment');
            assertTrue(rect.width >= tl.MIN_SEGMENT_WIDTH_PX,
                'Min draw width must be at least ' + tl.MIN_SEGMENT_WIDTH_PX +
                ' px. Got ' + rect.width);
            cleanup(tl, container);
            tl = null;
        });

        it('scales minimum width with canvas width (wider window → wider min)', function () {
            // Use public-ish API to change the timeline's CSS width via _cssWidth,
            // since the mock canvas in the test harness doesn't actually resize.
            tl._cssWidth = 400;
            var rectSmall = tl._computeSegmentDrawRect({ start: 5000, end: 5000 });
            tl._cssWidth = 2000;
            var rectLarge = tl._computeSegmentDrawRect({ start: 5000, end: 5000 });
            assertNotNull(rectSmall);
            assertNotNull(rectLarge);
            assertTrue(rectLarge.width > rectSmall.width,
                'Larger canvas should give a wider minimum segment width. Small: ' +
                rectSmall.width + ', Large: ' + rectLarge.width);
            cleanup(tl, container);
            tl = null;
        });

        it('preserves natural width when segment is wider than minimum', function () {
            // A segment spanning the whole video should be the full content width,
            // not artificially compressed or enlarged beyond that.
            var contentW = tl._cssWidth - tl.LEFT_MARGIN - tl.RIGHT_PADDING;
            var rect = tl._computeSegmentDrawRect({ start: 0, end: 179999 });
            assertNotNull(rect);
            // Allow a 1px rounding tolerance.
            assertTrue(Math.abs(rect.width - contentW) <= 1,
                'Full-range segment should have ~contentW width (' + contentW + '), got ' + rect.width);
            cleanup(tl, container);
            tl = null;
        });

        it('returns null for segment entirely left of visible area', function () {
            tl.setZoom(10);  // zoom in so only part of the video is visible
            tl.scrollTo(100000);  // scroll far right
            var rect = tl._computeSegmentDrawRect({ start: 5, end: 10 });
            assertNull(rect, 'Segment before visible range should be null');
            cleanup(tl, container);
            tl = null;
        });

        it('returns null for segment entirely right of visible area', function () {
            tl.setZoom(10);
            tl.scrollTo(0);
            var rect = tl._computeSegmentDrawRect({ start: 150000, end: 150005 });
            assertNull(rect, 'Segment after visible range should be null');
            cleanup(tl, container);
            tl = null;
        });

        it('centers minimum-width bar on the segment midpoint (matches playhead)', function () {
            // When the natural segment width is smaller than minSegW, the bar
            // should be CENTERED on the segment's midpoint — the same x that
            // _frameToX(currentFrame + 0.5) uses for the playhead. Otherwise
            // the bar appears shifted right of the current-frame indicator,
            // which is how the user originally spotted the bug.
            var frameIdx = 5000;
            var rect = tl._computeSegmentDrawRect({ start: frameIdx, end: frameIdx });
            assertNotNull(rect);

            // Expected center: the midpoint between _frameToX(frameIdx)
            // and _frameToX(frameIdx + 1), which equals _frameToX(frameIdx + 0.5).
            var expectedCenter = tl._frameToX(frameIdx + 0.5);
            var actualCenter = rect.x + rect.width / 2;
            assertTrue(Math.abs(actualCenter - expectedCenter) < 0.5,
                'Min-width bar must be centered on frame midpoint. Expected center ' +
                expectedCenter + ', got ' + actualCenter + ' (x=' + rect.x + ' width=' + rect.width + ')');

            cleanup(tl, container);
            tl = null;
        });

        it('centers bar for multi-frame narrow segment (still below minSegW)', function () {
            // A 3-frame segment in a very long video is still narrower than
            // minSegW — the bar should be centered on the midpoint of [start, end+1].
            var rect = tl._computeSegmentDrawRect({ start: 10000, end: 10002 });
            assertNotNull(rect);
            var expectedCenter = (tl._frameToX(10000) + tl._frameToX(10003)) / 2;
            var actualCenter = rect.x + rect.width / 2;
            assertTrue(Math.abs(actualCenter - expectedCenter) < 0.5,
                'Narrow multi-frame bar must be centered on its midpoint. Expected ' +
                expectedCenter + ', got ' + actualCenter);
            cleanup(tl, container);
            tl = null;
        });

        it('clamps bar to right edge instead of overflowing (no centering overflow)', function () {
            // A short segment at the very last frame should have its draw rect
            // shifted left (or clamped) so it stays inside the content area.
            var contentRight = tl._cssWidth - tl.RIGHT_PADDING;
            var rect = tl._computeSegmentDrawRect({ start: 179999, end: 179999 });
            assertNotNull(rect);
            assertTrue(rect.x + rect.width <= contentRight + 0.5,
                'Draw bar must not extend past content right. x=' + rect.x +
                ' width=' + rect.width + ' contentRight=' + contentRight);
            assertTrue(rect.width >= tl.MIN_SEGMENT_WIDTH_PX,
                'Min width still enforced at edge. Got ' + rect.width);
            cleanup(tl, container);
            tl = null;
        });
    });

    // ---------------------------------------------------------------
    // Snap-to-track on click: when the user clicks near a labeled frame
    // (within MIN_SEGMENT_WIDTH_FRACTION * canvas width), seek to the
    // closest labeled frame instead of the raw click frame. For clusters
    // of labeled frames, pick the one closest to the click.
    // ---------------------------------------------------------------

    describe('Timeline - snap-to-track click', function () {
        var container, tl;

        // Build a session with one camera and instances at the given frames.
        function makeSessionWithFrames(frames) {
            var session = makeSession(['cam1']);
            for (var i = 0; i < frames.length; i++) {
                var inst = new Instance([[10, 10], [20, 20]], 0, 'user', 1);
                var fg = new FrameGroup(frames[i]);
                fg.addInstance('cam1', inst);
                session.addFrameGroup(fg);
            }
            return session;
        }

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            // Use a short video so pxPerFrame >> 1 and adjacent labeled frames
            // have meaningful pixel separation — required for cluster tests.
            tl = new Timeline(container, { totalFrames: 100 });
            tl.resize();
        });

        it('exposes _findSnapFrame helper', function () {
            assertTrue(typeof tl._findSnapFrame === 'function',
                'Timeline should expose _findSnapFrame(clickX)');
            cleanup(tl, container);
            tl = null;
        });

        it('returns null when no tracks exist', function () {
            // No segments → no snap targets
            var clickX = tl._frameToX(50);
            assertNull(tl._findSnapFrame(clickX));
            cleanup(tl, container);
            tl = null;
        });

        it('snaps click to labeled frame when click is on top of the bar', function () {
            var session = makeSessionWithFrames([50]);
            tl.setData(session);
            // Click exactly on the center of the frame's drawn bar
            var clickX = tl._frameToX(50 + 0.5);
            var snapped = tl._findSnapFrame(clickX);
            assertEqual(snapped, 50);
            cleanup(tl, container);
            tl = null;
        });

        it('snaps click to labeled frame in a long video when click is within tolerance', function () {
            // Real bug scenario: long video, narrow segment bar centered on the frame.
            // Click anywhere within tolerance of that bar's center should snap.
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 180000 });
            tl.resize();
            var session = makeSessionWithFrames([5000]);
            tl.setData(session);
            var labeledX = tl._frameToX(5000 + 0.5);
            var snapped = tl._findSnapFrame(labeledX + 1);
            assertEqual(snapped, 5000, 'Click 1px from labeled frame should snap');
            cleanup(tl, container);
            tl = null;
        });

        it('returns null when click is outside tolerance of any labeled frame', function () {
            var session = makeSessionWithFrames([10]);
            tl.setData(session);
            var labeledX = tl._frameToX(10 + 0.5);
            var tolerance = Math.max(tl.MIN_SEGMENT_WIDTH_PX,
                tl._cssWidth * tl.MIN_SEGMENT_WIDTH_FRACTION);
            var snapped = tl._findSnapFrame(labeledX + tolerance * 3);
            assertNull(snapped, 'Click far from any labeled frame should not snap');
            cleanup(tl, container);
            tl = null;
        });

        it('picks the closest frame in a cluster of adjacent labeled frames', function () {
            // Labeled frames 50, 51, 52 form one contiguous segment [50, 52].
            // With totalFrames=100, pxPerFrame ≈ 6.92, so each frame center is
            // well separated. Click just left of frame 52's center → snap to 52.
            var session = makeSessionWithFrames([50, 51, 52]);
            tl.setData(session);
            var x52Center = tl._frameToX(52 + 0.5);
            var snapped = tl._findSnapFrame(x52Center - 0.1);
            assertEqual(snapped, 52, 'Click just left of frame 52 center should snap to 52');
            cleanup(tl, container);
            tl = null;
        });

        it('picks closest frame across multiple separate segments', function () {
            // Two labeled frames widely separated → two segments. A click between
            // them should snap to whichever is nearer in pixels.
            var session = makeSessionWithFrames([30, 70]);
            tl.setData(session);
            var tolerance = Math.max(tl.MIN_SEGMENT_WIDTH_PX,
                tl._cssWidth * tl.MIN_SEGMENT_WIDTH_FRACTION);
            var x30 = tl._frameToX(30 + 0.5);
            var x70 = tl._frameToX(70 + 0.5);

            // Click 1 px right of frame 30 → nearer to 30, within tolerance
            var snapped30 = tl._findSnapFrame(x30 + 1);
            assertEqual(snapped30, 30, 'Click nearer frame 30 should snap to 30');

            // Click 1 px left of frame 70 → nearer to 70, within tolerance
            var snapped70 = tl._findSnapFrame(x70 - 1);
            assertEqual(snapped70, 70, 'Click nearer frame 70 should snap to 70');

            // Click halfway between them → neither within tolerance
            var midX = (x30 + x70) / 2;
            var snappedMid = tl._findSnapFrame(midX);
            assertNull(snappedMid, 'Click halfway between frames should not snap');

            cleanup(tl, container);
            tl = null;
        });

        it('tolerance scales with canvas width', function () {
            var session = makeSessionWithFrames([50]);
            tl.setData(session);

            // At narrow canvas, tolerance is small; click 5px away should not snap.
            tl._cssWidth = 400;  // min tolerance = max(2, 1.0) = 2px
            var labeledXNarrow = tl._frameToX(50 + 0.5);
            var snappedNarrow = tl._findSnapFrame(labeledXNarrow + 5);
            assertNull(snappedNarrow, 'On narrow canvas, click 5px away should not snap');

            // At wide canvas, tolerance is larger; click 5px away should snap.
            tl._cssWidth = 3000;  // min tolerance = max(2, 7.5) = 7.5px
            var labeledXWide = tl._frameToX(50 + 0.5);
            var snappedWide = tl._findSnapFrame(labeledXWide + 5);
            assertEqual(snappedWide, 50, 'On wide canvas, click 5px away should snap');

            cleanup(tl, container);
            tl = null;
        });
    });
})();
