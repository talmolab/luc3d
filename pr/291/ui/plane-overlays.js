// ui/plane-overlays.js — drawing the placed planes onto a view's 2D overlay
// canvas.
//
// Split out of `ui/plane-definition.js`. Pure rendering: it reads the model and
// the interaction state and writes pixels, and nothing in the panel calls back
// into it. `ui/rendering.js` is the only caller (via `drawAllOverlays`), and it
// keeps importing `drawPlaneOverlays` from `ui/plane-definition.js`, which
// re-exports it — so no call site changed.
//
// `planeModel` / `planeState` are imported from the hub, which imports this
// module back. Circular, and safe for the same reason documented in
// `ui/plane-toolbar-lock.js`: both are read inside function bodies only.

import { interactionManager } from './app-state.js?v=37dadb6545b9';
import { makeVideoToCanvasTransform } from './overlays.js?v=37dadb6545b9';
import {
    planeEdgesPoolIndices, planeFillOrderPoolIndices, planeCentroid2d,
} from '../pose/plane-data.js?v=37dadb6545b9';
import { planeModel, planeState } from './plane-definition.js?v=37dadb6545b9';
import { planeVisibility } from './plane-visibility.js?v=37dadb6545b9';

const PLANE_LABEL_SIZE = 11;
const NULLED_COLOR = '#777777';
/** Alpha for a filled polygon — enough to read the plane, not enough to hide the video under it. */
const PLANE_FILL_ALPHA = 0.28;
/** Ring colour marking a pinned (immutable) node — it cannot be dragged. */
const PINNED_RING = 'rgba(255,255,255,0.9)';

/**
 * Draw every placed plane on `view`'s overlay canvas.
 *
 * Called from `drawAllOverlays` AFTER `drawFrameOverlays`, which begins with a
 * `clearRect` — drawing before it would be wiped. Planes are drawn in every
 * mode, not just Defining Plane Mode: they are scene geometry the user
 * annotated, and hiding them outside the mode would make them look lost. Only
 * the SELECTION and HOVER decorations are mode-gated, since those advertise an
 * interaction that only exists inside the mode.
 *
 * What is drawn outside the mode is the user's to choose, through the Visibility
 * panel's `Planes` section — `planeVisibility` (`ui/plane-visibility.js`) reads
 * it and forces every part on while the mode is active. The plane body (fill,
 * edges, plane name) and the NODES are separately switchable, so the two `if`s
 * below are not one: a node outlives the planes referencing it, and wanting the
 * corners without five filled walls on top of the frame is the ordinary case.
 * What it never changes is HOW a shown plane is drawn — colour, edges and
 * `Fill` are the annotation's, in every mode.
 *
 * Fills and edges are per PLANE; NODES are drawn once each, over the union of
 * the placed planes' nodes — a corner two planes share is one node with one 2D
 * point, so drawing it twice would just double the anti-aliasing.
 *
 * @param {{name:string, overlayCtx:CanvasRenderingContext2D,
 *          overlayCanvas:HTMLCanvasElement, videoWidth:number,
 *          videoHeight:number}} view
 */
export function drawPlaneOverlays(view) {
    if (!view || !view.overlayCtx || !view.overlayCanvas) return;
    var model = planeModel();
    var inst = model.getInstance(view.name);
    if (!inst) return;
    var placed = model.placedPlanes(view.name);
    if (!placed.length) return;

    var vis = planeVisibility(planeState.active);
    if (!vis.planes2d && !vis.nodes2d) return;

    var videoW = view.videoWidth || view.overlayCanvas.width;
    var videoH = view.videoHeight || view.overlayCanvas.height;
    if (!videoW || !videoH) return;

    var ctx = view.overlayCtx;
    var pool = model.pool;
    var tf = makeVideoToCanvasTransform(
        videoW, videoH, view.overlayCanvas.width, view.overlayCanvas.height
    );

    var isSelected = !!(planeState.active && interactionManager &&
        interactionManager.selectedPlane === inst);
    var hovered = (planeState.active && interactionManager)
        ? interactionManager.hoveredPlaneNode : null;
    var lineWidth = planeState.edgeWidth;

    ctx.save();

    // --- fills and edges, per plane ---
    if (vis.planes2d) {
        for (var p = 0; p < placed.length; p++) {
            var plane = placed[p];
            var edgeColor = plane.color || '#4dd0e1';
            // `plane.filled` and nothing else. The visibility toggles decide
            // WHETHER a plane is drawn, never HOW — a plane that gained a fill
            // by becoming visible would look different outside the mode from
            // inside it, and `Fill` is the one control that sets this.
            if (plane.filled) fillPolygon(ctx, plane, pool, inst, tf, edgeColor);

            var edges = planeEdgesPoolIndices(plane, pool);
            // A selected view draws a wider, semi-transparent halo under its edges.
            if (isSelected) {
                ctx.lineWidth = lineWidth + 5;
                ctx.strokeStyle = 'rgba(255,255,255,0.35)';
                strokeEdges(ctx, edges, inst, tf);
            }
            ctx.lineWidth = lineWidth;
            ctx.strokeStyle = edgeColor;
            strokeEdges(ctx, edges, inst, tf);
        }
    }

    // --- nodes, once each ---
    if (vis.nodes2d) drawPlaneNodes(ctx, model, inst, tf, hovered, view.name);

    // --- plane name at each plane's own centroid ---
    // With the body: the label names the plane, so leaving it behind would put
    // five floating words over a view with no planes in it.
    if (vis.planes2d) {
        ctx.font = 'bold ' + PLANE_LABEL_SIZE + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (var q = 0; q < placed.length; q++) {
            var c = planeCentroid2d(placed[q], pool, inst);
            if (!c) continue;
            var cp = tf(c[0], c[1]);
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(0,0,0,0.8)';
            ctx.strokeText(placed[q].name, cp.x, cp.y);
            ctx.fillStyle = isSelected ? '#ffffff' : (placed[q].color || '#4dd0e1');
            ctx.fillText(placed[q].name, cp.x, cp.y);
        }
        ctx.textAlign = 'start';
    }

    ctx.restore();
}

