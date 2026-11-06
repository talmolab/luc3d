/**
 * test-unlinked-badge.js — the `showUnlinkedBadge` option on
 * overlays.drawUnlinkedInstances().
 *
 * An unlinked instance (a 2D detection not yet assigned to a cross-view
 * InstanceGroup) is drawn with three cues: dashed edges, reduced opacity, and an
 * amber "?" badge. The badge is an EDITING affordance — it says "assign me" — so
 * it is suppressible via `showUnlinkedBadge: false`, which the overlay video
 * export sets and the Visibility panel's "Show ? badge" toggle drives.
 *
 * What matters and is easy to get wrong:
 *   - the flag must default to TRUE (a missing option must not silently strip an
 *     affordance the live app relies on)
 *   - suppressing the badge must NOT suppress the instance — the dashed skeleton
 *     and nodes still have to render, or "hide the badge" would become "hide the
 *     detection"
 *   - it must apply to BOTH types. `drawFrameOverlays` makes two passes,
 *     typeFilter 'predicted' and 'user', and the badge block sits outside the
 *     isPredicted branch — a per-type regression would only show on one pass.
 *
 * Pixel-based, like test-node-shape.js: the badge is a filled circle + fillText,
 * so counting amber pixels is the only honest check that it did or didn't paint.
 */

(function () {
    const { describe, it, assertTrue, assertEqual } = TestFramework;

    const W = 200, H = 200;
    // The badge's amber. Must match ui/overlays.js.
    const BADGE_RGB = [0xfb, 0xbf, 0x24];

    function makeCtx() {
        var c = document.createElement('canvas');
        c.width = W; c.height = H;
        var ctx = c.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        return ctx;
    }

    // Count pixels close to the badge amber. A tolerance is needed because the
    // badge is drawn at globalAlpha 0.9 over a 60%-black disc, and the "?" glyph
    // is antialiased.
    //
    // Expect only a HANDFUL of these: the disc is black, so the amber is just the
    // 10px bold "?" glyph — measured at 10 px. The thresholds below are therefore
    // "a glyph's worth, not a stray pixel", not "a disc's worth".
    function amberPixels(ctx) {
        var d = ctx.getImageData(0, 0, W, H).data;
        var n = 0;
        for (var i = 0; i < d.length; i += 4) {
            if (d[i + 3] === 0) continue;
            if (Math.abs(d[i] - BADGE_RGB[0]) < 40 &&
                Math.abs(d[i + 1] - BADGE_RGB[1]) < 40 &&
                Math.abs(d[i + 2] - BADGE_RGB[2]) < 40) n++;
        }
        return n;
    }

    function inkedPixels(ctx) {
        var d = ctx.getImageData(0, 0, W, H).data;
        var n = 0;
        for (var i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
    }

    // One unlinked instance whose points sit well away from the canvas edges, so
    // the badge (offset up-left by 2*nodeSize, radius 10) cannot be clipped.
    function makeUnlinked(type) {
        var inst = new Instance([[100, 100], [140, 140]], 0, type, 0);
        return [new UnlinkedInstance(inst, 'cam1')];
    }

    function skel() {
        return new Skeleton('sk', ['a', 'b'], [[0, 1]]);
    }

    function draw(ctx, type, options) {
        var base = {
            nodeSize: 5, lineWidth: 2, videoWidth: W, videoHeight: H,
            canvasWidth: W, canvasHeight: H, showLabels: false,
        };
        drawUnlinkedInstances(ctx, makeUnlinked(type), skel(),
            Object.assign(base, options || {}));
    }

    describe('Overlays - unlinked "?" badge', function () {
        it('has the dependencies it needs', function () {
            assertTrue(typeof drawUnlinkedInstances === 'function', 'drawUnlinkedInstances exported');
            assertTrue(typeof UnlinkedInstance === 'function', 'UnlinkedInstance exported');
        });

        it('draws the badge by default (option omitted entirely)', function () {
            var ctx = makeCtx();
            draw(ctx, 'user', {});
            assertTrue(amberPixels(ctx) > 3,
                'omitting showUnlinkedBadge must still paint the badge (got ' + amberPixels(ctx) + ' amber px)');
        });

        it('draws the badge for showUnlinkedBadge: true', function () {
            var ctx = makeCtx();
            draw(ctx, 'user', { showUnlinkedBadge: true });
            assertTrue(amberPixels(ctx) > 3, 'explicit true paints the badge');
        });

        it('suppresses the badge for showUnlinkedBadge: false', function () {
            var ctx = makeCtx();
            draw(ctx, 'user', { showUnlinkedBadge: false });
            assertEqual(amberPixels(ctx), 0, 'no amber badge pixels remain');
        });

        it('suppresses the badge for BOTH user and predicted instances', function () {
            // drawFrameOverlays runs two passes (typeFilter 'predicted' then
            // 'user'); the badge block is outside the isPredicted branch, so a
            // regression that gated it per type would only show on one of them.
            ['user', 'predicted'].forEach(function (type) {
                var on = makeCtx(), off = makeCtx();
                draw(on, type, { showUnlinkedBadge: true });
                draw(off, type, { showUnlinkedBadge: false });
                assertTrue(amberPixels(on) > 3, type + ': badge drawn when enabled');
                assertEqual(amberPixels(off), 0, type + ': badge gone when disabled');
            });
        });

        it('still draws the instance itself when the badge is hidden', function () {
            // The point of the flag is to drop the editing prompt, NOT the
            // detection. If this ever inverts, unlinked instances would silently
            // vanish from the view that is meant to help you find them.
            var off = makeCtx();
            draw(off, 'user', { showUnlinkedBadge: false });
            var ink = inkedPixels(off);
            assertTrue(ink > 0, 'nodes/edges still rendered without the badge (got ' + ink + ' px)');

            var on = makeCtx();
            draw(on, 'user', { showUnlinkedBadge: true });
            assertTrue(inkedPixels(on) > ink,
                'the badge is strictly ADDITIONAL ink, so enabling it can only add pixels');
        });

        it('hides only the badge, leaving the skeleton pixel-identical', function () {
            // Everything except the badge must be untouched. Compare the two
            // renders outside the badge's disc: identical there, different inside.
            var on = makeCtx(), off = makeCtx();
            draw(on, 'user', { showUnlinkedBadge: true });
            draw(off, 'user', { showUnlinkedBadge: false });
            // Badge center = first visible point (100,100) offset by 2*nodeSize.
            var bx = 100 - 10, by = 100 - 10, r = 12;
            var a = on.getImageData(0, 0, W, H).data;
            var b = off.getImageData(0, 0, W, H).data;
            var diffOutside = 0, diffInside = 0;
            for (var p = 0; p < a.length; p += 4) {
                var idx = p / 4, x = idx % W, y = Math.floor(idx / W);
                var same = a[p] === b[p] && a[p + 1] === b[p + 1] &&
                           a[p + 2] === b[p + 2] && a[p + 3] === b[p + 3];
                if (same) continue;
                if ((x - bx) * (x - bx) + (y - by) * (y - by) <= r * r) diffInside++;
                else diffOutside++;
            }
            assertEqual(diffOutside, 0, 'nothing outside the badge disc changed');
            assertTrue(diffInside > 20, 'the badge disc itself changed (got ' + diffInside + ' px)');
        });
    });
})();
