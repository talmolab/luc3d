/**
 * Overlay rendering for multi-view pose proofreading
 * Combines skeleton rendering (from slp-viewer) with reprojection visualization (from calibration-studio)
 *
 * Draws pose overlays on transparent canvas elements that sit on top of video canvases.
 * All functions are globals (no imports/exports).
 */

// Track colors (8-color palette from slp-viewer, cycling)
const TRACK_COLORS = [
    '#667eea',  // blue
    '#4ade80',  // green
    '#fbbf24',  // yellow
    '#f472b6',  // pink
    '#06b6d4',  // cyan
    '#f97316',  // orange
    '#a855f7',  // purple
    '#ef4444',  // red
];

function getTrackColor(trackIdx) {
    return TRACK_COLORS[trackIdx % TRACK_COLORS.length];
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
function videoToCanvas(x, y, videoWidth, videoHeight, canvasWidth, canvasHeight) {
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
function makeVideoToCanvasTransform(videoWidth, videoHeight, canvasWidth, canvasHeight) {
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
function errorColor(errorPx) {
    if (errorPx < 2) return '#4ade80';  // green
    if (errorPx <= 5) return '#fbbf24'; // yellow
    return '#ef4444';                    // red
}

/**
 * Parse a hex color into { r, g, b } integers.
 */
function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return {
        r: parseInt(h.substring(0, 2), 16),
        g: parseInt(h.substring(2, 4), 16),
        b: parseInt(h.substring(4, 6), 16),
    };
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
function drawSkeleton(ctx, instance, skeleton, options) {
    options = options || {};
    const points = instance.points;
    if (!points || points.length === 0) return;

    const color = options.color || getTrackColor(instance.trackIdx != null ? instance.trackIdx : 0);
    const baseNodeSize = options.nodeSize != null ? options.nodeSize : 4;
    const baseLineWidth = options.lineWidth != null ? options.lineWidth : 2;
    const alpha = options.alpha != null ? options.alpha : 1.0;
    const showLabels = !!options.showLabels;

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
    const lineWidth = baseLineWidth * scale;

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

    // --- 1. Draw edges ---
    if (skeleton.edges) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < skeleton.edges.length; i++) {
            const edge = skeleton.edges[i];
            const srcIdx = edge[0];
            const dstIdx = edge[1];
            const src = canvasPoints[srcIdx];
            const dst = canvasPoints[dstIdx];
            if (src && dst) {
                ctx.moveTo(src.x, src.y);
                ctx.lineTo(dst.x, dst.y);
            }
        }
        ctx.stroke();
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

    // --- 3. Optional labels (SLEAP-style with dark outline) ---
    if (showLabels) {
        var savedAlpha = ctx.globalAlpha;
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        // Font size = 3x the node radius. Since nodeSize is already scaled
        // to canvas coordinates, this ensures labels are always visible and
        // proportional to the node display size.
        var fontSize = Math.max(10, Math.round(nodeSize * 3));
        ctx.lineWidth = Math.max(1, Math.round(nodeSize * 0.5));
        ctx.font = 'bold ' + fontSize + 'px sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';
        var labelOffset = Math.round(nodeSize * 0.5);
        for (var li = 0; li < canvasPoints.length; li++) {
            var lp = canvasPoints[li];
            if (!lp) continue;
            var node = skeleton.nodes ? skeleton.nodes[li] : undefined;
            var name = typeof node === 'string' ? node : (node && node.name ? node.name : 'node_' + li);
            var tx = lp.x + nodeSize + labelOffset;
            var ty = lp.y - labelOffset;
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
function drawReprojectedSkeleton(ctx, reprojectedPoints, skeleton, options) {
    options = options || {};
    if (!reprojectedPoints || reprojectedPoints.length === 0) return;

    const color = options.color || '#ff6b6b';
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

    const markerSize = baseNodeSize * scale;  // half-extent of the X
    const lineWidth = baseLineWidth * scale;

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
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';

    // --- 1. Draw edges as dashed lines ---
    if (skeleton.edges) {
        ctx.setLineDash([4 * scale, 4 * scale]);
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

    // --- 2. Draw X markers ---
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
function drawReprojectionErrors(ctx, observedPoints, reprojectedPoints, options) {
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
function drawSelectionHighlight(ctx, points, skeleton, options) {
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

    const nodeSize = baseNodeSize * scale;
    const lineWidth = baseLineWidth * scale;

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

    // --- 1. Glow circles behind nodes ---
    const rgb = hexToRgb(color);
    const glowRadius = nodeSize * 2.5;
    ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.25)';
    for (let i = 0; i < canvasPoints.length; i++) {
        const cp = canvasPoints[i];
        if (!cp) continue;
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, glowRadius, 0, Math.PI * 2);
        ctx.fill();
    }

    // --- 2. Thicker, brighter edges ---
    if (skeleton.edges) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = lineWidth * 2;
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.8;
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
        ctx.globalAlpha = 1.0;
    }

    // --- 3. Brighter nodes ---
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < canvasPoints.length; i++) {
        const cp = canvasPoints[i];
        if (!cp) continue;
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, nodeSize * 1.3, 0, Math.PI * 2);
        ctx.fill();
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
function drawHoverHighlight(ctx, point, nodeIdx, options) {
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
function drawDragPreview(ctx, points, dragNodeIdx, dragPos, skeleton, options) {
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

    const nodeSize = baseNodeSize * scale;
    const lineWidth = baseLineWidth * scale;

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
                ctx.setLineDash([4 * scale, 4 * scale]);
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
        ctx.lineWidth = 2 * scale;
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
function drawInstanceLabels(ctx, instances, skeleton, viewName, options) {
    options = options || {};
    if (!instances || instances.length === 0) return;

    const trackNames = options.trackNames || [];
    const selectedInstanceIdx = options.selectedInstanceIdx != null ? options.selectedInstanceIdx : -1;
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
        const color = getTrackColor(inst.trackIdx != null ? inst.trackIdx : instIdx);

        ctx.font = 'bold ' + Math.round(11 * scale) + 'px sans-serif';
        ctx.textBaseline = 'bottom';

        // Background pill for track label
        const textWidth = ctx.measureText(trackName).width;
        const pillPad = 3 * scale;
        const pillX = firstCp.x - pillPad;
        const pillY = firstCp.y - nodeSize * 2 - (11 * scale) - pillPad;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(pillX, pillY, textWidth + pillPad * 2, 11 * scale + pillPad * 2, 3);
        } else {
            ctx.rect(pillX, pillY, textWidth + pillPad * 2, 11 * scale + pillPad * 2);
        }
        ctx.fill();

        ctx.fillStyle = color;
        ctx.fillText(trackName, firstCp.x, firstCp.y - nodeSize * 2);

        // Draw node name labels for the selected instance
        if (instIdx === selectedInstanceIdx && skeleton && skeleton.nodes) {
            ctx.font = Math.round(9 * scale) + 'px sans-serif';
            ctx.fillStyle = '#ffffff';
            ctx.textBaseline = 'bottom';
            for (let n = 0; n < inst.points.length; n++) {
                const pt = inst.points[n];
                if (pt == null) continue;
                let cp;
                if (toCanvas) {
                    cp = toCanvas(pt[0], pt[1]);
                } else {
                    cp = { x: pt[0], y: pt[1] };
                }
                const nodeName = typeof skeleton.nodes[n] === 'string'
                    ? skeleton.nodes[n]
                    : (skeleton.nodes[n] && skeleton.nodes[n].name ? skeleton.nodes[n].name : '');
                if (nodeName) {
                    ctx.fillText(nodeName, cp.x + nodeSize + 2 * scale, cp.y - 2 * scale);
                }
            }
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
function drawInstanceTypeIndicator(ctx, points, type, options) {
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
 */
function drawUnlinkedInstances(ctx, unlinkedInstances, skeleton, options) {
    options = options || {};
    if (!unlinkedInstances || unlinkedInstances.length === 0) return;

    const baseNodeSize = options.nodeSize != null ? options.nodeSize : 4;
    const baseLineWidth = options.lineWidth != null ? options.lineWidth : 2;
    const showLabels = options.showLabels !== false; // default true for unlinked
    const assignmentSelectedIds = options.assignmentSelectedIds || [];
    const assignmentColor = options.assignmentColor || '#fbbf24';
    const selectedUnlinkedId = options.selectedUnlinkedId || null;

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
    const lineWidth = baseLineWidth * scale;

    for (let u = 0; u < unlinkedInstances.length; u++) {
        const ul = unlinkedInstances[u];
        const instance = ul.instance;
        const points = instance.points;
        if (!points || points.length === 0) continue;

        const isAssignSelected = assignmentSelectedIds.indexOf(ul.id) >= 0;
        const isEditSelected = selectedUnlinkedId != null && ul.id === selectedUnlinkedId;
        const isSelected = isAssignSelected || isEditSelected;
        const color = isAssignSelected ? assignmentColor : isEditSelected ? '#60a5fa' : getTrackColor(instance.trackIdx != null ? instance.trackIdx : u);
        const alpha = isSelected ? 0.95 : 0.5;

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

        ctx.save();
        ctx.globalAlpha = alpha;

        // Dashed edges
        if (skeleton.edges) {
            ctx.strokeStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.lineCap = 'round';
            ctx.setLineDash([4 * scale, 4 * scale]);
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

        // Semi-transparent nodes
        ctx.fillStyle = color;
        for (let i = 0; i < canvasPoints.length; i++) {
            const cp = canvasPoints[i];
            if (!cp) continue;
            ctx.beginPath();
            ctx.arc(cp.x, cp.y, nodeSize, 0, Math.PI * 2);
            ctx.fill();
        }

        // "?" badge near the first visible point
        let anchorCp = null;
        for (let i = 0; i < canvasPoints.length; i++) {
            if (canvasPoints[i]) { anchorCp = canvasPoints[i]; break; }
        }
        if (anchorCp) {
            const badgeSize = Math.round(10 * scale);
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.beginPath();
            ctx.arc(anchorCp.x - nodeSize * 2, anchorCp.y - nodeSize * 2, badgeSize, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fbbf24';
            ctx.font = 'bold ' + badgeSize + 'px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('?', anchorCp.x - nodeSize * 2, anchorCp.y - nodeSize * 2);
        }

        // Node name labels
        if (showLabels) {
            ctx.globalAlpha = 1.0;
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
            // Font size = 3x the node radius. Since nodeSize is already scaled
            // to canvas coordinates, labels are always proportional to nodes.
            var fontSize = Math.max(10, Math.round(nodeSize * 3));
            ctx.lineWidth = Math.max(1, Math.round(nodeSize * 0.5));
            ctx.font = 'bold ' + fontSize + 'px sans-serif';
            ctx.textBaseline = 'bottom';
            ctx.textAlign = 'left';
            var labelOffset = Math.round(nodeSize * 0.5);
            for (var li = 0; li < canvasPoints.length; li++) {
                var lp = canvasPoints[li];
                if (!lp) continue;
                var node2 = skeleton.nodes ? skeleton.nodes[li] : undefined;
                var lname = typeof node2 === 'string' ? node2 : (node2 && node2.name ? node2.name : 'node_' + li);
                var ltx = lp.x + nodeSize + labelOffset;
                var lty = lp.y - labelOffset;
                ctx.strokeText(lname, ltx, lty);
                ctx.fillText(lname, ltx, lty);
            }
        }

        // Selection ring (assignment = yellow, edit = blue)
        if (isSelected) {
            ctx.globalAlpha = 0.8;
            ctx.strokeStyle = isAssignSelected ? assignmentColor : '#60a5fa';
            ctx.lineWidth = 2 * scale;
            for (let i = 0; i < canvasPoints.length; i++) {
                const cp = canvasPoints[i];
                if (!cp) continue;
                ctx.beginPath();
                ctx.arc(cp.x, cp.y, nodeSize * 2, 0, Math.PI * 2);
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
function drawFrameOverlays(ctx, viewName, frameGroup, instanceGroups, session, options) {
    options = options || {};
    const showDetected    = options.showDetected !== false;
    const showReprojected = options.showReprojected !== false;
    const showErrors      = options.showErrors !== false;
    const showLegend      = options.showLegend !== false;
    const nodeSize        = options.nodeSize != null ? options.nodeSize : 4;
    const lineWidth       = options.lineWidth != null ? options.lineWidth : 2;
    const showLabels      = !!options.showLabels;

    const selectedInstanceGroup = options.selectedInstanceGroup || null;
    const selectedNodeIdx       = options.selectedNodeIdx != null ? options.selectedNodeIdx : -1;
    const hoveredNode           = options.hoveredNode || null;
    const dragInfo              = options.dragInfo || null;

    const canvasW = options.canvasWidth != null ? options.canvasWidth : ctx.canvas.width;
    const canvasH = options.canvasHeight != null ? options.canvasHeight : ctx.canvas.height;
    const videoW  = options.videoWidth;
    const videoH  = options.videoHeight;

    const skeleton = session && session.skeleton ? session.skeleton : { nodes: [], edges: [] };

    // Shared rendering options (passed to sub-functions)
    const renderOpts = {
        nodeSize: nodeSize,
        lineWidth: lineWidth,
        videoWidth: videoW,
        videoHeight: videoH,
        canvasWidth: canvasW,
        canvasHeight: canvasH,
        showLabels: showLabels,
    };

    // 1. Clear overlay
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    // 2. Draw detected skeletons
    if (showDetected && frameGroup && frameGroup.instances) {
        const viewInstances = frameGroup.instances instanceof Map
            ? frameGroup.instances.get(viewName)
            : frameGroup.instances[viewName];
        if (viewInstances) {
            for (let i = 0; i < viewInstances.length; i++) {
                const inst = viewInstances[i];
                drawSkeleton(ctx, inst, skeleton, Object.assign({}, renderOpts, {
                    color: getTrackColor(inst.trackIdx != null ? inst.trackIdx : i),
                }));
            }
        }
    }

    // 2b. Draw unlinked instances (dashed, semi-transparent)
    const unlinkedInstances = options.unlinkedInstances || [];
    if (unlinkedInstances.length > 0) {
        drawUnlinkedInstances(ctx, unlinkedInstances, skeleton, Object.assign({}, renderOpts, {
            assignmentSelectedIds: options.assignmentSelectedIds || [],
            assignmentColor: '#fbbf24',
            selectedUnlinkedId: options.selectedUnlinkedId || null,
        }));
    }

    // 3. Draw reprojected skeletons + error vectors
    if (instanceGroups) {
        for (let g = 0; g < instanceGroups.length; g++) {
            const group = instanceGroups[g];

            // Reprojected points for this camera
            const reprojPts = group.reprojections ? group.reprojections[viewName] : null;

            if (showReprojected && reprojPts) {
                drawReprojectedSkeleton(ctx, reprojPts, skeleton, Object.assign({}, renderOpts, {
                    color: '#ff6b6b',
                }));
            }

            // Error vectors: need both observed and reprojected
            if (showErrors && reprojPts) {
                const observedPts = group.observedPoints ? group.observedPoints[viewName] : null;
                if (observedPts) {
                    drawReprojectionErrors(ctx, observedPts, reprojPts, renderOpts);
                }
            }
        }
    }

    // 4. Selection highlight
    if (selectedInstanceGroup) {
        const selInst = selectedInstanceGroup.getInstance
            ? selectedInstanceGroup.getInstance(viewName)
            : (selectedInstanceGroup.instances ? selectedInstanceGroup.instances[viewName] : null);
        if (selInst && selInst.points) {
            const trackColor = getTrackColor(
                selectedInstanceGroup.trackIdx != null ? selectedInstanceGroup.trackIdx : 0
            );
            drawSelectionHighlight(ctx, selInst.points, skeleton, Object.assign({}, renderOpts, {
                color: trackColor,
                selectedNodeIdx: selectedNodeIdx,
            }));
        }
    }

    // 5. Hover highlight
    if (hoveredNode && hoveredNode.viewName === viewName && instanceGroups) {
        const hGroupIdx = hoveredNode.instanceGroupIdx;
        const hNodeIdx = hoveredNode.nodeIdx;
        if (hGroupIdx >= 0 && hGroupIdx < instanceGroups.length) {
            const hGroup = instanceGroups[hGroupIdx];
            const hInst = hGroup.getInstance
                ? hGroup.getInstance(viewName)
                : (hGroup.instances ? hGroup.instances[viewName] : null);
            if (hInst && hInst.points && hNodeIdx >= 0 && hNodeIdx < hInst.points.length && hInst.points[hNodeIdx]) {
                const hTrackColor = getTrackColor(
                    hGroup.trackIdx != null ? hGroup.trackIdx : 0
                );
                drawHoverHighlight(ctx, hInst.points[hNodeIdx], hNodeIdx, Object.assign({}, renderOpts, {
                    color: hTrackColor,
                }));
            }
        }
    }

    // 6. Drag preview
    if (dragInfo && dragInfo.viewName === viewName && selectedInstanceGroup) {
        const dragInst = selectedInstanceGroup.getInstance
            ? selectedInstanceGroup.getInstance(viewName)
            : (selectedInstanceGroup.instances ? selectedInstanceGroup.instances[viewName] : null);
        if (dragInst && dragInst.points) {
            const dragTrackColor = getTrackColor(
                selectedInstanceGroup.trackIdx != null ? selectedInstanceGroup.trackIdx : 0
            );
            drawDragPreview(ctx, dragInst.points, dragInfo.nodeIdx, dragInfo.currentPos, skeleton,
                Object.assign({}, renderOpts, { color: dragTrackColor }));
        }
    }

    // 7. Legend
    if (showLegend) {
        drawLegend(ctx, {
            showDetected: showDetected,
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
function drawLegend(ctx, options) {
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

    const fontSize = 12;
    const itemHeight = 18;
    const padding = 8;
    const iconWidth = 16;
    const iconGap = 6;
    const boxWidth = 140;
    const boxHeight = padding * 2 + items.length * itemHeight;

    const x = ctx.canvas.width - boxWidth - 10;
    const y = 10;

    ctx.save();

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(x, y, boxWidth, boxHeight, 4);
    } else {
        ctx.rect(x, y, boxWidth, boxHeight);
    }
    ctx.fill();

    ctx.font = fontSize + 'px sans-serif';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const iy = y + padding + i * itemHeight + itemHeight / 2;
        const ix = x + padding;

        if (item.type === 'detected') {
            // Filled circle in first track color
            ctx.fillStyle = TRACK_COLORS[0];
            ctx.beginPath();
            ctx.arc(ix + iconWidth / 2, iy, 4, 0, Math.PI * 2);
            ctx.fill();
        } else if (item.type === 'reprojected') {
            // X marker in red
            const cx = ix + iconWidth / 2;
            ctx.strokeStyle = '#ff6b6b';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cx - 4, iy - 4);
            ctx.lineTo(cx + 4, iy + 4);
            ctx.moveTo(cx + 4, iy - 4);
            ctx.lineTo(cx - 4, iy + 4);
            ctx.stroke();
        } else if (item.type === 'error') {
            // Short gradient-colored line
            const lx = ix + 2;
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            // green segment
            ctx.strokeStyle = '#4ade80';
            ctx.beginPath();
            ctx.moveTo(lx, iy);
            ctx.lineTo(lx + 4, iy);
            ctx.stroke();
            // yellow segment
            ctx.strokeStyle = '#fbbf24';
            ctx.beginPath();
            ctx.moveTo(lx + 4, iy);
            ctx.lineTo(lx + 8, iy);
            ctx.stroke();
            // red segment
            ctx.strokeStyle = '#ef4444';
            ctx.beginPath();
            ctx.moveTo(lx + 8, iy);
            ctx.lineTo(lx + 12, iy);
            ctx.stroke();
        }

        // Label text
        ctx.fillStyle = '#ffffff';
        ctx.fillText(item.label, ix + iconWidth + iconGap, iy);
    }

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
function getFrameStats(frameGroup, instanceGroups, cameras) {
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
        const trackIdx = group.trackIdx != null ? group.trackIdx : g;
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
