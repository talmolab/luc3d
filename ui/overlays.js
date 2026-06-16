/**
 * Overlay rendering for multi-view pose proofreading
 * Combines skeleton rendering (from slp-viewer) with reprojection visualization (from calibration-studio)
 *
 * Draws pose overlays on transparent canvas elements that sit on top of video canvases.
 * All functions are globals (no imports/exports).
 */

// SLEAP default "alphabet" palette — 26 visually distinct colors (Green-Armytage)
// Red entries removed: red is reserved exclusively for ReprojectedInstances.
export const TRACK_COLORS = [
    '#ff6b6b',  // red
    '#4ecdc4',  // teal
    '#ffe66d',  // yellow
    '#a78bfa',  // purple
    '#2bce48',  // green
    '#ff9f43',  // orange
    '#5ef1f2',  // cyan
    '#ff6eb4',  // hot pink
    '#69db7c',  // lime
    '#ffa405',  // amber
    '#74b9ff',  // sky blue
    '#f0a3ff',  // lavender
    '#ffd93d',  // gold
    '#6bcb77',  // emerald
    '#ff8a5c',  // salmon
    '#a8e6cf',  // mint
    '#dda0dd',  // plum
    '#87ceeb',  // light blue
    '#ffb347',  // tangerine
    '#98fb98',  // pale green
];

// Fixed color for all ReprojectedInstances
export const REPROJECTION_COLOR = '#e53e3e';

// Fixed color for ungrouped UserInstances
export const UNGROUPED_USER_COLOR = '#F8B195';

// Space gray for instances the tracker explicitly marked as having no identity
// (the -1 sentinel). Only applied when coloring by identity — see
// Session.isExplicitNoIdentity.
export const NULL_ID_COLOR = '#a7adba';

export function getTrackColor(trackIdx) {
    return TRACK_COLORS[trackIdx % TRACK_COLORS.length];
}

/**
 * Adjust the brightness (V in HSV) of a hex color.
 * @param {string} hex - e.g. '#ff8800'
 * @param {number} factor - 0..1, where 1 = original brightness
 * @returns {string} adjusted hex color
 */
export function adjustColorBrightness(hex, factor) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    r = Math.round(Math.min(255, r * factor));
    g = Math.round(Math.min(255, g * factor));
    b = Math.round(Math.min(255, b * factor));
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

export function getGroupColor(group, session, useIdentity, frameIdx, cameraName) {
    // --- Identity-color path (only when coloring by identity) ------------
    // A group may have been explicitly assigned an Identity via
    // assignIdentityToGroup — that's the strongest signal. Otherwise fall
    // back to the per-track identity lookup keyed by the instance's live
    // `trackIdx` so the color reflects what's actually drawn on this view.
    if (useIdentity && session) {
        if (group.identityId != null && group.identityId >= 0 && session.getIdentity) {
            var gIdentity = session.getIdentity(group.identityId);
            if (gIdentity && gIdentity.color) return gIdentity.color;
        }
        if (session.getIdentityForTrack) {
            var probeIdx = null;
            if (cameraName && group.instances.has(cameraName)) {
                var pInst = group.instances.get(cameraName);
                if (pInst && pInst.trackIdx != null) probeIdx = pInst.trackIdx;
            }
            if (probeIdx == null) {
                for (var [, pI] of group.instances) {
                    if (pI && pI.trackIdx != null) { probeIdx = pI.trackIdx; break; }
                }
            }
            if (probeIdx != null) {
                // Explicit "no identity" (-1) → space gray, not a track color.
                if (session.isExplicitNoIdentity &&
                    session.isExplicitNoIdentity(cameraName, probeIdx, frameIdx)) {
                    return NULL_ID_COLOR;
                }
                var tIdentity = session.getIdentityForTrack(probeIdx, cameraName, frameIdx);
                if (tIdentity && tIdentity.color) return tIdentity.color;
            }
        }
    }

    // --- Track-color path ------------------------------------------------
    // Source of truth is the per-instance `trackIdx` on the current view.
    // `group.identityId` is only updated at the frame where the dropdown
    // fires, so consulting it here would show stale colors for any group
    // whose past-frame instances still carry the old trackIdx.
    var effectiveTrackIdx = null;
    if (cameraName && group.instances.has(cameraName)) {
        var camInst = group.instances.get(cameraName);
        if (camInst && camInst.trackIdx != null) effectiveTrackIdx = camInst.trackIdx;
    }
    if (effectiveTrackIdx == null) {
        for (var [, inst] of group.instances) {
            if (inst && inst.trackIdx != null) { effectiveTrackIdx = inst.trackIdx; break; }
        }
    }
    if (effectiveTrackIdx == null) {
        effectiveTrackIdx = group.identityId != null && group.identityId >= 0 ? group.identityId : 0;
    }
    return getTrackColor(effectiveTrackIdx);
}

/**
 * Get color for an instance using the track→identity map.
 * Used for unlinked/ungrouped predictions. Trackless instances
 * (trackIdx == null, e.g., reprojections imported as UserInstance with
 * track=null from SLEAP 2D exports) render with UNGROUPED_USER_COLOR so
 * they're visually distinct from track-0 instances.
 */
export function getInstanceColor(instance, session, cameraName, useIdentity, frameIdx) {
    if (useIdentity && session && instance.trackIdx != null) {
        // Explicit "no identity" (-1) → space gray, not a track color.
        if (session.isExplicitNoIdentity &&
            session.isExplicitNoIdentity(cameraName, instance.trackIdx, frameIdx)) {
            return NULL_ID_COLOR;
        }
        var identity = session.getIdentityForTrack(instance.trackIdx, cameraName, frameIdx);
        if (identity && identity.color) return identity.color;
    }
    if (instance.trackIdx == null) return UNGROUPED_USER_COLOR;
    return getTrackColor(instance.trackIdx);
}

export function getLineDashPattern(style) {
    if (style === 'dotted') return [2, 3];
    if (style === 'dashed') return [6, 4];
    return []; // solid
}

// ============================================
// Coordinate transforms
// ============================================

/**
 * Convert video pixel coordinates to canvas coordinates.
 * Handles aspect-ratio-preserving fit (letterboxing / pillarboxing).
 *
 * @param {number} x - X in video pixels
 * @param {number} y - Y in video pixels
 * @param {number} videoWidth - Original video width
 * @param {number} videoHeight - Original video height
 * @param {number} canvasWidth - Overlay canvas width
 * @param {number} canvasHeight - Overlay canvas height
 * @returns {{ x: number, y: number, scale: number }}
 */
export function videoToCanvas(x, y, videoWidth, videoHeight, canvasWidth, canvasHeight) {
    const scaleX = canvasWidth / videoWidth;
    const scaleY = canvasHeight / videoHeight;
    const scale = Math.min(scaleX, scaleY);
    const offsetX = (canvasWidth - videoWidth * scale) / 2;
    const offsetY = (canvasHeight - videoHeight * scale) / 2;

    return {
        x: x * scale + offsetX,
        y: y * scale + offsetY,
        scale: scale,
    };
}

/**
 * Convenience: compute only the scale + offset once for a given
 * video/canvas size pair.  Returns a transform function that maps
 * (vx, vy) -> { x, y }.
 */
export function makeVideoToCanvasTransform(videoWidth, videoHeight, canvasWidth, canvasHeight) {
    const scaleX = canvasWidth / videoWidth;
    const scaleY = canvasHeight / videoHeight;
    const scale = Math.min(scaleX, scaleY);
    const offsetX = (canvasWidth - videoWidth * scale) / 2;
    const offsetY = (canvasHeight - videoHeight * scale) / 2;

    function transform(vx, vy) {
        return {
            x: vx * scale + offsetX,
            y: vy * scale + offsetY,
        };
    }
    transform.scale = scale;
    return transform;
}

// ============================================
// Color helpers
// ============================================

/**
 * Return a CSS color string for a reprojection error magnitude.
 *   < 2 px  -> green
 *   2-5 px  -> yellow
 *   > 5 px  -> red
 */
export function errorColor(errorPx) {
    if (errorPx < 2) return '#4ade80';  // green
    if (errorPx <= 5) return '#fbbf24'; // yellow
    return '#ef4444';                    // red
}

/**
 * Parse a hex color into { r, g, b } integers.
 */
export function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return {
        r: parseInt(h.substring(0, 2), 16),
        g: parseInt(h.substring(2, 4), 16),
        b: parseInt(h.substring(4, 6), 16),
    };
}

