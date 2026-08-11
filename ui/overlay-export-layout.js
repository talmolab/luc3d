// ui/overlay-export-layout.js — pure geometry / settings helpers behind the
// "Export Video Overlays" modal (issue #190).
//
// Deliberately DEPENDENCY-FREE (no project imports, no dockview, no DOM beyond
// `localStorage`) so it can be bridged into the classic-script unit runner and
// exercised without a browser dock. `ui/overlay-export-modal.js` owns everything
// that needs the DOM, dockview, decoders or WebCodecs.

/** The synthetic "view name" of the 3D viewport tile. Never a real camera name. */
export const TILE_3D = '__3d__';

export const SETTINGS_KEY = 'overlayExportSettings.v1';

/**
 * Output heights — the shared quality tiers, used by BOTH video export modals
 * ("Export Video Overlays" here, "Export 3D Video" via `V3D_RES` in
 * ui/export-modals.js, which is built from this table). Keep them in sync: two
 * tier tables is how the modals drifted apart before.
 *
 * Keys ARE the height. Here the width is DERIVED from the composition (or tile)
 * aspect ratio, so the export carries no letterbox bars unless the layout itself
 * demands them — meaning the real output width is only known once a layout
 * exists. `refW` is therefore just the 16:9 reference width used for the option
 * labels (and it is the exact width the 3D modal uses, since that viewport is
 * always rendered 16:9); the modal shows the ACTUAL W×H in its output readout,
 * which is what to trust when the composition is not 16:9.
 */
export const RES_PRESETS = {
    '480':  { h: 480,  refW: 854,  label: '480p (854×480)'    },
    '720':  { h: 720,  refW: 1280, label: '720p (1280×720)'   },
    '1080': { h: 1080, refW: 1920, label: '1080p (1920×1080)' },
    '2160': { h: 2160, refW: 3840, label: '2160p (3840×2160)' },
};

/** Fallback whenever a `res` value isn't a known preset. */
export const DEFAULT_RES = '1080';

export const MAX_OUT_DIM = 3840;

/** Bits-per-pixel-per-second multipliers behind the Quality picker. */
export const QUALITY_BPP = { low: 0.06, medium: 0.12, high: 0.24 };

/** Round to the nearest even integer >= 2 (H.264 requires even dimensions). */
export function evenDim(n) {
    var v = Math.round(n);
    if (v < 2) return 2;
    return v % 2 === 0 ? v : v + 1;
}

/**
 * Aspect-preserving "contain" fit of a srcW x srcH box into dstW x dstH.
 *
 * Identical maths to `videoToCanvas()` in ui/overlays.js — that is the whole
 * point: a video drawn with this fit and overlays drawn with that transform
 * land on the same pixels, so the burned-in skeleton sits on the animal.
 */
export function fitRect(srcW, srcH, dstW, dstH) {
    var s = Math.min(dstW / srcW, dstH / srcH);
    var w = srcW * s, h = srcH * s;
    return { scale: s, x: (dstW - w) / 2, y: (dstH - h) / 2, width: w, height: h };
}

/**
 * Size of the axis-aligned box a srcW x srcH image occupies once rotated by
 * `rotationDeg` about its own centre.
 *
 * The main window rotates the whole `.canvas-wrapper` with a CSS transform
 * (`applyZoom`, loading/video.js), so a 90-degree camera rotation SWAPS a view's
 * effective width and height — a 640x480 camera reads as 480x640. Anything asking
 * "what aspect is this view?" has to ask it of the ROTATED box, or a rotated frame
 * ends up pillarboxed inside an output sized for the unrotated one.
 *
 * Cardinal angles are special-cased so 90/270 come out exactly swapped rather than
 * swapped-plus-floating-point-dust; the general case is the standard
 * |w cos| + |h sin| bound. 0 and 180 return srcW x srcH unchanged, which is what
 * keeps every unrotated call site bit-identical.
 */
