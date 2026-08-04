/**
 * test-overlay-export-layout.js — unit tests for ui/overlay-export-layout.js,
 * the pure half of "Export Instance Overlays" (issue #190).
 *
 * What actually goes wrong in a composited video export is geometry and
 * encoder-parameter arithmetic, and none of it needs a browser dock:
 *
 *  - `fitRect` must be bit-for-bit the same "contain" fit `videoToCanvas()` in
 *    ui/overlays.js uses. If the two ever diverge, the video is drawn with one
 *    mapping and the skeleton with another, and every exported overlay is
 *    offset from the animal it belongs to. Pinned here by computing both.
 *  - `computeTileRects` must tile the output canvas without gaps, overlap or
 *    out-of-bounds writes — a rect that runs past the canvas silently drops
 *    pixels, and a rounding gap shows as a black seam in the middle of the
 *    stitched frame.
 *  - `outputSizeFor` must always return EVEN dimensions: `VideoEncoder`
 *    configure() rejects odd width/height for H.264 (yuv420), so an odd size is
 *    a hard export failure, not a cosmetic one. It must also stay under the
 *    3840 clamp for extreme aspect ratios (a 10-camera single row is ~10:1).
 *  - `mergeSettings` must never let a stored blob introduce an unknown key or a
 *    wrong-typed value — those feed straight into canvas + encoder parameters.
 *  - `seedLayoutPlan` must only ever reference EARLIER entries, since the caller
 *    substitutes real dockview panel ids as it walks the plan forward.
 *
 * Requires the test-runner bridge: window.__OverlayExportLayout, plus
 * `videoToCanvas` from ui/overlays.js (spread onto window by the bridge).
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertDeepEqual } = TestFramework;


    describe('overlay export — fitRect matches the overlay transform', () => {
        it('agrees with videoToCanvas for a pillarboxed fit', () => {
            // 4:3 video into a 16:9 tile → bars on the left/right.
            const f = __OverlayExportLayout.fitRect(640, 480, 1920, 1080);
            const p = videoToCanvas(0, 0, 640, 480, 1920, 1080);
            assertEqual(f.scale, p.scale, 'scale');
            assertEqual(f.x, p.x, 'x offset');
            assertEqual(f.y, p.y, 'y offset');
        });

        it('agrees with videoToCanvas for a letterboxed fit', () => {
            // 16:9 video into a 4:3 tile → bars top/bottom.
            const f = __OverlayExportLayout.fitRect(1920, 1080, 640, 480);
            const p = videoToCanvas(0, 0, 1920, 1080, 640, 480);
            assertEqual(f.scale, p.scale, 'scale');
            assertEqual(f.x, p.x, 'x offset');
            assertEqual(f.y, p.y, 'y offset');
        });

        it('maps an arbitrary interior point identically', () => {
            const vw = 1280, vh = 800, cw = 500, ch = 500;
            const f = __OverlayExportLayout.fitRect(vw, vh, cw, ch);
            const p = videoToCanvas(321, 654, vw, vh, cw, ch);
            assertEqual(321 * f.scale + f.x, p.x, 'x');
            assertEqual(654 * f.scale + f.y, p.y, 'y');
        });

        it('fills the destination exactly on a matching aspect', () => {
            const f = __OverlayExportLayout.fitRect(1920, 1080, 960, 540);
            assertEqual(f.x, 0, 'no x bar');
            assertEqual(f.y, 0, 'no y bar');
            assertEqual(f.width, 960, 'width');
            assertEqual(f.height, 540, 'height');
        });
    });

    describe('overlay export — computeTileRects', () => {
        // A 2x2 grid in a 800x600 dock.
        const dock = { width: 800, height: 600 };
        const quad = [
            { x: 0,   y: 0,   width: 400, height: 300 },
            { x: 400, y: 0,   width: 400, height: 300 },
            { x: 0,   y: 300, width: 400, height: 300 },
            { x: 400, y: 300, width: 400, height: 300 },
        ];

        it('tiles a matching-aspect output canvas exactly, with no seams', () => {
            const rects = __OverlayExportLayout.computeTileRects(dock, quad, 1600, 1200);
            assertDeepEqual(rects[0], { x: 0, y: 0, width: 800, height: 600 }, 'top-left');
            assertDeepEqual(rects[1], { x: 800, y: 0, width: 800, height: 600 }, 'top-right');
            assertDeepEqual(rects[2], { x: 0, y: 600, width: 800, height: 600 }, 'bottom-left');
            assertDeepEqual(rects[3], { x: 800, y: 600, width: 800, height: 600 }, 'bottom-right');
            // No gap: right edge of tile 0 == left edge of tile 1.
            assertEqual(rects[0].x + rects[0].width, rects[1].x, 'no horizontal seam');
            assertEqual(rects[0].y + rects[0].height, rects[2].y, 'no vertical seam');
        });

        it('never writes outside the output canvas', () => {
            const rects = __OverlayExportLayout.computeTileRects(dock, quad, 1281, 961);   // deliberately odd
            for (const r of rects) {
                assertTrue(r.x >= 0 && r.y >= 0, 'origin inside canvas');
                assertTrue(r.x + r.width <= 1281, 'right edge inside canvas');
                assertTrue(r.y + r.height <= 961, 'bottom edge inside canvas');
            }
        });

        it('letterboxes the whole composition when the output aspect differs', () => {
            // 4:3 dock into a 16:9 canvas → the composition is centred with bars.
            const rects = __OverlayExportLayout.computeTileRects({ width: 800, height: 600 }, quad, 1920, 1080);
            const scale = 1080 / 600;                     // height-limited
            const compW = 800 * scale;                    // 1440
            const barX = Math.round((1920 - compW) / 2);  // 240
            assertEqual(rects[0].x, barX, 'left bar preserved');
            assertEqual(rects[1].x + rects[1].width, 1920 - barX, 'right bar preserved');
            assertEqual(rects[0].y, 0, 'no vertical bar (height-limited)');
        });

        it('never emits a degenerate (zero-size) rect', () => {
            const tiny = [{ x: 0, y: 0, width: 2, height: 2 }];
            const rects = __OverlayExportLayout.computeTileRects({ width: 4000, height: 3000 }, tiny, 64, 48);
            assertTrue(rects[0].width >= 2 && rects[0].height >= 2, 'clamped to >= 2px');
        });
    });

    describe('overlay export — output size / encoder params', () => {
        it('always returns even dimensions (H.264 yuv420 requires it)', () => {
            const aspects = [16 / 9, 4 / 3, 1, 2.35, 0.5625, 3.7, 1.333333];
            for (const key of ['360', '720', '1080', '1440']) {
                for (const a of aspects) {
                    const s = __OverlayExportLayout.outputSizeFor(a, key);
                    assertEqual(s.width % 2, 0, 'even width for aspect ' + a + ' @ ' + key);
                    assertEqual(s.height % 2, 0, 'even height for aspect ' + a + ' @ ' + key);
                }
            }
        });

        it('takes its height from the preset and its width from the aspect', () => {
            const s = __OverlayExportLayout.outputSizeFor(16 / 9, '1080');
            assertEqual(s.height, 1080, 'preset height');
            assertEqual(s.width, 1920, 'derived width');
        });

        it('clamps an extreme aspect to MAX_OUT_DIM and keeps the aspect', () => {
            // A 10-camera single row is ~10:1 — at 1440p that would be 14400px.
            const s = __OverlayExportLayout.outputSizeFor(10, '1440');
            assertEqual(s.width, __OverlayExportLayout.MAX_OUT_DIM, 'width clamped');
            assertTrue(s.height < 1440, 'height reduced to hold the aspect');
            assertTrue(Math.abs(s.width / s.height - 10) < 0.05, 'aspect preserved');
            assertEqual(s.height % 2, 0, 'still even after the clamp');
        });

        it('falls back to 16:9 for a nonsense aspect', () => {
            for (const bad of [0, -3, NaN, Infinity]) {
                const s = __OverlayExportLayout.outputSizeFor(bad, '720');
                assertEqual(s.width, 1280, 'width for aspect ' + bad);
                assertEqual(s.height, 720, 'height for aspect ' + bad);
            }
        });

        it('picks an H.264 level that covers the resolution', () => {
            assertEqual(__OverlayExportLayout.h264CodecFor(1280, 720), 'avc1.42001F', '720p');
            assertEqual(__OverlayExportLayout.h264CodecFor(1920, 1080), 'avc1.420028', '1080p');
            assertEqual(__OverlayExportLayout.h264CodecFor(2560, 1440), 'avc1.420032', '1440p');
            assertEqual(__OverlayExportLayout.h264CodecFor(3840, 2160), 'avc1.420034', '4K');
        });

        it('scales bitrate with quality and clamps to a sane band', () => {
            const lo = __OverlayExportLayout.bitrateFor(1920, 1080, 30, 'low');
            const mid = __OverlayExportLayout.bitrateFor(1920, 1080, 30, 'medium');
            const hi = __OverlayExportLayout.bitrateFor(1920, 1080, 30, 'high');
            assertTrue(lo < mid && mid < hi, 'monotonic in quality');
            assertTrue(__OverlayExportLayout.bitrateFor(64, 48, 1, 'low') >= 1000000, 'floor');
            assertTrue(__OverlayExportLayout.bitrateFor(3840, 2160, 240, 'high') <= 48000000, 'ceiling');
            assertEqual(__OverlayExportLayout.bitrateFor(1920, 1080, 30, 'nonsense'), mid, 'unknown quality → medium');
        });
    });

    describe('overlay export — custom output size', () => {
        const L = () => __OverlayExportLayout;

        it('clamps a hand-typed dimension to an even, legal encoder value', () => {
            assertEqual(L().clampOutDim(1921), 1922, 'odd rounds up to even');
            assertEqual(L().clampOutDim(1920), 1920, 'even is kept');
            assertEqual(L().clampOutDim(0), 2, 'zero floors at 2');
            assertEqual(L().clampOutDim(-500), 2, 'negative floors at 2');
            assertEqual(L().clampOutDim(999999), L().MAX_OUT_DIM, 'clamped to MAX_OUT_DIM');
            assertEqual(L().clampOutDim(720.4), 720, 'fractional rounds');
            assertEqual(L().clampOutDim('1280'), 1280, 'numeric string coerces');
            assertEqual(L().clampOutDim(NaN), 2, 'NaN floors at 2');
            assertEqual(L().clampOutDim('abc'), 2, 'garbage floors at 2');
        });

        it('follows the preset until res is switched to custom', () => {
            const s = L().defaultOverlayExportSettings();
            s.outW = 640; s.outH = 480;
            const preset = L().outputSizeFrom(s, 16 / 9);
            assertEqual(preset.width, 1920, 'preset width still derived from the aspect');
            assertEqual(preset.height, 1080, 'preset height still from the preset');
            s.res = L().RES_CUSTOM;
            const custom = L().outputSizeFrom(s, 16 / 9);
            assertEqual(custom.width, 640, 'custom width wins');
            assertEqual(custom.height, 480, 'custom height wins');
        });

        it('sanitises a stored custom size on the way out', () => {
            const s = L().defaultOverlayExportSettings();
            s.res = L().RES_CUSTOM;
            s.outW = 1001; s.outH = 99999;
            const out = L().outputSizeFrom(s, 1);
            assertEqual(out.width, 1002, 'odd width evened');
            assertEqual(out.height, L().MAX_OUT_DIM, 'over-large height clamped');
            assertEqual(out.width % 2, 0, 'even width');
            assertEqual(out.height % 2, 0, 'even height');
        });

        it('reports a shaping aspect only in custom mode', () => {
            const s = L().defaultOverlayExportSettings();
            assertEqual(L().customAspect(s), null, 'no shaping for a preset');
            s.res = L().RES_CUSTOM;
            s.outW = 1920; s.outH = 1080;
            assertTrue(Math.abs(L().customAspect(s) - 16 / 9) < 1e-9, 'custom aspect reported');
            s.outW = 1080; s.outH = 1080;
            assertEqual(L().customAspect(s), 1, 'square custom aspect');
            assertEqual(L().customAspect(null), null, 'null settings tolerated');
        });

        it('leaves no letterbox once the dock is shaped to the custom aspect', () => {
            // This is the whole point of `customAspect`: shaping the dock makes
            // `computeTileRects` fill the output instead of burning in bars.
            const s = L().defaultOverlayExportSettings();
            s.res = L().RES_CUSTOM; s.outW = 1000; s.outH = 500;
            const out = L().outputSizeFrom(s, 1);
            const a = L().customAspect(s);
            const dock = { width: 400 * a, height: 400 };
            const rects = L().computeTileRects(dock, [{ x: 0, y: 0, width: dock.width, height: dock.height }],
                out.width, out.height);
            assertEqual(rects[0].x, 0, 'no left bar');
            assertEqual(rects[0].y, 0, 'no top bar');
            assertEqual(rects[0].width, out.width, 'fills the output width');
            assertEqual(rects[0].height, out.height, 'fills the output height');
        });

        it('carries a custom size through the settings round trip', () => {
            const base = L().defaultOverlayExportSettings();
            L().mergeSettings(base, { res: 'custom', outW: 1600, outH: 900 });
            assertEqual(base.res, 'custom', 'res persisted');
            assertEqual(base.outW, 1600, 'width persisted');
            assertEqual(base.outH, 900, 'height persisted');
            // A pre-custom-size blob must not disturb the new defaults.
            const old = L().defaultOverlayExportSettings();
            L().mergeSettings(old, { res: '720', fps: 24 });
            assertEqual(old.outW, 1920, 'default width kept');
            assertEqual(old.outH, 1080, 'default height kept');
        });
    });

    describe('overlay export — settings merge', () => {
        it('accepts a matching-typed stored value', () => {
            const base = __OverlayExportLayout.defaultOverlayExportSettings();
            __OverlayExportLayout.mergeSettings(base, { fps: 60, user: { nodeSize: 9 } });
            assertEqual(base.fps, 60, 'fps taken');
            assertEqual(base.user.nodeSize, 9, 'nested value taken');
        });

        it('rejects a wrong-typed stored value rather than poisoning the encoder', () => {
            const base = __OverlayExportLayout.defaultOverlayExportSettings();
            __OverlayExportLayout.mergeSettings(base, { fps: '60', res: 1080, user: { alpha: 'opaque' } });
            assertEqual(base.fps, 30, 'string fps rejected');
            assertEqual(base.res, '1080', 'number res rejected');
            assertEqual(base.user.alpha, 1.0, 'string alpha rejected');
        });

        it('ignores keys the schema does not declare', () => {
            const base = __OverlayExportLayout.defaultOverlayExportSettings();
            __OverlayExportLayout.mergeSettings(base, { evil: true, user: { evil: 1 } });
            assertEqual(base.evil, undefined, 'top-level unknown key dropped');
            assertEqual(base.user.evil, undefined, 'nested unknown key dropped');
        });

        it('survives a null / non-object blob', () => {
            const base = __OverlayExportLayout.defaultOverlayExportSettings();
            assertEqual(__OverlayExportLayout.mergeSettings(base, null).fps, 30, 'null');
            assertEqual(__OverlayExportLayout.mergeSettings(base, 'garbage').fps, 30, 'string');
        });
    });

    describe('overlay export — overlayOptionsFrom', () => {
        it('carries no interaction state into an export', () => {
            const o = __OverlayExportLayout.overlayOptionsFrom(__OverlayExportLayout.defaultOverlayExportSettings(), 640, 480, 320, 240);
            assertEqual(o.selectedInstanceGroup, null, 'no selection');
            assertEqual(o.hoveredNode, null, 'no hover');
            assertEqual(o.dragInfo, null, 'no drag');
            assertEqual(o.assignmentMode, false, 'no assignment mode');
            assertEqual(o.selectedNodeIdx, -1, 'no selected node');
        });

        it('scales marker/line/label sizes by the video→canvas fit', () => {
            const s = __OverlayExportLayout.defaultOverlayExportSettings();
            s.user.nodeSize = 4; s.user.lineWidth = 2; s.user.labelSize = 12;
            // 640x480 video into a 1280x960 tile → 2x. "Size 4" must mean 4
            // VIDEO pixels at every output resolution, or a 360p and a 1440p
            // export of the same layout would not look alike.
            const big = __OverlayExportLayout.overlayOptionsFrom(s, 640, 480, 1280, 960);
            assertEqual(big.userOpts.nodeSize, 8, 'marker doubled');
            assertEqual(big.userOpts.lineWidth, 4, 'line doubled');
            assertEqual(big.userOpts.labelSize, 24, 'label doubled');
            // …and halved when the tile is half the video's size.
            const small = __OverlayExportLayout.overlayOptionsFrom(s, 640, 480, 320, 240);
            assertEqual(small.userOpts.nodeSize, 2, 'marker halved');
            assertEqual(small.userOpts.lineWidth, 1, 'line halved');
            // 1:1 is the identity, matching the live app's video-resolution canvas.
            const same = __OverlayExportLayout.overlayOptionsFrom(s, 640, 480, 640, 480);
            assertEqual(same.userOpts.nodeSize, 4, 'unchanged at 1:1');
            assertEqual(same.userOpts.labelSize, 12, 'label unchanged at 1:1');
        });

        it('never scales the overlay away to nothing on a tiny tile', () => {
            const s = __OverlayExportLayout.defaultOverlayExportSettings();
            const o = __OverlayExportLayout.overlayOptionsFrom(s, 4000, 3000, 40, 30);
            assertTrue(o.userOpts.nodeSize >= 0.75, 'marker floored');
            assertTrue(o.userOpts.lineWidth >= 0.5, 'line floored');
        });

        it('keeps a label size of 0 at 0 — the floor must not create labels', () => {
            const s = __OverlayExportLayout.defaultOverlayExportSettings();
            s.user.labelSize = 0;
            const o = __OverlayExportLayout.overlayOptionsFrom(s, 4000, 3000, 40, 30);
            assertEqual(o.userOpts.labelSize, 0, 'still 0');
            assertEqual(o.userOpts.showLabels, false, 'still off');
        });

        it('derives showLabels from the label size', () => {
            const s = __OverlayExportLayout.defaultOverlayExportSettings();
            s.user.labelSize = 0;
            assertEqual(__OverlayExportLayout.overlayOptionsFrom(s, 1, 1, 1, 1).userOpts.showLabels, false, 'size 0 → off');
            s.user.labelSize = 12;
            assertEqual(__OverlayExportLayout.overlayOptionsFrom(s, 1, 1, 1, 1).userOpts.showLabels, true, 'size 12 → on');
        });

        it('forwards the geometry the caller drew the video with', () => {
            const o = __OverlayExportLayout.overlayOptionsFrom(__OverlayExportLayout.defaultOverlayExportSettings(), 1920, 1080, 640, 360);
            assertEqual(o.videoWidth, 1920, 'videoWidth');
            assertEqual(o.videoHeight, 1080, 'videoHeight');
            assertEqual(o.canvasWidth, 640, 'canvasWidth');
            assertEqual(o.canvasHeight, 360, 'canvasHeight');
        });

        it('maps colorBy onto the boolean drawFrameOverlays expects', () => {
            const s = __OverlayExportLayout.defaultOverlayExportSettings();
            s.colorBy = 'identity';
            assertEqual(__OverlayExportLayout.overlayOptionsFrom(s, 1, 1, 1, 1).colorByIdentity, true, 'identity');
            s.colorBy = 'track';
            assertEqual(__OverlayExportLayout.overlayOptionsFrom(s, 1, 1, 1, 1).colorByIdentity, false, 'track');
        });

        it('passes the per-layer node/edge toggles through', () => {
            const s = __OverlayExportLayout.defaultOverlayExportSettings();
            s.pred.showEdges = false;
            s.reproj.showNodes = false;
            const o = __OverlayExportLayout.overlayOptionsFrom(s, 1, 1, 1, 1);
            assertEqual(o.predictedOpts.showEdges, false, 'predicted edges off');
            assertEqual(o.predictedOpts.showNodes, true, 'predicted nodes still on');
            assertEqual(o.reprojOpts.showNodes, false, 'reproj nodes off');
        });
    });

    describe('overlay export — seedLayoutPlan', () => {
        it('only ever references entries that come earlier in the plan', () => {
            for (const n of [1, 2, 3, 4, 5, 8, 9, 12, 15]) {
                const names = [];
                for (let i = 0; i < n; i++) names.push('cam' + i);
                const plan = __OverlayExportLayout.seedLayoutPlan(names, true);
                for (let i = 0; i < plan.length; i++) {
                    const pos = plan[i].position;
                    if (pos && pos.refIndex != null) {
                        assertTrue(pos.refIndex < i, 'n=' + n + ' step ' + i + ' refs earlier entry');
                        assertTrue(pos.refIndex >= 0, 'n=' + n + ' step ' + i + ' ref is valid');
                    }
                }
            }
        });

        it('places every view exactly once, plus the 3D tile last', () => {
            const plan = __OverlayExportLayout.seedLayoutPlan(['a', 'b', 'c', 'd', 'e'], true);
            assertEqual(plan.length, 6, 'five views + 3D');
            assertEqual(plan[plan.length - 1].viewName, __OverlayExportLayout.TILE_3D, '3D docked last');
            const seen = plan.slice(0, 5).map(p => p.viewName).sort();
            assertDeepEqual(seen, ['a', 'b', 'c', 'd', 'e'], 'every view once');
        });

        it('omits the 3D tile when the session has no calibration', () => {
            const plan = __OverlayExportLayout.seedLayoutPlan(['a', 'b'], false);
            assertEqual(plan.length, 2, 'no 3D entry');
            assertTrue(plan.every(p => p.viewName !== __OverlayExportLayout.TILE_3D), 'TILE_3D absent');
        });

        it('handles a video-less session (3D only)', () => {
            const plan = __OverlayExportLayout.seedLayoutPlan([], true);
            assertEqual(plan.length, 1, 'one entry');
            assertEqual(plan[0].viewName, __OverlayExportLayout.TILE_3D, '3D');
            assertEqual(plan[0].position, null, 'first panel has no position');
            assertDeepEqual(__OverlayExportLayout.seedLayoutPlan([], false), [], 'nothing at all when neither exists');
        });

        it('uses the main dock\'s row-count heuristic', () => {
            // n<=3 → 1 row: nothing is placed "below".
            const three = __OverlayExportLayout.seedLayoutPlan(['a', 'b', 'c'], false);
            assertTrue(three.every(p => !p.position || p.position.direction !== 'below'), 'single row');
            // n=4 → 2 rows: at least one "below".
            const four = __OverlayExportLayout.seedLayoutPlan(['a', 'b', 'c', 'd'], false);
            assertTrue(four.some(p => p.position && p.position.direction === 'below'), 'two rows');
            // n=9 → 3x3: every cell below row 0 is placed "below" the cell
            // directly above it (NOT chained off the row's first cell — that
            // builds a ragged staircase in dockview's split tree, not a grid).
            const nine = __OverlayExportLayout.seedLayoutPlan(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], false);
            assertEqual(nine.filter(p => p.position && p.position.direction === 'below').length, 6, '3x3 grid');
            assertEqual(nine.filter(p => p.position && p.position.direction === 'right').length, 2, 'row 0 chains right');
            // Column-matched: entry 3 ("d") sits below entry 0 ("a"), 4 below 1, …
            assertEqual(nine[3].position.refIndex, 0, 'd below a');
            assertEqual(nine[4].position.refIndex, 1, 'e below b');
            assertEqual(nine[5].position.refIndex, 2, 'f below c');
            assertEqual(nine[6].position.refIndex, 3, 'g below d');
        });
    });
})();