/** Lighten a hex color by a factor (0-1). factor=0.4 means 40% closer to white. */
export function brightenColor(hex, factor) {
    const rgb = hexToRgb(hex);
    const r = Math.min(255, Math.round(rgb.r + (255 - rgb.r) * factor));
    const g = Math.min(255, Math.round(rgb.g + (255 - rgb.g) * factor));
    const b = Math.min(255, Math.round(rgb.b + (255 - rgb.b) * factor));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/** Desaturate a hex color by blending toward mid-gray. amount=0.5 means 50% gray. */
export function desaturateColor(hex, amount) {
    const rgb = hexToRgb(hex);
    const gray = 128;
    const r = Math.round(rgb.r + (gray - rgb.r) * amount);
    const g = Math.round(rgb.g + (gray - rgb.g) * amount);
    const b = Math.round(rgb.b + (gray - rgb.b) * amount);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/**
 * Compute a complementary (opposite hue) color for visual contrast.
 * Shifts hue by 180 degrees in HSL space.
 * @param {string} hex - Hex color string
 * @returns {string} Complementary hex color
 */
export function complementaryColor(hex) {
    var rgb = hexToRgb(hex);
    var r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, l = (max + min) / 2;
    if (max === min) {
        h = 0; s = 0;
    } else {
        var d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
    }
    // Shift hue by 180 degrees, boost saturation
    h = (h + 0.5) % 1.0;
    s = Math.min(1.0, s * 1.2 + 0.2);
    // HSL to RGB
    function hue2rgb(p, q, t) {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
    }
    var rr, gg, bb;
    if (s === 0) { rr = gg = bb = l; }
    else {
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        var p = 2 * l - q;
        rr = hue2rgb(p, q, h + 1/3);
        gg = hue2rgb(p, q, h);
        bb = hue2rgb(p, q, h - 1/3);
    }
    var ri = Math.round(rr * 255), gi = Math.round(gg * 255), bi = Math.round(bb * 255);
    return '#' + ((1 << 24) + (ri << 16) + (gi << 8) + bi).toString(16).slice(1);
}

// ============================================
// SLEAP-style label placement
// ============================================

/**
 * Compute label offset for a node using SLEAP-style placement.
 * Finds the largest arc gap between connected edges and places the label
 * at the bisector angle of that gap.
 *
 * @param {number} nodeIdx - Index of the node
 * @param {Array} canvasPoints - Array of {x, y} or null for each node
 * @param {Object} skeleton - Skeleton with .edges
 * @param {string} labelText - The label text (for measuring width)
 * @param {number} fontSize - Font size in canvas pixels
 * @param {CanvasRenderingContext2D} ctx - Canvas context (for text measurement)
 * @returns {{dx: number, dy: number}} Offset from node position
 */
export function computeLabelOffset(nodeIdx, canvasPoints, skeleton, labelText, fontSize, ctx) {
    var cp = canvasPoints[nodeIdx];
    if (!cp) return { dx: fontSize * 0.3, dy: -fontSize * 0.3 };

    // Measure label dimensions
    var labelWidth = ctx.measureText(labelText).width;
    var labelHeight = fontSize;

    // Collect angles to neighboring nodes
    var angles = [];
    if (skeleton && skeleton.edges) {
        for (var e = 0; e < skeleton.edges.length; e++) {
            var edge = skeleton.edges[e];
            var neighborIdx = -1;
            if (edge[0] === nodeIdx) neighborIdx = edge[1];
            else if (edge[1] === nodeIdx) neighborIdx = edge[0];
            if (neighborIdx < 0) continue;
            var np = canvasPoints[neighborIdx];
            if (!np) continue;
            angles.push(Math.atan2(np.y - cp.y, np.x - cp.x));
        }
    }

    // Default: place to the upper-right if no neighbors
    if (angles.length === 0) {
        // SLEAP default: shift_angle=0 → shift_factor_x = 0.6-0.5=0.1, shift_factor_y = 0-0.5=-0.5
        return { dx: labelWidth * 0.1, dy: labelHeight * -0.5 };
    }

    // Sort angles and find the largest arc gap (SLEAP algorithm)
    angles.sort(function (a, b) { return a - b; });

    // Append first angle + 2π for wrap-around
    angles.push(angles[0] + Math.PI * 2);

    var bestGapSize = 0;
    var bestBisector = 0;
    for (var i = 0; i < angles.length - 1; i++) {
        var gapSize = angles[i + 1] - angles[i];
        var bisector = (angles[i + 1] + angles[i]) / 2;
        if (gapSize > bestGapSize) {
            bestGapSize = gapSize;
            bestBisector = bisector;
        }
    }

    // Normalize bisector to [0, 2π)
    bestBisector = bestBisector % (2 * Math.PI);

    // SLEAP shift factors: (cos(angle) * 0.6) - 0.5
    var shiftX = (Math.cos(bestBisector) * 0.6) - 0.5;
    var shiftY = (Math.sin(bestBisector) * 0.6) - 0.5;

    return { dx: labelWidth * shiftX, dy: labelHeight * shiftY };
}

// ============================================
// Skeleton rendering
// ============================================

/**
 * Draw a single skeleton (edges + nodes) for one instance.
 *
 * @param {CanvasRenderingContext2D} ctx - Overlay canvas context
 * @param {Object} instance - Instance with .points (array of [x,y] or null) and .trackIdx
 * @param {Object} skeleton - Skeleton with .nodes (array of { name }) and .edges (array of [srcIdx, dstIdx])
 * @param {Object} [options]
 * @param {string}  [options.color]        - Override color (default: track color)
 * @param {number}  [options.nodeSize]     - Radius in video pixels (default: 4)
 * @param {number}  [options.lineWidth]    - Edge width in video pixels (default: 2)
 * @param {number}  [options.alpha]        - Global alpha (default: 1.0)
 * @param {number}  [options.videoWidth]
 * @param {number}  [options.videoHeight]
 * @param {number}  [options.canvasWidth]
 * @param {number}  [options.canvasHeight]
 * @param {boolean} [options.showLabels]   - Draw node name labels (default: false)
 */
export function drawSkeleton(ctx, instance, skeleton, options) {
    options = options || {};
    const points = instance.points;
    if (!points || points.length === 0) return;

    const color = options.color || (instance.trackIdx != null ? getTrackColor(instance.trackIdx) : UNGROUPED_USER_COLOR);
    const edgeColor = options.edgeColor || color;
    const baseNodeSize = options.nodeSize != null ? options.nodeSize : 4;
    const baseLabelSize = options.labelSize != null ? options.labelSize : 11;
    const baseLineWidth = options.lineWidth != null ? options.lineWidth : 2;
    const alpha = options.alpha != null ? options.alpha : 1.0;
    const labelAlpha = options.labelAlpha != null ? options.labelAlpha : 1.0;
    const showLabels = !!options.showLabels;
    const lineStyle = options.lineStyle || (options.dashed ? 'dashed' : 'solid');
    const dashPattern = getLineDashPattern(lineStyle);

    const vw = options.videoWidth;
    const vh = options.videoHeight;
    const cw = options.canvasWidth != null ? options.canvasWidth : ctx.canvas.width;
    const ch = options.canvasHeight != null ? options.canvasHeight : ctx.canvas.height;

    const needsTransform = vw != null && vh != null;
    const toCanvas = needsTransform
        ? makeVideoToCanvasTransform(vw, vh, cw, ch)
        : null;
    const scale = toCanvas ? toCanvas.scale : 1;

    // Screen-relative label sizing: scale baseLabelSize so labels appear the
    // same visual size regardless of canvas backing resolution.
    const displayScale = cw / (ctx.canvas.getBoundingClientRect().width || cw);
    const adjustedLabelSize = Math.round(baseLabelSize * displayScale);

    const nodeShape = options.nodeShape || 'circle';
    const nodeSize = baseNodeSize;
    const lineWidth = baseLineWidth;
    const nulledNodes = instance.nulledNodes || null;

    // Pre-compute canvas positions for each point
    const canvasPoints = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        if (pt == null) {
            canvasPoints[i] = null;
            continue;
        }
        if (toCanvas) {
            canvasPoints[i] = toCanvas(pt[0], pt[1]);
        } else {
            canvasPoints[i] = { x: pt[0], y: pt[1] };
        }
    }

    ctx.save();
    ctx.globalAlpha = alpha;

    // Check for occluded array on the instance
    const occluded = instance.occluded || [];

    // --- 1. Draw edges ---
    if (skeleton.edges) {
        ctx.lineCap = 'round';
        if (dashPattern.length) ctx.setLineDash(dashPattern);
        // Draw normal edges first, then grayed edges
        for (var pass = 0; pass < 2; pass++) {
            ctx.lineWidth = lineWidth;
            ctx.beginPath();
            var hasStrokes = false;
            for (let i = 0; i < skeleton.edges.length; i++) {
                const edge = skeleton.edges[i];
                const srcIdx = edge[0];
                const dstIdx = edge[1];
                const src = canvasPoints[srcIdx];
                const dst = canvasPoints[dstIdx];
                if (!src || !dst) continue;
                var srcNulled = nulledNodes && nulledNodes.has(srcIdx);
                var dstNulled = nulledNodes && nulledNodes.has(dstIdx);
                var edgeGray = srcNulled || dstNulled;
                if (pass === 0 && !edgeGray) {
                    ctx.moveTo(src.x, src.y);
                    ctx.lineTo(dst.x, dst.y);
                    hasStrokes = true;
                } else if (pass === 1 && edgeGray) {
                    ctx.moveTo(src.x, src.y);
                    ctx.lineTo(dst.x, dst.y);
                    hasStrokes = true;
                }
            }
            if (hasStrokes) {
                if (pass === 0) {
                    ctx.strokeStyle = edgeColor;
                } else {
                    ctx.strokeStyle = '#888888';
                    ctx.globalAlpha = alpha * 0.4;
                }
                ctx.stroke();
                if (pass === 1) ctx.globalAlpha = alpha;
            }
        }
        if (dashPattern.length) ctx.setLineDash([]);
    }

    // --- 2. Draw nodes ---
    // Normal nodes
    ctx.fillStyle = color;
    for (let i = 0; i < canvasPoints.length; i++) {
        const cp = canvasPoints[i];
        if (!cp) continue;
        if (nulledNodes && nulledNodes.has(i)) continue;
        if (nodeShape === 'x') {
            var xr = nodeSize * 0.9;
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(2, nodeSize * 0.35);
            ctx.beginPath();
            ctx.moveTo(cp.x - xr, cp.y - xr); ctx.lineTo(cp.x + xr, cp.y + xr);
            ctx.moveTo(cp.x + xr, cp.y - xr); ctx.lineTo(cp.x - xr, cp.y + xr);
            ctx.stroke();
        } else {
            ctx.beginPath();
            ctx.arc(cp.x, cp.y, nodeSize, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    // Grayed-out (nulled) nodes
    if (nulledNodes && nulledNodes.size > 0) {
        ctx.fillStyle = '#aaaaaa';
        ctx.globalAlpha = alpha * 0.55;
        for (const ni of nulledNodes) {
            const cp = canvasPoints[ni];
            if (!cp) continue;
            if (nodeShape === 'x') {
                var xr = nodeSize * 0.9;
                ctx.strokeStyle = '#888888';
                ctx.lineWidth = Math.max(2, nodeSize * 0.35);
                ctx.beginPath();
                ctx.moveTo(cp.x - xr, cp.y - xr); ctx.lineTo(cp.x + xr, cp.y + xr);
                ctx.moveTo(cp.x + xr, cp.y - xr); ctx.lineTo(cp.x - xr, cp.y + xr);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.arc(cp.x, cp.y, nodeSize, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.globalAlpha = alpha;
    }

    // --- 3. Optional labels (SLEAP-style with dark outline) ---
    if (showLabels) {
        var savedAlpha = ctx.globalAlpha;
        ctx.globalAlpha = labelAlpha;
        // Use independent label size (scaled to canvas coordinates)
        var fontSize = adjustedLabelSize;
        if (fontSize <= 0) { ctx.globalAlpha = savedAlpha; ctx.restore(); return; }
        ctx.lineWidth = Math.max(1, Math.round(fontSize * 0.15));
        ctx.font = 'bold ' + fontSize + 'px sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';
        for (var li = 0; li < canvasPoints.length; li++) {
            var lp = canvasPoints[li];
            if (!lp) continue;
            var isNulled = nulledNodes && nulledNodes.has(li);
            var node = skeleton.nodes ? skeleton.nodes[li] : undefined;
            var name = typeof node === 'string' ? node : (node && node.name ? node.name : 'node_' + li);
            var labelOff = computeLabelOffset(li, canvasPoints, skeleton, name, fontSize, ctx);
            var tx = lp.x + labelOff.dx;
            var ty = lp.y + labelOff.dy;
            if (isNulled) {
                ctx.globalAlpha = 0.4 * labelAlpha;
                ctx.fillStyle = '#888888';
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
            } else {
                ctx.globalAlpha = labelAlpha;
                ctx.fillStyle = '#ffffff';
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
            }
            ctx.strokeText(name, tx, ty);
            ctx.fillText(name, tx, ty);
        }
        ctx.globalAlpha = savedAlpha;
    }

    ctx.restore();
}

/**
 * Draw a reprojected skeleton with a visually distinct style:
 *   - Dashed edges
 *   - X markers instead of filled circles
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} reprojectedPoints - Array of [x,y] or null
 * @param {Object} skeleton - Skeleton with .nodes and .edges
 * @param {Object} [options] - Same shape as drawSkeleton options
 */
export function drawReprojectedSkeleton(ctx, reprojectedPoints, skeleton, options) {
    options = options || {};
    if (!reprojectedPoints || reprojectedPoints.length === 0) return;

    // `color` is the X-marker (node) color — defaults to the designated
    // reprojection node color the caller picks. `edgeColor` is the line
    // color connecting the X marks; it defaults to `color` for
    // backwards-compatible callers but should be set to the track color
    // so reprojections stay visually distinct from user nodes.
    const color = options.color || '#ff6b6b';
    const edgeColor = options.edgeColor || color;
    const baseNodeSize = options.nodeSize != null ? options.nodeSize : 4;
    const baseLineWidth = options.lineWidth != null ? options.lineWidth : 2;
    const alpha = options.alpha != null ? options.alpha : 0.85;

    const vw = options.videoWidth;
    const vh = options.videoHeight;
    const cw = options.canvasWidth != null ? options.canvasWidth : ctx.canvas.width;
    const ch = options.canvasHeight != null ? options.canvasHeight : ctx.canvas.height;

    const needsTransform = vw != null && vh != null;
    const toCanvas = needsTransform
        ? makeVideoToCanvasTransform(vw, vh, cw, ch)
        : null;
    const scale = toCanvas ? toCanvas.scale : 1;

    const markerSize = baseNodeSize;  // half-extent of the X
    const lineWidth = baseLineWidth;

    // Pre-compute canvas positions
    const canvasPoints = new Array(reprojectedPoints.length);
    for (let i = 0; i < reprojectedPoints.length; i++) {
        const pt = reprojectedPoints[i];
        if (pt == null) {
            canvasPoints[i] = null;
            continue;
        }
        if (toCanvas) {
            canvasPoints[i] = toCanvas(pt[0], pt[1]);
        } else {
            canvasPoints[i] = { x: pt[0], y: pt[1] };
        }
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';

    // --- 1. Draw edges as dashed lines (track-colored) ---
    if (skeleton.edges) {
        ctx.strokeStyle = edgeColor;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        for (let i = 0; i < skeleton.edges.length; i++) {
            const edge = skeleton.edges[i];
            const src = canvasPoints[edge[0]];
            const dst = canvasPoints[edge[1]];
            if (src && dst) {
                ctx.moveTo(src.x, src.y);
                ctx.lineTo(dst.x, dst.y);
            }
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // --- 2. Draw X markers (designated reprojection color) ---
    ctx.strokeStyle = color;
    const arm = markerSize;  // length from center to tip of each arm
    for (let i = 0; i < canvasPoints.length; i++) {
        const cp = canvasPoints[i];
        if (!cp) continue;
        ctx.beginPath();
        // First stroke of X: top-left to bottom-right
        ctx.moveTo(cp.x - arm, cp.y - arm);
        ctx.lineTo(cp.x + arm, cp.y + arm);
        // Second stroke of X: top-right to bottom-left
        ctx.moveTo(cp.x + arm, cp.y - arm);
        ctx.lineTo(cp.x - arm, cp.y + arm);
        ctx.stroke();
    }

    ctx.restore();
}

/**
 * Draw error vectors from observed (detected) to reprojected points.
 * Line color encodes error magnitude (green < 2px, yellow 2-5px, red > 5px).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} observedPoints  - Array of [x,y] or null (video coords)
 * @param {Array} reprojectedPoints - Array of [x,y] or null (video coords)
 * @param {Object} [options]
 */
export function drawReprojectionErrors(ctx, observedPoints, reprojectedPoints, options) {
    options = options || {};
    if (!observedPoints || !reprojectedPoints) return;

    const vw = options.videoWidth;
    const vh = options.videoHeight;
    const cw = options.canvasWidth != null ? options.canvasWidth : ctx.canvas.width;
    const ch = options.canvasHeight != null ? options.canvasHeight : ctx.canvas.height;

    const needsTransform = vw != null && vh != null;
    const toCanvas = needsTransform
        ? makeVideoToCanvasTransform(vw, vh, cw, ch)
        : null;
    const scale = toCanvas ? toCanvas.scale : 1;

    const lineWidth = Math.max(1, 1 * scale);

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';

    const len = Math.min(observedPoints.length, reprojectedPoints.length);
    for (let i = 0; i < len; i++) {
        const obs = observedPoints[i];
        const rep = reprojectedPoints[i];
        if (obs == null || rep == null) continue;

        // Compute error in video-pixel space
        const dx = rep[0] - obs[0];
        const dy = rep[1] - obs[1];
        const errPx = Math.sqrt(dx * dx + dy * dy);

        // Transform to canvas coordinates
        let co, cr;
        if (toCanvas) {
            co = toCanvas(obs[0], obs[1]);
            cr = toCanvas(rep[0], rep[1]);
        } else {
            co = { x: obs[0], y: obs[1] };
            cr = { x: rep[0], y: rep[1] };
        }

        ctx.strokeStyle = errorColor(errPx);
        ctx.beginPath();
        ctx.moveTo(co.x, co.y);
        ctx.lineTo(cr.x, cr.y);
        ctx.stroke();
    }

    ctx.restore();
}

// ============================================
// Selection, hover, drag, and label rendering
// ============================================

/**
 * Draw a bright, thicker highlight of the selected instance's skeleton.
 * Adds glow behind nodes, a dashed bounding box, and an optional bright
 * ring around the specifically selected node.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {(number[]|null)[]} points - Instance points in video coords
 * @param {Object} skeleton - Skeleton with .nodes and .edges
 * @param {Object} [options]
 * @param {string}  [options.color]          - Track color for glow tinting
 * @param {number}  [options.selectedNodeIdx] - Index of specifically selected node, or -1
 * @param {number}  [options.nodeSize]       - Base node radius (video px, default 4)
 * @param {number}  [options.lineWidth]      - Base line width (video px, default 2)
 * @param {number}  [options.videoWidth]
 * @param {number}  [options.videoHeight]
 * @param {number}  [options.canvasWidth]
 * @param {number}  [options.canvasHeight]
 */
export function drawSelectionHighlight(ctx, points, skeleton, options) {
    options = options || {};
    if (!points || points.length === 0) return;

    const color = options.color || '#667eea';
    const selectedNodeIdx = options.selectedNodeIdx != null ? options.selectedNodeIdx : -1;
    const baseNodeSize = options.nodeSize != null ? options.nodeSize : 4;
    const baseLineWidth = options.lineWidth != null ? options.lineWidth : 2;

    const vw = options.videoWidth;
    const vh = options.videoHeight;
    const cw = options.canvasWidth != null ? options.canvasWidth : ctx.canvas.width;
    const ch = options.canvasHeight != null ? options.canvasHeight : ctx.canvas.height;

    const needsTransform = vw != null && vh != null;
    const toCanvas = needsTransform
        ? makeVideoToCanvasTransform(vw, vh, cw, ch)
        : null;
    const scale = toCanvas ? toCanvas.scale : 1;

    const nodeSize = baseNodeSize;
    const lineWidth = baseLineWidth;

    // Pre-compute canvas positions
    const canvasPoints = new Array(points.length);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        if (pt == null) { canvasPoints[i] = null; continue; }
        if (toCanvas) {
            canvasPoints[i] = toCanvas(pt[0], pt[1]);
        } else {
            canvasPoints[i] = { x: pt[0], y: pt[1] };
        }
        const cp = canvasPoints[i];
        if (cp.x < minX) minX = cp.x;
        if (cp.y < minY) minY = cp.y;
        if (cp.x > maxX) maxX = cp.x;
        if (cp.y > maxY) maxY = cp.y;
    }

    ctx.save();

    const nulledNodes = options.nulledNodes || null;

    // --- 1. Glow circles behind nodes ---
    const rgb = hexToRgb(color);
    const glowRadius = nodeSize * 1.4;
    ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.25)';
    for (let i = 0; i < canvasPoints.length; i++) {
        const cp = canvasPoints[i];
        if (!cp) continue;
        if (nulledNodes && nulledNodes.has(i)) continue;
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, glowRadius, 0, Math.PI * 2);
        ctx.fill();
    }

    // --- 2. Thicker, brighter edges ---
    if (skeleton.edges) {
        ctx.lineWidth = lineWidth * 2;
        ctx.lineCap = 'round';
        // Two-pass: normal edges, then grayed (nulled) edges
        for (var ePass = 0; ePass < 2; ePass++) {
            ctx.beginPath();
            var hasEdgeStrokes = false;
            for (let i = 0; i < skeleton.edges.length; i++) {
                const edge = skeleton.edges[i];
                const src = canvasPoints[edge[0]];
                const dst = canvasPoints[edge[1]];
                if (!src || !dst) continue;
                var srcNulled = nulledNodes && nulledNodes.has(edge[0]);
                var dstNulled = nulledNodes && nulledNodes.has(edge[1]);
                var edgeGray = srcNulled || dstNulled;
                if (ePass === 0 && !edgeGray) {
                    ctx.moveTo(src.x, src.y);
                    ctx.lineTo(dst.x, dst.y);
                    hasEdgeStrokes = true;
                } else if (ePass === 1 && edgeGray) {
                    ctx.moveTo(src.x, src.y);
                    ctx.lineTo(dst.x, dst.y);
                    hasEdgeStrokes = true;
                }
            }
            if (hasEdgeStrokes) {
                if (ePass === 0) {
                    ctx.strokeStyle = '#ffffff';
                    ctx.globalAlpha = 0.8;
                } else {
                    ctx.strokeStyle = '#888888';
                    ctx.globalAlpha = 0.8 * 0.4;
                }
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1.0;
    }

    // --- 3. Brighter nodes ---
    // Normal (non-nulled) nodes
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < canvasPoints.length; i++) {
        const cp = canvasPoints[i];
        if (!cp) continue;
        if (nulledNodes && nulledNodes.has(i)) continue;
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, nodeSize * 1.1, 0, Math.PI * 2);
        ctx.fill();
    }
    // Grayed-out (nulled) nodes
    if (nulledNodes && nulledNodes.size > 0) {
        ctx.fillStyle = '#aaaaaa';
        ctx.globalAlpha = 0.55;
        for (const ni of nulledNodes) {
            const cp = canvasPoints[ni];
            if (!cp) continue;
            ctx.beginPath();
            ctx.arc(cp.x, cp.y, nodeSize * 1.1, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1.0;
    }

    // --- 4. Dashed bounding box ---
    if (minX < Infinity) {
        const pad = nodeSize * 3;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 1 * scale;
        ctx.setLineDash([4 * scale, 4 * scale]);
        ctx.strokeRect(minX - pad, minY - pad, (maxX - minX) + 2 * pad, (maxY - minY) + 2 * pad);
        ctx.setLineDash([]);
    }

    // --- 5. Bright ring on specifically selected node ---
    if (selectedNodeIdx >= 0 && selectedNodeIdx < canvasPoints.length && canvasPoints[selectedNodeIdx]) {
        const cp = canvasPoints[selectedNodeIdx];
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, nodeSize * 2, 0, Math.PI * 2);
        ctx.stroke();
        // Inner colored ring
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * scale;
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, nodeSize * 2.5, 0, Math.PI * 2);
        ctx.stroke();
    }

    ctx.restore();
}

/**
 * Draw a hover highlight around a single node.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} point - [u, v] in video coords
 * @param {number} nodeIdx - Index of the hovered node
 * @param {Object} [options]
 * @param {string}  [options.color]       - Track color
 * @param {number}  [options.nodeSize]    - Base node radius (video px, default 4)
 * @param {number}  [options.videoWidth]
 * @param {number}  [options.videoHeight]
 * @param {number}  [options.canvasWidth]
 * @param {number}  [options.canvasHeight]
 * @returns {string} Suggested CSS cursor type ('grab')
 */
export function drawHoverHighlight(ctx, point, nodeIdx, options) {
    options = options || {};
    if (!point) return 'default';

    const color = options.color || '#667eea';
    const baseNodeSize = options.nodeSize != null ? options.nodeSize : 4;

    const vw = options.videoWidth;
    const vh = options.videoHeight;
    const cw = options.canvasWidth != null ? options.canvasWidth : ctx.canvas.width;
    const ch = options.canvasHeight != null ? options.canvasHeight : ctx.canvas.height;

    const needsTransform = vw != null && vh != null;
    const toCanvas = needsTransform
        ? makeVideoToCanvasTransform(vw, vh, cw, ch)
        : null;
    const scale = toCanvas ? toCanvas.scale : 1;

    const nodeSize = baseNodeSize * scale;

    let cp;
    if (toCanvas) {
        cp = toCanvas(point[0], point[1]);
    } else {
        cp = { x: point[0], y: point[1] };
    }

    ctx.save();

    // Semi-transparent glow circle (radius increased by 50%, alpha 0.3)
    const rgb = hexToRgb(color);
    const hoverRadius = nodeSize * 1.5;
    ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.3)';
    ctx.beginPath();
    ctx.arc(cp.x, cp.y, hoverRadius, 0, Math.PI * 2);
    ctx.fill();

    // White outline ring
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1.5 * scale;
    ctx.beginPath();
    ctx.arc(cp.x, cp.y, hoverRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();

    return 'grab';
}

/**
 * Draw a ghost/preview skeleton with a single node dragged to a new position.
 * Rendered semi-transparently with dashed edges to the dragged node.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {(number[]|null)[]} points - Original instance points in video coords
 * @param {number} dragNodeIdx - Index of the node being dragged
 * @param {number[]} dragPos - [u, v] current drag position in video coords
 * @param {Object} skeleton - Skeleton with .nodes and .edges
 * @param {Object} [options]
 * @param {string}  [options.color]       - Track color
 * @param {number}  [options.nodeSize]    - Base node radius (video px, default 4)
 * @param {number}  [options.lineWidth]   - Base line width (video px, default 2)
 * @param {number}  [options.videoWidth]
 * @param {number}  [options.videoHeight]
 * @param {number}  [options.canvasWidth]
 * @param {number}  [options.canvasHeight]
 */
export function drawDragPreview(ctx, points, dragNodeIdx, dragPos, skeleton, options) {
    options = options || {};
    if (!points || !dragPos || dragNodeIdx < 0 || dragNodeIdx >= points.length) return;

    const color = options.color || '#667eea';
    const baseNodeSize = options.nodeSize != null ? options.nodeSize : 4;
    const baseLineWidth = options.lineWidth != null ? options.lineWidth : 2;

    const vw = options.videoWidth;
    const vh = options.videoHeight;
    const cw = options.canvasWidth != null ? options.canvasWidth : ctx.canvas.width;
    const ch = options.canvasHeight != null ? options.canvasHeight : ctx.canvas.height;

    const needsTransform = vw != null && vh != null;
    const toCanvas = needsTransform
        ? makeVideoToCanvasTransform(vw, vh, cw, ch)
        : null;
    const scale = toCanvas ? toCanvas.scale : 1;

    const nodeSize = baseNodeSize;
    const lineWidth = baseLineWidth;

    // Build canvas points with the dragged node at its new position
    const canvasPoints = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
        let pt;
        if (i === dragNodeIdx) {
            pt = dragPos;
        } else {
            pt = points[i];
        }
        if (pt == null) { canvasPoints[i] = null; continue; }
        if (toCanvas) {
            canvasPoints[i] = toCanvas(pt[0], pt[1]);
        } else {
            canvasPoints[i] = { x: pt[0], y: pt[1] };
        }
    }

    ctx.save();
    ctx.globalAlpha = 0.4;

    // --- 1. Draw edges ---
    if (skeleton.edges) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        for (let i = 0; i < skeleton.edges.length; i++) {
            const edge = skeleton.edges[i];
            const src = canvasPoints[edge[0]];
            const dst = canvasPoints[edge[1]];
            if (!src || !dst) continue;

            // Use dashed style for edges connected to the dragged node
            const connectsToDrag = (edge[0] === dragNodeIdx || edge[1] === dragNodeIdx);
            if (connectsToDrag) {
                ctx.setLineDash([4, 4]);
            } else {
                ctx.setLineDash([]);
            }
            ctx.beginPath();
            ctx.moveTo(src.x, src.y);
            ctx.lineTo(dst.x, dst.y);
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    // --- 2. Draw nodes ---
    ctx.fillStyle = color;
    for (let i = 0; i < canvasPoints.length; i++) {
        const cp = canvasPoints[i];
        if (!cp) continue;
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, nodeSize, 0, Math.PI * 2);
        ctx.fill();
    }

    // --- 3. Highlight the dragged node ---
    if (canvasPoints[dragNodeIdx]) {
        const dp = canvasPoints[dragNodeIdx];
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(dp.x, dp.y, nodeSize * 1.5, 0, Math.PI * 2);
        ctx.stroke();
    }

    ctx.restore();
}

/**
 * Draw track name and node name labels near instances.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Instance[]} instances - Array of Instance objects for a camera view
 * @param {Object} skeleton - Skeleton with .nodes
 * @param {string} viewName - Camera / view name
 * @param {Object} [options]
 * @param {string[]} [options.trackNames]     - Track name strings indexed by trackIdx
 * @param {number}   [options.selectedInstanceIdx] - Index of the selected instance (for node labels), or -1
 * @param {number}   [options.nodeSize]       - Base node radius (video px, default 4)
 * @param {number}   [options.videoWidth]
 * @param {number}   [options.videoHeight]
 * @param {number}   [options.canvasWidth]
 * @param {number}   [options.canvasHeight]
 */
export function drawInstanceLabels(ctx, instances, skeleton, viewName, options) {
    options = options || {};
    if (!instances || instances.length === 0) return;

    const trackNames = options.trackNames || [];
    const selectedInstanceIdx = options.selectedInstanceIdx != null ? options.selectedInstanceIdx : -1;
    const baseNodeSize = options.nodeSize != null ? options.nodeSize : 4;
    const baseLabelSize = options.labelSize != null ? options.labelSize : 11;

    const vw = options.videoWidth;
    const vh = options.videoHeight;
    const cw = options.canvasWidth != null ? options.canvasWidth : ctx.canvas.width;
    const ch = options.canvasHeight != null ? options.canvasHeight : ctx.canvas.height;

    const needsTransform = vw != null && vh != null;
    const toCanvas = needsTransform
        ? makeVideoToCanvasTransform(vw, vh, cw, ch)
        : null;
    const scale = toCanvas ? toCanvas.scale : 1;

    // Screen-relative label sizing
    const displayScale = cw / (ctx.canvas.getBoundingClientRect().width || cw);
    const adjustedLabelSize = Math.round(baseLabelSize * displayScale);

    const nodeSize = baseNodeSize;

    ctx.save();

    for (let instIdx = 0; instIdx < instances.length; instIdx++) {
        const inst = instances[instIdx];
        if (!inst.points || inst.points.length === 0) continue;

        // Find first non-null point for track label placement
        let firstCp = null;
        for (let i = 0; i < inst.points.length; i++) {
            const pt = inst.points[i];
            if (pt == null) continue;
            if (toCanvas) {
                firstCp = toCanvas(pt[0], pt[1]);
            } else {
                firstCp = { x: pt[0], y: pt[1] };
            }
            break;
        }

        if (!firstCp) continue;

        // Draw track name label
        const trackName = inst.trackIdx != null && trackNames[inst.trackIdx]
            ? trackNames[inst.trackIdx]
            : ('Track ' + (inst.trackIdx != null ? inst.trackIdx : instIdx));
        var trackColors = options.trackColors || null;
        const color = (trackColors && trackColors[inst.trackIdx])
            ? trackColors[inst.trackIdx]
            : (options.color || getTrackColor(inst.trackIdx != null ? inst.trackIdx : instIdx));

        var fontSize = adjustedLabelSize;
        if (fontSize <= 0) continue; // label size 0 = hidden
        ctx.font = 'bold ' + fontSize + 'px sans-serif';
        ctx.textBaseline = 'bottom';

        // Background pill for track label
        const textWidth = ctx.measureText(trackName).width;
        const pillPad = 3;
        const pillX = firstCp.x - pillPad;
        var labelYOffset = fontSize * 1.5;
        const pillY = firstCp.y - labelYOffset - fontSize - pillPad;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(pillX, pillY, textWidth + pillPad * 2, fontSize + pillPad * 2, 3);
        } else {
            ctx.rect(pillX, pillY, textWidth + pillPad * 2, fontSize + pillPad * 2);
        }
        ctx.fill();

        ctx.fillStyle = color;
        ctx.fillText(trackName, firstCp.x, firstCp.y - labelYOffset);

        // Draw node name labels for the selected instance
        if (instIdx === selectedInstanceIdx && skeleton && skeleton.nodes) {
            var nodeFontSize = adjustedLabelSize;
            if (nodeFontSize <= 0) continue;
            ctx.font = nodeFontSize + 'px sans-serif';
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
            ctx.lineWidth = Math.max(1, Math.round(nodeFontSize * 0.15));
            ctx.textBaseline = 'bottom';
            ctx.textAlign = 'left';
            // Build canvasPoints for label offset computation
            var instCanvasPoints = new Array(inst.points.length);
            for (let n = 0; n < inst.points.length; n++) {
                const pt = inst.points[n];
                if (pt == null) { instCanvasPoints[n] = null; continue; }
                if (toCanvas) {
                    instCanvasPoints[n] = toCanvas(pt[0], pt[1]);
                } else {
                    instCanvasPoints[n] = { x: pt[0], y: pt[1] };
                }
            }
            var instNulled = inst.nulledNodes || null;
            for (let n = 0; n < inst.points.length; n++) {
                var cp = instCanvasPoints[n];
                if (!cp) continue;
                const nodeName = typeof skeleton.nodes[n] === 'string'
                    ? skeleton.nodes[n]
                    : (skeleton.nodes[n] && skeleton.nodes[n].name ? skeleton.nodes[n].name : '');
                if (nodeName) {
                    var isNodeNulled = instNulled && instNulled.has(n);
                    if (isNodeNulled) {
                        ctx.globalAlpha = 0.4;
                        ctx.fillStyle = '#888888';
                        ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
                    } else {
                        ctx.globalAlpha = 1.0;
                        ctx.fillStyle = '#ffffff';
                        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
                    }
                    var loff = computeLabelOffset(n, instCanvasPoints, skeleton, nodeName, nodeFontSize, ctx);
                    ctx.strokeText(nodeName, cp.x + loff.dx, cp.y + loff.dy);
                    ctx.fillText(nodeName, cp.x + loff.dx, cp.y + loff.dy);
                }
            }
            ctx.globalAlpha = 1.0;
        }
    }

    ctx.restore();
}

/**
 * Draw a small type-indicator badge near an instance.
 *   - 'predicted': small "P" badge
 *   - 'user': small "U" badge
 *   - If instance.modified is true: small "*" indicator appended
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {(number[]|null)[]} points - Instance points in video coords
 * @param {string} type - 'predicted' or 'user'
 * @param {Object} [options]
 * @param {boolean} [options.modified]    - Whether the instance has been modified
 * @param {string}  [options.color]       - Track color
 * @param {number}  [options.nodeSize]    - Base node radius (video px, default 4)
 * @param {number}  [options.videoWidth]
 * @param {number}  [options.videoHeight]
 * @param {number}  [options.canvasWidth]
 * @param {number}  [options.canvasHeight]
 */
export function drawInstanceTypeIndicator(ctx, points, type, options) {
    options = options || {};
    if (!points || points.length === 0) return;

    const modified = !!options.modified;
    const baseNodeSize = options.nodeSize != null ? options.nodeSize : 4;

    const vw = options.videoWidth;
    const vh = options.videoHeight;
    const cw = options.canvasWidth != null ? options.canvasWidth : ctx.canvas.width;
    const ch = options.canvasHeight != null ? options.canvasHeight : ctx.canvas.height;

    const needsTransform = vw != null && vh != null;
    const toCanvas = needsTransform
        ? makeVideoToCanvasTransform(vw, vh, cw, ch)
        : null;
    const scale = toCanvas ? toCanvas.scale : 1;

    const nodeSize = baseNodeSize * scale;

    // Find the topmost, leftmost non-null point for badge placement
    let anchorCp = null;
    let bestY = Infinity;
    for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        if (pt == null) continue;
        let cp;
        if (toCanvas) {
            cp = toCanvas(pt[0], pt[1]);
        } else {
            cp = { x: pt[0], y: pt[1] };
        }
        if (cp.y < bestY) {
            bestY = cp.y;
            anchorCp = cp;
        }
    }
    if (!anchorCp) return;

    ctx.save();

    let badgeText = type === 'predicted' ? 'P' : 'U';
    if (modified) badgeText += '*';

    const fontSize = Math.round(9 * scale);
    ctx.font = 'bold ' + fontSize + 'px sans-serif';
    const textW = ctx.measureText(badgeText).width;
    const pad = 2 * scale;
    const badgeW = textW + pad * 2;
    const badgeH = fontSize + pad * 2;
    const badgeX = anchorCp.x + nodeSize + 2 * scale;
    const badgeY = anchorCp.y - badgeH;

    // Badge background
    const bgColor = type === 'predicted' ? 'rgba(168, 85, 247, 0.7)' : 'rgba(6, 182, 212, 0.7)';
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 2);
    } else {
        ctx.rect(badgeX, badgeY, badgeW, badgeH);
    }
    ctx.fill();

    // Badge text
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    ctx.fillText(badgeText, badgeX + pad, badgeY + pad);

    ctx.restore();
}

// ============================================
// Unlinked instance rendering
// ============================================

/**
 * Draw unlinked instances with a visually distinct style:
 *   - Dashed skeleton edges
 *   - Semi-transparent nodes
 *   - "?" badge to indicate unlinked status
 *   - During assignment mode: highlighted border if selected
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {UnlinkedInstance[]} unlinkedInstances - Array of UnlinkedInstance objects
 * @param {Object} skeleton - Skeleton with .nodes and .edges
 * @param {Object} [options]
 * @param {number}   [options.nodeSize]
 * @param {number}   [options.lineWidth]
 * @param {number}   [options.videoWidth]
 * @param {number}   [options.videoHeight]
 * @param {number}   [options.canvasWidth]
 * @param {number}   [options.canvasHeight]
 * @param {number[]} [options.assignmentSelectedIds] - IDs of unlinked instances selected for assignment
 * @param {string}   [options.assignmentColor] - Color for assignment selection highlight
 * @param {string}   [options.typeFilter] - If set, only draw instances matching this type ('user' or 'predicted')
 */
export function drawUnlinkedInstances(ctx, unlinkedInstances, skeleton, options) {
    options = options || {};
    if (!unlinkedInstances || unlinkedInstances.length === 0) return;

    const baseNodeSize = options.nodeSize != null ? options.nodeSize : 4;
    const baseLineWidth = options.lineWidth != null ? options.lineWidth : 2;
    const baseLabelSize = options.labelSize != null ? options.labelSize : 11;
    const showLabels = options.showLabels !== false; // default true for unlinked
    const assignmentSelectedIds = options.assignmentSelectedIds || [];
    const assignmentColor = options.assignmentColor || '#fbbf24';
    const ulColorByIdentity = !!options.colorByIdentity;
    const ulSession = options.session || null;
    const ulFrameIdx = options.frameIdx != null ? options.frameIdx : null;
    const selectedUnlinkedId = options.selectedUnlinkedId || null;
    const predictedRender = options.predictedRender || null;

    const vw = options.videoWidth;
    const vh = options.videoHeight;
    const cw = options.canvasWidth != null ? options.canvasWidth : ctx.canvas.width;
    const ch = options.canvasHeight != null ? options.canvasHeight : ctx.canvas.height;

    const needsTransform = vw != null && vh != null;
    const toCanvas = needsTransform
        ? makeVideoToCanvasTransform(vw, vh, cw, ch)
        : null;
    const scale = toCanvas ? toCanvas.scale : 1;

    // Screen-relative label sizing
    const displayScale = cw / (ctx.canvas.getBoundingClientRect().width || cw);
    const adjustedLabelSize = Math.round(baseLabelSize * displayScale);

    const nodeSize = baseNodeSize;
    const lineWidth = baseLineWidth;

    const typeFilter = options.typeFilter || null;

    for (let u = 0; u < unlinkedInstances.length; u++) {
        const ul = unlinkedInstances[u];
        const instance = ul.instance;
        const points = instance.points;
        if (!points || points.length === 0) continue;

        // Filter by type if typeFilter is set
        const instType = instance.type || 'user';
        if (typeFilter && instType !== typeFilter) continue;

        // Use per-type render options for predicted instances
        const isPredicted = instance.type === 'predicted';
        const instNodeSize = isPredicted && predictedRender ? (predictedRender.nodeSize || nodeSize) : nodeSize;
        const instLineWidth = isPredicted && predictedRender ? (predictedRender.lineWidth || lineWidth) : lineWidth;

        const isAssignSelected = assignmentSelectedIds.indexOf(ul.id) >= 0;
        const isSelected = isAssignSelected;
        var baseTrackColor = getInstanceColor(instance, ulSession, ul.cameraName, ulColorByIdentity, ulFrameIdx) || (isPredicted ? '#888888' : UNGROUPED_USER_COLOR);
        const color = isAssignSelected ? assignmentColor : (isPredicted ? desaturateColor(baseTrackColor, 0.15) : baseTrackColor);
        const ulEdgeColor = isPredicted && !isAssignSelected ? desaturateColor(baseTrackColor, 0.3) : color;
        const alpha = isSelected ? 0.95 : (isPredicted ? 0.8 : 0.5);

        // Pre-compute canvas positions
        const canvasPoints = new Array(points.length);
        for (let i = 0; i < points.length; i++) {
            const pt = points[i];
            if (pt == null) { canvasPoints[i] = null; continue; }
            if (toCanvas) {
                canvasPoints[i] = toCanvas(pt[0], pt[1]);
            } else {
                canvasPoints[i] = { x: pt[0], y: pt[1] };
            }
        }

        const nulledNodes = instance.nulledNodes || null;

        ctx.save();
        ctx.globalAlpha = alpha;

        // Edges with per-type line style
        if (skeleton.edges) {
            const instLineStyle = isPredicted && predictedRender && predictedRender.lineStyle
                ? predictedRender.lineStyle : (options.lineStyle || 'dashed');
            const instDashPattern = getLineDashPattern(instLineStyle);
            ctx.lineWidth = instLineWidth;
            ctx.lineCap = 'round';
            if (instDashPattern.length) ctx.setLineDash(instDashPattern);
            // Two-pass: normal edges, then grayed (nulled) edges
            for (var ePass = 0; ePass < 2; ePass++) {
                ctx.beginPath();
                var hasEdgeStrokes = false;
                for (let i = 0; i < skeleton.edges.length; i++) {
                    const edge = skeleton.edges[i];
                    const src = canvasPoints[edge[0]];
                    const dst = canvasPoints[edge[1]];
                    if (!src || !dst) continue;
                    var srcNulled = nulledNodes && nulledNodes.has(edge[0]);
                    var dstNulled = nulledNodes && nulledNodes.has(edge[1]);
                    var edgeGray = srcNulled || dstNulled;
                    if (ePass === 0 && !edgeGray) {
                        ctx.moveTo(src.x, src.y);
                        ctx.lineTo(dst.x, dst.y);
                        hasEdgeStrokes = true;
                    } else if (ePass === 1 && edgeGray) {
                        ctx.moveTo(src.x, src.y);
                        ctx.lineTo(dst.x, dst.y);
                        hasEdgeStrokes = true;
                    }
                }
                if (hasEdgeStrokes) {
                    if (ePass === 0) {
                        ctx.strokeStyle = ulEdgeColor;
                    } else {
                        ctx.strokeStyle = '#888888';
                        ctx.globalAlpha = alpha * 0.4;
                    }
                    ctx.stroke();
                    if (ePass === 1) ctx.globalAlpha = alpha;
                }
            }
            if (instDashPattern.length) ctx.setLineDash([]);
        }

        // Normal nodes
        ctx.fillStyle = color;
        for (let i = 0; i < canvasPoints.length; i++) {
            const cp = canvasPoints[i];
            if (!cp) continue;
            if (nulledNodes && nulledNodes.has(i)) continue;
            ctx.beginPath();
            ctx.arc(cp.x, cp.y, instNodeSize, 0, Math.PI * 2);
            ctx.fill();
        }
        // Grayed-out (nulled) nodes
        if (nulledNodes && nulledNodes.size > 0) {
            ctx.fillStyle = '#aaaaaa';
            ctx.globalAlpha = alpha * 0.55;
            for (const ni of nulledNodes) {
                const cp = canvasPoints[ni];
                if (!cp) continue;
                ctx.beginPath();
                ctx.arc(cp.x, cp.y, instNodeSize, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = alpha;
        }

        // "?" badge near the first visible point
        let anchorCp = null;
        for (let i = 0; i < canvasPoints.length; i++) {
            if (canvasPoints[i]) { anchorCp = canvasPoints[i]; break; }
        }
        if (anchorCp) {
            const badgeSize = 10;
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.beginPath();
            ctx.arc(anchorCp.x - instNodeSize * 2, anchorCp.y - instNodeSize * 2, badgeSize, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fbbf24';
            ctx.font = 'bold ' + badgeSize + 'px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('?', anchorCp.x - instNodeSize * 2, anchorCp.y - instNodeSize * 2);
        }

        // Node name labels (never for predicted instances)
        if (showLabels && !isPredicted) {
            ctx.globalAlpha = 1.0;
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
            var fontSize = adjustedLabelSize;
            if (fontSize > 0) {
                ctx.lineWidth = Math.max(1, Math.round(fontSize * 0.15));
                ctx.font = 'bold ' + fontSize + 'px sans-serif';
                ctx.textBaseline = 'bottom';
                ctx.textAlign = 'left';
                for (var li = 0; li < canvasPoints.length; li++) {
                    var lp = canvasPoints[li];
                    if (!lp) continue;
                    var isLabelNulled = nulledNodes && nulledNodes.has(li);
                    var node2 = skeleton.nodes ? skeleton.nodes[li] : undefined;
                    var lname = typeof node2 === 'string' ? node2 : (node2 && node2.name ? node2.name : 'node_' + li);
                    var labelOff2 = computeLabelOffset(li, canvasPoints, skeleton, lname, fontSize, ctx);
                    var ltx = lp.x + labelOff2.dx;
                    var lty = lp.y + labelOff2.dy;
                    if (isLabelNulled) {
                        ctx.globalAlpha = 0.4;
                        ctx.fillStyle = '#888888';
                        ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
                    } else {
                        ctx.globalAlpha = 1.0;
                        ctx.fillStyle = '#ffffff';
                        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
                    }
                    ctx.strokeText(lname, ltx, lty);
                    ctx.fillText(lname, ltx, lty);
                }
            }
        }

        // Selection ring (assignment mode only)
        if (isSelected) {
            ctx.globalAlpha = 0.8;
            ctx.strokeStyle = assignmentColor;
            ctx.lineWidth = 2;
            for (let i = 0; i < canvasPoints.length; i++) {
                const cp = canvasPoints[i];
                if (!cp) continue;
                ctx.beginPath();
                ctx.arc(cp.x, cp.y, instNodeSize * 2, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        ctx.restore();
    }
}

// ============================================
// Full frame overlay rendering
// ============================================

/**
 * Draw all overlays for a single camera view at the current frame.
 *
 * @param {CanvasRenderingContext2D} ctx - Overlay canvas context
 * @param {string} viewName - Camera name (e.g. 'back', 'mid', 'side', 'top')
 * @param {Object} frameGroup - FrameGroup for the current frame; has per-camera
 *        instance arrays, e.g. frameGroup.instances[viewName] = [Instance, ...]
 * @param {Array}  instanceGroups - InstanceGroup[] for current frame; each has:
 *        .trackIdx, .reprojections[viewName] = [x,y][] or null,
 *        .observedPoints[viewName] = [x,y][] or null
 * @param {Object} session - Session object with .cameras, .skeleton
 * @param {Object} [options]
 * @param {boolean} [options.showDetected]    - Show original 2D detections (default true)
 * @param {boolean} [options.showReprojected] - Show reprojected from 3D (default true)
 * @param {boolean} [options.showErrors]      - Show error vectors (default true)
 * @param {number}  [options.nodeSize]        - Node radius in video px (default 4)
 * @param {number}  [options.lineWidth]       - Edge width in video px (default 2)
 * @param {number}  [options.videoWidth]      - Original video width
 * @param {number}  [options.videoHeight]     - Original video height
 * @param {number}  [options.canvasWidth]     - Override canvas width
 * @param {number}  [options.canvasHeight]    - Override canvas height
 * @param {boolean} [options.showLabels]      - Show node labels (default false)
 * @param {boolean} [options.showLegend]      - Show legend (default true)
 * @param {Object|null}  [options.selectedInstanceGroup] - Currently selected InstanceGroup, or null
 * @param {number}       [options.selectedNodeIdx]       - Currently selected node index, or -1
 * @param {Object|null}  [options.hoveredNode]           - { viewName, instanceGroupIdx, nodeIdx } or null
 * @param {Object|null}  [options.dragInfo]              - { viewName, nodeIdx, currentPos } or null
 * @param {UnlinkedInstance[]} [options.unlinkedInstances] - Unlinked instances for this view
 * @param {number[]}    [options.assignmentSelectedIds]  - IDs of unlinked instances selected for assignment
 * @param {boolean}     [options.assignmentMode]         - Whether assignment mode is active
 */
export function drawFrameOverlays(ctx, viewName, frameGroup, instanceGroups, session, options) {
    options = options || {};
    var _frameIdx = frameGroup ? frameGroup.frameIdx : null;

    // Per-type visibility flags
    const showUser        = options.showUser !== undefined ? options.showUser : (options.showDetected !== false);
    const showPredicted   = options.showPredicted !== undefined ? options.showPredicted : (options.showDetected !== false);
    const showReprojected = options.showReprojected !== false;
    const reprojNodeColor = options.reprojNodeColor || 'white';
    const showErrors      = options.showErrors !== false;
    const showLegend      = options.showLegend === true;
    const colorByIdentity = !!options.colorByIdentity;

    // Per-type rendering options (fall back to flat options for backward compat)
    const defaultOpts = {
        nodeSize: options.nodeSize != null ? options.nodeSize : 4,
        lineWidth: options.lineWidth != null ? options.lineWidth : 2,
        labelSize: options.labelSize != null ? options.labelSize : 11,
        alpha: 1.0,
        showLabels: !!options.showLabels,
    };
    const userOpts = options.userOpts || defaultOpts;
    const predictedOpts = options.predictedOpts || Object.assign({}, defaultOpts, { showLabels: false });
    const reprojOpts = options.reprojOpts || defaultOpts;

    const selectedInstanceGroup = options.selectedInstanceGroup || null;
    const selectedReprojected   = options.selectedReprojected || false;
    const selectedNodeIdx       = options.selectedNodeIdx != null ? options.selectedNodeIdx : -1;
    const hoveredNode           = options.hoveredNode || null;
    const dragInfo              = options.dragInfo || null;

    const canvasW = options.canvasWidth != null ? options.canvasWidth : ctx.canvas.width;
    const canvasH = options.canvasHeight != null ? options.canvasHeight : ctx.canvas.height;
    const videoW  = options.videoWidth;
    const videoH  = options.videoHeight;

    const skeleton = session && session.skeleton ? session.skeleton : { nodes: [], edges: [] };

    // Shared geometry options (used for coordinate transforms)
    const geoOpts = {
        videoWidth: videoW,
        videoHeight: videoH,
        canvasWidth: canvasW,
        canvasHeight: canvasH,
    };

    // Build per-type render option sets with geometry info
    function makeRenderOpts(typeOpts) {
        return Object.assign({}, typeOpts, geoOpts);
    }

    var userRender = makeRenderOpts(userOpts);
    var predictedRender = makeRenderOpts(predictedOpts);
    var reprojRender = makeRenderOpts(reprojOpts);

    // 1. Clear overlay
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    // Gather view instances once for both passes
    let viewInstances = null;
    if (frameGroup && frameGroup.instances) {
        viewInstances = frameGroup.instances instanceof Map
            ? frameGroup.instances.get(viewName)
            : frameGroup.instances[viewName];
    }

    const unlinkedInstances = options.unlinkedInstances || [];
    const unlinkedOpts = {
        lineStyle: userOpts.preLineStyle || 'dashed',
        predictedRender: Object.assign({}, predictedRender, {
            lineStyle: predictedOpts.preLineStyle || 'solid',
        }),
        assignmentSelectedIds: options.assignmentSelectedIds || [],
        assignmentColor: '#fbbf24',
        selectedUnlinkedId: options.selectedUnlinkedId || null,
    };

    // 2. Draw reprojected instances + error vectors (back layer)
    if (instanceGroups) {
        for (let g = 0; g < instanceGroups.length; g++) {
            const group = instanceGroups[g];

            // Draw reprojected instances — same color as group/3D viewer
            var trackBaseColor = getGroupColor(group, session, colorByIdentity, _frameIdx, viewName);
            var reprojBrightness = reprojOpts.brightness != null ? reprojOpts.brightness : 1.0;
            var reprojTrackColor = reprojBrightness < 1.0
                ? adjustColorBrightness(trackBaseColor, reprojBrightness)
                : trackBaseColor;

            // Always draw reprojections — one per group per view
            if (showReprojected) {
                var reprojInst = (group.reprojectedInstances && group.reprojectedInstances.size > 0)
                    ? (group.getReprojectedInstance ? group.getReprojectedInstance(viewName) : null)
                    : null;

                if (reprojInst) {
                    var isSelected = selectedReprojected && selectedInstanceGroup && selectedInstanceGroup === group;
                    var reprojXColor = isSelected ? '#ffffff'
                        : reprojNodeColor === 'black' ? '#000000'
                        : reprojNodeColor === 'track' ? reprojTrackColor
                        : '#ffffff';
                    drawSkeleton(ctx, reprojInst, skeleton, Object.assign({}, reprojRender, {
                        color: reprojXColor,
                        edgeColor: isSelected ? '#ffffff' : reprojTrackColor,
                        lineStyle: reprojOpts.lineStyle || 'dotted',
                        nodeShape: 'x',
                    }));

                    if (reprojOpts.showLabels) {
                        const trackNames = session && session.tracks ? session.tracks : [];
                        drawInstanceLabels(ctx, [reprojInst], skeleton, viewName, Object.assign({}, reprojRender, {
                            trackNames: trackNames,
                            color: reprojTrackColor,
                        }));
                    }
                } else {
                    // Fall back to raw reprojection data. Match the
                    // primary path's color split: X marks (nodes) use the
                    // designated reprojection color; connecting edges use
                    // the track color. SLP-loaded groups populate
                    // `group.reprojections` without ever materializing
                    // `reprojectedInstances`, so this branch rendered
                    // every reprojection in track-color before — making
                    // it look like "reprojections use the node color."
                    var reprojPts = group.reprojections ? group.reprojections[viewName] : null;
                    if (reprojPts) {
                        drawReprojectedSkeleton(ctx, reprojPts, skeleton, Object.assign({}, reprojRender, {
                            color: reprojXColor,
                            edgeColor: reprojTrackColor,
                        }));
                    }
                }
            }

            // Error vectors: need both observed and reprojected
            const reprojPtsForErrors = group.reprojections ? group.reprojections[viewName] : null;
            if (showErrors && reprojPtsForErrors) {
                const observedPts = group.observedPoints ? group.observedPoints[viewName] : null;
                if (observedPts) {
                    drawReprojectionErrors(ctx, observedPts, reprojPtsForErrors, reprojRender);
                }
            }
        }
    }

    // Build map of instance -> group for identity coloring
    var instToGroup = new Map();
    if (instanceGroups) {
        for (var _ig = 0; _ig < instanceGroups.length; _ig++) {
            var _g = instanceGroups[_ig];
            var _inst = _g.getInstance ? _g.getInstance(viewName) : null;
            if (_inst) instToGroup.set(_inst, _g);
        }
    }

    // 3. Linked predicted instances — drawn OVER reprojections so they're visible
    if (viewInstances && showPredicted) {
        for (let i = 0; i < viewInstances.length; i++) {
            const inst = viewInstances[i];
            const instType = inst.type || 'user';
            if (instType !== 'predicted') continue;

            var parentGroup = instToGroup.get(inst);
            var baseColor = parentGroup ? getGroupColor(parentGroup, session, colorByIdentity, _frameIdx, viewName) : getInstanceColor(inst, session, viewName, colorByIdentity, _frameIdx);
            var isSelected = !selectedReprojected && selectedInstanceGroup &&
                selectedInstanceGroup.getInstance &&
                selectedInstanceGroup.getInstance(viewName) === inst;
            var drawColor = isSelected ? '#ffffff' : desaturateColor(baseColor, 0.2);
            var drawAlpha = isSelected ? 1.0 : 0.85;
            drawSkeleton(ctx, inst, skeleton, Object.assign({}, predictedRender, {
                color: drawColor,
                edgeColor: isSelected ? '#ffffff' : desaturateColor(baseColor, 0.4),
                alpha: drawAlpha,
                lineStyle: predictedOpts.postLineStyle || 'solid',
            }));
        }
    }

    // 3b. Unlinked predicted instances
    if (unlinkedInstances.length > 0) {
        drawUnlinkedInstances(ctx, unlinkedInstances, skeleton, Object.assign({}, userRender, unlinkedOpts, {
            typeFilter: 'predicted',
            colorByIdentity: colorByIdentity,
            session: session,
            frameIdx: _frameIdx,
        }));
    }

    // 4. Linked user instances (front layer) + user labels
    if (viewInstances && showUser) {
        var userInstances = [];
        for (let i = 0; i < viewInstances.length; i++) {
            const inst = viewInstances[i];
            const instType = inst.type || 'user';
            if (instType === 'predicted') continue;

            var parentGroup = instToGroup.get(inst);
            var baseColor = parentGroup ? getGroupColor(parentGroup, session, colorByIdentity, _frameIdx, viewName) : getInstanceColor(inst, session, viewName, colorByIdentity, _frameIdx);
            var isSelected = !selectedReprojected && selectedInstanceGroup &&
                selectedInstanceGroup.getInstance &&
                selectedInstanceGroup.getInstance(viewName) === inst;
            var drawColor = isSelected ? '#ffffff' : baseColor;
            drawSkeleton(ctx, inst, skeleton, Object.assign({}, userRender, {
                color: drawColor,
                lineStyle: userOpts.postLineStyle || 'solid',
            }));

            userInstances.push(inst);
        }

        // 4a. Draw track name labels (user instances only)
        if (userOpts.showLabels && userInstances.length > 0) {
            var labelNames = session && session.tracks ? session.tracks.slice() : [];
            var labelColors = null;
            // When coloring by identity, show identity names and colors on labels
            if (colorByIdentity && session) {
                labelColors = {};
                for (var li = 0; li < userInstances.length; li++) {
                    var lInst = userInstances[li];
                    var lIdentity = session.getIdentityForTrack(lInst.trackIdx, viewName, _frameIdx);
                    if (lIdentity) {
                        labelNames[lInst.trackIdx] = lIdentity.name;
                        labelColors[lInst.trackIdx] = lIdentity.color;
                    }
                }
            }
            drawInstanceLabels(ctx, userInstances, skeleton, viewName, Object.assign({}, userRender, {
                trackNames: labelNames,
                trackColors: labelColors,
            }));
        }
    }

    // 4b. Unlinked user instances
    if (unlinkedInstances.length > 0) {
        drawUnlinkedInstances(ctx, unlinkedInstances, skeleton, Object.assign({}, userRender, unlinkedOpts, {
            typeFilter: 'user',
            colorByIdentity: colorByIdentity,
            session: session,
            frameIdx: _frameIdx,
        }));
    }

    // 5. Selection highlight
    if (selectedInstanceGroup && !selectedReprojected) {
        const selInst = selectedInstanceGroup.getInstance
            ? selectedInstanceGroup.getInstance(viewName)
            : (selectedInstanceGroup.instances ? selectedInstanceGroup.instances[viewName] : null);
        if (selInst && selInst.points) {
            drawSelectionHighlight(ctx, selInst.points, skeleton, Object.assign({}, userRender, {
                color: '#ffffff',
                selectedNodeIdx: selectedNodeIdx,
                nulledNodes: selInst.nulledNodes || null,
            }));
        }
    }

    // 5b. Edit Group highlight — white ring around all group member instances
    var editGroupTarget = options.editGroupTarget || null;
    if (editGroupTarget) {
        var egInst = editGroupTarget.getInstance
            ? editGroupTarget.getInstance(viewName)
            : null;
        if (egInst && egInst.points) {
            drawSelectionHighlight(ctx, egInst.points, skeleton, Object.assign({}, userRender, {
                color: '#ffffff',
                selectedNodeIdx: -1,
                nulledNodes: egInst.nulledNodes || null,
            }));
        }
    }

    // 6. Hover highlight — disabled (cursor change handled by interaction manager)

    // 7. Drag preview
    if (dragInfo && dragInfo.viewName === viewName && selectedInstanceGroup) {
        const dragInst = selectedInstanceGroup.getInstance
            ? selectedInstanceGroup.getInstance(viewName)
            : (selectedInstanceGroup.instances ? selectedInstanceGroup.instances[viewName] : null);
        if (dragInst && dragInst.points) {
            drawDragPreview(ctx, dragInst.points, dragInfo.nodeIdx, dragInfo.currentPos, skeleton,
                Object.assign({}, userRender, { color: '#ffffff' }));
        }
    }

    // 8. Legend
    if (showLegend) {
        drawLegend(ctx, {
            showDetected: showUser || showPredicted,
            showReprojected: showReprojected,
            showErrors: showErrors,
        });
    }
}

/**
 * Draw a small legend in the top-right corner of the overlay canvas.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} [options]
 * @param {boolean} [options.showDetected]
 * @param {boolean} [options.showReprojected]
 * @param {boolean} [options.showErrors]
 */
export function drawLegend(ctx, options) {
    options = options || {};
    const showDetected    = options.showDetected !== false;
    const showReprojected = options.showReprojected !== false;
    const showErrors      = options.showErrors !== false;

    // Collect legend items
    const items = [];
    if (showDetected) {
        items.push({ type: 'detected', label: 'Detected' });
    }
    if (showReprojected) {
        items.push({ type: 'reprojected', label: 'Reprojected' });
    }
    if (showErrors) {
        items.push({ type: 'error', label: 'Error vector' });
    }
    if (items.length === 0) return;

    const fontSize = 28;
    const itemHeight = 40;
    const padding = 18;
    const iconWidth = 32;
    const iconGap = 14;
    const boxWidth = 310;
    const boxHeight = padding * 2 + items.length * itemHeight;

    // Render legend at 2x resolution on an offscreen canvas for crisp text
    const scale = 2;
    const offCanvas = document.createElement('canvas');
    offCanvas.width = boxWidth * scale;
    offCanvas.height = boxHeight * scale;
    const oc = offCanvas.getContext('2d');
    oc.scale(scale, scale);

    // Background
    oc.fillStyle = 'rgba(0, 0, 0, 0.6)';
    oc.beginPath();
    if (oc.roundRect) {
        oc.roundRect(0, 0, boxWidth, boxHeight, 4);
    } else {
        oc.rect(0, 0, boxWidth, boxHeight);
    }
    oc.fill();

    oc.font = fontSize + 'px sans-serif';
    oc.textBaseline = 'middle';

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const iy = padding + i * itemHeight + itemHeight / 2;
        const ix = padding;

        if (item.type === 'detected') {
            oc.fillStyle = TRACK_COLORS[0];
            oc.beginPath();
            oc.arc(ix + iconWidth / 2, iy, 8, 0, Math.PI * 2);
            oc.fill();
        } else if (item.type === 'reprojected') {
            const cx = ix + iconWidth / 2;
            oc.strokeStyle = REPROJECTION_COLOR;
            oc.lineWidth = 4;
            oc.beginPath();
            oc.moveTo(cx - 8, iy - 8);
            oc.lineTo(cx + 8, iy + 8);
            oc.moveTo(cx + 8, iy - 8);
            oc.lineTo(cx - 8, iy + 8);
            oc.stroke();
        } else if (item.type === 'error') {
            const lx = ix + 2;
            oc.lineWidth = 4;
            oc.lineCap = 'round';
            oc.strokeStyle = '#4ade80';
            oc.beginPath();
            oc.moveTo(lx, iy);
            oc.lineTo(lx + 8, iy);
            oc.stroke();
            oc.strokeStyle = '#fbbf24';
            oc.beginPath();
            oc.moveTo(lx + 8, iy);
            oc.lineTo(lx + 16, iy);
            oc.stroke();
            oc.strokeStyle = '#ef4444';
            oc.beginPath();
            oc.moveTo(lx + 16, iy);
            oc.lineTo(lx + 24, iy);
            oc.stroke();
        }

        oc.fillStyle = '#ffffff';
        oc.fillText(item.label, ix + iconWidth + iconGap, iy);
    }

    // Draw the hi-res offscreen canvas onto the main canvas at 1x size
    const destX = ctx.canvas.width - boxWidth - 16;
    const destY = 16;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(offCanvas, destX, destY, boxWidth, boxHeight);
    ctx.restore();
}

// ============================================
// Info panel helpers
// ============================================

/**
 * Compute summary statistics for the info panel.
 *
 * @param {Object} frameGroup - FrameGroup for current frame
 * @param {Array}  instanceGroups - InstanceGroup[] for current frame
 * @param {Array}  cameras - Array of camera name strings
 * @returns {{
 *   numInstances: number,
 *   numInstanceGroups: number,
 *   meanReprojError: number,
 *   maxReprojError: number,
 *   perCameraErrors: Object.<string, { mean: number, max: number, count: number }>,
 *   perTrackErrors: Object.<number, { mean: number, max: number, count: number }>
 * }}
 */
export function getFrameStats(frameGroup, instanceGroups, cameras) {
    const stats = {
        numInstances: 0,
        numInstanceGroups: 0,
        meanReprojError: 0,
        maxReprojError: 0,
        perCameraErrors: {},
        perTrackErrors: {},
    };

    // Count total instances across all cameras
    if (frameGroup && frameGroup.instances) {
        const isMap = frameGroup.instances instanceof Map;
        if (cameras) {
            for (let c = 0; c < cameras.length; c++) {
                const camName = cameras[c];
                const insts = isMap ? frameGroup.instances.get(camName) : frameGroup.instances[camName];
                if (insts) {
                    stats.numInstances += insts.length;
                }
            }
        } else {
            // Iterate over all entries
            const entries = isMap ? Array.from(frameGroup.instances.entries()) : Object.entries(frameGroup.instances);
            for (let k = 0; k < entries.length; k++) {
                const insts = entries[k][1];
                if (insts) {
                    stats.numInstances += insts.length;
                }
            }
        }
    }

    if (!instanceGroups) return stats;
    stats.numInstanceGroups = instanceGroups.length;

    // Initialize per-camera accumulators
    if (cameras) {
        for (let c = 0; c < cameras.length; c++) {
            stats.perCameraErrors[cameras[c]] = { sum: 0, max: 0, count: 0 };
        }
    }

    // Accumulate reprojection errors
    let globalSum = 0;
    let globalMax = 0;
    let globalCount = 0;

    for (let g = 0; g < instanceGroups.length; g++) {
        const group = instanceGroups[g];
        const trackIdx = group.identityId >= 0 ? group.identityId : g;
        const reproj = group.reprojections;
        const observed = group.observedPoints;
        if (!reproj || !observed) continue;

        if (!stats.perTrackErrors[trackIdx]) {
            stats.perTrackErrors[trackIdx] = { sum: 0, max: 0, count: 0 };
        }
        const trackAcc = stats.perTrackErrors[trackIdx];

        const camKeys = cameras || Object.keys(reproj);
        for (let c = 0; c < camKeys.length; c++) {
            const camName = camKeys[c];
            const rPts = reproj[camName];
            const oPts = observed[camName];
            if (!rPts || !oPts) continue;

            // Ensure per-camera accumulator exists
            if (!stats.perCameraErrors[camName]) {
                stats.perCameraErrors[camName] = { sum: 0, max: 0, count: 0 };
            }
            const camAcc = stats.perCameraErrors[camName];

            const len = Math.min(rPts.length, oPts.length);
            for (let i = 0; i < len; i++) {
                const rp = rPts[i];
                const op = oPts[i];
                if (rp == null || op == null) continue;

                const dx = rp[0] - op[0];
                const dy = rp[1] - op[1];
                const err = Math.sqrt(dx * dx + dy * dy);

                globalSum += err;
                if (err > globalMax) globalMax = err;
                globalCount++;

                camAcc.sum += err;
                if (err > camAcc.max) camAcc.max = err;
                camAcc.count++;

                trackAcc.sum += err;
                if (err > trackAcc.max) trackAcc.max = err;
                trackAcc.count++;
            }
        }
    }

    stats.meanReprojError = globalCount > 0 ? globalSum / globalCount : 0;
    stats.maxReprojError = globalMax;

    // Finalize per-camera: replace sum with mean
    const camNames = Object.keys(stats.perCameraErrors);
    for (let c = 0; c < camNames.length; c++) {
        const acc = stats.perCameraErrors[camNames[c]];
        acc.mean = acc.count > 0 ? acc.sum / acc.count : 0;
        delete acc.sum;
    }

    // Finalize per-track: replace sum with mean
    const trackIdxs = Object.keys(stats.perTrackErrors);
    for (let t = 0; t < trackIdxs.length; t++) {
        const acc = stats.perTrackErrors[trackIdxs[t]];
        acc.mean = acc.count > 0 ? acc.sum / acc.count : 0;
        delete acc.sum;
    }

    return stats;
}
