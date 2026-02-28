/**
 * test-labels.js - Tests for label rendering in overlays.js
 *
 * Focuses on the label (node name text) rendering in drawSkeleton and
 * drawUnlinkedInstances.  Font size is computed as nodeSize * 3 (proportional
 * to the scaled node radius), with a minimum of 10px.  This ensures labels
 * are always visible regardless of canvas/display size ratio.
 */

(function () {
    var describe   = TestFramework.describe;
    var it         = TestFramework.it;
    var assertEqual    = TestFramework.assertEqual;
    var assertTrue     = TestFramework.assertTrue;
    var assertNotNull  = TestFramework.assertNotNull;
    var assertGreaterThan = TestFramework.assertGreaterThan;
    var assertApprox   = TestFramework.assertApprox;

    // ---- Helper: create a canvas with specific intrinsic and display sizes ----

    /**
     * Create an off-screen canvas and optionally inject it into the DOM so
     * getBoundingClientRect returns a meaningful rect.  When displayWidth is
     * provided the canvas is appended to the body (hidden) so the browser
     * can compute layout.
     *
     * @param {number} intrinsicW - canvas.width (drawing-buffer pixels)
     * @param {number} intrinsicH - canvas.height
     * @param {number} [displayW] - CSS display width in px (optional)
     * @param {number} [displayH] - CSS display height in px (optional)
     * @returns {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, cleanup: Function }}
     */
    function makeCanvas(intrinsicW, intrinsicH, displayW, displayH) {
        var canvas = document.createElement('canvas');
        canvas.width = intrinsicW;
        canvas.height = intrinsicH;

        if (displayW != null) {
            canvas.style.width  = displayW + 'px';
            canvas.style.height = (displayH || displayW) + 'px';
            canvas.style.position = 'absolute';
            canvas.style.left = '-9999px';
            canvas.style.top  = '-9999px';
            document.body.appendChild(canvas);
        }

        var ctx = canvas.getContext('2d');

        function cleanup() {
            if (canvas.parentNode) {
                canvas.parentNode.removeChild(canvas);
            }
        }

        return { canvas: canvas, ctx: ctx, cleanup: cleanup };
    }

    // ---- Helper: spy on ctx.fillText and ctx.strokeText ----

    function spyOnTextCalls(ctx) {
        var calls = [];
        var origFillText   = ctx.fillText.bind(ctx);
        var origStrokeText = ctx.strokeText.bind(ctx);

        ctx.fillText = function (text, x, y) {
            calls.push({ method: 'fillText', text: text, x: x, y: y });
            return origFillText(text, x, y);
        };
        ctx.strokeText = function (text, x, y) {
            calls.push({ method: 'strokeText', text: text, x: x, y: y });
            return origStrokeText(text, x, y);
        };

        function restore() {
            ctx.fillText   = origFillText;
            ctx.strokeText = origStrokeText;
        }

        return { calls: calls, restore: restore };
    }

    // ---- Helper: spy on ctx.font setter ----

    function spyOnFont(ctx) {
        var fonts = [];
        var origDescriptor = Object.getOwnPropertyDescriptor(
            CanvasRenderingContext2D.prototype, 'font'
        );
        // We cannot use defineProperty on ctx directly for font in all
        // browsers, so we track it via a wrapper around the label-drawing
        // path.  Instead, we will parse the font string after drawing.
        // Return a function that reads ctx.font and appends it.
        return {
            capture: function () {
                fonts.push(ctx.font);
            },
            fonts: fonts,
        };
    }

    // ================================================================
    // Test suite 1: Font size calculation
    // ================================================================

    describe('Labels - font size calculation', function () {

        it('computes a visible font size when canvas is displayed at smaller size', function () {
            if (typeof drawSkeleton !== 'function') return;

            // Canvas intrinsic 1920x1080 displayed at 400x225
            var c = makeCanvas(1920, 1080, 400, 225);
            try {
                var skeleton = new Skeleton('test', ['nose', 'ear'], [[0, 1]]);
                var instance = new Instance([[100, 200], [300, 400]], 0, 'user', 1.0);

                var spy = spyOnTextCalls(c.ctx);

                drawSkeleton(c.ctx, instance, skeleton, {
                    videoWidth: 1920, videoHeight: 1080,
                    canvasWidth: 1920, canvasHeight: 1080,
                    nodeSize: 4,
                    showLabels: true,
                });

                spy.restore();

                // We should have at least one fillText call for the labels
                var fillCalls = spy.calls.filter(function (c) { return c.method === 'fillText'; });
                assertGreaterThan(fillCalls.length, 0, 'Should have fillText calls for labels');

                // Parse the font that was set on ctx.  The label code computes:
                //   fontSize = Math.max(10, Math.round(nodeSize * 3))
                // With nodeSize=4, scale=1: fontSize = Math.max(10, 12) = 12
                // Verify the font string contains a reasonable size.
                var fontStr = c.ctx.font;
                var match = fontStr.match(/(\d+)px/);
                assertNotNull(match, 'Font should include px size');
                var pxSize = parseInt(match[1], 10);
                // Should be at least 10 (the minimum) and reasonably large for a high-res canvas
                assertGreaterThan(pxSize, 9, 'Font size in canvas pixels should be >= 10');
            } finally {
                c.cleanup();
            }
        });

        it('font size defaults to at least 10px even for small nodeSize', function () {
            if (typeof drawSkeleton !== 'function') return;

            // Canvas 320x240 displayed at 640x480, nodeSize=4, scale=1
            // fontSize = Math.max(10, Math.round(4 * 3)) = 12
            var c = makeCanvas(320, 240, 640, 480);
            try {
                var skeleton = new Skeleton('test', ['a'], []);
                var instance = new Instance([[100, 100]], 0, 'user', 1.0);

                var spy = spyOnTextCalls(c.ctx);

                drawSkeleton(c.ctx, instance, skeleton, {
                    videoWidth: 320, videoHeight: 240,
                    canvasWidth: 320, canvasHeight: 240,
                    nodeSize: 4,
                    showLabels: true,
                });

                spy.restore();

                var fontStr = c.ctx.font;
                var match = fontStr.match(/(\d+)px/);
                assertNotNull(match, 'Font should include px size');
                var pxSize = parseInt(match[1], 10);
                assertGreaterThan(pxSize, 9, 'Font size should be at least 10');
            } finally {
                c.cleanup();
            }
        });

        it('font size is finite and positive when canvas has no parent', function () {
            if (typeof drawSkeleton !== 'function') return;

            // Canvas NOT added to DOM - still works because font size is
            // computed from nodeSize, not getBoundingClientRect
            var c = makeCanvas(640, 480);

            var skeleton = new Skeleton('test', ['a'], []);
            var instance = new Instance([[100, 100]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            // fontSize = Math.max(10, Math.round(4 * 3)) = 12
            var fontStr = c.ctx.font;
            var match = fontStr.match(/(\d+)px/);
            assertNotNull(match, 'Font should include px size');
            var pxSize = parseInt(match[1], 10);
            assertTrue(isFinite(pxSize), 'Font size should be finite');
            assertGreaterThan(pxSize, 0, 'Font size should be positive');

            c.cleanup();
        });
    });

    // ================================================================
    // Test suite 2: Label text content
    // ================================================================

    describe('Labels - text content with named nodes', function () {

        it('draws node names from skeleton.nodes when showLabels is true', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['nose', 'ear', 'tail'], [[0, 1], [1, 2]]);
            var instance = new Instance([[100, 100], [200, 200], [300, 300]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            // Collect all fillText calls (labels produce both strokeText and fillText)
            var fillTexts = spy.calls.filter(function (c) { return c.method === 'fillText'; });
            var drawnNames = fillTexts.map(function (c) { return c.text; });

            // All three node names should appear
            assertTrue(drawnNames.indexOf('nose') >= 0, 'Should draw "nose" label');
            assertTrue(drawnNames.indexOf('ear') >= 0, 'Should draw "ear" label');
            assertTrue(drawnNames.indexOf('tail') >= 0, 'Should draw "tail" label');

            c.cleanup();
        });

        it('draws strokeText outlines for each node name', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['nose', 'ear'], [[0, 1]]);
            var instance = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            var strokeTexts = spy.calls.filter(function (c) { return c.method === 'strokeText'; });
            var strokeNames = strokeTexts.map(function (c) { return c.text; });

            assertTrue(strokeNames.indexOf('nose') >= 0, 'Should strokeText "nose"');
            assertTrue(strokeNames.indexOf('ear') >= 0, 'Should strokeText "ear"');

            c.cleanup();
        });

        it('each node name has matching fillText and strokeText at same position', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['nose', 'ear'], [[0, 1]]);
            var instance = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            // For each node name, strokeText should come before fillText at same coords
            var nodeNames = ['nose', 'ear'];
            for (var n = 0; n < nodeNames.length; n++) {
                var name = nodeNames[n];
                var strokes = spy.calls.filter(function (c) { return c.method === 'strokeText' && c.text === name; });
                var fills   = spy.calls.filter(function (c) { return c.method === 'fillText' && c.text === name; });

                assertEqual(strokes.length, 1, 'Exactly one strokeText for "' + name + '"');
                assertEqual(fills.length, 1, 'Exactly one fillText for "' + name + '"');
                assertApprox(strokes[0].x, fills[0].x, 0.01, name + ' stroke/fill x should match');
                assertApprox(strokes[0].y, fills[0].y, 0.01, name + ' stroke/fill y should match');
            }

            c.cleanup();
        });
    });

    // ================================================================
    // Test suite 3: Fallback names (empty nodes array)
    // ================================================================

    describe('Labels - fallback names for unnamed nodes', function () {

        it('uses node_N fallback names when skeleton.nodes is empty', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', [], []);
            var instance = new Instance([[50, 50], [150, 150], [250, 250]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            var fillTexts = spy.calls.filter(function (c) { return c.method === 'fillText'; });
            var drawnNames = fillTexts.map(function (c) { return c.text; });

            assertTrue(drawnNames.indexOf('node_0') >= 0, 'Should draw "node_0" fallback');
            assertTrue(drawnNames.indexOf('node_1') >= 0, 'Should draw "node_1" fallback');
            assertTrue(drawnNames.indexOf('node_2') >= 0, 'Should draw "node_2" fallback');

            c.cleanup();
        });

        it('uses node_N fallback when skeleton.nodes is shorter than instance.points', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            // Skeleton has only 1 node name, but instance has 3 points
            var skeleton = new Skeleton('test', ['nose'], []);
            var instance = new Instance([[50, 50], [150, 150], [250, 250]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            var fillTexts = spy.calls.filter(function (c) { return c.method === 'fillText'; });
            var drawnNames = fillTexts.map(function (c) { return c.text; });

            assertTrue(drawnNames.indexOf('nose') >= 0, 'First node should use skeleton name');
            assertTrue(drawnNames.indexOf('node_1') >= 0, 'Second node should use fallback "node_1"');
            assertTrue(drawnNames.indexOf('node_2') >= 0, 'Third node should use fallback "node_2"');

            c.cleanup();
        });

        it('handles skeleton.nodes as objects with .name property', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            // Some code uses nodes as { name: 'foo' } objects
            var skeleton = new Skeleton('test', ['nose', 'ear'], [[0, 1]]);
            // Override nodes to be objects
            skeleton.nodes = [{ name: 'obj_nose' }, { name: 'obj_ear' }];
            var instance = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            var fillTexts = spy.calls.filter(function (c) { return c.method === 'fillText'; });
            var drawnNames = fillTexts.map(function (c) { return c.text; });

            assertTrue(drawnNames.indexOf('obj_nose') >= 0, 'Should use .name from object node');
            assertTrue(drawnNames.indexOf('obj_ear') >= 0, 'Should use .name from object node');

            c.cleanup();
        });
    });

    // ================================================================
    // Test suite 4: drawUnlinkedInstances labels
    // ================================================================

    describe('Labels - drawUnlinkedInstances', function () {

        it('draws labels for unlinked instances by default (showLabels not explicitly false)', function () {
            if (typeof drawUnlinkedInstances !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['nose', 'ear', 'tail'], [[0, 1], [1, 2]]);
            var inst = new Instance([[100, 100], [200, 200], [300, 300]], 0, 'user', 0.9);
            var ul = new UnlinkedInstance(inst, 'cam1');

            var spy = spyOnTextCalls(c.ctx);

            drawUnlinkedInstances(c.ctx, [ul], skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                // showLabels not set -> defaults to true for unlinked
            });

            spy.restore();

            // Filter out the "?" badge text - only look for node names
            var fillTexts = spy.calls.filter(function (c) {
                return c.method === 'fillText' && c.text !== '?';
            });
            var drawnNames = fillTexts.map(function (c) { return c.text; });

            assertTrue(drawnNames.indexOf('nose') >= 0, 'Should draw "nose" label on unlinked');
            assertTrue(drawnNames.indexOf('ear') >= 0, 'Should draw "ear" label on unlinked');
            assertTrue(drawnNames.indexOf('tail') >= 0, 'Should draw "tail" label on unlinked');

            c.cleanup();
        });

        it('draws fallback node_N labels for unlinked instances with empty nodes', function () {
            if (typeof drawUnlinkedInstances !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', [], []);
            var inst = new Instance([[50, 50], [150, 150]], 0, 'user', 0.8);
            var ul = new UnlinkedInstance(inst, 'cam1');

            var spy = spyOnTextCalls(c.ctx);

            drawUnlinkedInstances(c.ctx, [ul], skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
            });

            spy.restore();

            var fillTexts = spy.calls.filter(function (c) {
                return c.method === 'fillText' && c.text !== '?';
            });
            var drawnNames = fillTexts.map(function (c) { return c.text; });

            assertTrue(drawnNames.indexOf('node_0') >= 0, 'Should draw "node_0" fallback on unlinked');
            assertTrue(drawnNames.indexOf('node_1') >= 0, 'Should draw "node_1" fallback on unlinked');

            c.cleanup();
        });

        it('suppresses labels when showLabels is explicitly false', function () {
            if (typeof drawUnlinkedInstances !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['nose', 'ear'], [[0, 1]]);
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 0.9);
            var ul = new UnlinkedInstance(inst, 'cam1');

            var spy = spyOnTextCalls(c.ctx);

            drawUnlinkedInstances(c.ctx, [ul], skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: false,
            });

            spy.restore();

            // Only the "?" badge should appear in fillText, NOT node names
            var nodeNameCalls = spy.calls.filter(function (c) {
                return c.method === 'fillText' && c.text !== '?' &&
                    c.text !== 'Detected' && c.text !== 'Reprojected' && c.text !== 'Error vector';
            });

            // Node names should not be drawn when showLabels=false
            var hasNose = false;
            var hasEar = false;
            for (var i = 0; i < nodeNameCalls.length; i++) {
                if (nodeNameCalls[i].text === 'nose') hasNose = true;
                if (nodeNameCalls[i].text === 'ear')  hasEar = true;
            }
            assertTrue(!hasNose, 'Should NOT draw "nose" when showLabels=false');
            assertTrue(!hasEar, 'Should NOT draw "ear" when showLabels=false');

            c.cleanup();
        });
    });

    // ================================================================
    // Test suite 5: showLabels=false hides labels
    // ================================================================

    describe('Labels - showLabels=false hides labels in drawSkeleton', function () {

        it('no fillText calls for node names when showLabels is false', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['nose', 'ear', 'tail'], [[0, 1], [1, 2]]);
            var instance = new Instance([[100, 100], [200, 200], [300, 300]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: false,
            });

            spy.restore();

            var fillTexts = spy.calls.filter(function (c) { return c.method === 'fillText'; });
            assertEqual(fillTexts.length, 0, 'No fillText calls when showLabels is false');

            c.cleanup();
        });

        it('no strokeText calls for node names when showLabels is false', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['nose', 'ear'], [[0, 1]]);
            var instance = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: false,
            });

            spy.restore();

            var strokeTexts = spy.calls.filter(function (c) { return c.method === 'strokeText'; });
            assertEqual(strokeTexts.length, 0, 'No strokeText calls when showLabels is false');

            c.cleanup();
        });

        it('no text calls when showLabels is undefined (defaults to false)', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['nose'], []);
            var instance = new Instance([[100, 100]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                // showLabels NOT set -> defaults to false via !!undefined
            });

            spy.restore();

            var allTextCalls = spy.calls.filter(function (c) {
                return c.method === 'fillText' || c.method === 'strokeText';
            });
            assertEqual(allTextCalls.length, 0, 'No text calls when showLabels is omitted');

            c.cleanup();
        });
    });

    // ================================================================
    // Test suite 6: showLabels=true shows labels
    // ================================================================

    describe('Labels - showLabels=true shows labels in drawSkeleton', function () {

        it('produces fillText calls for each visible node when showLabels is true', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['nose', 'ear', 'tail'], [[0, 1], [1, 2]]);
            var instance = new Instance([[100, 100], [200, 200], [300, 300]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            var fillTexts = spy.calls.filter(function (c) { return c.method === 'fillText'; });
            assertEqual(fillTexts.length, 3, 'Should have 3 fillText calls for 3 nodes');

            c.cleanup();
        });

        it('skips null points in label rendering', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['nose', 'ear', 'tail'], [[0, 1], [1, 2]]);
            // Middle point is null
            var instance = new Instance([[100, 100], null, [300, 300]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            var fillTexts = spy.calls.filter(function (c) { return c.method === 'fillText'; });
            // Only 2 non-null points should have labels
            assertEqual(fillTexts.length, 2, 'Should have 2 fillText calls (1 null point skipped)');

            var drawnNames = fillTexts.map(function (c) { return c.text; });
            assertTrue(drawnNames.indexOf('nose') >= 0, 'Should draw "nose"');
            assertTrue(drawnNames.indexOf('tail') >= 0, 'Should draw "tail"');
            assertTrue(drawnNames.indexOf('ear') < 0, 'Should NOT draw "ear" (null point)');

            c.cleanup();
        });

        it('draws labels at correct offset from node position', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['a'], []);
            var instance = new Instance([[200, 300]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            var fillTexts = spy.calls.filter(function (c) { return c.method === 'fillText'; });
            assertEqual(fillTexts.length, 1, 'One label drawn');

            // The label should be offset to the right and above the node
            // Node is at (200, 300) in video coords. With scale=1 (same size canvas),
            // canvasPoint = (200, 300), nodeSize = 4 * 1 = 4.
            // labelOffset = Math.round(4 * 0.5) = 2
            // Label x = 200 + 4 + 2 = 206
            // Label y = 300 - 2 = 298
            var labelCall = fillTexts[0];
            assertGreaterThan(labelCall.x, 200, 'Label x should be to the right of node center');
            assertTrue(labelCall.y <= 300, 'Label y should be at or above node center');

            c.cleanup();
        });
    });

    // ================================================================
    // Test suite 7: getBoundingClientRect fallback
    // ================================================================

    describe('Labels - detached canvas and edge cases', function () {

        it('labels work when canvas has no parent (not in DOM)', function () {
            if (typeof drawSkeleton !== 'function') return;

            // Canvas NOT in DOM
            var c = makeCanvas(800, 600);
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var instance = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            // Should not throw
            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 800, videoHeight: 600,
                canvasWidth: 800, canvasHeight: 600,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            var fillTexts = spy.calls.filter(function (c) { return c.method === 'fillText'; });
            assertEqual(fillTexts.length, 2, 'Should still draw 2 labels even without DOM parent');

            c.cleanup();
        });

        it('labels render finite text coordinates when canvas is detached', function () {
            if (typeof drawSkeleton !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['pt'], []);
            var instance = new Instance([[320, 240]], 0, 'user', 1.0);

            var spy = spyOnTextCalls(c.ctx);

            drawSkeleton(c.ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            var fillTexts = spy.calls.filter(function (c) { return c.method === 'fillText'; });
            for (var i = 0; i < fillTexts.length; i++) {
                assertTrue(isFinite(fillTexts[i].x), 'Label x coordinate should be finite');
                assertTrue(isFinite(fillTexts[i].y), 'Label y coordinate should be finite');
                assertTrue(!isNaN(fillTexts[i].x), 'Label x coordinate should not be NaN');
                assertTrue(!isNaN(fillTexts[i].y), 'Label y coordinate should not be NaN');
            }

            c.cleanup();
        });

        it('drawUnlinkedInstances labels work when canvas has no parent', function () {
            if (typeof drawUnlinkedInstances !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 0.9);
            var ul = new UnlinkedInstance(inst, 'cam1');

            var spy = spyOnTextCalls(c.ctx);

            // Should not throw
            drawUnlinkedInstances(c.ctx, [ul], skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                nodeSize: 4,
                showLabels: true,
            });

            spy.restore();

            // Filter out "?" badge
            var labelCalls = spy.calls.filter(function (c) {
                return c.method === 'fillText' && c.text !== '?';
            });

            assertEqual(labelCalls.length, 2, 'Should draw 2 labels for unlinked instance in detached canvas');

            // Verify coordinates are finite
            for (var i = 0; i < labelCalls.length; i++) {
                assertTrue(isFinite(labelCalls[i].x), 'Unlinked label x should be finite');
                assertTrue(isFinite(labelCalls[i].y), 'Unlinked label y should be finite');
            }

            c.cleanup();
        });

        it('labels work when canvas is zero-sized', function () {
            if (typeof drawSkeleton !== 'function') return;

            // Edge case: canvas with zero dimensions
            var canvas = document.createElement('canvas');
            canvas.width = 0;
            canvas.height = 0;
            var ctx = canvas.getContext('2d');

            var skeleton = new Skeleton('test', ['a'], []);
            var instance = new Instance([[0, 0]], 0, 'user', 1.0);

            // Should not throw
            drawSkeleton(ctx, instance, skeleton, {
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 0, canvasHeight: 0,
                nodeSize: 4,
                showLabels: true,
            });
        });
    });

    // ================================================================
    // Test suite 8: Label rendering via drawFrameOverlays integration
    // ================================================================

    describe('Labels - drawFrameOverlays passes showLabels to drawSkeleton', function () {

        it('drawFrameOverlays with showLabels=true renders node labels', function () {
            if (typeof drawFrameOverlays !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['nose', 'ear'], [[0, 1]]);
            var cameras = [
                new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            // Verify session stores skeleton correctly
            assertNotNull(session.skeleton, 'session.skeleton should exist');
            assertNotNull(session.skeleton.nodes, 'session.skeleton.nodes should exist');
            assertEqual(session.skeleton.nodes.length, 2, 'skeleton should have 2 nodes');

            var fg = new FrameGroup(0);
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            fg.addInstance('cam1', inst);

            // Verify FrameGroup stores instance correctly
            assertTrue(fg.instances instanceof Map, 'fg.instances should be a Map');
            var storedInstances = fg.instances.get('cam1');
            assertNotNull(storedInstances, 'fg.instances.get(cam1) should return array');
            assertEqual(storedInstances.length, 1, 'should have 1 instance');

            var spy = spyOnTextCalls(c.ctx);

            drawFrameOverlays(c.ctx, 'cam1', fg, [], session, {
                showDetected: true, showReprojected: false, showErrors: false,
                showLabels: true, showLegend: false,
                nodeSize: 4,
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                selectedInstanceGroup: null, selectedNodeIdx: -1,
                hoveredNode: null, dragInfo: null,
                unlinkedInstances: [], assignmentSelectedIds: [],
                assignmentMode: false,
            });

            spy.restore();

            var fillTexts = spy.calls.filter(function (c) { return c.method === 'fillText'; });
            var drawnNames = fillTexts.map(function (c) { return c.text; });

            // Debug: show what was actually drawn
            var allCalls = spy.calls.map(function (c) { return c.method + '(' + c.text + ')'; });
            assertTrue(drawnNames.indexOf('nose') >= 0,
                'drawFrameOverlays should render "nose" label. Got ' + drawnNames.length + ' fillText calls: [' + drawnNames.join(', ') + ']. All spy calls: [' + allCalls.join(', ') + ']');
            assertTrue(drawnNames.indexOf('ear') >= 0, 'drawFrameOverlays should render "ear" label');

            c.cleanup();
        });

        it('drawFrameOverlays with showLabels=false renders no node labels', function () {
            if (typeof drawFrameOverlays !== 'function') return;

            var c = makeCanvas(640, 480);
            var skeleton = new Skeleton('test', ['nose', 'ear'], [[0, 1]]);
            var cameras = [
                new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            var fg = new FrameGroup(0);
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            fg.addInstance('cam1', inst);

            var spy = spyOnTextCalls(c.ctx);

            drawFrameOverlays(c.ctx, 'cam1', fg, [], session, {
                showDetected: true, showReprojected: false, showErrors: false,
                showLabels: false, showLegend: false,
                nodeSize: 4,
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                selectedInstanceGroup: null, selectedNodeIdx: -1,
                hoveredNode: null, dragInfo: null,
                unlinkedInstances: [], assignmentSelectedIds: [],
                assignmentMode: false,
            });

            spy.restore();

            // Should be zero text calls since we disabled both labels and legend
            var allTextCalls = spy.calls.filter(function (c) {
                return c.method === 'fillText' || c.method === 'strokeText';
            });
            assertEqual(allTextCalls.length, 0, 'No text should be drawn with showLabels=false and showLegend=false');

            c.cleanup();
        });
    });

})();