export function rotatedBoxSize(srcW, srcH, rotationDeg) {
    var r = Number(rotationDeg);
    if (!isFinite(r)) r = 0;
    r = ((r % 360) + 360) % 360;
    if (r === 0 || r === 180) return { width: srcW, height: srcH };
    if (r === 90 || r === 270) return { width: srcH, height: srcW };
    var a = r * Math.PI / 180;
    var c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    return { width: srcW * c + srcH * s, height: srcW * s + srcH * c };
}

/**
 * Rotation-aware "contain" fit: the scale at which a srcW x srcH image, rotated by
 * `rotationDeg`, still fits inside dstW x dstH — plus the size of the UNROTATED
 * image box at that scale.
 *
 * `boxWidth`/`boxHeight` are what a tile draw needs: it paints the video (and the
 * overlays) into a boxWidth x boxHeight rectangle centred on the tile and rotates
 * that rectangle, exactly as the main window rotates the one wrapper holding both
 * canvases. At rotation 0 this degenerates to `fitRect`: the scale expression is
 * literally the same `Math.min(dstW / srcW, dstH / srcH)`.
 */
export function rotatedFit(srcW, srcH, dstW, dstH, rotationDeg) {
    var box = rotatedBoxSize(srcW, srcH, rotationDeg);
    var s = Math.min(dstW / box.width, dstH / box.height);
    if (!isFinite(s) || s <= 0) s = 1;
    return { scale: s, boxWidth: srcW * s, boxHeight: srcH * s };
}

/**
 * Map dock-local tile rects into an outW x outH output canvas.
 *
 * The dock is fitted into the output canvas first (so a mismatched output aspect
 * letterboxes the whole composition rather than distorting it), then each tile
 * is scaled by that same factor. Rects are integer pixels, clamped to the canvas.
 *
 * @param {{width:number,height:number}} dock  dock container size, CSS px
 * @param {Array<{x:number,y:number,width:number,height:number}>} tiles dock-local CSS px
 * @param {number} outW
 * @param {number} outH
 * @returns {Array<{x:number,y:number,width:number,height:number}>}
 */
export function computeTileRects(dock, tiles, outW, outH) {
    var fit = fitRect(dock.width, dock.height, outW, outH);
    var out = [];
    for (var i = 0; i < tiles.length; i++) {
        var t = tiles[i];
        var x = Math.round(fit.x + t.x * fit.scale);
        var y = Math.round(fit.y + t.y * fit.scale);
        var w = Math.round(t.width * fit.scale);
        var h = Math.round(t.height * fit.scale);
        if (x < 0) { w += x; x = 0; }
        if (y < 0) { h += y; y = 0; }
        if (x + w > outW) w = outW - x;
        if (y + h > outH) h = outH - y;
        out.push({ x: x, y: y, width: Math.max(2, w), height: Math.max(2, h) });
    }
    return out;
}

/**
 * Output canvas size for a given aspect ratio and resolution preset. Height
 * comes from the preset; width follows the aspect, clamped to MAX_OUT_DIM (in
 * which case the height is recomputed so the aspect still holds).
 */
export function outputSizeFor(aspect, presetKey) {
    var preset = RES_PRESETS[presetKey] || RES_PRESETS[DEFAULT_RES];
    if (!isFinite(aspect) || aspect <= 0) aspect = 16 / 9;
    var h = preset.h;
    var w = evenDim(h * aspect);
    if (w > MAX_OUT_DIM) {
        w = MAX_OUT_DIM;
        h = evenDim(w / aspect);
    }
    return { width: w, height: evenDim(h) };
}

/** The `res` value that means "use settings.outW x settings.outH verbatim". */
export const RES_CUSTOM = 'custom';

/** Coerce a hand-typed dimension into a legal, even encoder dimension. */
export function clampOutDim(n) {
    var v = Math.round(Number(n));
    if (!isFinite(v)) return 2;
    if (v < 2) v = 2;
    if (v > MAX_OUT_DIM) v = MAX_OUT_DIM;
    return evenDim(v);
}

/**
 * Output canvas size for the current settings. A preset derives the width from
 * `aspect` (so the composition fills the frame); `res: 'custom'` ignores the
 * aspect entirely and uses the user's own width x height — the composition is
 * then letterboxed into it by `computeTileRects`, which is exactly why the modal
 * shapes the dock to `customAspect()` so the preview shows no surprise bars.
 */