/**
 * Draw the visible nodes of a view.
 *
 * A PINNED node gets an extra white ring: it is the one node under the cursor
 * that will refuse to move, and finding that out only by dragging it would read
 * as a broken drag rather than as a deliberate lock.
 *
 * Three states are visually distinct because they mean three different things
 * to the next solve: solid = your annotation, counted; hollow grey = you turned
 * it off; ghosted with a dashed ring = REPROJECTED from the 3D into a view you
 * never annotated, so it is shown and draggable but not counted.
 */
function drawPlaneNodes(ctx, model, inst, tf, hovered, viewName) {
    var pool = model.pool;
    var radius = planeState.nodeSize;
    var visible = model.visibleNodeIndices(viewName);

    ctx.font = PLANE_LABEL_SIZE + 'px sans-serif';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < visible.length; i++) {
        var n = visible[i];
        if (!inst.hasPoint(n)) continue;
        var node = pool.nodeAt(n);
        if (!node) continue;
        var pt = tf(inst.getX(n), inst.getY(n));
        var nulled = inst.isNodeNulled(n);
        var derived = !nulled && inst.isNodeDerived(n);
        var nodeColor = nulled ? NULLED_COLOR : node.color;
        var isHovered = !!(hovered && hovered.viewName === viewName &&
            hovered.planeId === inst.id && hovered.nodeIdx === n);

        if (isHovered) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, radius + 4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        if (nulled) {
            // Hollow = excluded from the later solve, matching how a nulled
            // pose node reads.
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = nodeColor;
            ctx.stroke();
        } else if (derived) {
            // REPROJECTED here, not annotated here: ghosted fill + a dashed
            // ring. It is a real, draggable point — dragging it is what turns
            // it into an observation — so it must read as neither a solid
            // annotation nor a nulled one. Nulled wins when both apply: "you
            // turned this off" is the more actionable fact.
            ctx.save();
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = nodeColor;
            ctx.fill();
            ctx.restore();
            ctx.setLineDash([3, 2.5]);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = nodeColor;
            ctx.stroke();
            ctx.setLineDash([]);
        } else {
            ctx.fillStyle = nodeColor;
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = 'rgba(0,0,0,0.75)';
            ctx.stroke();
        }

        if (node.immutable) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, radius + 2.5, 0, Math.PI * 2);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = PINNED_RING;
            ctx.stroke();
        }

        if (node.name) {
            var lx = pt.x + radius + 3;
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(0,0,0,0.8)';
            ctx.strokeText(node.name, lx, pt.y);
            ctx.fillStyle = nodeColor;
            ctx.fillText(node.name, lx, pt.y);
        }
    }
}

/**
 * Fill one plane's polygon. Vertex order comes from
 * `planeFillOrderPoolIndices`: the user's connections when they form a closed
 * ring, otherwise the CONVEX HULL of this view's positioned nodes. Membership
 * order would draw a self-intersecting bowtie for any quad whose corners were
 * not added in ring order, and would turn a node placed in the MIDDLE of a
 * plane into a reflex vertex that carves a notch out of the fill instead of
 * being covered by it.
 *
 * Nulled nodes are still vertices here: toggling a corner off means "don't use
 * this observation in the solve", not "this corner isn't part of the plane",
 * and dropping it would distort the outline.
 */
function fillPolygon(ctx, plane, pool, inst, tf, color) {
    var order = planeFillOrderPoolIndices(plane, pool, inst);
    var pts = [];
    for (var i = 0; i < order.length; i++) {
        var k = order[i];
        if (k >= 0 && inst.hasPoint(k)) pts.push(tf(inst.getX(k), inst.getY(k)));
    }
    if (pts.length < 3) return;

    ctx.save();
    ctx.globalAlpha = PLANE_FILL_ALPHA;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

/** Stroke edges given as POOL-index pairs. */
function strokeEdges(ctx, edges, inst, tf) {
    for (var e = 0; e < edges.length; e++) {
        var a = edges[e][0], b = edges[e][1];
        if (a < 0 || b < 0 || !inst.hasPoint(a) || !inst.hasPoint(b)) continue;
        var pa = tf(inst.getX(a), inst.getY(a));
        var pb = tf(inst.getX(b), inst.getY(b));
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
    }
}
