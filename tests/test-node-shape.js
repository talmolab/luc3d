/**
 * test-node-shape.js - Unit tests for overlays.drawNodeShape().
 *
 * drawNodeShape(ctx, x, y, shape, size, color) renders one keypoint marker in
 * one of four styles: 'circle', 'x', 'triangle', 'square'. These tests draw
 * each shape on a real 2D canvas and spot-check pixels to confirm the shape
 * actually rendered and that the shapes differ from one another.
 */

(function () {
    const { describe, it, assertTrue } = TestFramework;

    function makeCtx() {
        var c = document.createElement('canvas');
        c.width = 100; c.height = 100;
        var ctx = c.getContext('2d');
        ctx.clearRect(0, 0, 100, 100);
        return ctx;
    }
    // A pixel is "inked" if its alpha channel is non-zero.
    function inked(ctx, x, y) {
        return ctx.getImageData(x, y, 1, 1).data[3] > 0;
    }

    describe('Overlays - drawNodeShape', function () {
        it('is exported', function () {
            assertTrue(typeof drawNodeShape === 'function', 'drawNodeShape should be a function');
        });

        it('draws ink at the center for every shape', function () {
            if (typeof drawNodeShape !== 'function') return;
            ['circle', 'x', 'triangle', 'square'].forEach(function (shape) {
                var ctx = makeCtx();
                drawNodeShape(ctx, 50, 50, shape, 10, '#ff0000');
                assertTrue(inked(ctx, 50, 50), shape + ' should ink its center');
            });
        });

        it('circle fills straight-below center where square does not', function () {
            if (typeof drawNodeShape !== 'function') return;
            // Circle radius 10 -> (50,59) is inside (dist 9). Square half-extent
            // is size*1.6/2 = 8 -> (50,59) is 9 below center, outside the square.
            var cc = makeCtx();
            drawNodeShape(cc, 50, 50, 'circle', 10, '#ff0000');
            assertTrue(inked(cc, 50, 59), 'circle should ink a point 9px below center');

            var sc = makeCtx();
            drawNodeShape(sc, 50, 50, 'square', 10, '#ff0000');
            assertTrue(!inked(sc, 50, 59), 'square should NOT ink a point 9px below center');
        });

        it('unknown shape falls back to a filled circle', function () {
            if (typeof drawNodeShape !== 'function') return;
            var ctx = makeCtx();
            drawNodeShape(ctx, 50, 50, 'bogus', 10, '#ff0000');
            assertTrue(inked(ctx, 50, 50), 'fallback should ink center');
            assertTrue(inked(ctx, 50, 59), 'fallback should ink like a circle');
        });

        it('does not throw for any shape', function () {
            if (typeof drawNodeShape !== 'function') return;
            var ctx = makeCtx();
            var threw = false;
            try {
                ['circle', 'x', 'triangle', 'square'].forEach(function (s) {
                    drawNodeShape(ctx, 30, 30, s, 6, '#00ff00');
                });
            } catch (e) { threw = true; }
            assertTrue(!threw, 'drawNodeShape should not throw');
        });
    });
})();