export function outputSizeFrom(settings, aspect) {
    if (settings && settings.res === RES_CUSTOM) {
        return { width: clampOutDim(settings.outW), height: clampOutDim(settings.outH) };
    }
    return outputSizeFor(aspect, settings ? settings.res : DEFAULT_RES);
}

/**
 * The aspect ratio the composition must be shaped to, or `null` when the output
 * follows the composition (any preset) and no shaping is needed.
 */
export function customAspect(settings) {
    if (!settings || settings.res !== RES_CUSTOM) return null;
    var s = outputSizeFrom(settings, 16 / 9);
    return s.height > 0 ? s.width / s.height : null;
}

/** H.264 codec string whose level covers W x H. */
export function h264CodecFor(W, H) {
    var px = W * H;
    if (px <= 1280 * 720) return 'avc1.42001F';       // level 3.1
    if (px <= 1920 * 1080) return 'avc1.420028';      // level 4.0
    if (px <= 2560 * 1440) return 'avc1.420032';      // level 5.0
    return 'avc1.420034';                              // level 5.2
}

/** Target H.264 bitrate (bits/sec) — must match the encoder config. */
export function bitrateFor(W, H, fps, quality) {
    var bpp = QUALITY_BPP[quality] != null ? QUALITY_BPP[quality] : QUALITY_BPP.medium;
    return Math.min(48000000, Math.max(1000000, Math.round(W * H * fps * bpp)));
}

/**
 * True when `bitrateFor`'s [1, 48] Mbps clamp actually bit — i.e. the requested
 * bits-per-pixel could not be honoured at this size and fps.
 *
 * The modal needs this because the clamp makes adjacent Quality tiers COLLIDE: at
 * 3840x2160 @ 60 fps `medium` and `high` are BOTH 48 Mbps, and at or below about
 * 640x360 @ 30 `low` and `medium` are BOTH 1 Mbps. In those configurations picking
 * a different tier changes neither the size estimate nor the encoded file — and
 * with nothing in the UI saying so, a correctly-wired picker just looks broken.
 */
export function bitrateIsClamped(W, H, fps, quality) {
    var bpp = QUALITY_BPP[quality] != null ? QUALITY_BPP[quality] : QUALITY_BPP.medium;
    return Math.round(W * H * fps * bpp) !== bitrateFor(W, H, fps, quality);
}

/**
 * Expected size of one output file, in bytes. This is the number the modal's
 * summary line shows, and the same number that decides whether the export needs
 * a streaming destination — the two must not drift apart.
 */
export function estimatedBytes(W, H, fps, quality, nFrames) {
    if (!(fps > 0) || !(nFrames > 0)) return 0;
    return bitrateFor(W, H, fps, quality) * (nFrames / fps) / 8;
}

/**
 * Above this much expected output, buffering the whole .mp4 in memory before
 * handing it to a download is a real risk rather than a theoretical one: it
 * lands in V8's pointer-compressed heap, which a Chrome renderer hard-caps near
 * 4 GB (see CLAUDE.md on luc3d #185/#190/#191/#193). Past it the export asks
 * for a real file and streams to disk instead. Below it, nothing is gained by
 * making the user pick a destination, so it just downloads as it always has.
 */
export const STREAM_TO_DISK_BYTES = 256 * 1024 * 1024;

/** True when `totalBytes` of expected output warrants streaming to disk. */
export function shouldStreamToDisk(totalBytes) {
    return totalBytes > STREAM_TO_DISK_BYTES;
}

// ============================================================================
// Settings
// ============================================================================

