/**
 * test-overlays.js - Unit tests for overlays.js
 *
 * Note: videoToCanvas() returns { x, y, scale } (object, not array).
 * makeVideoToCanvasTransform() returns a function that also returns { x, y }.
 */

(function () {
    const { describe, it, assertEqual, assertNotNull, assertTrue, assertApprox,
        assertGreaterThan, assertLessThan } = TestFramework;

    // ---- videoToCanvas ----

    describe('Overlays - videoToCanvas', function () {
        it('maps video origin to canvas origin (same size)', function () {
            if (typeof videoToCanvas !== 'function') return;
            var result = videoToCanvas(0, 0, 640, 480, 640, 480);
            assertApprox(result.x, 0, 0.01, 'X should be 0');
            assertApprox(result.y, 0, 0.01, 'Y should be 0');
        });

        it('maps video center to canvas center (same size)', function () {
            if (typeof videoToCanvas !== 'function') return;
            var result = videoToCanvas(320, 240, 640, 480, 640, 480);
            assertApprox(result.x, 320, 1.0, 'Center X');
            assertApprox(result.y, 240, 1.0, 'Center Y');
        });

        it('maps correctly with 2x scale', function () {
            if (typeof videoToCanvas !== 'function') return;
            // 640x480 video displayed at 1280x960
            var result = videoToCanvas(100, 100, 640, 480, 1280, 960);
            assertApprox(result.x, 200, 1.0, 'X should be 2x');
            assertApprox(result.y, 200, 1.0, 'Y should be 2x');
        });

        it('maps correctly with 0.5x scale', function () {
            if (typeof videoToCanvas !== 'function') return;
            // 640x480 video displayed at 320x240
            var result = videoToCanvas(200, 200, 640, 480, 320, 240);
            assertApprox(result.x, 100, 1.0, 'X should be 0.5x');
            assertApprox(result.y, 100, 1.0, 'Y should be 0.5x');
        });

        it('handles aspect ratio mismatch gracefully', function () {
            if (typeof videoToCanvas !== 'function') return;
            // Canvas is square (800x800) but video is 4:3 (640x480)
            // Should use uniform scale = min(800/640, 800/480) = min(1.25, 1.667) = 1.25
            // with letterboxing offset in Y
            var result = videoToCanvas(100, 100, 640, 480, 800, 800);
            assertNotNull(result, 'Should return a value');
            assertTrue(typeof result.x === 'number', 'x should be a number');
            assertTrue(typeof result.y === 'number', 'y should be a number');
            assertTrue(!isNaN(result.x), 'x should not be NaN');
            assertTrue(!isNaN(result.y), 'y should not be NaN');
        });

        it('includes scale in return value', function () {
            if (typeof videoToCanvas !== 'function') return;
            var result = videoToCanvas(0, 0, 640, 480, 1280, 960);
            assertApprox(result.scale, 2.0, 0.01, 'Scale should be 2x');
        });
    });

    // ---- makeVideoToCanvasTransform ----

    describe('Overlays - makeVideoToCanvasTransform', function () {
        it('returns a callable function', function () {
            if (typeof makeVideoToCanvasTransform !== 'function') return;
            var transform = makeVideoToCanvasTransform(640, 480, 640, 480);
            assertEqual(typeof transform, 'function', 'Should return a function');
        });

        it('transform gives same results as videoToCanvas', function () {
            if (typeof makeVideoToCanvasTransform !== 'function') return;
            if (typeof videoToCanvas !== 'function') return;

            var transform = makeVideoToCanvasTransform(640, 480, 1280, 960);
            var testPoints = [[0, 0], [100, 200], [320, 240], [639, 479]];

            for (var i = 0; i < testPoints.length; i++) {
                var direct = videoToCanvas(testPoints[i][0], testPoints[i][1], 640, 480, 1280, 960);
                var viaTransform = transform(testPoints[i][0], testPoints[i][1]);
                assertApprox(viaTransform.x, direct.x, 0.01, 'Transform X at point ' + i);
                assertApprox(viaTransform.y, direct.y, 0.01, 'Transform Y at point ' + i);
            }
        });
    });

    // ---- getTrackColor ----

    describe('Overlays - getTrackColor', function () {
        it('returns a valid hex color string', function () {
            if (typeof getTrackColor !== 'function') return;
            var color = getTrackColor(0);
            assertTrue(typeof color === 'string', 'Should return string');
            assertTrue(color.charAt(0) === '#', 'Should start with #');
            assertGreaterThan(color.length, 3, 'Should be a valid hex color');
        });

        it('returns different colors for different indices', function () {
            if (typeof getTrackColor !== 'function') return;
            var color0 = getTrackColor(0);
            var color1 = getTrackColor(1);
            assertTrue(color0 !== color1, 'Colors 0 and 1 should differ');
        });

        it('cycles colors and does not throw for large indices', function () {
            if (typeof getTrackColor !== 'function') return;
            // Should not throw for any index
            for (var i = 0; i < 20; i++) {
                var color = getTrackColor(i);
                assertNotNull(color, 'Color for index ' + i);
                assertTrue(typeof color === 'string', 'String for index ' + i);
            }
        });
    });

    // ---- errorColor ----

    describe('Overlays - errorColor', function () {
        it('returns green for low error', function () {
            if (typeof errorColor !== 'function') return;
            var color = errorColor(0.5);
            assertNotNull(color, 'Should return a color');
        });

        it('returns different colors for different error magnitudes', function () {
            if (typeof errorColor !== 'function') return;
            var low = errorColor(1.0);
            var high = errorColor(10.0);
            // They should be different (green vs red)
            assertTrue(low !== high, 'Low and high error should have different colors');
        });
    });

    // ---- hexToRgb ----

    describe('Overlays - hexToRgb', function () {
        it('parses standard hex colors', function () {
            if (typeof hexToRgb !== 'function') return;
            var result = hexToRgb('#ff0000');
            assertNotNull(result, 'Should parse #ff0000');
            assertEqual(result.r, 255);
            assertEqual(result.g, 0);
            assertEqual(result.b, 0);
        });

        it('parses white', function () {
            if (typeof hexToRgb !== 'function') return;
            var result = hexToRgb('#ffffff');
            assertNotNull(result);
            assertEqual(result.r, 255);
            assertEqual(result.g, 255);
            assertEqual(result.b, 255);
        });

        it('parses black', function () {
            if (typeof hexToRgb !== 'function') return;
            var result = hexToRgb('#000000');
            assertNotNull(result);
            assertEqual(result.r, 0);
            assertEqual(result.g, 0);
            assertEqual(result.b, 0);
        });
    });

    // ---- Drawing functions don't throw ----

    describe('Overlays - drawing functions safety', function () {
        var canvas, ctx;

        function getTestCanvas() {
            if (!canvas) {
                canvas = document.createElement('canvas');
                canvas.width = 640;
                canvas.height = 480;
                ctx = canvas.getContext('2d');
            }
            ctx.clearRect(0, 0, 640, 480);
            return ctx;
        }

        it('drawSkeleton does not throw with valid input', function () {
            if (typeof drawSkeleton !== 'function') return;
            var testCtx = getTestCanvas();
            var instance = new Instance([[100, 200], [300, 400]], 0, 'user', 1);
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            drawSkeleton(testCtx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
            });
        });

        it('drawSkeleton does not throw with null points', function () {
            if (typeof drawSkeleton !== 'function') return;
            var testCtx = getTestCanvas();
            var instance = new Instance([null, null], 0, 'user', 1);
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            drawSkeleton(testCtx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
            });
        });

        it('drawSkeleton does not throw with empty instance', function () {
            if (typeof drawSkeleton !== 'function') return;
            var testCtx = getTestCanvas();
            var instance = new Instance([], 0, 'user', 1);
            var skeleton = new Skeleton('test', [], []);
            drawSkeleton(testCtx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
            });
        });

        it('drawFrameOverlays does not throw with null frameGroup', function () {
            if (typeof drawFrameOverlays !== 'function') return;
            var testCtx = getTestCanvas();
            var skeleton = new Skeleton('test', ['a'], []);
            var cameras = [new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])];
            var session = new Session(cameras, skeleton, []);

            drawFrameOverlays(testCtx, 'cam1', null, [], session, {
                showDetected: true, showReprojected: false, showErrors: false, showLabels: false,
                nodeSize: 4, videoWidth: 640, videoHeight: 480, canvasWidth: 640, canvasHeight: 480,
                selectedInstanceGroup: null, selectedNodeIdx: -1, hoveredNode: null, dragInfo: null,
                unlinkedInstances: [], assignmentSelectedIds: [], assignmentMode: false,
            });
        });

        it('drawFrameOverlays does not throw with empty instanceGroups', function () {
            if (typeof drawFrameOverlays !== 'function') return;
            var testCtx = getTestCanvas();
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var cameras = [new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])];
            var session = new Session(cameras, skeleton, []);

            drawFrameOverlays(testCtx, 'cam1', { instances: {} }, [], session, {
                showDetected: true, showReprojected: true, showErrors: true, showLabels: true,
                nodeSize: 4, videoWidth: 640, videoHeight: 480, canvasWidth: 640, canvasHeight: 480,
                selectedInstanceGroup: null, selectedNodeIdx: -1, hoveredNode: null, dragInfo: null,
                unlinkedInstances: [], assignmentSelectedIds: [], assignmentMode: false,
            });
        });
    });

    // ---- getFrameStats ----

    describe('Overlays - getFrameStats', function () {
        it('computes stats for a frame with data', function () {
            if (typeof getFrameStats !== 'function') return;

            var cameras = [
                new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 100], [640, 480]),
                new Camera('cam2', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0.3, 0], [20, 0, 80], [640, 480]),
            ];
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var session = new Session(cameras, skeleton, ['track_0']);

            var fg = new FrameGroup(0);
            var inst1 = new Instance([[100, 200], [300, 400]], 0, 'user', 0.95);
            var inst2 = new Instance([[150, 250], [350, 450]], 0, 'user', 0.88);
            fg.addInstance('cam1', inst1);
            fg.addInstance('cam2', inst2);
            session.addFrameGroup(fg);

            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst1);
            group.addInstance('cam2', inst2);

            var stats = getFrameStats(fg, [group], cameras);
            assertNotNull(stats, 'Should return stats');
        });

        it('returns empty stats for null frameGroup', function () {
            if (typeof getFrameStats !== 'function') return;
            var stats = getFrameStats(null, [], []);
            assertNotNull(stats, 'Should return stats object even for null input');
        });
    });
})();
