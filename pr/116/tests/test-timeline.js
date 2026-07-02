/**
 * test-timeline.js - Tests for Timeline widget (timeline.js)
 *
 * Tests: setCurrentFrame, setTotalFrames, coordinate conversion, zoom,
 * scroll clamping, frame change callbacks, data building, and range selection.
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertDeepEqual, assertNotNull,
        assertNull, assertTrue, assertFalse, assertGreaterThan, assertLessThan,
        assertApprox } = TestFramework;

    // Helper: create a container div with fixed dimensions for the timeline
    function createContainer(width, height) {
        var div = document.createElement('div');
        div.style.width = (width || 800) + 'px';
        div.style.height = (height || 80) + 'px';
        div.style.position = 'fixed';
        div.style.top = '-9999px'; // off-screen so it doesn't interfere
        div.style.left = '0';
        document.body.appendChild(div);
        return div;
    }

    function cleanup(timeline, container) {
        if (timeline) timeline.destroy();
        if (container && container.parentNode) container.remove();
    }

    describe('Timeline - Construction', function () {
        var container, tl;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 100 });
        });

        it('creates a canvas inside the container', function () {
            var canvas = container.querySelector('canvas');
            assertNotNull(canvas, 'Should have a canvas element');
            cleanup(tl, container);
            tl = null;
        });

        it('creates a tooltip element', function () {
            var tooltip = container.querySelector('div');
            assertNotNull(tooltip, 'Should have a tooltip div');
            cleanup(tl, container);
            tl = null;
        });

        it('initializes with totalFrames from options', function () {
            assertEqual(tl._totalFrames, 100, 'Should have 100 total frames');
            cleanup(tl, container);
            tl = null;
        });

        it('initializes currentFrame at 0', function () {
            assertEqual(tl._currentFrame, 0, 'Should start at frame 0');
            cleanup(tl, container);
            tl = null;
        });

        it('initializes zoom at 1', function () {
            assertEqual(tl._zoom, 1, 'Should start at zoom level 1');
            cleanup(tl, container);
            tl = null;
        });
    });

    describe('Timeline - setCurrentFrame', function () {
        var container, tl, lastFrame;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            lastFrame = null;
            container = createContainer(800, 80);
            tl = new Timeline(container, {
                totalFrames: 200,
                onFrameChange: function (f) { lastFrame = f; },
            });
        });

        it('updates internal currentFrame', function () {
            tl.setCurrentFrame(50);
            assertEqual(tl._currentFrame, 50);
            cleanup(tl, container);
            tl = null;
        });

        it('clamps to 0 for negative values', function () {
            tl.setCurrentFrame(-10);
            assertEqual(tl._currentFrame, 0, 'Should clamp to 0');
            cleanup(tl, container);
            tl = null;
        });

        it('clamps to totalFrames-1 for values exceeding total', function () {
            tl.setCurrentFrame(999);
            assertEqual(tl._currentFrame, 199, 'Should clamp to 199');
            cleanup(tl, container);
            tl = null;
        });

        it('does not re-render for same frame (early return)', function () {
            tl.setCurrentFrame(42);
            var drawCount = 0;
            var origRedraw = tl.redraw.bind(tl);
            tl.redraw = function () { drawCount++; origRedraw(); };
            tl.setCurrentFrame(42); // same frame
            assertEqual(drawCount, 0, 'Should not redraw for same frame');
            cleanup(tl, container);
            tl = null;
        });
    });

    describe('Timeline - setTotalFrames', function () {
        var container, tl;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 100 });
        });

        it('updates totalFrames', function () {
            tl.setTotalFrames(500);
            assertEqual(tl._totalFrames, 500);
            cleanup(tl, container);
            tl = null;
        });

        it('clamps to at least 1', function () {
            tl.setTotalFrames(0);
            assertEqual(tl._totalFrames, 1, 'Should be at least 1');
            tl.setTotalFrames(-5);
            assertEqual(tl._totalFrames, 1, 'Should be at least 1 for negative');
            cleanup(tl, container);
            tl = null;
        });

        it('clamps currentFrame if it exceeds new total', function () {
            tl.setCurrentFrame(90);
            tl.setTotalFrames(50);
            // setCurrentFrame internally clamps, but scroll should be clamped
            assertTrue(tl._scrollFrame >= 0, 'Scroll should be >= 0');
            cleanup(tl, container);
            tl = null;
        });
    });

    describe('Timeline - Zoom', function () {
        var container, tl;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 1000 });
        });

        it('setZoom changes zoom level', function () {
            tl.setZoom(5);
            assertEqual(tl._zoom, 5);
            cleanup(tl, container);
            tl = null;
        });

        it('setZoom clamps to minimum of 1', function () {
            tl.setZoom(0.5);
            assertEqual(tl._zoom, 1, 'Zoom should not go below 1');
            cleanup(tl, container);
            tl = null;
        });

        it('visibleFrames decreases with higher zoom', function () {
            var fullVisible = tl._visibleFrames();
            tl.setZoom(5);
            var zoomedVisible = tl._visibleFrames();
            assertLessThan(zoomedVisible, fullVisible, 'Should see fewer frames when zoomed');
            cleanup(tl, container);
            tl = null;
        });

        it('zoom at 1 shows all frames', function () {
            assertEqual(tl._visibleFrames(), 1000, 'Should show all 1000 frames at zoom 1');
            cleanup(tl, container);
            tl = null;
        });
    });

    describe('Timeline - wheel zoom (plain mouse wheel)', function () {
        var container, tl;

        function wheel(deltaY, shiftKey) {
            return {
                deltaX: 0, deltaY: deltaY, offsetX: 400,
                ctrlKey: false, shiftKey: !!shiftKey,
                preventDefault: function () {},
            };
        }

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 1000 });
            tl._cssWidth = 800; // make content math well-defined headless
        });

        it('plain wheel up zooms in', function () {
            var before = tl._zoom;
            tl._handleWheel(wheel(-100, false));
            assertGreaterThan(tl._zoom, before, 'scroll up should zoom in');
            cleanup(tl, container);
            tl = null;
        });

        it('plain wheel down zooms out', function () {
            tl.setZoom(5);
            var before = tl._zoom;
            tl._handleWheel(wheel(100, false));
            assertLessThan(tl._zoom, before, 'scroll down should zoom out');
            cleanup(tl, container);
            tl = null;
        });

        it('Shift+wheel does not zoom (reserved for row scroll)', function () {
            tl.setZoom(3);
            var before = tl._zoom;
            tl._handleWheel(wheel(-100, true));
            assertEqual(tl._zoom, before, 'Shift+wheel should not change zoom');
            cleanup(tl, container);
            tl = null;
        });
    });

    describe('Timeline - Coordinate Conversion', function () {
        var container, tl;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 100 });
            tl.resize(); // ensure dimensions are computed
        });

        it('_frameToX and _xToFrame are inverse (at zoom 1)', function () {
            var x = tl._frameToX(50);
            var frame = tl._xToFrame(x);
            assertApprox(frame, 50, 0.5, 'Round-trip should yield ~50');
            cleanup(tl, container);
            tl = null;
        });

        it('frame 0 maps to LEFT_MARGIN', function () {
            var x = tl._frameToX(0);
            assertApprox(x, tl.LEFT_MARGIN, 1, 'Frame 0 should be at left margin');
            cleanup(tl, container);
            tl = null;
        });

        it('_clampFrame clamps correctly', function () {
            assertEqual(tl._clampFrame(-5), 0);
            assertEqual(tl._clampFrame(50), 50);
            assertEqual(tl._clampFrame(999), 99);
            cleanup(tl, container);
            tl = null;
        });
    });

    describe('Timeline - Scroll', function () {
        var container, tl;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 1000 });
        });

        it('_clampScroll keeps scroll >= 0', function () {
            tl._scrollFrame = -50;
            tl._clampScroll();
            assertEqual(tl._scrollFrame, 0, 'Should clamp to 0');
            cleanup(tl, container);
            tl = null;
        });

        it('_ensureFrameVisible scrolls forward', function () {
            tl.setZoom(10); // show only 100 frames
            tl._scrollFrame = 0;
            tl._ensureFrameVisible(500);
            assertGreaterThan(tl._scrollFrame, 0, 'Should have scrolled forward');
            cleanup(tl, container);
            tl = null;
        });

        it('scrollTo moves scroll position', function () {
            tl.setZoom(10);
            tl.scrollTo(500);
            // After scrollTo(500), frame 500 should be visible
            var visible = tl._visibleFrames();
            assertTrue(500 >= tl._scrollFrame && 500 <= tl._scrollFrame + visible,
                'Frame 500 should be visible');
            cleanup(tl, container);
            tl = null;
        });
    });

    describe('Timeline - Data Building', function () {
        var container, tl;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 100 });
        });

        it('setData with null clears segments and markers', function () {
            tl.setData(null);
            assertEqual(tl._trackSegments.length, 0, 'Should clear segments');
            assertEqual(tl._frameMarkers.size, 0, 'Should clear markers');
            cleanup(tl, container);
            tl = null;
        });

        it('setData populates track segments from session', function () {
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var cameras = [
                new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var session = new Session(cameras, skeleton, ['track_0', 'track_1']);

            // Add instances to frame 5 and frame 6 for track_0
            var inst0 = new Instance([[100, 100], [200, 200]], 0, 'user', 1);
            var fg5 = new FrameGroup(5);
            fg5.addInstance('cam1', inst0);
            session.addFrameGroup(fg5);

            var inst1 = new Instance([[100, 100], [200, 200]], 0, 'user', 1);
            var fg6 = new FrameGroup(6);
            fg6.addInstance('cam1', inst1);
            session.addFrameGroup(fg6);

            tl.setData(session);

            // Only track_0 has instances in cam1, so 1 track segment
            assertGreaterThan(tl._trackSegments.length, 0, 'Should have at least 1 track segment');
            assertGreaterThan(tl._trackSegments[0].segments.length, 0, 'Track 0 should have segments');
            cleanup(tl, container);
            tl = null;
        });

        it('setData populates frame markers', function () {
            var skeleton = new Skeleton('test', ['a'], []);
            var cameras = [
                new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            var inst = new Instance([[50, 50]], 0, 'user', 1);
            var fg = new FrameGroup(10);
            fg.addInstance('cam1', inst);
            session.addFrameGroup(fg);

            tl.setData(session);

            assertTrue(tl._frameMarkers.has(10), 'Should have marker for frame 10');
            var marker = tl._frameMarkers.get(10);
            assertTrue(marker.hasUser, 'Marker should indicate user annotation');
            cleanup(tl, container);
            tl = null;
        });
    });

    describe('Timeline - Frame Modification Markers', function () {
        var container, tl;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 100 });
        });

        it('setFrameModified marks a frame as modified', function () {
            tl.setFrameModified(10, true);
            assertTrue(tl._frameMarkers.has(10));
            assertTrue(tl._frameMarkers.get(10).modified);
            cleanup(tl, container);
            tl = null;
        });

        it('setFrameModified can unmark a frame', function () {
            tl.setFrameModified(10, true);
            tl.setFrameModified(10, false);
            assertFalse(tl._frameMarkers.get(10).modified);
            cleanup(tl, container);
            tl = null;
        });

        it('setFrameModified updates existing marker', function () {
            // Pre-populate a marker
            tl._frameMarkers.set(5, { hasUser: true, hasPredicted: false, modified: false });
            tl.setFrameModified(5, true);
            assertTrue(tl._frameMarkers.get(5).modified);
            assertTrue(tl._frameMarkers.get(5).hasUser, 'Should preserve hasUser');
            cleanup(tl, container);
            tl = null;
        });
    });

    describe('Timeline - Range Selection', function () {
        var container, tl;

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 100 });
        });

        it('clearRangeSelection resets range', function () {
            tl._rangeStart = 10;
            tl._rangeEnd = 50;
            tl.clearRangeSelection();
            assertNull(tl._rangeStart);
            assertNull(tl._rangeEnd);
            cleanup(tl, container);
            tl = null;
        });
    });

    describe('Timeline - Destroy', function () {
        it('removes canvas and tooltip from container', function () {
            var container = createContainer(800, 80);
            var tl = new Timeline(container, { totalFrames: 100 });

            assertEqual(container.querySelectorAll('canvas').length, 1, 'Should have canvas');
            tl.destroy();
            assertEqual(container.querySelectorAll('canvas').length, 0, 'Canvas should be removed');
            container.remove();
        });
    });

    // ---- Mouse interaction regressions: right-click pan + mouseup-only seek ----
    describe('Timeline - mouse interaction', function () {
        var container, tl;

        function ev(button, x) {
            return {
                button: button, offsetX: x, offsetY: 20,
                clientX: x, clientY: 20,
                preventDefault: function () {}, shiftKey: false,
            };
        }

        beforeEach(function () {
            if (tl) cleanup(tl, container);
            container = createContainer(800, 80);
            tl = new Timeline(container, { totalFrames: 100 });
        });

        it('right-click + drag scrolls the timeline; right-click release alone is a no-op', function () {
            // Zoom so there's scrollable range.
            var bigContainer = createContainer(800, 80);
            var bigTl = new Timeline(bigContainer, { totalFrames: 10000 });
            bigTl.setZoom(10);
            var scrollBefore = bigTl._scrollFrame;
            bigTl._handleMouseDown(ev(2, 300));
            assertTrue(!!bigTl._isPanning, 'right-click enters pan mode');
            bigTl._handleMouseMove(ev(2, 100));
            assertTrue(bigTl._scrollFrame !== scrollBefore,
                'drag updates _scrollFrame');
            bigTl._handleMouseUp(ev(2, 100));
            assertFalse(!!bigTl._isPanning, 'mouseup ends the pan');
            cleanup(bigTl, bigContainer);

            // Right-click release without drag changes nothing.
            var prevFrame = tl._currentFrame;
            var prevScroll = tl._scrollFrame;
            tl._handleMouseDown(ev(2, 300));
            tl._handleMouseUp(ev(2, 300));
            assertEqual(tl._scrollFrame, prevScroll);
            assertEqual(tl._currentFrame, prevFrame);
            cleanup(tl, container); tl = null;
        });

        it('left-click drag does not emit during drag; one seek fires on mouseup', function () {
            var frameChanges = [];
            var dragEnds = [];
            tl._onFrameChange = function (f) { frameChanges.push(f); };
            tl._onDragEnd = function (f) { dragEnds.push(f); };
            var before = tl._currentFrame;

            tl._handleMouseDown(ev(0, 300));
            tl._handleMouseMove(ev(0, 400));
            tl._handleMouseMove(ev(0, 500));
            assertEqual(frameChanges.length, 0,
                'no intermediate frame loads during drag');
            assertEqual(tl._currentFrame, before,
                'playhead pinned during drag');

            tl._handleMouseUp(ev(0, 500));
            assertEqual(frameChanges.length, 1, 'one onFrameChange per gesture');
            assertEqual(dragEnds.length, 1, 'one onDragEnd per gesture');
            assertEqual(frameChanges[0], dragEnds[0],
                'both emissions target the same final frame');
            assertTrue(tl._currentFrame !== before,
                'playhead jumps to the release frame');
            cleanup(tl, container); tl = null;
        });

        it('release outside the content area does not seek', function () {
            var dragEnds = [];
            tl._onDragEnd = function (f) { dragEnds.push(f); };
            tl._handleMouseDown(ev(0, 300));
            tl._handleMouseUp(ev(0, 10));  // inside LEFT_MARGIN (label area)
            assertEqual(dragEnds.length, 0);
            cleanup(tl, container); tl = null;
        });
    });

})();