export function defaultOverlayExportSettings() {
    return {
        // `videoNames` burns each tile's CAMERA NAME into the frame. Default OFF,
        // like `legend`: it changes the exported pixels, and an export that
        // silently grew a caption would be a surprise. Listed FIRST because it is
        // the one layer that labels the composition rather than the animal.
        layers: {
            videoNames: false, user: true, predicted: true, reproj: true,
            errors: false, legend: false,
        },
        trailLength: 0,
        colorBy: 'track',
        background: 'video',
        user: {
            nodeStyle: 'circle', nodeSize: 4, lineWidth: 2, alpha: 1.0,
            labelSize: 0, labelAlpha: 0.9, lineStyle: 'solid',
            showNodes: true, showEdges: true,
        },
        pred: {
            nodeStyle: 'x', nodeSize: 4, lineWidth: 2, alpha: 0.85,
            lineStyle: 'solid', showNodes: true, showEdges: true,
        },
        reproj: {
            nodeStyle: 'circle', nodeSize: 4, lineWidth: 2, alpha: 0.9,
            brightness: 1.0, nodeColor: 'white', lineStyle: 'dotted',
            labelSize: 0, labelAlpha: 0.9, showNodes: true, showEdges: true,
        },
        res: DEFAULT_RES,
        outW: 1920,          // only consulted when res === RES_CUSTOM
        outH: 1080,
        fps: 30,
        quality: 'medium',
        mode: 'stitched',
    };
}

/**
 * Deep-merge `saved` over `base` IN PLACE, ignoring keys `base` doesn't declare
 * and values whose type doesn't match. A stored settings blob from an older
 * build (or a hand-edited one) can therefore never introduce an unknown key or
 * flip a number into a string — the export path reads these values straight
 * into canvas/encoder parameters.
 */
export function mergeSettings(base, saved) {
    if (!saved || typeof saved !== 'object') return base;
    for (var k in base) {
        if (!Object.prototype.hasOwnProperty.call(base, k)) continue;
        if (saved[k] == null) continue;
        if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
            mergeSettings(base[k], saved[k]);
        } else if (typeof saved[k] === typeof base[k]) {
            base[k] = saved[k];
        }
    }
    return base;
}

/**
 * Hold a persisted blob to the CURRENT option sets.
 *
 * `mergeSettings` only type-checks, so a `res` written by an older build (the
 * preset list has changed twice now: `360` became `480`, then `1440`/2K was
 * retired for `2160`) survives as a string nothing recognises. That splits the UI
 * in two — `outputSizeFor` falls back to the default height while the `<select>`,
 * having no matching `<option>`, goes blank — so the summary would quote a size
 * the visible control doesn't name. Fall back explicitly instead.
 *
 * Retired tiers fall back to `DEFAULT_RES` rather than to the nearest surviving
 * tier ON PURPOSE: promoting a stored `1440` to `2160` would silently ~2.25x the
 * pixel count, the bitrate and the file size of the next export the user runs.
 */
export function sanitizeSettings(s) {
    if (!s) return s;
    if (s.res !== RES_CUSTOM && !RES_PRESETS[s.res]) s.res = DEFAULT_RES;
    return s;
}

/** Merge the persisted blob (if any) over `base`. */
export function applyStoredSettings(base) {
    try {
        var raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) return sanitizeSettings(mergeSettings(base, JSON.parse(raw)));
    } catch (e) { /* corrupt / unavailable storage — keep the seeded defaults */ }
    return base;
}

export function saveOverlayExportSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
}

// ============================================================================
// Overlay draw options
// ============================================================================

/**
 * Translate the modal's settings into `drawFrameOverlays()` options.
 *
 * Sizes are VIDEO-RELATIVE. `drawSkeleton` treats `nodeSize`/`lineWidth`/
 * `labelSize` as raw canvas pixels, and in the live app the overlay canvas is
 * the video's own resolution — so "marker size 4" means 4 video pixels there.
 * Here the canvas is a composition tile whose size has nothing to do with the
 * video's, so the same 4 would render at a wildly different apparent size, and
 * would CHANGE with the resolution preset: a 480p export and a 2160p export of
 * the same layout would not look alike. Pre-multiplying by the fit scale pins
 * one meaning of "size 4" across the app, the preview and every output
 * resolution. (Sub-pixel results are fine — canvas strokes/arcs are not
 * quantised, and a `min` floor is applied so a small preview tile never erases
 * the overlay entirely.)
 *
 * All interaction state (selection / hover / drag / assignment) is explicitly
 * nulled: an export has no cursor, and a stray highlight would be burned in.
 * `showUnlinkedBadge: false` belongs to that same family — the "?" on an unlinked
 * instance is an editing prompt, and nobody watching an .mp4 can act on it.
 */
export function overlayOptionsFrom(settings, videoW, videoH, canvasW, canvasH) {
    var u = settings.user, p = settings.pred, r = settings.reproj;
    var gs = (videoW > 0 && videoH > 0) ? fitRect(videoW, videoH, canvasW, canvasH).scale : 1;
    // Scale, but never all the way to invisibility on a small preview tile.
    var sz = function (v) { return Math.max(0.75, v * gs); };
    var lw = function (v) { return Math.max(0.5, v * gs); };
    // A label size of 0 means "no labels" — it must NOT be floored into
    // existence, so scale it without a floor and let `showLabels` gate it.
    var lb = function (v) { return v > 0 ? Math.max(6, v * gs) : 0; };
    return {
        colorByIdentity: settings.colorBy === 'identity',
        trailLength: settings.trailLength || 0,
        showLegend: !!settings.layers.legend,
        // Read by `drawTileContent`, not by `drawFrameOverlays` — a burned-in camera
        // name is a caption on the TILE, drawn upright outside the view transform,
        // exactly like the legend.
        showViewName: !!settings.layers.videoNames,
        showUser: !!settings.layers.user,
        showPredicted: !!settings.layers.predicted,
        showReprojected: !!settings.layers.reproj,
        showErrors: !!settings.layers.errors,
        reprojNodeColor: r.nodeColor,
        userOpts: {
            nodeSize: sz(u.nodeSize), lineWidth: lw(u.lineWidth), alpha: u.alpha,
            labelSize: lb(u.labelSize), labelAlpha: u.labelAlpha,
            showLabels: u.labelSize > 0,
            preLineStyle: u.lineStyle, postLineStyle: u.lineStyle,
            nodeStyle: u.nodeStyle, showNodes: u.showNodes, showEdges: u.showEdges,
        },
        predictedOpts: {
            nodeSize: sz(p.nodeSize), lineWidth: lw(p.lineWidth), alpha: p.alpha,
            showLabels: false,
            preLineStyle: p.lineStyle, postLineStyle: p.lineStyle,
            nodeStyle: p.nodeStyle, showNodes: p.showNodes, showEdges: p.showEdges,
        },
        reprojOpts: {
            nodeSize: sz(r.nodeSize), lineWidth: lw(r.lineWidth), alpha: r.alpha,
            brightness: r.brightness, labelSize: lb(r.labelSize), labelAlpha: r.labelAlpha,
            showLabels: r.labelSize > 0, lineStyle: r.lineStyle,
            nodeStyle: r.nodeStyle, showNodes: r.showNodes, showEdges: r.showEdges,
        },
        videoWidth: videoW,
        videoHeight: videoH,
        canvasWidth: canvasW,
        canvasHeight: canvasH,
        selectedInstanceGroup: null,
        selectedReprojected: false,
        selectedNodeIdx: -1,
        hoveredNode: null,
        dragInfo: null,
        assignmentSelectedIds: [],
        assignmentMode: false,
        selectedUnlinkedId: null,
        editGroupTarget: null,
        // No "?" badges on unlinked instances. Their dashed edges and reduced
        // opacity still mark them as unlinked; only the editing prompt is dropped.
        showUnlinkedBadge: false,
    };
}

/**
 * The seed layout for the composition dock: mirror the main window — the video
 * views in a grid (same row-count heuristic as `addAllViewsAsGrid`), then the
 * 3D tile docked to the right of the whole grid.
 *
 * Returns a flat list of `{ viewName, position }` add-panel instructions where
 * `position` references earlier entries by their index in this same list
 * (`refIndex`), so the caller can substitute real dockview panel ids.
 *
 * @param {string[]} viewNames
 * @param {boolean} include3D
 */
export function seedLayoutPlan(viewNames, include3D) {
    var plan = [];
    var n = viewNames.length;
    if (n === 0) {
        if (include3D) plan.push({ viewName: TILE_3D, position: null });
        return plan;
    }
    // Row-count heuristic + reference scheme copied from `addAllViewsAsGrid`
    // (ui/sessions-panes.js). The reference scheme matters: dockview builds a
    // nested split tree, so a row whose cells all hang off the row's FIRST cell
    // produces a ragged staircase, not a grid. Each cell must reference the cell
    // directly ABOVE it (column-matched, clamped for a short last row).
    var rows = n <= 3 ? 1 : (n <= 8 ? 2 : 3);
    var cols = Math.ceil(n / rows);

    var grid = [];
    var idx = 0;
    for (var r = 0; r < rows && idx < n; r++) {
        grid[r] = [];
        var rowCount = (r === 0) ? cols : Math.ceil((n - cols) / (rows - 1));
        if (r === rows - 1) rowCount = n - idx;
        for (var c = 0; c < rowCount && idx < n; c++) grid[r].push(viewNames[idx++]);
    }

    var planIdx = [];   // planIdx[r][c] = index into `plan`
    for (var r2 = 0; r2 < grid.length; r2++) planIdx[r2] = [];

    for (var c1 = 0; c1 < grid[0].length; c1++) {
        plan.push({
            viewName: grid[0][c1],
            position: c1 === 0 ? null : { refIndex: planIdx[0][c1 - 1], direction: 'right' },
        });
        planIdx[0][c1] = plan.length - 1;
    }
    for (var r3 = 1; r3 < grid.length; r3++) {
        for (var c3 = 0; c3 < grid[r3].length; c3++) {
            var refCol = Math.min(c3, planIdx[r3 - 1].length - 1);
            plan.push({
                viewName: grid[r3][c3],
                position: { refIndex: planIdx[r3 - 1][refCol], direction: 'below' },
            });
            planIdx[r3][c3] = plan.length - 1;
        }
    }
    // No reference → dockview docks it against the ROOT, i.e. a full-height
    // column to the right of the whole grid.
    if (include3D) plan.push({ viewName: TILE_3D, position: { direction: 'right' } });
    return plan;
}

// ============================================================================
// Even-axis sash resizing
// ============================================================================

/**
 * How a sash drag's delta is shared out. See `distributeAxisSizes`.
 *
 * `'grow-one'` is the literal reading of "scale the remaining videos in the axis
 * evenly", and is the default. `'share-sides'` is the alternative that keeps the
 * sash under the cursor — swapping the constant in ui/overlay-export-modal.js is
 * the whole change.
 */
export var SASH_GROW_ONE = 'grow-one';
export var SASH_SHARE_SIDES = 'share-sides';

/**
 * Sizes for one dock AXIS after dragging the sash at index `k` by `d` px.
 *
 * dockview 6.6.1 hands a sash drag's WHOLE delta to the one tile on the other
 * side of the sash, and only spills to tiles beyond it when that neighbour hits a
 * limit (`Splitview.resize`, dockview-core 6.6.1 `dist/cjs/splitview/splitview.js`,
 * driven from the sash's own `pointermove`). With three or more tiles on an axis
 * the far tiles never move at all. This spreads the change instead.
 *
 * Two modes, because "evenly" has two defensible readings:
 *
 *   'grow-one'    the tile on the side you drag TOWARDS grows by the full delta
 *                 and EVERY other tile on the axis gives up delta/(n-1). This is
 *                 literally "the remaining videos scale evenly". Cost: tiles
 *                 BEFORE the sash shrink too, so the sash no longer sits under
 *                 the cursor — with 4 equal tiles, dragging sash 1 by 90 px moves
 *                 that sash only 60 px.
 *   'share-sides' the tiles at-or-before the sash share the gain and the tiles
 *                 after it share the loss. Also spreads the change across the
 *                 axis, and the sash tracks the cursor exactly.
 *
 * `base`/`min`/`max`/`vis` are per-view, in axis order. Invisible views never take
 * part. The result ALWAYS sums to `sum(base)` exactly, so the axis total — and
 * therefore every other axis in the dock, and the dock's own box — is untouched.
 *
 * @param {number[]} base   current sizes, px
 * @param {number[]} min    per-view minimum size
 * @param {number[]} max    per-view maximum size
 * @param {boolean[]} vis   per-view visibility
 * @param {number} k        sash index: the boundary between view k and k+1
 * @param {number} d        signed drag distance along the axis, px
 * @param {string} mode     SASH_GROW_ONE | SASH_SHARE_SIDES
 * @returns {number[]} new sizes
 */
export function distributeAxisSizes(base, min, max, vis, k, d, mode) {
    var out = base.slice();
    d = Math.round(d);
    if (!d || k < 0 || k >= base.length - 1) return out;

    var grow = [], shrink = [], i;
    if (mode === SASH_SHARE_SIDES) {
        for (i = 0; i < base.length; i++) {
            if (!vis[i]) continue;
            (i <= k ? grow : shrink).push(i);
        }
        if (d < 0) { var swap = grow; grow = shrink; shrink = swap; }
    } else {
        // The tile you are dragging towards is the one that grows.
        var lead = d > 0 ? k : k + 1;
        if (!vis[lead]) return out;
        grow.push(lead);
        for (i = 0; i < base.length; i++) if (vis[i] && i !== lead) shrink.push(i);
    }
    if (!grow.length || !shrink.length) return out;

    // Per-view capacity, then bound the whole move by what BOTH sides can absorb.
    // Note the caps are summed, not min'd: a single view sitting on its 100px
    // minimum must not veto the entire drag. Doing that made the sash feel dead in
    // a real dock, where a squeezed tile at the minimum is common — the drag now
    // proceeds and simply routes around it.
    var growCaps = [], shrinkCaps = [], growTotal = 0, shrinkTotal = 0;
    for (i = 0; i < grow.length; i++) {
        var hc = Math.max(0, max[grow[i]] - base[grow[i]]);
        growCaps.push(hc); growTotal += hc;
    }
    for (i = 0; i < shrink.length; i++) {
        var rc = Math.max(0, base[shrink[i]] - min[shrink[i]]);
        shrinkCaps.push(rc); shrinkTotal += rc;
    }
    var amount = Math.min(Math.abs(d), growTotal, shrinkTotal);
    if (!(amount > 0)) return out;

    var gives = fillEvenly(growCaps, amount);
    var takes = fillEvenly(shrinkCaps, amount);
    for (i = 0; i < grow.length; i++) out[grow[i]] += gives[i];
    for (i = 0; i < shrink.length; i++) out[shrink[i]] -= takes[i];
    return out;
}

/**
 * Split `amount` px as evenly as possible across slots whose individual capacities
 * are `caps`, giving every slot an equal share and re-spreading whatever a
 * capped-out slot cannot take across the ones that still have room.
 *
 * Integer, and the result sums to EXACTLY `min(amount, sum(caps))`. That exactness
 * matters twice over: a residue would be dumped on one arbitrary tile by dockview's
 * `distributeEmptySpace()` (so repeated drags would creep), and the caller relies on
 * the two sides of the drag matching so the axis total never moves.
 *
 * Even-share-with-spill rather than proportional-to-capacity on purpose: the point
 * of the feature is that tiles change by the SAME amount, so a big tile and a small
 * one give up the same pixels until the small one runs out.
 */
function fillEvenly(caps, amount) {
    var out = [], i;
    for (i = 0; i < caps.length; i++) out.push(0);
    var left = Math.min(amount, caps.reduce(function (a, b) { return a + b; }, 0));
    while (left > 0) {
        var active = [];
        for (i = 0; i < caps.length; i++) if (out[i] < caps[i]) active.push(i);
        if (!active.length) break;
        var share = Math.floor(left / active.length);
        if (share < 1) {
            // Fewer pixels left than slots: hand out the last few one at a time.
            for (i = 0; i < active.length && left > 0; i++) { out[active[i]]++; left--; }
            break;
        }
        for (i = 0; i < active.length; i++) {
            var give = Math.min(share, caps[active[i]] - out[active[i]]);
            out[active[i]] += give;
            left -= give;
        }
    }
    return out;
}
